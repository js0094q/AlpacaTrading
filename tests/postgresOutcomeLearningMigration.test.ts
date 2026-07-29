import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  POSTGRES_OPERATIONAL_INDEXES,
  POSTGRES_OPERATIONAL_TABLES
} from "../src/lib/database/postgresSchema.js";

const migrationPath = new URL(
  "../src/lib/database/migrations/009_bounded_outcome_learning.sql",
  import.meta.url
);

test("migration 009 creates bounded normalized outcome learning state", async () => {
  const sql = await readFile(migrationPath, "utf8");

  for (const table of [
    "outcome_learning_refresh_runs",
    "outcome_learning_records",
    "historical_outcome_aggregates"
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table}\\b`), table);
    assert.ok(POSTGRES_OPERATIONAL_TABLES.includes(table as never), table);
  }

  for (const required of [
    "environment",
    "candidate_id",
    "proposal_id",
    "arbitration_decision_id",
    "review_id",
    "exit_review_id",
    "intent_id",
    "client_order_id",
    "alpaca_order_id",
    "broker_event_ids",
    "research_signal_ids",
    "research_horizons",
    "time_horizon",
    "fill_status",
    "market_evidence_ids",
    "reference_received_at",
    "reference_persisted_at",
    "fill_vs_midpoint",
    "spread_at_reference_bps",
    "join_status",
    "partial_join_reasons",
    "missing_join_reasons",
    "ambiguous_join_reasons",
    "unsupported_join_reasons",
    "metric_limitations",
    "paper_limitations",
    "source_fingerprint",
    "content_hash",
    "schema_version"
  ]) {
    assert.match(sql, new RegExp(`\\b${required}\\b`), required);
  }

  assert.match(sql, /environment IN \('paper', 'live', 'unknown'\)/);
  assert.match(sql, /join_status IN \('exact', 'partial', 'missing', 'ambiguous', 'unsupported'\)/);
  assert.match(sql, /lane IN \('equity', 'options_0dte', 'options_leaps', 'unknown'\)/);
  assert.match(sql, /date_range_end > date_range_start/);
  assert.match(sql, /requested_max_records BETWEEN 1 AND 500/);
  assert.match(sql, /source_record_count BETWEEN 0 AND requested_max_records/);
  assert.match(sql, /UNIQUE \(environment, candidate_id, schema_version\)/);
  assert.match(
    sql,
    /UNIQUE \(\s*environment,\s*lane,\s*dimension,\s*grouping_key,\s*date_range_start,\s*date_range_end,\s*schema_version\s*\)/
  );
  assert.match(sql, /candidates_outcome_learning_as_of_idx/);
  assert.match(sql, /outcome_learning_records_environment_lane_idx/);
  assert.match(sql, /historical_outcome_aggregates_lookup_idx/);
  assert.match(sql, /historical_outcome_aggregates_evidence_idx/);
  assert.match(sql, /historical_outcome_aggregates_range_idx/);
  assert.doesNotMatch(sql, /api[_-]?key|secret|credential/i);
});

test("migration 009 persists only derived evidence and no executable broker payload", async () => {
  const sql = await readFile(migrationPath, "utf8");

  for (const forbidden of [
    "broker_payload",
    "order_payload",
    "request_payload",
    "confirmation_payload",
    "api_key",
    "limit_order_payload"
  ]) {
    assert.doesNotMatch(sql, new RegExp(`\\b${forbidden}\\b`, "i"), forbidden);
  }

  for (const index of [
    "candidates_outcome_learning_as_of_idx",
    "outcome_learning_refresh_runs_range_idx",
    "outcome_learning_records_environment_lane_idx",
    "outcome_learning_records_symbol_idx",
    "outcome_learning_records_proposed_idx",
    "outcome_learning_records_refresh_idx",
    "historical_outcome_aggregates_lookup_idx",
    "historical_outcome_aggregates_evidence_idx",
    "historical_outcome_aggregates_range_idx",
    "historical_outcome_aggregates_refresh_idx"
  ]) {
    assert.ok(POSTGRES_OPERATIONAL_INDEXES.includes(index as never), index);
  }
});
