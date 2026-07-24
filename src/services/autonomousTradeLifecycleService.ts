/** Pure, paper-only contracts for the autonomous trade lifecycle. */

export const AUTONOMOUS_TRADE_LIFECYCLE_STATES = [
  "candidate_created", "candidate_qualified", "review_created", "review_pending", "review_approved",
  "review_rejected", "intent_created", "submission_attempt_persisted", "submitted", "partially_filled",
  "filled", "exit_requested", "exit_submission_attempt_persisted", "exit_submitted", "cancel_requested",
  "cancel_submitted", "cancelled", "rejected", "expired", "reconciled", "closed", "blocked",
  "ambiguous", "failed_recoverable", "failed_terminal"
] as const;
export type AutonomousTradeLifecycleState = (typeof AUTONOMOUS_TRADE_LIFECYCLE_STATES)[number];

export const TRADE_OPERATIONS = ["buy_to_open", "sell_to_open", "sell_to_close", "buy_to_cover"] as const;
export type TradeOperation = (typeof TRADE_OPERATIONS)[number];

export const STRATEGY_CLASSIFICATIONS = [
  "equity_long", "equity_short", "standard_call", "standard_put",
  "zero_dte_call", "zero_dte_put", "leaps_call", "leaps_put", "hedge"
] as const;
export type StrategyClassification = (typeof STRATEGY_CLASSIFICATIONS)[number];

export interface WorkerExecutionContext {
  autonomousCycleId: string;
  workstreamExecutionId: string;
  authorizationSnapshotId: string;
  schedulerFenceToken: bigint;
  reviewId: string | null;
  confirmationId: string | null;
  parentPositionId: string | null;
  openingIntentId: string | null;
}

export interface PersistedOrderIntent {
  id: string;
  accountId: string;
  candidateId: string | null;
  reviewId: string | null;
  confirmationId: string | null;
  parentPositionId: string | null;
  openingIntentId: string | null;
  contractId: string | null;
  authorizationSnapshotId: string;
  autonomousCycleId: string;
  workstreamExecutionId: string;
  reservationId: string | null;
  clientOrderId: string;
  operation: TradeOperation;
  classification: StrategyClassification;
  lifecycleState: AutonomousTradeLifecycleState;
  brokerOrderId: string | null;
  brokerStatus: string | null;
  reservationReleaseReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DashboardTradeLifecycleRow extends PersistedOrderIntent {
  symbol: string;
  exitTrigger: string | null;
  exitReason: string | null;
  reconciliationAt: Date | null;
  premiumEvidence: { bid: number | null; ask: number | null; observedAt: Date | null } | null;
}

export interface DashboardLifecycleContract {
  paperOnly: true;
  rows: readonly DashboardTradeLifecycleRow[];
  generatedAt: Date;
}
export type DashboardLifecycleRow = DashboardTradeLifecycleRow;
export type AutonomousTradeLifecycleDashboardRow = DashboardTradeLifecycleRow;

export const validateCloseOperation = (input: {
  positionSide: "long" | "short";
  operation: TradeOperation | string;
}): { valid: true } | { valid: false; reason: string } => {
  const expected = input.positionSide === "short" ? "buy_to_cover" : "sell_to_close";
  return input.operation === expected ? { valid: true } : { valid: false, reason: `CLOSE_OPERATION_MISMATCH:${expected}` };
};

const utcDate = (value: string): number => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) throw new Error("INVALID_OPTION_DATE");
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
};

export const classifyOptionStrategy = (input: {
  observedAt: string;
  expiration: string;
  optionType: "call" | "put";
}): Exclude<StrategyClassification, "equity_long" | "equity_short" | "hedge"> => {
  const days = Math.floor((utcDate(input.expiration) - utcDate(input.observedAt)) / 86_400_000);
  const family = days === 0 ? "zero_dte" : days >= 365 ? "leaps" : "standard";
  return `${family}_${input.optionType}` as Exclude<StrategyClassification, "equity_long" | "equity_short" | "hedge">;
};

const transitions: Readonly<Record<AutonomousTradeLifecycleState, readonly AutonomousTradeLifecycleState[]>> = {
  candidate_created: ["candidate_qualified", "blocked"], candidate_qualified: ["review_created", "blocked"],
  review_created: ["review_pending", "review_rejected", "blocked"], review_pending: ["review_approved", "review_rejected", "expired", "blocked"],
  review_approved: ["intent_created", "blocked"], review_rejected: ["failed_terminal"],
  intent_created: ["submission_attempt_persisted", "cancel_requested", "blocked"],
  submission_attempt_persisted: ["submitted", "ambiguous", "rejected", "cancel_requested"],
  submitted: ["partially_filled", "filled", "reconciled", "cancel_requested", "rejected", "ambiguous"],
  partially_filled: ["filled", "exit_requested", "cancel_requested", "reconciled"], filled: ["exit_requested", "closed", "reconciled"],
  exit_requested: ["exit_submission_attempt_persisted", "cancel_requested", "blocked"],
  exit_submission_attempt_persisted: ["exit_submitted", "ambiguous", "rejected", "cancel_requested"],
  exit_submitted: ["partially_filled", "closed", "reconciled", "rejected", "ambiguous"],
  cancel_requested: ["cancel_submitted", "cancelled", "expired", "reconciled"], cancel_submitted: ["cancelled", "expired", "reconciled", "ambiguous"],
  ambiguous: ["submission_attempt_persisted", "submitted", "reconciled", "failed_recoverable", "failed_terminal"],
  failed_recoverable: ["submission_attempt_persisted", "reconciled", "failed_terminal"],
  cancelled: [], rejected: [], expired: [], reconciled: ["closed"], closed: [], blocked: [], failed_terminal: []
};

export interface LifecycleTransitionResult { readonly ok: true; readonly from: AutonomousTradeLifecycleState; readonly to: AutonomousTradeLifecycleState; }
export interface LifecycleClassificationResult { readonly classification: StrategyClassification; }
export interface AutonomousTradeLifecycleServiceContract {
  validateTransition(from: AutonomousTradeLifecycleState, to: AutonomousTradeLifecycleState): LifecycleTransitionResult;
  classifyOption(input: Parameters<typeof classifyOptionStrategy>[0]): LifecycleClassificationResult;
}

export class AutonomousTradeLifecycleService implements AutonomousTradeLifecycleServiceContract {
  validateTransition(from: AutonomousTradeLifecycleState, to: AutonomousTradeLifecycleState): LifecycleTransitionResult {
    validateLifecycleTransition(from, to);
    return { ok: true, from, to };
  }
  classifyOption(input: Parameters<typeof classifyOptionStrategy>[0]): LifecycleClassificationResult {
    return { classification: classifyOptionStrategy(input) };
  }
}

export const validateLifecycleTransition = (from: AutonomousTradeLifecycleState, to: AutonomousTradeLifecycleState): void => {
  if (!transitions[from]?.includes(to)) throw new Error(`INVALID_LIFECYCLE_TRANSITION:${from}->${to}`);
};

export const isTerminalLifecycleState = (state: AutonomousTradeLifecycleState) =>
  ["cancelled", "rejected", "expired", "closed", "blocked", "failed_terminal"].includes(state);
