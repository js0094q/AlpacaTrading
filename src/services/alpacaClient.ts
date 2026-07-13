import { recordApiRequest } from "./apiLog.js";
import { config } from "../config.js";
import {
  assertLiveTradingDisabled,
  assertReadOnlyAlpacaAccessAllowed,
  getTradingSafetyState
} from "./tradingSafetyService.js";

export interface AlpacaApiResponse<T> {
  data: T;
  requestId?: string;
  status: number;
  url: string;
}

export class AlpacaApiError extends Error {
  status?: number;
  requestId?: string;
  url?: string;
  responseBody?: unknown;
}

const PAPER_TRADING_BASE_URL = "https://paper-api.alpaca.markets";

export interface AlpacaPaperOrderRequest {
  symbol: string;
  qty?: string;
  notional?: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  time_in_force: "day";
  limit_price?: string;
  client_order_id: string;
  position_intent?: "buy_to_open" | "buy_to_close" | "sell_to_open" | "sell_to_close";
  order_class?: "simple" | "mleg";
}

export interface AlpacaSubmittedOrder {
  id?: string;
  client_order_id?: string;
  symbol?: string;
  asset_class?: string;
  qty?: string;
  notional?: string;
  side?: string;
  type?: string;
  time_in_force?: string;
  limit_price?: string;
  status?: string;
  submitted_at?: string;
  filled_qty?: string;
  filled_avg_price?: string;
  filled_at?: string;
}

export interface AlpacaAccountRaw {
  id?: string;
  status?: string;
  cash?: string;
  equity?: string;
  portfolio_value?: string;
  buying_power?: string;
  options_buying_power?: string;
  options_approved_level?: number | string;
  options_trading_level?: number | string;
  trading_blocked?: boolean;
  account_blocked?: boolean;
  transfers_blocked?: boolean;
}

export interface AlpacaOptionContractRaw {
  id?: string;
  symbol?: string;
  name?: string;
  status?: string;
  tradable?: boolean;
  tradeable?: boolean;
  expiration_date?: string;
  root_symbol?: string;
  underlying_symbol?: string;
  underlying_asset_id?: string;
  type?: "call" | "put" | string;
  style?: string;
  strike_price?: string | number;
  multiplier?: string | number;
}

export interface AlpacaPositionRaw {
  symbol?: string;
  asset_class?: string;
  qty?: string;
  qty_available?: string;
  side?: string;
}

const firstEnv = (...names: string[]) => {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.trim() !== "") {
      return value.trim();
    }
  }
  return "";
};

export const getAlpacaPaperCredentials = () => {
  const apiKey = firstEnv("ALPACA_PAPER_API_KEY", "ALPACA_PAPER_KEY", "ALPACA_API_KEY");
  const secretKey = firstEnv("ALPACA_PAPER_SECRET_KEY", "ALPACA_PAPER_SECRET", "ALPACA_SECRET_KEY");
  const baseUrl = firstEnv("ALPACA_PAPER_BASE_URL") || config.alpaca.paperBaseUrl;
  const dataBaseUrl = firstEnv("ALPACA_DATA_BASE_URL") || config.alpaca.dataBaseUrl;

  if (!apiKey || !secretKey) {
    throw new Error(
      "Missing Alpaca paper credentials. Set ALPACA_PAPER_API_KEY and ALPACA_PAPER_SECRET_KEY."
    );
  }

  return {
    apiKey,
    secretKey,
    baseUrl,
    dataBaseUrl
  };
};

const parseTimeoutMs = (): number => {
  const parsed = Number.parseInt(process.env.ALPACA_REQUEST_TIMEOUT_MS || "15000", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15000;
};

const parseRetryCount = (): number => {
  const parsed = Number.parseInt(process.env.ALPACA_MAX_RETRIES || "2", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
};

const parseResponseBody = async (response: Response): Promise<unknown> => {
  const raw = await response.text();
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

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

export const getAlpacaPaperEndpoint = async <T>(endpoint: string): Promise<AlpacaApiResponse<T>> => {
  return requestJson<T>(endpoint, "trade");
};

export const getAlpacaDataEndpoint = async <T>(endpoint: string): Promise<AlpacaApiResponse<T>> => {
  return requestJson<T>(endpoint, "data");
};

const assertPaperTradingEndpointAllowed = () => {
  const state = getTradingSafetyState();
  if (state.alpacaEnv !== "paper") {
    throw new Error("PAPER_ENV_REQUIRED");
  }
  if (state.liveTradingEnabled) {
    throw new Error("LIVE_TRADING_MUST_BE_DISABLED");
  }
};

const requestPaperTradingJson = async <T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<AlpacaApiResponse<T>> => {
  assertPaperTradingEndpointAllowed();
  assertLiveTradingDisabled();

  const credentials = getAlpacaPaperCredentials();
  const url = `${PAPER_TRADING_BASE_URL}${endpoint}`;
  const timeoutMs = parseTimeoutMs();
  const maxRetries = parseRetryCount();
  const method = String(options.method || "GET").toUpperCase();
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let response: Response;
    try {
      response = await executeWithTimeout(timeoutMs, (signal) =>
        fetch(url, {
          ...options,
          method,
          headers: {
            "APCA-API-KEY-ID": credentials.apiKey,
            "APCA-API-SECRET-KEY": credentials.secretKey,
            "User-Agent": config.alpaca.userAgent,
            "Content-Type": "application/json",
            ...(options.headers || {})
          },
          signal
        })
      );

      const requestId = response.headers.get("x-request-id") || undefined;
      const status = response.status;
      const parsedBody = await parseResponseBody(response);

      recordApiRequest({
        provider: "alpaca",
        endpoint,
        method,
        status,
        requestId
      });

      if (!response.ok) {
        const error = new AlpacaApiError(
          `Alpaca paper trading request failed for ${endpoint}. status=${status}.`
        );
        error.status = status;
        error.requestId = requestId;
        error.url = url;
        error.responseBody = parsedBody;
        throw error;
      }

      return {
        data: parsedBody as T,
        requestId,
        status,
        url
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        lastError = new Error(`Alpaca request timed out after ${timeoutMs}ms.`);
      } else {
        lastError = error;
      }

      if (error instanceof AlpacaApiError) {
        throw error;
      }

      if (attempt >= maxRetries) {
        throw lastError;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Alpaca paper trading request failed and could not be completed.");
};

export const getAccount = async (): Promise<AlpacaApiResponse<AlpacaAccountRaw>> => {
  return requestPaperTradingJson<AlpacaAccountRaw>("/v2/account");
};

export const getOptionContract = async (
  symbolOrId: string
): Promise<AlpacaApiResponse<AlpacaOptionContractRaw>> => {
  return requestPaperTradingJson<AlpacaOptionContractRaw>(
    `/v2/options/contracts/${encodeURIComponent(symbolOrId)}`
  );
};

export const listPaperPositions = async (): Promise<AlpacaApiResponse<AlpacaPositionRaw[]>> => {
  return requestPaperTradingJson<AlpacaPositionRaw[]>("/v2/positions");
};

export const submitPaperOrder = async (
  payload: AlpacaPaperOrderRequest
): Promise<AlpacaApiResponse<AlpacaSubmittedOrder>> => {
  return requestPaperTradingJson<AlpacaSubmittedOrder>("/v2/orders", {
    method: "POST",
    body: JSON.stringify(payload)
  });
};

export const getPaperOrder = async (
  orderId: string
): Promise<AlpacaApiResponse<AlpacaSubmittedOrder>> => {
  return requestPaperTradingJson<AlpacaSubmittedOrder>(
    `/v2/orders/${encodeURIComponent(orderId)}`
  );
};

export const replacePaperOrder = async (
  orderId: string,
  payload: { qty?: string; limit_price?: string }
): Promise<AlpacaApiResponse<AlpacaSubmittedOrder>> => {
  return requestPaperTradingJson<AlpacaSubmittedOrder>(
    `/v2/orders/${encodeURIComponent(orderId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(payload)
    }
  );
};

export const cancelPaperOrder = async (
  orderId: string
): Promise<AlpacaApiResponse<null>> => {
  return requestPaperTradingJson<null>(
    `/v2/orders/${encodeURIComponent(orderId)}`,
    { method: "DELETE" }
  );
};

export const listRecentPaperOrders = async (
  limit = 50
): Promise<AlpacaApiResponse<AlpacaSubmittedOrder[]>> => {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(500, Math.floor(limit)) : 50;
  return requestPaperTradingJson<AlpacaSubmittedOrder[]>(
    `/v2/orders?status=all&limit=${safeLimit}&nested=false`
  );
};

const requestJson = async <T>(
  endpoint: string,
  baseUrl: "trade" | "data"
): Promise<AlpacaApiResponse<T>> => {
  assertReadOnlyAlpacaAccessAllowed();
  assertLiveTradingDisabled();

  const credentials = getAlpacaPaperCredentials();
  const rootUrl = baseUrl === "trade" ? credentials.baseUrl : credentials.dataBaseUrl;
  const url = `${rootUrl}${endpoint}`;
  const timeoutMs = parseTimeoutMs();
  const maxRetries = parseRetryCount();

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let response: Response;
    try {
      response = await executeWithTimeout(timeoutMs, (signal) =>
        fetch(url, {
          method: "GET",
          headers: {
            "APCA-API-KEY-ID": credentials.apiKey,
            "APCA-API-SECRET-KEY": credentials.secretKey,
            "User-Agent": config.alpaca.userAgent,
            "Content-Type": "application/json"
          },
          signal
        })
      );

      const requestId = response.headers.get("x-request-id") || undefined;
      const status = response.status;
      const parsedBody = await parseResponseBody(response);

      recordApiRequest({
        provider: "alpaca",
        endpoint,
        method: "GET",
        status,
        requestId
      });

      if (!response.ok) {
        const error = new AlpacaApiError(
          `Alpaca request failed for ${endpoint}. status=${status}.`
        );
        error.status = status;
        error.requestId = requestId;
        error.url = url;
        error.responseBody = parsedBody;
        throw error;
      }

      return {
        data: parsedBody as T,
        requestId,
        status,
        url
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        lastError = new Error(`Alpaca request timed out after ${timeoutMs}ms.`);
      } else {
        lastError = error;
      }

      if (error instanceof AlpacaApiError) {
        throw error;
      }

      if (attempt >= maxRetries) {
        throw lastError;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Alpaca request failed and could not be completed.");
};

export const withTradingSafetyContext = (handler: () => void) => {
  return handler();
};
