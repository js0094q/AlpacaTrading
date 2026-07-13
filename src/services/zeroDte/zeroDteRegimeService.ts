import type { ZeroDteDirection } from "./zeroDteTypes.js";

export type { ZeroDteDirection } from "./zeroDteTypes.js";

export type ZeroDteRegime =
  | "trend"
  | "range"
  | "high-volatility"
  | "low-volatility"
  | "event-risk"
  | "uncertain";

export type SignalEvidenceValue = number | string | boolean | null;

export interface SignalEvidence {
  code: string;
  description: string;
  value?: SignalEvidenceValue;
  threshold?: SignalEvidenceValue;
  direction?: ZeroDteDirection;
  contribution?: number;
  source?: string;
}

export interface ZeroDteBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
  vwap?: number | null;
  [key: string]: unknown;
}

export interface ZeroDteIndicators {
  vwap?: number | null;
  emaFast?: number | null;
  emaSlow?: number | null;
  emaShort?: number | null;
  emaLong?: number | null;
  ema9?: number | null;
  ema20?: number | null;
  ema50?: number | null;
  atr?: number | null;
  atr14?: number | null;
  relativeVolume?: number | null;
  realizedVolatility?: number | null;
  realizedVolatility20?: number | null;
  realizedVolatilityBaseline?: number | null;
  atrBaseline?: number | null;
  atrAcceleration?: number | null;
  volatilityIndexChangePct?: number | null;
  impliedVolatility?: number | null;
  velocity?: number | null;
  breadth?: number | null;
  crossIndexConfirmation?: boolean | null;
  trendDirection?: ZeroDteDirection | string | null;
  trendStrength?: number | null;
  multiTimeframeDirection?: Record<string, ZeroDteDirection | string | null> | null;
  rangeBound?: boolean | null;
  openingRangeHigh?: number | null;
  openingRangeLow?: number | null;
  openingRangeMinutes?: number | null;
  [key: string]: unknown;
}

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const readNumber = (source: Record<string, unknown>, names: string[]) => {
  for (const name of names) {
    const value = finite(source[name]);
    if (value !== null) {
      return value;
    }
  }
  return null;
};

const readBoolean = (source: Record<string, unknown>, names: string[]) => {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      if (value.trim().toLowerCase() === "true") return true;
      if (value.trim().toLowerCase() === "false") return false;
    }
  }
  return null;
};

const normalizeDirection = (value: unknown): ZeroDteDirection | null => {
  if (typeof value !== "string") {
    return null;
  }
  switch (value.trim().toLowerCase()) {
    case "bullish":
    case "up":
    case "long":
      return "bullish";
    case "bearish":
    case "down":
    case "short":
      return "bearish";
    case "neutral":
    case "flat":
      return "neutral";
    default:
      return null;
  }
};

const evidence = (
  code: string,
  description: string,
  value?: SignalEvidenceValue,
  threshold?: SignalEvidenceValue,
  contribution?: number
): SignalEvidence => ({
  code,
  description,
  ...(value === undefined ? {} : { value }),
  ...(threshold === undefined ? {} : { threshold }),
  ...(contribution === undefined ? {} : { contribution })
});

const unique = (values: string[]) => Array.from(new Set(values));

const normalizedVolatility = (value: number | null) => {
  if (value === null) return null;
  return value > 1 ? value / 100 : value;
};

const timeframeDirections = (indicators: ZeroDteIndicators) => {
  const raw = indicators.multiTimeframeDirection;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [] as ZeroDteDirection[];
  }
  return Object.values(raw)
    .map(normalizeDirection)
    .filter((value): value is ZeroDteDirection => value !== null);
};

export const classifyZeroDteRegime = (input: {
  indicators: ZeroDteIndicators;
  verifiedEventRisk: boolean;
}): { regime: ZeroDteRegime; evidence: SignalEvidence[]; blockers: string[] } => {
  const indicators = input.indicators ?? {};
  const evidenceRows: SignalEvidence[] = [];
  const blockers: string[] = [];

  if (input.verifiedEventRisk === true) {
    return {
      regime: "event-risk",
      evidence: [
        evidence(
          "VERIFIED_EVENT_RISK",
          "Event-risk regime is enabled by an explicitly verified calendar/source signal",
          true
        )
      ],
      blockers: []
    };
  }

  const realizedVolatility = normalizedVolatility(
    readNumber(indicators, ["realizedVolatility", "realizedVolatility20"])
  );
  const atrAcceleration = readNumber(indicators, [
    "atrAcceleration",
    "atrRatio",
    "atrExpansion"
  ]);
  const volatilityIndexChange = readNumber(indicators, [
    "volatilityIndexChangePct",
    "volatilityProxyChangePct",
    "vixChangePct"
  ]);
  const trendDirection = normalizeDirection(
    indicators.trendDirection ?? indicators.direction ?? indicators.trend
  );
  const trendStrength = readNumber(indicators, ["trendStrength", "trendScore"]);
  const timeframeVotes = timeframeDirections(indicators);
  const bullishVotes = timeframeVotes.filter((value) => value === "bullish").length;
  const bearishVotes = timeframeVotes.filter((value) => value === "bearish").length;
  const rangeBound = readBoolean(indicators, ["rangeBound", "isRangeBound"]);

  if (realizedVolatility === null && atrAcceleration === null && volatilityIndexChange === null) {
    blockers.push("MISSING_REGIME_VOLATILITY_INPUTS");
  } else {
    if (realizedVolatility !== null) {
      evidenceRows.push(
        evidence(
          realizedVolatility >= 0.3 ? "ELEVATED_REALIZED_VOLATILITY" : "REALIZED_VOLATILITY",
          "Realized volatility was evaluated without inferring event risk",
          realizedVolatility,
          0.3
        )
      );
    }
    if (atrAcceleration !== null) {
      evidenceRows.push(
        evidence("ATR_ACCELERATION", "ATR acceleration is available for regime classification", atrAcceleration, 1.5)
      );
    }
    if (volatilityIndexChange !== null) {
      evidenceRows.push(
        evidence(
          "VOLATILITY_INDEX_MOVEMENT",
          "Available volatility-index movement is treated as market data, not event evidence",
          volatilityIndexChange,
          5
        )
      );
    }
  }

  const highVolatility =
    (realizedVolatility !== null && realizedVolatility >= 0.3) ||
    (atrAcceleration !== null && atrAcceleration >= 1.5) ||
    (volatilityIndexChange !== null && Math.abs(volatilityIndexChange) >= 5);
  const lowVolatility =
    realizedVolatility !== null &&
    realizedVolatility <= 0.1 &&
    (atrAcceleration === null || atrAcceleration <= 1.1) &&
    (volatilityIndexChange === null || Math.abs(volatilityIndexChange) < 5);
  const confirmedTrend =
    (trendDirection !== null && trendDirection !== "neutral" &&
      (trendStrength === null || trendStrength >= 0.55)) ||
    (timeframeVotes.length >= 2 && Math.max(bullishVotes, bearishVotes) >= 2);

  if (highVolatility) {
    evidenceRows.push(
      evidence("HIGH_VOLATILITY_REGIME", "Volatility inputs exceed the high-volatility thresholds", true, 0.3)
    );
    return { regime: "high-volatility", evidence: evidenceRows, blockers: unique(blockers) };
  }

  if (lowVolatility) {
    evidenceRows.push(
      evidence("LOW_VOLATILITY_REGIME", "Realized volatility and ATR expansion remain subdued", true, 0.1)
    );
    return { regime: "low-volatility", evidence: evidenceRows, blockers: unique(blockers) };
  }

  if (confirmedTrend) {
    const direction =
      trendDirection && trendDirection !== "neutral"
        ? trendDirection
        : bullishVotes > bearishVotes
          ? "bullish"
          : "bearish";
    evidenceRows.push(
      evidence(
        "MULTI_TIMEFRAME_TREND",
        "Trend direction is supported by the supplied indicator set",
        direction,
        2
      )
    );
    return { regime: "trend", evidence: evidenceRows, blockers: unique(blockers) };
  }

  if (rangeBound === true || trendStrength !== null && trendStrength <= 0.35) {
    evidenceRows.push(
      evidence("RANGE_BOUND_PRICE_ACTION", "No sufficiently confirmed directional trend was observed", true)
    );
    return { regime: "range", evidence: evidenceRows, blockers: unique(blockers) };
  }

  if (!evidenceRows.length) {
    blockers.push("INSUFFICIENT_REGIME_DATA");
  }
  return { regime: "uncertain", evidence: evidenceRows, blockers: unique(blockers) };
};
