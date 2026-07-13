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
