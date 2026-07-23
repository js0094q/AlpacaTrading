export type Timeframe = "1Day" | "1Hour" | "15Min" | "5Min" | "1Min";
export type TimeHorizon = "1d" | "5d" | "20d";
export type AssetDirection = "long" | "short" | "neutral";
export type RiskProfile = "aggressive" | "moderate" | "conservative";
export type PreferredExpression =
  | "shares"
  | "long_call"
  | "long_put"
  | "call_spread"
  | "put_spread"
  | "covered_call"
  | "cash_secured_put"
  | "protective_put"
  | "collar"
  | "none";
export type ExitReason =
  | "stop_loss"
  | "take_profit"
  | "time_exit"
  | "signal_exit"
  | "trailing_stop";
export type OptionExitReason = ExitReason | "expiration";

export type UniverseLifecycleState =
  | "discovered"
  | "observe_only"
  | "research_eligible"
  | "paper_eligible"
  | "paper_active"
  | "suspended"
  | "retired";

export interface UniverseSymbolRow {
  symbol: string;
  assetClass: string;
  enabled: 0 | 1;
  source: string;
  createdAt: string;
  updatedAt: string;
  tradable: 0 | 1;
  assetId: string | null;
  assetStatus: string | null;
  exchange: string | null;
  fractionable: 0 | 1 | null;
  shortable: 0 | 1 | null;
  marginable: 0 | 1 | null;
  optionsEnabled: 0 | 1 | null;
  assetAttributes: string[];
  assetValidatedAt: string | null;
  assetRequestId: string | null;
  lifecycleState: UniverseLifecycleState;
  lifecycleReasonCode: string;
  lifecycleEnteredAt: string | null;
  lifecycleUpdatedAt: string | null;
  lifecycleConfigVersion: string | null;
}

export interface UniverseLifecycleEventRow {
  id: string;
  runId: string;
  symbol: string;
  fromState: UniverseLifecycleState | null;
  toState: UniverseLifecycleState;
  reasonCode: string;
  evidenceJson: string;
  occurredAt: string;
  gitSha: string;
  configVersion: string;
  configHash: string;
}

export interface UniverseLifecycleRunRow {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: "running" | "completed" | "failed";
  discoveryCursorStart: string | null;
  discoveryCursorEnd: string | null;
  assetsScanned: number;
  assetsDiscovered: number;
  symbolsAssessed: number;
  transitionsApplied: number;
  errorSummary: string | null;
  gitSha: string;
  configVersion: string;
  configHash: string;
}

export interface MarketBarRow {
  symbol: string;
  timeframe: Timeframe;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: "alpaca";
}

export type StockSnapshotFreshnessStatus = "FRESH" | "STALE" | "UNKNOWN";
export type StockSnapshotDataQualityStatus =
  | "COMPLETE"
  | "PARTIAL"
  | "MISSING_QUOTE"
  | "MISSING_TRADE"
  | "MISSING_MINUTE_BAR"
  | "SOURCE_ERROR";

export interface StockSnapshotRow {
  symbol: string;
  observedAt: string;
  sourceTimestamp: string | null;
  requestedFeed: string;
  effectiveFeed: string;
  currency: string | null;
  latestTradePrice: number | null;
  latestTradeSize: number | null;
  latestTradeExchange: string | null;
  latestTradeConditions: string[];
  tradeTimestamp: string | null;
  bidPrice: number | null;
  askPrice: number | null;
  bidSize: number | null;
  askSize: number | null;
  bidExchange: string | null;
  askExchange: string | null;
  quoteConditions: string[];
  quoteTimestamp: string | null;
  midpoint: number | null;
  spread: number | null;
  spreadPct: number | null;
  minuteTimestamp: string | null;
  minuteOpen: number | null;
  minuteHigh: number | null;
  minuteLow: number | null;
  minuteClose: number | null;
  minuteVolume: number | null;
  minuteTradeCount: number | null;
  minuteVwap: number | null;
  dailyTimestamp: string | null;
  dailyOpen: number | null;
  dailyHigh: number | null;
  dailyLow: number | null;
  dailyClose: number | null;
  dailyVolume: number | null;
  dailyTradeCount: number | null;
  dailyVwap: number | null;
  previousDailyTimestamp: string | null;
  previousDailyOpen: number | null;
  previousDailyHigh: number | null;
  previousDailyLow: number | null;
  previousDailyClose: number | null;
  previousDailyVolume: number | null;
  previousDailyTradeCount: number | null;
  previousDailyVwap: number | null;
  dailyReturn: number | null;
  gapFromPreviousClose: number | null;
  returnFromOpen: number | null;
  distanceFromVwap: number | null;
  intradayRange: number | null;
  relativeCurrentDayVolume: number | null;
  freshnessStatus: StockSnapshotFreshnessStatus;
  dataQualityStatus: StockSnapshotDataQualityStatus;
  source: "alpaca";
  requestId: string | null;
  errorSummary: string | null;
}

export interface OptionContractRow {
  underlyingSymbol: string;
  optionSymbol: string;
  type: "call" | "put";
  expirationDate: string;
  strike: number;
  multiplier: number;
  tradable: 0 | 1;
  source: "alpaca";
}

export interface OptionSnapshotRow {
  optionSymbol: string;
  underlyingSymbol: string;
  timestamp: string;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  last: number | null;
  volume: number | null;
  openInterest: number | null;
  impliedVolatility: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  source: "alpaca";
}

export interface FeatureSnapshotRow {
  symbol: string;
  timestamp: string;
  features: Record<string, string | number | null>;
}

export interface TargetSnapshotRow {
  symbol: string;
  asOf: string;
  direction: AssetDirection;
  horizon: TimeHorizon;
  entryReference: number;
  upsideTarget: number;
  downsideRisk: number;
  stopLoss: number | null;
  takeProfit: number | null;
  confidence: number;
  expectedReturn: number | null;
  volatilityAdjustedScore: number | null;
  riskProfile: RiskProfile;
  preferredExpression: PreferredExpression;
  rationale: string[];
  optionsCandidate?: string | null;
}

export interface ResearchRunRow {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: "running" | "completed" | "failed";
  riskProfile: RiskProfile;
  optionsEnabled: boolean;
  universeSize: number;
  targetsGenerated: number;
  candidatesSelected: number;
  errorMessage: string | null;
  configJson: string;
  summaryJson: string | null;
}

declare const decisionIdBrand: unique symbol;
declare const positionLifecycleIdBrand: unique symbol;

export type DecisionId = string & { readonly [decisionIdBrand]: true };
export type PositionLifecycleId = string & {
  readonly [positionLifecycleIdBrand]: true;
};

export type DecisionRole = "entry" | "exit" | "non_executable";
export type DecisionStatus =
  | "DISCOVERED"
  | "DATA_INCOMPLETE"
  | "SCORED"
  | "REJECTED"
  | "SKIPPED"
  | "SELECTED"
  | "REVIEWED"
  | "BLOCKED"
  | "PAPER_ELIGIBLE"
  | "SUBMITTED"
  | "FILLED"
  | "OPEN"
  | "CLOSED"
  | "EXPIRED";
declare const decisionReasonCodeBrand: unique symbol;
declare const exitReasonCodeBrand: unique symbol;
declare const dataQualityStatusBrand: unique symbol;
export type DecisionReasonCode = string & {
  readonly [decisionReasonCodeBrand]: true;
};
export type ExitReasonCode = string & { readonly [exitReasonCodeBrand]: true };
export type DataQualityStatus = string & {
  readonly [dataQualityStatusBrand]: true;
};
export type OutcomeCompletenessStatus =
  | "COMPLETE"
  | "PARTIAL"
  | "INSUFFICIENT_OBSERVATIONS"
  | "LEGACY_UNAVAILABLE"
  | "AMBIGUOUS_LINEAGE";
export type LinkageStatus =
  | "EXACT"
  | "EXACT_LEGACY_REUSE"
  | "AMBIGUOUS_NETTED_POSITION"
  | "LEGACY_UNLINKED"
  | "PARTIAL_BROKER_RECONCILIATION";

export interface PaperTradeCandidateRow {
  id: string;
  decisionId?: DecisionId | null;
  researchRunId: string;
  symbol: string;
  asOf: string;
  rank: number;
  direction: "long" | "short" | "neutral";
  horizon: TimeHorizon;
  riskProfile: RiskProfile;
  preferredExpression: PreferredExpression;
  score: number;
  confidence: number;
  expectedReturn: number | null;
  estimatedMaxLoss: number | null;
  estimatedMaxProfit: number | null;
  rationale: string[];
  relevantBacktestRunId: string | null;
  historicalWinRate: number | null;
  historicalAvgReturn: number | null;
  historicalMaxDrawdown: number | null;
  similarSetupCount: number | null;
  optionLiquidityScore: number | null;
  volatilityAdjustedScore: number | null;
  signalFreshnessDays: number | null;
  recentLearningAdjustment: number | null;
  directionalAccuracy: number | null;
  optionOutperformanceAccuracy: number | null;
  optionSymbol?: string | null;
  strike?: number | null;
  shortStrike?: number | null;
  estimatedExitValue?: number | null;
}

export type CandidateDecision = "selected" | "rejected" | "skipped" | "blocked";

export interface CandidateDecisionRecord extends Omit<PaperTradeCandidateRow, "researchRunId"> {
  decision: CandidateDecision;
  decisionReason: string;
  strategyFamily: string;
  signalInputs: Record<string, string | number | null>;
  dataQualityStatus: string;
}

export interface PaperTradePlanRow {
  id: string;
  researchRunId: string;
  candidateId: string;
  decisionId: DecisionId | null;
  symbol: string;
  createdAt: string;
  status: "planned" | "entered" | "closed" | "expired" | "skipped";
  direction: "long" | "short" | "neutral";
  expression: string;
  entryReference: number;
  stopLoss: number | null;
  takeProfit: number | null;
  expirationDate: string | null;
  optionSymbol: string | null;
  strike: number | null;
  shortStrike: number | null;
  estimatedEntryCost: number | null;
  estimatedMaxLoss: number | null;
  estimatedMaxProfit: number | null;
  thesis: string;
  invalidation: string;
  learningObjective: string;
  lastEvaluatedAt: string | null;
  lastOutcome: string | null;
  lastReturnPct: number | null;
}

export interface PaperTradeEvaluationRow {
  id: string;
  researchRunId: string;
  planId: string;
  candidateId: string;
  decisionId: DecisionId | null;
  evaluatedAt: string;
  markPrice: number | null;
  estimatedExitValue: number | null;
  unrealizedPnl: number | null;
  realizedPnl: number | null;
  returnPct: number | null;
  outcome:
    | "winner"
    | "loser"
    | "flat"
    | "expired_worthless"
    | "hit_stop"
    | "hit_take_profit"
    | "still_open"
    | "insufficient_data";
  notes: string[];
  horizon: TimeHorizon;
}

export interface StrategySelectorResult {
  symbol: string;
  asOf: string;
  direction: AssetDirection;
  preferredExpression: PreferredExpression;
  alternatives: PreferredExpression[];
  optionsCandidate?: {
    optionSymbol?: string;
    expirationDate?: string;
    strike?: number;
    type?: "call" | "put";
    estimatedEntryPrice?: number;
    maxLoss?: number | null;
    maxProfit?: number | null;
    breakeven?: number | null;
    liquidityScore?: number;
  };
  rationale: string[];
}

export interface IngestionRunRow {
  id: number;
  runType: "bars" | "options_contracts" | "options_snapshots" | "stock_snapshots";
  status: "running" | "completed" | "partial" | "failed" | "skipped_market_closed";
  symbols: string;
  timeframe?: Timeframe | null;
  startedAt: string;
  completedAt: string | null;
  rowsIngested: number;
  notes: string | null;
  requestedSymbols: number;
  successfulSymbols: number;
  failedSymbols: number;
  errorSummary: string | null;
}

export interface BacktestTradeRow {
  symbol: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  side: AssetDirection;
  quantity: number;
  pnl: number;
  returnPct: number;
  exitReason: ExitReason;
}

export interface BacktestOptionTradeRow {
  underlyingSymbol: string;
  optionSymbol?: string;
  strategy:
    | "long_call"
    | "long_put"
    | "call_spread"
    | "put_spread"
    | "covered_call"
    | "cash_secured_put"
    | "protective_put"
    | "collar";
  entryDate: string;
  exitDate: string;
  expirationDate?: string;
  strike?: number;
  shortStrike?: number;
  entryPremium: number | null;
  exitPremium: number | null;
  contracts: number;
  estimatedMaxLoss: number | null;
  estimatedMaxProfit: number | null;
  pnl: number;
  returnPct: number;
  exitReason: OptionExitReason;
}
