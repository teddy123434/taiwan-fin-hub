import { mergeLegacyTransactionStatements } from "./transaction-merge";

// 早期同步在讀不到卡號末四碼時會寫入 credit:<connector>:main 摘要帳戶；
// 之後解析出實體卡就會多出一筆孤兒帳戶，只有單張卡時可以安全併回實體卡。
export function reconcileSingleCardSummaryAccountStatements(
  db: D1Database,
  connectorId: "esun" | "hncb",
) {
  const mainAccountId = `(SELECT id FROM bank_accounts
    WHERE connector_id = '${connectorId}' AND source_id = 'credit:${connectorId}:main')`;
  const physicalAccountFilter = `connector_id = '${connectorId}'
    AND account_type = 'credit'
    AND source_id LIKE 'credit:${connectorId}:%'
    AND source_id <> 'credit:${connectorId}:main'
    AND canonical_account_id IS NULL`;
  const physicalAccountId = `(SELECT id FROM bank_accounts
    WHERE ${physicalAccountFilter}
    ORDER BY id
    LIMIT 1)`;
  const hasSinglePhysicalCard = `(SELECT COUNT(*) FROM bank_accounts
    WHERE ${physicalAccountFilter}) = 1`;

  return [
    db.prepare(
      `DELETE FROM credit_card_bills
       WHERE account_id = ${mainAccountId}
         AND ${hasSinglePhysicalCard}
         AND EXISTS (
           SELECT 1 FROM credit_card_bills current
           WHERE current.account_id = ${physicalAccountId}
             AND current.billing_period = credit_card_bills.billing_period
         )`,
    ),
    db.prepare(
      `DELETE FROM bank_balance_snapshots
       WHERE account_id = ${mainAccountId}
         AND ${hasSinglePhysicalCard}
         AND EXISTS (
           SELECT 1 FROM bank_balance_snapshots current
           WHERE current.account_id = ${physicalAccountId}
             AND current.source_id = bank_balance_snapshots.source_id
         )`,
    ),
    ...mergeLegacyTransactionStatements(
      db,
      `
      SELECT shadow.id AS old_id, canonical.id AS new_id
      FROM bank_transactions shadow
      JOIN bank_transactions canonical
        ON canonical.connector_id = shadow.connector_id
       AND canonical.account_id = ${physicalAccountId}
       AND canonical.source_id = shadow.source_id
      WHERE shadow.connector_id = '${connectorId}'
        AND shadow.account_id = ${mainAccountId}
        AND ${hasSinglePhysicalCard}`,
    ),
    db.prepare(
      `UPDATE credit_card_bills
       SET account_id = ${physicalAccountId}
       WHERE account_id = ${mainAccountId}
         AND ${hasSinglePhysicalCard}`,
    ),
    db.prepare(
      `UPDATE bank_balance_snapshots
       SET account_id = ${physicalAccountId}
       WHERE account_id = ${mainAccountId}
         AND ${hasSinglePhysicalCard}`,
    ),
    db.prepare(
      `UPDATE bank_transactions
       SET account_id = ${physicalAccountId}
       WHERE account_id = ${mainAccountId}
         AND ${hasSinglePhysicalCard}
         AND NOT EXISTS (
           SELECT 1 FROM bank_transactions current
           WHERE current.connector_id = bank_transactions.connector_id
             AND current.account_id = ${physicalAccountId}
             AND current.source_id = bank_transactions.source_id
         )`,
    ),
    db.prepare(
      `DELETE FROM bank_accounts
       WHERE id = ${mainAccountId}
         AND ${hasSinglePhysicalCard}
         AND NOT EXISTS (
           SELECT 1 FROM bank_balance_snapshots
           WHERE account_id = bank_accounts.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM bank_transactions
           WHERE account_id = bank_accounts.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM credit_card_bills
           WHERE account_id = bank_accounts.id
         )`,
    ),
  ];
}
