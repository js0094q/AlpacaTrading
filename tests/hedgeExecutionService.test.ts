import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test } from "node:test";

process.env.RESEARCH_DB_PATH = join(mkdtempSync(join(tmpdir(), "hedge-execution-")), "research.db");
process.env.ALPACA_ENV = "paper";
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
process.env.HEDGE_PAPER_EXECUTION_ENABLED = "true";
process.env.HEDGE_LIVE_EXECUTION_ENABLED = "false";
process.env.MULTI_LEG_HEDGE_EXECUTION_ENABLED = "false";
process.env.HEDGE_REVIEW_SIGNING_KEY = "execution-test-key";

import { closeDbForTests, getDb } from "../src/lib/db.js";
import {
  buildHedgeConfig,
  hedgeConfigurationFingerprint
} from "../src/services/hedgeConfigService.js";
import {
  buildHedgeCapitalEvidence,
  type HedgeCapitalEvidence,
  type HedgeCapitalOrderInput
} from "../src/services/hedgeCapitalEvidenceService.js";
import { createHedgeExecutionReview } from "../src/services/hedgeExecutionReviewService.js";
import type {
  AlpacaPaperOrderRequest,
  AlpacaPositionRaw
} from "../src/services/alpacaClient.js";
import {
  executeReviewedPaperHedge,
  paperAccountIdentityHash
} from "../src/services/hedgeExecutionService.js";
import { persistHedgeExecutionReview } from "../src/services/hedgePersistenceService.js";
import {
  insertPaperExecutionLedgerEntry,
  updatePaperExecutionLedgerEntry
} from "../src/services/paperExecutionLedgerService.js";

const account = {
  id: "paper-account-1",
  status: "ACTIVE",
  equity: "100000",
  buying_power: "10000",
  options_approved_level: 3
};

const capitalEvidence = (input: {
  positions?: AlpacaPositionRaw[];
  orders?: HedgeCapitalOrderInput[];
} = {}) => buildHedgeCapitalEvidence({
  asOf: "2026-07-13T14:00:00.000Z",
  allowedUnderlyings: ["SPY", "QQQ"],
  positions: input.positions ?? [],
  orders: input.orders ?? [],
  ledger: []
});

const makeReview = (
  suffix: string,
  options: {
    capitalEvidence?: HedgeCapitalEvidence;
    estimatedCost?: number;
  } = {}
) => {
  const accountHash = paperAccountIdentityHash(account);
  const review = createHedgeExecutionReview({
    accountHash,
    sourceRecommendationId: `recommendation-${suffix}`,
    sourceSnapshotId: `snapshot-${suffix}`,
    sourceRegimeId: `regime-${suffix}`,
    riskModelVersion: "portfolio-risk-v1",
    regimeModelVersion: "market-regime-v1",
    configurationFingerprint: hedgeConfigurationFingerprint(buildHedgeConfig()),
    generatedAt: "2026-07-13T14:00:00.000Z",
    signingKey: "execution-test-key",
    capitalEvidence: options.capitalEvidence ?? capitalEvidence(),
    candidate: {
      candidateId: `candidate-${suffix}`,
      rank: 1,
      instrumentType: "protective_put",
      symbol: "SPY260918P00500000",
      underlying: "SPY",
      executable: true,
      expectedProtection: 1_000,
      estimatedCost: options.estimatedCost ?? 500,
      units: 1,
      rationale: [],
      warnings: [],
      blockers: [],
      details: {
        midpoint: 5,
        bid: 4.9,
        ask: 5.1,
        delta: -0.32,
        daysToExpiration: 67,
        quoteTimestamp: "2026-07-13T13:59:45.000Z",
        multiplier: 100,
        contractDeltaCoveragePct: 1,
        marketValueDeltaCoveragePct: 1
      }
    }
  });
  persistHedgeExecutionReview(review);
  return review;
};

const deps = (overrides: Record<string, unknown> = {}) => ({
  getAccount: async () => ({ data: account, requestId: "account-request", status: 200, url: "paper" }),
  listPositions: async () => ({ positions: [], requestId: "positions-request" }),
  listOrders: async () => ({ orders: [], requestId: "orders-request" }),
  listLedger: () => [],
  refreshQuote: async () => ({
    bid: 4.9,
    ask: 5.1,
    midpoint: 5,
    delta: -0.32,
    quoteTimestamp: "2026-07-13T13:59:55.000Z"
  }),
  submitPaperOrder: async (payload: AlpacaPaperOrderRequest) => ({
    data: {
      id: "broker-order-1",
      client_order_id: payload.client_order_id as string,
      symbol: payload.symbol as string,
      status: "accepted"
    },
    requestId: "submit-request",
    status: 200,
    url: "paper"
  }),
  getPaperOrder: async () => ({
    data: {
      id: "broker-order-1",
      symbol: "SPY260918P00500000",
      status: "filled",
      filled_qty: "1",
      filled_avg_price: "5.01"
    },
    requestId: "order-request",
    status: 200,
    url: "paper"
  }),
  replacePaperOrder: async () => { throw new Error("replace should not be called after fill"); },
  cancelPaperOrder: async () => { throw new Error("cancel should not be called after fill"); },
  now: () => "2026-07-13T14:00:01.000Z",
  sleep: async () => undefined,
  ...overrides
});

test("executes one bounded paper long put with no multi-leg payload", async () => {
  const review = makeReview("success");
  const submitted: AlpacaPaperOrderRequest[] = [];
  const result = await executeReviewedPaperHedge(
    { reviewId: review.reviewId, confirmPaper: true },
    deps({ submitPaperOrder: async (payload: AlpacaPaperOrderRequest) => {
      submitted.push(payload);
      return {
        data: { id: "broker-order-1", client_order_id: payload.client_order_id as string, symbol: payload.symbol as string, status: "accepted" },
        requestId: "submit-request",
        status: 200,
        url: "paper"
      };
    }})
  );

  assert.equal(result.status, "filled");
  assert.equal(result.paperOnly, true);
  assert.equal(result.brokerOrderId, "broker-order-1");
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]?.position_intent, "buy_to_open");
  assert.equal("legs" in submitted[0]!, false);
  assert.equal("order_class" in submitted[0]!, false);
});

test("does not call the broker when paper/live gates are unsafe", async () => {
  const review = makeReview("blocked");
  process.env.HEDGE_PAPER_EXECUTION_ENABLED = "false";
  let brokerCalls = 0;
  const result = await executeReviewedPaperHedge(
    { reviewId: review.reviewId, confirmPaper: true },
    deps({
      getAccount: async () => { brokerCalls += 1; return { data: account, status: 200, url: "paper" }; },
      submitPaperOrder: async () => { brokerCalls += 1; throw new Error("must not submit"); }
    })
  );
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.includes("HEDGE_EXECUTION_DISABLED"));
  assert.equal(brokerCalls, 0);
  process.env.HEDGE_PAPER_EXECUTION_ENABLED = "true";
});

test("a consumed signed hedge review cannot be replayed", async () => {
  const review = makeReview("consumed-replay");
  getDb().prepare(
    "UPDATE hedge_execution_reviews SET status = 'consumed' WHERE review_id = ?"
  ).run(review.reviewId);
  let brokerCalls = 0;
  const result = await executeReviewedPaperHedge(
    { reviewId: review.reviewId, confirmPaper: true },
    deps({
      getAccount: async () => {
        brokerCalls += 1;
        return { data: account, status: 200, url: "paper" };
      },
      submitPaperOrder: async () => {
        brokerCalls += 1;
        throw new Error("must not replay a consumed review");
      }
    })
  );

  assert.equal(result.status, "blocked");
  assert.equal(brokerCalls, 0);
  assert.ok(result.blockers.includes("HEDGE_REVIEW_ALREADY_CONSUMED"));
});

test("capital evidence drift or incompleteness requires a fresh review and submits zero", async () => {
  const completePosition: AlpacaPositionRaw = {
    symbol: "QQQ260918P00400000",
    asset_class: "us_option",
    qty: "1",
    market_value: "400",
    cost_basis: "350"
  };
  const driftReview = makeReview("capital-drift");
  let submitCalls = 0;
  const driftResult = await executeReviewedPaperHedge(
    { reviewId: driftReview.reviewId, confirmPaper: true },
    deps({
      listPositions: async () => ({ positions: [completePosition] }),
      submitPaperOrder: async () => {
        submitCalls += 1;
        throw new Error("must not submit on capital evidence drift");
      }
    })
  );
  assert.equal(driftResult.status, "blocked");
  assert.ok(driftResult.blockers.includes("HEDGE_CAPITAL_EVIDENCE_CHANGED"));
  assert.ok(driftResult.blockers.includes("FRESH_REVIEW_REQUIRED"));

  const incompleteReview = makeReview("capital-incomplete");
  const incompleteResult = await executeReviewedPaperHedge(
    { reviewId: incompleteReview.reviewId, confirmPaper: true },
    deps({
      listPositions: async () => ({
        positions: [{
          symbol: "QQQ260918P00400000",
          asset_class: "us_option",
          qty: "1"
        }]
      }),
      submitPaperOrder: async () => {
        submitCalls += 1;
        throw new Error("must not submit on incomplete capital evidence");
      }
    })
  );
  assert.equal(incompleteResult.status, "blocked");
  assert.ok(incompleteResult.blockers.includes("HEDGE_CAPITAL_EVIDENCE_INCOMPLETE"));
  assert.ok(incompleteResult.blockers.includes("FRESH_REVIEW_REQUIRED"));
  assert.equal(submitCalls, 0);
});

test("fresh hedge quote drift blocks without inline repricing or submission", async () => {
  const review = makeReview("quote-drift");
  let submitCalls = 0;
  const result = await executeReviewedPaperHedge(
    { reviewId: review.reviewId, confirmPaper: true },
    deps({
      refreshQuote: async () => ({
        bid: 5.9,
        ask: 6.1,
        midpoint: 6,
        delta: -0.32,
        quoteTimestamp: "2026-07-13T13:59:55.000Z"
      }),
      submitPaperOrder: async () => {
        submitCalls += 1;
        throw new Error("must not submit after hedge price drift");
      }
    })
  );

  assert.equal(result.status, "blocked");
  assert.equal(submitCalls, 0);
  assert.ok(result.blockers.includes("HEDGE_PRICE_DRIFT"));
  assert.ok(result.blockers.includes("FRESH_REVIEW_REQUIRED"));
});

test("hedge reservation atomically rejects a distinct reservation that fills before the guard", async () => {
  const review = makeReview("shared-cap-race");
  let submitCalls = 0;
  const result = await executeReviewedPaperHedge(
    { reviewId: review.reviewId, confirmPaper: true },
    deps({
      refreshQuote: async () => {
        const concurrent = insertPaperExecutionLedgerEntry({
          mode: "hedge-entry",
          assetClass: "option",
          symbol: "QQQ260918P00450000",
          underlyingSymbol: "QQQ",
          strategy: "portfolio_hedge",
          side: "buy",
          orderType: "limit",
          timeInForce: "day",
          qty: "1",
          limitPrice: "16",
          estimatedPremium: 1_600,
          maxRisk: 1_600,
          dedupeKey: "hedge-shared-cap-race-other",
          clientOrderId: "hedge-shared-cap-race-other",
          status: "reserved",
          sourcePlanId: "other-hedge-review",
          payload: { expiresAt: "2026-07-13T14:05:00.000Z" }
        });
        updatePaperExecutionLedgerEntry(concurrent.id, {
          status: "filled",
          alpacaOrderId: "hedge-shared-cap-race-order",
          alpacaStatus: "filled"
        });
        return {
          bid: 4.9,
          ask: 5.1,
          midpoint: 5,
          delta: -0.32,
          quoteTimestamp: "2026-07-13T13:59:55.000Z"
        };
      },
      submitPaperOrder: async () => {
        submitCalls += 1;
        throw new Error("must not submit after a concurrent hedge reservation");
      }
    })
  );

  getDb().prepare(
    "DELETE FROM paper_execution_ledger WHERE client_order_id = 'hedge-shared-cap-race-other'"
  ).run();
  assert.equal(result.status, "blocked");
  assert.equal(submitCalls, 0);
  assert.ok(result.blockers.includes("HEDGE_RESERVATION_STATE_DRIFT"));
  assert.ok(result.blockers.includes("FRESH_REVIEW_REQUIRED"));
});

test("reapplies new, total, daily, and open-order hedge caps before reservation", async () => {
  const totalCapPositions: AlpacaPositionRaw[] = [{
    symbol: "QQQ260918P00400000",
    asset_class: "us_option",
    qty: "1",
    market_value: "1600",
    cost_basis: "1600"
  }];
  const dailyCapOrders: HedgeCapitalOrderInput[] = [{
    id: "daily-filled-order",
    client_order_id: "daily-filled-client",
    symbol: "QQQ260918P00400000",
    asset_class: "us_option",
    side: "buy",
    position_intent: "buy_to_open",
    status: "filled",
    qty: "1",
    limit_price: "6",
    filled_qty: "1",
    filled_avg_price: "6",
    created_at: "2026-07-13T13:50:00.000Z",
    filled_at: "2026-07-13T13:51:00.000Z"
  }];
  const openCapOrders: HedgeCapitalOrderInput[] = [{
    id: "open-order",
    client_order_id: "open-client",
    symbol: "QQQ260918P00400000",
    asset_class: "us_option",
    side: "buy",
    position_intent: "buy_to_open",
    status: "accepted",
    qty: "1",
    limit_price: "2",
    filled_qty: "0",
    created_at: "2026-07-13T13:50:00.000Z"
  }];
  const scenarios = [
    {
      suffix: "new-cap",
      evidence: capitalEvidence(),
      estimatedCost: 800,
      positions: [] as AlpacaPositionRaw[],
      orders: [] as HedgeCapitalOrderInput[],
      blocker: "HEDGE_PREMIUM_CAP_EXCEEDED"
    },
    {
      suffix: "total-cap",
      evidence: capitalEvidence({ positions: totalCapPositions }),
      estimatedCost: 500,
      positions: totalCapPositions,
      orders: [] as HedgeCapitalOrderInput[],
      blocker: "HEDGE_TOTAL_PREMIUM_CAP_EXCEEDED"
    },
    {
      suffix: "daily-cap",
      evidence: capitalEvidence({ orders: dailyCapOrders }),
      estimatedCost: 500,
      positions: [] as AlpacaPositionRaw[],
      orders: dailyCapOrders,
      blocker: "HEDGE_DAILY_PREMIUM_CAP_EXCEEDED"
    },
    {
      suffix: "open-cap",
      evidence: capitalEvidence({ orders: openCapOrders }),
      estimatedCost: 500,
      positions: [] as AlpacaPositionRaw[],
      orders: openCapOrders,
      blocker: "HEDGE_OPEN_ORDER_CAP_REACHED"
    }
  ];
  let submitCalls = 0;
  for (const scenario of scenarios) {
    const review = makeReview(scenario.suffix, {
      capitalEvidence: scenario.evidence,
      estimatedCost: scenario.estimatedCost
    });
    const result = await executeReviewedPaperHedge(
      { reviewId: review.reviewId, confirmPaper: true },
      deps({
        listPositions: async () => ({ positions: scenario.positions }),
        listOrders: async () => ({ orders: scenario.orders }),
        submitPaperOrder: async () => {
          submitCalls += 1;
          throw new Error("must not submit when a hedge cap is exceeded");
        }
      })
    );
    assert.equal(result.status, "blocked", scenario.suffix);
    assert.ok(result.blockers.includes(scenario.blocker), scenario.suffix);
  }
  assert.equal(submitCalls, 0);
});

test("retries only the reserved order and cancels after bounded timeout", async () => {
  const review = makeReview("timeout");
  let pollCount = 0;
  let replaceCount = 0;
  let cancelCount = 0;
  const result = await executeReviewedPaperHedge(
    { reviewId: review.reviewId, confirmPaper: true },
    deps({
      getPaperOrder: async () => {
        pollCount += 1;
        return { data: { id: "broker-order-1", symbol: review.orderIntent.symbol, status: "accepted", filled_qty: "0" }, status: 200, url: "paper" };
      },
      replacePaperOrder: async () => {
        replaceCount += 1;
        return { data: { id: "broker-order-1", symbol: review.orderIntent.symbol, status: "accepted" }, status: 200, url: "paper" };
      },
      cancelPaperOrder: async () => {
        cancelCount += 1;
        return { data: null, status: 204, url: "paper" };
      },
      maxRepriceAttempts: 2
    })
  );
  assert.equal(result.status, "canceled", result.blockers.join(","));
  assert.ok(pollCount >= 1);
  assert.ok(replaceCount <= 2);
  assert.equal(cancelCount, 1);
});

after(() => closeDbForTests());
