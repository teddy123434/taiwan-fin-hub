import { mergeLegacyTransactionStatements } from "../../features/sync/transaction-merge";
import { reconcileSingleCardSummaryAccountStatements } from "../../features/sync/card-reconciliation";

export function reconcileEsunLifecycleShadowStatements(db: D1Database) {
  const shadowJoin = `canonical.connector_id = shadow.connector_id
      AND canonical.account_id = shadow.account_id
      AND canonical.source_id = replace(
        replace(shadow.source_id, ':已入帳:', ':'),
        ':未入帳:', ':'
      )`;
  const isLifecycleShadow = `shadow.connector_id = 'esun'
      AND (instr(shadow.source_id, ':已入帳:') > 0 OR instr(shadow.source_id, ':未入帳:') > 0)`;
  return mergeLegacyTransactionStatements(
    db,
    `
    SELECT shadow.id AS old_id, canonical.id AS new_id
    FROM bank_transactions shadow
    JOIN bank_transactions canonical ON ${shadowJoin}
    WHERE ${isLifecycleShadow}`,
  );
}

export function reconcileEsunSingleCardSummaryAccountStatements(
  db: D1Database,
) {
  return reconcileSingleCardSummaryAccountStatements(db, "esun");
}
