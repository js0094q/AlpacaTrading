import { canonicalJsonHash } from "../lib/canonicalJson.js";
import type { FencedPostgresRepositoryContext } from "../repositories/postgres/postgresRepositorySupport.js";
import type {
  PostgresFeatureSnapshot,
  PostgresMarketBar,
  PostgresOptionContract,
  PostgresOptionSnapshot,
  PostgresStockSnapshot,
  PostgresTargetSnapshot
} from "../repositories/postgres/postgresMarketDataRepository.js";
import { PostgresMarketDataRepository } from "../repositories/postgres/postgresMarketDataRepository.js";
import type { RiskProfile } from "../types.js";
import { normalizeSymbol } from "../lib/utils.js";
import { atr, classifyTrend, distanceFrom, ema, macd, rollingStd, rsi, sma } from "./indicators.js";
import { selectExpressionWithPolicy } from "./strategySelectionLogic.js";

type FeatureTargetWriter = Pick<
  PostgresMarketDataRepository,
  "upsertFeatureSnapshots" | "upsertTargetSnapshots"
>;

type FeatureValues = Record<string, string | number | boolean | null | undefined>;

const numberValue = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const stringValue = (value: unknown) => typeof value === "string" && value.length > 0 ? value : null;

const isRegularMarketSession = (timestamp: string) => {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return false;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (values.weekday === "Sat" || values.weekday === "Sun") return false;
  const minutes = Number(values.hour) * 60 + Number(values.minute);
  return minutes >= 570 && minutes <= 960;
};

const stockEvidenceAsOf = (input: { symbol: string; asOf: string; snapshots: readonly PostgresStockSnapshot[] }) =>
  input.snapshots
    .filter((row) => normalizeSymbol(row.symbol) === input.symbol && Date.parse(row.observedAt) <= Date.parse(input.asOf))
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0] ?? null;

const latestStockEvidence = (symbol: string, snapshots: readonly PostgresStockSnapshot[]) =>
  snapshots
    .filter((row) => normalizeSymbol(row.symbol) === symbol)
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0] ?? null;

const stockDecisionFeatures = (snapshot: PostgresStockSnapshot | null) => {
  if (!snapshot) return {};
  const evidence = snapshot.evidence;
  const freshnessStatus = stringValue(evidence.freshnessStatus);
  const dataQualityStatus = stringValue(evidence.dataQualityStatus);
  const midpoint = numberValue(evidence.midpoint);
  const latestTradePrice = numberValue(evidence.latestTradePrice);
  const currentTradablePrice = midpoint ?? latestTradePrice;
  return {
    currentTradablePrice,
    latestTradePrice,
    bidPrice: numberValue(evidence.bidPrice),
    askPrice: numberValue(evidence.askPrice),
    bidAskMidpoint: midpoint,
    absoluteSpread: numberValue(evidence.spread),
    percentageSpread: numberValue(evidence.spreadPct),
    intradayReturn: numberValue(evidence.returnFromOpen),
    snapshotDailyReturn: numberValue(evidence.dailyReturn),
    distanceFromVwap: numberValue(evidence.distanceFromVwap),
    snapshotRelativeVolume: numberValue(evidence.relativeCurrentDayVolume),
    currentRangePosition: (() => {
      const low = numberValue(evidence.dailyLow);
      const high = numberValue(evidence.dailyHigh);
      return currentTradablePrice !== null && low !== null && high !== null && high > low
        ? (currentTradablePrice - low) / (high - low)
        : null;
    })(),
    marketSessionEligible: freshnessStatus === "FRESH" && dataQualityStatus === "COMPLETE" && isRegularMarketSession(snapshot.sourceTimestamp ?? snapshot.observedAt),
    stockEvidenceFreshnessStatus: freshnessStatus,
    stockDataQualityStatus: dataQualityStatus,
    stockEvidenceTimestamp: snapshot.sourceTimestamp ?? snapshot.observedAt,
    stockEffectiveFeed: snapshot.effectiveFeed
  };
};

const fingerprint = (value: unknown) => canonicalJsonHash(value);

const optionRowsAsOf = (input: {
  symbol: string;
  asOf: string;
  contracts: readonly PostgresOptionContract[];
  snapshots: readonly PostgresOptionSnapshot[];
}) => {
  const asOf = Date.parse(input.asOf);
  const contracts = input.contracts.filter((contract) =>
    contract.tradable &&
    normalizeSymbol(contract.underlyingSymbol) === input.symbol &&
    Date.parse(`${contract.expirationDate}T23:59:59.999Z`) >= asOf
  );
  const byContract = new Map<string, PostgresOptionSnapshot>();
  for (const snapshot of input.snapshots) {
    if (normalizeSymbol(snapshot.underlyingSymbol) !== input.symbol || Date.parse(snapshot.observedAt) > asOf) continue;
    const current = byContract.get(normalizeSymbol(snapshot.optionSymbol));
    if (!current || Date.parse(current.observedAt) < Date.parse(snapshot.observedAt)) {
      byContract.set(normalizeSymbol(snapshot.optionSymbol), snapshot);
    }
  }
  return contracts
    .map((contract) => ({ contract, snapshot: byContract.get(normalizeSymbol(contract.optionSymbol)) }))
    .filter((row): row is { contract: PostgresOptionContract; snapshot: PostgresOptionSnapshot } => Boolean(row.snapshot));
};

const buildOptionFeatures = (input: {
  symbol: string;
  asOf: string;
  close: number;
  contracts: readonly PostgresOptionContract[];
  snapshots: readonly PostgresOptionSnapshot[];
}) => {
  const rows = optionRowsAsOf(input);
  if (!rows.length) {
    return {
      values: {
        optionsNearestExpiration: null,
        daysToExpiration: null,
        atmImpliedVol: null,
        ivPercentile: null,
        callLiquidityAvailable: 0,
        putLiquidityAvailable: 0,
        callSpreadAvailable: 0,
        putSpreadAvailable: 0,
        estimatedBidAskSpreadPct: null,
        preferredContractLiquidityScore: 0,
        optionSuitability: "insufficient_data",
        marketEvidenceTimestamp: input.asOf
      } satisfies FeatureValues,
      candidate: null
    };
  }

  const nearestExpiration = rows.map((row) => row.contract.expirationDate).sort()[0]!;
  const nearestRows = rows.filter((row) => row.contract.expirationDate === nearestExpiration);
  const selected = [...nearestRows].sort((a, b) =>
    Math.abs(a.contract.strike - input.close) - Math.abs(b.contract.strike - input.close)
  )[0]!;
  const calls = nearestRows.filter((row) => row.contract.type === "call");
  const puts = nearestRows.filter((row) => row.contract.type === "put");
  const bid = selected.snapshot.bid;
  const ask = selected.snapshot.ask;
  const midpoint = selected.snapshot.midpoint;
  const spreadPct = bid !== null && ask !== null && midpoint !== null && midpoint > 0 ? (ask - bid) / midpoint : null;
  const liquidity = (selected.snapshot.volume ?? 0) + (selected.snapshot.openInterest ?? 0);
  const spreadSignal = spreadPct === null ? 0 : 1 - Math.min(1, Math.abs(spreadPct));
  const liquidityScore =
    Math.max(0, Math.min(1, nearestRows.length / 10)) * 0.6 +
    Math.min(1, liquidity / 10_000) * 0.4 +
    spreadSignal * 0.2;
  const ivSamples = rows
    .map((row) => row.snapshot.impliedVolatility)
    .filter((value): value is number => value !== null);
  const impliedVolatility = selected.snapshot.impliedVolatility;
  const ivPercentile = impliedVolatility === null || !ivSamples.length
    ? null
    : ivSamples.filter((value) => value <= impliedVolatility).length / ivSamples.length;
  const hasLiquidity = liquidity > 0;
  const evidenceTimestamp = selected.snapshot.quoteTimestamp ??
    selected.snapshot.snapshotTimestamp ?? selected.snapshot.tradeTimestamp ??
    selected.snapshot.observedAt;
  const entryPrice = selected.snapshot.midpoint ?? selected.snapshot.ask ?? selected.snapshot.last ?? null;
  const quoteAgeSeconds = (Date.parse(input.asOf) - Date.parse(evidenceTimestamp)) / 1000;
  const quoteFreshnessStatus = Number.isFinite(quoteAgeSeconds) && quoteAgeSeconds >= 0 && quoteAgeSeconds <= 1_200
    ? "fresh"
    : "stale";
  const moneyness = selected.contract.type === "call"
    ? (input.close - selected.contract.strike) / input.close
    : (selected.contract.strike - input.close) / input.close;
  const intrinsicValue = selected.contract.type === "call"
    ? Math.max(0, input.close - selected.contract.strike)
    : Math.max(0, selected.contract.strike - input.close);
  const extrinsicValue = entryPrice === null ? null : Math.max(0, entryPrice - intrinsicValue);
  const expirationMs = Date.parse(`${nearestExpiration}T20:00:00.000Z`);
  const hoursToExpiration = Math.max(0, (expirationMs - Date.parse(input.asOf)) / 3_600_000);
  const greekCoverage = [selected.snapshot.delta, selected.snapshot.gamma, selected.snapshot.theta, selected.snapshot.vega]
    .filter((value) => value !== null && value !== undefined).length / 4;
  const decisionLiquidityScore = liquidityScore + greekCoverage * 0.1;
  const optionFeedValidated = selected.snapshot.evidence.requestedFeed === "opra" && selected.snapshot.evidence.effectiveFeed === "opra";
  const contractEligible = hasLiquidity && optionFeedValidated && quoteFreshnessStatus === "fresh" && spreadPct !== null && spreadPct <= 0.08 && entryPrice !== null;

  return {
    values: {
      optionsNearestExpiration: nearestExpiration,
      daysToExpiration: Math.max(0, Math.round((Date.parse(`${nearestExpiration}T23:59:59.999Z`) - Date.parse(input.asOf)) / 86_400_000)),
      atmImpliedVol: impliedVolatility,
      ivPercentile,
      callLiquidityAvailable: calls.length,
      putLiquidityAvailable: puts.length,
      callSpreadAvailable: calls.length >= 2 ? 1 : 0,
      putSpreadAvailable: puts.length >= 2 ? 1 : 0,
      estimatedBidAskSpreadPct: spreadPct,
      optionUnderlyingPrice: input.close,
      optionMidpoint: midpoint,
      optionMoneyness: moneyness,
      optionIntrinsicValue: intrinsicValue,
      optionExtrinsicValue: extrinsicValue,
      hoursToExpiration,
      optionQuoteAgeSeconds: quoteAgeSeconds,
      optionQuoteFreshnessStatus: quoteFreshnessStatus,
      optionFeedValidated,
      optionContractEligible: contractEligible,
      optionDelta: selected.snapshot.delta,
      optionGamma: selected.snapshot.gamma ?? null,
      optionTheta: selected.snapshot.theta ?? null,
      optionVega: selected.snapshot.vega ?? null,
      preferredContractLiquidityScore: decisionLiquidityScore,
      optionSuitability: hasLiquidity && liquidityScore > 0.7
        ? "suitable"
        : hasLiquidity && liquidityScore > 0.35
          ? "marginal"
          : "unsuitable",
      marketEvidenceTimestamp: evidenceTimestamp
    } satisfies FeatureValues,
    candidate: contractEligible ? {
      optionSymbol: selected.contract.optionSymbol,
      expirationDate: selected.contract.expirationDate,
      strike: selected.contract.strike,
      type: selected.contract.type,
      estimatedEntryPrice: entryPrice,
      maxLoss: null,
      maxProfit: null,
      breakeven: null,
      liquidityScore: decisionLiquidityScore,
      evidenceTimestamp
      ,decisionInputs: {
        delta: selected.snapshot.delta, gamma: selected.snapshot.gamma ?? null,
        theta: selected.snapshot.theta ?? null, vega: selected.snapshot.vega ?? null,
        impliedVolatility, spreadPct, moneyness, quoteFreshnessStatus,
        feed: optionFeedValidated ? "opra" : null
      }
    } : null
  };
};

const calculateFeatures = (input: {
  bars: readonly PostgresMarketBar[];
  stockSnapshots: readonly PostgresStockSnapshot[];
  contracts: readonly PostgresOptionContract[];
  snapshots: readonly PostgresOptionSnapshot[];
}) => {
  const closes = input.bars.map((row) => row.close);
  const highs = input.bars.map((row) => row.high);
  const lows = input.bars.map((row) => row.low);
  const volumes = input.bars.map((row) => row.volume);
  const changes = closes.map((close, index) => index === 0 ? null : close - closes[index - 1]!);
  const logs = closes.map((close, index) => index === 0 || close <= 0 || closes[index - 1]! <= 0
    ? null
    : Math.log(close / closes[index - 1]!));

  return input.bars.map((bar, index) => {
    const closeSeries = closes.slice(0, index + 1);
    const highSeries = highs.slice(0, index + 1);
    const lowSeries = lows.slice(0, index + 1);
    const volumeSeries = volumes.slice(0, index + 1);
    const changeSeries = changes.slice(0, index + 1).filter((value): value is number => value !== null);
    const sma10 = sma(closeSeries, 10);
    const sma20 = sma(closeSeries, 20);
    const sma50 = sma(closeSeries, 50);
    const averageVolume = sma(volumeSeries, 20);
    const macdValues = macd(closeSeries);
    const stockSnapshot = index === input.bars.length - 1
      ? latestStockEvidence(normalizeSymbol(bar.symbol), input.stockSnapshots)
      : stockEvidenceAsOf({ symbol: normalizeSymbol(bar.symbol), asOf: bar.observedAt, snapshots: input.stockSnapshots });
    const stock = stockDecisionFeatures(stockSnapshot);
    const decisionAsOf = stockSnapshot?.observedAt ?? bar.observedAt;
    const option = buildOptionFeatures({
      symbol: normalizeSymbol(bar.symbol),
      asOf: decisionAsOf,
      close: typeof stock.currentTradablePrice === "number" ? stock.currentTradablePrice : bar.close,
      contracts: input.contracts,
      snapshots: input.snapshots
    });
    const values: FeatureValues = {
      close: bar.close,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      volume: bar.volume,
      dailyReturn: changes[index],
      logReturn: logs[index],
      volatility5: rollingStd(changeSeries.length ? changeSeries : [0], 5),
      volatility10: rollingStd(changeSeries.length ? changeSeries : [0], 10),
      volatility20: rollingStd(changeSeries.length ? changeSeries : [0], 20),
      volatility60: rollingStd(changeSeries.length ? changeSeries : [0], 60),
      sma10,
      sma20,
      sma50,
      sma200: sma(closeSeries, 200),
      ema9: ema(closeSeries, 9),
      ema21: ema(closeSeries, 21),
      rsi14: rsi(changeSeries, 14),
      atr14: atr(highSeries, lowSeries, closeSeries, 14),
      macd: macdValues.macd,
      macdSignal: macdValues.signal,
      macdHistogram: macdValues.histogram,
      volumeAvg20: averageVolume,
      relativeVolume: averageVolume && averageVolume !== 0 ? bar.volume / averageVolume : null,
      distanceFrom20High: distanceFrom(highs[index]!, sma10 && sma20 ? Math.max(...highSeries.slice(-20)) : null),
      distanceFrom20Low: distanceFrom(lows[index]!, sma10 && sma20 ? Math.min(...lowSeries.slice(-20)) : null),
      trend: classifyTrend({ sma10, sma20, sma50, close: bar.close }),
      multiPeriodReturn5: index >= 5 ? bar.close / closes[index - 5]! - 1 : null,
      multiPeriodReturn20: index >= 20 ? bar.close / closes[index - 20]! - 1 : null,
      realizedVolatility20: rollingStd(logs.slice(0, index + 1).filter((value): value is number => value !== null), 20),
      ...stock,
      ...option.values
    };
    return {
      symbol: normalizeSymbol(bar.symbol),
      observedAt: decisionAsOf,
      features: values,
      sourceFingerprint: fingerprint({ bar, stockSnapshot, optionEvidenceTimestamp: option.values.marketEvidenceTimestamp }),
      optionCandidate: option.candidate
    };
  });
};

const targetFromFeature = (input: {
  feature: ReturnType<typeof calculateFeatures>[number];
  riskProfile: RiskProfile;
  learningAccuracy?: number | null;
  learningModelName?: string | null;
}): PostgresTargetSnapshot => {
  const values = input.feature.features;
  const directionScore =
    (values.trend === "bullish" ? 1 : values.trend === "bearish" ? -1 : 0) +
    (typeof values.rsi14 === "number" ? (values.rsi14 - 50) / 100 : 0) +
    (typeof values.ema9 === "number" && typeof values.ema21 === "number"
      ? (values.ema9 - values.ema21) / (values.ema21 || 1)
      : 0) +
    (typeof values.macdHistogram === "number" ? Math.sign(values.macdHistogram) * 0.2 : 0) +
    (typeof values.snapshotRelativeVolume === "number"
      ? 0.2 * (values.snapshotRelativeVolume - 1)
      : typeof values.relativeVolume === "number" ? 0.2 * (values.relativeVolume - 1) : 0) +
    (typeof values.intradayReturn === "number" ? Math.max(-0.25, Math.min(0.25, values.intradayReturn * 5)) : 0) +
    (typeof values.distanceFromVwap === "number" ? Math.max(-0.15, Math.min(0.15, values.distanceFromVwap * 3)) : 0);
  const volatilityAdjusted = Math.max(0, Math.min(2,
    1 + (typeof values.atmImpliedVol === "number" ? values.atmImpliedVol : 0.2)
  ));
  const expectedReturn = directionScore * volatilityAdjusted;
  const learningBoost = Math.max(0, Math.min(1, (input.learningAccuracy ?? 0.5) - 0.5));
  const confidence = Math.max(0, Math.min(1, Math.abs(directionScore) / 2 + learningBoost * 0.2));
  const direction = directionScore > 0.25 ? "long" : directionScore < -0.25 ? "short" : "neutral";
  const atr14 = typeof values.atr14 === "number" ? values.atr14 : null;
  const close = typeof values.currentTradablePrice === "number"
    ? values.currentTradablePrice
    : typeof values.close === "number" ? values.close : 0;
  const stopDistance = (atr14 ?? 0) * 1.5;
  const profitDistance = (atr14 ?? 0) * 3;
  const selector = selectExpressionWithPolicy({
    symbol: input.feature.symbol,
    asOf: input.feature.observedAt,
    direction,
    confidence,
    expectedReturn,
    atr: atr14,
    trend: String(values.trend ?? "neutral"),
    iv: typeof values.atmImpliedVol === "number" ? values.atmImpliedVol : null,
    liquidityScore: typeof values.preferredContractLiquidityScore === "number" ? values.preferredContractLiquidityScore : 0,
    spreadPct: typeof values.estimatedBidAskSpreadPct === "number" ? values.estimatedBidAskSpreadPct : null,
    hasOptionsData: Number(values.callLiquidityAvailable ?? 0) > 0 || Number(values.putLiquidityAvailable ?? 0) > 0
  }, input.riskProfile === "aggressive");
  const rationale = [
    ...selector.rationale,
    `Risk profile set to ${input.riskProfile}`,
    `Learning boost from ${input.learningModelName ?? "no model"}`
  ];
  const sourceFingerprint = fingerprint({ feature: input.feature.sourceFingerprint, riskProfile: input.riskProfile });
  return {
    symbol: input.feature.symbol,
    asOf: input.feature.observedAt,
    direction,
    horizon: "1d",
    entryReference: close,
    upsideTarget: close + profitDistance,
    downsideRisk: close - stopDistance,
    stopLoss: direction === "long" ? close - stopDistance : close + stopDistance,
    takeProfit: direction === "long" ? close + profitDistance : close - profitDistance,
    confidence,
    expectedReturn,
    volatilityAdjustedScore: volatilityAdjusted,
    riskProfile: input.riskProfile,
    preferredExpression: selector.preferredExpression,
    rationale,
    sourceFingerprint,
    optionsStrategy: {
      alternatives: selector.alternatives,
      rationale: selector.rationale,
      optionsCandidate: input.feature.optionCandidate,
      decisionInputs: {
        currentTradablePrice: values.currentTradablePrice,
        intradayReturn: values.intradayReturn,
        distanceFromVwap: values.distanceFromVwap,
        relativeVolume: values.relativeVolume,
        realizedVolatility20: values.realizedVolatility20,
        currentRangePosition: values.currentRangePosition,
        distanceToStopLoss: stopDistance,
        distanceToTakeProfit: profitDistance,
        stockEvidenceFreshnessStatus: values.stockEvidenceFreshnessStatus,
        marketSessionEligible: values.marketSessionEligible
      }
    }
  };
};

export const buildPostgresFeaturesAndTargets = async (input: {
  bars: readonly PostgresMarketBar[];
  stockSnapshots: readonly PostgresStockSnapshot[];
  optionContracts: readonly PostgresOptionContract[];
  optionSnapshots: readonly PostgresOptionSnapshot[];
  riskProfile: RiskProfile;
  optionsEnabled: boolean;
  learningAccuracy?: number | null;
  learningModelName?: string | null;
  repository?: FeatureTargetWriter;
  context: FencedPostgresRepositoryContext;
}) => {
  const repository = input.repository ?? new PostgresMarketDataRepository();
  const bySymbol = new Map<string, PostgresMarketBar[]>();
  for (const bar of input.bars) {
    const symbol = normalizeSymbol(bar.symbol);
    bySymbol.set(symbol, [...(bySymbol.get(symbol) ?? []), bar]);
  }
  if (!bySymbol.size) throw new Error("POSTGRES_FEATURE_BARS_UNAVAILABLE");

  const calculated = [] as ReturnType<typeof calculateFeatures>;
  for (const [symbol, symbolBars] of bySymbol) {
    const ordered = [...symbolBars].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    if (ordered.length < 50) throw new Error(`POSTGRES_FEATURE_HISTORY_INSUFFICIENT:${symbol}`);
    const stockSnapshot = latestStockEvidence(symbol, input.stockSnapshots);
    if (!stockSnapshot) throw new Error(`POSTGRES_DECISION_STOCK_EVIDENCE_MISSING:${symbol}`);
    const stock = stockDecisionFeatures(stockSnapshot);
    if (stock.stockEvidenceFreshnessStatus !== "FRESH") throw new Error(`POSTGRES_DECISION_STOCK_EVIDENCE_STALE:${symbol}`);
    if (stock.stockDataQualityStatus !== "COMPLETE" || stock.currentTradablePrice === null || stock.stockEffectiveFeed !== "sip") {
      throw new Error(`POSTGRES_DECISION_STOCK_EVIDENCE_INVALID:${symbol}`);
    }
    if (stock.marketSessionEligible !== true) throw new Error(`POSTGRES_DECISION_MARKET_SESSION_INELIGIBLE:${symbol}`);
    calculated.push(...calculateFeatures({
      bars: ordered,
      stockSnapshots: input.stockSnapshots,
      contracts: input.optionsEnabled ? input.optionContracts : [],
      snapshots: input.optionsEnabled ? input.optionSnapshots : []
    }));
  }
  const features: PostgresFeatureSnapshot[] = calculated.map(({ optionCandidate: _candidate, ...feature }) => feature);
  const targets = Array.from(bySymbol.keys()).map((symbol) => {
    const latest = calculated.filter((row) => row.symbol === symbol).at(-1)!;
    return targetFromFeature({
      feature: latest,
      riskProfile: input.riskProfile,
      learningAccuracy: input.learningAccuracy,
      learningModelName: input.learningModelName
    });
  });
  await repository.upsertFeatureSnapshots(features, input.context);
  await repository.upsertTargetSnapshots(targets, input.context);
  return { features, targets };
};
