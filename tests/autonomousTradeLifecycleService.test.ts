import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AUTONOMOUS_TRADE_LIFECYCLE_STATES,
  classifyOptionStrategy,
  validateCloseOperation,
  validateLifecycleTransition
} from "../src/services/autonomousTradeLifecycleService.js";

test("exposes the complete lifecycle domain contracts", async () => {
  assert.ok(AUTONOMOUS_TRADE_LIFECYCLE_STATES.includes("intent_created"));
  assert.ok(AUTONOMOUS_TRADE_LIFECYCLE_STATES.includes("closed"));
  assert.equal(validateCloseOperation({ positionSide: "short", operation: "buy" }).valid, false);
  assert.equal(validateCloseOperation({ positionSide: "short", operation: "buy_to_cover" }).valid, true);
});

test("classifies options from observed UTC date-only expiration", () => {
  assert.equal(classifyOptionStrategy({ observedAt: "2026-07-24T14:00:00.000Z", expiration: "2026-07-24" }), "zero_dte");
  assert.equal(classifyOptionStrategy({ observedAt: "2026-07-24T14:00:00.000Z", expiration: "2027-07-24" }), "leaps");
  assert.equal(classifyOptionStrategy({ observedAt: "2026-07-24T14:00:00.000Z", expiration: "2026-08-21" }), "standard");
});

test("rejects invalid lifecycle transitions", () => {
  assert.throws(() => validateLifecycleTransition("closed", "submitted"), /INVALID_LIFECYCLE_TRANSITION/);
  assert.doesNotThrow(() => validateLifecycleTransition("intent_created", "submission_attempt_persisted"));
});

test("migration 006 contains durable lifecycle lineage and terminal transition tables", async () => {
  const sql = await readFile(new URL("../src/lib/database/migrations/006_autonomous_trade_lifecycle.sql", import.meta.url), "utf8");
  assert.match(sql, /ALTER TABLE order_intents/i);
  assert.match(sql, /cycle_id/i);
  assert.match(sql, /workstream/i);
  assert.match(sql, /CREATE TABLE(?: IF NOT EXISTS)? autonomous_trade_lifecycle_transitions/i);
  assert.match(sql, /append-only|ON CONFLICT/i);
  assert.match(sql, /CREATE TABLE(?: IF NOT EXISTS)? reservation_terminal_transitions/i);
  assert.match(sql, /UNIQUE\s*\(reservation_id\)/i);
});
