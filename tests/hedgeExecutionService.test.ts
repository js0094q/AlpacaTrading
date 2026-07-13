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

import { closeDbForTests } from "../src/lib/db.js";
import { createHedgeExecutionReview } from "../src/services/hedgeExecutionReviewService.js";
import type { AlpacaPaperOrderRequest } from "../src/services/alpacaClient.js";
import {
  executeReviewedPaperHedge,
  paperAccountIdentityHash
} from "../src/services/hedgeExecutionService.js";
import { persistHedgeExecutionReview } from "../src/services/hedgePersistenceService.js";

const account = {
  id: "paper-account-1",
  status: "ACTIVE",
  equity: "100000",
  buying_power: "10000",
  options_approved_level: 3
};

const makeReview = (suffix: string) => {
  const accountHash = paperAccountIdentityHash(account);
  const review = createHedgeExecutionReview({
    accountHash,
    sourceRecommendationId: `recommendation-${suffix}`,
    sourceSnapshotId: `snapshot-${suffix}`,
    sourceRegimeId: `regime-${suffix}`,
    riskModelVersion: "portfolio-risk-v1",
    regimeModelVersion: "market-regime-v1",
    configurationFingerprint: "config_hash",
    generatedAt: "2026-07-13T14:00:00.000Z",
    signingKey: "execution-test-key",
    candidate: {
      candidateId: `candidate-${suffix}`,
      rank: 1,
      instrumentType: "protective_put",
      symbol: "SPY260918P00500000",
      underlying: "SPY",
      executable: true,
      expectedProtection: 1_000,
      estimatedCost: 500,
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
  assert.equal(result.status, "canceled");
  assert.ok(pollCount >= 1);
  assert.ok(replaceCount <= 2);
  assert.equal(cancelCount, 1);
});

after(() => closeDbForTests());
