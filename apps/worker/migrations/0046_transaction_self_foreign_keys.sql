-- Rebuild transaction references without cascading or discarding user preferences.
-- Applied atomically by the D1 migration runner; orphan references abort the migration.

CREATE TABLE _0046_bank_transaction_preferences_backup AS SELECT * FROM bank_transaction_preferences;

DROP TABLE bank_transaction_preferences;

CREATE TABLE _0046_invoice_transaction_preferences_backup AS SELECT * FROM invoice_transaction_preferences;

DROP TABLE invoice_transaction_preferences;

CREATE TABLE bank_transactions_new (
  id TEXT NOT NULL PRIMARY KEY,
  connector_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES "bank_accounts" (id),
  source_id TEXT NOT NULL,
  posted_date TEXT,
  authorized_at TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'TWD',
  description TEXT,
  counterparty TEXT,
  raw_payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  effective_date TEXT AS (COALESCE(posted_date, authorized_at, '')),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('pending', 'posted')),
  transfer_peer_id TEXT REFERENCES bank_transactions_new (id),
  matched_transaction_id TEXT REFERENCES bank_transactions_new (id),
  UNIQUE (connector_id, account_id, source_id)
);

INSERT INTO bank_transactions_new (id, connector_id, account_id, source_id, posted_date, authorized_at, amount, currency, description, counterparty, raw_payload, created_at, updated_at, status, transfer_peer_id, matched_transaction_id)
SELECT id, connector_id, account_id, source_id, posted_date, authorized_at, amount, currency, description, counterparty, raw_payload, created_at, updated_at, status, transfer_peer_id, matched_transaction_id FROM bank_transactions;

DROP TABLE bank_transactions;

ALTER TABLE bank_transactions_new RENAME TO bank_transactions;

CREATE UNIQUE INDEX idx_bank_transactions_matched_transaction
  ON bank_transactions(matched_transaction_id)
  WHERE matched_transaction_id IS NOT NULL;

CREATE INDEX idx_bank_transactions_transaction_day
  ON bank_transactions (
    CASE
      WHEN length(authorized_at) > 10
        THEN COALESCE(
          date(authorized_at, '+8 hours'),
          substr(authorized_at, 1, 10)
        )
      ELSE substr(COALESCE(authorized_at, posted_date), 1, 10)
    END
  );

CREATE INDEX idx_bank_transactions_status
  ON bank_transactions (connector_id, account_id, status);

CREATE INDEX idx_bank_transactions_effective_updated
  ON bank_transactions (effective_date DESC, updated_at DESC, id DESC);

CREATE INDEX idx_bank_transactions_posted_date
  ON bank_transactions (posted_date);

CREATE INDEX idx_bank_transactions_account_posted_date
  ON bank_transactions (account_id, posted_date);

CREATE INDEX idx_bank_transactions_transfer_peer ON bank_transactions (transfer_peer_id);

CREATE TABLE "bank_transaction_preferences" (
  transaction_id TEXT NOT NULL PRIMARY KEY REFERENCES bank_transactions (id),
  excluded_from_calculation INTEGER NOT NULL DEFAULT 0 CHECK (excluded_from_calculation IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO bank_transaction_preferences SELECT * FROM _0046_bank_transaction_preferences_backup;

DROP TABLE _0046_bank_transaction_preferences_backup;

CREATE INDEX idx_bank_transaction_preferences_excluded
  ON bank_transaction_preferences (excluded_from_calculation);

CREATE TABLE "invoice_transaction_preferences" (
  invoice_id TEXT NOT NULL PRIMARY KEY REFERENCES invoices (id),
  transaction_id TEXT REFERENCES bank_transactions (id),
  decision TEXT NOT NULL CHECK (decision IN ('linked', 'separate')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (decision = 'linked' AND transaction_id IS NOT NULL)
    OR decision = 'separate'
  )
);

INSERT INTO invoice_transaction_preferences SELECT * FROM _0046_invoice_transaction_preferences_backup;

DROP TABLE _0046_invoice_transaction_preferences_backup;

CREATE UNIQUE INDEX idx_invoice_transaction_preferences_linked_transaction
  ON invoice_transaction_preferences (transaction_id)
  WHERE decision = 'linked';

CREATE INDEX idx_invoice_transaction_preferences_transaction
  ON invoice_transaction_preferences (transaction_id);
