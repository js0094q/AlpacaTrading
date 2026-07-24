import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AUTONOMOUS_TRADE_LIFECYCLE_STATES,
  DomainInvariantError,
  STRATEGY_CLASSIFICATIONS,
  TRADE_OPERATIONS,
  classifyOptionStrategy,
  validateCloseOperation,
  validateLifecycleTransition,
  type AutonomousTradeLifecycleService,
  type PersistedOrderIntent,
  type WorkerExecutionContext
} from "../src/services/autonomousTradeLifecycleService.js";

test("exposes the exact lifecycle domain contracts", () => {
  assert.deepEqual(AUTONOMOUS_TRADE_LIFECYCLE_STATES, [
    "candidate_created", "review_created", "confirmed", "ready_for_submission",
    "submission_attempt_persisted", "submission_ambiguous", "broker_order_discovered",
    "broker_order_accepted", "partially_filled", "filled", "position_reconciled",
    "exit_evaluated", "exit_review_created", "exit_confirmed", "exit_ready_for_submission",
    "exit_submission_attempt_persisted", "exit_submission_ambiguous",
    "exit_broker_order_discovered", "exit_partially_filled", "closed", "cancel_requested",
    "cancel_ambiguous", "cancelled", "rejected", "expired", "failed_terminal"
  ]);
  assert.deepEqual(TRADE_OPERATIONS, ["buy_to_open", "sell_to_open", "sell_to_close", "buy_to_cover"]);
  assert.deepEqual(STRATEGY_CLASSIFICATIONS, [
    "equity_long", "equity_short", "standard_long_call", "standard_long_put",
    "zero_dte_long_call", "zero_dte_long_put", "leaps_long_call", "leaps_long_put", "hedge"
  ]);
});

test("classifies options from observed UTC date-only expiration", () => {
  assert.equal(classifyOptionStrategy({ observedAt: "2026-07-24T14:00:00.000Z", expiration: "2026-07-24", optionType: "call" }), "zero_dte_long_call");
  assert.equal(classifyOptionStrategy({ observedAt: "2026-07-24T14:00:00.000Z", expiration: "2027-07-24", optionType: "put" }), "leaps_long_put");
  assert.equal(classifyOptionStrategy({ observedAt: "2026-07-24T14:00:00.000Z", expiration: "2026-08-21", optionType: "call" }), "standard_long_call");
});

test("requires domain close operations before broker-side mapping", () => {
  const shortPosition = {
    id: "position-short",
    assetClass: "equity" as const,
    side: "short" as const,
    symbol: "POOL",
    contractId: null,
    originatingCandidateId: "candidate-short",
    openingIntentId: "intent-open",
    openQuantity: "1",
    strategyClassification: "equity_short" as const
  };
  assert.throws(
    () => validateCloseOperation(shortPosition, "buy_to_open"),
    (error) => error instanceof DomainInvariantError &&
      error.message === "SHORT_POSITION_REQUIRES_BUY_TO_COVER"
  );
  assert.doesNotThrow(() => validateCloseOperation(shortPosition, "buy_to_cover"));
});

test("exports compile-time lifecycle service and persisted intent contracts", () => {
  const acceptsService = (_service: AutonomousTradeLifecycleService) => true;
  const acceptsContext = (_context: WorkerExecutionContext) => true;
  const acceptsIntent = (_intent: PersistedOrderIntent) => true;
  assert.equal(typeof acceptsService, "function");
  assert.equal(typeof acceptsContext, "function");
  assert.equal(typeof acceptsIntent, "function");
});

test("rejects invalid lifecycle transitions", () => {
  assert.throws(
    () => validateLifecycleTransition("closed", "submission_attempt_persisted"),
    /INVALID_LIFECYCLE_TRANSITION/
  );
  assert.doesNotThrow(() =>
    validateLifecycleTransition("ready_for_submission", "submission_attempt_persisted")
  );
});

test("migration 006 contains durable lifecycle lineage and terminal transition tables", async () => {
  const sql = await readFile(new URL("../src/lib/database/migrations/006_autonomous_trade_lifecycle.sql", import.meta.url), "utf8");
  assert.match(sql, /ALTER TABLE order_intents/i);
  assert.match(sql, /cycle_id/i);
  assert.match(sql, /autonomous_cycle_id/i);
  assert.match(sql, /workstream_execution_id/i);
  assert.match(sql, /authorization_snapshot_id/i);
  assert.match(sql, /parent_position_id/i);
  assert.match(sql, /contract_id/i);
  assert.match(sql, /CHECK[\s\S]*lifecycle_state/i);
  assert.match(sql, /BEFORE\s+(UPDATE|DELETE)/i);
  assert.match(sql, /enforce_autonomous_lifecycle_transition/i);
  assert.match(sql, /INVALID_LIFECYCLE_TRANSITION/i);
  assert.match(sql, /reservation_release_reason_contract/i);
  assert.match(sql, /reservation_terminal_transitions_append_only/i);
  assert.doesNotMatch(
    sql,
    /WHEN\s+status\s*=\s*'submitted'\s+THEN\s+'broker_order_accepted'/i
  );
  assert.match(sql, /FROM\s+option_contracts/i);
  assert.match(sql, /expiration_date/i);
  assert.match(sql, /CREATE TABLE(?: IF NOT EXISTS)? autonomous_trade_lifecycle_transitions/i);
  assert.match(sql, /append-only|ON CONFLICT/i);
  assert.match(sql, /CREATE TABLE(?: IF NOT EXISTS)? reservation_terminal_transitions/i);
  assert.match(sql, /UNIQUE\s*\(reservation_id\)/i);
});
