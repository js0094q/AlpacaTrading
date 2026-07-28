import assert from "node:assert/strict";
import test from "node:test";

import {
  autonomousLifecycleContextFromRuntime,
  lifecycleStateForBrokerStatus,
  promoteNextConfirmedPostgresIntent,
  runAutonomousPostgresExecutionCommand,
  validateAutonomousExecutionEvidence,
  type AutonomousExecutionIntentRow
} from "../src/services/autonomousPostgresExecutionService.js";

const intent = (overrides: Partial<AutonomousExecutionIntentRow> = {}): AutonomousExecutionIntentRow => ({
  order_intent_id: "intent-1",
  candidate_id: "candidate-1",
  account_id: "account-1",
  broker_account_id: "broker-account-1",
  account_snapshot_fingerprint: "portfolio-fingerprint",
  review_account_fingerprint: "structural-fingerprint",
  reservation_id: "reservation-1",
  execution_review_id: "review-1",
  review_type: "entry",
  confirmation_evidence_id: "confirmation-1",
  client_order_id: "worker-order-1",
  strategy_key: "baseline",
  symbol: "AAPL",
  asset_class: "equity",
  side: "buy",
  order_type: "limit",
  time_in_force: "day",
  quantity: "1",
  notional: null,
  limit_price: "200",
  stop_price: null,
  intent_version: "2",
  operation: "buy_to_open",
  strategy_classification: "equity_long",
  parent_position_id: null,
  opening_intent_id: null,
  contract_id: null,
  position_side: null,
  position_available_quantity: null,
  position_option_symbol: null,
  position_contract_id: null,
  market_evidence: [{ symbol: "AAPL", referencePrice: 200, timestamp: "2026-07-20T21:59:30.000Z" }],
  ...overrides
});

const broker = {
  capturedAt: "2026-07-20T22:00:00.000Z",
  accountIdentityHash: "account-identity",
  brokerAccountId: "broker-account-1",
  portfolioFingerprint: "portfolio-fingerprint",
  structuralPortfolioFingerprint: "structural-fingerprint"
};

const optionUnderlyingSip = (
  overrides: Record<string, unknown> = {}
) => ({
  symbol: "SPY",
  referencePrice: 555,
  timestamp: "2026-07-20T21:59:00.000Z",
  requestId: "sip-underlying-request",
  bid: 554.9,
  ask: 555.1,
  requestedFeed: "sip",
  effectiveFeed: "sip",
  provider: "alpaca",
  source: "postgres.stock_snapshots",
  ...overrides
});

test("broker statuses map to exact entry and exit lifecycle states", () => {
  assert.equal(lifecycleStateForBrokerStatus("entry", "accepted"), "broker_order_accepted");
  assert.equal(lifecycleStateForBrokerStatus("entry", "partially_filled"), "partially_filled");
  assert.equal(lifecycleStateForBrokerStatus("entry", "filled"), "filled");
  assert.equal(lifecycleStateForBrokerStatus("exit", "accepted"), "exit_broker_order_discovered");
  assert.equal(lifecycleStateForBrokerStatus("exit", "partially_filled"), "exit_partially_filled");
  assert.equal(lifecycleStateForBrokerStatus("exit", "filled"), "exit_broker_order_discovered");
  for (const terminal of ["canceled", "cancelled", "rejected", "expired"] as const) {
    const expected = terminal === "canceled" ? "cancelled" : terminal;
    assert.equal(lifecycleStateForBrokerStatus("entry", terminal), expected);
    assert.equal(lifecycleStateForBrokerStatus("exit", terminal), expected);
  }
});

test("autonomous lifecycle identity preserves the worker cycle and unique invocation", () => {
  assert.deepEqual(
    autonomousLifecycleContextFromRuntime(
      { AUTONOMOUS_CYCLE_ID: "cycle-123" },
      { runId: "invocation-456" }
    ),
    { cycleId: "cycle-123", workstreamExecutionId: "invocation-456" }
  );
});

test("a direct terminal broker response settles reservation and audit under one fence", async () => {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const result = await runAutonomousPostgresExecutionCommand({
    command: "paper:execute:reviewed",
    query: { query: async () => ({ rows: [{ ready_count: "1" }], rowCount: 1 }) },
    transaction: async (operation) => operation({
      query: async (sql: string, values?: readonly unknown[]) => {
        statements.push({ sql, values: values ?? [] });
        if (sql.includes("FROM order_intents intent")) {
          return { rows: [intent() as unknown as Record<string, unknown>], rowCount: 1 };
        }
        if (sql.includes("released_reservation_count")) {
          return {
            rows: [{
              released_reservation_count: "1",
              adjusted_allocation_count: "1",
              terminal_transition_count: "1"
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    }),
    marketOpen: async () => true,
    captureBrokerSnapshot: async () => broker,
    submitOrder: async (payload) => ({
      status: 200,
      url: "paper",
      data: {
        id: "broker-rejected",
        client_order_id: payload.client_order_id,
        symbol: payload.symbol,
        side: payload.side,
        type: payload.type,
        time_in_force: payload.time_in_force,
        status: "rejected",
        qty: payload.qty,
        submitted_at: "2026-07-20T22:00:00.000Z"
      }
    }),
    safety: {
      environment: "paper",
      tradingMode: "paper",
      liveTradingEnabled: false,
      paperOrderExecutionEnabled: true,
      paperOptionsExecutionEnabled: true,
      quoteMaxAgeSeconds: 60
    },
    confirmPaper: true,
    fence: {
      jobName: "paper-execution",
      workstream: "paper_execution",
      ownerId: "owner",
      runId: "run",
      fencingToken: "12"
    },
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.evidence.brokerStatus, "rejected");
  const settlement = statements.find(({ sql }) => sql.includes("released_reservation_count"));
  assert.ok(settlement);
  assert.match(settlement.sql, /INSERT INTO reservation_terminal_transitions/);
  assert.match(settlement.sql, /FROM scheduler_leases/);
  assert.equal(settlement.values[4], "rejected");
  assert.equal(settlement.values[1], "broker_terminal_rejected");
});

test("the execution gate rejects missing current market timestamp before submission", () => {
  assert.throws(
    () => validateAutonomousExecutionEvidence(
      intent({ market_evidence: [{ symbol: "AAPL", referencePrice: 200 }] }),
      broker,
      new Date("2026-07-20T22:00:00.000Z"),
      60
    ),
    /POSTGRES_MARKET_EVIDENCE_TIMESTAMP_MISSING/
  );
});

test("the execution gate accepts mark-to-market drift when material portfolio structure is unchanged", () => {
  const payload = validateAutonomousExecutionEvidence(
    intent(),
    { ...broker, portfolioFingerprint: "valuation-drifted" },
    new Date("2026-07-20T22:00:00.000Z"),
    60
  );
  assert.equal(payload.client_order_id, "worker-order-1");
});

test("the execution gate still rejects material portfolio structure changes", () => {
  assert.throws(
    () => validateAutonomousExecutionEvidence(
      intent(),
      { ...broker, structuralPortfolioFingerprint: "position-or-order-changed" },
      new Date("2026-07-20T22:00:00.000Z"),
      60
    ),
    /POSTGRES_REVIEW_ACCOUNT_EVIDENCE_CONFLICT/
  );
});

test("the execution gate accepts complete fresh paper evidence without synthesizing fields", () => {
  const payload = validateAutonomousExecutionEvidence(
    intent(),
    broker,
    new Date("2026-07-20T22:00:00.000Z"),
    60
  );
  assert.deepEqual(payload, {
    symbol: "AAPL",
    qty: "1",
    side: "buy",
    type: "limit",
    time_in_force: "day",
    limit_price: "200",
    client_order_id: "worker-order-1"
  });
});

test("the execution gate accepts evidence at 29:59 and rejects evidence older than 30 minutes", () => {
  const accepted = validateAutonomousExecutionEvidence(
    intent({
      market_evidence: [{
        symbol: "AAPL",
        referencePrice: 200,
        timestamp: "2026-07-20T21:30:01.000Z"
      }]
    }),
    broker,
    new Date("2026-07-20T22:00:00.000Z"),
    1_800
  );
  assert.equal(accepted.client_order_id, "worker-order-1");
  assert.throws(
    () => validateAutonomousExecutionEvidence(
      intent({
        market_evidence: [{
          symbol: "AAPL",
          referencePrice: 200,
          timestamp: "2026-07-20T21:29:59.000Z"
        }]
      }),
      broker,
      new Date("2026-07-20T22:00:00.000Z"),
      1_800
    ),
    /POSTGRES_MARKET_EVIDENCE_STALE/
  );
});

test("the execution gate rejects a fresh option intent with an unusable quote", () => {
  assert.throws(
    () => validateAutonomousExecutionEvidence(
      intent({
        asset_class: "option",
        underlying_symbol: "SPY",
        side: "buy_to_open",
        symbol: "SPY260821C00560000",
        market_evidence: [{
          symbol: "SPY260821C00560000",
          referencePrice: 2,
          timestamp: "2026-07-20T21:59:30.000Z",
          bid: 2.02,
          ask: 1.98,
          spreadPct: 0.02,
          maximumSpreadPct: 0.15,
          underlyingPrice: 555,
          volume: 5_000,
          openInterest: 8_000,
          requestedFeed: "opra",
          effectiveFeed: "opra",
          source: "postgres.option_snapshots",
          underlyingSip: optionUnderlyingSip()
        }]
      }),
      broker,
      new Date("2026-07-20T22:00:00.000Z"),
      1_800
    ),
    /POSTGRES_OPTION_MARKET_EVIDENCE_UNUSABLE/
  );
});

test("the execution gate preserves an integer multi-contract LEAPS quantity", () => {
  const optionSymbol = "SPY260821C00560000";
  const payload = validateAutonomousExecutionEvidence(
    intent({
      asset_class: "option",
      underlying_symbol: "SPY",
      side: "buy_to_open",
      symbol: optionSymbol,
      operation: "buy_to_open",
      strategy_classification: "standard_long_call",
      contract_id: `contract-${optionSymbol}`,
      quantity: "5",
      notional: null,
      limit_price: "10",
      market_evidence: [{
        symbol: optionSymbol,
        referencePrice: 10,
        timestamp: "2026-07-20T21:59:30.000Z",
        bid: 9.9,
        ask: 10.1,
        spreadPct: 0.02,
        maximumSpreadPct: 0.15,
        underlyingPrice: 555,
        volume: 5_000,
        openInterest: 8_000,
        requestedFeed: "opra",
        effectiveFeed: "opra",
        source: "postgres.option_snapshots",
        underlyingSip: optionUnderlyingSip()
      }]
    }),
    broker,
    new Date("2026-07-20T22:00:00.000Z"),
    1_800
  );

  assert.equal(payload.qty, "5");
  assert.equal(payload.symbol, optionSymbol);
});

test("the execution gate preserves the stricter 15-minute option quote age", () => {
  assert.throws(
    () => validateAutonomousExecutionEvidence(
      intent({
        asset_class: "option",
        underlying_symbol: "SPY",
        side: "buy_to_open",
        symbol: "SPY260821C00560000",
        market_evidence: [{
          symbol: "SPY260821C00560000",
          referencePrice: 2,
          timestamp: "2026-07-20T21:40:00.000Z",
          bid: 1.98,
          ask: 2.02,
          spreadPct: 0.02,
          maximumSpreadPct: 0.15,
          underlyingPrice: 555,
          volume: 5_000,
          openInterest: 8_000,
          requestedFeed: "opra",
          effectiveFeed: "opra",
          source: "postgres.option_snapshots",
          underlyingSip: optionUnderlyingSip()
        }]
      }),
      broker,
      new Date("2026-07-20T22:00:00.000Z"),
      1_800
    ),
    /POSTGRES_MARKET_EVIDENCE_STALE/
  );
});

for (const reviewType of ["entry", "exit"] as const) {
  for (const [label, sipEvidence, expected] of [
    [
      "missing nested SIP evidence",
      undefined,
      /POSTGRES_OPTION_UNDERLYING_SIP_EVIDENCE_UNUSABLE/
    ],
    [
      "31:01 stale nested SIP evidence",
      optionUnderlyingSip({ timestamp: "2026-07-20T21:28:59.000Z" }),
      /POSTGRES_OPTION_UNDERLYING_SIP_EVIDENCE_STALE/
    ],
    [
      "wrong SIP provider and feed",
      optionUnderlyingSip({
        requestedFeed: "iex",
        effectiveFeed: "iex",
        provider: "synthetic"
      }),
      /POSTGRES_OPTION_UNDERLYING_SIP_EVIDENCE_UNUSABLE/
    ],
    [
      "unlinked SIP underlying",
      optionUnderlyingSip({ symbol: "QQQ" }),
      /POSTGRES_OPTION_UNDERLYING_SIP_EVIDENCE_UNUSABLE/
    ],
    [
      "nonpositive SIP underlying price",
      optionUnderlyingSip({ referencePrice: 0 }),
      /POSTGRES_OPTION_UNDERLYING_SIP_EVIDENCE_UNUSABLE/
    ]
  ] as const) {
    test(`the ${reviewType} broker gate rejects ${label} with fresh OPRA`, () => {
      const optionSymbol = "SPY260821C00560000";
      assert.throws(
        () => validateAutonomousExecutionEvidence(
          intent({
            asset_class: "option",
            underlying_symbol: "SPY",
            review_type: reviewType,
            side: reviewType === "entry" ? "buy_to_open" : "sell_to_close",
            symbol: optionSymbol,
            operation: reviewType === "entry" ? "buy_to_open" : "sell_to_close",
            strategy_classification: "standard_long_call",
            contract_id: `contract-${optionSymbol}`,
            parent_position_id: reviewType === "exit" ? "position-call" : null,
            opening_intent_id:
              reviewType === "exit" ? "opening-intent-call" : null,
            position_side: reviewType === "exit" ? "long" : null,
            position_available_quantity: reviewType === "exit" ? "1" : null,
            position_option_symbol: reviewType === "exit" ? optionSymbol : null,
            position_contract_id:
              reviewType === "exit" ? `contract-${optionSymbol}` : null,
            quantity: "1",
            notional: null,
            limit_price: "2",
            market_evidence: [{
              symbol: optionSymbol,
              referencePrice: 2,
              timestamp: "2026-07-20T21:59:30.000Z",
              bid: 1.98,
              ask: 2.02,
              spreadPct: 0.02,
              maximumSpreadPct: 0.15,
              underlyingPrice: 555,
              volume: 5_000,
              openInterest: 8_000,
              requestedFeed: "opra",
              effectiveFeed: "opra",
              source: "postgres.option_snapshots",
              ...(sipEvidence === undefined
                ? {}
                : { underlyingSip: sipEvidence })
            }]
          }),
          broker,
          new Date("2026-07-20T22:00:00.000Z"),
          1_800
        ),
        expected
      );
    });
  }
}

test("the execution gate compares the persisted broker identity hash without hashing it twice", () => {
  const payload = validateAutonomousExecutionEvidence(
    intent({ broker_account_id: "account-identity" }),
    { ...broker, brokerAccountId: undefined },
    new Date("2026-07-20T22:00:00.000Z"),
    60
  );
  assert.equal(payload.symbol, "AAPL");
});

test("the execution gate emits supported option sell-to-close semantics", () => {
  const payload = validateAutonomousExecutionEvidence(
    intent({
      asset_class: "option",
      underlying_symbol: "SPY",
      review_type: "exit",
      side: "sell_to_close",
      symbol: "SPY260720P00555000",
      operation: "sell_to_close",
      strategy_classification: "zero_dte_long_put",
      parent_position_id: "position-put",
      opening_intent_id: "opening-intent-put",
      contract_id: "contract-SPY260720P00555000",
      position_side: "long",
      position_available_quantity: "1",
      position_option_symbol: "SPY260720P00555000",
      position_contract_id: "contract-SPY260720P00555000",
      notional: null,
      quantity: "1",
      limit_price: "1.05",
      market_evidence: [{
        symbol: "SPY260720P00555000",
        referencePrice: 1.05,
        timestamp: "2026-07-20T21:59:30.000Z",
        bid: 1.05,
        ask: 1.08,
        spreadPct: 0.028169,
        maximumSpreadPct: 0.15,
        underlyingPrice: 555,
        volume: 5_000,
        openInterest: 8_000,
        requestedFeed: "opra",
        effectiveFeed: "opra",
        source: "postgres.option_snapshots",
        underlyingSip: optionUnderlyingSip()
      }]
    }),
    broker,
    new Date("2026-07-20T22:00:00.000Z"),
    60
  );
  assert.equal(payload.side, "sell");
  assert.equal(payload.position_intent, "sell_to_close");
});

test("a short cover is validated as buy-to-cover before mapping to Alpaca buy", () => {
  const payload = validateAutonomousExecutionEvidence(
    intent({
      review_type: "exit",
      side: "buy",
      operation: "buy_to_cover",
      strategy_classification: "equity_short",
      parent_position_id: "position-short",
      position_side: "short",
      position_available_quantity: "2",
      quantity: "2"
    }),
    broker,
    new Date("2026-07-20T22:00:00.000Z"),
    60
  );

  assert.equal(payload.side, "buy");
  assert.equal(payload.position_intent, undefined);
});

test("a generic or mismatched short close is rejected before Alpaca payload mapping", () => {
  assert.throws(
    () => validateAutonomousExecutionEvidence(
      intent({
        review_type: "exit",
        side: "buy",
        operation: "sell_to_close",
        strategy_classification: "equity_short",
        parent_position_id: "position-short",
        position_side: "short",
        position_available_quantity: "2",
        quantity: "2"
      }),
      broker,
      new Date("2026-07-20T22:00:00.000Z"),
      60
    ),
    /CLOSE_OPERATION_MISMATCH:buy_to_cover/
  );
});

test("an option close retains its observed contract and cannot exceed reconciled available quantity", () => {
  const optionIntent = intent({
    review_type: "exit",
    asset_class: "option",
    underlying_symbol: "SPY",
    symbol: "SPY260821P00500000",
    side: "sell_to_close",
    operation: "sell_to_close",
    strategy_classification: "standard_long_put",
    contract_id: "contract-SPY260821P00500000",
    parent_position_id: "position-put",
    position_side: "long",
    position_option_symbol: "SPY260821P00500000",
    position_contract_id: "contract-SPY260821P00500000",
    position_available_quantity: "1",
    quantity: "2",
    limit_price: "1.00",
    market_evidence: [{
      symbol: "SPY260821P00500000",
      referencePrice: 1,
      timestamp: "2026-07-20T21:59:30.000Z",
      bid: 1,
      ask: 1.02,
      spreadPct: 0.0198,
      maximumSpreadPct: 0.15,
      underlyingPrice: 555,
      volume: 500,
      openInterest: 800,
      requestedFeed: "opra",
      effectiveFeed: "opra",
      source: "postgres.option_snapshots",
      underlyingSip: optionUnderlyingSip()
    }]
  });

  assert.throws(
    () => validateAutonomousExecutionEvidence(
      optionIntent,
      broker,
      new Date("2026-07-20T22:00:00.000Z"),
      60
    ),
    /POSTGRES_CLOSE_QUANTITY_EXCEEDS_RECONCILED_POSITION/
  );
});

test("confirmation promotion atomically readies an entry intent with a buying-power reservation", async () => {
  const statements: string[] = [];
  const values: Array<readonly unknown[]> = [];
  const result = await promoteNextConfirmedPostgresIntent({
    command: "paper:execute:reviewed",
    query: {
      query: async (sql: string, parameters?: readonly unknown[]) => {
        statements.push(sql);
        values.push(parameters ?? []);
        if (sql.includes("intent.status = 'created'")) {
          return {
            rows: [{
              order_intent_id: "intent-created",
              candidate_id: "candidate-1",
              account_id: "account-1",
              account_snapshot_id: "snapshot-1",
              strategy_key: "baseline",
              symbol: "AAPL",
              asset_class: "equity",
              side: "buy",
              max_risk: "100",
              execution_review_id: "review-1",
              review_type: "entry",
              review_payload_fingerprint: "review-payload",
              review_signature: "review-signature",
              review_expires_at: "2026-07-20T22:15:00.000Z"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("AS buying_power_allowed")) {
          return {
            rows: [{
              buying_power_allowed: true,
              deployment_allowed: true,
              strategy_allowed: true,
              symbol_allowed: true,
              position_count_allowed: true,
              order_count_allowed: true
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence: {
      jobName: "paper-execution",
      workstream: "paper_execution",
      ownerId: "owner",
      runId: "run",
      fencingToken: "10"
    },
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "promoted");
  assert.equal(result.orderIntentId, "intent-created");
  assert.equal(statements.some((sql) => sql.includes("INSERT INTO confirmation_evidence")), true);
  assert.equal(statements.some((sql) => sql.includes("INSERT INTO buying_power_reservations")), true);
  assert.equal(statements.some((sql) => sql.includes("UPDATE strategy_allocations")), true);
  assert.equal(
    statements.some((sql) =>
      sql.includes("SET confirmation_evidence_id") &&
      sql.includes("status = 'ready_for_submission'")
    ),
    true
  );
  const confirmationInsert = statements.findIndex((sql) => sql.includes("INSERT INTO confirmation_evidence"));
  assert.equal(values[confirmationInsert]?.[5], "autonomous_worker_confirm_paper");
});

test("paper execution promotes a confirmed created intent before broker submission", async () => {
  let countReads = 0;
  let countSql = "";
  const transactionStatements: string[] = [];
  const result = await runAutonomousPostgresExecutionCommand({
    command: "paper:execute:reviewed",
    query: {
      query: async (sql: string) => {
        countSql = sql;
        countReads += 1;
        return {
          rows: [{
            ready_count: countReads === 1 ? "0" : "1",
            confirmable_count: countReads === 1 ? "1" : "0"
          }],
          rowCount: 1
        };
      }
    },
    transaction: async (operation) => operation({
      query: async (sql: string) => {
        transactionStatements.push(sql);
        if (sql.includes("intent.status = 'created'")) {
          return {
            rows: [{
              order_intent_id: "intent-created",
              candidate_id: "candidate-1",
              account_id: "account-1",
              account_snapshot_id: "snapshot-1",
              strategy_key: "baseline",
              symbol: "AAPL",
              asset_class: "equity",
              side: "buy",
              max_risk: "100",
              execution_review_id: "review-1",
              review_type: "entry",
              review_payload_fingerprint: "review-payload",
              review_signature: "review-signature",
              review_expires_at: "2026-07-20T22:15:00.000Z"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("AS buying_power_allowed")) {
          return {
            rows: [{
              buying_power_allowed: true,
              deployment_allowed: true,
              strategy_allowed: true,
              symbol_allowed: true,
              position_count_allowed: true,
              order_count_allowed: true
            }],
            rowCount: 1
          };
        }
        if (sql.includes("FROM order_intents intent")) {
          return {
            rows: [intent({
              order_intent_id: "intent-created",
              confirmation_evidence_id: "confirmation-ready",
              reservation_id: "reservation-ready"
            }) as unknown as Record<string, unknown>],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    }),
    marketOpen: async () => true,
    captureBrokerSnapshot: async () => broker,
    submitOrder: async (payload) => ({
      data: {
        id: "broker-order-1",
        client_order_id: payload.client_order_id,
        status: "accepted",
        symbol: payload.symbol,
        side: payload.side,
        type: payload.type,
        time_in_force: payload.time_in_force,
        qty: payload.qty,
        submitted_at: "2026-07-20T22:00:00.000Z"
      },
      status: 200,
      url: "paper"
    }),
    safety: {
      environment: "paper",
      tradingMode: "paper",
      liveTradingEnabled: false,
      paperOrderExecutionEnabled: true,
      paperOptionsExecutionEnabled: true,
      quoteMaxAgeSeconds: 60
    },
    confirmPaper: true,
    confirmationSigningKey: "test-signing-key-with-sufficient-length",
    fence: {
      jobName: "paper-execution",
      workstream: "paper_execution",
      ownerId: "owner",
      runId: "run",
      fencingToken: "10"
    },
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "completed");
  assert.equal(result.submittedOrderCount, 1);
  assert.equal(transactionStatements.some((sql) => sql.includes("INSERT INTO confirmation_evidence")), true);
  assert.match(countSql, /review\.expires_at > now\(\)/);
  assert.match(countSql, /FROM confirmation_evidence current_confirmation/);
  assert.match(countSql, /current_confirmation\.expires_at > now\(\)/);
});

test("paper execution persists one captured broker snapshot before promotion and submission", async () => {
  const sequence: string[] = [];
  let countReads = 0;
  await runAutonomousPostgresExecutionCommand({
    command: "paper:execute:reviewed",
    query: {
      query: async () => {
        countReads += 1;
        return {
          rows: [{
            ready_count: countReads === 1 ? "0" : "1",
            confirmable_count: countReads === 1 ? "1" : "0"
          }],
          rowCount: 1
        };
      }
    },
    transaction: async (operation) => operation({
      query: async (sql: string) => {
        if (sql.includes("intent.status = 'created'")) {
          sequence.push("promotion");
          return {
            rows: [{
              order_intent_id: "intent-created",
              candidate_id: "candidate-1",
              account_id: "account-1",
              account_snapshot_id: "snapshot-1",
              strategy_key: "baseline",
              symbol: "AAPL",
              asset_class: "equity",
              side: "buy",
              max_risk: "100",
              execution_review_id: "review-1",
              review_type: "entry",
              review_payload_fingerprint: "review-payload",
              review_signature: "review-signature",
              review_expires_at: "2026-07-20T22:15:00.000Z"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("AS buying_power_allowed")) {
          return {
            rows: [{
              buying_power_allowed: true,
              deployment_allowed: true,
              strategy_allowed: true,
              symbol_allowed: true,
              position_count_allowed: true,
              order_count_allowed: true
            }],
            rowCount: 1
          };
        }
        if (sql.includes("FROM order_intents intent")) {
          sequence.push("claim");
          return {
            rows: [intent({
              order_intent_id: "intent-created",
              confirmation_evidence_id: "confirmation-ready",
              reservation_id: "reservation-ready"
            }) as unknown as Record<string, unknown>],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    }),
    marketOpen: async () => true,
    captureBrokerSnapshot: async () => {
      sequence.push("capture");
      return broker;
    },
    persistBrokerSnapshot: async (snapshot) => {
      assert.equal(snapshot, broker);
      sequence.push("persist");
    },
    submitOrder: async (payload) => {
      sequence.push("submit");
      return {
        data: {
          id: "broker-order-snapshot",
          client_order_id: payload.client_order_id,
          status: "accepted",
          symbol: payload.symbol,
          side: payload.side,
          type: payload.type,
          time_in_force: payload.time_in_force,
          qty: payload.qty,
          submitted_at: "2026-07-20T22:00:00.000Z"
        },
        status: 200,
        url: "paper"
      };
    },
    safety: {
      environment: "paper",
      tradingMode: "paper",
      liveTradingEnabled: false,
      paperOrderExecutionEnabled: true,
      paperOptionsExecutionEnabled: true,
      quoteMaxAgeSeconds: 60
    },
    confirmPaper: true,
    confirmationSigningKey: "test-signing-key-with-sufficient-length",
    fence: {
      jobName: "paper-execution",
      workstream: "paper_execution",
      ownerId: "owner",
      runId: "run",
      fencingToken: "10"
    },
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.deepEqual(
    sequence.filter((step) => ["capture", "persist", "promotion", "claim", "submit"].includes(step)),
    ["capture", "persist", "promotion", "claim", "submit"]
  );
});

test("an execution command with no ready PostgreSQL intent makes no broker call", async () => {
  let brokerCalls = 0;
  const result = await runAutonomousPostgresExecutionCommand({
    command: "paper:execute:reviewed",
    query: {
      query: async () => ({ rows: [{ ready_count: "0" }], rowCount: 1 })
    },
    transaction: async () => { throw new Error("transaction must not run"); },
    captureBrokerSnapshot: async () => {
      brokerCalls += 1;
      throw new Error("broker must not run");
    },
    submitOrder: async () => { throw new Error("submit must not run"); },
    safety: {
      environment: "paper",
      tradingMode: "paper",
      liveTradingEnabled: false,
      paperOrderExecutionEnabled: true,
      paperOptionsExecutionEnabled: true,
      quoteMaxAgeSeconds: 60
    },
    confirmPaper: true,
    fence: {
      jobName: "paper-execution",
      workstream: "paper_execution",
      ownerId: "owner",
      runId: "run",
      fencingToken: "10"
    }
  });
  assert.equal(result.status, "no_op");
  assert.equal(result.submittedOrderCount, 0);
  assert.equal(brokerCalls, 0);
});

test("reviewed execution rejects a mismatched persisted review artifact", async () => {
  const transaction = async <T>(operation: (query: {
    query: (sql: string) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
  }) => Promise<T>) => operation({
    query: async (sql: string) => sql.includes("FROM order_intents intent")
      ? {
          rows: [intent({
            review_signature: "persisted-signature",
            payload_fingerprint: "persisted-payload"
          }) as unknown as Record<string, unknown>],
          rowCount: 1
        }
      : { rows: [], rowCount: 1 }
  });

  await assert.rejects(
    runAutonomousPostgresExecutionCommand({
      command: "paper:execute:reviewed",
      query: { query: async () => ({ rows: [{ ready_count: "1" }], rowCount: 1 }) },
      transaction,
      marketOpen: async () => true,
      captureBrokerSnapshot: async () => broker,
      submitOrder: async () => { throw new Error("must not submit"); },
      safety: {
        environment: "paper",
        tradingMode: "paper",
        liveTradingEnabled: false,
        paperOrderExecutionEnabled: true,
        paperOptionsExecutionEnabled: true,
        quoteMaxAgeSeconds: 60
      },
      confirmPaper: true,
      expectedPayloadSignature: "different-signature",
      fence: {
        jobName: "paper-execution",
        workstream: "paper_execution",
        ownerId: "owner",
        runId: "run",
        fencingToken: "10"
      },
      now: new Date("2026-07-20T22:00:00.000Z")
    }),
    /PAPER_REVIEW_ARTIFACT_MISMATCH/
  );
});

test("live flags block before querying PostgreSQL or Alpaca", async () => {
  const previous = process.env.LIVE_TRADING_ENABLED;
  process.env.LIVE_TRADING_ENABLED = "true";
  try {
    await assert.rejects(
      runAutonomousPostgresExecutionCommand({
        command: "paper:execute:reviewed",
        query: { query: async () => { throw new Error("must not query"); } },
        transaction: async () => { throw new Error("must not transact"); },
        captureBrokerSnapshot: async () => { throw new Error("must not read broker"); },
        submitOrder: async () => { throw new Error("must not submit"); },
        safety: {
          environment: "paper",
          tradingMode: "paper",
          liveTradingEnabled: true,
          paperOrderExecutionEnabled: true,
          paperOptionsExecutionEnabled: true,
          quoteMaxAgeSeconds: 60
        },
        confirmPaper: true,
        fence: {
          jobName: "paper-execution",
          workstream: "paper_execution",
          ownerId: "owner",
          runId: "run",
          fencingToken: "10"
        }
      }),
      /LIVE_TRADING_MUST_BE_DISABLED/
    );
  } finally {
    if (previous === undefined) delete process.env.LIVE_TRADING_ENABLED;
    else process.env.LIVE_TRADING_ENABLED = previous;
  }
});

test("a closed paper market blocks a ready intent without account sync or submission", async () => {
  let snapshotCalls = 0;
  let submitCalls = 0;
  const result = await runAutonomousPostgresExecutionCommand({
    command: "paper:execute:reviewed",
    query: { query: async () => ({ rows: [{ ready_count: "1" }], rowCount: 1 }) },
    transaction: async () => { throw new Error("transaction must not run"); },
    marketOpen: async () => false,
    captureBrokerSnapshot: async () => {
      snapshotCalls += 1;
      throw new Error("snapshot must not run");
    },
    submitOrder: async () => {
      submitCalls += 1;
      throw new Error("submit must not run");
    },
    safety: {
      environment: "paper",
      tradingMode: "paper",
      liveTradingEnabled: false,
      paperOrderExecutionEnabled: true,
      paperOptionsExecutionEnabled: true,
      quoteMaxAgeSeconds: 60
    },
    confirmPaper: true,
    fence: {
      jobName: "paper-execution",
      workstream: "paper_execution",
      ownerId: "owner",
      runId: "run",
      fencingToken: "11"
    }
  });
  assert.equal(result.status, "no_op");
  assert.equal(result.code, "PAPER_MARKET_CLOSED");
  assert.equal(snapshotCalls, 0);
  assert.equal(submitCalls, 0);
});

test("an uncertain broker submission recovers by client order ID without a duplicate submit", async () => {
  const transactionSql: string[] = [];
  const transactionValues: Array<readonly unknown[]> = [];
  let submitCalls = 0;
  let recoveryCalls = 0;
  const transaction = async <T>(
    operation: (query: { query: (sql: string, values?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }> }) => Promise<T>
  ) => operation({
    query: async (sql: string, values?: readonly unknown[]) => {
      transactionSql.push(sql);
      transactionValues.push(values ?? []);
      if (sql.includes("FROM order_intents intent")) {
        return { rows: [intent() as unknown as Record<string, unknown>], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
  });

  const result = await runAutonomousPostgresExecutionCommand({
    command: "paper:execute:reviewed",
    query: { query: async () => ({ rows: [{ ready_count: "1" }], rowCount: 1 }) },
    transaction,
    marketOpen: async () => true,
    captureBrokerSnapshot: async () => broker,
    submitOrder: async () => {
      submitCalls += 1;
      throw new Error("socket closed before response");
    },
    recoverAmbiguousSubmission: async (clientOrderId) => {
      recoveryCalls += 1;
      assert.equal(clientOrderId, "worker-order-1");
      return {
        status: "recovered",
        orderId: "order-recovered",
        brokerOrderId: "broker-order-recovered",
        brokerStatus: "accepted"
      };
    },
    safety: {
      environment: "paper",
      tradingMode: "paper",
      liveTradingEnabled: false,
      paperOrderExecutionEnabled: true,
      paperOptionsExecutionEnabled: true,
      quoteMaxAgeSeconds: 60
    },
    confirmPaper: true,
    fence: {
      jobName: "paper-execution",
      workstream: "paper_execution",
      ownerId: "owner",
      runId: "run",
      fencingToken: "12"
    },
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(transactionSql.some((sql) => /SET status = 'ambiguous'/.test(sql)), true);
  assert.equal(transactionSql.some((sql) => /INSERT INTO broker_events/.test(sql)), true);
  assert.equal(submitCalls, 1);
  assert.equal(recoveryCalls, 1);
  assert.equal(result.status, "completed");
  assert.equal(result.evidence.recoveredFromAmbiguous, true);
  assert.equal(result.evidence.brokerOrderId, "broker-order-recovered");
  const candidateUpdate = transactionSql.findIndex((sql) => sql.includes("UPDATE candidates"));
  assert.notEqual(candidateUpdate, -1);
  assert.equal(
    transactionValues.some((values) =>
      values[1] === "execution_ambiguous" &&
      values[2] === "POSTGRES_BROKER_SUBMISSION_AMBIGUOUS"
    ),
    true
  );
  assert.equal(
    transactionValues.some((values) =>
      values[1] === "executed" &&
      values[2] === "PAPER_ORDER_RECOVERED_BY_CLIENT_ID"
    ),
    true
  );
});

test("the durable submission-attempt event is written before the broker mutation", async () => {
  const statements: string[] = [];
  let submitCalls = 0;
  const result = await runAutonomousPostgresExecutionCommand({
    command: "paper:execute:reviewed",
    query: { query: async () => ({ rows: [{ ready_count: "1" }], rowCount: 1 }) },
    transaction: async (operation) => operation({
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("FROM order_intents intent")) {
          return { rows: [intent() as unknown as Record<string, unknown>], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }
    }),
    marketOpen: async () => true,
    captureBrokerSnapshot: async () => broker,
    submitOrder: async (payload) => {
      submitCalls += 1;
      assert.equal(
        statements.some((sql) =>
          sql.includes("INSERT INTO broker_events") &&
          sql.includes("order_submission_attempt")
        ),
        true
      );
      return {
        data: {
          id: "broker-order-attempt",
          client_order_id: payload.client_order_id,
          status: "accepted",
          symbol: payload.symbol,
          side: payload.side,
          type: payload.type,
          time_in_force: payload.time_in_force,
          qty: payload.qty,
          submitted_at: "2026-07-20T22:00:00.000Z"
        },
        status: 200,
        url: "paper"
      };
    },
    safety: {
      environment: "paper",
      tradingMode: "paper",
      liveTradingEnabled: false,
      paperOrderExecutionEnabled: true,
      paperOptionsExecutionEnabled: true,
      quoteMaxAgeSeconds: 60
    },
    confirmPaper: true,
    fence: {
      jobName: "paper-execution",
      workstream: "paper_execution",
      ownerId: "owner",
      runId: "run",
      fencingToken: "12"
    },
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(submitCalls, 1);
  assert.equal(result.status, "completed");
});

test("a failed pre-mutation attempt write releases the claim and never calls Alpaca", async () => {
  const statements: string[] = [];
  let submitCalls = 0;
  await assert.rejects(
    runAutonomousPostgresExecutionCommand({
      command: "paper:execute:reviewed",
      query: { query: async () => ({ rows: [{ ready_count: "1" }], rowCount: 1 }) },
      transaction: async (operation) => operation({
        query: async (sql: string) => {
          statements.push(sql);
          if (sql.includes("FROM order_intents intent")) {
            return { rows: [intent() as unknown as Record<string, unknown>], rowCount: 1 };
          }
          if (sql.includes("order_submission_attempt")) {
            throw new Error("attempt persistence unavailable");
          }
          return { rows: [], rowCount: 1 };
        }
      }),
      marketOpen: async () => true,
      captureBrokerSnapshot: async () => broker,
      submitOrder: async () => {
        submitCalls += 1;
        throw new Error("must not submit");
      },
      safety: {
        environment: "paper",
        tradingMode: "paper",
        liveTradingEnabled: false,
        paperOrderExecutionEnabled: true,
        paperOptionsExecutionEnabled: true,
        quoteMaxAgeSeconds: 60
      },
      confirmPaper: true,
      fence: {
        jobName: "paper-execution",
        workstream: "paper_execution",
        ownerId: "owner",
        runId: "run",
        fencingToken: "12"
      },
      now: new Date("2026-07-20T22:00:00.000Z")
    }),
    /attempt persistence unavailable/
  );

  assert.equal(submitCalls, 0);
  assert.equal(
    statements.some((sql) => /SET status = 'ready_for_submission'/.test(sql)),
    true
  );
});

test("a zero-row fenced lifecycle attempt aborts before the broker mutation", async () => {
  let submitCalls = 0;
  await assert.rejects(
    runAutonomousPostgresExecutionCommand({
      command: "paper:execute:reviewed",
      query: { query: async () => ({ rows: [{ ready_count: "1" }], rowCount: 1 }) },
      transaction: async (operation) => operation({
        query: async (sql: string) => {
          if (sql.includes("FROM order_intents intent")) {
            return { rows: [intent() as unknown as Record<string, unknown>], rowCount: 1 };
          }
          if (sql.includes("SET lifecycle_state = $2")) {
            return { rows: [], rowCount: 0 };
          }
          return { rows: [], rowCount: 1 };
        }
      }),
      marketOpen: async () => true,
      captureBrokerSnapshot: async () => broker,
      submitOrder: async () => {
        submitCalls += 1;
        throw new Error("must not submit");
      },
      safety: {
        environment: "paper",
        tradingMode: "paper",
        liveTradingEnabled: false,
        paperOrderExecutionEnabled: true,
        paperOptionsExecutionEnabled: true,
        quoteMaxAgeSeconds: 60
      },
      confirmPaper: true,
      fence: {
        jobName: "paper-execution",
        workstream: "paper_execution",
        ownerId: "owner",
        runId: "run",
        fencingToken: "12"
      },
      now: new Date("2026-07-20T22:00:00.000Z")
    }),
    /POSTGRES_BROKER_SUBMISSION_ATTEMPT_LIFECYCLE_PERSISTENCE_FAILED/
  );
  assert.equal(submitCalls, 0);
});

test("claiming an unreserved intent does not lock the nullable reservation join", async () => {
  const statements: string[] = [];
  const transaction = async <T>(operation: (query: {
    query: (sql: string) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
  }) => Promise<T>) => operation({
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes("FROM order_intents intent")) {
        return { rows: [intent({ reservation_id: null }) as unknown as Record<string, unknown>], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
  });
  await assert.rejects(
    runAutonomousPostgresExecutionCommand({
      command: "paper:execute:reviewed",
      query: { query: async () => ({ rows: [{ ready_count: "1" }], rowCount: 1 }) },
      transaction,
      marketOpen: async () => true,
      captureBrokerSnapshot: async () => broker,
      submitOrder: async () => { throw new Error("ambiguous"); },
      safety: {
        environment: "paper", tradingMode: "paper", liveTradingEnabled: false,
        paperOrderExecutionEnabled: true, paperOptionsExecutionEnabled: true,
        quoteMaxAgeSeconds: 60
      },
      confirmPaper: true,
      fence: { jobName: "execution", workstream: "execution", ownerId: "owner", runId: "run", fencingToken: "13" },
      now: new Date("2026-07-20T22:00:00.000Z")
    }),
    /POSTGRES_BROKER_SUBMISSION_AMBIGUOUS/
  );
  const select = statements.find((sql) => sql.includes("FROM order_intents intent"))!;
  assert.doesNotMatch(select, /FOR UPDATE OF[^\n]*reservation/);
});

test("claiming a reserved intent revalidates current structural and capacity state without snapshot row identity", async () => {
  const statements: string[] = [];
  await assert.rejects(
    runAutonomousPostgresExecutionCommand({
      command: "paper:execute:reviewed",
      query: { query: async () => ({ rows: [{ ready_count: "1" }], rowCount: 1 }) },
      transaction: async (operation) => operation({
        query: async (sql: string) => {
          statements.push(sql);
          if (sql.includes("FROM order_intents intent")) {
            return { rows: [intent() as unknown as Record<string, unknown>], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        }
      }),
      marketOpen: async () => true,
      captureBrokerSnapshot: async () => broker,
      submitOrder: async () => {
        throw new Error("ambiguous");
      },
      safety: {
        environment: "paper",
        tradingMode: "paper",
        liveTradingEnabled: false,
        paperOrderExecutionEnabled: true,
        paperOptionsExecutionEnabled: true,
        quoteMaxAgeSeconds: 60
      },
      confirmPaper: true,
      fence: {
        jobName: "execution",
        workstream: "execution",
        ownerId: "owner",
        runId: "run",
        fencingToken: "14"
      },
      now: new Date("2026-07-20T22:00:00.000Z")
    }),
    /POSTGRES_BROKER_SUBMISSION_AMBIGUOUS/
  );

  const select = statements.find((sql) => sql.includes("FROM order_intents intent"))!;
  assert.match(
    select,
    /snapshot\.evidence->>'structuralPortfolioFingerprint' = review\.account_fingerprint/
  );
  assert.match(select, /snapshot\.buying_power/);
  assert.match(select, /reservation_state\.total/);
  assert.match(select, /allocation\.deployed_amount \+ allocation\.reserved_amount/);
  assert.doesNotMatch(select, /reservation\.account_snapshot_id = snapshot\.id/);
});

test("a deterministic pre-submit rejection releases the claimed intent without broker submission", async () => {
  const statements: string[] = [];
  const statementValues: Array<readonly unknown[]> = [];
  let submitCalls = 0;
  const transaction = async <T>(operation: (query: {
    query: (sql: string) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
  }) => Promise<T>) => operation({
    query: async (sql: string, values?: readonly unknown[]) => {
      statements.push(sql);
      statementValues.push(values ?? []);
      if (sql.includes("FROM order_intents intent")) {
        return {
          rows: [intent({ asset_class: "option", side: "buy_to_open", symbol: "SPY260720C00625000" }) as unknown as Record<string, unknown>],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 1 };
    }
  });
  await assert.rejects(
    runAutonomousPostgresExecutionCommand({
      command: "paper:execute:reviewed",
      query: { query: async () => ({ rows: [{ ready_count: "1" }], rowCount: 1 }) },
      transaction,
      marketOpen: async () => true,
      captureBrokerSnapshot: async () => broker,
      submitOrder: async () => { submitCalls += 1; throw new Error("must not submit"); },
      safety: {
        environment: "paper", tradingMode: "paper", liveTradingEnabled: false,
        paperOrderExecutionEnabled: true, paperOptionsExecutionEnabled: false,
        quoteMaxAgeSeconds: 60
      },
      confirmPaper: true,
      fence: { jobName: "execution", workstream: "execution", ownerId: "owner", runId: "run", fencingToken: "14" },
      now: new Date("2026-07-20T22:00:00.000Z")
    }),
    /PAPER_OPTIONS_EXECUTION_DISABLED/
  );
  assert.equal(submitCalls, 0);
  assert.equal(statements.some((sql) => /SET status = 'ready_for_submission'/.test(sql)), true);
  assert.equal(statements.some((sql) => /SET status = 'ambiguous'/.test(sql)), false);
  const candidateUpdate = statements.findIndex((sql) => sql.includes("UPDATE candidates"));
  assert.notEqual(candidateUpdate, -1);
  assert.equal(statementValues[candidateUpdate]?.[1], "execution_deferred");
  assert.equal(statementValues[candidateUpdate]?.[2], "PAPER_OPTIONS_EXECUTION_DISABLED");
});

test("equity short submission fails closed unless Alpaca reports shortable and easy to borrow", async () => {
  const statements: string[] = [];
  let submitCalls = 0;
  await assert.rejects(
    runAutonomousPostgresExecutionCommand({
      command: "paper:execute:reviewed",
      query: {
        query: async () => ({
          rows: [{ ready_count: "1", confirmable_count: "0" }],
          rowCount: 1
        })
      },
      transaction: async (operation) => operation({
        query: async (sql: string) => {
          statements.push(sql);
          if (sql.includes("FROM order_intents intent")) {
            return {
              rows: [intent({
                side: "sell",
                operation: "sell_to_open",
                strategy_classification: "equity_short",
                order_type: "market",
                quantity: "1",
                notional: null,
                limit_price: null
              }) as unknown as Record<string, unknown>],
              rowCount: 1
            };
          }
          return { rows: [], rowCount: 1 };
        }
      }),
      marketOpen: async () => true,
      captureBrokerSnapshot: async () => broker,
      checkAsset: async () => ({
        symbol: "AAPL",
        tradable: true,
        asset: {
          symbol: "AAPL",
          status: "active",
          tradable: true,
          shortable: true,
          easyToBorrow: false
        }
      }),
      submitOrder: async () => {
        submitCalls += 1;
        throw new Error("must not submit");
      },
      safety: {
        environment: "paper",
        tradingMode: "paper",
        liveTradingEnabled: false,
        paperOrderExecutionEnabled: true,
        paperOptionsExecutionEnabled: true,
        quoteMaxAgeSeconds: 60
      },
      confirmPaper: true,
      fence: {
        jobName: "execution",
        workstream: "execution",
        ownerId: "owner",
        runId: "run",
        fencingToken: "15"
      },
      now: new Date("2026-07-20T22:00:00.000Z")
    }),
    /POSTGRES_SHORT_ASSET_INELIGIBLE/
  );
  assert.equal(submitCalls, 0);
  assert.equal(
    statements.some((sql) => /SET status = 'ready_for_submission'/.test(sql)),
    true
  );
});
