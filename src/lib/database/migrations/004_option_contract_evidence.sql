ALTER TABLE option_contracts
  ADD COLUMN IF NOT EXISTS contract_id text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS exercise_style text,
  ADD COLUMN IF NOT EXISTS open_interest numeric,
  ADD COLUMN IF NOT EXISTS open_interest_date date,
  ADD COLUMN IF NOT EXISTS close_price numeric,
  ADD COLUMN IF NOT EXISTS close_price_date date,
  ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'option_contracts_evidence_object'
      AND conrelid = 'option_contracts'::regclass
  ) THEN
    ALTER TABLE option_contracts
      ADD CONSTRAINT option_contracts_evidence_object
      CHECK (jsonb_typeof(evidence) = 'object'::text) NOT VALID;
  END IF;
END
$migration$;

ALTER TABLE option_contracts
  VALIDATE CONSTRAINT option_contracts_evidence_object;
