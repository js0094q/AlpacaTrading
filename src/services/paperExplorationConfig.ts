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

const enabled = (value: string | undefined) =>
  value?.trim().toLowerCase() === "true" || value?.trim() === "1";

const explicitlyOutsidePaperMode = (env: NodeJS.ProcessEnv) =>
  env.ALPACA_ENV?.trim().toLowerCase() === "live" ||
  env.TRADING_MODE?.trim().toLowerCase() === "live" ||
  enabled(env.ALPACA_LIVE_TRADE) ||
  enabled(env.LIVE_TRADING_ENABLED);

export const paperExplorationThresholds = (
  env: NodeJS.ProcessEnv = process.env
): PaperExplorationThresholds => {
  if (explicitlyOutsidePaperMode(env)) return { ...BASELINE_DECISION_THRESHOLDS };
  return {
    directionScore: boundedNumber(
      env.PAPER_EXPLORATION_DIRECTION_SCORE,
      0.15,
      0.05,
      BASELINE_DECISION_THRESHOLDS.directionScore
    ),
    minimumDirectionalConfidence: boundedNumber(
      env.PAPER_EXPLORATION_MIN_DIRECTIONAL_CONFIDENCE,
      0.25,
      0.1,
      BASELINE_DECISION_THRESHOLDS.minimumDirectionalConfidence
    ),
    minimumOptionLiquidityScore: boundedNumber(
      env.PAPER_EXPLORATION_MIN_OPTION_LIQUIDITY_SCORE,
      0.35,
      0.1,
      BASELINE_DECISION_THRESHOLDS.minimumOptionLiquidityScore
    ),
    maximumOptionSpreadPct: boundedNumber(
      env.PAPER_EXPLORATION_MAX_OPTION_SPREAD_PCT,
      0.12,
      BASELINE_DECISION_THRESHOLDS.maximumOptionSpreadPct,
      0.15
    ),
    minimumLongOptionConfidence: boundedNumber(
      env.PAPER_EXPLORATION_MIN_LONG_OPTION_CONFIDENCE,
      0.4,
      0.25,
      BASELINE_DECISION_THRESHOLDS.minimumLongOptionConfidence
    ),
    minimumAggressiveOptionConfidence: boundedNumber(
      env.PAPER_EXPLORATION_MIN_AGGRESSIVE_OPTION_CONFIDENCE,
      0.6,
      0.4,
      BASELINE_DECISION_THRESHOLDS.minimumAggressiveOptionConfidence
    ),
    minimumDefinedRiskConfidence: boundedNumber(
      env.PAPER_EXPLORATION_MIN_DEFINED_RISK_CONFIDENCE,
      0.7,
      0.5,
      BASELINE_DECISION_THRESHOLDS.minimumDefinedRiskConfidence
    ),
    minimumOptionExpectedReturnPct: boundedNumber(
      env.PAPER_EXPLORATION_MIN_OPTION_EXPECTED_RETURN_PCT,
      0.75,
      0.25,
      BASELINE_DECISION_THRESHOLDS.minimumOptionExpectedReturnPct
    ),
    minimumDefinedRiskExpectedReturnPct: boundedNumber(
      env.PAPER_EXPLORATION_MIN_DEFINED_RISK_EXPECTED_RETURN_PCT,
      1,
      0.5,
      BASELINE_DECISION_THRESHOLDS.minimumDefinedRiskExpectedReturnPct
    ),
    maxCandidates: boundedInteger(
      env.PAPER_EXPLORATION_MAX_CANDIDATES,
      25,
      BASELINE_DECISION_THRESHOLDS.maxCandidates,
      25
    ),
    maxOrderNotional: boundedNumber(
      env.PAPER_EXPLORATION_MAX_ORDER_NOTIONAL,
      250,
      50,
      BASELINE_DECISION_THRESHOLDS.maxOrderNotional
    )
  };
};

export const paperExplorationProfile = (
  thresholds: PaperExplorationThresholds = paperExplorationThresholds()
) => ({
  scope: "paper_only" as const,
  profile: "exploration_v1" as const,
  thresholds: {
    directionScore: {
      previous: BASELINE_DECISION_THRESHOLDS.directionScore,
      current: thresholds.directionScore
    },
    directionalConfidence: {
      previous: BASELINE_DECISION_THRESHOLDS.minimumDirectionalConfidence,
      current: thresholds.minimumDirectionalConfidence
    },
    optionLiquidityScore: {
      previous: BASELINE_DECISION_THRESHOLDS.minimumOptionLiquidityScore,
      current: thresholds.minimumOptionLiquidityScore
    },
    maxOptionSpreadPct: {
      previous: BASELINE_DECISION_THRESHOLDS.maximumOptionSpreadPct,
      current: thresholds.maximumOptionSpreadPct
    },
    longOptionConfidence: {
      previous: BASELINE_DECISION_THRESHOLDS.minimumLongOptionConfidence,
      current: thresholds.minimumLongOptionConfidence
    },
    aggressiveOptionConfidence: {
      previous: BASELINE_DECISION_THRESHOLDS.minimumAggressiveOptionConfidence,
      current: thresholds.minimumAggressiveOptionConfidence
    },
    definedRiskConfidence: {
      previous: BASELINE_DECISION_THRESHOLDS.minimumDefinedRiskConfidence,
      current: thresholds.minimumDefinedRiskConfidence
    },
    optionExpectedReturnPct: {
      previous: BASELINE_DECISION_THRESHOLDS.minimumOptionExpectedReturnPct,
      current: thresholds.minimumOptionExpectedReturnPct
    },
    definedRiskExpectedReturnPct: {
      previous: BASELINE_DECISION_THRESHOLDS.minimumDefinedRiskExpectedReturnPct,
      current: thresholds.minimumDefinedRiskExpectedReturnPct
    },
    maxCandidates: {
      previous: BASELINE_DECISION_THRESHOLDS.maxCandidates,
      current: thresholds.maxCandidates
    },
    maxOrderNotional: {
      previous: BASELINE_DECISION_THRESHOLDS.maxOrderNotional,
      current: thresholds.maxOrderNotional
    }
  }
});

export const classifyDirectionalScore = (
  score: number,
  threshold = BASELINE_DECISION_THRESHOLDS.directionScore
) => score > threshold ? "long" as const : score < -threshold ? "short" as const : "neutral" as const;
