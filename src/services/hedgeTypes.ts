import type { PortfolioRiskSnapshot } from "./portfolioRiskService.js";

export const HEDGE_RISK_MODEL_VERSION = "portfolio-risk-v1";
export const HEDGE_REGIME_MODEL_VERSION = "market-regime-v1";
export const HEDGE_PLAN_VERSION = "hedge-plan-v1";

export type HedgeDataQualityStatus =
  | "complete"
  | "partial"
  | "monitoring"
  | "blocked";

export type RiskAssessmentStatus =
  | "measured"
  | "partially_measured"
  | "indeterminate"
  | "blocked";

export type HedgeRecommendationStatus =
  | "current"
  | "monitoring"
  | "blocked"
  | "stale"
  | "expired";

export type MarketRegime =
  | "insufficient-data"
  | "crisis"
  | "risk-off"
  | "transition"
  | "risk-on"
  | "neutral";

export type HedgeDecision =
  | "monitor"
  | "existing_protection_sufficient"
  | "trim_leaps"
  | "trim_leaps_then_protect"
  | "buy_protection"
  | "blocked";

export interface BetaCacheIdentity {
  symbol: string;
  benchmark: string;
  lookbackDays: number;
  observationInterval: string;
  minimumObservations: number;
  calculationVersion: string;
  latestMarketDataDate: string;
}

export interface BetaCacheEntry extends BetaCacheIdentity {
  beta: number | null;
  observations: number;
  dataStartDate: string | null;
  dataEndDate: string | null;
  status: "calculated" | "unavailable";
  computedAt: string;
  expiresAt: string;
}

export interface PortfolioHighWaterMark {
  environment: "paper";
  equity: number;
  observedAt: string;
}

export interface HedgeCandidate {
  candidateId: string;
  rank: number;
  instrumentType: "protective_put" | "put_spread" | "inverse_etf";
  symbol: string;
  underlying: string;
  executable: false;
  expectedProtection: number | null;
  estimatedCost: number | null;
  units: number | null;
  rationale: string[];
  warnings: string[];
  blockers: string[];
  details?: Record<string, unknown>;
}

export interface HedgeRecommendationRecord {
  recordType: "hedge_recommendation";
  recommendationId: string;
  generatedAt: string;
  expiresAt: string;
  environment: "paper";
  sourceSnapshotId: string;
  riskModelVersion: string;
  regimeModelVersion: string;
  configurationFingerprint: string;
  dataQualityStatus: HedgeDataQualityStatus;
  recommendationStatus: Exclude<HedgeRecommendationStatus, "stale" | "expired">;
  reviewedPayloadHash: string | null;
  decision: HedgeDecision;
  benchmark: string;
  risk: PortfolioRiskSnapshot;
  regime: object;
  score: object;
  sizing: object;
  leaps: object;
  candidates: HedgeCandidate[];
  warnings: string[];
  blockers: string[];
  requestId: string;
  correlationId: string | null;
}

export interface PersistedHedgeRecommendation
  extends Omit<HedgeRecommendationRecord, "risk" | "environment"> {
  environment: string;
  paperOnly: boolean;
  liveTradingEnabled: boolean;
  risk: PortfolioRiskSnapshot | null;
  effectiveStatus: HedgeRecommendationStatus;
  integrityWarnings: string[];
  persistedAt: string;
}

export interface PersistedHedgeRiskRead {
  paperOnly: true;
  environment: "paper";
  liveTradingEnabled: false;
  effectiveStatus: HedgeRecommendationStatus;
  generatedAt: string | null;
  expiresAt: string | null;
  risk: PortfolioRiskSnapshot | null;
  warnings: string[];
  blockers: string[];
}
