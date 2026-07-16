import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

process.env.RESEARCH_DB_PATH = join(mkdtempSync(join(tmpdir(), "hedge-exit-")), "research.db");
process.env.ALPACA_ENV = "paper";
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
process.env.HEDGE_PAPER_EXECUTION_ENABLED = "true";
process.env.HEDGE_EXIT_MANAGEMENT_ENABLED = "true";
process.env.HEDGE_LIVE_EXECUTION_ENABLED = "false";
process.env.HEDGE_REVIEW_SIGNING_KEY = "exit-test-key";

import {
  buildHedgeExitReview,
  evaluateHedgeExitPolicy,
  executeReviewedPaperHedgeExit
} from "../src/services/hedgeExitService.js";
import { getDb } from "../src/lib/db.js";
import {
  insertPaperExecutionLedgerEntry,
  type PaperExecutionLedgerEntry
} from "../src/services/paperExecutionLedgerService.js";
import { withExecutionAuthority } from "./helpers/executionAuthorityRuntime.js";

const basePosition = () => ({
  symbol: "SPY260918P00500000",
  underlying: "SPY",
  quantity: 1,
  entryPrice: 5,
  currentPrice: 5,
  expirationDate: "2026-09-18",
  entryAt: "2026-07-13T13:00:00.000Z",
  asOf: "2026-07-13T14:00:00.000Z",
  bid: 4.9,
  ask: 5.1,
  delta: -0.32,
  accountHash: "account-hash",
  sourceRecommendationId: "recommendation-1",
  sourceSnapshotId: "snapshot-1",
  sourceRegimeId: "regime-1",
  riskModelVersion: "portfolio-risk-v1",
  regimeModelVersion: "market-regime-v1",
  configurationFingerprint: "config-hash"
});

test("builds paper-only exits for profit, loss, DTE, stale thesis, and normalized risk", () => {
  const profit = evaluateHedgeExitPolicy({ ...basePosition(), currentPrice: 7.5 });
  assert.equal(profit.shouldExit, true);
  assert.ok(profit.reasons.includes("HEDGE_PROFIT_TARGET"));

  const loss = evaluateHedgeExitPolicy({ ...basePosition(), currentPrice: 2.5 });
  assert.ok(loss.reasons.includes("HEDGE_LOSS_CONTAINMENT"));

  const dte = evaluateHedgeExitPolicy({ ...basePosition(), expirationDate: "2026-07-20" });
  assert.ok(dte.reasons.includes("HEDGE_TIME_TO_EXPIRATION"));

  const stale = evaluateHedgeExitPolicy({ ...basePosition(), staleThesis: true });
  assert.ok(stale.reasons.includes("HEDGE_STALE_THESIS"));

  const normalized = evaluateHedgeExitPolicy({ ...basePosition(), riskNormalizationObservations: 2 });
  assert.ok(normalized.reasons.includes("HEDGE_PORTFOLIO_RISK_NORMALIZED"));
  assert.equal(normalized.riskNormalizationConfirmations, 2);
});

test("does not create an immediate post-entry exit and builds sell-to-close review", () => {
  const immediate = evaluateHedgeExitPolicy({
    ...basePosition(),
    asOf: "2026-07-13T13:05:00.000Z"
  });
  assert.equal(immediate.shouldExit, false);
  assert.ok(immediate.warnings.includes("HEDGE_EXIT_MIN_HOLD_NOT_REACHED"));

  const input = { ...basePosition(), currentPrice: 7.5 };
  const built = buildHedgeExitReview({ ...input, signingKey: "exit-test-key" });
  assert.equal(built.status, "reviewed");
  assert.equal(built.review?.reviewType, "exit");
  assert.equal(built.review?.orderIntent.side, "sell_to_close");
  assert.equal(built.review?.orderIntent.quantity, 1);
});

test("executes only the current paper hedge quantity for a sell-to-close exit", async () => {
  const input = { ...basePosition(), currentPrice: 7.5 };
  const built = buildHedgeExitReview({ ...input, signingKey: "exit-test-key" });
  assert.ok(built.review);
  let submitted: Record<string, unknown> | null = null;
  const result = await executeReviewedPaperHedgeExit(
    { reviewId: built.review.reviewId, confirmPaper: true },
    {
      review: built.review,
      getAccount: async () => ({ data: { id: "paper-account", status: "ACTIVE", buying_power: "10000", equity: "100000", options_approved_level: 3 }, status: 200, url: "paper" }),
      listPositions: async () => ({ data: [{ symbol: input.symbol, qty: "1" }], status: 200, url: "paper" }),
      now: () => input.asOf,
      refreshQuote: async () => ({ bid: 7.4, ask: 7.6, midpoint: 7.5, quoteTimestamp: input.asOf }),
      submitPaperOrder: async (payload) => {
        submitted = payload;
        return { data: { id: "exit-order-1", status: "accepted" }, requestId: "exit-request", status: 200, url: "paper" };
      },
      getPaperOrder: async () => ({ data: { id: "exit-order-1", status: "filled", filled_qty: "1", filled_avg_price: "7.45" }, status: 200, url: "paper" }),
      cancelPaperOrder: async () => ({ data: null, status: 204, url: "paper" })
    }
  );
  assert.equal(result.status, "filled");
  const submittedPayload = submitted as Record<string, unknown> | null;
  assert.equal(submittedPayload?.side, "sell");
  assert.equal(submittedPayload?.position_intent, "sell_to_close");
  assert.equal(submittedPayload?.qty, "1");
});

test("PostgreSQL execution authority bypasses the SQLite hedge-exit reservation", async () => {
  const input = {
    ...basePosition(),
    currentPrice: 7.5,
    asOf: "2026-07-13T14:01:00.000Z",
    sourceRecommendationId: "recommendation-postgres-exit",
    sourceSnapshotId: "snapshot-postgres-exit"
  };
  const built = buildHedgeExitReview({ ...input, signingKey: "exit-test-key" });
  assert.ok(built.review);
  const recordedStatuses: string[] = [];
  const result = await withExecutionAuthority(() =>
    executeReviewedPaperHedgeExit(
      { reviewId: built.review!.reviewId, confirmPaper: true },
      {
        review: built.review!,
        getAccount: async () => ({
          data: {
            id: "paper-account",
            status: "ACTIVE",
            buying_power: "10000",
            equity: "100000",
            options_approved_level: 3
          },
          status: 200,
          url: "paper"
        }),
        listPositions: async () => ({
          data: [{ symbol: input.symbol, qty: "1" }],
          status: 200,
          url: "paper"
        }),
        now: () => input.asOf,
        refreshQuote: async () => {
          insertPaperExecutionLedgerEntry({
            mode: "hedge-exit",
            assetClass: "option",
            symbol: input.symbol,
            underlyingSymbol: input.underlying,
            strategy: "portfolio_hedge",
            side: "sell",
            orderType: "limit",
            timeInForce: "day",
            qty: "1",
            limitPrice: "7.4",
            estimatedPremium: 740,
            maxRisk: 740,
            dedupeKey: "sqlite-only-hedge-exit",
            clientOrderId: "sqlite-only-hedge-exit",
            status: "reserved",
            sourcePlanId: "sqlite-only-hedge-exit-review",
            payload: { expiresAt: "2026-07-13T14:05:00.000Z" }
          });
          return {
            bid: 7.4,
            ask: 7.6,
            midpoint: 7.5,
            quoteTimestamp: input.asOf
          };
        },
        storeExecutionEvidence: async () => ({ status: "authority_stored" }),
        authorizeExecution: async () => ({
          status: "authority_reserved",
          brokerAllowed: true,
          reservationId: "reservation-postgres-exit",
          orderIntentId: "intent-postgres-exit"
        }),
        recordExecutionResult: async (ledger: PaperExecutionLedgerEntry) => {
          recordedStatuses.push(ledger.status);
          return { status: "authority_recorded", replay: false };
        },
        submitPaperOrder: async () => ({
          data: { id: "exit-order-postgres", status: "accepted" },
          requestId: "exit-request-postgres",
          status: 200,
          url: "paper"
        }),
        getPaperOrder: async () => ({
          data: {
            id: "exit-order-postgres",
            status: "filled",
            filled_qty: "1",
            filled_avg_price: "7.45"
          },
          status: 200,
          url: "paper"
        })
      }
    )
  );

  getDb().prepare(
    "DELETE FROM paper_execution_ledger WHERE client_order_id = 'sqlite-only-hedge-exit'"
  ).run();
  assert.equal(result.status, "filled");
  assert.deepEqual(recordedStatuses, ["submitted", "filled"]);
  assert.equal(
    (getDb().prepare(
      "SELECT COUNT(*) AS count FROM paper_execution_ledger WHERE client_order_id = ?"
    ).get(built.review.clientOrderId) as { count: number }).count,
    0
  );
  assert.equal(
    (getDb().prepare(
      "SELECT status FROM hedge_execution_reviews WHERE review_id = ?"
    ).get(built.review.reviewId) as { status: string }).status,
    "reviewed"
  );
});

test("PostgreSQL authority denial prevents the hedge-exit cancel broker mutation", async () => {
  const input = {
    ...basePosition(),
    currentPrice: 7.5,
    asOf: "2026-07-13T14:02:00.000Z",
    sourceRecommendationId: "recommendation-postgres-cancel-denied",
    sourceSnapshotId: "snapshot-postgres-cancel-denied"
  };
  const built = buildHedgeExitReview({ ...input, signingKey: "exit-test-key" });
  assert.ok(built.review);
  let cancelCalls = 0;

  const result = await withExecutionAuthority(() =>
    executeReviewedPaperHedgeExit(
      { reviewId: built.review!.reviewId, confirmPaper: true },
      {
        review: built.review!,
        account: {
          id: "paper-account",
          status: "ACTIVE",
          buying_power: "10000",
          equity: "100000",
          options_approved_level: 3
        },
        currentPositionQuantity: 1,
        now: () => input.asOf,
        refreshQuote: async () => ({
          bid: 7.4,
          ask: 7.6,
          midpoint: 7.5,
          quoteTimestamp: input.asOf
        }),
        storeExecutionEvidence: async () => ({ status: "authority_stored" }),
        authorizeExecution: async () => ({
          status: "authority_reserved",
          brokerAllowed: true,
          reservationId: null,
          orderIntentId: "intent-postgres-cancel-denied"
        }),
        recordExecutionResult: async () => ({
          status: "authority_recorded",
          replay: false
        }),
        authorizeBrokerMutation: async () => ({
          status: "authority_blocked",
          brokerAllowed: false,
          blockers: ["EXECUTION_BROKER_MUTATION_FENCE_REJECTED"]
        }),
        submitPaperOrder: async () => ({
          data: {
            id: "exit-order-cancel-denied",
            client_order_id: built.review!.clientOrderId,
            status: "accepted"
          },
          status: 200,
          url: "paper"
        }),
        getPaperOrder: async () => ({
          data: {
            id: "exit-order-cancel-denied",
            client_order_id: built.review!.clientOrderId,
            status: "accepted",
            filled_qty: "0"
          },
          status: 200,
          url: "paper"
        }),
        cancelPaperOrder: async () => {
          cancelCalls += 1;
          return { data: null, status: 204, url: "paper" };
        }
      }
    )
  );

  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.includes("EXECUTION_BROKER_MUTATION_FENCE_REJECTED"));
  assert.equal(cancelCalls, 0);
});
