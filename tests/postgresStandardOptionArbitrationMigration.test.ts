import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { listPostgresMigrations } from "../src/lib/database/postgresMigrations.js";

test("migration 011 permits standard options at the arbitration audit boundary", async () => {
  const migrations = await listPostgresMigrations(
    join(process.cwd(), "src/lib/database/migrations")
  );
  const migration = migrations.find(({ version }) => version === 11);

  assert.ok(migration, "migration 011 must exist");
  assert.equal(migration.name, "standard_option_arbitration_lane");
  assert.match(
    migration.sql,
    /DROP CONSTRAINT portfolio_arbitration_lane_valid;/
  );
  assert.match(
    migration.sql,
    /ADD CONSTRAINT portfolio_arbitration_lane_valid CHECK \(\s*lane IN \('equity', 'options_standard', 'options_0dte', 'options_leaps'\)\s*\);/
  );
  assert.doesNotMatch(migration.sql, /CREATE TABLE|DROP TABLE|DELETE FROM|TRUNCATE/i);
});
