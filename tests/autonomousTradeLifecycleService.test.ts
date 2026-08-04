import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AUTONOMOUS_TRADE_LIFECYCLE_EDGES,
  AUTONOMOUS_TRADE_LIFECYCLE_STATES,
  DomainInvariantError,
  STRATEGY_CLASSIFICATIONS,
  TRADE_OPERATIONS,
  classifyOptionStrategy,
  resolveBrokerReconciliationLifecyclePath,
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
  assert.equal(classifyOptionStrategy({ observedAt: "2026-07-25T01:00:00.000Z", expiration: "2026-07-24", optionType: "put" }), "zero_dte_long_put");
  assert.equal(classifyOptionStrategy({ observedAt: "2026-07-24T14:00:00.000Z", expiration: "2027-04-20", optionType: "call" }), "leaps_long_call");
  assert.equal(classifyOptionStrategy({ observedAt: "2026-07-24T14:00:00.000Z", expiration: "2027-07-24", optionType: "put" }), "leaps_long_put");
  assert.equal(classifyOptionStrategy({ observedAt: "2026-07-24T14:00:00.000Z", expiration: "2026-08-21", optionType: "call" }), "standard_long_call");
});

test("classifies date-only observations identically through both overloads", () => {
  for (const date of ["2026-07-24", "2026-03-08", "2026-11-01"]) {
    assert.equal(
      classifyOptionStrategy({ expirationDate: date, optionType: "call" }, date),
      "zero_dte_long_call"
    );
    assert.equal(
      classifyOptionStrategy({ observedAt: date, expiration: date, optionType: "put" }),
      "zero_dte_long_put"
    );
  }
});

test("shares the configured managed LEAPS threshold with lifecycle classification", () => {
  const previous = process.env.LEAPS_MIN_DTE_AT_ENTRY;
  process.env.LEAPS_MIN_DTE_AT_ENTRY = "365";
  try {
    assert.equal(
      classifyOptionStrategy({ observedAt: "2026-01-01", expiration: "2026-12-31", optionType: "call" }),
      "standard_long_call"
    );
    assert.equal(
      classifyOptionStrategy({ observedAt: "2026-01-01", expiration: "2027-01-01", optionType: "call" }),
      "leaps_long_call"
    );
  } finally {
    if (previous === undefined) delete process.env.LEAPS_MIN_DTE_AT_ENTRY;
    else process.env.LEAPS_MIN_DTE_AT_ENTRY = previous;
  }
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
  for (const terminalState of ["cancelled", "rejected", "expired"] as const) {
    assert.doesNotThrow(() =>
      validateLifecycleTransition("submission_attempt_persisted", terminalState)
    );
    assert.doesNotThrow(() =>
      validateLifecycleTransition("exit_submission_attempt_persisted", terminalState)
    );
  }
});

test("permits cancellation only from maintained nonterminal entry and exit states", () => {
  const cancellableSources = [
    "ready_for_submission",
    "broker_order_discovered",
    "broker_order_accepted",
    "partially_filled",
    "exit_ready_for_submission",
    "exit_broker_order_discovered",
    "exit_partially_filled"
  ] as const;
  for (const source of cancellableSources) {
    assert.doesNotThrow(() =>
      validateLifecycleTransition(source, "cancel_requested")
    );
  }
  for (
    const source of [
      "filled",
      "closed",
      "cancelled",
      "rejected",
      "expired",
      "failed_terminal"
    ] as const
  ) {
    assert.throws(
      () => validateLifecycleTransition(source, "cancel_requested"),
      new RegExp(`INVALID_LIFECYCLE_TRANSITION:${source}->cancel_requested`)
    );
  }
});

test("permits either cancellation phase to reconcile every actual terminal broker outcome", () => {
  const terminalOutcomes = [
    "filled",
    "rejected",
    "expired",
    "cancelled",
    "failed_terminal"
  ] as const;
  for (const source of ["cancel_requested", "cancel_ambiguous"] as const) {
    for (const outcome of terminalOutcomes) {
      assert.doesNotThrow(() =>
        validateLifecycleTransition(source, outcome)
      );
    }
  }
});

test("resolves every entry broker observation through maintained ordered lifecycle hops", () => {
  for (
    const source of [
      "submission_attempt_persisted",
      "submission_ambiguous"
    ] as const
  ) {
    assert.deepEqual(
      resolveBrokerReconciliationLifecyclePath({
        fromState: source,
        reviewType: "entry",
        brokerStatus: "accepted"
      }),
      [source, "broker_order_discovered", "broker_order_accepted"]
    );
    assert.deepEqual(
      resolveBrokerReconciliationLifecyclePath({
        fromState: source,
        reviewType: "entry",
        brokerStatus: "partially_filled"
      }),
      [
        source,
        "broker_order_discovered",
        "broker_order_accepted",
        "partially_filled"
      ]
    );
    assert.deepEqual(
      resolveBrokerReconciliationLifecyclePath({
        fromState: source,
        reviewType: "entry",
        brokerStatus: "filled"
      }),
      [
        source,
        "broker_order_discovered",
        "broker_order_accepted",
        "filled"
      ]
    );
  }
  assert.deepEqual(
    resolveBrokerReconciliationLifecyclePath({
      fromState: "broker_order_discovered",
      reviewType: "entry",
      brokerStatus: "filled"
    }),
    ["broker_order_discovered", "broker_order_accepted", "filled"]
  );
  assert.deepEqual(
    resolveBrokerReconciliationLifecyclePath({
      fromState: "broker_order_accepted",
      reviewType: "entry",
      brokerStatus: "partially_filled"
    }),
    ["broker_order_accepted", "partially_filled"]
  );
  assert.deepEqual(
    resolveBrokerReconciliationLifecyclePath({
      fromState: "partially_filled",
      reviewType: "entry",
      brokerStatus: "filled"
    }),
    ["partially_filled", "filled"]
  );
});

test("resolves every exit broker observation without prematurely closing the position", () => {
  for (
    const source of [
      "exit_submission_attempt_persisted",
      "exit_submission_ambiguous"
    ] as const
  ) {
    assert.deepEqual(
      resolveBrokerReconciliationLifecyclePath({
        fromState: source,
        reviewType: "exit",
        brokerStatus: "accepted"
      }),
      [source, "exit_broker_order_discovered"]
    );
    assert.deepEqual(
      resolveBrokerReconciliationLifecyclePath({
        fromState: source,
        reviewType: "exit",
        brokerStatus: "partially_filled"
      }),
      [
        source,
        "exit_broker_order_discovered",
        "exit_partially_filled"
      ]
    );
    assert.deepEqual(
      resolveBrokerReconciliationLifecyclePath({
        fromState: source,
        reviewType: "exit",
        brokerStatus: "filled"
      }),
      [source, "exit_broker_order_discovered"]
    );
  }
  assert.deepEqual(
    resolveBrokerReconciliationLifecyclePath({
      fromState: "exit_partially_filled",
      reviewType: "exit",
      brokerStatus: "filled"
    }),
    ["exit_partially_filled"],
    "position reconciliation, not order reconciliation, closes the exit"
  );
});

test("resolves canceled, rejected, and expired observations from every persisted broker phase", () => {
  const entrySources = [
    "submission_attempt_persisted",
    "submission_ambiguous",
    "broker_order_discovered",
    "broker_order_accepted",
    "partially_filled"
  ] as const;
  const exitSources = [
    "exit_submission_attempt_persisted",
    "exit_submission_ambiguous",
    "exit_broker_order_discovered",
    "exit_partially_filled"
  ] as const;
  for (
    const [brokerStatus, terminalState] of [
      ["canceled", "cancelled"],
      ["rejected", "rejected"],
      ["expired", "expired"]
    ] as const
  ) {
    for (const fromState of entrySources) {
      const path = resolveBrokerReconciliationLifecyclePath({
        fromState,
        reviewType: "entry",
        brokerStatus
      });
      assert.equal(path[0], fromState);
      assert.equal(path[path.length - 1], terminalState);
      for (let index = 1; index < path.length; index += 1) {
        assert.doesNotThrow(() =>
          validateLifecycleTransition(path[index - 1]!, path[index]!)
        );
      }
    }
    for (const fromState of exitSources) {
      const path = resolveBrokerReconciliationLifecyclePath({
        fromState,
        reviewType: "exit",
        brokerStatus
      });
      assert.equal(path[0], fromState);
      assert.equal(path[path.length - 1], terminalState);
      for (let index = 1; index < path.length; index += 1) {
        assert.doesNotThrow(() =>
          validateLifecycleTransition(path[index - 1]!, path[index]!)
        );
      }
    }
  }
});

test("resolves cancellation fills by review semantics and terminal broker outcomes by audit edge", () => {
  for (const source of ["cancel_requested", "cancel_ambiguous"] as const) {
    assert.deepEqual(
      resolveBrokerReconciliationLifecyclePath({
        fromState: source,
        reviewType: "entry",
        brokerStatus: "filled"
      }),
      [source, "filled"]
    );
    assert.deepEqual(
      resolveBrokerReconciliationLifecyclePath({
        fromState: source,
        reviewType: "exit",
        brokerStatus: "filled"
      }),
      [source, "exit_broker_order_discovered"]
    );
    for (
      const [brokerStatus, lifecycleState] of [
        ["canceled", "cancelled"],
        ["rejected", "rejected"],
        ["expired", "expired"]
      ] as const
    ) {
      assert.deepEqual(
        resolveBrokerReconciliationLifecyclePath({
          fromState: source,
          reviewType: "exit",
          brokerStatus
        }),
        [source, lifecycleState]
      );
    }
  }
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
  assert.match(sql, /terminal_state IN \('filled','cancelled','rejected','expired','closed','failed_terminal'\)/i);
  assert.doesNotMatch(
    sql,
    /WHEN\s+status\s*=\s*'submitted'\s+THEN\s+'broker_order_accepted'/i
  );
  assert.match(sql, /FROM\s+option_contracts/i);
  assert.match(sql, /expiration_date/i);
  assert.match(
    sql,
    /review_id\s*=\s*COALESCE\(review_id,\s*execution_review_id\)/i
  );
  assert.match(
    sql,
    /confirmation_id\s*=\s*COALESCE\(confirmation_id,\s*confirmation_evidence_id\)/i
  );
  assert.match(sql, /authorization_snapshot_id\s*=\s*review\.source_snapshot_id/i);
  assert.match(sql, /COUNT\(\*\)\s+FROM\s+orders[\s\S]*=\s*1/i);
  assert.match(
    sql,
    /COUNT\(\*\)\s+FROM\s+orders[\s\S]*broker_order_id\s+IS\s+NOT\s+NULL[\s\S]*=\s*1/i
  );
  assert.match(sql, /CREATE TABLE(?: IF NOT EXISTS)? autonomous_trade_lifecycle_transitions/i);
  assert.match(sql, /append-only|ON CONFLICT/i);
  assert.match(sql, /CREATE TABLE(?: IF NOT EXISTS)? reservation_terminal_transitions/i);
  assert.match(sql, /UNIQUE\s*\(reservation_id\)/i);
  for (
    const source of [
      "ready_for_submission",
      "broker_order_discovered",
      "broker_order_accepted",
      "partially_filled",
      "exit_ready_for_submission",
      "exit_broker_order_discovered",
      "exit_partially_filled"
    ]
  ) {
    assert.match(
      sql,
      new RegExp(`\\('${source}','cancel_requested'\\)`)
    );
  }
  for (
    const source of [
      "filled",
      "closed",
      "cancelled",
      "rejected",
      "expired",
      "failed_terminal"
    ]
  ) {
    assert.doesNotMatch(
      sql,
      new RegExp(`\\('${source}','cancel_requested'\\)`)
    );
  }
  for (const source of ["cancel_requested", "cancel_ambiguous"]) {
    for (
      const outcome of [
        "filled",
        "rejected",
        "expired",
        "cancelled",
        "failed_terminal"
      ]
    ) {
      assert.match(
        sql,
        new RegExp(`\\('${source}','${outcome}'\\)`)
      );
    }
  }
  const brokerPaths = [
    ["submission_ambiguous", "broker_order_discovered"],
    ["exit_submission_ambiguous", "exit_broker_order_discovered"],
    ["cancel_requested", "exit_broker_order_discovered"],
    ["cancel_ambiguous", "exit_broker_order_discovered"]
  ] as const;
  for (const [fromState, toState] of brokerPaths) {
    assert.match(
      sql,
      new RegExp(`\\('${fromState}','${toState}'\\)`)
    );
  }
  const parityScenarios = [
    ...[
      "submission_attempt_persisted",
      "submission_ambiguous",
      "broker_order_discovered"
    ].flatMap((fromState) =>
      ["accepted", "partially_filled", "filled"].map((brokerStatus) => ({
        fromState,
        reviewType: "entry" as const,
        brokerStatus
      }))
    ),
    ...[
      "exit_submission_attempt_persisted",
      "exit_submission_ambiguous"
    ].flatMap((fromState) =>
      ["accepted", "partially_filled", "filled"].map((brokerStatus) => ({
        fromState,
        reviewType: "exit" as const,
        brokerStatus
      }))
    ),
    ...[
      "submission_attempt_persisted",
      "submission_ambiguous",
      "broker_order_discovered",
      "broker_order_accepted",
      "partially_filled"
    ].flatMap((fromState) =>
      ["canceled", "rejected", "expired"].map((brokerStatus) => ({
        fromState,
        reviewType: "entry" as const,
        brokerStatus
      }))
    ),
    ...[
      "exit_submission_attempt_persisted",
      "exit_submission_ambiguous",
      "exit_broker_order_discovered",
      "exit_partially_filled"
    ].flatMap((fromState) =>
      ["canceled", "rejected", "expired"].map((brokerStatus) => ({
        fromState,
        reviewType: "exit" as const,
        brokerStatus
      }))
    )
  ];
  for (const scenario of parityScenarios) {
    const path = resolveBrokerReconciliationLifecyclePath(scenario);
    for (let index = 1; index < path.length; index += 1) {
      assert.match(
        sql,
        new RegExp(`\\('${path[index - 1]}','${path[index]}'\\)`)
      );
    }
  }
});

test("migration 006 and TypeScript enforce the complete identical lifecycle graph", async () => {
  const sql = await readFile(
    new URL(
      "../src/lib/database/migrations/006_autonomous_trade_lifecycle.sql",
      import.meta.url
    ),
    "utf8"
  );
  const lifecycleStates = new Set<string>(AUTONOMOUS_TRADE_LIFECYCLE_STATES);
  const sqlEdges = new Set(
    [...sql.matchAll(/\('([a-z_]+)'\s*,\s*'([a-z_]+)'\)/g)]
      .filter((match) =>
        lifecycleStates.has(match[1]!) && lifecycleStates.has(match[2]!)
      )
      .map((match) => `${match[1]}->${match[2]}`)
  );
  const typescriptEdges = new Set(AUTONOMOUS_TRADE_LIFECYCLE_EDGES);

  assert.equal(typescriptEdges.size, 72);
  assert.equal(sqlEdges.size, 72);
  assert.deepEqual(
    [...sqlEdges].sort(),
    [...typescriptEdges].sort()
  );
});
