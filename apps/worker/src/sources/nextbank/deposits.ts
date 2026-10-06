import type { parseNextbankDeposits } from "./protocol";
import { bankBalanceSnapshotRecord } from "../../features/sync/record-mapper";

/** Call only after the complete main/pocket response passed normalization and
 * total reconciliation. Absence is observed now, not a bank closure date.
 */
export async function prepareNextbankDepositWrite(
  db: D1Database,
  result: ReturnType<typeof parseNextbankDeposits>,
  now: string,
) {
  const currentIds = result.bankAccounts.map((account) => account.sourceId);
  const previous = await db
    .prepare(
      `SELECT source_id AS sourceId, currency FROM bank_accounts
       WHERE connector_id = 'nextbank' AND inactive_at IS NULL
         AND account_type IN ('savings', 'time_deposit')
         AND source_id NOT IN (SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(currentIds))
    .all<{ sourceId: string; currency: string }>();
  return {
    records: previous.results.map((account) =>
      bankBalanceSnapshotRecord(
        "nextbank",
        {
          accountId: account.sourceId,
          sourceId: `${account.sourceId}:absent:${now}`,
          balance: 0,
          availableBalance: 0,
          currency: account.currency,
          asOfAt: now,
          raw: { reason: "absent_from_complete_deposit_list" },
        },
        now,
      ),
    ),
    afterPromoteStatements: [
      db
        .prepare(
          `UPDATE bank_accounts SET inactive_at = ?, updated_at = ?
           WHERE connector_id = 'nextbank' AND inactive_at IS NULL
             AND account_type IN ('savings', 'time_deposit')
             AND source_id NOT IN (SELECT value FROM json_each(?))`,
        )
        .bind(now, now, JSON.stringify(currentIds)),
    ],
  };
}
