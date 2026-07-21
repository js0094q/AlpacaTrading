import { Pool, type PoolClient } from "pg";

import { normalizeOptionSnapshot } from "../src/services/optionSnapshotNormalizer.js";
import { normalizeStockSnapshot } from "../src/services/stockSnapshotNormalizer.js";
import { AlpacaStockStreamService } from "../src/services/alpacaStockStream.js";
import {
  fetchOptionContracts,
  fetchOptionSnapshots,
  fetchStockSnapshots
} from "../src/services/providers/alpaca.js";
import {
  buildMarketDataCoverage,
  runDeterministicMarketDataTrace
} from "../src/services/marketDataAvailabilityTraceService.js";

type JsonRecord = Record<string, unknown>;
type Asset = "equities" | "options" | "all";

const args = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...rest] = argument.split("=");
  return [key, rest.join("=") || true];
}));
const asset = String(args.get("--asset") ?? "all") as Asset;
const symbol = String(args.get("--symbol") ?? "SPY").trim().toUpperCase();
const jsonOutput = args.has("--json");
const now = new Date();

const requiredFalse = (name: string) => !["true", "1"].includes(String(process.env[name] ?? "").toLowerCase());
const assertSafety = () => {
  if (process.env.ALPACA_ENV !== "paper" || process.env.TRADING_MODE !== "paper") throw new Error("TRACE_PAPER_RUNTIME_REQUIRED");
  if (!requiredFalse("ALPACA_LIVE_TRADE") || !requiredFalse("LIVE_TRADING_ENABLED")) throw new Error("TRACE_LIVE_TRADING_DISABLED_REQUIRED");
  if ((process.env.DATABASE_BACKEND ?? "postgres") !== "postgres") throw new Error("TRACE_POSTGRES_REQUIRED");
  if (!requiredFalse("SQLITE_AUDIT_MIRROR_ENABLED")) throw new Error("TRACE_SQLITE_PROHIBITED");
  if (!process.env.DATABASE_URL) throw new Error("TRACE_POSTGRES_URL_REQUIRED");
};

const record = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const finite = (value: unknown) => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const first = (...values: unknown[]) => values.find((value) => value !== null && value !== undefined) ?? null;

const queryOne = async (client: PoolClient, sql: string, values: readonly unknown[]) =>
  (await client.query<JsonRecord>(sql, values as unknown[])).rows[0] ?? {};

const checkStockStream = async () => {
  const stream = new AlpacaStockStreamService({
    config: {
      enabled: true,
      url: "wss://stream.data.alpaca.markets/v2/sip",
      symbols: [symbol],
      trades: true,
      quotes: true,
      bars: true,
      reconnectMs: 60_000,
      staleAfterMs: 30_000
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined }
  });
  await stream.start();
  const deadline = Date.now() + 5_000;
  while (!stream.getStatus().authenticated && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const status = stream.getStatus();
  await stream.stop();
  return status;
};

const equityTrace = async (client: PoolClient) => {
  const response = (await fetchStockSnapshots({ symbols: [symbol], feed: "sip", currency: "USD" }))[0];
  const normalized = normalizeStockSnapshot({
    symbol, raw: response?.raw ?? null, observedAt: now.toISOString(), requestedFeed: response?.requestedFeed ?? "sip",
    effectiveFeed: response?.effectiveFeed ?? null, currency: response?.currency ?? "USD", requestId: response?.requestId ?? null,
    error: response?.error ?? null, now, maxAgeSeconds: 1_200
  });
  const persisted = await queryOne(client,
    `SELECT evidence, source_timestamp, requested_feed, effective_feed
       FROM stock_snapshots WHERE symbol = $1 ORDER BY observed_at DESC LIMIT 1`, [symbol]);
  const feature = await queryOne(client,
    `SELECT features FROM feature_snapshots WHERE symbol = $1 ORDER BY observed_at DESC LIMIT 1`, [symbol]);
  const evidence = record(persisted.evidence);
  const features = record(feature.features);
  const providerValues: JsonRecord = {
    latestTradePrice: normalized.latestTradePrice, latestTradeTimestamp: normalized.tradeTimestamp,
    bidPrice: normalized.bidPrice, askPrice: normalized.askPrice, bidSize: normalized.bidSize, askSize: normalized.askSize,
    midpoint: normalized.midpoint, spread: normalized.spread, spreadPct: normalized.spreadPct,
    open: normalized.dailyOpen, high: normalized.dailyHigh, low: normalized.dailyLow, close: normalized.dailyClose,
    volume: normalized.dailyVolume, tradeCount: normalized.dailyTradeCount, vwap: normalized.dailyVwap,
    previousClose: normalized.previousDailyClose, intradayReturn: normalized.returnFromOpen,
    relativeVolume: normalized.relativeCurrentDayVolume, rangePosition: normalized.dailyHigh !== null && normalized.dailyLow !== null && normalized.latestTradePrice !== null && normalized.dailyHigh > normalized.dailyLow
      ? (normalized.latestTradePrice - normalized.dailyLow) / (normalized.dailyHigh - normalized.dailyLow) : null,
    requestedFeed: normalized.requestedFeed, effectiveFeed: normalized.effectiveFeed,
    evidenceTimestamp: normalized.sourceTimestamp, freshnessStatus: normalized.freshnessStatus
  };
  const postgresValues: JsonRecord = {
    ...evidence, requestedFeed: persisted.requested_feed, effectiveFeed: persisted.effective_feed,
    evidenceTimestamp: persisted.source_timestamp
  };
  const decisionValues: JsonRecord = {
    latestTradePrice: features.latestTradePrice, bidPrice: features.bidPrice, askPrice: features.askPrice,
    midpoint: features.bidAskMidpoint, spread: features.absoluteSpread, spreadPct: features.percentageSpread,
    intradayReturn: features.intradayReturn, multiPeriodReturn5: features.multiPeriodReturn5,
    multiPeriodReturn20: features.multiPeriodReturn20, relativeVolume: first(features.snapshotRelativeVolume, features.relativeVolume),
    realizedVolatility: features.realizedVolatility20, rangePosition: features.currentRangePosition,
    trend: features.trend, sessionStatus: features.marketSessionEligible,
    evidenceTimestamp: features.stockEvidenceTimestamp, freshnessStatus: features.stockEvidenceFreshnessStatus
  };
  const report = buildMarketDataCoverage({
    asset: "equities", now: now.toISOString(),
    provider: { endpoint: "/v2/stocks/snapshots", feed: "sip", values: providerValues, timestamps: { quoteTimestamp: normalized.quoteTimestamp } },
    postgres: { table: "stock_snapshots.evidence", values: postgresValues },
    decision: { values: decisionValues, materiallyConsumed: ["midpoint", "intradayReturn", "relativeVolume", "realizedVolatility", "trend", "sessionStatus", "evidenceTimestamp", "freshnessStatus"] },
    requiredFields: ["latestTradePrice", "bidPrice", "askPrice", "midpoint", "effectiveFeed", "evidenceTimestamp", "freshnessStatus"]
  });
  const streamStatus = await checkStockStream();
  if (!streamStatus.authenticated || !streamStatus.subscribed) {
    report.executionAllowed = false;
    report.rejectionReasons.push("SIP_STREAM_AUTHENTICATION_UNAVAILABLE");
  }
  return { ...report, stream: "wss://stream.data.alpaca.markets/v2/sip", streamStatus, streamMapping: ["trade", "quote", "bar"] };
};

const optionTrace = async (client: PoolClient) => {
  const contracts = await fetchOptionContracts({ underlyingSymbols: [symbol], status: "active", minDaysToExpiration: 0, maxDaysToExpiration: 730, limit: 20 });
  const optionSymbols = contracts.map((contract) => String(contract.symbol ?? "")).filter(Boolean);
  const response = (await fetchOptionSnapshots(optionSymbols))[0];
  const contract = contracts.find((row) => row.symbol === response?.symbol) ?? contracts[0];
  const normalized = response ? normalizeOptionSnapshot(response.symbol, response.raw) : null;
  const persisted = await queryOne(client,
    `SELECT snapshot.*, contract.expiration_date, contract.strike, contract.type, contract.tradable
       FROM option_snapshots snapshot JOIN option_contracts contract USING (option_symbol)
      WHERE snapshot.underlying_symbol = $1 ORDER BY snapshot.observed_at DESC LIMIT 1`, [symbol]);
  const feature = await queryOne(client,
    `SELECT features FROM feature_snapshots WHERE symbol = $1 ORDER BY observed_at DESC LIMIT 1`, [symbol]);
  const candidate = await queryOne(client,
    `SELECT signal_inputs, score, confidence, expected_return FROM candidates
      WHERE symbol = $1 ORDER BY as_of DESC, rank ASC LIMIT 1`, [symbol]);
  const latestQuote = normalized?.latestQuote;
  const latestTrade = normalized?.latestTrade;
  const greeks = normalized?.greeks;
  const expiration = String(contract?.expiration_date ?? persisted.expiration_date ?? "");
  const strike = Number(contract?.strike_price ?? persisted.strike ?? NaN);
  const underlyingPrice = finite(record(feature.features).optionUnderlyingPrice);
  const midpoint = latestQuote?.bidPrice !== null && latestQuote?.bidPrice !== undefined && latestQuote.askPrice !== null && latestQuote.askPrice !== undefined
    ? (latestQuote.bidPrice + latestQuote.askPrice) / 2 : null;
  const dteHours = expiration && Number.isFinite(Date.parse(`${expiration}T20:00:00.000Z`))
    ? Math.max(0, (Date.parse(`${expiration}T20:00:00.000Z`) - now.getTime()) / 3_600_000) : null;
  const optionType = String(contract?.type ?? persisted.type ?? "");
  const intrinsic = underlyingPrice !== null && Number.isFinite(strike)
    ? optionType === "put" ? Math.max(0, strike - underlyingPrice) : Math.max(0, underlyingPrice - strike) : null;
  const providerValues: JsonRecord = {
    contractSymbol: response?.symbol ?? contract?.symbol ?? null, underlyingSymbol: normalized?.underlying ?? contract?.underlying_symbol ?? null,
    underlyingPrice, expiration, strike: Number.isFinite(strike) ? strike : null, type: optionType || null,
    tradable: contract?.tradable ?? null, activeStatus: contract?.status ?? null,
    bid: latestQuote?.bidPrice ?? null, ask: latestQuote?.askPrice ?? null,
    bidSize: latestQuote?.bidSize ?? null, askSize: latestQuote?.askSize ?? null, midpoint,
    spreadPct: midpoint && latestQuote?.bidPrice !== null && latestQuote?.bidPrice !== undefined && latestQuote.askPrice !== null && latestQuote.askPrice !== undefined
      ? (latestQuote.askPrice - latestQuote.bidPrice) / midpoint : null,
    latestTrade: latestTrade?.price ?? null, quoteTimestamp: latestQuote?.timestamp ?? null,
    tradeTimestamp: latestTrade?.timestamp ?? null, volume: finite(response?.raw.volume),
    openInterest: finite(first(response?.raw.open_interest, response?.raw.openInterest)),
    daysToExpiration: dteHours === null ? null : dteHours / 24, hoursToExpiration: dteHours,
    moneyness: underlyingPrice !== null && Number.isFinite(strike) ? (underlyingPrice - strike) / underlyingPrice : null,
    intrinsicValue: intrinsic, extrinsicValue: midpoint !== null && intrinsic !== null ? Math.max(0, midpoint - intrinsic) : null,
    impliedVolatility: normalized?.impliedVolatility ?? null,
    delta: greeks?.delta ?? null, gamma: greeks?.gamma ?? null, theta: greeks?.theta ?? null,
    vega: greeks?.vega ?? null, rho: greeks?.rho ?? null,
    feed: "opra", evidenceTimestamp: normalized?.snapshotTimestamp ?? null,
    freshnessStatus: normalized?.snapshotTimestamp && now.getTime() - Date.parse(normalized.snapshotTimestamp) <= 1_200_000 ? "FRESH" : "STALE"
  };
  const postgresValues: JsonRecord = {
    contractSymbol: persisted.option_symbol, underlyingSymbol: persisted.underlying_symbol,
    underlyingPrice: record(feature.features).optionUnderlyingPrice, expiration: persisted.expiration_date,
    strike: persisted.strike, type: persisted.type, tradable: persisted.tradable,
    bid: persisted.bid, ask: persisted.ask, midpoint: persisted.midpoint, latestTrade: persisted.last,
    quoteTimestamp: persisted.quote_timestamp, tradeTimestamp: persisted.trade_timestamp,
    volume: persisted.volume, openInterest: persisted.open_interest, impliedVolatility: persisted.implied_volatility,
    delta: persisted.delta, gamma: persisted.gamma, theta: persisted.theta, vega: persisted.vega, rho: persisted.rho,
    evidenceTimestamp: persisted.snapshot_timestamp
  };
  const features = record(feature.features);
  const decisionValues: JsonRecord = {
    underlyingPrice: features.optionUnderlyingPrice, midpoint: features.optionMidpoint,
    spreadPct: features.estimatedBidAskSpreadPct, daysToExpiration: features.daysToExpiration,
    hoursToExpiration: features.hoursToExpiration, moneyness: features.optionMoneyness,
    intrinsicValue: features.optionIntrinsicValue, extrinsicValue: features.optionExtrinsicValue,
    impliedVolatility: features.atmImpliedVol, delta: features.optionDelta, gamma: features.optionGamma,
    theta: features.optionTheta, vega: features.optionVega, rho: features.optionRho,
    quoteTimestamp: features.marketEvidenceTimestamp, evidenceTimestamp: features.marketEvidenceTimestamp,
    contractEligible: features.optionContractEligible, feed: features.optionFeedValidated
  };
  const report = buildMarketDataCoverage({
    asset: "options", now: now.toISOString(),
    provider: { endpoint: "/v1beta1/options/snapshots", feed: "opra", values: providerValues, timestamps: { quoteTimestamp: providerValues.quoteTimestamp } },
    postgres: { table: "option_snapshots", values: postgresValues },
    decision: { values: decisionValues, materiallyConsumed: ["underlyingPrice", "midpoint", "spreadPct", "daysToExpiration", "hoursToExpiration", "moneyness", "intrinsicValue", "extrinsicValue", "impliedVolatility", "delta", "gamma", "theta", "vega", "quoteTimestamp", "contractEligible", "feed"] },
    requiredFields: ["contractSymbol", "underlyingSymbol", "expiration", "strike", "type", "tradable", "bid", "ask", "midpoint", "quoteTimestamp", "feed", "evidenceTimestamp", "freshnessStatus"]
  });
  const actualDelta = finite(providerValues.delta);
  const coverage = [providerValues.delta, providerValues.gamma, providerValues.theta, providerValues.vega].filter((value) => value !== null).length / 4;
  const persistedLiquidity = finite(features.preferredContractLiquidityScore);
  const baseLiquidityScore = persistedLiquidity === null ? 0 : persistedLiquidity - coverage * 0.1;
  const trace = runDeterministicMarketDataTrace({
    baseline: {
      confidence: finite(candidate.confidence) ?? 0,
      expectedReturn: finite(candidate.expected_return) ?? 0,
      baseLiquidityScore,
      option: {
        symbol: String(providerValues.contractSymbol ?? ""), delta: actualDelta,
        gamma: finite(providerValues.gamma), theta: finite(providerValues.theta), vega: finite(providerValues.vega),
        impliedVolatility: finite(providerValues.impliedVolatility), spreadPct: finite(providerValues.spreadPct)
      }
    },
    field: "delta", afterValue: actualDelta === null ? 0.5 : null
  });
  return { ...report, contractsEndpoint: "/v2/options/contracts", deterministicTrace: trace };
};

const main = async () => {
  assertSafety();
  if (!(["equities", "options", "all"] as const).includes(asset)) throw new Error("TRACE_ASSET_INVALID");
  if (!symbol) throw new Error("TRACE_SYMBOL_REQUIRED");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const result: JsonRecord = { paperOnly: true, liveTradingEnabled: false, postgresOnly: true, symbol, generatedAt: now.toISOString() };
    if (asset === "equities" || asset === "all") result.equities = await equityTrace(client);
    if (asset === "options" || asset === "all") result.options = await optionTrace(client);
    await client.query("ROLLBACK");
    const reports = [result.equities, result.options].filter(Boolean).map(record);
    const failures = reports.flatMap((report) => (report.rejectionReasons as string[] | undefined) ?? []);
    result.status = failures.length ? "failed" : "passed";
    result.failures = failures;
    process.stdout.write(`${JSON.stringify(result, null, jsonOutput ? 2 : 2)}\n`);
    if (failures.length) process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "TRACE_MARKET_DATA_FAILED"}\n`);
  process.exitCode = 1;
});
