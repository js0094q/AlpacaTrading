import { config as loadDotenv } from "dotenv";
import { buildHedgeConfig } from "./services/hedgeConfigService.js";

loadDotenv();
loadDotenv({ path: ".env.txt", override: false });

const parseBoolean = (value: string | undefined) => value === "true" || value === "1";
const parseBooleanDefault = (value: string | undefined, fallback: boolean) =>
  value === undefined ? fallback : parseBoolean(value);
const parseNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseFloat(value || "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};
const parseSignedNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseFloat(value || "");
  return Number.isFinite(parsed) ? parsed : fallback;
};
const parseInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};
const parseSymbolList = (value: string | undefined, fallback: string[]) => {
  const source = value === undefined || value.trim() === "" ? fallback.join(",") : value;
  return Array.from(
    new Set(
      source
        .split(",")
        .map((entry) => entry.trim().toUpperCase())
        .filter(Boolean)
    )
  );
};

const firstEnv = (...names: string[]) => {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.trim() !== "") {
      return value.trim();
    }
  }
  return "";
};

const parseAlpacaEnv = (): "paper" | "live" => {
  const requested = (process.env.ALPACA_ENV || "paper").toLowerCase();
  return requested === "live" ? "live" : "paper";
};

const defaultSafeMode = () => {
  const tradingMode = String(process.env.TRADING_MODE || "paper").toLowerCase();
  return tradingMode !== "live" && parseAlpacaEnv() === "paper";
};

const paperOptionMaxPremiumPerContract = parseNumber(
  firstEnv("PAPER_OPTION_MAX_PREMIUM_PER_CONTRACT", "PAPER_OPTIONS_MAX_PREMIUM_PER_ORDER"),
  1500
);
const paperOptionMaxOrderNotional = parseNumber(
  firstEnv("PAPER_OPTION_MAX_ORDER_NOTIONAL", "PAPER_OPTIONS_MAX_PREMIUM_PER_ORDER"),
  1500
);
const paperOptionMaxContracts = Math.max(
  1,
  parseInteger(firstEnv("PAPER_OPTION_MAX_CONTRACTS", "PAPER_OPTIONS_MAX_CONTRACTS"), 1)
);
const paperZeroDteSpyMaxPremiumPerContract = parseNumber(
  firstEnv("PAPER_0DTE_SPY_MAX_PREMIUM_PER_CONTRACT", "PAPER_0DTE_SPY_MAX_PREMIUM_PER_TRADE"),
  250
);
const paperZeroDteSpyMaxOrderNotional = parseNumber(
  firstEnv("PAPER_0DTE_SPY_MAX_ORDER_NOTIONAL", "PAPER_0DTE_SPY_MAX_PREMIUM_PER_TRADE"),
  250
);
const paperLeapsMaxPremiumPerContract = parseNumber(
  firstEnv("PAPER_LEAPS_MAX_PREMIUM_PER_CONTRACT", "PAPER_LEAPS_MAX_PREMIUM_PER_TRADE"),
  1500
);
const paperLeapsMaxOrderNotional = parseNumber(
  firstEnv("PAPER_LEAPS_MAX_ORDER_NOTIONAL", "PAPER_LEAPS_MAX_PREMIUM_PER_TRADE"),
  1500
);

export const paperLeapsExitConfig = () => ({
  minDteAtEntry: Math.max(1, parseInteger(process.env.LEAPS_MIN_DTE_AT_ENTRY, 270)),
  dteExitThreshold: Math.max(0, parseInteger(process.env.LEAPS_DTE_EXIT_THRESHOLD, 180)),
  reviewLossPct: parseSignedNumber(process.env.LEAPS_REVIEW_LOSS_PCT, -20),
  hardStopLossPct: parseSignedNumber(process.env.LEAPS_HARD_STOP_LOSS_PCT, -35),
  partialProfitTakePct: parseSignedNumber(process.env.LEAPS_PARTIAL_PROFIT_TAKE_PCT, 75),
  fullProfitTakePct: parseSignedNumber(process.env.LEAPS_FULL_PROFIT_TAKE_PCT, 125),
  trendReviewSma: Math.max(1, parseInteger(process.env.LEAPS_TREND_REVIEW_SMA, 100)),
  severeTrendExitSma: Math.max(1, parseInteger(process.env.LEAPS_SEVERE_TREND_EXIT_SMA, 200)),
  maxBidAskSpreadPct: Math.max(0, parseNumber(process.env.LEAPS_MAX_BID_ASK_SPREAD_PCT, 20)),
  minDeltaReview: Math.max(0, parseNumber(process.env.LEAPS_MIN_DELTA_REVIEW, 0.45)),
  reviewIntervalDays: Math.max(1, parseInteger(process.env.LEAPS_REVIEW_INTERVAL_DAYS, 30))
});

export const config = {
  alpacaEnv: parseAlpacaEnv(),
  paperByDefault:
    process.env.ALPACA_LIVE_TRADE === "true" ||
    process.env.LIVE_TRADING_ENABLED === "true"
      ? false
      : parseAlpacaEnv() === "paper",
  liveTradingEnabled: process.env.LIVE_TRADING_ENABLED === "true",
  marketDataProvider: process.env.MARKET_DATA_PROVIDER || "alpaca",
  tradingMode: process.env.TRADING_MODE || "paper",
  enableOptionsResearch: process.env.ENABLE_OPTIONS_RESEARCH !== "false",
  paperOrderExecutionEnabled: parseBoolean(process.env.PAPER_ORDER_EXECUTION_ENABLED),
  paperOptionsExecutionEnabled: parseBoolean(process.env.PAPER_OPTIONS_EXECUTION_ENABLED),
  paperEquity: {
    notionalPerOrder: parseNumber(process.env.PAPER_EQUITY_NOTIONAL_PER_ORDER, 1000),
    maxNotionalPerOrder: parseNumber(process.env.PAPER_EQUITY_MAX_NOTIONAL_PER_ORDER, 5000),
    maxPortfolioDeployPct: parseNumber(process.env.PAPER_EQUITY_MAX_PORTFOLIO_DEPLOY_PCT, 50),
    maxPositionPct: parseNumber(process.env.PAPER_EQUITY_MAX_POSITION_PCT, 10),
    minCashReservePct: parseNumber(process.env.PAPER_EQUITY_MIN_CASH_RESERVE_PCT, 20)
  },
  paperOptions: {
    maxPremiumPerOrder: paperOptionMaxOrderNotional,
    maxPremiumPerContract: paperOptionMaxPremiumPerContract,
    maxOrderNotional: paperOptionMaxOrderNotional,
    maxContracts: paperOptionMaxContracts,
    minDte: parseInteger(process.env.PAPER_OPTIONS_MIN_DTE, 0),
    maxDte: Math.max(1, parseInteger(process.env.PAPER_OPTIONS_MAX_DTE, 90)),
    allow0Dte: parseBooleanDefault(
      process.env.ALLOW_0DTE_OPTIONS ?? process.env.PAPER_OPTIONS_ALLOW_0DTE,
      false
    ),
    allowMarketOrders: parseBoolean(process.env.PAPER_OPTIONS_ALLOW_MARKET_ORDERS),
    quoteMaxAgeMs: parseInteger(process.env.OPTIONS_QUOTE_MAX_AGE_MS, 15 * 60 * 1000),
    allowLastPriceFallback: parseBoolean(process.env.ALLOW_OPTIONS_LAST_PRICE_FALLBACK),
    limitPriceBasis: process.env.PAPER_OPTIONS_LIMIT_PRICE_BASIS || "mid",
    maxSpreadPct: parseNumber(process.env.PAPER_OPTIONS_MAX_SPREAD_PCT, 50),
    hardSpreadCapEnabled: parseBoolean(process.env.PAPER_OPTIONS_HARD_SPREAD_CAP_ENABLED),
    maxPortfolioRiskPct: parseNumber(process.env.PAPER_OPTIONS_MAX_PORTFOLIO_RISK_PCT, 20),
    maxPositionRiskPct: parseNumber(process.env.PAPER_OPTIONS_MAX_POSITION_RISK_PCT, 5),
    allowLongCalls: parseBooleanDefault(process.env.PAPER_OPTIONS_ALLOW_LONG_CALLS, true),
    allowLongPuts: parseBooleanDefault(process.env.PAPER_OPTIONS_ALLOW_LONG_PUTS, true),
    allowCashSecuredPuts: parseBooleanDefault(process.env.PAPER_OPTIONS_ALLOW_CASH_SECURED_PUTS, true),
    allowCoveredCalls: parseBooleanDefault(process.env.PAPER_OPTIONS_ALLOW_COVERED_CALLS, true),
    allowNakedOptions: parseBoolean(process.env.PAPER_OPTIONS_ALLOW_NAKED_OPTIONS)
  },
  paperOptionLearningLedgerEnabled: parseBooleanDefault(
    process.env.PAPER_OPTION_LEARNING_LEDGER_ENABLED,
    true
  ),
  paperZeroDteSpy: {
    enabled:
      parseBoolean(process.env.PAPER_0DTE_SPY_ENABLED) ||
      parseBoolean(process.env.PAPER_0DTE_DISCOVERY_ENABLED),
    underlyings: parseSymbolList(process.env.PAPER_0DTE_SPY_UNDERLYINGS, ["SPY"]),
    maxPremiumPerTrade: paperZeroDteSpyMaxOrderNotional,
    maxPremiumPerContract: Math.min(
      paperOptionMaxPremiumPerContract,
      paperZeroDteSpyMaxPremiumPerContract
    ),
    maxOrderNotional: Math.min(paperOptionMaxOrderNotional, paperZeroDteSpyMaxOrderNotional),
    maxContracts: Math.min(
      paperOptionMaxContracts,
      Math.max(1, parseInteger(process.env.PAPER_0DTE_SPY_MAX_CONTRACTS, paperOptionMaxContracts))
    ),
    maxDailyTrades: Math.max(1, parseInteger(process.env.PAPER_0DTE_SPY_MAX_DAILY_TRADES, 3)),
    maxQuoteAgeSeconds: Math.max(1, parseInteger(process.env.PAPER_0DTE_SPY_MAX_QUOTE_AGE_SECONDS, 60)),
    maxSpreadPct: parseNumber(process.env.PAPER_0DTE_SPY_MAX_SPREAD_PCT, 20),
    hardSpreadCapEnabled: parseBooleanDefault(
      process.env.PAPER_0DTE_SPY_HARD_SPREAD_CAP_ENABLED,
      parseBoolean(process.env.PAPER_OPTIONS_HARD_SPREAD_CAP_ENABLED)
    )
  },
  paperLeaps: {
    enabled: parseBoolean(process.env.PAPER_LEAPS_ENABLED),
    underlyings: parseSymbolList(process.env.PAPER_LEAPS_UNDERLYINGS, ["SPY", "QQQ"]),
    maxPremiumPerTrade: paperLeapsMaxOrderNotional,
    maxPremiumPerContract: Math.min(
      paperOptionMaxPremiumPerContract,
      paperLeapsMaxPremiumPerContract
    ),
    maxOrderNotional: Math.min(paperOptionMaxOrderNotional, paperLeapsMaxOrderNotional),
    maxContracts: Math.min(
      paperOptionMaxContracts,
      Math.max(1, parseInteger(process.env.PAPER_LEAPS_MAX_CONTRACTS, paperOptionMaxContracts))
    ),
    minDte: parseInteger(process.env.PAPER_LEAPS_MIN_DTE, 180),
    maxDte: Math.max(1, parseInteger(process.env.PAPER_LEAPS_MAX_DTE, 730)),
    maxSpreadPct: parseNumber(process.env.PAPER_LEAPS_MAX_SPREAD_PCT, 15),
    hardSpreadCapEnabled: parseBooleanDefault(
      process.env.PAPER_LEAPS_HARD_SPREAD_CAP_ENABLED,
      parseBoolean(process.env.PAPER_OPTIONS_HARD_SPREAD_CAP_ENABLED)
    )
  },
  paperLeapsExit: paperLeapsExitConfig(),
  hedge: buildHedgeConfig(),
  enableAggressivePaperStrategies:
    process.env.ENABLE_AGGRESSIVE_PAPER_STRATEGIES === "true",
  enableShortResearch: process.env.ENABLE_SHORT_RESEARCH !== "false",
  safeMode: defaultSafeMode(),
  alpaca: {
    paperKey: firstEnv(
      "ALPACA_PAPER_API_KEY",
      "ALPACA_PAPER_KEY",
      "ALPACA_API_KEY"
    ),
    paperSecret: firstEnv(
      "ALPACA_PAPER_SECRET_KEY",
      "ALPACA_PAPER_SECRET",
      "ALPACA_SECRET_KEY"
    ),
    liveKey: firstEnv("ALPACA_LIVE_KEY", "ALPACA_LIVE_API_KEY"),
    liveSecret: firstEnv("ALPACA_LIVE_SECRET", "ALPACA_LIVE_SECRET_KEY"),
    paperBaseUrl:
      firstEnv("ALPACA_PAPER_BASE_URL") || "https://paper-api.alpaca.markets",
    liveBaseUrl:
      firstEnv("ALPACA_LIVE_BASE_URL") || "https://api.alpaca.markets",
    dataBaseUrl: firstEnv("ALPACA_DATA_BASE_URL") || "https://data.alpaca.markets",
    requestTimeoutMs:
      Number.parseInt(process.env.ALPACA_REQUEST_TIMEOUT_MS || "15000", 10) || 15000,
    maxRetries: parseInteger(process.env.ALPACA_MAX_RETRIES, 2),
    userAgent: process.env.ALPACA_USER_AGENT || "alpaca-research-cli"
  }
};
