export interface PaperSubmitConfiguration {
  environment: string;
  tradingMode: string;
  liveTradingEnabled: boolean;
  paperOrderExecutionEnabled: boolean;
  paperOptionsExecutionEnabled: boolean;
  maxPositionNotional: number;
  maxTotalPlanNotional: number;
  equityMaxNotionalPerOrder: number;
  equityMaxPortfolioDeployPct: number;
  equityMaxPositionPct: number;
  equityMinCashReservePct: number;
  optionMaxOrderNotional: number;
  optionMaxContracts: number;
  optionMaxPortfolioRiskPct: number;
  optionMaxPositionRiskPct: number;
  quoteMaxAgeSeconds: number;
  maxPriceDriftPct: number;
  zeroDteMaxTradesPerDay?: number;
  zeroDteMaxDailyPremium?: number;
  zeroDteMaxDailyRealizedLoss?: number;
  zeroDteMaxOpenPositions?: number;
}

export interface PaperSubmitSafetyConfig extends PaperSubmitConfiguration {
  allocationIdentity: "baseline-v1";
}

const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const positive = (value: unknown, fallback: number) => {
  const parsed = finite(value);
  return parsed !== null && parsed > 0 ? parsed : fallback;
};

const nonNegative = (value: unknown, fallback: number) => {
  const parsed = finite(value);
  return parsed !== null && parsed >= 0 ? parsed : fallback;
};

const positiveInteger = (value: unknown, fallback: number) => {
  const parsed = finite(value);
  return parsed !== null && parsed > 0 ? Math.floor(parsed) : fallback;
};

const nonNegativeInteger = (value: unknown, fallback: number) => {
  const parsed = finite(value);
  return parsed !== null && parsed >= 0 ? Math.floor(parsed) : fallback;
};

const percent = (value: unknown, fallback: number) => {
  const parsed = finite(value);
  return parsed === null ? fallback : Math.min(100, Math.max(0, parsed));
};

const flag = (value: string | undefined) => value === "true" || value === "1";

const first = (env: NodeJS.ProcessEnv, ...names: string[]) => {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim()) return value;
  }
  return undefined;
};

export const loadPaperSubmitSafetyConfig = (
  env: NodeJS.ProcessEnv = process.env
): PaperSubmitSafetyConfig => {
  const processRuntime = env === process.env;
  const equityMaxNotionalPerOrder = positive(
    processRuntime
      ? first(env, "PAPER_EQUITY_MAX_NOTIONAL_PER_ORDER", "PAPER_PLAN_MAX_POSITION_NOTIONAL")
      : env.PAPER_EQUITY_MAX_NOTIONAL_PER_ORDER,
    5_000
  );
  return {
    environment: String(env.ALPACA_ENV || "paper").trim().toLowerCase(),
    tradingMode: String(env.TRADING_MODE || "paper").trim().toLowerCase(),
    liveTradingEnabled:
      flag(env.ALPACA_LIVE_TRADE) || flag(env.LIVE_TRADING_ENABLED),
    paperOrderExecutionEnabled: flag(env.PAPER_ORDER_EXECUTION_ENABLED),
    paperOptionsExecutionEnabled: flag(env.PAPER_OPTIONS_EXECUTION_ENABLED),
    maxPositionNotional: processRuntime
      ? equityMaxNotionalPerOrder
      : positive(
          first(env, "PAPER_PLAN_MAX_POSITION_NOTIONAL", "PAPER_EQUITY_MAX_NOTIONAL_PER_ORDER"),
          5_000
        ),
    maxTotalPlanNotional: processRuntime
      ? positiveInteger(env.PAPER_PLAN_MAX_TOTAL_PLAN_NOTIONAL, 50_000)
      : positive(env.PAPER_PLAN_MAX_TOTAL_PLAN_NOTIONAL, 50_000),
    equityMaxNotionalPerOrder,
    equityMaxPortfolioDeployPct: percent(env.PAPER_EQUITY_MAX_PORTFOLIO_DEPLOY_PCT, 50),
    equityMaxPositionPct: percent(env.PAPER_EQUITY_MAX_POSITION_PCT, 10),
    equityMinCashReservePct: percent(
      first(env, "PAPER_EQUITY_MIN_CASH_RESERVE_PCT", "PAPER_PLAN_MIN_BUYING_POWER_RESERVE_PCT"),
      20
    ),
    optionMaxOrderNotional: processRuntime
      ? nonNegative(
          first(env, "PAPER_OPTION_MAX_ORDER_NOTIONAL", "PAPER_OPTIONS_MAX_PREMIUM_PER_ORDER"),
          1_500
        )
      : positive(
          first(env, "PAPER_OPTION_MAX_ORDER_NOTIONAL", "PAPER_OPTIONS_MAX_PREMIUM_PER_ORDER"),
          1_500
        ),
    optionMaxContracts: Math.max(
      1,
      processRuntime
        ? nonNegativeInteger(
            first(env, "PAPER_OPTION_MAX_CONTRACTS", "PAPER_OPTIONS_MAX_CONTRACTS"),
            1
          )
        : positiveInteger(
            first(env, "PAPER_OPTION_MAX_CONTRACTS", "PAPER_OPTIONS_MAX_CONTRACTS"),
            1
          )
    ),
    optionMaxPortfolioRiskPct: percent(env.PAPER_OPTIONS_MAX_PORTFOLIO_RISK_PCT, 20),
    optionMaxPositionRiskPct: percent(env.PAPER_OPTIONS_MAX_POSITION_RISK_PCT, 5),
    quoteMaxAgeSeconds: positive(env.PAPER_SUBMIT_QUOTE_MAX_AGE_SECONDS, 60),
    maxPriceDriftPct: percent(env.PAPER_SUBMIT_MAX_PRICE_DRIFT_PCT, 10),
    zeroDteMaxTradesPerDay: processRuntime
      ? nonNegativeInteger(env.ZERO_DTE_MAX_TRADES_PER_DAY, 3)
      : Math.max(1, positiveInteger(env.ZERO_DTE_MAX_TRADES_PER_DAY, 3)),
    zeroDteMaxDailyPremium: processRuntime
      ? nonNegative(env.ZERO_DTE_MAX_DAILY_PREMIUM, 750)
      : positive(env.ZERO_DTE_MAX_DAILY_PREMIUM, 750),
    zeroDteMaxDailyRealizedLoss: processRuntime
      ? nonNegative(env.ZERO_DTE_MAX_DAILY_REALIZED_LOSS, 250)
      : positive(env.ZERO_DTE_MAX_DAILY_REALIZED_LOSS, 250),
    zeroDteMaxOpenPositions: processRuntime
      ? nonNegativeInteger(env.ZERO_DTE_MAX_OPEN_POSITIONS, 3)
      : Math.max(1, positiveInteger(env.ZERO_DTE_MAX_OPEN_POSITIONS, 3)),
    allocationIdentity: "baseline-v1"
  };
};

export const paperSubmitConfiguration = (
  env: NodeJS.ProcessEnv = process.env
): PaperSubmitConfiguration => {
  const { allocationIdentity: _allocationIdentity, ...configuration } =
    loadPaperSubmitSafetyConfig(env);
  return configuration;
};
