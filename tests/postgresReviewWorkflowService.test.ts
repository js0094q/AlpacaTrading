import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { Pool } from "pg";

import { loadDatabaseConfig } from "../src/lib/database/config.js";
import { createPostgresPool } from "../src/lib/database/postgres.js";
import { runPostgresMigrations } from "../src/lib/database/postgresMigrations.js";
import {
  PAPER_EXPLORATION_V2_THRESHOLDS,
  paperExplorationThresholds
} from "../src/services/paperExplorationConfig.js";
import { runPostgresReviewWorkflow } from "../src/services/postgresReviewWorkflowService.js";
import { selectExpressionWithPolicy } from "../src/services/strategySelectionLogic.js";

const fence = {
  jobName: "allocation", workstream: "allocation", ownerId: "worker",
  runId: "run", fencingToken: "9"
};

const paperLeapsEnvironment = {
  ALPACA_ENV: "paper",
  TRADING_MODE: "paper",
  ALPACA_LIVE_TRADE: "false",
  LIVE_TRADING_ENABLED: "false",
  LEAPS_MAX_ENTRY_CAPITAL_USD: "5000"
};

const candidate = {
  candidate_id: "candidate-1", symbol: "SPY", asset_class: "equity",
  option_symbol: null, preferred_expression: "shares", direction: "long",
  confidence: "0.9", candidate_as_of: "2026-07-20T20:00:00.000Z",
  account_id: "account-1", account_snapshot_id: "snapshot-1",
  snapshot_fingerprint: "portfolio-fingerprint",
  structural_fingerprint: "structural-fingerprint", buying_power: "10000",
  cash: "8000", equity: "20000", strategy_key: "baseline",
  allocation_amount: "5000", allocation_ratio: null, reserved_amount: "0",
  deployed_amount: "0", max_position_notional: "2000",
  max_symbol_notional: "2000", max_deployment_amount: "10000",
  cash_reserve_amount: "1000", cash_reserve_ratio: null,
  market_price: "555", market_timestamp: "2026-07-20T21:59:30.000Z",
  market_request_id: "sip-request", open_position_count: "0",
  open_order_count: "0"
};
const observedOptionContract = {
  contract_option_symbol: "SPY260821C00560000",
  contract_id: "option-contract-SPY260821C00560000",
  contract_underlying_symbol: "SPY",
  contract_type: "call",
  contract_expiration_date: "2026-08-21",
  contract_tradable: true,
  contract_status: "active",
  contract_source: "alpaca",
  contract_observed_at: "2026-07-20T21:59:00.000Z",
  contract_multiplier: "100",
  sip_underlying_symbol: "SPY",
  sip_market_price: "555",
  sip_market_timestamp: "2026-07-20T21:59:30.000Z",
  sip_bid_price: "554.90",
  sip_ask_price: "555.10",
  sip_requested_feed: "sip",
  sip_effective_feed: "sip",
  sip_provider: "alpaca",
  sip_request_id: "sip-underlying-request"
};
const observedExitOptionContract = (optionSymbol: string) => {
  const parsed = optionSymbol.match(/^([A-Z]{1,6})(\d{6})([CP])\d{8}$/);
  if (!parsed) throw new Error(`invalid test option symbol: ${optionSymbol}`);
  const expiration = parsed[2]!;
  const put = parsed[3] === "P";
  return {
    ...observedOptionContract,
    contract_option_symbol: optionSymbol,
    contract_id: `contract-${optionSymbol}`,
    contract_type: put ? "put" : "call",
    contract_expiration_date:
      `20${expiration.slice(0, 2)}-${expiration.slice(2, 4)}-${expiration.slice(4, 6)}`,
    opening_intent_id: `opening-intent-${optionSymbol}`,
    opening_review_id: `opening-review-${optionSymbol}`,
    opening_order_id: `opening-order-${optionSymbol}`,
    opening_strategy_classification: put
      ? "standard_long_put"
      : "standard_long_call",
    opening_contract_id: `contract-${optionSymbol}`,
    opening_authorization_snapshot_id: `opening-snapshot-${optionSymbol}`,
    allocation_id: "allocation-baseline",
    allocation_status: "active",
    allocation_effective_to: null
  };
};

test("entry review persists signed PostgreSQL review and unconfirmed pending intent", async () => {
  const sql: string[] = [];
  let sourceSql = "";
  let intentValues: readonly unknown[] = [];
  let candidateUpdateValues: readonly unknown[] = [];
  const result = await runPostgresReviewWorkflow({
    command: "paper:review",
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        sql.push(statement);
        if (statement.includes("FROM candidates candidate")) {
          sourceSql = statement;
          return { rows: [candidate], rowCount: 1 };
        }
        if (statement.includes("INSERT INTO order_intents")) {
          intentValues = values ?? [];
        }
        if (statement.includes("UPDATE candidates")) candidateUpdateValues = values ?? [];
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    maxCandidates: 25,
    explorationThresholds: PAPER_EXPLORATION_V2_THRESHOLDS,
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "completed");
  assert.equal(result.reviewsCreated, 1);
  assert.equal(result.pendingIntentsCreated, 1);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO execution_reviews")), true);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO order_intents")), true);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO confirmation_evidence")), false);
  assert.equal(sql.some((statement) => /'created'/.test(statement) && statement.includes("order_intents")), true);
  assert.equal(
    intentValues[13],
    PAPER_EXPLORATION_V2_THRESHOLDS.maxOrderNotional
  );
  assert.equal(candidateUpdateValues[1], "sized");
  assert.equal(candidateUpdateValues[2], "PAPER_ORDER_INTENT_CREATED");
  assert.match(sourceSql, /LIMIT 25$/);
});

test("a PostgreSQL Date option expiration propagates into an order intent", async () => {
  const exploration = paperExplorationThresholds({
    ALPACA_ENV: "paper",
    TRADING_MODE: "paper",
    ALPACA_LIVE_TRADE: "false",
    LIVE_TRADING_ENABLED: "false"
  });
  const selection = selectExpressionWithPolicy({
    symbol: "SPY",
    asOf: "2026-07-20T21:59:30.000Z",
    direction: "long",
    confidence: 0.375,
    expectedReturn: 0.002,
    atr: 2,
    trend: "bullish",
    iv: 0.3,
    liquidityScore: 0.1,
    spreadPct: 0.15,
    hasOptionsData: true
  }, true, exploration);
  assert.equal(selection.preferredExpression, "long_call");

  let orderIntent: Record<string, unknown> | undefined;
  let reviewMarketEvidence: Array<Record<string, unknown>> = [];
  let sourceSql = "";
  const result = await runPostgresReviewWorkflow({
    command: "paper:review",
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("FROM candidates candidate")) {
          sourceSql = statement;
          return {
            rows: [{
              ...candidate,
              ...observedOptionContract,
              contract_expiration_date: new Date("2026-08-21T00:00:00.000Z"),
              candidate_id: "candidate-new-threshold-option",
              asset_class: "option",
              option_symbol: "SPY260821C00560000",
              preferred_expression: selection.preferredExpression,
              confidence: "0.375",
              market_price: "2",
              signal_inputs: {
                marketDecisionInputs: {
                  currentTradablePrice: 555,
                  option: {
                    selectionScore: 0.5,
                    liquidityScore: 0.1,
                    spreadPct: 0.02,
                    volume: 5_000,
                    openInterest: 8_000,
                    feed: "opra"
                  }
                }
              },
              market_evidence: {
                bid: 1.98,
                ask: 2.02,
                midpoint: 2,
                spreadPct: 0.02,
                volume: 5_000,
                openInterest: 8_000,
                underlyingPrice: 555,
                requestedFeed: "opra",
                effectiveFeed: "opra",
                provider: "alpaca"
              }
            }],
            rowCount: 1
          };
        }
        if (statement.includes("INSERT INTO execution_reviews")) {
          orderIntent = JSON.parse(String(values?.[9])) as Record<string, unknown>;
          reviewMarketEvidence = JSON.parse(
            String(values?.[10])
          ) as Array<Record<string, unknown>>;
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    explorationThresholds: exploration,
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "completed");
  assert.equal(result.pendingIntentsCreated, 1);
  assert.equal(orderIntent?.symbol, "SPY260821C00560000");
  assert.equal(orderIntent?.side, "buy_to_open");
  assert.equal(orderIntent?.orderType, "limit");
  assert.equal(reviewMarketEvidence[0]?.underlyingPrice, 555);
  assert.deepEqual(reviewMarketEvidence[0]?.underlyingSip, {
    symbol: "SPY",
    referencePrice: 555,
    timestamp: "2026-07-20T21:59:30.000Z",
    requestId: "sip-underlying-request",
    bid: 554.9,
    ask: 555.1,
    requestedFeed: "sip",
    effectiveFeed: "sip",
    provider: "alpaca",
    source: "postgres.stock_snapshots"
  });
  assert.match(sourceSql, /FROM stock_snapshots stock/);
  assert.match(sourceSql, /contract\.underlying_symbol AS contract_underlying_symbol/);
  assert.match(
    sourceSql,
    /option_snapshot\.source IN \('alpaca', 'alpaca_opra_stream'\)/
  );
});

test("entry review maps a selected equity short to a sell order intent", async () => {
  let reviewOrderIntent: Record<string, unknown> | undefined;
  let intentValues: readonly unknown[] = [];
  const result = await runPostgresReviewWorkflow({
    command: "paper:review",
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("FROM candidates candidate")) {
          return {
            rows: [{ ...candidate, candidate_id: "candidate-short", direction: "short" }],
            rowCount: 1
          };
        }
        if (statement.includes("INSERT INTO execution_reviews")) {
          reviewOrderIntent = JSON.parse(String(values?.[9])) as Record<string, unknown>;
        }
        if (statement.includes("INSERT INTO order_intents")) intentValues = values ?? [];
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "completed");
  assert.equal(reviewOrderIntent?.side, "sell");
  assert.equal(reviewOrderIntent?.quantity, 1);
  assert.equal(reviewOrderIntent?.notional, null);
  assert.equal(intentValues[10], "sell");
  assert.equal(intentValues[12], 1);
  assert.equal(intentValues[13], null);
});

test("option review sizing is conservatively scaled by premium Alpaca decision evidence", async () => {
  let intentValues: readonly unknown[] = [];
  let persistedMarketEvidence: Array<Record<string, unknown>> = [];
  const optionCandidate = {
    ...candidate,
    ...observedOptionContract,
    candidate_id: "candidate-option-quality",
    asset_class: "option" as const,
    option_symbol: "SPY260821C00560000",
    preferred_expression: "long_call",
    market_price: "2",
    signal_inputs: {
      marketDecisionInputs: {
        option: {
          selectionScore: 0.6,
          liquidityScore: 0.8,
          impliedVolatility: 0.3,
          delta: 0.48,
          gamma: 0.03,
          theta: -0.06,
          vega: 0.15,
          rho: 0.04,
          spreadPct: 0.02,
          volume: 5_000,
          openInterest: 8_000,
          feed: "opra"
        }
      }
    },
    market_evidence: {
      bid: 1.98,
      ask: 2.02,
      midpoint: 2,
      spreadPct: 0.02,
      impliedVolatility: 0.3,
      delta: 0.48,
      gamma: 0.03,
      theta: -0.06,
      vega: 0.15,
      rho: 0.04,
      volume: 5_000,
      openInterest: 8_000,
      underlyingPrice: 555,
      requestedFeed: "opra",
      effectiveFeed: "opra",
      provider: "alpaca"
    }
  };

  const result = await runPostgresReviewWorkflow({
    command: "paper:review",
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("FROM candidates candidate")) {
          return { rows: [optionCandidate], rowCount: 1 };
        }
        if (statement.includes("INSERT INTO execution_reviews")) {
          persistedMarketEvidence = JSON.parse(String(values?.[10]));
        }
        if (statement.includes("INSERT INTO order_intents")) {
          intentValues = values ?? [];
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    explorationThresholds: PAPER_EXPLORATION_V2_THRESHOLDS,
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "completed");
  assert.equal(intentValues[12], 3);
  assert.equal(intentValues[15], 600);
  assert.equal(persistedMarketEvidence[0]?.effectiveFeed, "opra");
  assert.equal(persistedMarketEvidence[0]?.selectionScore, 0.6);
  assert.equal(persistedMarketEvidence[0]?.delta, 0.48);
  assert.equal(persistedMarketEvidence[0]?.openInterest, 8_000);
});

test("entry review skips an existing candidate and account-snapshot review identity", async () => {
  let reviewCreated = false;
  let sourceReads = 0;
  const query = {
    query: async (statement: string) => {
      if (statement.includes("FROM candidates candidate")) {
        sourceReads += 1;
        const excludesExistingIdentity = statement.includes("FROM execution_reviews existing_review");
        if (reviewCreated && excludesExistingIdentity) return { rows: [], rowCount: 0 };
        return {
          rows: [{
            ...candidate,
            market_timestamp: sourceReads === 1
              ? "2026-07-20T21:59:30.000Z"
              : "2026-07-20T21:59:45.000Z"
          }],
          rowCount: 1
        };
      }
      if (statement.includes("INSERT INTO execution_reviews")) {
        if (reviewCreated) {
          throw new Error("duplicate key value violates unique constraint execution_reviews_client_order_idx");
        }
        reviewCreated = true;
      }
      return { rows: [], rowCount: 1 };
    }
  };

  const first = await runPostgresReviewWorkflow({
    command: "paper:review",
    query,
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:00.000Z")
  });
  assert.equal(first.reviewsCreated, 1);

  const second = await runPostgresReviewWorkflow({
    command: "paper:review",
    query,
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:10.000Z")
  });
  assert.equal(second.status, "no_op");
  assert.equal(second.reviewsCreated, 0);
  assert.equal(second.pendingIntentsCreated, 0);
  assert.equal(sourceReads, 2);
});

test("a single stale proposal becomes canonical no-action after a bounded rejection", async () => {
  const sql: string[] = [];
  let candidateUpdateValues: readonly unknown[] = [];
  const result = await runPostgresReviewWorkflow({
    command: "paper:review",
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        sql.push(statement);
        if (statement.includes("FROM candidates candidate")) {
          return { rows: [{ ...candidate, market_timestamp: "2026-07-15T20:00:00.000Z" }], rowCount: 1 };
        }
        if (statement.includes("UPDATE candidates")) candidateUpdateValues = values ?? [];
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:00.000Z")
  });
  assert.equal(result.status, "no_op");
  assert.equal(result.code, "NO_ELIGIBLE_POSTGRES_CANDIDATES");
  assert.equal(candidateUpdateValues[1], "blocked");
  assert.equal(candidateUpdateValues[2], "POSTGRES_REVIEW_MARKET_EVIDENCE_STALE:SPY");
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO execution_reviews")), false);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO order_intents")), false);
});

test("entry review accepts market evidence that is fresh through the 30-minute boundary", async () => {
  const sql: string[] = [];
  const result = await runPostgresReviewWorkflow({
    command: "paper:review",
    query: {
      query: async (statement: string) => {
        sql.push(statement);
        if (statement.includes("FROM candidates candidate")) {
          return {
            rows: [{
              ...candidate,
              market_timestamp: "2026-07-20T21:30:01.000Z"
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "completed");
  assert.equal(result.reviewsCreated, 1);
  assert.equal(result.pendingIntentsCreated, 1);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO execution_reviews")), true);
});

for (const [label, sipOverride, expected] of [
  [
    "missing SIP underlying evidence",
    {
      sip_market_price: null,
      sip_market_timestamp: null,
      sip_requested_feed: null,
      sip_effective_feed: null,
      sip_provider: null
    },
    /POSTGRES_REVIEW_OPTION_UNDERLYING_SIP_INVALID:SPY260821C00560000/
  ],
  [
    "stale SIP underlying evidence",
    { sip_market_timestamp: "2026-07-20T21:29:59.000Z" },
    /POSTGRES_REVIEW_OPTION_UNDERLYING_SIP_STALE:SPY260821C00560000/
  ]
] as const) {
  test(`option entry rejects ${label} even when OPRA is fresh`, async () => {
    const sql: string[] = [];
    const optionCandidate = {
      ...candidate,
      ...observedOptionContract,
      ...sipOverride,
      candidate_id: `candidate-${label.replaceAll(" ", "-")}`,
      asset_class: "option" as const,
      option_symbol: "SPY260821C00560000",
      preferred_expression: "long_call",
      market_price: "2",
      market_timestamp: "2026-07-20T21:59:30.000Z",
      market_evidence: {
        bid: 1.98,
        ask: 2.02,
        midpoint: 2,
        spreadPct: 0.02,
        volume: 5_000,
        openInterest: 8_000,
        underlyingPrice: 555,
        requestedFeed: "opra",
        effectiveFeed: "opra",
        provider: "alpaca"
      },
      signal_inputs: {
        marketDecisionInputs: {
          currentTradablePrice: 555,
          option: {
            selectionScore: 0.6,
            liquidityScore: 0.8,
            spreadPct: 0.02,
            volume: 5_000,
            openInterest: 8_000,
            feed: "opra"
          }
        }
      }
    };

    await assert.rejects(
      runPostgresReviewWorkflow({
        command: "paper:review",
        query: {
          query: async (statement: string) => {
            sql.push(statement);
            if (statement.includes("FROM candidates candidate")) {
              return { rows: [optionCandidate], rowCount: 1 };
            }
            return { rows: [], rowCount: 1 };
          }
        },
        fence,
        signingKey: "test-signing-key-with-sufficient-length",
        now: new Date("2026-07-20T22:00:00.000Z")
      }),
      expected
    );
    assert.equal(
      sql.some((statement) => statement.includes("INSERT INTO execution_reviews")),
      false
    );
  });
}

for (const [label, marketEvidence] of [
  ["missing bid", { ask: 2.02, midpoint: 2 }],
  ["missing ask", { bid: 1.98, midpoint: 2 }],
  ["crossed quote", { bid: 2.02, ask: 1.98, midpoint: 2 }],
  ["non-executable quote", { bid: 0, ask: 0, midpoint: 0 }]
] as const) {
  test(`option review rejects fresh option evidence with ${label} before persistence`, async () => {
    const sql: string[] = [];
    const optionCandidate = {
      ...candidate,
      ...observedOptionContract,
      candidate_id: `candidate-option-invalid-${label.replaceAll(" ", "-")}`,
      asset_class: "option" as const,
      option_symbol: "SPY260821C00560000",
      preferred_expression: "long_call",
      market_price: "2",
      market_evidence: {
        ...marketEvidence,
        volume: 5_000,
        openInterest: 8_000,
        impliedVolatility: 0.3,
        requestedFeed: "opra",
        effectiveFeed: "opra",
        provider: "alpaca",
        underlyingPrice: 555
      },
      signal_inputs: {
        marketDecisionInputs: {
          currentTradablePrice: 555,
          option: {
            selectionScore: 0.6,
            liquidityScore: 0.8,
            spreadPct: 0.02,
            feed: "opra"
          }
        }
      }
    };

    await assert.rejects(
      runPostgresReviewWorkflow({
        command: "paper:review",
        query: {
          query: async (statement: string) => {
            sql.push(statement);
            if (statement.includes("FROM candidates candidate")) {
              return { rows: [optionCandidate], rowCount: 1 };
            }
            return { rows: [], rowCount: 1 };
          }
        },
        fence,
        signingKey: "test-signing-key-with-sufficient-length",
        now: new Date("2026-07-20T22:00:00.000Z")
      }),
      /POSTGRES_REVIEW_OPTION_QUOTE_INVALID:SPY260821C00560000/
    );
    assert.equal(sql.some((statement) => statement.includes("INSERT INTO execution_reviews")), false);
    assert.equal(sql.some((statement) => statement.includes("INSERT INTO order_intents")), false);
  });
}

test("invalid option contract blocks only that proposal and preserves valid equity work", async () => {
  const sql: string[] = [];
  const candidateUpdates: Array<readonly unknown[]> = [];
  const invalidOption = {
                ...candidate,
                candidate_id: "candidate-option-untradable",
                asset_class: "option",
                option_symbol: "SPY260821C00560000",
                preferred_expression: "long_call",
                market_price: "2",
                contract_option_symbol: "SPY260821C00560000",
                contract_tradable: false,
                contract_status: "inactive",
                contract_source: "alpaca",
                contract_observed_at: "2026-07-20T21:59:00.000Z",
                market_evidence: {
                  bid: 1.98,
                  ask: 2.02,
                  midpoint: 2,
                  spreadPct: 0.02,
                  volume: 5_000,
                  openInterest: 8_000,
                  underlyingPrice: 555,
                  requestedFeed: "opra",
                  effectiveFeed: "opra",
                  provider: "alpaca"
                },
                signal_inputs: {
                  marketDecisionInputs: {
                    currentTradablePrice: 555,
                    option: {
                      selectionScore: 0.6,
                      liquidityScore: 0.8,
                      spreadPct: 0.02,
                      volume: 5_000,
                      openInterest: 8_000,
                      feed: "opra"
                    }
                  }
                }
  };
  const result = await runPostgresReviewWorkflow({
    command: "paper:review",
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        sql.push(statement);
        if (statement.includes("FROM candidates candidate")) {
          return {
            rows: [
              { ...candidate, candidate_id: "valid-equity", symbol: "QQQ" },
              invalidOption
            ],
            rowCount: 2
          };
        }
        if (statement.includes("UPDATE candidates")) candidateUpdates.push(values ?? []);
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "completed");
  assert.equal(result.reviewsCreated, 1);
  assert.equal(result.pendingIntentsCreated, 1);
  assert.equal(sql.filter((statement) => statement.includes("INSERT INTO execution_reviews")).length, 1);
  assert.equal(sql.filter((statement) => statement.includes("INSERT INTO order_intents")).length, 1);
  assert.equal(candidateUpdates.some((values) =>
    values[0] === "candidate-option-untradable" &&
    values[1] === "blocked" &&
    values[2] === "POSTGRES_REVIEW_OPTION_CONTRACT_INVALID:SPY260821C00560000"
  ), true);
});

test("entry review skips held/open-order candidates and reviews the remaining candidates", async () => {
  const sql: string[] = [];
  const candidateUpdates: Array<readonly unknown[]> = [];
  const rows = [
    { ...candidate, candidate_id: "held-candidate", open_position_count: "1" },
    { ...candidate, candidate_id: "available-candidate", symbol: "QQQ" }
  ];
  const result = await runPostgresReviewWorkflow({
    command: "paper:review",
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        sql.push(statement);
        if (statement.includes("FROM candidates candidate")) return { rows, rowCount: rows.length };
        if (statement.includes("UPDATE candidates")) candidateUpdates.push(values ?? []);
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "completed");
  assert.equal(result.reviewsCreated, 1);
  assert.equal(result.pendingIntentsCreated, 1);
  assert.equal(result.skipped, 1);
  assert.equal(sql.filter((statement) => statement.includes("INSERT INTO execution_reviews")).length, 1);
  assert.equal(sql.filter((statement) => statement.includes("INSERT INTO order_intents")).length, 1);
  assert.equal(candidateUpdates.some((values) =>
    values[0] === "held-candidate" &&
    values[1] === "skipped" &&
    values[2] === "POSTGRES_REVIEW_POSITION_OR_ORDER_EXISTS"
  ), true);
});

test("stale proposal evidence blocks only that candidate and preserves valid siblings", async () => {
  const sql: string[] = [];
  const candidateUpdates: Array<readonly unknown[]> = [];
  const result = await runPostgresReviewWorkflow({
    command: "paper:review",
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        sql.push(statement);
        if (statement.includes("FROM candidates candidate")) {
          return { rows: [candidate, { ...candidate, candidate_id: "stale-candidate", symbol: "QQQ", market_timestamp: "2026-07-15T20:00:00.000Z" }], rowCount: 2 };
        }
        if (statement.includes("UPDATE candidates")) candidateUpdates.push(values ?? []);
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "completed");
  assert.equal(result.reviewsCreated, 1);
  assert.equal(result.pendingIntentsCreated, 1);
  assert.equal(sql.filter((statement) => statement.includes("INSERT INTO execution_reviews")).length, 1);
  assert.equal(sql.filter((statement) => statement.includes("INSERT INTO order_intents")).length, 1);
  assert.equal(candidateUpdates.some((values) =>
    values[0] === "stale-candidate" &&
    values[1] === "blocked" &&
    values[2] === "POSTGRES_REVIEW_MARKET_EVIDENCE_STALE:QQQ"
  ), true);
});

test("option capacity insufficiency blocks only that candidate and preserves preceding eligible work", async () => {
  const sql: string[] = [];
  const candidateUpdates: Array<readonly unknown[]> = [];
  const rows = [
    { ...candidate, candidate_id: "available-candidate" },
    {
      ...candidate,
      ...observedOptionContract,
      candidate_id: "option-candidate",
      symbol: "SPY",
      asset_class: "option" as const,
      option_symbol: "SPY260821C00600000",
      contract_option_symbol: "SPY260821C00600000",
      preferred_expression: "option",
      market_price: "20",
      market_evidence: {
        bid: 19.8,
        ask: 20.2,
        midpoint: 20,
        spreadPct: 0.02,
        volume: 5_000,
        openInterest: 8_000,
        underlyingPrice: 555,
        requestedFeed: "opra",
        effectiveFeed: "opra",
        provider: "alpaca"
      },
      signal_inputs: {
        marketDecisionInputs: {
          currentTradablePrice: 555,
          option: {
            selectionScore: 0.6,
            liquidityScore: 0.8,
            spreadPct: 0.02,
            volume: 5_000,
            openInterest: 8_000,
            feed: "opra"
          }
        }
      }
    }
  ];
  const result = await runPostgresReviewWorkflow({
    command: "paper:review",
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        sql.push(statement);
        if (statement.includes("FROM candidates candidate")) return { rows, rowCount: rows.length };
        if (statement.includes("UPDATE candidates")) candidateUpdates.push(values ?? []);
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "completed");
  assert.equal(result.reviewsCreated, 1);
  assert.equal(result.pendingIntentsCreated, 1);
  assert.equal(result.capacityBlocked, 1);
  assert.equal(sql.filter((statement) => statement.includes("INSERT INTO execution_reviews")).length, 1);
  assert.equal(sql.filter((statement) => statement.includes("INSERT INTO order_intents")).length, 1);
  assert.equal(candidateUpdates.some((values) =>
    values[0] === "option-candidate" &&
    values[1] === "blocked" &&
    values[2] === "POSTGRES_REVIEW_OPTION_CAPACITY_INSUFFICIENT"
  ), true);
});

test("entry review classifies same-day expiration against the New York trading date", async () => {
  let orderIntent: Record<string, unknown> | undefined;
  await runPostgresReviewWorkflow({
    command: "paper:review",
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("FROM candidates candidate")) {
          return {
            rows: [{
              ...candidate,
              ...observedOptionContract,
              candidate_id: "zero-dte-new-york-date",
              candidate_strategy_family: "zero_dte_spy",
              asset_class: "option",
              option_symbol: "SPY260720C00560000",
              contract_option_symbol: "SPY260720C00560000",
              contract_expiration_date: "2026-07-20",
              preferred_expression: "option",
              market_price: "2",
              market_timestamp: "2026-07-21T00:29:30.000Z",
              sip_market_timestamp: "2026-07-21T00:29:30.000Z",
              market_evidence: {
                bid: 1.98,
                ask: 2.02,
                midpoint: 2,
                spreadPct: 0.02,
                volume: 5_000,
                openInterest: 8_000,
                underlyingPrice: 555,
                requestedFeed: "opra",
                effectiveFeed: "opra",
                provider: "alpaca"
              }
            }],
            rowCount: 1
          };
        }
        if (statement.includes("INSERT INTO execution_reviews")) {
          orderIntent = JSON.parse(
            String(values?.[9])
          ) as Record<string, unknown>;
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-21T00:30:00.000Z")
  });

  assert.equal(orderIntent?.strategyClassification, "zero_dte_long_call");
});

test("LEAPS uses the independent $5,000 ceiling and persists one integer contract", async () => {
  let orderIntent: Record<string, unknown> | undefined;
  let marketEvidence: Array<Record<string, unknown>> = [];
  const result = await runPostgresReviewWorkflow({
    command: "paper:review",
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("FROM candidates candidate")) {
          return {
            rows: [{
              ...candidate,
              ...observedOptionContract,
              candidate_id: "leaps-3000",
              candidate_strategy_family: "leaps",
              asset_class: "option",
              option_symbol: "SPY260821C00560000",
              preferred_expression: "option",
              market_price: "30",
              max_position_notional: "10000",
              max_symbol_notional: "10000",
              market_evidence: {
                bid: 29.9,
                ask: 30.1,
                midpoint: 30,
                spreadPct: 0.00667,
                volume: 5_000,
                openInterest: 8_000,
                underlyingPrice: 555,
                requestedFeed: "opra",
                effectiveFeed: "opra",
                provider: "alpaca"
              }
            }],
            rowCount: 1
          };
        }
        if (statement.includes("INSERT INTO execution_reviews")) {
          orderIntent = JSON.parse(String(values?.[9])) as Record<string, unknown>;
          marketEvidence = JSON.parse(
            String(values?.[10])
          ) as Array<Record<string, unknown>>;
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    leapsEntryAllocationEnv: paperLeapsEnvironment,
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.reviewsCreated, 1);
  assert.equal(orderIntent?.quantity, 1);
  assert.equal(Number.isInteger(Number(orderIntent?.quantity)), true);
  assert.equal(marketEvidence[0]?.leapsSizing &&
    (marketEvidence[0].leapsSizing as Record<string, unknown>).configuredPerEntryAllocationUsd,
  5_000);
  assert.equal(
    (marketEvidence[0]?.leapsSizing as Record<string, unknown>)?.contractCostUsd,
    3_000
  );
  assert.equal(
    (marketEvidence[0]?.leapsSizing as Record<string, unknown>)?.contractMultiplier,
    100
  );
});

test("an exactly $5,000 LEAPS contract remains limited to one contract", async () => {
  let orderIntent: Record<string, unknown> | undefined;
  const result = await runPostgresReviewWorkflow({
    command: "paper:review",
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("FROM candidates candidate")) {
          return {
            rows: [{
              ...candidate,
              ...observedOptionContract,
              candidate_id: "leaps-5000",
              candidate_strategy_family: "leaps",
              asset_class: "option",
              option_symbol: "SPY260821C00560000",
              preferred_expression: "option",
              market_price: "50",
              buying_power: "100000",
              cash: "100000",
              equity: "100000",
              allocation_amount: "100000",
              max_position_notional: "100000",
              max_symbol_notional: "100000",
              max_deployment_amount: "100000",
              cash_reserve_amount: "0",
              market_evidence: {
                bid: 49.9,
                ask: 50.1,
                midpoint: 50,
                spreadPct: 0.004,
                volume: 5_000,
                openInterest: 8_000,
                underlyingPrice: 555,
                requestedFeed: "opra",
                effectiveFeed: "opra",
                provider: "alpaca"
              }
            }],
            rowCount: 1
          };
        }
        if (statement.includes("INSERT INTO execution_reviews")) {
          orderIntent = JSON.parse(String(values?.[9])) as Record<string, unknown>;
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    leapsEntryAllocationEnv: paperLeapsEnvironment,
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.reviewsCreated, 1);
  assert.equal(orderIntent?.quantity, 1);
});

test("buying power still rejects an otherwise allocation-affordable LEAPS contract", async () => {
  let candidateUpdate: readonly unknown[] = [];
  const result = await runPostgresReviewWorkflow({
    command: "paper:review",
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("FROM candidates candidate")) {
          return {
            rows: [{
              ...candidate,
              ...observedOptionContract,
              candidate_id: "leaps-buying-power-block",
              candidate_strategy_family: "leaps",
              asset_class: "option",
              option_symbol: "SPY260821C00560000",
              preferred_expression: "option",
              market_price: "30",
              buying_power: "2500",
              cash: "100000",
              equity: "100000",
              allocation_amount: "100000",
              max_position_notional: "100000",
              max_symbol_notional: "100000",
              max_deployment_amount: "100000",
              cash_reserve_amount: "0",
              market_evidence: {
                bid: 29.9,
                ask: 30.1,
                midpoint: 30,
                spreadPct: 0.00667,
                volume: 5_000,
                openInterest: 8_000,
                underlyingPrice: 555,
                requestedFeed: "opra",
                effectiveFeed: "opra",
                provider: "alpaca"
              }
            }],
            rowCount: 1
          };
        }
        if (statement.includes("UPDATE candidates")) {
          candidateUpdate = values ?? [];
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    leapsEntryAllocationEnv: paperLeapsEnvironment,
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.reviewsCreated, 0);
  assert.equal(result.capacityBlocked, 1);
  assert.equal(candidateUpdate[1], "blocked");
  assert.equal(
    candidateUpdate[2],
    "LEAPS_VALIDATED_AVAILABLE_CAPITAL_INSUFFICIENT"
  );
});

test("an unaffordable higher-ranked LEAPS contract is explicit and does not suppress an affordable sibling", async () => {
  const candidateUpdates: Array<readonly unknown[]> = [];
  const orderIntents: Array<Record<string, unknown>> = [];
  const optionRow = {
    ...candidate,
    ...observedOptionContract,
    candidate_strategy_family: "leaps",
    asset_class: "option" as const,
    preferred_expression: "option",
    buying_power: "100000",
    cash: "100000",
    equity: "100000",
    allocation_amount: "100000",
    max_position_notional: "100000",
    max_symbol_notional: "100000",
    max_deployment_amount: "100000",
    cash_reserve_amount: "0",
    market_evidence: {
      bid: 29.9,
      ask: 30.1,
      midpoint: 30,
      spreadPct: 0.00667,
      volume: 5_000,
      openInterest: 8_000,
      underlyingPrice: 555,
      requestedFeed: "opra",
      effectiveFeed: "opra",
      provider: "alpaca"
    }
  };
  const result = await runPostgresReviewWorkflow({
    command: "paper:review",
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("FROM candidates candidate")) {
          return {
            rows: [
              {
                ...optionRow,
                candidate_id: "leaps-unaffordable",
                option_symbol: "SPY260821C00600000",
                contract_option_symbol: "SPY260821C00600000",
                market_price: "50.01",
                market_evidence: {
                  ...optionRow.market_evidence,
                  bid: 50,
                  ask: 50.02,
                  midpoint: 50.01
                }
              },
              {
                ...optionRow,
                candidate_id: "leaps-affordable",
                option_symbol: "SPY260821C00560000",
                contract_option_symbol: "SPY260821C00560000",
                market_price: "30"
              }
            ],
            rowCount: 2
          };
        }
        if (statement.includes("UPDATE candidates")) {
          candidateUpdates.push(values ?? []);
        }
        if (statement.includes("INSERT INTO execution_reviews")) {
          orderIntents.push(
            JSON.parse(String(values?.[9])) as Record<string, unknown>
          );
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    leapsEntryAllocationEnv: paperLeapsEnvironment,
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.reviewsCreated, 1);
  assert.equal(result.capacityBlocked, 1);
  assert.equal(orderIntents[0]?.symbol, "SPY260821C00560000");
  assert.equal(orderIntents[0]?.quantity, 1);
  assert.equal(candidateUpdates.some((values) =>
    values[0] === "leaps-unaffordable" &&
    values[1] === "blocked" &&
    values[2] === "LEAPS_CONTRACT_COST_EXCEEDS_ALLOCATION"
  ), true);
});

test("short capacity insufficiency is a successful candidate-level block", async () => {
  const sql: string[] = [];
  let candidateUpdateValues: readonly unknown[] = [];
  const result = await runPostgresReviewWorkflow({
    command: "paper:review",
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        sql.push(statement);
        if (statement.includes("FROM candidates candidate")) {
          return {
            rows: [{
              ...candidate,
              candidate_id: "short-capacity-candidate",
              direction: "short",
              market_price: "2000"
            }],
            rowCount: 1
          };
        }
        if (statement.includes("UPDATE candidates")) candidateUpdateValues = values ?? [];
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "completed");
  assert.equal(result.code, "POSTGRES_REVIEW_CAPACITY_UNAVAILABLE");
  assert.equal(result.reviewsCreated, 0);
  assert.equal(result.pendingIntentsCreated, 0);
  assert.equal(result.capacityBlocked, 1);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO execution_reviews")), false);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO order_intents")), false);
  assert.equal(candidateUpdateValues[0], "short-capacity-candidate");
  assert.equal(candidateUpdateValues[1], "blocked");
  assert.equal(candidateUpdateValues[2], "POSTGRES_REVIEW_SHORT_CAPACITY_INSUFFICIENT");
});

test("exhausted allocation capacity is a successful row-level no-op", async () => {
  const sql: string[] = [];
  let candidateUpdateValues: readonly unknown[] = [];
  const result = await runPostgresReviewWorkflow({
    command: "paper:review",
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        sql.push(statement);
        if (statement.includes("FROM candidates candidate")) {
          return { rows: [{ ...candidate, reserved_amount: "5000" }], rowCount: 1 };
        }
        if (statement.includes("UPDATE candidates")) candidateUpdateValues = values ?? [];
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "completed");
  assert.equal(result.code, "POSTGRES_REVIEW_CAPACITY_UNAVAILABLE");
  assert.equal(result.reviewsCreated, 0);
  assert.equal(result.pendingIntentsCreated, 0);
  assert.equal(result.capacityBlocked, 1);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO execution_reviews")), false);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO order_intents")), false);
  assert.equal(candidateUpdateValues[1], "blocked");
  assert.equal(candidateUpdateValues[2], "POSTGRES_REVIEW_CAPACITY_UNAVAILABLE");
});

for (const field of ["buying_power", "cash", "equity"] as const) {
  for (const missingValue of [null, "   ", "not-a-number"] as const) {
    test(`missing or malformed ${field} sizing evidence fails closed before persistence`, async () => {
      const sql: string[] = [];
      await assert.rejects(
        runPostgresReviewWorkflow({
          command: "paper:review",
          query: {
            query: async (statement: string) => {
              sql.push(statement);
              if (statement.includes("FROM candidates candidate")) {
                return { rows: [{ ...candidate, [field]: missingValue }], rowCount: 1 };
              }
              return { rows: [], rowCount: 1 };
            }
          },
          fence,
          signingKey: "test-signing-key-with-sufficient-length",
          now: new Date("2026-07-20T22:00:00.000Z")
        }),
        /POSTGRES_REVIEW_ACCOUNT_SIZING_EVIDENCE_MISSING/
      );
      assert.equal(sql.some((statement) => statement.includes("INSERT INTO execution_reviews")), false);
      assert.equal(sql.some((statement) => statement.includes("INSERT INTO order_intents")), false);
    });
  }

  test(`explicit zero ${field} evidence produces a completed capacity outcome`, async () => {
    const sql: string[] = [];
    const result = await runPostgresReviewWorkflow({
      command: "paper:review",
      query: {
        query: async (statement: string) => {
          sql.push(statement);
          if (statement.includes("FROM candidates candidate")) {
            return {
              rows: [{
                ...candidate,
                [field]: "0",
                ...(field === "equity" ? { cash_reserve_amount: "8000" } : {})
              }],
              rowCount: 1
            };
          }
          return { rows: [], rowCount: 1 };
        }
      },
      fence,
      signingKey: "test-signing-key-with-sufficient-length",
      now: new Date("2026-07-20T22:00:00.000Z")
    });
    assert.equal(result.status, "completed");
    assert.equal(result.code, "POSTGRES_REVIEW_CAPACITY_UNAVAILABLE");
    assert.equal(result.capacityBlocked, 1);
    assert.equal(sql.some((statement) => statement.includes("INSERT INTO execution_reviews")), false);
    assert.equal(sql.some((statement) => statement.includes("INSERT INTO order_intents")), false);
  });
}

test("exit review evaluates existing thresholds against PostgreSQL position and market evidence", async () => {
  const sql: string[] = [];
  const result = await runPostgresReviewWorkflow({
    command: "paper:exit:review",
    query: {
      query: async (statement: string) => {
        sql.push(statement);
        if (statement.includes("FROM positions position")) return {
          rows: [{
            position_id: "position-1", candidate_id: "candidate-1",
            opening_intent_id: "intent-long-open",
            opening_review_id: "review-long-open",
            opening_order_id: "order-long-open",
            opening_strategy_classification: "equity_long",
            opening_authorization_snapshot_id: "snapshot-long-open",
            symbol: "SPY", order_symbol: "SPY", asset_class: "equity",
            side: "long", available_quantity: "2", average_entry_price: "500",
            strategy_key: "baseline", account_id: "account-1",
            allocation_id: "allocation-baseline",
            allocation_status: "active", allocation_effective_to: null,
            account_snapshot_id: "snapshot-1", snapshot_fingerprint: "portfolio-fingerprint",
            structural_fingerprint: "structural-fingerprint", market_price: "550",
            market_timestamp: "2026-07-20T21:59:30.000Z", market_request_id: "sip-request"
          }],
          rowCount: 1
        };
        if (statement.includes("INSERT INTO execution_reviews")) {
          return { rows: [{ fence_held: true, inserted_count: 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "completed");
  assert.equal(result.reviewsCreated, 1);
  assert.equal(sql.some((statement) => statement.includes("'exit'")), true);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO order_intents")), true);
});

test("exit review maps a short equity exit to buy-to-cover", async () => {
  let reviewOrderIntent: Record<string, unknown> | undefined;
  let persistenceSql = "";
  let persistenceValues: readonly unknown[] = [];
  const result = await runPostgresReviewWorkflow({
    command: "paper:exit:review",
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("FROM positions position")) {
          return {
            rows: [{
              position_id: "position-short", candidate_id: "candidate-short",
              opening_intent_id: "intent-short-open",
              opening_review_id: "review-short-open",
              opening_order_id: "order-short-open",
              opening_strategy_classification: "equity_short",
              opening_authorization_snapshot_id: "snapshot-short-open",
              symbol: "AAPL", order_symbol: "AAPL", asset_class: "equity",
              side: "short", available_quantity: "1", average_entry_price: "200",
              strategy_key: "baseline", account_id: "account-1",
              allocation_id: "allocation-baseline",
              allocation_status: "active", allocation_effective_to: null,
              account_snapshot_id: "snapshot-1", snapshot_fingerprint: "portfolio-fingerprint",
              structural_fingerprint: "structural-fingerprint", market_price: "180",
              market_timestamp: "2026-07-20T21:59:30.000Z", market_request_id: "sip-request"
            }],
            rowCount: 1
          };
        }
        if (statement.includes("INSERT INTO execution_reviews")) {
          persistenceSql = statement;
          persistenceValues = values ?? [];
          reviewOrderIntent = JSON.parse(String(values?.[9])) as Record<string, unknown>;
          return {
            rows: [{
              fence_held: true,
              inserted_count: 1,
              review_count: 1,
              confirmation_count: 1,
              intent_count: 1
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "completed");
  assert.equal(reviewOrderIntent?.side, "buy");
  assert.equal(reviewOrderIntent?.operation, "buy_to_cover");
  assert.match(persistenceSql, /INSERT INTO confirmation_evidence/);
  assert.match(persistenceSql, /INSERT INTO order_intents/);
  assert.match(persistenceSql, /'ready_for_submission'/);
  assert.equal(persistenceValues.includes("buy_to_cover"), true);
  assert.equal(persistenceValues.includes("equity_short"), true);
  assert.equal(persistenceValues.includes("position-short"), true);
  assert.equal(persistenceValues.includes("intent-short-open"), true);
  assert.equal(result.confirmationCreated, true);
});

test("exit review uses the opening allocation key when candidate family differs so the close remains claimable", async () => {
  let reviewOrderIntent: Record<string, unknown> | undefined;
  let persistenceValues: readonly unknown[] = [];
  let sourceSql = "";
  const result = await runPostgresReviewWorkflow({
    command: "paper:exit:review",
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("FROM positions position")) {
          sourceSql = statement;
          return {
            rows: [{
              position_id: "position-long",
              candidate_id: "candidate-long",
              opening_intent_id: "intent-long-open",
              opening_review_id: "review-long-open",
              opening_order_id: "order-long-open",
              opening_strategy_classification: "equity_long",
              opening_authorization_snapshot_id: "snapshot-long-open",
              candidate_strategy_family: "momentum-breakout",
              symbol: "SPY",
              order_symbol: "SPY",
              asset_class: "equity",
              side: "long",
              available_quantity: "2",
              average_entry_price: "500",
              strategy_key: "baseline-v1",
              allocation_id: "allocation-baseline-v1",
              allocation_status: "active",
              allocation_effective_to: null,
              account_id: "account-1",
              account_snapshot_id: "snapshot-1",
              snapshot_fingerprint: "portfolio-fingerprint",
              structural_fingerprint: "structural-fingerprint",
              market_price: "550",
              market_timestamp: "2026-07-20T21:59:30.000Z",
              market_request_id: "sip-request"
            }],
            rowCount: 1
          };
        }
        if (statement.includes("INSERT INTO execution_reviews")) {
          reviewOrderIntent = JSON.parse(String(values?.[9])) as Record<string, unknown>;
          persistenceValues = values ?? [];
          return {
            rows: [{
              fence_held: true,
              review_count: 1,
              confirmation_count: 1,
              intent_count: 1
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "completed");
  assert.equal(reviewOrderIntent?.side, "sell");
  assert.equal(reviewOrderIntent?.operation, "sell_to_close");
  assert.equal(persistenceValues.includes("sell_to_close"), true);
  assert.equal(persistenceValues.includes("equity_long"), true);
  assert.equal(persistenceValues.includes("position-long"), true);
  assert.equal(persistenceValues.includes("intent-long-open"), true);
  assert.equal(persistenceValues.includes("baseline-v1"), true);
  assert.match(sourceSql, /opening_intent\.strategy_key AS strategy_key/);
  assert.match(
    sourceSql,
    /strategy_allocation\.strategy_key = opening_intent\.strategy_key/
  );
  assert.match(sourceSql, /strategy_allocation\.status = 'active'/);
  assert.match(sourceSql, /strategy_allocation\.effective_to IS NULL/);
  assert.match(sourceSql, /allocation\.id AS allocation_id/);
  assert.doesNotMatch(
    sourceSql,
    /COALESCE\(candidate\.strategy_family, allocation\.strategy_key\)/
  );
  assert.equal(result.confirmationCreated, true);
});

test("exit source excludes closing positions and positions with an active close intent", async () => {
  let sourceSql = "";
  const result = await runPostgresReviewWorkflow({
    command: "paper:exit:review",
    query: {
      query: async (statement: string) => {
        if (statement.includes("FROM positions position")) sourceSql = statement;
        return { rows: [], rowCount: 0 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "no_op");
  assert.equal(result.code, "NO_POSTGRES_EXIT_TRIGGER");
  assert.match(sourceSql, /position\.status = 'open'/);
  assert.doesNotMatch(sourceSql, /position\.status IN \('open','closing'\)/);
  assert.match(sourceSql, /close_intent\.parent_position_id = position\.id/);
  assert.match(
    sourceSql,
    /close_intent\.lifecycle_state NOT IN \(\s*'closed','cancelled','rejected','expired','failed_terminal'\s*\)/
  );
});

for (const [label, allocationEvidence] of [
  [
    "missing",
    {
      allocation_id: null,
      allocation_status: null,
      allocation_effective_to: null
    }
  ],
  [
    "inactive",
    {
      allocation_id: "allocation-old",
      allocation_status: "superseded",
      allocation_effective_to: "2026-07-19T22:00:00.000Z"
    }
  ]
] as const) {
  test(`exit review fails closed when the opening strategy allocation is ${label}`, async () => {
    let sourceSql = "";
    await assert.rejects(
      runPostgresReviewWorkflow({
        command: "paper:exit:review",
        query: {
          query: async (statement: string) => {
            if (statement.includes("FROM positions position")) {
              sourceSql = statement;
              return {
                rows: [{
                  position_id: `position-allocation-${label}`,
                  candidate_id: `candidate-allocation-${label}`,
                  opening_intent_id: `intent-allocation-${label}`,
                  opening_review_id: `review-allocation-${label}`,
                  opening_order_id: `order-allocation-${label}`,
                  opening_strategy_classification: "equity_long",
                  opening_authorization_snapshot_id: "snapshot-open",
                  symbol: "SPY",
                  order_symbol: "SPY",
                  asset_class: "equity",
                  side: "long",
                  available_quantity: "1",
                  average_entry_price: "500",
                  strategy_key: "baseline-v1",
                  ...allocationEvidence,
                  account_id: "account-1",
                  account_snapshot_id: "snapshot-1",
                  snapshot_fingerprint: "portfolio-fingerprint",
                  structural_fingerprint: "structural-fingerprint",
                  market_price: "550",
                  market_timestamp: "2026-07-20T21:59:30.000Z",
                  market_request_id: "sip-request"
                }],
                rowCount: 1
              };
            }
            return { rows: [], rowCount: 1 };
          }
        },
        fence,
        signingKey: "test-signing-key-with-sufficient-length",
        now: new Date("2026-07-20T22:00:00.000Z")
      }),
      new RegExp(
        `POSTGRES_EXIT_ALLOCATION_AUTHORITY_MISSING:position-allocation-${label}:baseline-v1`
      )
    );
    assert.match(sourceSql, /LEFT JOIN LATERAL/);
  });
}

test("option exit retains the observed contract, open quantity cap, and immutable opening classification", async () => {
  let reviewOrderIntent: Record<string, unknown> | undefined;
  let reviewMarketEvidence: Array<Record<string, unknown>> = [];
  let persistenceValues: readonly unknown[] = [];
  const symbol = "SPY270720P00500000";
  const result = await runPostgresReviewWorkflow({
    command: "paper:exit:review",
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("FROM positions position")) {
          return {
            rows: [{
              ...observedExitOptionContract(symbol),
              contract_id: `contract-${symbol}`,
              contract_type: "put",
              contract_expiration_date: "2027-07-20",
              position_id: "position-option",
              candidate_id: "candidate-option",
              opening_intent_id: "intent-option-open",
              opening_review_id: "review-option-open",
              opening_order_id: "order-option-open",
              opening_strategy_classification: "leaps_long_put",
              opening_contract_id: `contract-${symbol}`,
              opening_authorization_snapshot_id: "snapshot-option-open",
              symbol: "SPY",
              order_symbol: symbol,
              asset_class: "option",
              side: "long",
              available_quantity: "2",
              average_entry_price: "2.00",
              strategy_key: "standard_option",
              account_id: "account-1",
              account_snapshot_id: "snapshot-1",
              snapshot_fingerprint: "portfolio-fingerprint",
              structural_fingerprint: "structural-fingerprint",
              market_price: "0.90",
              market_timestamp: "2026-07-20T21:59:30.000Z",
              market_request_id: "opra-request",
              market_evidence: {
                bid: 0.90,
                ask: 0.95,
                spreadPct: 0.054,
                underlyingPrice: 555,
                volume: 500,
                openInterest: 800,
                requestedFeed: "opra",
                effectiveFeed: "opra",
                provider: "alpaca"
              }
            }],
            rowCount: 1
          };
        }
        if (statement.includes("INSERT INTO execution_reviews")) {
          reviewOrderIntent = JSON.parse(String(values?.[9])) as Record<string, unknown>;
          reviewMarketEvidence = JSON.parse(
            String(values?.[10])
          ) as Array<Record<string, unknown>>;
          persistenceValues = values ?? [];
          return {
            rows: [{
              fence_held: true,
              review_count: 1,
              confirmation_count: 1,
              intent_count: 1
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "completed");
  assert.equal(reviewOrderIntent?.symbol, symbol);
  assert.equal(reviewOrderIntent?.quantity, 2);
  assert.equal(reviewOrderIntent?.operation, "sell_to_close");
  assert.equal(persistenceValues.includes(`contract-${symbol}`), true);
  assert.equal(persistenceValues.includes("leaps_long_put"), true);
  assert.equal(persistenceValues.includes("intent-option-open"), true);
  assert.equal(reviewMarketEvidence[0]?.underlyingPrice, 555);
  assert.equal(
    (reviewMarketEvidence[0]?.underlyingSip as Record<string, unknown>)
      .source,
    "postgres.stock_snapshots"
  );
});

test("PostgreSQL exit review forces a genuine 0DTE long option exit in the final 30 minutes", async () => {
  let reviewOrderIntent: Record<string, unknown> | undefined;
  let trigger: Record<string, unknown> | undefined;
  const result = await runPostgresReviewWorkflow({
    command: "zero-dte:exit:review",
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("FROM positions position")) {
          return {
            rows: [{
              ...observedExitOptionContract("SPY260720C00555000"),
              opening_strategy_classification: "zero_dte_long_call",
              position_id: "position-0dte", candidate_id: "candidate-0dte",
              symbol: "SPY", order_symbol: "SPY260720C00555000", asset_class: "option",
              side: "long", available_quantity: "1", average_entry_price: "1.00",
              strategy_key: "zero_dte_spy", account_id: "account-1",
              account_snapshot_id: "snapshot-1", snapshot_fingerprint: "portfolio-fingerprint",
              structural_fingerprint: "structural-fingerprint", market_price: "1.00",
              market_timestamp: "2026-07-20T19:44:30.000Z", market_request_id: "opra-request",
              sip_market_timestamp: "2026-07-20T19:44:30.000Z",
              market_evidence: {
                bid: 1,
                ask: 1.02,
                spreadPct: 0.0198,
                underlyingPrice: 555,
                volume: 5_000,
                openInterest: 8_000,
                requestedFeed: "opra",
                effectiveFeed: "opra",
                provider: "alpaca"
              }
            }],
            rowCount: 1
          };
        }
        if (statement.includes("INSERT INTO execution_reviews")) {
          reviewOrderIntent = JSON.parse(String(values?.[9])) as Record<string, unknown>;
          const portfolioPayload = JSON.parse(String(values?.[11])) as Record<string, unknown>;
          trigger = portfolioPayload.trigger as Record<string, unknown> | undefined;
          return { rows: [{ fence_held: true, inserted_count: 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T19:45:00.000Z")
  });

  assert.equal(result.status, "completed");
  assert.equal(reviewOrderIntent?.side, "sell_to_close");
  assert.equal(reviewOrderIntent?.reason, "ODTE_FORCE_EXIT_BEFORE_CLOSE");
  assert.equal(trigger?.reason, "ODTE_FORCE_EXIT_BEFORE_CLOSE");
});

test("PostgreSQL exit review applies the LEAPS full-profit trigger to a long-dated option", async () => {
  let reviewOrderIntent: Record<string, unknown> | undefined;
  let trigger: Record<string, unknown> | undefined;
  const result = await runPostgresReviewWorkflow({
    command: "paper:exit:review",
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("FROM positions position")) {
          return {
            rows: [{
              ...observedExitOptionContract("SPY280121C00550000"),
              opening_strategy_classification: "leaps_long_call",
              position_id: "position-leaps", candidate_id: "candidate-leaps",
              symbol: "SPY", order_symbol: "SPY280121C00550000", asset_class: "option",
              side: "long", available_quantity: "1", average_entry_price: "1.00",
              strategy_key: "leaps", account_id: "account-1",
              account_snapshot_id: "snapshot-1", snapshot_fingerprint: "portfolio-fingerprint",
              structural_fingerprint: "structural-fingerprint", market_price: "2.25",
              market_timestamp: "2026-07-20T21:59:30.000Z", market_request_id: "opra-request",
              market_evidence: {
                bid: 2.25,
                ask: 2.30,
                spreadPct: 0.021978,
                underlyingPrice: 555,
                volume: 5_000,
                openInterest: 8_000,
                requestedFeed: "opra",
                effectiveFeed: "opra",
                provider: "alpaca"
              }
            }],
            rowCount: 1
          };
        }
        if (statement.includes("INSERT INTO execution_reviews")) {
          reviewOrderIntent = JSON.parse(String(values?.[9])) as Record<string, unknown>;
          const portfolioPayload = JSON.parse(String(values?.[11])) as Record<string, unknown>;
          trigger = portfolioPayload.trigger as Record<string, unknown> | undefined;
          return { rows: [{ fence_held: true, inserted_count: 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "completed");
  assert.equal(reviewOrderIntent?.side, "sell_to_close");
  assert.equal(reviewOrderIntent?.reason, "LEAPS_FULL_PROFIT_TAKE");
  assert.equal(trigger?.reason, "LEAPS_FULL_PROFIT_TAKE");
});

test("PostgreSQL exit review applies the maintained LEAPS severe-trend trigger", async () => {
  let reviewOrderIntent: Record<string, unknown> | undefined;
  const result = await runPostgresReviewWorkflow({
    command: "paper:exit:review",
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("FROM positions position")) {
          return {
            rows: [{
              ...observedExitOptionContract("SPY280121C00550000"),
              opening_strategy_classification: "leaps_long_call",
              position_id: "position-leaps-trend",
              candidate_id: "candidate-leaps-trend",
              symbol: "SPY",
              order_symbol: "SPY280121C00550000",
              asset_class: "option",
              side: "long",
              available_quantity: "1",
              average_entry_price: "2.00",
              strategy_key: "leaps",
              account_id: "account-1",
              account_snapshot_id: "snapshot-1",
              snapshot_fingerprint: "portfolio-fingerprint",
              structural_fingerprint: "structural-fingerprint",
              market_price: "2.10",
              market_timestamp: "2026-07-20T21:59:30.000Z",
              market_request_id: "opra-request",
              underlying_close: "500",
              severe_trend_sma: "510",
              severe_trend_bar_count: "200",
              market_evidence: {
                bid: 2.10,
                ask: 2.14,
                spreadPct: 0.018868,
                underlyingPrice: 500,
                volume: 5_000,
                openInterest: 8_000,
                requestedFeed: "opra",
                effectiveFeed: "opra",
                provider: "alpaca"
              }
            }],
            rowCount: 1
          };
        }
        if (statement.includes("INSERT INTO execution_reviews")) {
          reviewOrderIntent = JSON.parse(String(values?.[9])) as Record<string, unknown>;
          return {
            rows: [{ fence_held: true, inserted_count: 1 }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "completed");
  assert.equal(reviewOrderIntent?.reason, "LEAPS_SEVERE_TREND_BREAK");
  assert.equal(reviewOrderIntent?.side, "sell_to_close");
});

test("option exit review rejects an unusable quote before persisting a close intent", async () => {
  const sql: string[] = [];
  await assert.rejects(
    runPostgresReviewWorkflow({
      command: "paper:exit:review",
      query: {
        query: async (statement: string) => {
          sql.push(statement);
          if (statement.includes("FROM positions position")) {
            return {
              rows: [{
                ...observedExitOptionContract("SPY260821P00550000"),
                position_id: "position-option-invalid-exit",
                candidate_id: "candidate-option-invalid-exit",
                symbol: "SPY",
                order_symbol: "SPY260821P00550000",
                asset_class: "option",
                side: "long",
                available_quantity: "1",
                average_entry_price: "2.00",
                strategy_key: "standard_option",
                account_id: "account-1",
                account_snapshot_id: "snapshot-1",
                snapshot_fingerprint: "portfolio-fingerprint",
                structural_fingerprint: "structural-fingerprint",
                market_price: "0.90",
                market_timestamp: "2026-07-20T21:59:30.000Z",
                market_request_id: "opra-request",
                market_evidence: {
                  bid: 1.00,
                  ask: 0.90,
                  spreadPct: 0.05,
                  underlyingPrice: 555,
                  volume: 5_000,
                  openInterest: 8_000,
                  requestedFeed: "opra",
                  effectiveFeed: "opra",
                  provider: "alpaca"
                }
              }],
              rowCount: 1
            };
          }
          return { rows: [], rowCount: 1 };
        }
      },
      fence,
      signingKey: "test-signing-key-with-sufficient-length",
      now: new Date("2026-07-20T22:00:00.000Z")
    }),
    /POSTGRES_EXIT_REVIEW_OPTION_QUOTE_INVALID:SPY260821P00550000/
  );
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO execution_reviews")), false);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO order_intents")), false);
});

test("option exit review preserves the stricter 15-minute executable quote gate", async () => {
  const sql: string[] = [];
  await assert.rejects(
    runPostgresReviewWorkflow({
      command: "paper:exit:review",
      query: {
        query: async (statement: string) => {
          sql.push(statement);
          if (statement.includes("FROM positions position")) {
            return {
              rows: [repeatedExitSource(
                "0.50",
                "2026-07-22T16:44:59.000Z"
              )],
              rowCount: 1
            };
          }
          return { rows: [], rowCount: 1 };
        }
      },
      fence,
      signingKey: "test-signing-key-with-sufficient-length",
      maxMarketAgeSeconds: 1_800,
      now: new Date("2026-07-22T17:00:00.000Z")
    }),
    /POSTGRES_REVIEW_MARKET_EVIDENCE_STALE:SPY/
  );
  assert.equal(
    sql.some((statement) => statement.includes("INSERT INTO execution_reviews")),
    false
  );
});

for (const [label, sipOverride, expected] of [
  [
    "missing SIP underlying evidence",
    {
      sip_market_price: null,
      sip_market_timestamp: null,
      sip_requested_feed: null,
      sip_effective_feed: null,
      sip_provider: null
    },
    /POSTGRES_EXIT_REVIEW_OPTION_UNDERLYING_SIP_INVALID:SPY260722P00748000/
  ],
  [
    "stale SIP underlying evidence",
    { sip_market_timestamp: "2026-07-22T16:29:59.000Z" },
    /POSTGRES_EXIT_REVIEW_OPTION_UNDERLYING_SIP_STALE:SPY260722P00748000/
  ]
] as const) {
  test(`option exit rejects ${label} even when OPRA is fresh`, async () => {
    const sql: string[] = [];
    await assert.rejects(
      runPostgresReviewWorkflow({
        command: "paper:exit:review",
        query: {
          query: async (statement: string) => {
            sql.push(statement);
            if (statement.includes("FROM positions position")) {
              return {
                rows: [{
                  ...repeatedExitSource(
                    "0.50",
                    "2026-07-22T16:59:30.000Z"
                  ),
                  ...sipOverride
                }],
                rowCount: 1
              };
            }
            return { rows: [], rowCount: 1 };
          }
        },
        fence,
        signingKey: "test-signing-key-with-sufficient-length",
        maxMarketAgeSeconds: 1_800,
        now: new Date("2026-07-22T17:00:00.000Z")
      }),
      expected
    );
    assert.equal(
      sql.some((statement) => statement.includes("INSERT INTO execution_reviews")),
      false
    );
  });
}

const repeatedExitSource = (marketPrice: string, marketTimestamp: string) => ({
  position_id: "position-repeated-exit", candidate_id: null,
  symbol: "SPY", order_symbol: "SPY260722P00748000", asset_class: "option",
  side: "long", available_quantity: "1", average_entry_price: "1.15",
  strategy_key: "baseline", account_id: "account-repeated-exit",
  account_snapshot_id: "snapshot-repeated-exit", snapshot_fingerprint: "portfolio-fingerprint",
  structural_fingerprint: "structural-fingerprint", market_price: marketPrice,
  market_timestamp: marketTimestamp, market_request_id: "opra-request",
  ...observedExitOptionContract("SPY260722P00748000"),
  sip_market_timestamp: marketTimestamp,
  market_evidence: {
    bid: Number(marketPrice),
    ask: Number(marketPrice) + 0.02,
    spreadPct: 0.04,
    underlyingPrice: 555,
    volume: 5_000,
    openInterest: 8_000,
    requestedFeed: "opra",
    effectiveFeed: "opra",
    provider: "alpaca"
  }
});

test("option exit review rejects non-Alpaca or unobserved contract evidence before persistence", async () => {
  const sql: string[] = [];
  await assert.rejects(
    runPostgresReviewWorkflow({
      command: "paper:exit:review",
      query: {
        query: async (statement: string) => {
          sql.push(statement);
          if (statement.includes("FROM positions position")) {
            return {
              rows: [{
                ...repeatedExitSource(
                  "0.50",
                  "2026-07-22T16:50:00.000Z"
                ),
                contract_source: "synthetic",
                market_evidence: {
                  ...repeatedExitSource(
                    "0.50",
                    "2026-07-22T16:50:00.000Z"
                  ).market_evidence,
                  provider: "synthetic"
                }
              }],
              rowCount: 1
            };
          }
          return { rows: [], rowCount: 1 };
        }
      },
      fence,
      signingKey: "test-signing-key-with-sufficient-length",
      now: new Date("2026-07-22T16:51:00.000Z")
    }),
    /POSTGRES_EXIT_REVIEW_OPTION_(QUOTE|CONTRACT)_INVALID/
  );
  assert.equal(
    sql.some((statement) => statement.includes("INSERT INTO execution_reviews")),
    false
  );
  assert.equal(
    sql.some((statement) => statement.includes("INSERT INTO order_intents")),
    false
  );
});

test("repeated exit evidence for one position and account snapshot is an idempotent row-level skip", async () => {
  let sourceReads = 0;
  let reviewInserts = 0;
  let intentInserts = 0;
  const query = {
    query: async (statement: string) => {
      if (statement.includes("FROM positions position")) {
        sourceReads += 1;
        return {
          rows: [sourceReads === 1
            ? repeatedExitSource("0.50", "2026-07-22T16:50:00.000Z")
            : repeatedExitSource("0.45", "2026-07-22T16:55:00.000Z")],
          rowCount: 1
        };
      }
      if (statement.includes("INSERT INTO execution_reviews")) {
        reviewInserts += 1;
        if (reviewInserts === 1 && statement.includes("INSERT INTO order_intents")) {
          intentInserts += 1;
        }
        if (reviewInserts === 2) {
          if (!/ON CONFLICT \(account_id, client_order_id\)[\s\S]*DO NOTHING/.test(statement)) {
            const error = new Error(
              'duplicate key value violates unique constraint "execution_reviews_client_order_idx"'
            ) as Error & { code: string };
            error.code = "23505";
            throw error;
          }
          return { rows: [{ fence_held: true, inserted_count: 0 }], rowCount: 1 };
        }
        return { rows: [{ fence_held: true, inserted_count: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  };

  const first = await runPostgresReviewWorkflow({
    command: "paper:exit:review", query, fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-22T16:51:00.000Z")
  });
  const second = await runPostgresReviewWorkflow({
    command: "paper:exit:review", query, fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-22T16:56:00.000Z")
  });

  assert.equal(first.reviewsCreated, 1);
  assert.equal(first.pendingIntentsCreated, 1);
  assert.equal(second.status, "completed");
  assert.equal(second.reviewsCreated, 0);
  assert.equal(second.pendingIntentsCreated, 0);
  assert.equal(second.skipped, 1);
  assert.equal(reviewInserts, 2);
  assert.equal(intentInserts, 1);
});

test("exit review fails closed when the scheduler fence is not held at insert time", async () => {
  let intentInserts = 0;
  await assert.rejects(
    runPostgresReviewWorkflow({
      command: "paper:exit:review",
      query: {
        query: async (statement: string) => {
          if (statement.includes("FROM positions position")) {
            return {
              rows: [repeatedExitSource("0.45", "2026-07-22T16:55:00.000Z")],
              rowCount: 1
            };
          }
          if (statement.includes("INSERT INTO execution_reviews")) {
            if (!statement.includes("inserted_review")) return { rows: [], rowCount: 0 };
            return { rows: [{ fence_held: false, inserted_count: 0 }], rowCount: 1 };
          }
          if (statement.includes("INSERT INTO order_intents")) intentInserts += 1;
          return { rows: [], rowCount: 0 };
        }
      },
      fence,
      signingKey: "test-signing-key-with-sufficient-length",
      now: new Date("2026-07-22T16:56:00.000Z")
    }),
    /SCHEDULER_FENCE_LOST/
  );
  assert.equal(intentInserts, 0);
});

test("real PostgreSQL preserves one exit review and intent across changing market evidence", {
  skip: process.env.POSTGRES_INTEGRATION_TEST_ENABLED !== "true"
}, async () => {
  const config = loadDatabaseConfig(
    {
      ...process.env,
      DATABASE_BACKEND: "postgres",
      POSTGRES_APPLICATION_NAME: "alpaca-exit-review-integration-test"
    },
    { runtime: "test", purpose: "migration" }
  );
  const schema = `exit_review_test_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const adminPool = createPostgresPool(config, "direct");
  let schemaPool: Pool | undefined;
  const integrationFence = {
    jobName: "exit-review", workstream: "exit_review",
    ownerId: "integration-owner", runId: "integration-run", fencingToken: "91"
  };
  let sourceReads = 0;

  try {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    schemaPool = createPostgresPool(config, "direct", {
      sessionOptions: `-c search_path=${schema}`
    });
    await runPostgresMigrations(schemaPool, config);
    const now = new Date();
    const schedulerExpiry = new Date(now.getTime() + 60 * 60_000).toISOString();
    await schemaPool.query(
      `INSERT INTO accounts(id, broker_account_id, environment, status, created_at, updated_at)
       VALUES ('account-repeated-exit', 'broker-repeated-exit', 'paper', 'active', $1, $1)`,
      [now.toISOString()]
    );
    await schemaPool.query(
      `INSERT INTO scheduler_leases(
         job_name, workstream, owner_id, run_id, fencing_token, status,
         acquired_at, heartbeat_at, expires_at, created_at, updated_at
       ) VALUES (
         'exit-review', 'exit_review', 'integration-owner', 'integration-run', 91,
         'held', $1, $1, $2, $1, $1
       )`,
      [now.toISOString(), schedulerExpiry]
    );

    const query = {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("FROM positions position")) {
          sourceReads += 1;
          return {
            rows: [sourceReads === 1
              ? repeatedExitSource("0.50", new Date(now.getTime() - 60_000).toISOString())
              : repeatedExitSource("0.45", new Date(now.getTime() - 30_000).toISOString())],
            rowCount: 1
          };
        }
        return schemaPool!.query(statement, values ? [...values] : []);
      }
    };

    const first = await runPostgresReviewWorkflow({
      command: "paper:exit:review", query, fence: integrationFence,
      signingKey: "test-signing-key-with-sufficient-length", now
    });
    const second = await runPostgresReviewWorkflow({
      command: "paper:exit:review", query, fence: integrationFence,
      signingKey: "test-signing-key-with-sufficient-length",
      now: new Date(now.getTime() + 30_000)
    });
    const counts = await schemaPool.query(
      `SELECT
         (SELECT COUNT(*)::integer FROM execution_reviews) AS review_count,
         (SELECT COUNT(*)::integer FROM order_intents) AS intent_count`
    );

    assert.equal(first.reviewsCreated, 1);
    assert.equal(first.pendingIntentsCreated, 1);
    assert.equal(second.status, "completed");
    assert.equal(second.reviewsCreated, 0);
    assert.equal(second.pendingIntentsCreated, 0);
    assert.equal(second.skipped, 1);
    assert.deepEqual(counts.rows[0], { review_count: 1, intent_count: 1 });
  } finally {
    await schemaPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  }
});

test("0DTE discovery scopes PostgreSQL candidates to the requested underlying and expiry", async () => {
  let sourceSql = "";
  let sourceValues: readonly unknown[] = [];
  const result = await runPostgresReviewWorkflow({
    command: "paper:options:discover",
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("FROM candidates candidate")) {
          sourceSql = statement;
          sourceValues = values ?? [];
        }
        return { rows: [], rowCount: 0 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    underlying: "SPY",
    dte: 0,
    now: new Date("2026-07-20T18:00:00.000Z")
  });
  assert.equal(result.status, "no_op");
  assert.match(sourceSql, /JOIN option_contracts/);
  assert.match(sourceSql, /contract\.expiration_date/);
  assert.deepEqual(sourceValues, ["SPY", "2026-07-20T18:00:00.000Z", 0]);
});
