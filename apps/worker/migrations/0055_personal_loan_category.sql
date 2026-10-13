ALTER TABLE bank_accounts
ADD COLUMN loan_category_expanded TEXT
CHECK (
  loan_category_expanded IS NULL
  OR loan_category_expanded IN ('housing', 'personal', 'other')
);

UPDATE bank_accounts
SET loan_category_expanded = loan_category;

ALTER TABLE bank_accounts DROP COLUMN loan_category;

ALTER TABLE bank_accounts
RENAME COLUMN loan_category_expanded TO loan_category;
