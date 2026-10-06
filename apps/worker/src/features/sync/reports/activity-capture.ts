/** Set-based journal writes share the promotion transaction and its lock owner. */
export function captureStagedActivityBefore(
  db: D1Database,
  stagingRunId: string,
  entities: Array<{
    entityType: string;
    table: string;
    conflictColumns: string[];
  }>,
) {
  const owner = `JOIN sync_jobs job ON job.connector_id = json_extract(staging.payload, '$.connector_id')
    JOIN sync_activity_runs run ON run.id = job.locked_by`;
  const statements = entities.map(({ entityType, table, conflictColumns }) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO sync_activity_changes
      (run_id, entity_type, record_id, change_kind, snapshot)
      SELECT run.id, staging.entity_type, json_extract(staging.payload, '$.id'), 'added', '{}'
      FROM sync_write_staging staging ${owner}
      WHERE staging.run_id = ? AND staging.entity_type = ?
        AND NOT EXISTS (SELECT 1 FROM ${table} target WHERE ${conflictColumns.map((c) => `target.${c} = json_extract(staging.payload, '$.${c}')`).join(" AND ")})`,
      )
      .bind(stagingRunId, entityType),
  );
  if (entities.some((e) => e.entityType === "bank_transaction")) {
    // Observe existing unmatched authorizations before lifecycle reconciliation.
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO sync_activity_changes
      (run_id, entity_type, record_id, change_kind, snapshot)
      SELECT run.id, 'bank_transaction', txn.id, 'pending', '{}'
      FROM sync_activity_runs run JOIN sync_jobs job ON job.locked_by = run.id
      JOIN bank_transactions txn ON txn.connector_id = run.connector_id
      WHERE txn.status = 'pending' AND txn.matched_transaction_id IS NULL
        AND EXISTS (SELECT 1 FROM sync_write_staging staging WHERE staging.run_id = ?
          AND staging.entity_type = 'bank_transaction'
          AND json_extract(staging.payload, '$.connector_id') = run.connector_id)`,
        )
        .bind(stagingRunId),
    );
  }
  return statements;
}

export const bankActivitySnapshotSql = (t: string, a: string) => `json_object(
  'id', ${t}.id, 'connectorId', ${t}.connector_id, 'sourceId', ${t}.source_id,
  'accountId', ${t}.account_id, 'accountType', ${a}.account_type,
  'institutionName', ${a}.institution_name, 'accountName', ${a}.account_name,
  'accountLast4', ${a}.account_last4, 'amount', ${t}.amount, 'currency', ${t}.currency,
  'authorizedAt', ${t}.authorized_at, 'postedDate', ${t}.posted_date,
  'description', ${t}.description, 'counterparty', ${t}.counterparty, 'status', ${t}.status,
  'canonicalAccountId', ${a}.canonical_account_id)`;

export function captureStagedActivityAfter(
  db: D1Database,
  stagingRunId: string,
) {
  const runs = `SELECT DISTINCT job.locked_by FROM sync_write_staging staging
    JOIN sync_jobs job ON job.connector_id = json_extract(staging.payload, '$.connector_id')
    WHERE staging.run_id = ?`;
  return [
    db
      .prepare(
        `UPDATE sync_activity_runs SET captured_at = ? WHERE id IN (${runs})`,
      )
      .bind(new Date().toISOString(), stagingRunId),
    db
      .prepare(
        `UPDATE sync_activity_changes AS change SET change_kind = 'posted'
      WHERE run_id IN (${runs}) AND entity_type = 'bank_transaction' AND change_kind = 'pending'
        AND EXISTS (SELECT 1 FROM bank_transactions t WHERE t.id = change.record_id
          AND (t.status = 'posted' OR t.matched_transaction_id IS NOT NULL))`,
      )
      .bind(stagingRunId),
    db
      .prepare(
        `DELETE FROM sync_activity_changes WHERE run_id IN (${runs}) AND change_kind = 'pending'`,
      )
      .bind(stagingRunId),
    db
      .prepare(
        `UPDATE sync_activity_changes AS change SET snapshot = (
      SELECT ${bankActivitySnapshotSql("t", "a")} FROM bank_transactions original
      JOIN bank_transactions t ON t.id = COALESCE(original.matched_transaction_id, original.id)
      JOIN bank_accounts a ON a.id = t.account_id WHERE original.id = change.record_id
    ) WHERE run_id IN (${runs}) AND entity_type = 'bank_transaction'
      AND EXISTS (SELECT 1 FROM bank_transactions WHERE id = change.record_id)`,
      )
      .bind(stagingRunId),
    db
      .prepare(
        `UPDATE sync_activity_changes AS change SET snapshot = (
      SELECT json_object('id', i.id, 'invoiceDate', i.invoice_date, 'sellerName', i.seller_name,
        'invoiceNumber', i.invoice_number, 'amount', i.amount) FROM invoices i WHERE i.id = change.record_id
    ) WHERE run_id IN (${runs}) AND entity_type = 'invoice'`,
      )
      .bind(stagingRunId),
    db
      .prepare(
        `UPDATE sync_activity_changes AS change SET snapshot = (
      SELECT json_object('id', t.id, 'name', t.name, 'symbol', t.symbol, 'tradeDate', t.trade_date,
        'postedDate', t.posted_date, 'transactionName', t.transaction_name, 'transactionCode', t.transaction_code,
        'quantity', t.quantity, 'price', t.price, 'amount', t.amount, 'currency', t.currency)
      FROM investment_transactions t WHERE t.id = change.record_id
    ) WHERE run_id IN (${runs}) AND entity_type = 'investment_transaction'`,
      )
      .bind(stagingRunId),
    db
      .prepare(
        `DELETE FROM sync_activity_changes WHERE run_id IN (${runs}) AND snapshot = '{}'`,
      )
      .bind(stagingRunId),
  ];
}
