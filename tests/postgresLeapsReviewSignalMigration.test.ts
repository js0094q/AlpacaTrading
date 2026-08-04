import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { listPostgresMigrations } from "../src/lib/database/postgresMigrations.js";

test("migration 012 adds durable non-executable LEAPS review signals", async () => {
  const migrations = await listPostgresMigrations(
    join(process.cwd(), "src/lib/database/migrations")
  );
  const migration = migrations.find(({ version }) => version === 12);

  assert.ok(migration, "migration 012 must exist");
  assert.equal(migration.name, "leaps_review_signals");
  assert.match(migration.sql, /CREATE TABLE position_review_signals/);
  assert.match(migration.sql, /position_id text NOT NULL REFERENCES positions\(id\)/);
  assert.match(migration.sql, /executable boolean NOT NULL DEFAULT false/);
  assert.match(migration.sql, /CHECK \(NOT executable\)/);
  assert.match(migration.sql, /action IN \('review', 'partial_exit_review'\)/);
  assert.match(migration.sql, /jsonb_typeof\(reasons\) = 'array'/);
  assert.match(migration.sql, /jsonb_array_length\(reasons\) > 0/);
  assert.match(migration.sql, /last_observation_id char\(64\) NOT NULL/);
  assert.match(
    migration.sql,
    /CONSTRAINT position_review_signals_identity_unique\s+UNIQUE \(position_id, signal_fingerprint\)/
  );
  assert.match(
    migration.sql,
    /CREATE INDEX position_review_signals_open_observed_idx[\s\S]*WHERE status = 'open'/
  );
  assert.doesNotMatch(migration.sql, /DROP TABLE|DELETE FROM|TRUNCATE/i);
});
