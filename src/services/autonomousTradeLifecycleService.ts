/** Pure domain contracts for the paper-only autonomous trade lifecycle. */

export const AUTONOMOUS_TRADE_LIFECYCLE_STATES = [
  "candidate_qualified", "review_pending", "reviewed", "intent_created",
  "submission_attempt_persisted", "submitted", "partially_filled", "filled",
  "exit_requested", "exit_submission_attempt_persisted", "exit_submitted",
  "cancel_requested", "cancelled", "rejected", "expired", "reconciled", "closed", "blocked"
] as const;
export type AutonomousTradeLifecycleState = (typeof AUTONOMOUS_TRADE_LIFECYCLE_STATES)[number];

export const TRADE_OPERATIONS = ["buy_to_open", "sell_to_open", "sell_to_close", "buy_to_cover"] as const;
export type TradeOperation = (typeof TRADE_OPERATIONS)[number];

export const STRATEGY_CLASSIFICATIONS = ["equity", "standard", "zero_dte", "leaps", "hedge"] as const;
export type StrategyClassification = (typeof STRATEGY_CLASSIFICATIONS)[number];

export interface WorkerExecutionContext {
  cycleId: string;
  workstream: string;
  snapshotId: string | null;
  parentIntentId: string | null;
  openingIntentId: string | null;
  schedulerFencingToken: number;
  idempotencyKey: string;
}

export interface PersistedOrderIntent {
  id: string;
  accountId: string;
  candidateId: string | null;
  reservationId: string | null;
  clientOrderId: string;
  operation: TradeOperation;
  classification: StrategyClassification;
  lifecycleState: AutonomousTradeLifecycleState;
  cycleId: string;
  workstream: string;
  snapshotId: string | null;
  parentIntentId: string | null;
  openingIntentId: string | null;
  brokerOrderId: string | null;
  brokerStatus: string | null;
  reservationReleaseReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardTradeLifecycleRow extends PersistedOrderIntent {
  symbol: string;
  positionLifecycleId: string | null;
  exitTrigger: string | null;
  exitReason: string | null;
  reconciliationAt: string | null;
  premiumEvidence: { bid: number | null; ask: number | null; observedAt: string | null } | null;
}

export interface DashboardLifecycleContract {
  paperOnly: true;
  rows: readonly DashboardTradeLifecycleRow[];
  generatedAt: string;
}

// Stable aliases keep consumers independent from the transport-specific row name.
export type DashboardLifecycleRow = DashboardTradeLifecycleRow;
export type AutonomousTradeLifecycleDashboardRow = DashboardTradeLifecycleRow;

export const validateCloseOperation = (input: {
  positionSide: "long" | "short";
  operation: TradeOperation | string;
}): { valid: true } | { valid: false; reason: string } => {
  const expected = input.positionSide === "short" ? "buy_to_cover" : "sell_to_close";
  return input.operation === expected
    ? { valid: true }
    : { valid: false, reason: `CLOSE_OPERATION_MISMATCH:${expected}` };
};

const utcDate = (value: string): number => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) throw new Error("INVALID_OPTION_DATE");
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
};

export const classifyOptionStrategy = (input: {
  observedAt: string;
  expiration: string;
}): Exclude<StrategyClassification, "equity" | "hedge"> => {
  const days = Math.floor((utcDate(input.expiration) - utcDate(input.observedAt)) / 86_400_000);
  if (days === 0) return "zero_dte";
  if (days >= 365) return "leaps";
  return "standard";
};

const transitions: Readonly<Record<AutonomousTradeLifecycleState, readonly AutonomousTradeLifecycleState[]>> = {
  candidate_qualified: ["review_pending", "blocked"],
  review_pending: ["reviewed", "blocked", "expired"],
  reviewed: ["intent_created", "blocked"],
  intent_created: ["submission_attempt_persisted", "cancel_requested", "blocked"],
  submission_attempt_persisted: ["submitted", "reconciled", "rejected", "cancel_requested"],
  submitted: ["partially_filled", "filled", "reconciled", "cancel_requested", "rejected"],
  partially_filled: ["filled", "exit_requested", "cancel_requested", "reconciled"],
  filled: ["exit_requested", "closed", "reconciled"],
  exit_requested: ["exit_submission_attempt_persisted", "cancel_requested", "blocked"],
  exit_submission_attempt_persisted: ["exit_submitted", "reconciled", "rejected"],
  exit_submitted: ["partially_filled", "closed", "reconciled", "rejected"],
  cancel_requested: ["cancelled", "expired", "reconciled"],
  cancelled: [], rejected: [], expired: [], reconciled: ["closed"], closed: [], blocked: []
};

export const validateLifecycleTransition = (from: AutonomousTradeLifecycleState, to: AutonomousTradeLifecycleState): void => {
  if (!transitions[from]?.includes(to)) throw new Error(`INVALID_LIFECYCLE_TRANSITION:${from}->${to}`);
};

export const isTerminalLifecycleState = (state: AutonomousTradeLifecycleState) =>
  ["cancelled", "rejected", "expired", "closed", "blocked"].includes(state);
