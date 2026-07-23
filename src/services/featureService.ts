import { getDb, queryAll } from "../lib/db.js";
import { getBars } from "./marketDataIngest.js";
import { getActiveSymbols, seedInitialUniverse } from "./universeService.js";
import { normalizeSymbol } from "../lib/utils.js";
import { sma, ema, rollingStd, rsi, atr, macd, classifyTrend, distanceFrom } from "./indicators.js";
import { getLatestStockObservationFeatures } from "./stockObservationService.js";
import { optionsQuoteConfig } from "./optionQuoteNormalizer.js";
import {
  buildOptionDecisionSnapshot,
  type OptionDecisionSnapshotEvidence
} from "./optionDecisionEvidenceService.js";
import type { Timeframe, FeatureSnapshotRow } from "../types.js";

const parseFeatureRow = (row: Record<string, unknown>): FeatureSnapshotRow => {
  const rawFeatures = row.features;
  const features =
    typeof rawFeatures === "string" ? JSON.parse(rawFeatures) : rawFeatures ?? {};
  return {
    symbol: String(row.symbol),
    timestamp: String(row.timestamp),
    features: features as Record<string, string | number | null>
  };
};

type OptionQuoteRow = {
  optionSymbol: string;
  type: "call" | "put";
  expirationDate: string;
  strike: number;
  multiplier: number | null;
  timestamp: string;
  daysToExpiration: number | null;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  last: number | null;
  quoteStatus: string | null;
  executable: number | null;
  executablePrice: number | null;
  executablePriceSource: string | null;
  rejectionReason: string | null;
  quoteTimestamp: string | null;
  quoteAgeMs: number | null;
  impliedVolatility: number | null;
  volume: number | null;
  openInterest: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  snapshotTimestamp: string | null;
  normalizationPath: string | null;
  source: string | null;
  sourceFeed: string | null;
  spreadPercentage: number | null;
};

type HistoricalIvRow = {
  timestamp: string;
  value: number;
};

interface OptionFeatureContext {
  latestContractRows: Map<string, OptionQuoteRow[]>;
  historicalImpliedVols: Map<string, HistoricalIvRow[]>;
}

const parseDate = (value: string): number | null => {
  const date = new Date(value);
  const millis = date.getTime();
  return Number.isNaN(millis) ? null : millis;
};

const readLatestContractRows = (symbol: string): OptionQuoteRow[] => {
  return getDb()
    .prepare(
      `
      SELECT
        c.option_symbol AS "optionSymbol",
        c.type,
        c.expiration_date AS "expirationDate",
        c.strike,
        c.multiplier,
        s.bid,
        s.ask,
        s.midpoint,
        s.last,
        s.timestamp,
        s.quote_status AS "quoteStatus",
        s.executable,
        s.executable_price AS "executablePrice",
        s.executable_price_source AS "executablePriceSource",
        s.rejection_reason AS "rejectionReason",
        s.quote_timestamp AS "quoteTimestamp",
        s.quote_age_ms AS "quoteAgeMs",
        s.days_to_expiration AS "daysToExpiration",
        s.implied_volatility AS "impliedVolatility",
        s.volume,
        s.open_interest AS "openInterest",
        s.delta,
        s.gamma,
        s.theta,
        s.vega,
        s.rho,
        s.snapshot_timestamp AS "snapshotTimestamp",
        s.normalization_path AS "normalizationPath",
        s.source,
        s.source_feed AS "sourceFeed",
        s.spread_percentage AS "spreadPercentage"
      FROM option_contracts AS c
      LEFT JOIN option_snapshots AS s
        ON s.option_symbol = c.option_symbol
        AND s.timestamp = (
          SELECT MAX(timestamp)
          FROM option_snapshots
          WHERE option_symbol = c.option_symbol
        )
      WHERE c.underlying_symbol = ? AND c.tradable = 1
      `
    )
    .all(symbol) as OptionQuoteRow[];
};

const getLatestContractRows = (
  symbol: string,
  context: OptionFeatureContext
): OptionQuoteRow[] => {
  const normalized = normalizeSymbol(symbol);
  const cached = context.latestContractRows.get(normalized);
  if (cached) {
    return cached;
  }
  const rows = readLatestContractRows(normalized);
  context.latestContractRows.set(normalized, rows);
  return rows;
};

const readHistoricalImpliedVols = (symbol: string): HistoricalIvRow[] => {
  const rows = getDb()
    .prepare(
      `
      SELECT s.timestamp, s.implied_volatility
      FROM option_snapshots AS s
      JOIN option_contracts AS c ON c.option_symbol = s.option_symbol
      WHERE c.underlying_symbol = ?
        AND s.implied_volatility IS NOT NULL
      `
    )
    .all(normalizeSymbol(symbol)) as Array<{
      timestamp: string;
      implied_volatility: number | null;
    }>;
  return rows
    .filter((row) => typeof row.implied_volatility === "number")
    .map((row) => ({
      timestamp: row.timestamp,
      value: row.implied_volatility as number
    }));
};

const getHistoricalImpliedVols = (
  symbol: string,
  asOf: string,
  context: OptionFeatureContext
): number[] => {
  const normalized = normalizeSymbol(symbol);
  const cached = context.historicalImpliedVols.get(normalized);
  const rows = cached ?? readHistoricalImpliedVols(normalized);
  if (!cached) {
    context.historicalImpliedVols.set(normalized, rows);
  }
  return rows
    .filter((row) => row.timestamp <= asOf)
    .map((row) => row.value);
};

const impliedVolPercentile = (value: number | null, samples: number[]): number | null => {
  if (value === null || samples.length === 0) {
    return null;
  }
  const ordered = [...samples].sort((a, b) => a - b);
  const position = ordered.filter((entry) => entry <= value).length;
  return position / ordered.length;
};

const buildOptionFeatures = (
  symbol: string,
  asOf: string,
  close: number,
  context: OptionFeatureContext
): {
  nearestExpiration: string | null;
  daysToExpiration: number | null;
  atmImpliedVol: number | null;
  ivPercentile: number | null;
  callLiquidityAvailable: number;
  putLiquidityAvailable: number;
  callSpreadAvailable: number;
  putSpreadAvailable: number;
  estimatedBidAskSpreadPct: number | null;
  preferredContractLiquidityScore: number;
  optionSuitability: "suitable" | "marginal" | "unsuitable" | "insufficient_data";
  optionDecisionSnapshot: OptionDecisionSnapshotEvidence;
} => {
  const asOfTs = parseDate(asOf);
  const rows = getLatestContractRows(symbol, context).filter((row) =>
    row.bid != null || row.ask != null || row.midpoint != null || row.impliedVolatility != null || row.volume != null || row.openInterest != null
  );

  if (!rows.length || asOfTs === null) {
    return {
      nearestExpiration: null,
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
      optionDecisionSnapshot: buildOptionDecisionSnapshot({
        contract: null,
        snapshot: null,
        decisionTimestamp: asOf,
        underlyingPrice: close,
        underlyingPriceSource: "stock_bar_close",
        maxQuoteAgeMs: optionsQuoteConfig().maxAgeMs
      })
    };
  }

  const dated = rows.filter((row) => {
    const expirationTs = parseDate(row.expirationDate);
    return expirationTs !== null && expirationTs >= asOfTs;
  });
  if (!dated.length) {
    return {
      nearestExpiration: null,
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
      optionDecisionSnapshot: buildOptionDecisionSnapshot({
        contract: null,
        snapshot: null,
        decisionTimestamp: asOf,
        underlyingPrice: close,
        underlyingPriceSource: "stock_bar_close",
        maxQuoteAgeMs: optionsQuoteConfig().maxAgeMs
      })
    };
  }

  const nearestExpiration = dated
    .map((row) => ({ ...row, expirationTs: parseDate(row.expirationDate)! }))
    .sort((a, b) => (a.expirationTs < b.expirationTs ? -1 : a.expirationTs > b.expirationTs ? 1 : 0))[0]!
    .expirationDate;
  const nearestTs = parseDate(nearestExpiration)!;
  const nearestRows = dated.filter(
    (row) => parseDate(row.expirationDate) === nearestTs
  );
  const callRows = nearestRows.filter((row) => row.type === "call");
  const putRows = nearestRows.filter((row) => row.type === "put");
  const callLiquidityAvailable = callRows.length;
  const putLiquidityAvailable = putRows.length;
  const callSpreadAvailable = callRows.length >= 2 ? 1 : 0;
  const putSpreadAvailable = putRows.length >= 2 ? 1 : 0;

  const callsOrPuts = [...callRows, ...putRows];
  const weighted = callsOrPuts.find((row) => close == null || Number.isNaN(close) ? false : true);
  const nearest = callsOrPuts
    .map((row) => ({
      row,
      distance: Math.abs(row.strike - close)
    }))
    .sort((a, b) => a.distance - b.distance)[0];
  const selected = nearest?.row ?? null;

  const atmImpliedVol = selected?.impliedVolatility ?? null;
  const ivPercentile = impliedVolPercentile(
    atmImpliedVol,
    getHistoricalImpliedVols(symbol, asOf, context)
  );
  const estimatedBidAskSpreadPct =
    selected?.bid == null || selected?.ask == null || selected.bid <= 0
      ? null
      : (selected.ask - selected.bid) / selected.bid;

  const liquiditySignal =
    (selected?.volume ?? 0) + (selected?.openInterest ?? 0);
  const spreadSignal = estimatedBidAskSpreadPct === null ? 0 : 1 - Math.min(1, Math.abs(estimatedBidAskSpreadPct));
  const preferredContractLiquidityScore =
    Math.max(0, Math.min(1, (callLiquidityAvailable + putLiquidityAvailable) / 10)) * 0.6 +
    Math.min(1, liquiditySignal / 10000) * 0.4 +
    spreadSignal * 0.2;

  const hasLiquidity = (selected?.volume ?? 0) > 0 || (selected?.openInterest ?? 0) > 0;
  const optionSuitability =
    hasLiquidity && preferredContractLiquidityScore > 0.7 ? "suitable" :
    hasLiquidity && preferredContractLiquidityScore > 0.35 ? "marginal" : "unsuitable";

  const daysToExpiration = Math.max(
    0,
    Math.round((nearestTs - asOfTs) / (24 * 60 * 60 * 1000))
  );

  const optionDecisionSnapshot = buildOptionDecisionSnapshot({
    contract: selected
      ? {
          optionSymbol: selected.optionSymbol,
          underlyingSymbol: symbol,
          type: selected.type,
          expirationDate: selected.expirationDate,
          strike: selected.strike,
          multiplier: selected.multiplier
        }
      : null,
    snapshot: selected
      ? {
          optionSymbol: selected.optionSymbol,
          underlyingSymbol: symbol,
          timestamp: selected.timestamp,
          bid: selected.bid,
          ask: selected.ask,
          midpoint: selected.midpoint,
          last: selected.last,
          quoteStatus: selected.quoteStatus,
          executable: selected.executable,
          executablePrice: selected.executablePrice,
          executablePriceSource: selected.executablePriceSource,
          rejectionReason: selected.rejectionReason,
          quoteTimestamp: selected.quoteTimestamp,
          quoteAgeMs: selected.quoteAgeMs,
          volume: selected.volume,
          openInterest: selected.openInterest,
          impliedVolatility: selected.impliedVolatility,
          delta: selected.delta,
          gamma: selected.gamma,
          theta: selected.theta,
          vega: selected.vega,
          rho: selected.rho,
          snapshotTimestamp: selected.snapshotTimestamp,
          normalizationPath: selected.normalizationPath,
          source: selected.source,
          sourceFeed: selected.sourceFeed,
          spreadPercentage: selected.spreadPercentage
        }
      : null,
    decisionTimestamp: asOf,
    daysToExpiration: selected?.daysToExpiration ?? null,
    underlyingPrice: close,
    underlyingPriceSource: "stock_bar_close",
    derived: {
      spreadPercentage: selected?.spreadPercentage ?? null,
      liquidityScore: preferredContractLiquidityScore,
      ivPercentile,
      candidateScore: null
    },
    selectionBinding: selected ? "nearest_contract_feature_snapshot" : "not_bound",
    maxQuoteAgeMs: optionsQuoteConfig().maxAgeMs
  });

  return {
    nearestExpiration,
    daysToExpiration,
    atmImpliedVol,
    ivPercentile,
    callLiquidityAvailable,
    putLiquidityAvailable,
    callSpreadAvailable,
    putSpreadAvailable,
    estimatedBidAskSpreadPct,
    preferredContractLiquidityScore,
    optionSuitability,
    optionDecisionSnapshot
  };
};

interface BarRecord {
  symbol: string;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface FeatureMap {
  symbol: string;
  timestamp: string;
  features: Record<string, unknown>;
}

const featureRow = (symbol: string, timestamp: string, values: Record<string, unknown>): FeatureMap => ({
  symbol,
  timestamp,
  features: values
});

export const getLatestFeatures = () =>
  queryAll<Record<string, unknown>>(
    `
    SELECT f.symbol, f.timestamp, f.features
    FROM feature_snapshots f
    INNER JOIN (
      SELECT symbol, MAX(timestamp) AS timestamp
      FROM feature_snapshots
      GROUP BY symbol
    ) x ON f.symbol = x.symbol AND f.timestamp = x.timestamp
    `
  ).map(parseFeatureRow);

const collectBars = (
  symbol: string,
  timeframe: Timeframe,
  start?: string,
  end?: string
): BarRecord[] =>
  getBars(symbol, timeframe, start, end).map((bar) => ({
    ...bar,
    symbol: normalizeSymbol(bar.symbol),
    open: Number(bar.open),
    high: Number(bar.high),
    low: Number(bar.low),
    close: Number(bar.close),
    volume: Number(bar.volume)
  }));

const calculateRows = (
  bars: BarRecord[],
  optionContext: OptionFeatureContext
): FeatureMap[] => {
  const closes = bars.map((row) => row.close);
  const highs = bars.map((row) => row.high);
  const lows = bars.map((row) => row.low);
  const volumes = bars.map((row) => row.volume);

  const closesLog = closes.map((close, index, arr) =>
    index === 0 || arr[index - 1] <= 0 || close <= 0
      ? null
      : Math.log(close / arr[index - 1])
  );
  const closesChange = closes.map((close, index, arr) =>
    index === 0 ? null : close - arr[index - 1]
  );

  const out: FeatureMap[] = [];
  for (let i = 0; i < bars.length; i += 1) {
    const closeSeries = closes.slice(0, i + 1);
    const highSeries = highs.slice(0, i + 1);
    const lowSeries = lows.slice(0, i + 1);
    const changeSeries = closesChange.slice(0, i + 1).filter((c): c is number => c !== null);
    const logReturn = closesLog[i];
    const dayReturn = closesChange[i];
    const sma10 = sma(closeSeries, 10);
    const sma20 = sma(closeSeries, 20);
    const sma50 = sma(closeSeries, 50);
    const sma200 = sma(closeSeries, 200);
    const ema9 = ema(closeSeries, 9);
    const ema21 = ema(closeSeries, 21);
    const vol20 = rollingStd(changeSeries.length ? changeSeries.map((v) => v) : [0], 20);
    const vol5 = rollingStd(changeSeries.length ? changeSeries.map((v) => v) : [0], 5);
    const vol10 = rollingStd(changeSeries.length ? changeSeries.map((v) => v) : [0], 10);
    const vol60 = rollingStd(changeSeries.length ? changeSeries.map((v) => v) : [0], 60);
    const atr14 = atr(highSeries, lowSeries, closeSeries, 14);
    const macdValues = macd(closeSeries);
    const avgVol20 = sma(volumes.slice(0, i + 1), 20);
    const relVol = avgVol20 && avgVol20 !== 0 ? volumes[i] / avgVol20 : null;
    const high20 = sma10 && sma20 ? Math.max(...highSeries.slice(-20)) : null;
    const low20 = sma10 && sma20 ? Math.min(...lowSeries.slice(-20)) : null;
    const rsi14 = rsi(changeSeries, 14);
    const trend = classifyTrend({
      sma10,
      sma20,
      sma50,
      close: closes[i]
    });
    const optionMetrics = buildOptionFeatures(
      bars[i].symbol,
      bars[i].timestamp,
      closes[i],
      optionContext
    );

    out.push(
      featureRow(bars[i].symbol, bars[i].timestamp, {
        close: closes[i],
        open: bars[i].open,
        high: bars[i].high,
        low: bars[i].low,
        volume: volumes[i],
        dailyReturn: dayReturn,
        logReturn,
        volatility5: vol5,
        volatility10: vol10,
        volatility20: vol20,
        volatility60: vol60,
        sma10,
        sma20,
        sma50,
        sma200,
        ema9,
        ema21,
        rsi14,
        atr14,
        macd: macdValues.macd,
        macdSignal: macdValues.signal,
        macdHistogram: macdValues.histogram,
        volumeAvg20: avgVol20,
        relativeVolume: relVol,
        distanceFrom20High: distanceFrom(highs[i], high20),
        distanceFrom20Low: distanceFrom(lows[i], low20),
        trend,
        optionsNearestExpiration: optionMetrics.nearestExpiration,
        daysToExpiration: optionMetrics.daysToExpiration,
        atmImpliedVol: optionMetrics.atmImpliedVol,
        ivPercentile: optionMetrics.ivPercentile,
        callLiquidityAvailable: optionMetrics.callLiquidityAvailable,
        putLiquidityAvailable: optionMetrics.putLiquidityAvailable,
        callSpreadAvailable: optionMetrics.callSpreadAvailable,
        putSpreadAvailable: optionMetrics.putSpreadAvailable,
        estimatedBidAskSpreadPct: optionMetrics.estimatedBidAskSpreadPct,
        preferredContractLiquidityScore: optionMetrics.preferredContractLiquidityScore,
        optionSuitability: optionMetrics.optionSuitability,
        optionDecisionSnapshot: optionMetrics.optionDecisionSnapshot
      })
    );
  }
  return out;
};

export const buildFeatures = async (options?: {
  symbols?: string[];
  timeframe?: Timeframe;
  start?: string;
  end?: string;
}) => {
  await seedInitialUniverse();
  const symbols = (options?.symbols?.length ? options.symbols : getActiveSymbols()).map(normalizeSymbol);
  const timeframe = options?.timeframe || "1Day";
  const insert = getDb().prepare(`
    INSERT INTO feature_snapshots(symbol, timestamp, features)
    VALUES (?, ?, ?)
    ON CONFLICT(symbol, timestamp) DO UPDATE SET features = excluded.features
  `);
  const optionContext: OptionFeatureContext = {
    latestContractRows: new Map(),
    historicalImpliedVols: new Map()
  };
  let total = 0;
  const results: FeatureMap[] = [];
  const db = getDb();
  db.exec("BEGIN");
  try {
    for (const symbol of symbols) {
      const bars = collectBars(symbol, timeframe, options?.start, options?.end);
      const featureRows = calculateRows(bars, optionContext);
      const latestObservation = getLatestStockObservationFeatures(symbol);
      const latestFeatureRow = featureRows.at(-1);
      if (latestObservation && latestFeatureRow) {
        latestFeatureRow.features = {
          ...latestFeatureRow.features,
          ...latestObservation
        };
      }
      for (const row of featureRows) {
        insert.run(row.symbol, row.timestamp, JSON.stringify(row.features));
        total += 1;
        results.push(row);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { featuresStored: total, symbolsProcessed: symbols.length, rows: results };
};
