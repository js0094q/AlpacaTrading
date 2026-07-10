import type { Timeframe } from "../types.js";
import { buildHedgeConfig, type HedgeConfig } from "./hedgeConfigService.js";
import type { HedgeDataQualityStatus, MarketRegime } from "./hedgeTypes.js";
import { getBars } from "./marketDataIngest.js";

export interface RegimeBar {
  symbol?: string;
  timeframe?: string;
  timestamp: string;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
}

export interface MarketRegimeIndicators {
  requiredDataAvailable: boolean;
  spyAboveSma50: boolean;
  spyAboveSma200: boolean;
  qqqAboveSma50: boolean;
  qqqAboveSma200: boolean;
  spyBelowSma50Pct: number | null;
  spyDrawdown20Pct: number | null;
  realizedVolatility20: number | null;
  volatilityProxyLevel: number | null;
  volatilityProxyTrend: "rising" | "falling" | "flat" | null;
  recentTrendCross?: boolean;
}

export interface MarketRegimeSnapshot {
  paperOnly: true;
  generatedAt: string;
  regime: MarketRegime;
  selectedRule: string;
  modelVersion: string;
  dataQualityStatus: HedgeDataQualityStatus;
  indicators: MarketRegimeIndicators;
  warnings: string[];
  blockers: string[];
}

const snapshot = (
  regime: MarketRegime,
  selectedRule: string,
  indicators: MarketRegimeIndicators,
  config: HedgeConfig,
  generatedAt: string,
  warnings: string[] = [],
  blockers: string[] = []
): MarketRegimeSnapshot => ({
  paperOnly: true,
  generatedAt,
  regime,
  selectedRule,
  modelVersion: config.regimeModelVersion,
  dataQualityStatus: blockers.length
    ? "blocked"
    : regime === "insufficient-data"
      ? "monitoring"
      : warnings.length
        ? "partial"
        : "complete",
  indicators,
  warnings,
  blockers
});

export const classifyMarketRegimeFromIndicators = (
  indicators: MarketRegimeIndicators,
  config: HedgeConfig,
  input: { generatedAt?: string; warnings?: string[]; blockers?: string[] } = {}
): MarketRegimeSnapshot => {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const warnings = input.warnings ?? [];
  const blockers = input.blockers ?? [];
  if (!indicators.requiredDataAvailable) {
    return snapshot(
      "insufficient-data",
      "INSUFFICIENT_REQUIRED_BENCHMARK_DATA",
      indicators,
      config,
      generatedAt,
      warnings,
      blockers
    );
  }
  if ((indicators.spyBelowSma50Pct ?? 0) >= 0.1) {
    return snapshot("crisis", "CRISIS_SPY_BELOW_SMA50", indicators, config, generatedAt, warnings, blockers);
  }
  if ((indicators.spyDrawdown20Pct ?? 0) >= 0.12) {
    return snapshot("crisis", "CRISIS_SPY_DRAWDOWN", indicators, config, generatedAt, warnings, blockers);
  }
  if ((indicators.volatilityProxyLevel ?? -Infinity) >= config.regime.crisisVolatilityLevel) {
    return snapshot("crisis", "CRISIS_VOLATILITY_PROXY", indicators, config, generatedAt, warnings, blockers);
  }
  if (!indicators.spyAboveSma200 && !indicators.qqqAboveSma200) {
    return snapshot("risk-off", "RISK_OFF_LONG_TREND_BREAK", indicators, config, generatedAt, warnings, blockers);
  }
  if (
    (indicators.realizedVolatility20 ?? 0) >= config.regime.realizedVolatilityThreshold &&
    !indicators.spyAboveSma50 &&
    !indicators.qqqAboveSma50
  ) {
    return snapshot("risk-off", "RISK_OFF_VOLATILE_SHORT_TREND", indicators, config, generatedAt, warnings, blockers);
  }
  if (
    indicators.spyAboveSma50 !== indicators.qqqAboveSma50 ||
    indicators.spyAboveSma200 !== indicators.qqqAboveSma200
  ) {
    return snapshot("transition", "TRANSITION_BENCHMARK_DIVERGENCE", indicators, config, generatedAt, warnings, blockers);
  }
  if (indicators.recentTrendCross) {
    return snapshot("transition", "TRANSITION_RECENT_TREND_CROSS", indicators, config, generatedAt, warnings, blockers);
  }
  if ((indicators.realizedVolatility20 ?? 0) >= config.regime.realizedVolatilityThreshold) {
    return snapshot("transition", "TRANSITION_ELEVATED_VOLATILITY", indicators, config, generatedAt, warnings, blockers);
  }
  if (
    indicators.spyAboveSma50 &&
    indicators.spyAboveSma200 &&
    indicators.qqqAboveSma50 &&
    indicators.qqqAboveSma200
  ) {
    return snapshot("risk-on", "RISK_ON_CONFIRMED_TREND", indicators, config, generatedAt, warnings, blockers);
  }
  return snapshot("neutral", "NEUTRAL_NO_PRIORITY_RULE", indicators, config, generatedAt, warnings, blockers);
};

const closes = (bars: RegimeBar[]) =>
  bars
    .filter((bar) => Number.isFinite(bar.close) && bar.close > 0)
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
    .map((bar) => bar.close);

const average = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

const realizedVolatility = (values: number[]) => {
  const window = values.slice(-21);
  if (window.length < 21) {
    return null;
  }
  const returns = window.slice(1).map((value, index) => value / window[index]! - 1);
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    Math.max(1, returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
};

const maximumDrawdown = (values: number[]) => {
  const window = values.slice(-20);
  if (!window.length) {
    return null;
  }
  let peak = window[0]!;
  let drawdown = 0;
  for (const value of window) {
    peak = Math.max(peak, value);
    drawdown = Math.max(drawdown, peak > 0 ? (peak - value) / peak : 0);
  }
  return drawdown;
};

const trendCross = (values: number[]) => {
  if (values.length < 51) {
    return false;
  }
  const current = values.at(-1)!;
  const previous = values.at(-2)!;
  const currentSma50 = average(values.slice(-50))!;
  const previousSma50 = average(values.slice(-51, -1))!;
  const currentSma200 = average(values.slice(-200));
  const crossed = (previous <= previousSma50 && current > currentSma50) ||
    (previous >= previousSma50 && current < currentSma50);
  return crossed && currentSma200 !== null && (current > currentSma50) !== (current > currentSma200);
};

export const classifyMarketRegimeFromBars = (
  bars: Record<string, RegimeBar[]>,
  config: HedgeConfig,
  generatedAt = new Date().toISOString()
) => {
  const spy = closes(bars.SPY ?? []);
  const qqq = closes(bars.QQQ ?? []);
  const proxy = closes(bars[config.regime.volatilityProxy] ?? []);
  const requiredDataAvailable = spy.length >= 200 && qqq.length >= 200;
  const warnings: string[] = [];
  if (spy.length < 200) warnings.push("REGIME_SPY_HISTORY_INSUFFICIENT");
  if (qqq.length < 200) warnings.push("REGIME_QQQ_HISTORY_INSUFFICIENT");
  if (!proxy.length) warnings.push("REGIME_VOLATILITY_PROXY_UNAVAILABLE");

  const spyLast = spy.at(-1) ?? null;
  const qqqLast = qqq.at(-1) ?? null;
  const spySma50 = average(spy.slice(-50));
  const spySma200 = average(spy.slice(-200));
  const qqqSma50 = average(qqq.slice(-50));
  const qqqSma200 = average(qqq.slice(-200));
  const proxyAverage20 = average(proxy.slice(-20));
  const proxyLast = proxy.at(-1) ?? null;
  const indicators: MarketRegimeIndicators = {
    requiredDataAvailable,
    spyAboveSma50: spyLast !== null && spySma50 !== null && spyLast > spySma50,
    spyAboveSma200: spyLast !== null && spySma200 !== null && spyLast > spySma200,
    qqqAboveSma50: qqqLast !== null && qqqSma50 !== null && qqqLast > qqqSma50,
    qqqAboveSma200: qqqLast !== null && qqqSma200 !== null && qqqLast > qqqSma200,
    spyBelowSma50Pct:
      spyLast !== null && spySma50 !== null && spyLast < spySma50
        ? (spySma50 - spyLast) / spySma50
        : spyLast === null || spySma50 === null
          ? null
          : 0,
    spyDrawdown20Pct: maximumDrawdown(spy),
    realizedVolatility20: realizedVolatility(spy),
    volatilityProxyLevel: proxyLast,
    volatilityProxyTrend:
      proxyLast === null || proxyAverage20 === null
        ? null
        : proxyLast > proxyAverage20
          ? "rising"
          : proxyLast < proxyAverage20
            ? "falling"
            : "flat",
    recentTrendCross: trendCross(spy) || trendCross(qqq)
  };
  return classifyMarketRegimeFromIndicators(indicators, config, {
    generatedAt,
    warnings
  });
};

export const classifyMarketRegime = (
  input: { config?: HedgeConfig; asOf?: string } = {}
) => {
  const config = input.config ?? buildHedgeConfig();
  const timeframe = config.beta.observationInterval as Timeframe;
  return classifyMarketRegimeFromBars(
    {
      SPY: getBars("SPY", timeframe),
      QQQ: getBars("QQQ", timeframe),
      [config.regime.volatilityProxy]: getBars(config.regime.volatilityProxy, timeframe)
    },
    config,
    input.asOf
  );
};
