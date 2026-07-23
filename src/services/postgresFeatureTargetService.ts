import { canonicalJsonHash } from "../lib/canonicalJson.js";
import type { FencedPostgresRepositoryContext } from "../repositories/postgres/postgresRepositorySupport.js";
import type { JsonValue } from "../repositories/contracts/common.js";
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
import {
  BASELINE_DECISION_THRESHOLDS,
  classifyDirectionalScore,
  type PaperExplorationThresholds
} from "./paperExplorationConfig.js";
import { selectExpressionWithPolicy } from "./strategySelectionLogic.js";

type FeatureTargetWriter = Pick<
  PostgresMarketDataRepository,
  "upsertFeatureSnapshots" | "upsertTargetSnapshots"
>;

type FeatureValues = Record<string, JsonValue | undefined>;

const numberValue = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const stringValue = (value: unknown) => typeof value === "string" && value.length > 0 ? value : null;

const isExtendedMarketSession = (timestamp: string) => {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return false;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (values.weekday === "Sat" || values.weekday === "Sun") return false;
  const minutes = Number(values.hour) * 60 + Number(values.minute);

  // Alpaca extended equity session:
  // premarket 04:00–09:30 ET
  // regular   09:30–16:00 ET
  // after-hours 16:00–20:00 ET
  return minutes >= 240 && minutes <= 1200;
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
    marketSessionEligible: freshnessStatus === "FRESH" && dataQualityStatus === "COMPLETE" && isExtendedMarketSession(snapshot.sourceTimestamp ?? snapshot.observedAt),
    stockEvidenceFreshnessStatus: freshnessStatus,
    stockDataQualityStatus: dataQualityStatus,
    stockEvidenceTimestamp: snapshot.sourceTimestamp ?? snapshot.observedAt,
    stockEffectiveFeed: snapshot.effectiveFeed
  };
};

const fingerprint = (value: unknown) => canonicalJsonHash(value);
const EXISTING_NO_IV_VOLATILITY_MULTIPLIER = 1.2;
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

const OPTION_FIELD_CLASSIFICATIONS = {
  contractId: "audit_only",
  contractObservedAt: "audit_only",
  optionSymbol: "decision_input",
  underlyingSymbol: "audit_only",
  optionType: "decision_input",
  strike: "decision_input",
  expirationDate: "decision_input",
  multiplier: "audit_only",
  exerciseStyle: "audit_only",
  openInterestDate: "audit_only",
  closePrice: "audit_only",
  closePriceDate: "audit_only",
  underlyingPrice: "derived_feature_input",
  bid: "derived_feature_input",
  ask: "derived_feature_input",
  bidSize: "audit_only",
  askSize: "audit_only",
  midpoint: "decision_input",
  spread: "derived_feature_input",
  spreadPct: "execution_gate",
  latestTrade: "decision_input",
  quoteTimestamp: "execution_gate",
  tradeTimestamp: "audit_only",
  snapshotTimestamp: "audit_only",
  snapshotObservedAt: "audit_only",
  sourceObservationTimestamp: "audit_only",
  persistenceTimestamp: "audit_only",
  daysToExpiration: "derived_feature_input",
  hoursToExpiration: "derived_feature_input",
  moneyness: "derived_feature_input",
  intrinsicValue: "derived_feature_input",
  extrinsicValue: "derived_feature_input",
  dailyVolume: "execution_gate",
  openInterest: "execution_gate",
  impliedVolatility: "decision_input",
  delta: "audit_only",
  gamma: "audit_only",
  theta: "audit_only",
  vega: "audit_only",
  rho: "audit_only",
  greekCoverage: "derived_feature_input",
  quoteAgeSeconds: "derived_feature_input",
  quoteFreshnessStatus: "execution_gate",
  tradable: "execution_gate",
  activeStatus: "execution_gate",
  requestedFeed: "execution_gate",
  effectiveFeed: "execution_gate",
  feedValidationBasis: "execution_gate",
  feedValidated: "execution_gate",
  endpoint: "audit_only",
  pageToken: "audit_only",
  requestId: "audit_only",
  retrievedAt: "audit_only",
  liquidityResult: "execution_gate",
  liquidityScore: "decision_input",
  suitability: "derived_feature_input",
  eligibility: "execution_gate",
  rejectionReasons: "derived_feature_input"
} as const;

const optionEvidenceRowsAsOf = (input: {
  symbol: string;
  asOf: string;
  contracts: readonly PostgresOptionContract[];
  snapshots: readonly PostgresOptionSnapshot[];
}) => {
  const asOf = Date.parse(input.asOf);
  const contracts = input.contracts.filter((contract) =>
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
    .sort((left, right) =>
      left.contract.expirationDate.localeCompare(right.contract.expirationDate) ||
      left.contract.strike - right.contract.strike ||
      left.contract.optionSymbol.localeCompare(right.contract.optionSymbol)
    );
};

type OptionEvidenceRow = ReturnType<typeof optionEvidenceRowsAsOf>[number];

const deriveOptionContractFeature = (input: {
  row: OptionEvidenceRow;
  asOf: string;
  activeRowsAtExpiration: number;
  maximumOptionSpreadPct: number;
}) => {
  const { contract, snapshot } = input.row;
  const bid = snapshot?.bid ?? null;
  const ask = snapshot?.ask ?? null;
  const midpoint = snapshot?.midpoint ?? null;
  const spread = snapshot?.spread ?? (
    bid !== null && ask !== null && ask >= bid ? ask - bid : null
  );
  const spreadPct = snapshot?.spreadPct ?? (
    spread !== null && midpoint !== null && midpoint > 0 ? spread / midpoint : null
  );
  const volume = snapshot?.volume ?? null;
  const openInterest = snapshot?.openInterest ?? contract.openInterest ?? null;
  const liquidity = volume !== null && openInterest !== null ? volume + openInterest : null;
  const hasLiquidity = liquidity !== null && liquidity > 0;
  const quoteTimestamp = snapshot?.quoteTimestamp ?? null;
  const quoteAgeSeconds = quoteTimestamp === null
    ? null
    : (Date.parse(input.asOf) - Date.parse(quoteTimestamp)) / 1_000;
  const calculatedFreshness = quoteTimestamp === null
    ? "missing"
    : quoteAgeSeconds !== null && Number.isFinite(quoteAgeSeconds) &&
        quoteAgeSeconds >= 0 && quoteAgeSeconds <= 1_200
      ? "fresh"
      : "stale";
  const quoteFreshnessStatus = snapshot?.freshnessStatus === "stale"
    ? "stale"
    : calculatedFreshness;
  const requestedFeed = snapshot?.requestedFeed ?? snapshot?.evidence.requestedFeed ?? null;
  const effectiveFeed = snapshot?.effectiveFeed ?? snapshot?.evidence.effectiveFeed ?? null;
  const validationBasis = snapshot?.evidence.validationBasis;
  const feedValidationBasis = validationBasis === "request_feed_opra"
    ? validationBasis
    : effectiveFeed === "opra"
      ? "observed_effective_feed"
      : null;
  const feedValidated = requestedFeed === "opra" &&
    feedValidationBasis !== null;
  const underlyingPrice = snapshot?.underlyingPrice ?? null;
  const entryPrice = snapshot?.midpoint ?? snapshot?.ask ?? snapshot?.last ?? null;
  const moneyness = underlyingPrice !== null && underlyingPrice > 0
    ? contract.type === "call"
      ? (underlyingPrice - contract.strike) / underlyingPrice
      : (contract.strike - underlyingPrice) / underlyingPrice
    : null;
  const intrinsicValue = underlyingPrice === null
    ? null
    : contract.type === "call"
      ? Math.max(0, underlyingPrice - contract.strike)
      : Math.max(0, contract.strike - underlyingPrice);
  const extrinsicValue = entryPrice === null || intrinsicValue === null
    ? null
    : Math.max(0, entryPrice - intrinsicValue);
  const daysToExpiration = Math.max(0, Math.round(
    (Date.parse(`${contract.expirationDate}T23:59:59.999Z`) - Date.parse(input.asOf)) / 86_400_000
  ));
  const hoursToExpiration = Math.max(0,
    (Date.parse(`${contract.expirationDate}T20:00:00.000Z`) - Date.parse(input.asOf)) / 3_600_000
  );
  const greekCoverage = snapshot
    ? [snapshot.delta, snapshot.gamma, snapshot.theta, snapshot.vega]
      .filter((value) => value !== null && value !== undefined).length / 4
    : 0;
  const spreadSignal = spreadPct === null ? 0 : 1 - Math.min(1, Math.abs(spreadPct));
  const liquidityScore =
    Math.max(0, Math.min(1, input.activeRowsAtExpiration / 10)) * 0.6 +
    Math.min(1, (liquidity ?? 0) / 10_000) * 0.4 +
    spreadSignal * 0.2;
  const decisionLiquidityScore = liquidityScore + greekCoverage * 0.1;
  const activeStatus = contract.status === "active";
  const rejectionReasons: string[] = [];
  if (!activeStatus) rejectionReasons.push("not_active");
  if (!contract.tradable) rejectionReasons.push("not_tradable");
  if (!snapshot) rejectionReasons.push("snapshot_missing");
  if (underlyingPrice === null) rejectionReasons.push("underlying_price_missing");
  if (quoteFreshnessStatus === "missing") rejectionReasons.push("quote_timestamp_missing");
  if (quoteFreshnessStatus === "stale") rejectionReasons.push("quote_stale");
  if (!feedValidated) rejectionReasons.push("feed_invalid");
  if (volume === null) rejectionReasons.push("volume_missing");
  if (openInterest === null) rejectionReasons.push("open_interest_missing");
  if (liquidity !== null && !hasLiquidity) rejectionReasons.push("liquidity_empty");
  if (spreadPct === null) rejectionReasons.push("spread_missing");
  else if (spreadPct > input.maximumOptionSpreadPct) rejectionReasons.push("spread_too_wide");
  if (entryPrice === null) rejectionReasons.push("entry_price_missing");
  const eligibility = rejectionReasons.length === 0;
  const evidenceTimestamp = quoteTimestamp ?? snapshot?.snapshotTimestamp ??
    snapshot?.tradeTimestamp ?? snapshot?.observedAt ?? null;

  return {
    optionSymbol: contract.optionSymbol,
    underlyingSymbol: contract.underlyingSymbol,
    contractId: contract.contractId ?? null,
    contractObservedAt: contract.observedAt,
    optionType: contract.type,
    strike: contract.strike,
    expirationDate: contract.expirationDate,
    multiplier: contract.multiplier,
    tradable: contract.tradable,
    activeStatus,
    exerciseStyle: contract.exerciseStyle ?? null,
    openInterestDate: contract.openInterestDate ?? null,
    closePrice: contract.closePrice ?? null,
    closePriceDate: contract.closePriceDate ?? null,
    underlyingPrice,
    bid,
    ask,
    bidSize: snapshot?.bidSize ?? null,
    askSize: snapshot?.askSize ?? null,
    midpoint,
    spread,
    spreadPct,
    latestTrade: snapshot?.last ?? null,
    quoteTimestamp,
    tradeTimestamp: snapshot?.tradeTimestamp ?? null,
    snapshotTimestamp: snapshot?.snapshotTimestamp ?? null,
    snapshotObservedAt: snapshot?.observedAt ?? null,
    sourceObservationTimestamp: evidenceTimestamp,
    persistenceTimestamp: snapshot?.persistedAt ?? null,
    daysToExpiration,
    hoursToExpiration,
    moneyness,
    intrinsicValue,
    extrinsicValue,
    dailyVolume: volume,
    openInterest,
    impliedVolatility: snapshot?.impliedVolatility ?? null,
    delta: snapshot?.delta ?? null,
    gamma: snapshot?.gamma ?? null,
    theta: snapshot?.theta ?? null,
    vega: snapshot?.vega ?? null,
    rho: snapshot?.rho ?? null,
    greekCoverage,
    quoteAgeSeconds,
    quoteFreshnessStatus,
    requestedFeed: typeof requestedFeed === "string" ? requestedFeed : null,
    effectiveFeed: typeof effectiveFeed === "string" ? effectiveFeed : null,
    feedValidationBasis,
    feedValidated,
    endpoint: snapshot?.endpoint ?? null,
    pageToken: snapshot?.pageToken ?? null,
    requestId: snapshot?.requestId ?? null,
    retrievedAt: snapshot?.retrievedAt ?? null,
    liquidityResult: hasLiquidity ? "passed" : "failed",
    liquidityScore: decisionLiquidityScore,
    suitability: hasLiquidity && liquidityScore > 0.7
      ? "suitable"
      : hasLiquidity && liquidityScore > 0.35
        ? "marginal"
        : "unsuitable",
    eligibility,
    rejectionReasons
  } as const;
};

const buildOptionFeatures = (input: {
  symbol: string;
  asOf: string;
  close: number;
  contracts: readonly PostgresOptionContract[];
  snapshots: readonly PostgresOptionSnapshot[];
  maximumOptionSpreadPct: number;
}) => {
  const evidenceRows = optionEvidenceRowsAsOf(input);
  const rows = evidenceRows.filter((row): row is {
    contract: PostgresOptionContract;
    snapshot: PostgresOptionSnapshot;
  } => row.contract.tradable && row.contract.status === "active" && Boolean(row.snapshot));
  const activeRowsByExpiration = new Map<string, number>();
  for (const row of rows) {
    activeRowsByExpiration.set(
      row.contract.expirationDate,
      (activeRowsByExpiration.get(row.contract.expirationDate) ?? 0) + 1
    );
  }
  const contractFeatures = evidenceRows.map((row) => deriveOptionContractFeature({
    row,
    asOf: input.asOf,
    activeRowsAtExpiration: activeRowsByExpiration.get(row.contract.expirationDate) ?? 0,
    maximumOptionSpreadPct: input.maximumOptionSpreadPct
  }));
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
        optionUnderlyingPrice: null,
        optionBid: null,
        optionAsk: null,
        optionBidSize: null,
        optionAskSize: null,
        optionMidpoint: null,
        optionSpread: null,
        optionSpreadPct: null,
        optionLatestTrade: null,
        optionMoneyness: null,
        optionIntrinsicValue: null,
        optionExtrinsicValue: null,
        hoursToExpiration: null,
        optionQuoteAgeSeconds: null,
        optionQuoteFreshnessStatus: "missing",
        optionSourceObservationTimestamp: null,
        optionPersistenceTimestamp: null,
        optionFeedValidationBasis: null,
        optionFeedValidated: false,
        optionTradable: null,
        optionActiveStatus: null,
        optionDailyVolume: null,
        optionOpenInterest: null,
        optionLiquidityResult: "failed",
        optionContractEligible: false,
        optionContractRejectionReasons: ["no_active_tradable_contract_snapshot"],
        eligibleOptionContractCount: contractFeatures.filter((row) => row.eligibility).length,
        ineligibleOptionContractCount: contractFeatures.filter((row) => !row.eligibility).length,
        optionContractFeatures: contractFeatures,
        optionDelta: null,
        optionGamma: null,
        optionTheta: null,
        optionVega: null,
        optionRho: null,
        optionFieldClassifications: OPTION_FIELD_CLASSIFICATIONS,
        unclassifiedOptionFields: [],
        preferredContractLiquidityScore: 0,
        optionSuitability: "insufficient_data",
        marketEvidenceTimestamp: input.asOf
      } satisfies FeatureValues,
      candidate: null,
      materialEvidence: { contracts: contractFeatures, selectedOptionSymbol: null }
    };
  }

  const nearestExpiration = rows.map((row) => row.contract.expirationDate).sort()[0]!;
  const nearestRows = rows.filter((row) => row.contract.expirationDate === nearestExpiration);
  const selected = [...nearestRows].sort((a, b) =>
    Math.abs(a.contract.strike - input.close) - Math.abs(b.contract.strike - input.close)
  )[0]!;
  const selectedFeature = contractFeatures.find((row) =>
    row.optionSymbol === selected.contract.optionSymbol
  )!;
  const calls = nearestRows.filter((row) => row.contract.type === "call");
  const puts = nearestRows.filter((row) => row.contract.type === "put");
  const ivSamples = rows
    .map((row) => row.snapshot.impliedVolatility)
    .filter((value): value is number => value !== null);
  const impliedVolatility = selected.snapshot.impliedVolatility;
  const ivPercentile = impliedVolatility === null || !ivSamples.length
    ? null
    : ivSamples.filter((value) => value <= impliedVolatility).length / ivSamples.length;
  const evidenceTimestamp = selectedFeature.sourceObservationTimestamp ?? input.asOf;
  const entryPrice = selected.snapshot.midpoint ?? selected.snapshot.ask ?? selected.snapshot.last ?? null;
  const contractEligible = selectedFeature.eligibility;

  return {
    values: {
      optionsNearestExpiration: nearestExpiration,
      daysToExpiration: selectedFeature.daysToExpiration,
      atmImpliedVol: impliedVolatility,
      ivPercentile,
      callLiquidityAvailable: calls.length,
      putLiquidityAvailable: puts.length,
      callSpreadAvailable: calls.length >= 2 ? 1 : 0,
      putSpreadAvailable: puts.length >= 2 ? 1 : 0,
      estimatedBidAskSpreadPct: selectedFeature.spreadPct,
      optionUnderlyingPrice: selectedFeature.underlyingPrice,
      optionBid: selectedFeature.bid,
      optionAsk: selectedFeature.ask,
      optionBidSize: selectedFeature.bidSize,
      optionAskSize: selectedFeature.askSize,
      optionMidpoint: selectedFeature.midpoint,
      optionSpread: selectedFeature.spread,
      optionSpreadPct: selectedFeature.spreadPct,
      optionLatestTrade: selectedFeature.latestTrade,
      optionMoneyness: selectedFeature.moneyness,
      optionIntrinsicValue: selectedFeature.intrinsicValue,
      optionExtrinsicValue: selectedFeature.extrinsicValue,
      hoursToExpiration: selectedFeature.hoursToExpiration,
      optionQuoteAgeSeconds: selectedFeature.quoteAgeSeconds,
      optionQuoteFreshnessStatus: selectedFeature.quoteFreshnessStatus,
      optionSourceObservationTimestamp: evidenceTimestamp,
      optionPersistenceTimestamp: selectedFeature.persistenceTimestamp,
      optionFeedValidationBasis: selectedFeature.feedValidationBasis,
      optionFeedValidated: selectedFeature.feedValidated,
      optionTradable: selected.contract.tradable,
      optionActiveStatus: selectedFeature.activeStatus,
      optionDailyVolume: selectedFeature.dailyVolume,
      optionOpenInterest: selectedFeature.openInterest,
      optionLiquidityResult: selectedFeature.liquidityResult,
      optionContractEligible: contractEligible,
      optionContractRejectionReasons: selectedFeature.rejectionReasons,
      eligibleOptionContractCount: contractFeatures.filter((row) => row.eligibility).length,
      ineligibleOptionContractCount: contractFeatures.filter((row) => !row.eligibility).length,
      optionContractFeatures: contractFeatures,
      optionDelta: selected.snapshot.delta,
      optionGamma: selected.snapshot.gamma ?? null,
      optionTheta: selected.snapshot.theta ?? null,
      optionVega: selected.snapshot.vega ?? null,
      optionRho: selected.snapshot.rho ?? null,
      optionFieldClassifications: OPTION_FIELD_CLASSIFICATIONS,
      unclassifiedOptionFields: [],
      preferredContractLiquidityScore: selectedFeature.liquidityScore,
      optionSuitability: selectedFeature.suitability,
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
      liquidityScore: selectedFeature.liquidityScore,
      evidenceTimestamp
      ,decisionInputs: {
        delta: selected.snapshot.delta, gamma: selected.snapshot.gamma ?? null,
        theta: selected.snapshot.theta ?? null, vega: selected.snapshot.vega ?? null,
        rho: selected.snapshot.rho ?? null, impliedVolatility,
        volume: selectedFeature.dailyVolume, openInterest: selectedFeature.openInterest,
        spreadPct: selectedFeature.spreadPct, moneyness: selectedFeature.moneyness,
        quoteFreshnessStatus: selectedFeature.quoteFreshnessStatus,
        feed: selectedFeature.feedValidated ? "opra" : null
      }
    } : null,
    materialEvidence: {
      contracts: contractFeatures,
      selectedOptionSymbol: selected.contract.optionSymbol
    }
  };
};

const calculateFeatures = (input: {
  bars: readonly PostgresMarketBar[];
  stockSnapshots: readonly PostgresStockSnapshot[];
  contracts: readonly PostgresOptionContract[];
  snapshots: readonly PostgresOptionSnapshot[];
  maximumOptionSpreadPct: number;
}) => {
  const featureSymbol = normalizeSymbol(input.bars[0]?.symbol ?? "");
  const symbolContracts = input.contracts.filter((contract) =>
    normalizeSymbol(contract.underlyingSymbol) === featureSymbol
  );
  const symbolSnapshots = input.snapshots.filter((snapshot) =>
    normalizeSymbol(snapshot.underlyingSymbol) === featureSymbol
  );
  const earliestOptionObservation = symbolSnapshots.reduce<number | null>((earliest, snapshot) => {
    const observed = Date.parse(snapshot.observedAt);
    if (!Number.isFinite(observed)) return earliest;
    return earliest === null || observed < earliest ? observed : earliest;
  }, null);
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
    const baseDecisionAsOf = stockSnapshot?.observedAt ?? bar.observedAt;
    const latestOptionObservedAt = index === input.bars.length - 1
      ? symbolSnapshots
        .map((snapshot) => snapshot.observedAt)
        .filter((observedAt) => Number.isFinite(Date.parse(observedAt)))
        .sort((left, right) => Date.parse(right) - Date.parse(left))[0]
      : undefined;
    const decisionAsOf = latestOptionObservedAt &&
      Date.parse(latestOptionObservedAt) > Date.parse(baseDecisionAsOf)
      ? latestOptionObservedAt
      : baseDecisionAsOf;
    const currentDecisionRow = index === input.bars.length - 1;
    const historicalOptionEvidenceAvailable = earliestOptionObservation !== null &&
      earliestOptionObservation <= Date.parse(decisionAsOf);
    const includeOptionEvidence = currentDecisionRow || historicalOptionEvidenceAvailable;
    const option = buildOptionFeatures({
      symbol: normalizeSymbol(bar.symbol),
      asOf: decisionAsOf,
      close: typeof stock.currentTradablePrice === "number" ? stock.currentTradablePrice : bar.close,
      // Current OPRA evidence cannot retroactively populate historical bars.
      // Preserve genuine historical option snapshots when callers supply them.
      contracts: includeOptionEvidence ? symbolContracts : [],
      snapshots: includeOptionEvidence ? symbolSnapshots : [],
      maximumOptionSpreadPct: input.maximumOptionSpreadPct
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
      sourceFingerprint: fingerprint({ bar, stockSnapshot, option: option.materialEvidence }),
      optionCandidate: option.candidate
    };
  });
};

const targetFromFeature = (input: {
  feature: ReturnType<typeof calculateFeatures>[number];
  riskProfile: RiskProfile;
  learningAccuracy?: number | null;
  learningModelName?: string | null;
  decisionThresholds?: PaperExplorationThresholds;
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
  const marketImpliedVolatility = typeof values.atmImpliedVol === "number"
    ? values.atmImpliedVol
    : null;
  const volatilityAdjusted = marketImpliedVolatility === null
    ? EXISTING_NO_IV_VOLATILITY_MULTIPLIER
    : Math.max(0, Math.min(2, 1 + marketImpliedVolatility));
  const volatilityAdjustmentSource = marketImpliedVolatility === null
    ? "existing_strategy_baseline"
    : "alpaca_implied_volatility";
  const expectedReturn = directionScore * volatilityAdjusted;
  const learningBoost = Math.max(0, Math.min(1, (input.learningAccuracy ?? 0.5) - 0.5));
  const confidence = Math.max(0, Math.min(1, Math.abs(directionScore) / 2 + learningBoost * 0.2));
  const direction = classifyDirectionalScore(
    directionScore,
    input.decisionThresholds?.directionScore
  );
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
  }, input.riskProfile === "aggressive", input.decisionThresholds);
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
        impliedVolatility: marketImpliedVolatility,
        volatilityAdjustmentSource,
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
  decisionThresholds?: PaperExplorationThresholds;
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
      snapshots: input.optionsEnabled ? input.optionSnapshots : [],
      maximumOptionSpreadPct:
        input.decisionThresholds?.maximumOptionSpreadPct ??
        BASELINE_DECISION_THRESHOLDS.maximumOptionSpreadPct
    }));
    await yieldToEventLoop();
  }
  const features: PostgresFeatureSnapshot[] = calculated.map(({ optionCandidate: _candidate, ...feature }) => feature);
  const targets = Array.from(bySymbol.keys()).map((symbol) => {
    const latest = calculated.filter((row) => row.symbol === symbol).at(-1)!;
    return targetFromFeature({
      feature: latest,
      riskProfile: input.riskProfile,
      learningAccuracy: input.learningAccuracy,
      learningModelName: input.learningModelName,
      decisionThresholds: input.decisionThresholds
    });
  });
  await repository.upsertFeatureSnapshots(features, input.context);
  await repository.upsertTargetSnapshots(targets, input.context);
  return { features, targets };
};
