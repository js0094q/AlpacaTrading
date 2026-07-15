export const ZERO_DTE_PLAYBOOKS = [
  "trend_continuation",
  "reversal",
  "breakout",
  "gamma_proxy",
  "volatility_expansion"
] as const;

export type ZeroDtePlaybook = (typeof ZERO_DTE_PLAYBOOKS)[number];

export type ZeroDteDirection = "bullish" | "bearish" | "neutral";

export const ZERO_DTE_CANDIDATE_STATES = [
  "discovered",
  "watching",
  "strengthening",
  "stable",
  "weakening",
  "eligible",
  "selected",
  "executed",
  "shadowed",
  "skipped",
  "rejected",
  "expired",
  "invalidated",
  "closed"
] as const;

export type ZeroDteCandidateState = (typeof ZERO_DTE_CANDIDATE_STATES)[number];

export const ZERO_DTE_STRATEGY_VERSION = "zero-dte-level-2-v1";

export interface ZeroDteConfig {
  enabled: boolean;
  paperExecutionEnabled: boolean;
  shadowEnabled: boolean;
  shadowSlippage: number;
  shadowFeePerContract: number;
  shadowMaxQuoteAgeMs: number;
  underlyings: string[];
  discoveryStartEt: string;
  newEntryCutoffEt: string;
  forceExitEt: string;
  engineIntervalSeconds: number;
  queueMaxActive: number;
  queueTopN: number;
  executionTopN: number;
  maxStrikesEachSide: number;
  underlyingMaxAgeMs: number;
  minOptionVolume: number;
  minOpenInterest: number;
  maxSpreadPct: number;
  minPremium: number;
  maxPremium: number;
  minScoreMovement: number;
  signalShortWindow: number;
  signalMediumWindow: number;
  minConfirmationObservations: number;
  maxContractsPerTrade: number;
  maxOpenPositions: number;
  maxTradesPerDay: number;
  maxPremiumPerTrade: number;
  maxDailyPremium: number;
  maxDailyRealizedLoss: number;
  outcomeHorizonsMinutes: number[];
  strategyVersion: string;
  configurationVersionId: string;
}

export interface ZeroDteRuntimeSnapshot {
  environment: string;
  tradingMode: string;
  paperOnly: boolean;
  liveTradingEnabled: boolean;
  engineEnabled: boolean;
  paperExecutionEnabled: boolean;
  paperOptionsExecutionEnabled: boolean;
  automatedPaperExecutionEnabled: boolean;
  paperAccountVerified?: boolean;
  marketOpen?: boolean;
  tradingDate?: string | null;
}

export interface ZeroDteAccountPositionSnapshot {
  symbol: string;
  quantity: number;
  marketValue?: number | null;
  currentPrice?: number | null;
}

export interface ZeroDteAccountOrderSnapshot {
  symbol: string;
  side?: string | null;
  status?: string | null;
  clientOrderId?: string | null;
  brokerOrderId?: string | null;
  quantity?: number | null;
  limitPrice?: number | null;
}

export interface ZeroDteAccountSnapshot {
  accountIdentityHash?: string | null;
  environment?: string;
  paperVerified?: boolean;
  status?: string | null;
  cash?: number | null;
  buyingPower: number | null;
  optionsBuyingPower?: number | null;
  equity?: number | null;
  optionApprovalLevel?: number | null;
  tradingBlocked?: boolean | null;
  accountBlocked?: boolean | null;
  dailyTradeCount?: number | null;
  dailyPremium?: number | null;
  dailyRealizedLoss?: number | null;
  activityEvidenceComplete?: boolean;
  activityEvidenceFingerprint?: string | null;
  activityEvidenceBlockers?: string[];
  openPositionCount?: number | null;
  openOrderCount?: number | null;
  openExposureCount?: number | null;
  openPositions?: ZeroDteAccountPositionSnapshot[];
  openOrders?: ZeroDteAccountOrderSnapshot[];
}
