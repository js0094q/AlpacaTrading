import { canonicalJsonHash } from "../lib/canonicalJson.js";
import type { HedgeExecutionReview } from "./hedgeExecutionReviewService.js";

export interface HedgeAccountReconciliationInput {
  review: HedgeExecutionReview;
  currentAccountHash: string;
  accountStatus: string;
  accountEnvironment: "paper" | "live" | string;
  buyingPower: number;
  requiredPremium: number;
  optionApprovalLevel: number;
  positions: Array<{ symbol: string; quantity: number }>;
  openOrders: Array<{ symbol: string; clientOrderId?: string; status?: string }>;
  ledger: Array<{ clientOrderId: string; status: string }>;
}

export interface HedgeAccountReconciliationResult {
  valid: boolean;
  blockers: string[];
  warnings: string[];
  checks: Record<string, boolean>;
  accountHash: string;
}

export const reconcileHedgeAccountState = (
  input: HedgeAccountReconciliationInput
): HedgeAccountReconciliationResult => {
  const duplicatePosition = input.positions.some(
    (position) => position.symbol === input.review.orderIntent.symbol && position.quantity > 0
  );
  const matchingOpenOrder = input.openOrders.some(
    (order) =>
      order.clientOrderId === input.review.clientOrderId ||
      (order.symbol === input.review.orderIntent.symbol && order.status !== "canceled" && order.status !== "rejected")
  );
  const matchingLedger = input.ledger.some(
    (entry) =>
      entry.clientOrderId === input.review.clientOrderId &&
      !["blocked", "duplicate_blocked", "failed", "released"].includes(entry.status)
  );
  const checks = {
    accountIdentity: input.currentAccountHash === input.review.accountHash,
    accountPaper: input.accountEnvironment === "paper",
    accountActive: input.accountStatus === "ACTIVE",
    buyingPower: Number.isFinite(input.buyingPower) && input.buyingPower >= input.requiredPremium,
    optionApproval: Number.isFinite(input.optionApprovalLevel) && input.optionApprovalLevel >= 1,
    noExistingPosition: !duplicatePosition,
    noConflictingOpenOrder: !matchingOpenOrder,
    noLedgerDuplicate: !matchingLedger
  };
  const blockers: string[] = [];
  if (!checks.accountIdentity) blockers.push("HEDGE_ACCOUNT_IDENTITY_MISMATCH");
  if (!checks.accountPaper) blockers.push("HEDGE_ENVIRONMENT_NOT_PAPER");
  if (!checks.accountActive) blockers.push("HEDGE_ACCOUNT_NOT_ACTIVE");
  if (!checks.buyingPower) blockers.push("HEDGE_BUYING_POWER_INSUFFICIENT");
  if (!checks.optionApproval) blockers.push("HEDGE_OPTION_APPROVAL_REQUIRED");
  if (duplicatePosition || matchingOpenOrder || matchingLedger) blockers.push("HEDGE_ACCOUNT_RECONCILIATION_MISMATCH");
  return {
    valid: blockers.length === 0,
    blockers: [...new Set(blockers)],
    warnings: [],
    checks,
    accountHash: canonicalJsonHash({
      accountEnvironment: input.accountEnvironment,
      accountStatus: input.accountStatus,
      buyingPower: input.buyingPower,
      optionApprovalLevel: input.optionApprovalLevel
    })
  };
};
