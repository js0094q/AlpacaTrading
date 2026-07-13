export type PaperPositionClass =
  | "equity"
  | "option_0dte"
  | "option_short_dated"
  | "option_leaps"
  | "option_other"
  | "unknown";

export type PaperExitStatus = "ok" | "warning" | "blocked";
export type PaperExitExecutionStatus = "ok" | "warning" | "blocked" | "error";
export type PaperExitEnvironment = "paper" | "live";

export type PaperExitAssetClass = "us_equity" | "us_option";

export interface PaperExitOrderPayload {
  symbol: string;
  assetClass: PaperExitAssetClass;
  side: "sell";
  positionIntent?: "sell_to_close";
  qty: string;
  orderType: "limit" | "market";
  timeInForce: "day";
  reason: string;
  limitPrice?: string;
  clientOrderId: string;
}

export interface PaperExitReviewCandidate {
  symbol: string;
  assetClass: PaperExitAssetClass;
  positionClass: PaperPositionClass;
  qty: string;
  qtyAvailable: string;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPl: number;
  unrealizedPlpc: number;
  reason: string;
  orderPayload: PaperExitOrderPayload;
}

export interface PaperExitSkippedPosition {
  symbol: string;
  assetClass: string;
  positionClass: PaperPositionClass | string;
  reason: string;
  details?: Record<string, unknown>;
}

export interface PaperExitReconciliationEvent {
  code: string;
  symbol?: string;
  message: string;
}

export interface PaperExitReviewResult {
  status: PaperExitStatus;
  environment: PaperExitEnvironment;
  mutationAttempted: false;
  generatedAt: string;
  blockReason?: string;
  account: {
    cash: number;
    equity: number;
    buyingPower: number;
    positionMarketValue: number;
  };
  reconciliation: {
    status: PaperExitStatus;
    sumPositionsMarketValue: number;
    accountPositionMarketValue: number;
    events: PaperExitReconciliationEvent[];
  };
  exitCandidates: PaperExitReviewCandidate[];
  skipped: PaperExitSkippedPosition[];
  alpacaRequestIds: Record<string, string>;
}

export interface PaperExitSubmittedOrder {
  symbol: string;
  side: "sell";
  qty: string;
  assetClass: PaperExitAssetClass;
  positionIntent?: "sell_to_close";
  reason: string;
  alpacaOrderId?: string;
  clientOrderId?: string;
  alpacaRequestId?: string;
  status?: string;
}

export interface PaperExitExecutionResult {
  status: PaperExitExecutionStatus;
  environment: PaperExitEnvironment;
  mutationAttempted: boolean;
  submittedOrders: PaperExitSubmittedOrder[];
  skipped: PaperExitSkippedPosition[];
  blockedReason?: string;
  errors?: Array<Record<string, unknown>>;
  review: PaperExitReviewResult;
}
