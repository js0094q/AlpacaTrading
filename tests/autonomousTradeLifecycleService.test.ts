import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AUTONOMOUS_TRADE_LIFECYCLE_STATES,
  STRATEGY_CLASSIFICATIONS,
  TRADE_OPERATIONS,
  AutonomousTradeLifecycleService,
  classifyOptionStrategy,
  validateCloseOperation,
  validateLifecycleTransition
} from "../src/services/autonomousTradeLifecycleService.js";

test("exposes the complete lifecycle domain contracts", async () => {
  assert.equal(AUTONOMOUS_TRADE_LIFECYCLE_STATES.length, 25);
  assert.equal(AUTONOMOUS_TRADE_LIFECYCLE_STATES[0], "candidate_created");
  assert.equal(AUTONOMOUS_TRADE_LIFECYCLE_STATES.at(-1), "failed_terminal");
  assert.deepEqual(TRADE_OPERATIONS, ["buy_to_open", "sell_to_open", "sell_to_close", "buy_to_cover"]);
  assert.deepEqual(STRATEGY_CLASSIFICATIONS, [
    "equity_long", "equity_short", "standard_call", "standard_put",
    "zero_dte_call", "zero_dte_put", "leaps_call", "leaps_put", "hedge"
  ]);
  assert.equal(validateCloseOperation({ positionSide: "short", operation: "buy" }).valid, false);
  assert.equal(validateCloseOperation({ positionSide: "short", operation: "buy_to_cover" }).valid, true);
});

test("classifies options from observed UTC date-only expiration", () => {
  assert.equal(classifyOptionStrategy({ observedAt: "2026-07-24T14:00:00.000Z", expiration: "2026-07-24", optionType: "call" }), "zero_dte_call");
  assert.equal(classifyOptionStrategy({ observedAt: "2026-07-24T14:00:00.000Z", expiration: "2027-07-24", optionType: "put" }), "leaps_put");
  assert.equal(classifyOptionStrategy({ observedAt: "2026-07-24T14:00:00.000Z", expiration: "2026-08-21", optionType: "call" }), "standard_call");
});

test("exports the lifecycle service interface and typed result", () => {
  const service = new AutonomousTradeLifecycleService();
  assert.equal(typeof service.validateTransition, "function");
  assert.equal(typeof service.classifyOption, "function");
  assert.equal(service.validateTransition("intent_created", "submission_attempt_persisted").ok, true);
});

test("rejects invalid lifecycle transitions", () => {
  assert.throws(() => validateLifecycleTransition("closed", "submitted"), /INVALID_LIFECYCLE_TRANSITION/);
  assert.doesNotThrow(() => validateLifecycleTransition("intent_created", "submission_attempt_persisted"));
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
  assert.match(sql, /CREATE TABLE(?: IF NOT EXISTS)? autonomous_trade_lifecycle_transitions/i);
  assert.match(sql, /append-only|ON CONFLICT/i);
  assert.match(sql, /CREATE TABLE(?: IF NOT EXISTS)? reservation_terminal_transitions/i);
  assert.match(sql, /UNIQUE\s*\(reservation_id\)/i);
});
