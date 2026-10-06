-- Preserve every preference. Existing orphan references must be reviewed before
-- applying this migration; copying them fails instead of deleting user decisions.
CREATE TABLE bank_transaction_preferences_new (
  transaction_id TEXT NOT NULL PRIMARY KEY REFERENCES bank_transactions (id),
  excluded_from_calculation INTEGER NOT NULL DEFAULT 0 CHECK (excluded_from_calculation IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO bank_transaction_preferences_new
  (transaction_id, excluded_from_calculation, created_at, updated_at)
SELECT transaction_id, excluded_from_calculation, created_at, updated_at
FROM bank_transaction_preferences;

DROP TABLE bank_transaction_preferences;
ALTER TABLE bank_transaction_preferences_new RENAME TO bank_transaction_preferences;
CREATE INDEX idx_bank_transaction_preferences_excluded
  ON bank_transaction_preferences (excluded_from_calculation);

CREATE TABLE invoice_transaction_preferences_new (
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

INSERT INTO invoice_transaction_preferences_new
  (invoice_id, transaction_id, decision, created_at, updated_at)
SELECT invoice_id, transaction_id, decision, created_at, updated_at
FROM invoice_transaction_preferences;

DROP TABLE invoice_transaction_preferences;
ALTER TABLE invoice_transaction_preferences_new RENAME TO invoice_transaction_preferences;
CREATE UNIQUE INDEX idx_invoice_transaction_preferences_linked_transaction
  ON invoice_transaction_preferences (transaction_id)
  WHERE decision = 'linked';
CREATE INDEX idx_invoice_transaction_preferences_transaction
  ON invoice_transaction_preferences (transaction_id);
