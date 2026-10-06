import { mergeLegacyTransactionStatements } from "../../features/sync/transaction-merge";
import { reconcileSingleCardSummaryAccountStatements } from "../../features/sync/card-reconciliation";

export function reconcileHncbSingleCardSummaryAccountStatements(
  db: D1Database,
) {
  return reconcileSingleCardSummaryAccountStatements(db, "hncb");
}

export function reconcileHncbLegacyTransactionStatements(db: D1Database) {
  const match = `canonical.connector_id = legacy.connector_id
      AND canonical.account_id = legacy.account_id
      AND (
        substr(canonical.authorized_at, 1, 10) = substr(legacy.authorized_at, 1, 10)
        OR substr(canonical.authorized_at, 1, 10) = substr(legacy.posted_date, 1, 10)
        OR substr(canonical.posted_date, 1, 10) = substr(legacy.posted_date, 1, 10)
        OR substr(canonical.posted_date, 1, 10) = substr(legacy.authorized_at, 1, 10)
      )
      AND canonical.amount = legacy.amount
      AND canonical.currency = legacy.currency`;
  return mergeLegacyTransactionStatements(
    db,
    `
    SELECT legacy.id AS old_id, canonical.id AS new_id
    FROM bank_transactions legacy
    JOIN bank_transactions canonical ON ${match}
    WHERE legacy.connector_id = 'hncb'
      AND legacy.source_id LIKE 'hncb:card:tx:%'
      AND legacy.source_id NOT LIKE 'hncb:card:tx:v2:%'
      AND canonical.source_id LIKE 'hncb:card:tx:v2:%'
      `,
  );
}
