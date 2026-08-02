-- Lane-aware target identity for independently persisted strategy expressions.
-- The migration runner owns BEGIN, COMMIT, ROLLBACK, and migration recording.

ALTER TABLE target_snapshots
  ADD COLUMN strategy_family text,
  ADD COLUMN expression_id text;

ALTER TABLE options_strategy_snapshots
  ADD COLUMN strategy_family text,
  ADD COLUMN expression_id text;

UPDATE target_snapshots
SET strategy_family = 'legacy_default', expression_id = 'legacy_default'
WHERE strategy_family IS NULL OR expression_id IS NULL;

UPDATE options_strategy_snapshots
SET strategy_family = 'legacy_default', expression_id = 'legacy_default'
WHERE strategy_family IS NULL OR expression_id IS NULL;

ALTER TABLE target_snapshots
  DROP CONSTRAINT target_snapshots_pkey;

ALTER TABLE options_strategy_snapshots
  DROP CONSTRAINT options_strategy_snapshots_pkey;

ALTER TABLE target_snapshots
  ALTER COLUMN strategy_family SET NOT NULL,
  ALTER COLUMN expression_id SET NOT NULL;

ALTER TABLE options_strategy_snapshots
  ALTER COLUMN strategy_family SET NOT NULL,
  ALTER COLUMN expression_id SET NOT NULL;

ALTER TABLE target_snapshots
  ADD CONSTRAINT target_snapshots_strategy_identity_nonempty CHECK (
    btrim(strategy_family) <> ''
    AND btrim(expression_id) <> ''
  );

ALTER TABLE options_strategy_snapshots
  ADD CONSTRAINT options_strategy_snapshots_strategy_identity_nonempty CHECK (
    btrim(strategy_family) <> ''
    AND btrim(expression_id) <> ''
  );

ALTER TABLE target_snapshots
  ADD CONSTRAINT target_snapshots_pkey PRIMARY KEY (symbol, as_of, risk_profile, strategy_family, expression_id);

ALTER TABLE options_strategy_snapshots
  ADD CONSTRAINT options_strategy_snapshots_pkey PRIMARY KEY (symbol, as_of, risk_profile, strategy_family, expression_id);

CREATE INDEX target_snapshots_family_as_of_idx
  ON target_snapshots (strategy_family, as_of DESC, symbol);

CREATE INDEX options_strategy_snapshots_family_as_of_idx
  ON options_strategy_snapshots (strategy_family, as_of DESC, symbol);
