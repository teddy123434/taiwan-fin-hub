import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import { encryptJson } from "../../../src/platform/crypto";
import type { Env } from "../../../src/platform/env";
import { acquireSyncJobLock, releaseSyncJobLock } from "../../../src/db";
import { createSyncExecution } from "../../../src/features/sync/execution";
import { NeedsUserActionError } from "../../../src/features/sync/errors";
import { calculateCurrentFinancialSnapshot } from "../../../src/features/sync/reports/repository";

const mocks = vi.hoisted(() => ({
  createSinopacConnector: vi.fn(),
  loginSinopacWithOcr: vi.fn(),
}));

vi.mock("../../../src/sources/sinopac/connector", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/sources/sinopac/connector")
  >("../../../src/sources/sinopac/connector");
  return {
    ...actual,
    createSinopacConnector: mocks.createSinopacConnector,
    loginSinopacWithOcr: mocks.loginSinopacWithOcr,
  };
});

import { SinopacVerificationRequiredError } from "../../../src/sources/sinopac/connector";
import { syncSinopac } from "../../../src/sources/sinopac/sync";

const KEY = "synthetic-test-encryption-key";
const CREATED_AT = "2026-10-09T00:00:00.000Z";
const RUN_ID = "synthetic-sinopac-loan-safety-run";
const LOCK_ROW = "sinopac:all";
const LOAN_ID = "sinopac:loan:synthetic-old";
const LOAN_SOURCE_ID = "loan:sinopac:synthetic-old";

let harness: Awaited<ReturnType<typeof createTestD1>>;
let env: Env;

async function runSyncWithIncompleteEmptyLoanList() {
  mocks.createSinopacConnector.mockReturnValue({
    sync: vi.fn().mockResolvedValue({
      records: [],
      bankAccounts: [],
      bankBalanceSnapshots: [],
      bankTransactions: [],
      creditCardBills: [],
      loanSummary: {
        overviewComplete: false,
        accountListFailures: 0,
        accountDetailFailures: 0,
        paymentDetailFailures: 0,
        accountCount: 0,
        snapshotCount: 0,
      },
    }),
  });

  expect(
    await acquireSyncJobLock(env.DB, {
      lockRowId: LOCK_ROW,
      runId: RUN_ID,
      scope: "all",
      trigger: "manual",
      leaseMs: 60_000,
    }),
  ).toBe(true);
  const execution = createSyncExecution(env, {
    lockRowId: LOCK_ROW,
    runId: RUN_ID,
  });
  try {
    return await execution.run((guardedEnv) =>
      syncSinopac(guardedEnv, "manual"),
    );
  } finally {
    execution.stop();
    await releaseSyncJobLock(env.DB, LOCK_ROW, RUN_ID);
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  harness = await createTestD1();
  env = { DB: harness.binding, CONFIG_ENCRYPTION_KEY: KEY } as Env;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO connector_settings(id, connector_id, encrypted_config, created_at, updated_at) VALUES('sinopac', 'sinopac', ?, ?, ?)",
    ).bind(
      await encryptJson({ userId: "A123456789" }, KEY),
      CREATED_AT,
      CREATED_AT,
    ),
    env.DB.prepare(
      `INSERT INTO bank_accounts (
         id, connector_id, source_id, institution_name, account_name,
         account_type, currency, created_at, updated_at
       ) VALUES (?, 'sinopac', ?, '永豐銀行', '合成貸款帳戶', 'loan', 'TWD', ?, ?)`,
    ).bind(LOAN_ID, LOAN_SOURCE_ID, CREATED_AT, CREATED_AT),
    env.DB.prepare(
      `INSERT INTO bank_balance_snapshots (
         id, connector_id, account_id, source_id, balance, currency,
         as_of_at, created_at, updated_at
       ) VALUES (?, 'sinopac', ?, 'synthetic-current', -50000, 'TWD', ?, ?, ?)`,
    ).bind(`${LOAN_ID}:snapshot`, LOAN_ID, CREATED_AT, CREATED_AT, CREATED_AT),
  ]);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
}, 60_000);

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.mf.dispose();
}, 60_000);

describe("永豐貸款清單完整性保護（隔離 D1）", () => {
  it("有效空清單完整性未知時不計 failure，也不會停用貸款或刪除快照", async () => {
    const log = vi.spyOn(console, "log");
    await runSyncWithIncompleteEmptyLoanList();

    const syncLogs = log.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith("[sync] sinopac/all:"));
    expect(syncLogs).toEqual([
      "[sync] sinopac/all: starting trigger=manual (cursor=none)",
      "[sync] sinopac/all: accounts=0 snapshots=0 transactions=0 bills=0 loanStatus=no_loans loanAccountCount=0 loanSnapshotCount=0 loanFailureCount=0",
    ]);
    expect(syncLogs.join(" ")).not.toContain("sinopac_sync_finished");
    expect(syncLogs.join(" ")).not.toContain("sync_execution");

    const account = await env.DB.prepare(
      "SELECT inactive_at AS inactiveAt FROM bank_accounts WHERE id = ?",
    )
      .bind(LOAN_ID)
      .first<{ inactiveAt: string | null }>();
    expect(account).toEqual({ inactiveAt: null });

    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS snapshotCount FROM bank_balance_snapshots WHERE account_id = ?",
      )
        .bind(LOAN_ID)
        .first<{ snapshotCount: number }>(),
    ).resolves.toEqual({ snapshotCount: 1 });
    await expect(
      calculateCurrentFinancialSnapshot(env.DB),
    ).resolves.toMatchObject({
      loanDebtTwd: 50_000,
    });
  });

  it("重新驗證失敗時回報 NeedsUserActionError，保留既有貸款快照且不更新 cursor", async () => {
    const cursor = "synthetic-existing-cursor";
    await env.DB.prepare(
      "UPDATE connector_settings SET sync_cursor = ? WHERE connector_id = ?",
    )
      .bind(cursor, "sinopac")
      .run();
    const verificationError = new SinopacVerificationRequiredError(
      "synthetic verification required",
    );
    const connectorSync = vi.fn().mockRejectedValue(verificationError);
    mocks.createSinopacConnector.mockReturnValue({ sync: connectorSync });
    mocks.loginSinopacWithOcr.mockResolvedValue({ sessionCookies: "[]" });

    expect(
      await acquireSyncJobLock(env.DB, {
        lockRowId: LOCK_ROW,
        runId: RUN_ID,
        scope: "all",
        trigger: "manual",
        leaseMs: 60_000,
      }),
    ).toBe(true);
    const execution = createSyncExecution(env, {
      lockRowId: LOCK_ROW,
      runId: RUN_ID,
    });
    try {
      await expect(
        execution.run((guardedEnv) => syncSinopac(guardedEnv, "manual")),
      ).rejects.toBeInstanceOf(NeedsUserActionError);
    } finally {
      execution.stop();
      await releaseSyncJobLock(env.DB, LOCK_ROW, RUN_ID);
    }

    expect(mocks.loginSinopacWithOcr).toHaveBeenCalledTimes(1);
    expect(connectorSync).toHaveBeenCalledTimes(2);
    await expect(
      env.DB.prepare(
        "SELECT sync_cursor AS syncCursor FROM connector_settings WHERE connector_id = ?",
      )
        .bind("sinopac")
        .first<{ syncCursor: string | null }>(),
    ).resolves.toEqual({ syncCursor: cursor });
    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS snapshotCount FROM bank_balance_snapshots WHERE account_id = ?",
      )
        .bind(LOAN_ID)
        .first<{ snapshotCount: number }>(),
    ).resolves.toEqual({ snapshotCount: 1 });
    await expect(
      calculateCurrentFinancialSnapshot(env.DB),
    ).resolves.toMatchObject({ loanDebtTwd: 50_000 });
  });
});
