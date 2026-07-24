/** Durable, paper-only autonomous trade lifecycle contracts. */

export const AUTONOMOUS_TRADE_LIFECYCLE_STATES = [
  "candidate_created", "review_created", "confirmed", "ready_for_submission",
  "submission_attempt_persisted", "submission_ambiguous", "broker_order_discovered",
  "broker_order_accepted", "partially_filled", "filled", "position_reconciled",
  "exit_evaluated", "exit_review_created", "exit_confirmed", "exit_ready_for_submission",
  "exit_submission_attempt_persisted", "exit_submission_ambiguous", "exit_broker_order_discovered",
  "exit_partially_filled", "closed", "cancel_requested", "cancel_ambiguous", "cancelled",
  "rejected", "expired", "failed_terminal"
] as const;
export type AutonomousTradeLifecycleState = (typeof AUTONOMOUS_TRADE_LIFECYCLE_STATES)[number];

export const TRADE_OPERATIONS = ["buy_to_open", "sell_to_open", "sell_to_close", "buy_to_cover"] as const;
export type TradeOperation = (typeof TRADE_OPERATIONS)[number];
export const STRATEGY_CLASSIFICATIONS = [
  "equity_long", "equity_short", "standard_long_call", "standard_long_put",
  "zero_dte_long_call", "zero_dte_long_put", "leaps_long_call", "leaps_long_put", "hedge"
] as const;
export type StrategyClassification = (typeof STRATEGY_CLASSIFICATIONS)[number];

export interface WorkerExecutionContext {
  cycleId: string;
  workstreamExecutionId: string;
  leaseId: string;
  fenceToken: bigint;
  startedAt: Date;
  abortSignal: AbortSignal;
}

export interface PersistedOrderIntent {
  id: string;
  candidateId: string | null;
  reviewId: string;
  confirmationId: string;
  parentPositionId: string | null;
  openingIntentId: string | null;
  operation: TradeOperation;
  strategyClassification: StrategyClassification;
  symbol: string;
  contractId: string | null;
  clientOrderId: string;
  quantity: string;
  limitPrice: string | null;
  lifecycleState: AutonomousTradeLifecycleState;
  autonomousCycleId: string;
  workstreamExecutionId: string;
  authorizationSnapshotId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DashboardTradeLifecycle {
  candidateId: string | null; reviewId: string | null; confirmationId: string | null; intentId: string;
  parentPositionId: string | null; openingIntentId: string | null; clientOrderId: string; brokerOrderId: string | null;
  operation: TradeOperation; strategyClassification: StrategyClassification; lifecycleState: AutonomousTradeLifecycleState;
  brokerStatus: string | null; submittedAt: string | null; filledAt: string | null; cancelledAt: string | null;
  filledQuantity: string | null; averageFillPrice: string | null; reservationState: string | null;
  reservationReleaseReason: string | null; positionId: string | null; positionSide: "long" | "short" | null;
  openQuantity: string | null; latestReconciledAt: string | null; autonomousCycleId: string; workstreamExecutionId: string;
  exitTrigger: string | null; reasonCode: string | null; decisionEvidence: Record<string, unknown> | null;
}

export interface ReconciledPosition {
  id: string; assetClass: "equity" | "option"; side: "long" | "short"; symbol: string;
  contractId: string | null; originatingCandidateId: string | null; openingIntentId: string | null; openQuantity: string;
  strategyClassification: StrategyClassification;
}
export interface ExitDecision {
  shouldExit: boolean;
  trigger: "stop_loss" | "take_profit" | "zero_dte_time_exit" | "zero_dte_risk_exit" | "leaps_trend_break" | "option_value_exit" | "short_risk_exit" | "hedge_exit" | "no_trigger";
  reasonCode: string; explanation: Record<string, unknown>; evaluatedAt: Date; marketDataSnapshotIds: string[];
}
export interface ExecutableOptionEvidence {
  contractId: string; symbol: string; underlyingSymbol: string; optionType: "call" | "put"; expirationDate: string; strikePrice: string;
  bid: string; ask: string; midpoint: string; spreadAbsolute: string; spreadPercent: string; volume: number | null; openInterest: number | null;
  impliedVolatility: string | null; delta: string | null; gamma: string | null; theta: string | null; vega: string | null; rho: string | null;
  quoteTimestamp: Date; contractObservedAt: Date; tradable: boolean; active: boolean; source: "alpaca_opra";
}
export class DomainInvariantError extends Error { constructor(code: string) { super(code); this.name = "DomainInvariantError"; } }

export function validateCloseOperation(position: ReconciledPosition, operation: TradeOperation): void;
export function validateCloseOperation(input: { positionSide: "long" | "short"; operation: string }): { valid: boolean; reason?: string };
export function validateCloseOperation(positionOrInput: ReconciledPosition | { positionSide: "long" | "short"; operation: string }, operation?: TradeOperation): void | { valid: boolean; reason?: string } {
  if ("positionSide" in positionOrInput) {
    const expected = positionOrInput.positionSide === "short" ? "buy_to_cover" : "sell_to_close";
    return positionOrInput.operation === expected ? { valid: true } : { valid: false, reason: `CLOSE_OPERATION_MISMATCH:${expected}` };
  }
  const position = positionOrInput;
  if (!operation) throw new DomainInvariantError("MISSING_CLOSE_OPERATION");
  if (position.assetClass === "equity" && position.side === "short" && operation !== "buy_to_cover") throw new DomainInvariantError("SHORT_POSITION_REQUIRES_BUY_TO_COVER");
  if (position.side === "long" && operation !== "sell_to_close") throw new DomainInvariantError("LONG_POSITION_REQUIRES_SELL_TO_CLOSE");
}

export function classifyOptionStrategy(contract: { expirationDate: string; optionType: "call" | "put" }, marketDate: string): Exclude<StrategyClassification, "equity_long" | "equity_short" | "hedge">;
export function classifyOptionStrategy(input: { observedAt: string; expiration: string; optionType: "call" | "put" }): Exclude<StrategyClassification, "equity_long" | "equity_short" | "hedge">;
export function classifyOptionStrategy(contractOrInput: { expirationDate?: string; expiration?: string; observedAt?: string; optionType: "call" | "put" }, marketDate?: string): Exclude<StrategyClassification, "equity_long" | "equity_short" | "hedge"> {
  const contract = { expirationDate: contractOrInput.expirationDate ?? contractOrInput.expiration!, optionType: contractOrInput.optionType };
  const date = marketDate ?? contractOrInput.observedAt!;
  const days = Math.floor((Date.parse(`${contract.expirationDate}T00:00:00Z`) - Date.parse(`${date.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
  if (days === 0) return contract.optionType === "call" ? "zero_dte_long_call" : "zero_dte_long_put";
  if (days >= 365) return contract.optionType === "call" ? "leaps_long_call" : "leaps_long_put";
  return contract.optionType === "call" ? "standard_long_call" : "standard_long_put";
}

export interface LifecycleAdvanceResult { readonly ok: true; readonly state: AutonomousTradeLifecycleState; readonly reasonCode?: string; }
export interface LifecycleRecoveryResult { readonly ok: true; readonly recovered: number; readonly reasonCode: string; }
export interface AutonomousTradeLifecycleService {
  advanceCandidate(candidateId: string, context: WorkerExecutionContext): Promise<LifecycleAdvanceResult>;
  advanceIntent(intentId: string, context: WorkerExecutionContext): Promise<LifecycleAdvanceResult>;
  advanceBrokerOrder(orderId: string, context: WorkerExecutionContext): Promise<LifecycleAdvanceResult>;
  evaluatePositionExit(positionId: string, context: WorkerExecutionContext): Promise<LifecycleAdvanceResult>;
  advanceExitIntent(intentId: string, context: WorkerExecutionContext): Promise<LifecycleAdvanceResult>;
  evaluateCancellation(orderId: string, context: WorkerExecutionContext): Promise<LifecycleAdvanceResult>;
  recoverPendingState(context: WorkerExecutionContext): Promise<LifecycleRecoveryResult>;
}

const transitions: Readonly<Record<AutonomousTradeLifecycleState, readonly AutonomousTradeLifecycleState[]>> = {
  candidate_created: ["review_created", "failed_terminal"],
  review_created: ["confirmed", "failed_terminal"],
  confirmed: ["ready_for_submission", "failed_terminal"],
  ready_for_submission: ["submission_attempt_persisted", "cancel_requested"],
  submission_attempt_persisted: [
    "submission_ambiguous",
    "broker_order_discovered",
    "cancelled",
    "rejected",
    "expired"
  ],
  submission_ambiguous: ["broker_order_discovered", "failed_terminal"],
  broker_order_discovered: [
    "broker_order_accepted",
    "rejected",
    "expired",
    "cancel_requested"
  ],
  broker_order_accepted: ["partially_filled", "filled", "cancel_requested"],
  partially_filled: ["filled", "position_reconciled", "cancel_requested"],
  filled: ["position_reconciled", "exit_evaluated"],
  position_reconciled: ["exit_evaluated"],
  exit_evaluated: ["exit_review_created", "closed"],
  exit_review_created: ["exit_confirmed"],
  exit_confirmed: ["exit_ready_for_submission"],
  exit_ready_for_submission: [
    "exit_submission_attempt_persisted",
    "cancel_requested"
  ],
  exit_submission_attempt_persisted: [
    "exit_submission_ambiguous",
    "exit_broker_order_discovered",
    "cancelled",
    "rejected",
    "expired"
  ],
  exit_submission_ambiguous: ["exit_broker_order_discovered", "failed_terminal"],
  exit_broker_order_discovered: [
    "exit_partially_filled",
    "closed",
    "rejected",
    "expired",
    "cancel_requested"
  ],
  exit_partially_filled: ["closed", "cancel_requested"],
  closed: [],
  cancel_requested: ["cancel_ambiguous", "cancelled", "expired"],
  cancel_ambiguous: ["cancelled", "expired", "failed_terminal"],
  cancelled: [],
  rejected: [],
  expired: [],
  failed_terminal: []
};
export const validateLifecycleTransition = (from: AutonomousTradeLifecycleState | string, to: AutonomousTradeLifecycleState | string): void => { if (!(transitions[from as AutonomousTradeLifecycleState]?.includes(to as AutonomousTradeLifecycleState))) throw new Error(`INVALID_LIFECYCLE_TRANSITION:${from}->${to}`); };
export const isTerminalLifecycleState = (state: AutonomousTradeLifecycleState) => ["closed", "cancelled", "rejected", "expired", "failed_terminal"].includes(state);

export const lifecycleStateForBrokerStatus = (
  reviewType: "entry" | "exit",
  brokerStatus: string
): AutonomousTradeLifecycleState => {
  const status = brokerStatus.trim().toLowerCase();
  if (status === "canceled" || status === "cancelled") return "cancelled";
  if (status === "rejected") return "rejected";
  if (status === "expired") return "expired";
  if (reviewType === "exit") {
    return status === "partially_filled"
      ? "exit_partially_filled"
      : "exit_broker_order_discovered";
  }
  if (status === "partially_filled") return "partially_filled";
  if (status === "filled") return "filled";
  return ["accepted", "new", "pending_new", "held"].includes(status)
    ? "broker_order_accepted"
    : "broker_order_discovered";
};

export const autonomousLifecycleContextFromRuntime = (
  environment: { readonly AUTONOMOUS_CYCLE_ID?: string },
  fence: { readonly runId: string }
): Pick<WorkerExecutionContext, "cycleId" | "workstreamExecutionId"> => ({
  cycleId: environment.AUTONOMOUS_CYCLE_ID?.trim() || fence.runId,
  workstreamExecutionId: fence.runId
});
