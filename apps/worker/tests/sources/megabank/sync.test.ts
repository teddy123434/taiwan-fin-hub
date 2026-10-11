import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import { decryptJson, encryptJson } from "../../../src/platform/crypto";
import type { Env } from "../../../src/platform/env";
import type { MegabankConfig } from "../../../src/sources/megabank/protocol";
import {
  type createMegabankConnector,
  MegabankOtpRequiredError,
  MegabankVerificationRequiredError,
} from "../../../src/sources/megabank/mobile-api";

const mocks = vi.hoisted(() => ({ createMegabankConnector: vi.fn() }));

vi.mock("../../../src/sources/megabank/mobile-api", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/sources/megabank/mobile-api")
  >("../../../src/sources/megabank/mobile-api");
  return {
    ...actual,
    createMegabankConnector: mocks.createMegabankConnector,
  };
});

import { syncMegabank } from "../../../src/sources/megabank/sync";

let harness: Awaited<ReturnType<typeof createTestD1>>;
let env: Env;
const key = "synthetic-test-encryption-key";
const NOW = "2026-09-27T00:00:00.000Z";
const ACCOUNT = "bank:megabank:2345:abcdef:TWD";
const P = "megabank:deposit:tx:";
const device = {
  deviceCode: "synthetic-device-code",
  deviceUKey: "synthetic-device-key",
  deviceSeed: "synthetic-device-seed",
};
type ConnectorOptions = NonNullable<
  Parameters<typeof createMegabankConnector>[2]
>;

const debit = {
  postedDate: "2026-09-20",
  amount: -1000,
  description: "合成扣款",
};

function syncResult(
  transactions: Array<{
    sourceId: string;
    postedDate: string;
    amount: number;
    description: string;
  }>,
) {
  return {
    records: [],
    bankAccounts: [
      {
        sourceId: ACCOUNT,
        institutionName: "兆豐銀行",
        accountName: "兆豐活存",
        accountType: "savings" as const,
        currency: "TWD",
      },
    ],
    bankBalanceSnapshots: [
      {
        accountId: ACCOUNT,
        sourceId: `${ACCOUNT}:${NOW}`,
        balance: 50_000,
        currency: "TWD",
        asOfAt: NOW,
      },
    ],
    bankTransactions: transactions.map((row) => ({
      accountId: ACCOUNT,
      authorizedAt: row.postedDate,
      currency: "TWD",
      status: "posted" as const,
      ...row,
    })),
  };
}

async function runSync(result: ReturnType<typeof syncResult>) {
  mocks.createMegabankConnector.mockReturnValue({
    sync: vi.fn().mockResolvedValue(result),
  });
  return syncMegabank(env, "manual");
}

async function transactions() {
  return (
    await env.DB.prepare(
      `SELECT id, source_id AS sourceId, amount, created_at AS createdAt
       FROM bank_transactions WHERE connector_id = 'megabank'
       ORDER BY source_id`,
    ).all<{ id: string; sourceId: string; amount: number; createdAt: string }>()
  ).results;
}

async function settings() {
  return (await env.DB.prepare(
    "SELECT encrypted_config, public_config, sync_cursor FROM connector_settings WHERE connector_id = 'megabank'",
  ).first<{
    encrypted_config: string;
    public_config: string | null;
    sync_cursor: string | null;
  }>())!;
}

async function savedConfig() {
  return decryptJson<Record<string, unknown>>(
    (await settings()).encrypted_config,
    key,
  );
}

function mockDeviceSync(run: () => Promise<object>) {
  mocks.createMegabankConnector.mockImplementation(
    (_fetcher, _recognizeCaptcha, options: ConnectorOptions) => ({
      async sync(config: MegabankConfig) {
        const saved =
          config.deviceCode && config.deviceUKey && config.deviceSeed;
        await options.onDevice?.(
          saved
            ? {
                deviceCode: config.deviceCode!,
                deviceUKey: config.deviceUKey!,
                deviceSeed: config.deviceSeed!,
              }
            : device,
          saved ? "stored" : "generated",
        );
        // 模擬銀行呼叫前即可從 D1 還原該次實際使用的裝置。
        expect(await savedConfig()).toMatchObject(device);
        return run();
      },
    }),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  harness = await createTestD1();
  env = {
    DB: harness.binding,
    CONFIG_ENCRYPTION_KEY: key,
    MEGABANK_EGRESS: {
      getByName: () => ({ fetch: globalThis.fetch.bind(globalThis) }),
    },
  } as unknown as Env;
  const encrypted = await encryptJson(
    { userId: "A123456789", account: "syntheticacct", password: "synthetic" },
    key,
  );
  await env.DB.prepare(
    "INSERT INTO connector_settings(id, connector_id, encrypted_config, created_at, updated_at) VALUES(?, ?, ?, ?, ?)",
  )
    .bind("megabank", "megabank", encrypted, NOW, NOW)
    .run();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
}, 60_000);

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.mf.dispose();
}, 60_000);

describe("兆豐存款交易 sourceId 對帳（隔離 D1）", () => {
  it("舊 sourceId 的既有列被更新而非重複新增，使用者決定原樣保留", async () => {
    // 模擬舊版寫入：兩筆同日同額同摘要，sourceId 含舊的順序欄位雜湊。
    await runSync(
      syncResult([
        { sourceId: `${P}legacy-a:0`, ...debit },
        { sourceId: `${P}legacy-b:0`, ...debit },
      ]),
    );
    const before = await transactions();
    expect(before).toHaveLength(2);
    const annotated = before.find((row) => row.sourceId === `${P}legacy-a:0`)!;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO bank_transaction_preferences (transaction_id, excluded_from_calculation, created_at, updated_at) VALUES (?, 1, 'created', 'updated')",
      ).bind(annotated.id),
      env.DB.prepare(
        "INSERT INTO classification_overrides (id, target_type, target_id, category_id, created_at, updated_at) VALUES ('override-1', 'bank_transaction', ?, 'food', 'created', 'updated')",
      ).bind(annotated.id),
    ]);

    // 新版格式：同樣兩筆（occurrence 0/1）加上稍後入帳的新交易。
    const latest = [
      { sourceId: `${P}new:0`, ...debit },
      { sourceId: `${P}new:1`, ...debit },
      {
        sourceId: `${P}other:0`,
        postedDate: "2026-09-20",
        amount: 500,
        description: "合成入帳",
      },
    ];
    const outcome = await runSync(syncResult(latest));
    expect(outcome).toMatchObject({
      success: true,
      newRecords: { bankTransactions: 1 },
    });

    const after = await transactions();
    expect(after).toHaveLength(3);
    const legacyRows = after.filter((row) => row.sourceId.includes("legacy"));
    expect(legacyRows.map((row) => row.id).sort()).toEqual(
      before.map((row) => row.id).sort(),
    );
    expect(after.some((row) => row.sourceId.startsWith(`${P}new:`))).toBe(
      false,
    );
    expect(after.find((row) => row.sourceId === `${P}other:0`)?.amount).toBe(
      500,
    );
    // 既有列是更新而非重建：created_at 不變。
    expect(legacyRows.map((row) => row.createdAt).sort()).toEqual(
      before.map((row) => row.createdAt).sort(),
    );
    expect(
      await env.DB.prepare(
        "SELECT excluded_from_calculation, created_at FROM bank_transaction_preferences WHERE transaction_id = ?",
      )
        .bind(annotated.id)
        .first(),
    ).toEqual({ excluded_from_calculation: 1, created_at: "created" });
    expect(
      await env.DB.prepare(
        "SELECT category_id FROM classification_overrides WHERE target_id = ?",
      )
        .bind(annotated.id)
        .first(),
    ).toEqual({ category_id: "food" });

    // 再同步一次保持冪等。
    await runSync(syncResult(latest));
    expect(await transactions()).toHaveLength(3);
  });

  it("log 只記錄對回舊列的筆數", async () => {
    await runSync(syncResult([{ sourceId: `${P}legacy-a:0`, ...debit }]));
    const log = vi.spyOn(console, "log");
    await runSync(syncResult([{ sourceId: `${P}new:0`, ...debit }]));
    const lines = log.mock.calls.map(([value]) => String(value));
    expect(lines).toContain(
      JSON.stringify({ event: "megabank_tx_source_reconciled", remapped: 1 }),
    );
    expect(lines.join("\n")).not.toContain("合成扣款");
  });
});

describe("兆豐裝置識別與設定版本（隔離 D1）", () => {
  it.each(["success", "verification_required"])(
    "首次自動同步 %s 後，下一次登入仍沿用加密保存的裝置",
    async (outcome) => {
      const result = { records: [], cursor: JSON.stringify({ syncedAt: NOW }) };
      mockDeviceSync(async () => {
        if (outcome === "verification_required") {
          throw new MegabankVerificationRequiredError("合成驗證要求");
        }
        return result;
      });
      if (outcome === "success") {
        await syncMegabank(env, "scheduled");
      } else {
        await expect(syncMegabank(env, "scheduled")).rejects.toThrow(
          "合成驗證要求",
        );
      }
      expect(await savedConfig()).toMatchObject(device);
      mockDeviceSync(async () => result);
      await syncMegabank(env, "manual");
      expect(await savedConfig()).toMatchObject(device);
      const row = await settings();
      expect(row.public_config).toBeNull();
      expect(row.sync_cursor).toBe(result.cursor);
      const logs = vi
        .mocked(console.log)
        .mock.calls.map(
          ([value]) => JSON.parse(String(value)) as Record<string, unknown>,
        )
        .filter((value) => value.event === "megabank_device_state");
      expect(logs).toMatchObject([
        { trigger: "scheduled", source: "generated", outcome: "saved" },
        { trigger: "manual", source: "stored", outcome: "reused" },
      ]);
      expect(logs[0]?.fingerprint).toMatch(/^[a-f0-9]{16}$/);
      expect(logs[1]?.fingerprint).toBe(logs[0]?.fingerprint);
      for (const secret of [
        ...Object.values(device),
        "A123456789",
        "syntheticacct",
        "synthetic",
      ]) {
        expect(JSON.stringify(logs)).not.toContain(secret);
        expect(row.encrypted_config).not.toContain(secret);
      }
    },
  );

  it("保留待簡訊的裝置，完成驗證只清除短暫工作階段", async () => {
    const expiresAt = new Date(Date.now() + 180_000).toISOString();
    mocks.createMegabankConnector.mockImplementation(
      (_fetcher, _recognizeCaptcha, options: ConnectorOptions) => ({
        async sync() {
          await options.onDevice?.(device, "pending_session");
          throw new MegabankOtpRequiredError(
            "合成簡訊提示",
            "synthetic-session-token",
            expiresAt,
            device,
          );
        },
      }),
    );
    await expect(syncMegabank(env, "manual")).rejects.toBeInstanceOf(
      MegabankOtpRequiredError,
    );
    expect(await savedConfig()).toMatchObject({
      ...device,
      pendingSession: "synthetic-session-token",
      pendingSessionExpiresAt: expiresAt,
    });
    mockDeviceSync(async () => ({
      records: [],
      cursor: JSON.stringify({ syncedAt: NOW }),
    }));
    await syncMegabank(env, "manual", { otp: "654321" });
    const config = await savedConfig();
    expect(config).toMatchObject(device);
    for (const field of [
      "pendingSession",
      "pendingSessionExpiresAt",
      "captcha",
      "otp",
    ]) {
      expect(config).not.toHaveProperty(field);
    }
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(
      "synthetic-session-token",
    );
  });

  it("保存裝置後憑證被更新，舊同步不能覆蓋新憑證或寫入帳務", async () => {
    const replacement = {
      userId: "B223456789",
      account: "replacement",
      password: "new-synthetic",
    };
    const replacementEncrypted = await encryptJson(replacement, key);
    mockDeviceSync(async () => {
      await env.DB.prepare(
        "UPDATE connector_settings SET encrypted_config = ? WHERE connector_id = 'megabank'",
      )
        .bind(replacementEncrypted)
        .run();
      return {
        ...syncResult([{ sourceId: `${P}stale:0`, ...debit }]),
        cursor: JSON.stringify({ syncedAt: NOW }),
      };
    });

    await expect(syncMegabank(env, "manual")).rejects.toThrow(
      "設定在同步期間已變更",
    );
    expect(await savedConfig()).toEqual(replacement);
    expect(await transactions()).toEqual([]);
    expect((await settings()).sync_cursor).toBeNull();
  });

  it("保存裝置前憑證被更新，停止外部呼叫且不把舊裝置放入新設定", async () => {
    const replacement = {
      userId: "B223456789",
      account: "replacement",
      password: "new-synthetic",
    };
    const replacementEncrypted = await encryptJson(replacement, key);
    const bankRequest = vi.fn();
    mocks.createMegabankConnector.mockImplementation(
      (_fetcher, _recognizeCaptcha, options: ConnectorOptions) => ({
        async sync() {
          await env.DB.prepare(
            "UPDATE connector_settings SET encrypted_config = ? WHERE connector_id = 'megabank'",
          )
            .bind(replacementEncrypted)
            .run();
          await options.onDevice?.(device, "generated");
          bankRequest();
          return { records: [] };
        },
      }),
    );

    await expect(syncMegabank(env, "scheduled")).rejects.toThrow(
      "設定在同步期間已變更",
    );
    expect(bankRequest).not.toHaveBeenCalled();
    expect(await savedConfig()).toEqual(replacement);
  });
});
