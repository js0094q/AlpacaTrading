import { atr, ema, rollingStd } from "../indicators.js";
import { clamp } from "../../lib/utils.js";
import type { ZeroDteDirection, ZeroDtePlaybook } from "./zeroDteTypes.js";
import type {
  SignalEvidence,
  SignalEvidenceValue,
  ZeroDteBar,
  ZeroDteIndicators,
  ZeroDteRegime
} from "./zeroDteRegimeService.js";

export type { ZeroDteDirection } from "./zeroDteTypes.js";
export type {
  SignalEvidence,
  SignalEvidenceValue,
  ZeroDteBar,
  ZeroDteIndicators,
  ZeroDteRegime
} from "./zeroDteRegimeService.js";

export interface ZeroDteOptionQuote {
  symbol?: string | null;
  side?: string | null;
  direction?: ZeroDteDirection | null;
  bid?: number | null;
  ask?: number | null;
  midpoint?: number | null;
  spreadPct?: number | null;
  volume?: number | null;
  openInterest?: number | null;
  gamma?: number | null;
  delta?: number | null;
  impliedVolatility?: number | null;
  quoteTimestamp?: string | null;
  [key: string]: unknown;
}

export interface ZeroDteOpeningRange {
  high: number;
  low: number;
  minutes?: number | null;
  start?: string | null;
  end?: string | null;
  source?: string | null;
}

export interface ZeroDtePlaybookContext {
  underlying: string;
  price: number;
  barsByTimeframe: Record<string, ZeroDteBar[]>;
  option: ZeroDteOptionQuote;
  indicators: ZeroDteIndicators;
  regime: ZeroDteRegime;
  asOf: string;
  eventCalendarEvidence: string[];
  direction?: ZeroDteDirection;
  openingRange?: ZeroDteOpeningRange;
  openingRangeMinutes?: number;
}

export type PlaybookEvaluationStatus = "ready" | "blocked" | "insufficient_data";

export interface PlaybookEvaluation {
  playbook: ZeroDtePlaybook;
  score: number;
  confidence: number;
  direction: ZeroDteDirection;
  eligible: boolean;
  status: PlaybookEvaluationStatus;
  supportingSignals: SignalEvidence[];
  opposingSignals: SignalEvidence[];
  blockers: string[];
  missingInputs: string[];
  componentContributions: Record<string, number>;
  components: Record<string, number>;
  contributions: Record<string, number>;
  metadata?: Record<string, SignalEvidenceValue | Record<string, unknown>>;
}

interface SignalCollector {
  supportingSignals: SignalEvidence[];
  opposingSignals: SignalEvidence[];
  blockers: string[];
  missingInputs: string[];
}

interface DerivedMarketContext {
  bars: ZeroDteBar[];
  closes: number[];
  price: number | null;
  previousClose: number | null;
  vwap: number | null;
  emaFast: number | null;
  emaSlow: number | null;
  atr: number | null;
  relativeVolume: number | null;
  realizedVolatility: number | null;
  realizedVolatilityBaseline: number | null;
  atrAcceleration: number | null;
  rangeBreak: boolean | null;
  volatilityIndexMovement: number | null;
  impliedVolatility: number | null;
  velocity: number | null;
  breadth: number | null;
  crossIndexConfirmation: boolean | null;
  timeframeDirections: ZeroDteDirection[];
}

interface FinalizeInput {
  playbook: ZeroDtePlaybook;
  direction: ZeroDteDirection;
  components: Record<string, number>;
  scoreAdjustment?: number;
  confidence: number;
  threshold: number;
  collector: SignalCollector;
  status?: PlaybookEvaluationStatus;
  metadata?: Record<string, SignalEvidenceValue | Record<string, unknown>>;
}

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const readNumber = (source: Record<string, unknown>, names: string[]) => {
  for (const name of names) {
    const value = finite(source[name]);
    if (value !== null) return value;
  }
  return null;
};

const readBoolean = (source: Record<string, unknown>, names: string[]) => {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value.trim().toLowerCase() === "true") return true;
      if (value.trim().toLowerCase() === "false") return false;
    }
    if (typeof value === "number" && (value === 0 || value === 1)) {
      return value === 1;
    }
  }
  return null;
};

const readString = (source: Record<string, unknown>, names: string[]) => {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
};

const normalizeDirection = (value: unknown): ZeroDteDirection | null => {
  if (typeof value !== "string") return null;
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

const unique = (values: string[]) => Array.from(new Set(values));

const addMissing = (collector: SignalCollector, input: string) => {
  if (!collector.missingInputs.includes(input)) collector.missingInputs.push(input);
};

const addBlocker = (collector: SignalCollector, blocker: string) => {
  if (!collector.blockers.includes(blocker)) collector.blockers.push(blocker);
};

const makeEvidence = (
  code: string,
  description: string,
  value?: SignalEvidenceValue,
  direction?: ZeroDteDirection,
  contribution?: number
): SignalEvidence => ({
  code,
  description,
  ...(value === undefined ? {} : { value }),
  ...(direction === undefined ? {} : { direction }),
  ...(contribution === undefined ? {} : { contribution })
});

const orderedBars = (bars: ZeroDteBar[] | undefined): ZeroDteBar[] =>
  (bars ?? [])
    .filter(
      (bar) =>
        finite(bar.open) !== null &&
        finite(bar.high) !== null &&
        finite(bar.low) !== null &&
        finite(bar.close) !== null
    )
    .map((bar) => ({ ...bar }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.timestamp);
      const rightTime = Date.parse(right.timestamp);
      if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 0;
      return leftTime - rightTime;
    });

const primaryBars = (context: ZeroDtePlaybookContext) => {
  const entries = Object.entries(context.barsByTimeframe ?? {});
  const preferred = ["1min", "1m", "5min", "5m", "15min", "15m"];
  for (const name of preferred) {
    const found = entries.find(([key]) => key.toLowerCase().replace(/[^a-z0-9]/g, "") === name);
    if (found) return orderedBars(found[1]);
  }
  const fallback = entries.find(([key]) => !key.toLowerCase().includes("opening"));
  return orderedBars(fallback?.[1]);
};

const mean = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

const deriveVwap = (indicators: ZeroDteIndicators, bars: ZeroDteBar[]) => {
  const configured = readNumber(indicators, ["vwap", "sessionVwap"]);
  if (configured !== null) return configured;
  const lastBarVwap = finite(bars.at(-1)?.vwap);
  if (lastBarVwap !== null) return lastBarVwap;
  const volumeRows = bars
    .map((bar) => ({
      volume: finite(bar.volume),
      typical: (bar.high + bar.low + bar.close) / 3
    }))
    .filter((row) => row.volume !== null && row.volume > 0);
  const totalVolume = volumeRows.reduce((sum, row) => sum + (row.volume ?? 0), 0);
  return totalVolume > 0
    ? volumeRows.reduce((sum, row) => sum + row.typical * (row.volume ?? 0), 0) / totalVolume
    : mean(bars.map((bar) => bar.close));
};

const deriveAtr = (indicators: ZeroDteIndicators, bars: ZeroDteBar[]) => {
  const configured = readNumber(indicators, ["atr", "atr14", "atrValue"]);
  if (configured !== null && configured > 0) return configured;
  const calculated = atr(
    bars.map((bar) => bar.high),
    bars.map((bar) => bar.low),
    bars.map((bar) => bar.close),
    14
  );
  if (calculated !== null && calculated > 0) return calculated;
  return mean(bars.map((bar) => bar.high - bar.low));
};

const deriveRelativeVolume = (indicators: ZeroDteIndicators, bars: ZeroDteBar[]) => {
  const configured = readNumber(indicators, ["relativeVolume", "rvol"]);
  if (configured !== null) return configured;
  const lastVolume = finite(bars.at(-1)?.volume);
  const previousVolumes = bars
    .slice(0, -1)
    .map((bar) => finite(bar.volume))
    .filter((value): value is number => value !== null && value > 0)
    .slice(-20);
  const baseline = mean(previousVolumes);
  return lastVolume !== null && baseline !== null && baseline > 0 ? lastVolume / baseline : null;
};

const deriveTimeframeDirections = (
  context: ZeroDtePlaybookContext,
  indicators: ZeroDteIndicators
) => {
  const configured = asRecord(indicators.multiTimeframeDirection);
  const configuredDirections = Object.values(configured)
    .map(normalizeDirection)
    .filter((value): value is ZeroDteDirection => value !== null);
  if (configuredDirections.length) return configuredDirections;

  return Object.entries(context.barsByTimeframe ?? {})
    .filter(([key]) => !key.toLowerCase().includes("opening"))
    .map(([, bars]) => orderedBars(bars))
    .filter((bars) => bars.length >= 2)
    .map((bars) => {
      const change = bars.at(-1)!.close - bars[0]!.close;
      return change > 0 ? "bullish" : change < 0 ? "bearish" : "neutral";
    });
};

const deriveRangeBreak = (indicators: ZeroDteIndicators, bars: ZeroDteBar[]) => {
  const configured = readBoolean(indicators, ["rangeBreak", "breakoutConfirmed"]);
  if (configured !== null) return configured;
  if (bars.length < 2) return null;
  const current = bars.at(-1)!.close;
  const previous = bars.slice(Math.max(0, bars.length - 11), -1);
  if (!previous.length) return null;
  const priorHigh = Math.max(...previous.map((bar) => bar.high));
  const priorLow = Math.min(...previous.map((bar) => bar.low));
  return current > priorHigh || current < priorLow;
};

const deriveAtrAcceleration = (indicators: ZeroDteIndicators, bars: ZeroDteBar[], currentAtr: number | null) => {
  const configured = readNumber(indicators, ["atrAcceleration", "atrRatio", "atrExpansion"]);
  if (configured !== null) return configured;
  const baseline = readNumber(indicators, ["atrBaseline", "baselineAtr"]);
  if (currentAtr !== null && baseline !== null && baseline > 0) return currentAtr / baseline;
  if (bars.length < 4) return null;
  const recentRange = bars.at(-1)!.high - bars.at(-1)!.low;
  const baselineRange = mean(bars.slice(0, -1).slice(-10).map((bar) => bar.high - bar.low));
  return baselineRange !== null && baselineRange > 0 ? recentRange / baselineRange : null;
};

const deriveVelocity = (indicators: ZeroDteIndicators, bars: ZeroDteBar[], currentAtr: number | null) => {
  const configured = readNumber(indicators, ["velocity", "priceVelocity"]);
  if (configured !== null) return configured;
  if (bars.length < 2 || currentAtr === null || currentAtr <= 0) return null;
  return (bars.at(-1)!.close - bars.at(-2)!.close) / currentAtr;
};

const deriveMarketContext = (context: ZeroDtePlaybookContext): DerivedMarketContext => {
  const indicators = context.indicators ?? {};
  const bars = primaryBars(context);
  const closes = bars.map((bar) => bar.close);
  const price = finite(context.price) ?? closes.at(-1) ?? null;
  const previousClose = closes.length >= 2 ? closes.at(-2)! : null;
  const currentAtr = deriveAtr(indicators, bars);
  const returns = closes.slice(1).map((close, index) => close / closes[index]! - 1);
  const configuredRealizedVolatility = readNumber(indicators, [
    "realizedVolatility",
    "realizedVolatility20"
  ]);
  const realizedVolatility =
    configuredRealizedVolatility ??
    (returns.length >= 2 ? rollingStd(returns, Math.min(20, returns.length)) : null);
  const configuredBaseline = readNumber(indicators, [
    "realizedVolatilityBaseline",
    "realizedVolatilityBaseline20"
  ]);
  const realizedVolatilityBaseline = configuredBaseline ?? mean(returns.slice(0, -5).map(Math.abs));
  const emaFast =
    readNumber(indicators, ["emaFast", "emaShort", "ema9"]) ?? ema(closes, 9);
  const emaSlow =
    readNumber(indicators, ["emaSlow", "emaLong", "ema20", "ema50"]) ?? ema(closes, 20);

  return {
    bars,
    closes,
    price,
    previousClose,
    vwap: deriveVwap(indicators, bars),
    emaFast,
    emaSlow,
    atr: currentAtr,
    relativeVolume: deriveRelativeVolume(indicators, bars),
    realizedVolatility,
    realizedVolatilityBaseline,
    atrAcceleration: deriveAtrAcceleration(indicators, bars, currentAtr),
    rangeBreak: deriveRangeBreak(indicators, bars),
    volatilityIndexMovement: readNumber(indicators, [
      "volatilityIndexChangePct",
      "volatilityProxyChangePct",
      "vixChangePct"
    ]),
    impliedVolatility:
      finite(context.option.impliedVolatility) ?? readNumber(indicators, ["impliedVolatility", "iv"]),
    velocity: deriveVelocity(indicators, bars, currentAtr),
    breadth: readNumber(indicators, ["breadth", "marketBreadth"]),
    crossIndexConfirmation: readBoolean(indicators, [
      "crossIndexConfirmation",
      "crossMarketConfirmation"
    ]),
    timeframeDirections: deriveTimeframeDirections(context, indicators)
  };
};

const optionLiquidityScore = (
  context: ZeroDtePlaybookContext,
  _derived: DerivedMarketContext,
  collector: SignalCollector
): number | null => {
  const quote = context.option;
  const quoteRecord = asRecord(quote);
  const quoteStatus = readString(quoteRecord, ["quoteStatus", "quote_status", "status"]);
  const executable = readBoolean(quoteRecord, ["executable"]);
  const bid = finite(quote.bid);
  const ask = finite(quote.ask);
  if (quoteStatus !== null && quoteStatus.toLowerCase() !== "valid") {
    addBlocker(collector, `OPTION_QUOTE_${quoteStatus.toUpperCase()}`);
    return null;
  }
  if (executable === false) {
    addBlocker(collector, "OPTION_QUOTE_NOT_EXECUTABLE");
    return null;
  }
  if (bid !== null && ask !== null && ask < bid) {
    addBlocker(collector, "OPTION_QUOTE_CROSSED");
    return null;
  }
  const configured = readNumber(context.indicators, ["liquidityScore", "optionLiquidityScore"]);
  if (configured !== null) return clamp(configured, 0, 100);
  const midpoint = finite(quote.midpoint) ?? (bid !== null && ask !== null ? (bid + ask) / 2 : null);
  const spreadPct =
    finite(quote.spreadPct) ??
    (bid !== null && ask !== null && midpoint !== null && midpoint > 0
      ? ((ask - bid) / midpoint) * 100
      : null);
  const volume = finite(quote.volume);
  const openInterest = readNumber(asRecord(quote), ["openInterest", "open_interest", "oi"]);
  if (spreadPct === null && volume === null && openInterest === null) return null;

  const spreadScore = spreadPct === null ? 50 : clamp(100 - spreadPct * 4, 0, 100);
  const volumeScore = volume === null ? 50 : clamp((volume / 1_000) * 100, 0, 100);
  const openInterestScore = openInterest === null ? 50 : clamp((openInterest / 5_000) * 100, 0, 100);
  return clamp((spreadScore + volumeScore + openInterestScore) / 3, 0, 100);
};

const directionSign = (direction: ZeroDteDirection) =>
  direction === "bullish" ? 1 : direction === "bearish" ? -1 : 0;

const addDirectionalMagnitude = (input: {
  collector: SignalCollector;
  value: number | null;
  scale: number;
  maxPoints: number;
  direction: ZeroDteDirection;
  missingInput: string;
  supportingCode: string;
  opposingCode: string;
  supportingDescription: string;
  opposingDescription: string;
}) => {
  if (input.value === null || !Number.isFinite(input.scale) || input.scale <= 0) {
    addMissing(input.collector, input.missingInput);
    return 0;
  }
  const magnitude = clamp(Math.abs(input.value) / input.scale, 0, 1);
  const sign = directionSign(input.direction);
  const aligned = sign === 0 ? input.value !== 0 : input.value * sign > 0;
  const contribution = magnitude * input.maxPoints;
  if (aligned && contribution > 0) {
    input.collector.supportingSignals.push(
      makeEvidence(
        input.supportingCode,
        input.supportingDescription,
        input.value,
        input.direction,
        contribution
      )
    );
    return contribution;
  }
  if (input.value !== 0) {
    input.collector.opposingSignals.push(
      makeEvidence(
        input.opposingCode,
        input.opposingDescription,
        input.value,
        input.direction
      )
    );
  }
  return 0;
};

const addPositiveSignal = (input: {
  collector: SignalCollector;
  value: number | boolean | null;
  maxPoints: number;
  scale?: number;
  missingInput: string;
  supportingCode: string;
  opposingCode: string;
  supportingDescription: string;
  opposingDescription: string;
  direction?: ZeroDteDirection;
}) => {
  if (input.value === null) {
    addMissing(input.collector, input.missingInput);
    return 0;
  }
  const numeric = typeof input.value === "boolean" ? (input.value ? 1 : 0) : input.value;
  const positive = numeric > 0;
  const contribution = positive
    ? input.maxPoints * clamp(numeric / (input.scale ?? 1), 0, 1)
    : 0;
  if (positive) {
    input.collector.supportingSignals.push(
      makeEvidence(input.supportingCode, input.supportingDescription, input.value, input.direction, contribution)
    );
  } else {
    input.collector.opposingSignals.push(
      makeEvidence(input.opposingCode, input.opposingDescription, input.value, input.direction)
    );
  }
  return contribution;
};

const addBooleanSignal = (input: {
  collector: SignalCollector;
  value: boolean | null;
  maxPoints: number;
  missingInput: string;
  supportingCode: string;
  opposingCode: string;
  supportingDescription: string;
  opposingDescription: string;
  direction?: ZeroDteDirection;
}) =>
  addPositiveSignal({
    ...input,
    value: input.value,
    scale: 1
  });

const addLiquiditySignal = (
  collector: SignalCollector,
  liquidityScore: number | null,
  maxPoints: number,
  direction?: ZeroDteDirection
) => {
  if (liquidityScore === null) {
    addMissing(collector, "optionLiquidity");
    return 0;
  }
  const contribution = clamp(liquidityScore / 100, 0, 1) * maxPoints;
  if (liquidityScore >= 50) {
    collector.supportingSignals.push(
      makeEvidence("LIQUIDITY_SUPPORT", "Option quote liquidity supports the setup", liquidityScore, direction, contribution)
    );
  } else {
    collector.opposingSignals.push(
      makeEvidence("LIQUIDITY_CONSTRAINT", "Option quote liquidity is below the preferred level", liquidityScore, direction)
    );
  }
  return contribution;
};

const addTimeframeSignal = (
  collector: SignalCollector,
  directions: ZeroDteDirection[],
  direction: ZeroDteDirection,
  maxPoints: number
) => {
  if (!directions.length) {
    addMissing(collector, "multiTimeframeDirection");
    return 0;
  }
  const target = directions.filter((value) => value === direction).length;
  const opposing = directions.filter(
    (value) => direction !== "neutral" && value !== direction && value !== "neutral"
  ).length;
  if (opposing > 0) {
    collector.opposingSignals.push(
      makeEvidence("MULTI_TIMEFRAME_OPPOSITION", "At least one supplied timeframe opposes the evaluated direction", opposing, direction)
    );
  }
  if (target <= 0) return 0;
  const contribution = (target / directions.length) * maxPoints;
  collector.supportingSignals.push(
    makeEvidence("MULTI_TIMEFRAME_ALIGNMENT", "Multiple timeframes align with the evaluated direction", target, direction, contribution)
  );
  return contribution;
};

const coreCollector = (derived: DerivedMarketContext) => {
  const collector: SignalCollector = {
    supportingSignals: [],
    opposingSignals: [],
    blockers: [],
    missingInputs: []
  };
  if (derived.price === null) {
    addMissing(collector, "price");
    addBlocker(collector, "MISSING_PRICE");
  }
  if (derived.bars.length < 2) {
    addMissing(collector, "bars");
    addBlocker(collector, "INSUFFICIENT_BARS");
  }
  return collector;
};

const finalize = (input: FinalizeInput): PlaybookEvaluation => {
  const componentContributions = Object.fromEntries(
    Object.entries(input.components).map(([key, value]) => [key, Number.isFinite(value) ? value : 0])
  );
  const rawScore = Object.values(componentContributions).reduce((sum, value) => sum + value, 0) + (input.scoreAdjustment ?? 0);
  const score = clamp(Number.isFinite(rawScore) ? rawScore : 0, 0, 100);
  const missingInputs = unique(input.collector.missingInputs);
  const blockers = unique([
    ...input.collector.blockers,
    ...(input.direction === "neutral" ? ["NEUTRAL_DIRECTION_NOT_EXECUTABLE"] : [])
  ]);
  const eligible = blockers.length === 0 && score >= input.threshold;
  const status = input.status ?? (blockers.length ? "blocked" : "ready");
  const components = { ...componentContributions };
  const contributions = { ...componentContributions };
  return {
    playbook: input.playbook,
    score,
    confidence: clamp(input.confidence, 0, 100),
    direction: input.direction,
    eligible,
    status,
    supportingSignals: [...input.collector.supportingSignals],
    opposingSignals: [...input.collector.opposingSignals],
    blockers,
    missingInputs,
    componentContributions,
    components,
    contributions,
    ...(input.metadata ? { metadata: { ...input.metadata } } : {})
  };
};

const resolveDirections = (context: ZeroDtePlaybookContext): ZeroDteDirection[] => {
  if (context.direction) return [context.direction];
  const option = context.option ?? {};
  const explicit = normalizeDirection(option.direction);
  if (explicit) return [explicit];
  const side = readString(option, ["side", "optionType", "type"]);
  if (side?.toLowerCase() === "call" || side?.toLowerCase() === "c") return ["bullish"];
  if (side?.toLowerCase() === "put" || side?.toLowerCase() === "p") return ["bearish"];
  return ["bullish", "bearish"];
};

const evaluateTrendContinuation = (
  context: ZeroDtePlaybookContext,
  direction: ZeroDteDirection,
  derived: DerivedMarketContext
) => {
  const collector = coreCollector(derived);
  const liquidity = optionLiquidityScore(context, derived, collector);
  const components = {
    vwapDistance: addDirectionalMagnitude({
      collector,
      value: derived.price !== null && derived.vwap !== null ? derived.price - derived.vwap : null,
      scale: Math.max((derived.atr ?? 0) * 2, Math.abs(derived.price ?? 0) * 0.002, 0.01),
      maxPoints: 20,
      direction,
      missingInput: "vwap",
      supportingCode: "VWAP_DIRECTIONAL_DISTANCE",
      opposingCode: "VWAP_OPPOSES_DIRECTION",
      supportingDescription: "Price is displaced from VWAP in the evaluated direction",
      opposingDescription: "Price is displaced from VWAP against the evaluated direction"
    }),
    emaAlignment: addDirectionalMagnitude({
      collector,
      value: derived.emaFast !== null && derived.emaSlow !== null ? derived.emaFast - derived.emaSlow : null,
      scale: Math.max((derived.atr ?? 0) * 1.5, Math.abs(derived.emaSlow ?? 0) * 0.005, 0.01),
      maxPoints: 20,
      direction,
      missingInput: "emaAlignment",
      supportingCode: "EMA_ALIGNMENT",
      opposingCode: "EMA_OPPOSITION",
      supportingDescription: "Fast and slow EMA alignment supports the evaluated direction",
      opposingDescription: "Fast and slow EMA alignment opposes the evaluated direction"
    }),
    multiTimeframeAlignment: addTimeframeSignal(
      collector,
      derived.timeframeDirections,
      direction,
      20
    ),
    relativeVolume: addPositiveSignal({
      collector,
      value: derived.relativeVolume === null ? null : derived.relativeVolume - 1,
      maxPoints: 15,
      scale: 1,
      missingInput: "relativeVolume",
      supportingCode: "RELATIVE_VOLUME_SUPPORT",
      opposingCode: "RELATIVE_VOLUME_CONSTRAINT",
      supportingDescription: "Relative volume confirms participation in the move",
      opposingDescription: "Relative volume does not confirm participation"
    }),
    atrNormalizedDisplacement: addDirectionalMagnitude({
      collector,
      value:
        derived.previousClose !== null && derived.price !== null && derived.atr !== null && derived.atr > 0
          ? (derived.price - derived.previousClose) / derived.atr
          : null,
      scale: 1.5,
      maxPoints: 15,
      direction,
      missingInput: "atrNormalizedDisplacement",
      supportingCode: "ATR_NORMALIZED_DISPLACEMENT",
      opposingCode: "ATR_DISPLACEMENT_OPPOSITION",
      supportingDescription: "Recent displacement persists in the evaluated direction",
      opposingDescription: "Recent displacement opposes the evaluated direction"
    }),
    liquidity: addLiquiditySignal(collector, liquidity, 10, direction)
  };
  const available = Object.values(components).filter((value) => value > 0).length;
  return finalize({
    playbook: "trend_continuation",
    direction,
    components,
    confidence: clamp((available / Object.keys(components).length) * 100, 0, 100),
    threshold: 55,
    collector
  });
};

const booleanOrDirectional = (
  source: Record<string, unknown>,
  names: string[],
  direction: ZeroDteDirection
) => {
  const value = names
    .map((name) => source[name])
    .find((candidate) => candidate !== undefined && candidate !== null);
  if (typeof value === "boolean") return value;
  const configuredDirection = normalizeDirection(value);
  return configuredDirection === null ? null : configuredDirection === direction;
};

const evaluateReversal = (
  context: ZeroDtePlaybookContext,
  direction: ZeroDteDirection,
  derived: DerivedMarketContext
) => {
  const collector = coreCollector(derived);
  const liquidity = optionLiquidityScore(context, derived, collector);
  const indicators = context.indicators;
  const priorDirection =
    normalizeDirection(readString(indicators, ["lastMoveDirection", "priorDirection", "momentumDirection"])) ??
    (derived.previousClose !== null && derived.price !== null
      ? derived.price > derived.previousClose
        ? "bullish"
        : derived.price < derived.previousClose
          ? "bearish"
          : null
      : null);
  const oppositeDirection = direction === "bullish" ? "bearish" : "bullish";
  const extension =
    derived.price !== null && derived.vwap !== null && derived.atr !== null && derived.atr > 0
      ? Math.abs(derived.price - derived.vwap) / derived.atr
      : null;
  const extensionSupport =
    priorDirection === null ? null : priorDirection === oppositeDirection;
  const exhaustion = readNumber(indicators, ["exhaustion", "exhaustionScore"]);
  const exhaustionSignal =
    exhaustion !== null
      ? addPositiveSignal({
          collector,
          value: exhaustion,
          maxPoints: 15,
          scale: 1,
          missingInput: "exhaustion",
          supportingCode: "EXHAUSTION_CONFIRMATION",
          opposingCode: "EXHAUSTION_NOT_CONFIRMED",
          supportingDescription: "Exhaustion evidence supports a reversal setup",
          opposingDescription: "Exhaustion evidence is below the reversal threshold",
          direction
        })
      : addBooleanSignal({
          collector,
          value: readBoolean(indicators, ["exhaustion"]),
          maxPoints: 15,
          missingInput: "exhaustion",
          supportingCode: "EXHAUSTION_CONFIRMATION",
          opposingCode: "EXHAUSTION_NOT_CONFIRMED",
          supportingDescription: "Exhaustion evidence supports a reversal setup",
          opposingDescription: "Exhaustion evidence is not confirmed",
          direction
        });
  const failedBreak = booleanOrDirectional(indicators, ["failedBreak", "failedBreakDirection"], direction);
  const reversalCandle = booleanOrDirectional(indicators, ["reversalCandle", "reversalCandleDirection"], direction);
  const volumeClimaxConfigured = readBoolean(indicators, ["volumeClimax"]);
  const volumeClimax = volumeClimaxConfigured ??
    (derived.relativeVolume === null ? null : derived.relativeVolume >= 2);
  const divergence = booleanOrDirectional(indicators, ["supportedDivergence", "divergenceDirection"], direction);
  const components = {
    vwapAtrExtension: addPositiveSignal({
      collector,
      value: extension === null ? null : extension - 0.75,
      maxPoints: 20,
      scale: 1.25,
      missingInput: "vwapAtrExtension",
      supportingCode: "VWAP_ATR_EXTENSION",
      opposingCode: "VWAP_ATR_EXTENSION_WEAK",
      supportingDescription: "VWAP/ATR extension provides a reversal location",
      opposingDescription: "VWAP/ATR extension is too small for a reversal location",
      direction
    }),
    priorMoveOpposesDirection: addBooleanSignal({
      collector,
      value: extensionSupport,
      maxPoints: 15,
      missingInput: "priorMoveDirection",
      supportingCode: "PRIOR_MOVE_EXHAUSTED",
      opposingCode: "PRIOR_MOVE_SUPPORTS_CONTINUATION",
      supportingDescription: "The prior move is opposite the evaluated reversal direction",
      opposingDescription: "The prior move does not support reversal direction",
      direction
    }),
    exhaustion: exhaustionSignal,
    failedBreak: addBooleanSignal({
      collector,
      value: failedBreak,
      maxPoints: 15,
      missingInput: "failedBreak",
      supportingCode: "FAILED_BREAK_CONFIRMATION",
      opposingCode: "FAILED_BREAK_UNCONFIRMED",
      supportingDescription: "A failed break confirms reversal risk",
      opposingDescription: "A failed break is not confirmed",
      direction
    }),
    reversalCandle: addBooleanSignal({
      collector,
      value: reversalCandle,
      maxPoints: 15,
      missingInput: "reversalCandle",
      supportingCode: "REVERSAL_CANDLE_CONFIRMATION",
      opposingCode: "REVERSAL_CANDLE_UNCONFIRMED",
      supportingDescription: "The latest candle confirms the evaluated reversal direction",
      opposingDescription: "The latest candle does not confirm reversal direction",
      direction
    }),
    volumeClimax: addBooleanSignal({
      collector,
      value: volumeClimax,
      maxPoints: 10,
      missingInput: "volumeClimax",
      supportingCode: "VOLUME_CLIMAX_CONFIRMATION",
      opposingCode: "VOLUME_CLIMAX_UNCONFIRMED",
      supportingDescription: "Volume climax supports reversal confirmation",
      opposingDescription: "Volume climax is not confirmed",
      direction
    }),
    supportedDivergence: addBooleanSignal({
      collector,
      value: divergence,
      maxPoints: 10,
      missingInput: "supportedDivergence",
      supportingCode: "SUPPORTED_DIVERGENCE",
      opposingCode: "DIVERGENCE_UNSUPPORTED",
      supportingDescription: "Supported divergence confirms the reversal thesis",
      opposingDescription: "Supported divergence is not confirmed",
      direction
    }),
    liquidity: addLiquiditySignal(collector, liquidity, 10, direction)
  };
  const confirmationCount = [
    extension !== null && extension >= 1,
    extensionSupport === true,
    exhaustion !== null ? exhaustion >= 0.6 : readBoolean(indicators, ["exhaustion"]) === true,
    failedBreak === true,
    reversalCandle === true,
    volumeClimax === true,
    divergence === true
  ].filter(Boolean).length;
  if (confirmationCount < 4) addBlocker(collector, "INSUFFICIENT_REVERSAL_CONFIRMATION");
  return finalize({
    playbook: "reversal",
    direction,
    components,
    confidence: clamp((confirmationCount / 7) * 100, 0, 100),
    threshold: 65,
    collector
  });
};

const validOpeningRange = (value: ZeroDteOpeningRange | undefined): ZeroDteOpeningRange | null => {
  if (!value) return null;
  const high = finite(value.high);
  const low = finite(value.low);
  return high !== null && low !== null && high > low ? { ...value, high, low } : null;
};

const deriveOpeningRange = (
  context: ZeroDtePlaybookContext,
  primary: ZeroDteBar[]
): ZeroDteOpeningRange | null => {
  const direct = validOpeningRange(context.openingRange);
  if (direct) return direct;
  const indicatorHigh = finite(context.indicators.openingRangeHigh);
  const indicatorLow = finite(context.indicators.openingRangeLow);
  if (indicatorHigh !== null && indicatorLow !== null && indicatorHigh > indicatorLow) {
    return {
      high: indicatorHigh,
      low: indicatorLow,
      minutes: finite(context.openingRangeMinutes) ?? finite(context.indicators.openingRangeMinutes),
      source: "indicator"
    };
  }
  const openingEntry = Object.entries(context.barsByTimeframe ?? {}).find(([key]) =>
    key.toLowerCase().replace(/[^a-z0-9]/g, "").includes("openingrange")
  );
  if (openingEntry) {
    const openingBars = orderedBars(openingEntry[1]);
    if (openingBars.length) {
      return {
        high: Math.max(...openingBars.map((bar) => bar.high)),
        low: Math.min(...openingBars.map((bar) => bar.low)),
        minutes: openingBars.length,
        source: "opening-range-bars"
      };
    }
  }
  const minutes = finite(context.openingRangeMinutes) ?? finite(context.indicators.openingRangeMinutes);
  if (minutes !== null && minutes > 0 && primary.length >= Math.ceil(minutes)) {
    const openingBars = primary.slice(0, Math.ceil(minutes));
    return {
      high: Math.max(...openingBars.map((bar) => bar.high)),
      low: Math.min(...openingBars.map((bar) => bar.low)),
      minutes,
      source: "configured-opening-range"
    };
  }
  return null;
};

const evaluateBreakout = (
  context: ZeroDtePlaybookContext,
  direction: ZeroDteDirection,
  derived: DerivedMarketContext
) => {
  const collector = coreCollector(derived);
  const openingRange = deriveOpeningRange(context, derived.bars);
  if (!openingRange) {
    addMissing(collector, "openingRange");
    addBlocker(collector, "MISSING_OPENING_RANGE_EVIDENCE");
  }
  const price = derived.price;
  const breakoutDistance =
    openingRange !== null && price !== null
      ? direction === "bullish"
        ? price - openingRange.high
        : direction === "bearish"
          ? openingRange.low - price
          : Math.max(price - openingRange.high, openingRange.low - price)
      : null;
  if (breakoutDistance !== null && breakoutDistance <= 0) {
    addBlocker(collector, "OPENING_RANGE_NOT_BROKEN");
  }
  const rangeWidth = openingRange ? openingRange.high - openingRange.low : null;
  const compression =
    readBoolean(context.indicators, ["compression", "rangeCompression", "consolidation"]) ??
    (rangeWidth !== null && price !== null ? rangeWidth / price <= 0.02 : null);
  const retest = readBoolean(context.indicators, ["retestConfirmed", "breakoutRetest"]);
  const falseBreakRisk = readNumber(context.indicators, ["falseBreakRisk", "falseBreakProbability"]);
  const components = {
    openingRangeBreak: addPositiveSignal({
      collector,
      value: breakoutDistance === null ? null : breakoutDistance,
      maxPoints: 25,
      scale: Math.max(derived.atr ?? 0, (rangeWidth ?? 0) * 0.25, 0.01),
      missingInput: "openingRangeBreak",
      supportingCode: "OPENING_RANGE_BREAK",
      opposingCode: "OPENING_RANGE_NOT_BROKEN",
      supportingDescription: "Price has broken the supplied opening range in the evaluated direction",
      opposingDescription: "Price has not broken the supplied opening range in the evaluated direction",
      direction
    }),
    compression: addBooleanSignal({
      collector,
      value: compression,
      maxPoints: 15,
      missingInput: "compression",
      supportingCode: "PRE_BREAK_COMPRESSION",
      opposingCode: "NO_PRE_BREAK_COMPRESSION",
      supportingDescription: "Compression or consolidation preceded the breakout",
      opposingDescription: "Compression or consolidation is not confirmed",
      direction
    }),
    volumeExpansion: addPositiveSignal({
      collector,
      value: derived.relativeVolume === null ? null : derived.relativeVolume - 1,
      maxPoints: 15,
      scale: 1,
      missingInput: "relativeVolume",
      supportingCode: "BREAKOUT_VOLUME_EXPANSION",
      opposingCode: "BREAKOUT_VOLUME_UNCONFIRMED",
      supportingDescription: "Relative volume expands with the breakout",
      opposingDescription: "Relative volume does not expand with the breakout",
      direction
    }),
    retest: addBooleanSignal({
      collector,
      value: retest,
      maxPoints: 15,
      missingInput: "retestConfirmed",
      supportingCode: "BREAKOUT_RETEST",
      opposingCode: "BREAKOUT_RETEST_UNCONFIRMED",
      supportingDescription: "The opening-range break held on retest",
      opposingDescription: "A confirming retest is not available",
      direction
    }),
    timeframeAlignment: addTimeframeSignal(
      collector,
      derived.timeframeDirections,
      direction,
      15
    ),
    liquidity: addLiquiditySignal(collector, optionLiquidityScore(context, derived, collector), 10, direction),
    falseBreakRisk: falseBreakRisk === null ? 0 : clamp(falseBreakRisk, 0, 1) * 10
  };
  if (falseBreakRisk !== null && falseBreakRisk > 0.5) {
    collector.opposingSignals.push(
      makeEvidence("FALSE_BREAK_RISK", "False-break risk reduces breakout confidence", falseBreakRisk, direction)
    );
  }
  const available = Object.entries(components).filter(([key, value]) => key === "falseBreakRisk" || value > 0).length;
  return finalize({
    playbook: "breakout",
    direction,
    components,
    scoreAdjustment: -(components.falseBreakRisk ?? 0),
    confidence: clamp((available / 7) * 100, 0, 100),
    threshold: 60,
    collector
  });
};

const evaluateGammaProxy = (
  context: ZeroDtePlaybookContext,
  direction: ZeroDteDirection,
  derived: DerivedMarketContext
) => {
  const collector: SignalCollector = {
    supportingSignals: [],
    opposingSignals: [],
    blockers: [],
    missingInputs: []
  };
  const option = asRecord(context.option);
  const greeks = asRecord(option.greeks);
  const gamma =
    readNumber(option, ["gamma", "gammaValue", "gammaProxy"]) ??
    readNumber(greeks, ["gamma"]) ??
    readNumber(context.indicators, ["gamma", "gammaValue", "gammaProxy"]);
  const openInterest =
    readNumber(option, ["openInterest", "open_interest", "oi"]) ??
    readNumber(context.indicators, ["openInterest", "open_interest", "oi"]);
  if (gamma === null) addMissing(collector, "gamma");
  if (openInterest === null) addMissing(collector, "openInterest");
  if (gamma === null || openInterest === null) {
    addBlocker(collector, "MISSING_GAMMA_PROXY_INPUTS");
    return finalize({
      playbook: "gamma_proxy",
      direction,
      components: {
        gammaMagnitude: 0,
        openInterestDepth: 0,
        liquidity: 0
      },
      confidence: 0,
      threshold: 55,
      collector,
      status: "insufficient_data",
      metadata: {
        proxyMetric: true,
        dealerPositioningClaim: false
      }
    });
  }
  const liquidity = optionLiquidityScore(context, derived, collector);
  const components = {
    gammaMagnitude: clamp(Math.abs(gamma) * 1_000, 0, 50),
    openInterestDepth: clamp(Math.log10(openInterest + 1) / 4 * 30, 0, 30),
    liquidity: liquidity === null ? 0 : clamp(liquidity / 100, 0, 1) * 20
  };
  if (components.gammaMagnitude > 0 && components.openInterestDepth > 0) {
    collector.supportingSignals.push(
      makeEvidence(
        "DATA_BACKED_GAMMA_PROXY",
        "Observed option gamma and open interest form a bounded proxy metric; no dealer-positioning claim is made",
        Math.abs(gamma) * openInterest,
        direction,
        components.gammaMagnitude + components.openInterestDepth
      )
    );
  }
  if (gamma === 0) {
    collector.opposingSignals.push(
      makeEvidence("ZERO_GAMMA_PROXY", "Observed gamma contributes no proxy magnitude", gamma, direction)
    );
  }
  return finalize({
    playbook: "gamma_proxy",
    direction,
    components,
    confidence: clamp((Object.values(components).filter((value) => value > 0).length / 3) * 100, 0, 100),
    threshold: 55,
    collector,
    metadata: {
      proxyMetric: true,
      dealerPositioningClaim: false
    }
  });
};

const evaluateVolatilityExpansion = (
  context: ZeroDtePlaybookContext,
  direction: ZeroDteDirection,
  derived: DerivedMarketContext
) => {
  const collector = coreCollector(derived);
  const realizedRatio =
    derived.realizedVolatility !== null &&
    derived.realizedVolatilityBaseline !== null &&
    derived.realizedVolatilityBaseline > 0
      ? derived.realizedVolatility / derived.realizedVolatilityBaseline
      : null;
  const iv = derived.impliedVolatility;
  const components = {
    realizedVolatility:
      realizedRatio === null
        ? 0
        : clamp((realizedRatio - 1) / 1.5, 0, 1) * 18,
    atrAcceleration:
      derived.atrAcceleration === null
        ? 0
        : clamp((derived.atrAcceleration - 1) / 1.5, 0, 1) * 15,
    rangeBreak: derived.rangeBreak === true ? 14 : 0,
    volatilityIndexMovement:
      derived.volatilityIndexMovement === null
        ? 0
        : clamp(Math.abs(derived.volatilityIndexMovement) / 10, 0, 1) * 10,
    impliedVolatility: iv === null ? 0 : clamp(iv / 0.5, 0, 1) * 10,
    velocity: derived.velocity === null ? 0 : clamp(Math.abs(derived.velocity) / 1, 0, 1) * 10,
    breadth: derived.breadth === null ? 0 : clamp(Math.abs(derived.breadth) / 1, 0, 1) * 8,
    crossIndexConfirmation: derived.crossIndexConfirmation === true ? 8 : 0,
    liquidity: addLiquiditySignal(collector, optionLiquidityScore(context, derived, collector), 7, direction)
  };
  if (derived.realizedVolatility === null || derived.realizedVolatilityBaseline === null) {
    addMissing(collector, "realizedVolatility");
  } else if (realizedRatio !== null && realizedRatio > 1) {
    collector.supportingSignals.push(
      makeEvidence("REALIZED_VOLATILITY_EXPANSION", "Realized volatility is above its baseline", realizedRatio, direction, components.realizedVolatility)
    );
  } else {
    collector.opposingSignals.push(
      makeEvidence("REALIZED_VOLATILITY_NOT_EXPANDING", "Realized volatility is not above its baseline", realizedRatio, direction)
    );
  }
  if (derived.atrAcceleration === null) addMissing(collector, "atrAcceleration");
  if (derived.rangeBreak === null) addMissing(collector, "rangeBreak");
  if (derived.volatilityIndexMovement === null) addMissing(collector, "volatilityIndexMovement");
  if (iv === null) addMissing(collector, "impliedVolatility");
  if (derived.velocity === null) addMissing(collector, "velocity");
  if (derived.breadth === null) addMissing(collector, "breadth");
  if (derived.crossIndexConfirmation === null) addMissing(collector, "crossIndexConfirmation");
  const active = Object.values(components).filter((value) => value > 0).length;
  if (active < 3) addBlocker(collector, "INSUFFICIENT_VOLATILITY_EXPANSION_INPUTS");
  return finalize({
    playbook: "volatility_expansion",
    direction,
    components,
    confidence: clamp((active / Object.keys(components).length) * 100, 0, 100),
    threshold: 55,
    collector
  });
};

export const evaluateZeroDtePlaybooks = (
  context: ZeroDtePlaybookContext
): PlaybookEvaluation[] => {
  const derived = deriveMarketContext(context);
  const directions = resolveDirections(context);
  const evaluations: PlaybookEvaluation[] = [];
  for (const direction of directions) {
    evaluations.push(evaluateTrendContinuation(context, direction, derived));
    evaluations.push(evaluateReversal(context, direction, derived));
    evaluations.push(evaluateBreakout(context, direction, derived));
    evaluations.push(evaluateGammaProxy(context, direction, derived));
    evaluations.push(evaluateVolatilityExpansion(context, direction, derived));
  }
  return evaluations;
};
