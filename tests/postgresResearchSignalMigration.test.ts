import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  POSTGRES_OPERATIONAL_INDEXES,
  POSTGRES_OPERATIONAL_TABLES
} from "../src/lib/database/postgresSchema.js";

const migrationPath = new URL(
  "../src/lib/database/migrations/007_public_equity_research_signals.sql",
  import.meta.url
);

test("migration 007 stores one bounded provider-neutral research signal", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.match(sql, /CREATE TABLE research_signals/);
  for (const column of [
    "provider_signal_id",
    "as_of",
    "horizon",
    "thesis_summary",
    "thesis_direction",
    "confidence",
    "catalysts",
    "catalyst_dates",
    "risks",
    "invalidation_conditions",
    "contradiction_status",
    "contradiction_reason",
    "valuation_summary",
    "source_references",
    "expires_or_review_at",
    "ingestion_timestamp",
    "content_hash",
    "schema_version"
  ]) {
    assert.match(sql, new RegExp(`\\b${column}\\b`), column);
  }
  assert.match(sql, /UNIQUE \(provider, symbol, as_of, horizon, content_hash\)/);
  assert.match(sql, /jsonb_array_length\(source_references\) BETWEEN 1 AND 20/);
  assert.match(sql, /confidence BETWEEN 0 AND 1/);
  assert.match(sql, /ingestion_timestamp >= as_of/);
  assert.match(sql, /research_signals_provider_signal_idx/);
  assert.match(sql, /WHERE provider_signal_id IS NOT NULL/);
});

test("research signal schema is authority-verified and contains no broker payload columns", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.ok(POSTGRES_OPERATIONAL_TABLES.includes("research_signals"));
  assert.ok(
    POSTGRES_OPERATIONAL_INDEXES.includes("research_signals_symbol_as_of_idx")
  );
  assert.ok(
    POSTGRES_OPERATIONAL_INDEXES.includes("research_signals_provider_signal_idx")
  );
  for (const forbidden of [
    "quantity",
    "side",
    "order_type",
    "limit_price",
    "stop_price",
    "client_order_id",
    "broker_payload"
  ]) {
    assert.doesNotMatch(sql, new RegExp(`\\b${forbidden}\\b`), forbidden);
  }
});
