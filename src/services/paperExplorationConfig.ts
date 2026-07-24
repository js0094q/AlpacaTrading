export type StrategySelectionThresholds = {
  readonly minimumDirectionalConfidence: number;
  readonly minimumOptionLiquidityScore: number;
  readonly maximumOptionSpreadPct: number;
  readonly minimumLongOptionConfidence: number;
  readonly minimumAggressiveOptionConfidence: number;
  readonly minimumDefinedRiskConfidence: number;
  readonly minimumOptionExpectedReturnPct: number;
  readonly minimumDefinedRiskExpectedReturnPct: number;
};

export type PaperExplorationThresholds = StrategySelectionThresholds & {
  readonly directionScore: number;
  readonly maxCandidates: number;
  readonly maxOrderNotional: number;
};

export const BASELINE_DECISION_THRESHOLDS: PaperExplorationThresholds = {
  directionScore: 0.25,
  minimumDirectionalConfidence: 0.35,
  minimumOptionLiquidityScore: 0.5,
  maximumOptionSpreadPct: 0.08,
  minimumLongOptionConfidence: 0.5,
  minimumAggressiveOptionConfidence: 0.7,
  minimumDefinedRiskConfidence: 0.8,
  minimumOptionExpectedReturnPct: 1,
  minimumDefinedRiskExpectedReturnPct: 1.5,
  maxCandidates: 10,
  maxOrderNotional: 1_000
};

export const PAPER_EXPLORATION_V1_THRESHOLDS: PaperExplorationThresholds = {
  directionScore: 0.15,
  minimumDirectionalConfidence: 0.25,
  minimumOptionLiquidityScore: 0.35,
  maximumOptionSpreadPct: 0.12,
  minimumLongOptionConfidence: 0.4,
  minimumAggressiveOptionConfidence: 0.6,
  minimumDefinedRiskConfidence: 0.7,
  minimumOptionExpectedReturnPct: 0.75,
  minimumDefinedRiskExpectedReturnPct: 1,
  maxCandidates: 25,
  maxOrderNotional: 1_000
};

export const PAPER_EXPLORATION_V2_THRESHOLDS: PaperExplorationThresholds = {
  directionScore: 0.05,
  minimumDirectionalConfidence: 0.1,
  minimumOptionLiquidityScore: 0.1,
  maximumOptionSpreadPct: 0.15,
  minimumLongOptionConfidence: 0.25,
  minimumAggressiveOptionConfidence: 0.4,
  minimumDefinedRiskConfidence: 0.5,
  minimumOptionExpectedReturnPct: 0.25,
  minimumDefinedRiskExpectedReturnPct: 0.5,
  maxCandidates: 25,
  maxOrderNotional: 1_000
};

export const PAPER_EXPLORATION_V3_THRESHOLDS: PaperExplorationThresholds = {
  directionScore: 0.04,
  minimumDirectionalConfidence: 0.05,
  minimumOptionLiquidityScore: 0.1,
  maximumOptionSpreadPct: 0.15,
  minimumLongOptionConfidence: 0.2,
  minimumAggressiveOptionConfidence: 0.35,
  minimumDefinedRiskConfidence: 0.45,
  minimumOptionExpectedReturnPct: 0.2,
  minimumDefinedRiskExpectedReturnPct: 0.4,
  maxCandidates: 25,
  maxOrderNotional: 1_000
};

const boundedNumber = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
};

const boundedInteger = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
};

const normalized = (value: string | undefined) => value?.trim().toLowerCase();

const explicitlyPaperOnly = (env: NodeJS.ProcessEnv) =>
  normalized(env.ALPACA_ENV) === "paper" &&
  normalized(env.TRADING_MODE) === "paper" &&
  normalized(env.ALPACA_LIVE_TRADE) === "false" &&
  normalized(env.LIVE_TRADING_ENABLED) === "false";

export const paperExplorationThresholds = (
  env: NodeJS.ProcessEnv = process.env
): PaperExplorationThresholds => {
  if (!explicitlyPaperOnly(env)) return { ...BASELINE_DECISION_THRESHOLDS };
  return {
    directionScore: boundedNumber(
      env.PAPER_EXPLORATION_DIRECTION_SCORE,
      PAPER_EXPLORATION_V3_THRESHOLDS.directionScore,
      0.04,
      BASELINE_DECISION_THRESHOLDS.directionScore
    ),
    minimumDirectionalConfidence: boundedNumber(
      env.PAPER_EXPLORATION_MIN_DIRECTIONAL_CONFIDENCE,
      PAPER_EXPLORATION_V3_THRESHOLDS.minimumDirectionalConfidence,
      0.05,
      BASELINE_DECISION_THRESHOLDS.minimumDirectionalConfidence
    ),
    minimumOptionLiquidityScore: boundedNumber(
      env.PAPER_EXPLORATION_MIN_OPTION_LIQUIDITY_SCORE,
      PAPER_EXPLORATION_V3_THRESHOLDS.minimumOptionLiquidityScore,
      0.1,
      BASELINE_DECISION_THRESHOLDS.minimumOptionLiquidityScore
    ),
    maximumOptionSpreadPct: boundedNumber(
      env.PAPER_EXPLORATION_MAX_OPTION_SPREAD_PCT,
      PAPER_EXPLORATION_V3_THRESHOLDS.maximumOptionSpreadPct,
      BASELINE_DECISION_THRESHOLDS.maximumOptionSpreadPct,
      0.15
    ),
    minimumLongOptionConfidence: boundedNumber(
      env.PAPER_EXPLORATION_MIN_LONG_OPTION_CONFIDENCE,
      PAPER_EXPLORATION_V3_THRESHOLDS.minimumLongOptionConfidence,
      0.2,
      BASELINE_DECISION_THRESHOLDS.minimumLongOptionConfidence
    ),
    minimumAggressiveOptionConfidence: boundedNumber(
      env.PAPER_EXPLORATION_MIN_AGGRESSIVE_OPTION_CONFIDENCE,
      PAPER_EXPLORATION_V3_THRESHOLDS.minimumAggressiveOptionConfidence,
      0.35,
      BASELINE_DECISION_THRESHOLDS.minimumAggressiveOptionConfidence
    ),
    minimumDefinedRiskConfidence: boundedNumber(
      env.PAPER_EXPLORATION_MIN_DEFINED_RISK_CONFIDENCE,
      PAPER_EXPLORATION_V3_THRESHOLDS.minimumDefinedRiskConfidence,
      0.45,
      BASELINE_DECISION_THRESHOLDS.minimumDefinedRiskConfidence
    ),
    minimumOptionExpectedReturnPct: boundedNumber(
      env.PAPER_EXPLORATION_MIN_OPTION_EXPECTED_RETURN_PCT,
      PAPER_EXPLORATION_V3_THRESHOLDS.minimumOptionExpectedReturnPct,
      0.2,
      BASELINE_DECISION_THRESHOLDS.minimumOptionExpectedReturnPct
    ),
    minimumDefinedRiskExpectedReturnPct: boundedNumber(
      env.PAPER_EXPLORATION_MIN_DEFINED_RISK_EXPECTED_RETURN_PCT,
      PAPER_EXPLORATION_V3_THRESHOLDS.minimumDefinedRiskExpectedReturnPct,
      0.4,
      BASELINE_DECISION_THRESHOLDS.minimumDefinedRiskExpectedReturnPct
    ),
    maxCandidates: boundedInteger(
      env.PAPER_EXPLORATION_MAX_CANDIDATES,
      PAPER_EXPLORATION_V3_THRESHOLDS.maxCandidates,
      BASELINE_DECISION_THRESHOLDS.maxCandidates,
      25
    ),
    maxOrderNotional: boundedNumber(
      env.PAPER_EXPLORATION_MAX_ORDER_NOTIONAL,
      PAPER_EXPLORATION_V3_THRESHOLDS.maxOrderNotional,
      50,
      BASELINE_DECISION_THRESHOLDS.maxOrderNotional
    )
  };
};

export const paperExplorationProfile = (
  thresholds: PaperExplorationThresholds = paperExplorationThresholds()
) => ({
  scope: "paper_only" as const,
  profile: "exploration_v3" as const,
  thresholds: {
    directionScore: {
      previous: PAPER_EXPLORATION_V2_THRESHOLDS.directionScore,
      current: thresholds.directionScore
    },
    directionalConfidence: {
      previous: PAPER_EXPLORATION_V2_THRESHOLDS.minimumDirectionalConfidence,
      current: thresholds.minimumDirectionalConfidence
    },
    optionLiquidityScore: {
      previous: PAPER_EXPLORATION_V2_THRESHOLDS.minimumOptionLiquidityScore,
      current: thresholds.minimumOptionLiquidityScore
    },
    maxOptionSpreadPct: {
      previous: PAPER_EXPLORATION_V2_THRESHOLDS.maximumOptionSpreadPct,
      current: thresholds.maximumOptionSpreadPct
    },
    longOptionConfidence: {
      previous: PAPER_EXPLORATION_V2_THRESHOLDS.minimumLongOptionConfidence,
      current: thresholds.minimumLongOptionConfidence
    },
    aggressiveOptionConfidence: {
      previous: PAPER_EXPLORATION_V2_THRESHOLDS.minimumAggressiveOptionConfidence,
      current: thresholds.minimumAggressiveOptionConfidence
    },
    definedRiskConfidence: {
      previous: PAPER_EXPLORATION_V2_THRESHOLDS.minimumDefinedRiskConfidence,
      current: thresholds.minimumDefinedRiskConfidence
    },
    optionExpectedReturnPct: {
      previous: PAPER_EXPLORATION_V2_THRESHOLDS.minimumOptionExpectedReturnPct,
      current: thresholds.minimumOptionExpectedReturnPct
    },
    definedRiskExpectedReturnPct: {
      previous: PAPER_EXPLORATION_V2_THRESHOLDS.minimumDefinedRiskExpectedReturnPct,
      current: thresholds.minimumDefinedRiskExpectedReturnPct
    },
    maxCandidates: {
      previous: PAPER_EXPLORATION_V2_THRESHOLDS.maxCandidates,
      current: thresholds.maxCandidates
    },
    maxOrderNotional: {
      previous: PAPER_EXPLORATION_V2_THRESHOLDS.maxOrderNotional,
      current: thresholds.maxOrderNotional
    }
  }
});

export const classifyDirectionalScore = (
  score: number,
  threshold = BASELINE_DECISION_THRESHOLDS.directionScore
) => score > threshold ? "long" as const : score < -threshold ? "short" as const : "neutral" as const;
