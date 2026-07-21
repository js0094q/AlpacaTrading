import { config as loadDotenv } from "dotenv";

import { canonicalJsonHash } from "../../lib/canonicalJson.js";
import { recordApiRequest } from "../apiLog.js";
import { assertReadOnlyAlpacaAccessAllowed } from "../tradingSafetyService.js";
import type { Timeframe } from "../../types.js";
import type { StockSnapshotRaw } from "../stockSnapshotNormalizer.js";

loadDotenv();
loadDotenv({ path: ".env.txt", override: false });

const firstEnv = (...names: string[]) => {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
};
const marketConfig = {
  paperKey: firstEnv("ALPACA_PAPER_API_KEY", "ALPACA_PAPER_KEY", "ALPACA_API_KEY"),
  paperSecret: firstEnv("ALPACA_PAPER_SECRET_KEY", "ALPACA_PAPER_SECRET", "ALPACA_SECRET_KEY"),
  paperBaseUrl: firstEnv("ALPACA_PAPER_BASE_URL") || "https://paper-api.alpaca.markets",
  dataBaseUrl: firstEnv("ALPACA_DATA_BASE_URL") || "https://data.alpaca.markets",
  stockDataFeed: process.env.ALPACA_STOCK_DATA_FEED?.trim() || "sip",
  optionDataFeed: process.env.ALPACA_OPTION_DATA_FEED?.trim() || "opra",
  requestTimeoutMs: Number.parseInt(process.env.ALPACA_REQUEST_TIMEOUT_MS || "15000", 10) || 15000,
  maxRetries: Math.max(0, Number.parseInt(process.env.ALPACA_MAX_RETRIES || "2", 10) || 0),
  userAgent: process.env.ALPACA_USER_AGENT || "alpaca-research-cli"
};

export interface RawBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface ApiResponse<T> {
  data: T;
  requestId: string | null;
}

const getAuthHeaders = (): Record<string, string> => {
  const key = marketConfig.paperKey;
  const secret = marketConfig.paperSecret;
  return key && secret
    ? {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret
      }
    : {};
};

const MAX_MARKET_DATA_PAGES = 100;
const MAX_OPTION_CONTRACT_PAGES = 50;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const executeWithTimeout = async <T>(
  timeoutMs: number,
  task: (signal: AbortSignal) => Promise<T>
): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
};

const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

const normalizeBarsPayload = (
  value: unknown
): Record<string, RawBar[]> => {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, rows]) => Array.isArray(rows))
      .filter(([symbol]) => symbol.trim().length > 0)
      .map(([symbol, rows]) => [symbol.toUpperCase(), rows]) as Array<
        [string, RawBar[]]
      >
  );
};

const requestJson = async <T>(
  endpoint: string,
  options: RequestInit = {},
  baseUrl: "data" | "trade" = "data"
): Promise<ApiResponse<T>> => {
  assertReadOnlyAlpacaAccessAllowed();
  const apiRoot = baseUrl === "trade"
    ? marketConfig.paperBaseUrl
    : marketConfig.dataBaseUrl;
  const timeoutMs = marketConfig.requestTimeoutMs;
  const maxRetries = marketConfig.maxRetries;
  let response: Response | null = null;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      response = await executeWithTimeout(timeoutMs, (signal) =>
        fetch(`${apiRoot}${endpoint}`, {
          ...options,
          headers: {
            ...(options.headers || {}),
            ...getAuthHeaders(),
            "Content-Type": "application/json",
            "User-Agent": marketConfig.userAgent
          },
          signal
        })
      );
      break;
    } catch (error) {
      lastError = isAbortError(error)
        ? new Error(`Alpaca request timed out after ${timeoutMs}ms.`)
        : error;

      if (attempt >= maxRetries) {
        throw lastError;
      }
    }
  }

  if (!response) {
    throw lastError instanceof Error
      ? lastError
      : new Error("Alpaca request failed and could not be completed.");
  }

  const requestId = response.headers.get("x-request-id");
  const status = response.status;
  const text = await response.text();
  let parsedBody: unknown = {};
  if (text) {
    try {
      parsedBody = JSON.parse(text) as T;
    } catch {
      parsedBody = text;
    }
  }
  recordApiRequest({
    provider: "alpaca",
    endpoint,
    method: options.method || "GET",
    status,
    requestId
  });
  if (!response.ok) {
    const body = typeof parsedBody === "string"
      ? parsedBody.slice(0, 200)
      : JSON.stringify(parsedBody);
    throw new Error(
      `Alpaca request failed for ${endpoint}. status=${status}; requestId=${requestId || "none"}; body=${body || "empty"}`
    );
  }
  if (typeof parsedBody === "string") {
    throw new Error(`Alpaca request returned non-JSON data for ${endpoint}.`);
  }
  return { data: parsedBody as T, requestId };
};

const toSearchParams = (params: Record<string, string | number | undefined | null>) => {
  const urlParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      return;
    }
    urlParams.set(key, String(value));
  });
  return urlParams.toString();
};

export interface ProviderOptions {
  symbols?: string[];
  timeframe?: Timeframe;
  start?: string;
  end?: string;
  feed?: string;
  pageToken?: string | null;
}

export interface OptionChainFilters {
  underlyingSymbols?: string[];
  minDaysToExpiration?: number | null;
  maxDaysToExpiration?: number | null;
  expirationDate?: string | null;
  expirationDateGte?: string | null;
  expirationDateLte?: string | null;
  minDelta?: number | null;
  maxDelta?: number | null;
  status?: "active" | "inactive" | null;
  limit?: number | null;
}

export interface OptionContractRaw {
  requestId?: string | null;
  retrievedAt?: string;
  id?: string | null;
  symbol?: string;
  underlying_symbol?: string;
  root_symbol?: string;
  type?: "call" | "put" | string;
  expiration_date?: string;
  strike_price?: number | string;
  multiplier?: number | string;
  size?: number | string;
  open_interest?: number | string | null;
  openInterest?: number | string | null;
  tradable?: boolean;
  tradeable?: boolean;
  status?: string;
  style?: string | null;
  exercise_style?: string | null;
  open_interest_date?: string | null;
  close_price?: number | string | null;
  close_price_date?: string | null;
}

interface OptionSnapshotComponentRaw {
  [key: string]: unknown;
  t?: string | null;
  timestamp?: string | null;
  bp?: number | null;
  ap?: number | null;
  b?: number | null;
  a?: number | null;
  bs?: number | null;
  as?: number | null;
  p?: number | null;
  s?: number | null;
  o?: number | null;
  h?: number | null;
  l?: number | null;
  c?: number | null;
  v?: number | null;
  vw?: number | null;
  n?: number | null;
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  rho?: number | null;
}

export interface OptionSnapshotRaw {
  [key: string]: unknown;
  symbol?: string;
  underlying_symbol?: string;
  volume?: number | string | null;
  open_interest?: number | string | null;
  openInterest?: number | string | null;
  snapshotTimestamp?: string | null;
  snapshot_timestamp?: string | null;
  timestamp?: string | null;
  Greeks?: OptionSnapshotComponentRaw;
  greeks?: OptionSnapshotComponentRaw;
  latest_quote?: OptionSnapshotComponentRaw;
  latestQuote?: OptionSnapshotComponentRaw;
  latest_trade?: OptionSnapshotComponentRaw;
  latestTrade?: OptionSnapshotComponentRaw;
  daily_bar?: OptionSnapshotComponentRaw;
  dailyBar?: OptionSnapshotComponentRaw;
  implied_volatility?: number | null;
  impliedVolatility?: number | null;
}

export interface FetchedOptionChainSnapshot {
  symbol: string;
  raw: OptionSnapshotRaw;
  requestId: string | null;
  endpoint: string;
  underlyingSymbol: string;
  requestedFeed: string;
  effectiveFeed: string | null;
  validationBasis?: "request_feed_opra";
  pageToken: string | null;
  retrievedAt: string;
}

export interface FetchedOptionChain {
  underlyingSymbol: string;
  pagesConsumed: number;
  snapshots: FetchedOptionChainSnapshot[];
}

export interface OptionQuoteRaw {
  [key: string]: unknown;
  t?: string | null;
  bp?: number | null;
  ap?: number | null;
  b?: number | null;
  a?: number | null;
  bs?: number | null;
  as?: number | null;
}

const parseOptionContractPayload = (payload: unknown): OptionContractRaw[] => {
  const value = payload as {
    option_contracts?: OptionContractRaw[];
    contracts?: OptionContractRaw[];
  };
  if (Array.isArray(value.option_contracts)) {
    return value.option_contracts;
  }
  if (Array.isArray(value.contracts)) {
    return value.contracts;
  }
  return [];
};

const parseOptionSnapshotPayload = (
  payload: unknown
): { symbol: string; data: OptionSnapshotRaw }[] => {
  const result: { symbol: string; data: OptionSnapshotRaw }[] = [];
  if (!payload || typeof payload !== "object") {
    return result;
  }
  const value = payload as {
    snapshots?: Record<string, OptionSnapshotRaw>;
    data?: Record<string, OptionSnapshotRaw>;
    options?: Record<string, OptionSnapshotRaw>;
  };
  const map = value.snapshots || value.data || value.options || {};
  for (const [symbol, data] of Object.entries(map)) {
    if (symbol && data) {
      result.push({ symbol, data });
    }
  }
  return result;
};

const parseOptionQuotePayload = (
  payload: unknown
): { symbol: string; data: OptionQuoteRaw }[] => {
  const result: { symbol: string; data: OptionQuoteRaw }[] = [];
  if (!payload || typeof payload !== "object") {
    return result;
  }
  const value = payload as {
    quotes?: Record<string, OptionQuoteRaw>;
    data?: Record<string, OptionQuoteRaw>;
    quote?: OptionQuoteRaw;
    symbol?: string;
  };
  if (value.quote && value.symbol) {
    result.push({ symbol: value.symbol, data: value.quote });
    return result;
  }
  const map = value.quotes || value.data || {};
  for (const [symbol, data] of Object.entries(map)) {
    if (symbol && data) {
      result.push({ symbol, data });
    }
  }
  return result;
};

const parseStockSnapshotPayload = (payload: unknown): Record<string, StockSnapshotRaw> => {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const value = payload as {
    snapshots?: Record<string, StockSnapshotRaw>;
    data?: Record<string, StockSnapshotRaw>;
  };
  const map = value.snapshots ?? value.data ?? payload as Record<string, StockSnapshotRaw>;
  return Object.fromEntries(
    Object.entries(map)
      .filter(([symbol, snapshot]) => symbol.trim().length > 0 && snapshot && typeof snapshot === "object")
      .map(([symbol, snapshot]) => [symbol.trim().toUpperCase(), snapshot])
  );
};

const dateOnly = (value: Date = new Date()) => value.toISOString().slice(0, 10);

const dateOnlyFromDays = (days: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + Math.floor(days));
  return dateOnly(date);
};

const assertDateOnly = (value: string, label: string) => {
  if (!ISO_DATE_RE.test(value)) {
    throw new Error(`Invalid option contract date filter: ${label}=${value}; expected YYYY-MM-DD.`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const utc = Date.UTC(year!, month! - 1, day!);
  if (Number.isNaN(utc) || new Date(utc).toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid option contract date filter: ${label}=${value}; expected a real calendar date.`);
  }
};

const utcDayNumber = (value: string) => {
  assertDateOnly(value, "expiration_date");
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year!, month! - 1, day!) / MS_PER_DAY);
};

const daysToExpirationDateOnly = (expirationDate: string) =>
  utcDayNumber(expirationDate) - utcDayNumber(dateOnly());

const normalizeOptionContractLimit = (limit?: number | null) => {
  if (!Number.isFinite(limit || NaN) || !limit) {
    return 1000;
  }
  return Math.max(1, Math.min(1000, Math.floor(limit)));
};

const optionContractParams = (
  filters: OptionChainFilters,
  pageToken?: string | null
) => {
  const expirationDate = filters.expirationDate || undefined;
  const expirationDateGte =
    filters.expirationDateGte ||
    (filters.minDaysToExpiration !== null && filters.minDaysToExpiration !== undefined
      ? dateOnlyFromDays(filters.minDaysToExpiration)
      : undefined);
  const expirationDateLte =
    filters.expirationDateLte ||
    (filters.maxDaysToExpiration !== null && filters.maxDaysToExpiration !== undefined
      ? dateOnlyFromDays(filters.maxDaysToExpiration)
      : undefined);

  if (expirationDate) {
    assertDateOnly(expirationDate, "expiration_date");
  }
  if (expirationDateGte) {
    assertDateOnly(expirationDateGte, "expiration_date_gte");
  }
  if (expirationDateLte) {
    assertDateOnly(expirationDateLte, "expiration_date_lte");
  }
  if (expirationDateGte && expirationDateLte && utcDayNumber(expirationDateGte) > utcDayNumber(expirationDateLte)) {
    throw new Error(
      `Invalid option contract date filter: expiration_date_gte=${expirationDateGte} is after expiration_date_lte=${expirationDateLte}.`
    );
  }

  return {
    underlying_symbols: filters.underlyingSymbols?.join(","),
    status: filters.status ?? "active",
    expiration_date: expirationDate,
    expiration_date_gte: expirationDate ? undefined : expirationDateGte,
    expiration_date_lte: expirationDate ? undefined : expirationDateLte,
    page_token: pageToken ?? undefined,
    limit: normalizeOptionContractLimit(filters.limit)
  };
};

export const buildOptionContractsEndpoint = (
  filters: OptionChainFilters,
  pageToken?: string | null
) => `/v2/options/contracts?${toSearchParams(optionContractParams(filters, pageToken))}`;

export const fetchBars = async (options: ProviderOptions): Promise<{ symbol: string; bars: RawBar[]; requestId: string | null }[]> => {
  const timeframe = options.timeframe || "1Day";
  const params = toSearchParams({
    symbols: options.symbols?.join(","),
    timeframe,
    start: options.start,
    end: options.end,
    feed: options.feed || marketConfig.stockDataFeed,
    page_token: options.pageToken,
    limit: 1000
  });

  const endpoint = `/v2/stocks/bars${params ? `?${params}` : ""}`;
  const response = await requestJson<{ bars?: Record<string, RawBar[]>; next_page_token?: string }>(
    endpoint,
    { method: "GET" }
  );
  const bars = response.data.bars || {};
  return Object.entries(bars).map(([symbol, rows]) => ({
    symbol,
    bars: rows,
    requestId: response.requestId
  }));
};

export const fetchAllBars = async (
  options: ProviderOptions
): Promise<{ symbol: string; bar: RawBar; requestIds: Array<string | null> }[]> => {
  let pageToken: string | null = options.pageToken ?? null;
  const out: { symbol: string; bar: RawBar; requestIds: Array<string | null> }[] = [];
  const seenTokens = new Set<string>();
  let pageCount = 0;
  if (pageToken) {
    seenTokens.add(pageToken);
  }

  while (true) {
    pageCount += 1;
    if (pageCount > MAX_MARKET_DATA_PAGES) {
      throw new Error(
        `Alpaca bars pagination exceeded safety cap (${MAX_MARKET_DATA_PAGES} pages).`
      );
    }

    const params = toSearchParams({
      symbols: options.symbols?.join(","),
      timeframe: options.timeframe || "1Day",
      start: options.start,
      end: options.end,
      feed: options.feed || marketConfig.stockDataFeed,
      page_token: pageToken ?? undefined,
      limit: 1000
    });
    const response = await requestJson<{ bars?: Record<string, RawBar[]>; next_page_token?: string }>(
      `/v2/stocks/bars${params ? `?${params}` : ""}`,
      { method: "GET" }
    );
    const bars = normalizeBarsPayload(response.data?.bars);
    const hasBars = Object.values(bars).some((rows) => rows.length > 0);
    for (const [symbol, rows] of Object.entries(bars)) {
      for (const bar of rows) {
        out.push({
          symbol,
          bar,
          requestIds: [response.requestId]
        });
      }
    }

    const next = response.data && response.data.next_page_token;
    if (!next && !hasBars) {
      break;
    }
    if (!next) {
      break;
    }

    if (typeof next !== "string" || next.length === 0) {
      throw new Error(`Alpaca bars pagination returned invalid next token: ${String(next)}`);
    }
    if (seenTokens.has(next)) {
      throw new Error(`Alpaca bars pagination repeated token: ${next}`);
    }
    seenTokens.add(next);
    pageToken = next;
  }
  return out;
};

export const fetchOptionContracts = async (
  filters: OptionChainFilters
): Promise<OptionContractRaw[]> => {
  const contracts: OptionContractRaw[] = [];
  const requestedLimit =
    filters.limit === undefined || filters.limit === null
      ? null
      : normalizeOptionContractLimit(filters.limit);
  let pageToken: string | null = null;
  const seenTokens = new Set<string>();
  let pageCount = 0;

  while (true) {
    pageCount += 1;
    if (pageCount > MAX_OPTION_CONTRACT_PAGES) {
      throw new Error(
        `Alpaca option contract pagination exceeded safety cap (${MAX_OPTION_CONTRACT_PAGES} pages).`
      );
    }

    const endpoint = buildOptionContractsEndpoint(filters, pageToken);
    const response = await requestJson<{
      option_contracts?: OptionContractRaw[];
      contracts?: OptionContractRaw[];
      next_page_token?: string | null;
      page_token?: string | null;
    }>(endpoint, { method: "GET" }, "trade");
    const retrievedAt = new Date().toISOString();
    const pageContracts = parseOptionContractPayload(response.data).map((contract) => ({
      ...contract,
      requestId: response.requestId,
      retrievedAt
    }));
    const remaining = requestedLimit === null
      ? pageContracts
      : pageContracts.slice(0, Math.max(0, requestedLimit - contracts.length));
    contracts.push(...remaining);

    if (requestedLimit !== null && contracts.length >= requestedLimit) {
      break;
    }

    const next = response.data.next_page_token || response.data.page_token || null;
    if (!next) {
      break;
    }
    if (seenTokens.has(next)) {
      throw new Error(`Alpaca option contract pagination repeated token: ${next}`);
    }
    seenTokens.add(next);
    pageToken = next;
  }

  const filtered = contracts.filter((contract) => {
    const expiration = contract.expiration_date;
    if (!expiration) {
      return false;
    }
    if (filters.expirationDate && expiration !== filters.expirationDate) {
      return false;
    }
    let days: number;
    try {
      days = daysToExpirationDateOnly(expiration);
    } catch {
      return false;
    }
    if (filters.minDaysToExpiration !== null && filters.minDaysToExpiration !== undefined) {
      if (days < filters.minDaysToExpiration) {
        return false;
      }
    }
    if (filters.maxDaysToExpiration !== null && filters.maxDaysToExpiration !== undefined) {
      if (days > filters.maxDaysToExpiration) {
        return false;
      }
    }
    return true;
  });
  return requestedLimit === null ? filtered : filtered.slice(0, requestedLimit);
};

export const fetchOptionSnapshots = async (
  optionSymbols: string[]
): Promise<{ symbol: string; raw: OptionSnapshotRaw }[]> => {
  if (!optionSymbols.length) {
    return [];
  }
  const results: { symbol: string; raw: OptionSnapshotRaw }[] = [];
  const chunkSize = 100;
  for (let index = 0; index < optionSymbols.length; index += chunkSize) {
    const chunk = optionSymbols.slice(index, index + chunkSize);
    const endpoint = `/v1beta1/options/snapshots?${toSearchParams({
      symbols: chunk.join(","),
      feed: marketConfig.optionDataFeed
    })}`;
    const response = await requestJson<unknown>(endpoint);
    results.push(
      ...parseOptionSnapshotPayload(response.data).map((row) => ({
        symbol: row.symbol,
        raw: row.data
      }))
    );
  }
  return results;
};

export const fetchOptionChainSnapshots = async (
  underlyingSymbol: string,
  options: { feed?: string } = {}
): Promise<FetchedOptionChain> => {
  const normalizedUnderlying = underlyingSymbol.trim().toUpperCase();
  if (!normalizedUnderlying) {
    throw new Error("Alpaca option-chain underlying symbol is required.");
  }
  const requestedFeed = (options.feed || marketConfig.optionDataFeed).trim().toLowerCase();
  if (requestedFeed !== "opra") {
    throw new Error(`Alpaca option-chain feed must be opra: ${requestedFeed || "missing"}`);
  }

  const snapshots = new Map<string, FetchedOptionChainSnapshot>();
  const seenTokens = new Set<string>();
  let pageToken: string | null = null;
  let pagesConsumed = 0;

  while (true) {
    pagesConsumed += 1;
    if (pagesConsumed > MAX_MARKET_DATA_PAGES) {
      throw new Error(
        `Alpaca option-chain pagination exceeded safety cap (${MAX_MARKET_DATA_PAGES} pages).`
      );
    }
    const endpoint: string = `/v1beta1/options/snapshots/${encodeURIComponent(normalizedUnderlying)}?${toSearchParams({
      feed: requestedFeed,
      limit: 1000,
      page_token: pageToken ?? undefined
    })}`;
    const response: ApiResponse<{
      snapshots?: Record<string, OptionSnapshotRaw>;
      data?: Record<string, OptionSnapshotRaw>;
      options?: Record<string, OptionSnapshotRaw>;
      feed?: string | null;
      next_page_token?: string | null;
    }> = await requestJson(endpoint, { method: "GET" });
    const observedFeed = typeof response.data.feed === "string"
      ? response.data.feed.trim().toLowerCase()
      : null;
    if (observedFeed && observedFeed !== requestedFeed) {
      throw new Error(`ALPACA_OPTION_CHAIN_FEED_MISMATCH:${response.data.feed}`);
    }
    const retrievedAt = new Date().toISOString();
    for (const row of parseOptionSnapshotPayload(response.data)) {
      const symbol = row.symbol.trim().toUpperCase();
      if (!symbol) continue;
      const existing = snapshots.get(symbol);
      if (existing && canonicalJsonHash(existing.raw) !== canonicalJsonHash(row.data)) {
        throw new Error(`ALPACA_OPTION_CHAIN_DUPLICATE_CONFLICT:${symbol}`);
      }
      snapshots.set(symbol, {
        symbol,
        raw: row.data,
        requestId: response.requestId,
        endpoint,
        underlyingSymbol: normalizedUnderlying,
        requestedFeed,
        effectiveFeed: observedFeed,
        validationBasis: "request_feed_opra",
        pageToken,
        retrievedAt
      });
    }

    const next: string | null = response.data.next_page_token ?? null;
    if (!next) break;
    if (typeof next !== "string" || next.length === 0) {
      throw new Error(`Alpaca option-chain pagination returned invalid next token: ${String(next)}`);
    }
    if (seenTokens.has(next)) {
      throw new Error(`Alpaca option-chain pagination repeated token: ${next}`);
    }
    seenTokens.add(next);
    pageToken = next;
  }

  return {
    underlyingSymbol: normalizedUnderlying,
    pagesConsumed,
    snapshots: [...snapshots.values()]
  };
};

export const fetchOptionQuotes = async (
  optionSymbols: string[]
): Promise<{ symbol: string; raw: OptionQuoteRaw }[]> => {
  if (!optionSymbols.length) {
    return [];
  }
  const results: { symbol: string; raw: OptionQuoteRaw }[] = [];
  const chunkSize = 100;
  for (let index = 0; index < optionSymbols.length; index += chunkSize) {
    const chunk = optionSymbols.slice(index, index + chunkSize);
    const endpoint = `/v1beta1/options/quotes/latest?${toSearchParams({
      symbols: chunk.join(","),
      feed: marketConfig.optionDataFeed
    })}`;
    const response = await requestJson<unknown>(endpoint);
    results.push(
      ...parseOptionQuotePayload(response.data).map((row) => ({
        symbol: row.symbol,
        raw: row.data
      }))
    );
  }
  return results;
};

export interface FetchedStockSnapshot {
  symbol: string;
  raw: StockSnapshotRaw | null;
  requestedFeed: string;
  effectiveFeed: string;
  currency: string | null;
  requestId: string | null;
  retrievedAt?: string;
  error?: "SOURCE_SYMBOL_MISSING" | "STOCK_SNAPSHOT_REQUEST_FAILED";
}

export const fetchStockSnapshots = async (input: {
  symbols: string[];
  feed: string;
  currency?: string;
}): Promise<FetchedStockSnapshot[]> => {
  const symbols = Array.from(
    new Set(input.symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))
  );
  const requestedFeed = input.feed.trim().toLowerCase();
  const currency = input.currency?.trim().toUpperCase() || null;
  const results: FetchedStockSnapshot[] = [];
  const chunkSize = 100;

  for (let index = 0; index < symbols.length; index += chunkSize) {
    const chunk = symbols.slice(index, index + chunkSize);
    const endpoint = `/v2/stocks/snapshots?${toSearchParams({
      symbols: chunk.join(","),
      feed: requestedFeed,
      currency
    })}`;
    try {
      const response = await requestJson<unknown>(endpoint, { method: "GET" });
      const retrievedAt = new Date().toISOString();
      const snapshots = parseStockSnapshotPayload(response.data);
      for (const symbol of chunk) {
        const raw = snapshots[symbol] ?? null;
        results.push({
          symbol,
          raw,
          requestedFeed,
          effectiveFeed: requestedFeed,
          currency,
          requestId: response.requestId,
          retrievedAt,
          ...(raw ? {} : { error: "SOURCE_SYMBOL_MISSING" as const })
        });
      }
    } catch {
      for (const symbol of chunk) {
        const retrievedAt = new Date().toISOString();
        results.push({
          symbol,
          raw: null,
          requestedFeed,
          effectiveFeed: requestedFeed,
          currency,
          requestId: null,
          retrievedAt,
          error: "STOCK_SNAPSHOT_REQUEST_FAILED"
        });
      }
    }
  }

  return results;
};

export const validateAsset = async (symbol: string): Promise<boolean> => {
  const endpoint = `/v2/assets/${encodeURIComponent(symbol)}`;
  const response = await requestJson<{ tradable?: boolean }>(endpoint, { method: "GET" }, "trade");
  return Boolean(response.data?.tradable);
};
