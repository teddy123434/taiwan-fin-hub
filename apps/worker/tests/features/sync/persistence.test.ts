import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import {
  persistStagedSyncWrite,
  promoteStagedSyncWrite,
  stageSyncWriteRecords,
  type SyncWriteRecord,
} from "../../../src/features/sync/persistence";
import {
  connectorStateStatement,
  updateConnectorEncryptedConfigIfCurrent,
} from "../../../src/features/sync/connector-repository";

const now = "2026-09-01T10:30:00+08:00";
const account: SyncWriteRecord = {
  entityType: "bank_account",
  recordKey: "sinopac:card",
  payload: {
    id: "sinopac:card",
    connector_id: "sinopac",
    source_id: "card",
    account_type: "credit",
    currency: "TWD",
    raw_payload: "{}",
    created_at: now,
    updated_at: now,
  },
};
function transaction(status: "pending" | "posted"): SyncWriteRecord {
  return {
    entityType: "bank_transaction",
    recordKey: "sinopac:purchase",
    payload: {
      id: "sinopac:purchase",
      connector_id: "sinopac",
      account_id: account.recordKey,
      source_id: "purchase",
      amount: -252,
      currency: "TWD",
      authorized_at: status === "pending" ? now : "2026-09-01",
      posted_date: status === "posted" ? "2026-09-03" : null,
      status,
      raw_payload: JSON.stringify({ status }),
      created_at: now,
      updated_at: now,
    },
  };
}

describe("同步資料完整性（隔離 D1）", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  let db: D1Database;
  beforeAll(async () => {
    harness = await createTestD1();
    db = harness.binding;
  }, 60_000);
  afterAll(async () => {
    await harness?.mf.dispose();
  });
  beforeEach(async () => {
    await db.batch([
      ...[
        "bank_transaction_preferences",
        "credit_card_bills",
        "bank_transactions",
        "bank_accounts",
        "sync_write_staging",
        "connector_settings",
      ].map((table) => db.prepare(`DELETE FROM ${table}`)),
      db.prepare(
        "INSERT INTO connector_settings (id, connector_id, encrypted_config, sync_cursor, created_at, updated_at) VALUES ('sinopac', 'sinopac', 'old-config', 'old-cursor', 't', 't')",
      ),
    ]);
  });

  it("重抓與入帳只保留一筆交易、原始時刻及使用者排除決定，空結果也保留歷史", async () => {
    const records = [account, transaction("pending")];
    expect(
      (await persistStagedSyncWrite(db, { records })).bankTransactions,
    ).toBe(1);
    await db
      .prepare(
        "INSERT INTO bank_transaction_preferences VALUES ('sinopac:purchase', 1, 'created', 'updated')",
      )
      .run();
    for (const records of [
      [transaction("posted")],
      [transaction("pending")],
      [],
    ]) {
      expect(
        (await persistStagedSyncWrite(db, { records })).bankTransactions,
      ).toBe(0);
    }
    expect(
      (
        await db
          .prepare(
            "SELECT id, amount, status, authorized_at, posted_date, raw_payload FROM bank_transactions",
          )
          .all()
      ).results,
    ).toEqual([
      {
        id: "sinopac:purchase",
        amount: -252,
        status: "posted",
        authorized_at: now,
        posted_date: "2026-09-03",
        raw_payload: JSON.stringify({ status: "posted" }),
      },
    ]);
    expect(
      await db.prepare("SELECT * FROM bank_transaction_preferences").first(),
    ).toEqual({
      transaction_id: "sinopac:purchase",
      excluded_from_calculation: 1,
      created_at: "created",
      updated_at: "updated",
    });
  });

  it("後續資料缺少繳款欄位時保留已確認的繳款資料", async () => {
    const bill: SyncWriteRecord = {
      entityType: "credit_card_bill",
      recordKey: "sinopac:bill",
      payload: {
        id: "sinopac:bill",
        connector_id: "sinopac",
        account_id: account.recordKey,
        source_id: "bill",
        billing_period: "2026-09",
        statement_amount: 1000,
        paid_amount: 1000,
        is_paid: 1,
        currency: "TWD",
        raw_payload: "{}",
        created_at: now,
        updated_at: now,
      },
    };
    await persistStagedSyncWrite(db, { records: [account, bill] });
    await persistStagedSyncWrite(db, {
      records: [
        {
          ...bill,
          payload: { ...bill.payload, paid_amount: null, is_paid: null },
        },
      ],
    });
    expect(
      await db
        .prepare("SELECT paid_amount, is_paid FROM credit_card_bills")
        .first(),
    ).toEqual({ paid_amount: 1000, is_paid: 1 });
  });

  it("暫存後變更憑證時，舊同步不能寫入金融資料或覆蓋新憑證與 cursor", async () => {
    const records = [account, transaction("posted")];
    await stageSyncWriteRecords(db, "stale-run", records);
    await db
      .prepare(
        "UPDATE connector_settings SET encrypted_config = 'new-config', sync_cursor = NULL WHERE connector_id = 'sinopac'",
      )
      .run();
    const staleState = connectorStateStatement(
      db,
      "sinopac",
      "stale-session",
      null,
      "stale-cursor",
      now,
      "old-config",
    );
    await promoteStagedSyncWrite(db, {
      runId: "stale-run",
      entityTypes: ["bank_account", "bank_transaction"],
      settingsGuard: { connectorId: "sinopac", encryptedConfig: "old-config" },
      finalizeStatements: [staleState],
    });
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM bank_accounts").first("n"),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM bank_transactions")
        .first("n"),
    ).toBe(0);
    expect(
      await updateConnectorEncryptedConfigIfCurrent(
        db,
        "sinopac",
        "old-config",
        "stale-session",
      ),
    ).toBe(false);
    expect((await staleState.run()).meta.changes).toBe(0);
    expect(
      await db
        .prepare("SELECT encrypted_config, sync_cursor FROM connector_settings")
        .first(),
    ).toEqual({ encrypted_config: "new-config", sync_cursor: null });
    expect(
      (
        await persistStagedSyncWrite(db, {
          records,
          settingsGuard: {
            connectorId: "sinopac",
            encryptedConfig: "new-config",
          },
          finalizeStatements: [
            connectorStateStatement(
              db,
              "sinopac",
              "current-session",
              null,
              "current-cursor",
              now,
              "new-config",
            ),
          ],
        })
      ).bankTransactions,
    ).toBe(1);
    expect(
      await db
        .prepare("SELECT encrypted_config, sync_cursor FROM connector_settings")
        .first(),
    ).toEqual({
      encrypted_config: "current-session",
      sync_cursor: "current-cursor",
    });
  });
});
