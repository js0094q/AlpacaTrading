import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("portfolio arbitration schema is paper-only, audited, and cycle-idempotent", async () => {
  const sql = await readFile(
    new URL(
      "../src/lib/database/migrations/008_portfolio_resource_arbitration.sql",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(sql, /CREATE TABLE portfolio_arbitration_decisions/);
  assert.match(sql, /action IN \('approve', 'resize', 'skip'\)/);
  assert.match(sql, /environment = 'paper'/);
  assert.match(sql, /NOT live_trading_enabled/);
  assert.match(sql, /UNIQUE \(arbitration_id, proposal_id\)/);
  assert.match(sql, /UNIQUE \(cycle_id, proposal_id\)/);
  assert.match(sql, /decision_fingerprint/);
  assert.match(sql, /scheduler_fencing_token/);
  assert.match(sql, /reason_codes jsonb/);
  assert.match(sql, /deterministic_tiebreak/);
  assert.doesNotMatch(sql, /api[_-]?key|secret|credential/i);
});
