ALTER TABLE option_contracts
  ADD COLUMN evidence jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE option_contracts
  ADD CONSTRAINT option_contracts_evidence_object
  CHECK (jsonb_typeof(evidence) = 'object');
