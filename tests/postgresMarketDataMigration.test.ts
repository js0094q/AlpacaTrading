import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("migration 003 creates the complete PostgreSQL market-data authority schema", async () => {
  const sql = await readFile(
    "src/lib/database/migrations/003_market_data_authority.sql",
    "utf8"
  );
  for (const table of [
    "market_data_ingestion_runs",
    "universe_symbols",
    "market_bars",
    "stock_snapshots",
    "option_contracts",
    "option_snapshots",
    "feature_snapshots",
    "target_snapshots",
    "options_strategy_snapshots",
    "research_evidence"
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.doesNotMatch(sql, /sqlite/i);
  assert.match(sql, /request_id text/);
  assert.match(sql, /source_fingerprint text/);
  assert.match(sql, /jsonb/);
});
