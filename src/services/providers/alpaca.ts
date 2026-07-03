import { recordApiRequest } from "../apiLog.js";
import { config } from "../../config.js";
import type { Timeframe } from "../../types.js";

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
  const key = config.paperByDefault ? config.alpaca.paperKey : config.alpaca.liveKey;
  const secret = config.paperByDefault ? config.alpaca.paperSecret : config.alpaca.liveSecret;
  return key && secret
    ? {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret
      }
    : {};
};

const requestJson = async <T>(
  endpoint: string,
  options: RequestInit = {},
  baseUrl: "data" | "trade" = "data"
): Promise<ApiResponse<T>> => {
  const apiRoot = baseUrl === "trade"
    ? (config.paperByDefault ? config.alpaca.paperBaseUrl : config.alpaca.liveBaseUrl)
    : config.alpaca.dataBaseUrl;
  const response = await fetch(`${apiRoot}${endpoint}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...getAuthHeaders(),
      "Content-Type": "application/json"
    }
  });
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
  pageToken?: string | null;
}

export interface OptionChainFilters {
  underlyingSymbols?: string[];
  minDaysToExpiration?: number | null;
  maxDaysToExpiration?: number | null;
  minDelta?: number | null;
  maxDelta?: number | null;
}

export interface OptionContractRaw {
  symbol: string;
  underlying_symbol: string;
  type: "call" | "put";
  expiration_date: string;
  strike_price: number;
  multiplier?: number;
  tradable: boolean;
}

export interface OptionSnapshotRaw {
  symbol: string;
  underlying_symbol: string;
  Greeks?: {
    delta?: number;
    gamma?: number;
    theta?: number;
    vega?: number;
    rho?: number;
  };
  latest_quote?: {
    b?: number | null;
    a?: number | null;
    p?: number | null;
  };
  implied_volatility?: number | null;
  volume?: number | null;
  open_interest?: number | null;
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

export const fetchBars = async (options: ProviderOptions): Promise<{ symbol: string; bars: RawBar[]; requestId: string | null }[]> => {
  const timeframe = options.timeframe || "1Day";
  const params = toSearchParams({
    symbols: options.symbols?.join(","),
    timeframe,
    start: options.start,
    end: options.end,
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

  while (true) {
    const params = toSearchParams({
      symbols: options.symbols?.join(","),
      timeframe: options.timeframe || "1Day",
      start: options.start,
      end: options.end,
      page_token: pageToken ?? undefined,
      limit: 1000
    });
    const response = await requestJson<{ bars?: Record<string, RawBar[]>; next_page_token?: string }>(
      `/v2/stocks/bars${params ? `?${params}` : ""}`,
      { method: "GET" }
    );
    const bars = response.data.bars || {};
      for (const [symbol, rows] of Object.entries(bars)) {
        for (const bar of rows) {
          out.push({
            symbol,
            bar,
            requestIds: [response.requestId]
        });
      }
    }
    const next = response.data.next_page_token;
    if (!next) {
      break;
    }
    pageToken = next;
  }
  return out;
};

export const fetchOptionContracts = async (
  filters: OptionChainFilters
): Promise<OptionContractRaw[]> => {
  const endpoint = `/v2/options/contracts?${toSearchParams({
    underlying_symbols: filters.underlyingSymbols?.join(","),
    limit: 500
  })}`;
  const response = await requestJson<unknown>(endpoint, { method: "GET" }, "trade");
  const contracts = parseOptionContractPayload(response.data);
  return contracts.filter((contract) => {
    const expiration = contract.expiration_date;
    if (!expiration) {
      return false;
    }
    const expires = new Date(expiration);
    const now = new Date();
    const days = Math.round(
      (expires.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)
    );
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
    const endpoint = `/v1beta1/options/snapshots?${toSearchParams({ symbols: chunk.join(",") })}`;
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

export const validateAsset = async (symbol: string): Promise<boolean> => {
  const endpoint = `/v2/assets/${encodeURIComponent(symbol)}`;
  const response = await requestJson<{ tradable?: boolean }>(endpoint, { method: "GET" }, "trade");
  return Boolean(response.data?.tradable);
};
