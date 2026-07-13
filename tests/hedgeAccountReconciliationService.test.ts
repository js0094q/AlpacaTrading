import assert from "node:assert/strict";
import test from "node:test";

import { reconcileHedgeAccountState } from "../src/services/hedgeAccountReconciliationService.js";
import type { HedgeExecutionReview } from "../src/services/hedgeExecutionReviewService.js";

const review = {
  accountHash: "account-hash",
  orderIntent: {
    symbol: "SPY260918P00500000",
    quantity: 1,
    side: "buy_to_open"
  },
  clientOrderId: "hedge-entry-1"
} as HedgeExecutionReview;

const validInput = () => ({
  review,
  currentAccountHash: "account-hash",
  accountStatus: "ACTIVE",
  accountEnvironment: "paper" as const,
  buyingPower: 10_000,
  requiredPremium: 500,
  optionApprovalLevel: 3,
  positions: [],
  openOrders: [],
  ledger: []
});

test("reconciles a paper account with no conflicting position or order", () => {
  const result = reconcileHedgeAccountState(validInput());
  assert.equal(result.valid, true);
  assert.deepEqual(result.blockers, []);
});

test("blocks account, position, order, and ledger disagreements", () => {
  const result = reconcileHedgeAccountState({
    ...validInput(),
    currentAccountHash: "different",
    accountEnvironment: "live",
    positions: [{ symbol: review.orderIntent.symbol, quantity: 1 }],
    openOrders: [{ symbol: review.orderIntent.symbol, clientOrderId: review.clientOrderId }],
    ledger: [{ clientOrderId: review.clientOrderId, status: "submitted" }]
  });
  assert.equal(result.valid, false);
  assert.ok(result.blockers.includes("HEDGE_ACCOUNT_IDENTITY_MISMATCH"));
  assert.ok(result.blockers.includes("HEDGE_ACCOUNT_RECONCILIATION_MISMATCH"));
});
