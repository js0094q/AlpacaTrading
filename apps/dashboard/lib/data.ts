import { getAlpacaAccountSnapshot } from "../../../src/services/alpacaAccountService";
import { listAlpacaPositions } from "../../../src/services/alpacaPositionService";
import { listAlpacaOpenOrders } from "../../../src/services/alpacaOrderReadService";
import { assertPaperDashboardAccess } from "./guards";
import {
  VERCEL_HISTORICAL_STORAGE_WARNING,
  VERCEL_HISTORICAL_UNAVAILABLE_MESSAGE,
  VERCEL_READ_ONLY_MODE,
  resolveVpsControlBaseUrl,
  resolveDashboardControlToken,
  isPaperDashboardBridgeEnabled,
  hasDashboardDurableStorageConfig,
  shouldUseVercelReadOnlyFallback
} from "./runtime";
import { optionsQuoteConfig } from "../../../src/services/optionQuoteNormalizer";
import {
  buildOptionDecisionSnapshot,
  type OptionDecisionFieldEvidenceMap,
  type OptionDecisionSnapshotEvidence,
  type OptionEvidenceAvailability,
  type OptionEvidenceDataQualityStatus,
  type OptionStrategyUseMap
} from "../../../src/services/optionDecisionEvidenceService";

export type RiskProfileInput = "moderate" | "aggressive" | "conservative";

export interface PaperActionInput {
  riskProfile?: RiskProfileInput;
  optionsEnabled?: boolean;
  maxCandidates?: number;
  assetClass?: "all" | "equity" | "option";
  confirmPaper?: boolean;
  expectedPayloadSignature?: string;
  underlying?: string;
  dte?: number;
  quantity?: number;
  reviewId?: string;
  symbol?: string;
  expirationDate?: string;
  entryPrice?: number;
  currentPrice?: number;
  entryAt?: string;
  asOf?: string;
  staleThesis?: boolean;
  riskNormalizationObservations?: number;
}

const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const safeLimit = (value: unknown, fallback: number, max: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(max, Math.floor(parsed))
    : fallback;
};

type PaperBridgeSummary = {
  paperOnly?: boolean;
  environment?: string;
  liveTradingEnabled?: boolean;
  generatedAt?: string;
  mode?: string;
  historicalDataAvailable?: boolean;
  durableStorageConfigured?: boolean;
  historicalWarning?: string | null;
  durableStorageWarning?: string | null;
  account?: unknown;
  positions?: unknown;
  runtime?: unknown;
  plan?: unknown;
  review?: unknown;
  dryRun?: unknown;
  latestResearch?: unknown;
  latestPaperPlans?: unknown;
  openOrders?: unknown;
  snapshots?: unknown;
  executions?: unknown;
  learningSummary?: unknown;
  promotionReadiness?: unknown;
  optionContracts?: unknown;
  requestIds?: unknown;
  hedge?: unknown;
};

const normalizeOpenOrdersRows = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object" && "orders" in value) {
    const orders = (value as { orders?: unknown }).orders;
    if (Array.isArray(orders)) {
      return orders;
    }
  }
  return [];
};

type DashboardResultError = {
  ok: false;
  label?: string;
  error: string;
};

type DashboardResult<T> =
  | {
      ok: true;
      label?: string;
      data: T;
    }
  | DashboardResultError;

export type DashboardSnapshotMode = typeof VERCEL_READ_ONLY_MODE | "postgres-only-authority" | string;

export interface DashboardSnapshot {
  paperOnly: true;
  environment: string;
  liveTradingEnabled: boolean;
  generatedAt: string;
  mode: DashboardSnapshotMode;
  historicalDataAvailable: boolean;
  durableStorageConfigured: boolean;
  historicalWarning: string | null;
  durableStorageWarning: string | null;
  account: DashboardResult<unknown>;
  positions: DashboardResult<unknown>;
  runtime: DashboardResult<unknown> | { ok: false; label: string; error: string };
  plan: DashboardResult<{ plan: Array<unknown>; planSummary?: unknown }>;
  review: DashboardResult<{
    review: { status: string; blockers: string[]; warnings: string[] };
    planSummary: { plannedOrders: number };
  }>;
  dryRun: DashboardResult<{ summary: { wouldSubmitCount: number; payloadsBlocked: number }; assetClass: string }>;
  latestResearch: unknown[];
  latestPaperPlans: unknown[];
  openOrders: DashboardResult<unknown>;
  snapshots: unknown[];
  executions: DashboardResult<unknown> | unknown[];
  learningSummary: DashboardResult<unknown>;
  promotionReadiness: unknown[];
  optionContracts: OptionContractDashboardRow[];
  requestIds: unknown[];
  hedge: DashboardResult<unknown>;
}

export type OptionContractDisplayCategory = "Discovered" | "Quoted" | "Executable" | "Rejected";

export interface OptionContractDashboardRow {
  underlying_symbol: string;
  option_symbol: string;
  type: string;
  expiration_date: string;
  strike: number | null;
  multiplier: number | null;
  tradable: boolean;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  last: number | null;
  volume: number | null;
  openInterest: number | null;
  impliedVolatility: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  spreadPercentage: number | null;
  quoteStatus: "valid" | "missing" | "invalid" | "stale";
  executable: boolean;
  executablePrice: number | null;
  executablePriceSource: string | null;
  rejectionReason: string | null;
  rejectionReasons: string[];
  quoteTimestamp: string | null;
  quoteAgeMs: number | null;
  snapshotTimestamp: string | null;
  source: string | null;
  sourceFeed: string | null;
  normalizationPath: string | null;
  daysToExpiration: number | null;
  underlyingPrice: number | null;
  underlyingPriceSource: string | null;
  greekAvailability: OptionEvidenceAvailability;
  dataQualityStatus: OptionEvidenceDataQualityStatus;
  strategyUse: OptionStrategyUseMap;
  decisionUse: OptionDecisionFieldEvidenceMap;
  decisionSnapshot: OptionDecisionSnapshotEvidence;
  timestamp: string | null;
  displayCategory: OptionContractDisplayCategory;
}

type BridgeEnvelope<T> = { ok: true; data: T } | { ok: false; error?: unknown };

const MAX_BRIDGE_TIMEOUT_MS = 30_000;

let bridgeSummaryPromise: Promise<PaperBridgeSummary> | null = null;

const clampRows = <T>(rows: unknown, limit: number): T[] => {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.slice(0, safeLimit(limit, rows.length > 0 ? rows.length : 1, 200)) as T[];
};

const recordValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const booleanFlag = (value: unknown) =>
  value === true || value === 1 || value === "1" || value === "true";

const bridgeUrlForPath = (path: string) => {
  const base = (resolveVpsControlBaseUrl() || "").trim();
  if (!base) {
    throw new Error("DASHBOARD_CONTROL_BASE_URL_NOT_CONFIGURED");
  }
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  const normalizedPath = path.replace(/^\//, "");
  return `${normalizedBase}${normalizedPath}`;
};

const fetchPaperBridgePayload = async <T>(path: string): Promise<T> => {
  const headers: Record<string, string> = {
    Accept: "application/json"
  };

  const token = (resolveDashboardControlToken() || "").trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers["x-dashboard-bridge-token"] = token;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_BRIDGE_TIMEOUT_MS);

  try {
    const response = await fetch(bridgeUrlForPath(path), {
      method: "GET",
      headers,
      cache: "no-store",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`DASHBOARD_BRIDGE_HTTP_${response.status}`);
    }

    const payload = (await response.json()) as unknown;
    if (
      payload !== null &&
      typeof payload === "object" &&
      "ok" in payload &&
      typeof (payload as BridgeEnvelope<T>).ok === "boolean"
    ) {
      const envelope = payload as BridgeEnvelope<T>;
      if (envelope.ok) {
        return envelope.data;
      }
      throw new Error(
        `DASHBOARD_BRIDGE_RESPONSE_ERROR:${String((payload as { error?: unknown }).error)}`
      );
    }

    return payload as T;
  } finally {
    clearTimeout(timer);
  }
};

const getPaperBridgeSummary = async () => {
  if (!bridgeSummaryPromise) {
    const summaryPath = resolveVpsControlBaseUrl() ? "api/v1/summary" : "api/paper/summary";
    bridgeSummaryPromise = fetchPaperBridgePayload<PaperBridgeSummary>(summaryPath);
  }
  return bridgeSummaryPromise;
};

export interface ZeroDteDashboardSummary {
  paperOnly: true;
  generatedAt: string;
  tradingDate: string | null;
  engine: {
    enabled: boolean;
    lastRunAt: string | null;
    status: string;
    queueSize: number;
    staleDataCount: number;
  };
  queue: Array<Record<string, unknown>>;
  paperPositions: Array<Record<string, unknown>>;
  shadowTrades: Array<Record<string, unknown>>;
  lifecycle: {
    counts: Record<string, number>;
    recent: Array<Record<string, unknown>>;
  };
  learning: Record<string, unknown> | null;
  blockers: string[];
}

const unavailableZeroDteSummary = (): ZeroDteDashboardSummary => ({
  paperOnly: true,
  generatedAt: new Date().toISOString(),
  tradingDate: null,
  engine: {
    enabled: false,
    lastRunAt: null,
    status: "unavailable",
    queueSize: 0,
    staleDataCount: 0
  },
  queue: [],
  paperPositions: [],
  shadowTrades: [],
  lifecycle: { counts: {}, recent: [] },
  learning: null,
  blockers: ["ZERO_DTE_VPS_SUMMARY_UNAVAILABLE"]
});

export const latestZeroDteSummary = async (limit = 25): Promise<ZeroDteDashboardSummary> => {
  if (isPaperDashboardBridgeEnabled()) {
    return fetchPaperBridgePayload<ZeroDteDashboardSummary>("api/v1/zero-dte/summary");
  }
  void limit;
  return unavailableZeroDteSummary();
};

const normalizeRiskProfile = (value: unknown): RiskProfileInput => {
  return value === "aggressive" || value === "conservative" || value === "moderate"
    ? value
    : "aggressive";
};

const normalizeAssetClass = (value: unknown): "all" | "equity" | "option" => {
  return value === "equity" || value === "option" || value === "all" ? value : "all";
};

export const parsePaperActionInput = (value: unknown): PaperActionInput => {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    riskProfile: normalizeRiskProfile(record.riskProfile),
    optionsEnabled:
      typeof record.optionsEnabled === "boolean" ? record.optionsEnabled : true,
    maxCandidates: safeLimit(record.maxCandidates, 10, 50),
    assetClass: normalizeAssetClass(record.assetClass),
    confirmPaper: record.confirmPaper === true,
    expectedPayloadSignature:
      typeof record.expectedPayloadSignature === "string"
        ? record.expectedPayloadSignature
        : undefined,
    underlying:
      typeof record.underlying === "string" && record.underlying.trim()
        ? record.underlying.trim().toUpperCase()
        : "SPY",
    dte: safeLimit(record.dte, 0, 30),
    quantity: numberOrNull(record.quantity) !== null ? Math.max(1, Math.floor(numberOrNull(record.quantity)!)) : undefined,
    reviewId: typeof record.reviewId === "string" && record.reviewId.trim() ? record.reviewId.trim() : undefined,
    symbol: typeof record.symbol === "string" && record.symbol.trim() ? record.symbol.trim().toUpperCase() : undefined,
    expirationDate: typeof record.expirationDate === "string" ? record.expirationDate : undefined,
    entryPrice: numberOrNull(record.entryPrice) ?? undefined,
    currentPrice: numberOrNull(record.currentPrice) ?? undefined,
    entryAt: typeof record.entryAt === "string" ? record.entryAt : undefined,
    asOf: typeof record.asOf === "string" ? record.asOf : undefined,
    staleThesis: record.staleThesis === true,
    riskNormalizationObservations: numberOrNull(record.riskNormalizationObservations) ?? undefined
  };
};

export const latestResearchRuns = async (limit = 5) =>
  isPaperDashboardBridgeEnabled()
    ? getPaperBridgeSummary().then((summary) => clampRows(summary.latestResearch, limit))
    : [];

export const latestPaperPlans = async (limit = 10) =>
  isPaperDashboardBridgeEnabled()
    ? getPaperBridgeSummary().then((summary) => clampRows(summary.latestPaperPlans, limit))
    : [];

const quoteStatusForDashboard = (
  value: string | null
): OptionContractDashboardRow["quoteStatus"] =>
  value === "valid" || value === "invalid" || value === "stale" || value === "missing"
    ? value
    : "missing";

const optionDisplayCategory = (input: {
  hasSnapshot: boolean;
  quoteStatus: OptionContractDashboardRow["quoteStatus"];
  executable: boolean;
  rejectionReason: string | null;
}): OptionContractDisplayCategory => {
  if (input.executable) {
    return "Executable";
  }
  if (input.rejectionReason || (input.hasSnapshot && input.quoteStatus !== "valid")) {
    return "Rejected";
  }
  if (input.quoteStatus === "valid") {
    return "Quoted";
  }
  return "Discovered";
};
const inferredQuoteStatus = (row: Record<string, unknown>) => {
  const explicit = textOrNull(row.quote_status ?? row.quoteStatus);
  if (explicit) return quoteStatusForDashboard(explicit);

  const timestamp = textOrNull(
    row.quote_timestamp ??
      row.quoteTimestamp ??
      row.observed_at ??
      row.timestamp
  );

  const bid = numberOrNull(row.bid);
  const ask = numberOrNull(row.ask);

  if (
    timestamp &&
    bid !== null &&
    ask !== null &&
    bid >= 0 &&
    ask >= bid
  ) {
    return "valid" as const;
  }

  return timestamp ? "invalid" as const : "missing" as const;
};
export const normalizeOptionContractDashboardRow = (row: {
  underlying_symbol: string;
  option_symbol: string;
  type: string;
  expiration_date: string;
  strike: number | null;
  multiplier: number | null;
  tradable: number;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  last: number | null;
  quote_status: string | null;
  executable: number | null;
  executable_price: number | null;
  executable_price_source: string | null;
  rejection_reason: string | null;
  quote_timestamp: string | null;
  quote_age_ms: number | null;
  snapshot_timestamp: string | null;
  source: string | null;
  source_feed: string | null;
  normalization_path: string | null;
  days_to_expiration: number | null;
  volume: number | null;
  open_interest: number | null;
  implied_volatility: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  spread_percentage: number | null;
  timestamp: string | null;
}): OptionContractDashboardRow => {
  const quoteStatus = quoteStatusForDashboard(row.quote_status);
  const allow0Dte = optionsQuoteConfig().allow0DteOptions;
  const sameDayExpiration =
    row.expiration_date === new Date().toISOString().slice(0, 10);
  const expirationRejection =
    sameDayExpiration && !allow0Dte ? "same_day_expiration_not_enabled" : null;
  const executable = row.executable === 1 && !expirationRejection;
  const rejectionReason =
    expirationRejection ||
    row.rejection_reason ||
    (row.timestamp && quoteStatus === "missing" ? "quote_unavailable" : null);
  const decisionSnapshot = buildOptionDecisionSnapshot({
    contract: {
      optionSymbol: row.option_symbol,
      underlyingSymbol: row.underlying_symbol,
      type: row.type === "put" ? "put" : "call",
      expirationDate: row.expiration_date,
      strike: row.strike,
      multiplier: row.multiplier
    },
    snapshot: row.timestamp
      ? {
          optionSymbol: row.option_symbol,
          underlyingSymbol: row.underlying_symbol,
          timestamp: row.timestamp,
          bid: row.bid,
          ask: row.ask,
          midpoint: row.midpoint,
          last: row.last,
          quoteStatus,
          executable: row.executable,
          executablePrice: row.executable_price,
          executablePriceSource: row.executable_price_source,
          rejectionReason,
          quoteTimestamp: row.quote_timestamp,
          quoteAgeMs: row.quote_age_ms,
          volume: row.volume,
          openInterest: row.open_interest,
          impliedVolatility: row.implied_volatility,
          delta: row.delta,
          gamma: row.gamma,
          theta: row.theta,
          vega: row.vega,
          rho: row.rho,
          snapshotTimestamp: row.snapshot_timestamp,
          normalizationPath: row.normalization_path,
          source: row.source,
          sourceFeed: row.source_feed,
          spreadPercentage: row.spread_percentage
        }
      : null,
    decisionTimestamp: row.timestamp,
    daysToExpiration: row.days_to_expiration,
    maxQuoteAgeMs: optionsQuoteConfig().maxAgeMs
  });

  return {
    underlying_symbol: row.underlying_symbol,
    option_symbol: row.option_symbol,
    type: row.type,
    expiration_date: row.expiration_date,
    strike: row.strike,
    multiplier: row.multiplier,
    tradable: row.tradable === 1,
    bid: row.bid,
    ask: row.ask,
    midpoint: row.midpoint,
    last: row.last,
    volume: row.volume,
    openInterest: row.open_interest,
    impliedVolatility: row.implied_volatility,
    delta: row.delta,
    gamma: row.gamma,
    theta: row.theta,
    vega: row.vega,
    rho: row.rho,
    spreadPercentage: row.spread_percentage,
    quoteStatus,
    executable,
    executablePrice: executable ? row.executable_price : null,
    executablePriceSource: executable ? row.executable_price_source : null,
    rejectionReason,
    rejectionReasons: decisionSnapshot.rejectionReasons,
    quoteTimestamp: row.quote_timestamp,
    quoteAgeMs: row.quote_age_ms,
    snapshotTimestamp: row.snapshot_timestamp,
    source: row.source,
    sourceFeed: row.source_feed,
    normalizationPath: row.normalization_path,
    daysToExpiration: decisionSnapshot.daysToExpiration,
    underlyingPrice: decisionSnapshot.underlyingPrice,
    underlyingPriceSource: decisionSnapshot.underlyingPriceSource,
    greekAvailability: decisionSnapshot.availability.greeks,
    dataQualityStatus: decisionSnapshot.dataQualityStatus,
    strategyUse: decisionSnapshot.strategyUse,
    decisionUse: decisionSnapshot.decisionUse,
    decisionSnapshot,
    timestamp: row.timestamp,
    displayCategory: optionDisplayCategory({
      hasSnapshot: Boolean(row.timestamp),
      quoteStatus,
      executable,
      rejectionReason
    })
  };
};

const normalizeBridgeOptionContractRow = (value: unknown): OptionContractDashboardRow => {
  const row = recordValue(value);
  const quoteStatus = inferredQuoteStatus(row);
  return normalizeOptionContractDashboardRow({
    underlying_symbol: textOrNull(row.underlying_symbol ?? row.underlyingSymbol) ?? "-",
    option_symbol: textOrNull(row.option_symbol ?? row.optionSymbol) ?? "-",
    type: textOrNull(row.type ?? row.optionType) ?? "-",
    expiration_date: textOrNull(row.expiration_date ?? row.expirationDate) ?? "-",
    strike: numberOrNull(row.strike),
    multiplier: numberOrNull(row.multiplier),
    tradable: booleanFlag(row.tradable) ? 1 : 0,
    bid: numberOrNull(row.bid),
    ask: numberOrNull(row.ask),
    midpoint: numberOrNull(row.midpoint),
    last: numberOrNull(row.last),
    quote_status: quoteStatus,
    executable: booleanFlag(row.executable) ? 1 : 0,
    executable_price: numberOrNull(row.executable_price ?? row.executablePrice),
    executable_price_source: textOrNull(row.executable_price_source ?? row.executablePriceSource),
    rejection_reason: textOrNull(row.rejection_reason ?? row.rejectionReason),
    quote_timestamp: textOrNull(row.quote_timestamp ?? row.quoteTimestamp),
    quote_age_ms: numberOrNull(row.quote_age_ms ?? row.quoteAgeMs),
    snapshot_timestamp: textOrNull(row.snapshot_timestamp ?? row.snapshotTimestamp),
    source: textOrNull(row.source),
    source_feed: textOrNull(row.source_feed ?? row.sourceFeed),
    normalization_path: textOrNull(row.normalization_path ?? row.normalizationPath),
    days_to_expiration: numberOrNull(row.days_to_expiration ?? row.daysToExpiration),
    volume: numberOrNull(row.volume),
    open_interest: numberOrNull(row.open_interest ?? row.openInterest),
    implied_volatility: numberOrNull(row.implied_volatility ?? row.impliedVolatility),
    delta: numberOrNull(row.delta),
    gamma: numberOrNull(row.gamma),
    theta: numberOrNull(row.theta),
    vega: numberOrNull(row.vega),
    rho: numberOrNull(row.rho),
    spread_percentage: numberOrNull(row.spread_percentage ?? row.spreadPercentage),
    timestamp: textOrNull(row.timestamp ?? row.observed_at ?? row.observedAt)
  });
};

export const latestOptionContracts = async (limit = 10) =>
  isPaperDashboardBridgeEnabled()
    ? getPaperBridgeSummary().then((summary) =>
        clampRows(summary.optionContracts, limit).map(normalizeBridgeOptionContractRow)
      )
    : [];

export const latestOpenOrders = async (limit = 12) =>
  isPaperDashboardBridgeEnabled()
    ? getPaperBridgeSummary().then((summary) =>
        clampRows(normalizeOpenOrdersRows(summary.openOrders), limit)
      )
    : [];

export const latestApiRequestIds = async (limit = 12) =>
  isPaperDashboardBridgeEnabled()
    ? getPaperBridgeSummary().then((summary) => clampRows(summary.requestIds, limit))
    : [];

const capture = async <T>(label: string, fn: () => Promise<T> | T) => {
  try {
    return { ok: true as const, label, data: await fn() };
  } catch (error) {
    return {
      ok: false as const,
      label,
      error:
        error instanceof Error &&
        /Missing Alpaca paper credentials/.test(error.message)
          ? "DASHBOARD_ALPACA_ENV_NOT_CONFIGURED"
          : "Unavailable. Confirm paper environment, credentials, and local DB access."
    };
  }
};

const historicalUnavailable = (label: string) => ({
  ok: false as const,
  label,
  error: VERCEL_HISTORICAL_UNAVAILABLE_MESSAGE
});

const cachedSummaryUnavailable = (label: string) => ({
  ok: false as const,
  label,
  error: "Fresh runtime generation is available from the dedicated action endpoints."
});

const DASHBOARD_CACHED_SECTION_TIMEOUT_MS = 8_000;

const captureWithTimeout = async <T>(
  label: string,
  fn: () => Promise<T> | T,
  timeoutMs = DASHBOARD_CACHED_SECTION_TIMEOUT_MS
): Promise<DashboardResult<T>> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const operation = Promise.resolve()
      .then(fn)
      .then((data) => ({ ok: true as const, label, data }))
      .catch((error) => ({
        ok: false as const,
        label,
        error:
          error instanceof Error &&
          /Missing Alpaca paper credentials/.test(error.message)
            ? "DASHBOARD_ALPACA_ENV_NOT_CONFIGURED"
            : "Unavailable. Confirm paper environment, credentials, and local DB access."
      }));

    const timeout = new Promise<DashboardResultError>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          ok: false,
          label,
          error: `Unavailable after ${timeoutMs}ms. Use the dedicated action endpoint for a fresh read.`
        });
      }, timeoutMs);
    });

    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const rowsOrEmpty = async <T>(fn: () => Promise<T[]> | T[]): Promise<T[]> => {
  try {
    return await fn();
  } catch {
    return [];
  }
};

const cachedPlanResult = (latestPlans: unknown[]): DashboardSnapshot["plan"] => ({
  ok: true,
  label: "plan",
  data: {
    plan: latestPlans.map((row, index) => {
      const record = recordValue(row);
      const strategy = [
        record.strategy,
        record.direction,
        record.expression ?? record.preferred_expression,
        record.strategy_family ?? record.option_symbol
      ]
        .map((entry) => textOrNull(entry) ?? "")
        .filter(Boolean)
        .join(" / ");
      return {
        symbol: textOrNull(record.symbol ?? record.option_symbol) ?? "-",
        decision:
          textOrNull(record.decision ?? record.status ?? record.direction) ?? "-",
        latestRank: index + 1,
        strategy: strategy || null,
        estimatedNotional:
          numberOrNull(record.estimatedNotional) ??
          numberOrNull(record.estimated_notional) ??
          numberOrNull(record.estimated_max_loss) ??
          numberOrNull(record.estimated_max_profit)
      };
    })
  }
});

const planRowsFromBridgeValue = (value: unknown, fallback: unknown[]) => {
  const result = recordValue(value);
  const data = recordValue(result.data);
  return Array.isArray(data.plan) ? data.plan : fallback;
};

const normalizeBridgeHedgeResult = (value: unknown): DashboardSnapshot["hedge"] => {
  const result = recordValue(value);
  if (result.ok === false) {
    return {
      ok: false,
      label: textOrNull(result.label) ?? "hedge",
      error: textOrNull(result.error) ?? "Unavailable"
    };
  }
  const data = recordValue(result.ok === true ? result.data : value);
  const status = textOrNull(data.effectiveStatus ?? data.status);
  return {
    ok: true,
    label: textOrNull(result.label) ?? "hedge",
    data: {
      ...data,
      effectiveStatus:
        status === "current" || status === "monitoring" || status === "stale" ||
        status === "expired" || status === "blocked"
          ? status
          : "blocked"
    }
  };
};

export const normalizeDashboardBridgeSummary = (summary: PaperBridgeSummary): PaperBridgeSummary => {
  const latestPlans = clampRows(summary.latestPaperPlans, 100);
  return {
    ...summary,
    latestPaperPlans: latestPlans,
    plan: cachedPlanResult(planRowsFromBridgeValue(summary.plan, latestPlans)),
    optionContracts: clampRows(summary.optionContracts, 100).map(normalizeBridgeOptionContractRow),
    hedge: normalizeBridgeHedgeResult(summary.hedge)
  };
};

const cachedReviewAndDryRun = async (): Promise<{
  review: DashboardSnapshot["review"];
  dryRun: DashboardSnapshot["dryRun"];
}> => {
  const {
    latestPaperReviewArtifact,
    isPaperReviewArtifactFresh
  } = await import("../../../src/services/paperReviewArtifactService");
  const artifact = latestPaperReviewArtifact();
  if (!artifact) {
    return {
      review: {
        ok: false,
        label: "review",
        error: "No reviewed payload artifact is available yet."
      },
      dryRun: {
        ok: false,
        label: "dryRun",
        error: "No reviewed payload artifact is available yet."
      }
    };
  }

  const fresh = isPaperReviewArtifactFresh(artifact);
  const staleWarning = fresh ? [] : ["REVIEW_STALE_OR_PAYLOAD_CHANGED"];
  const warnings = [...artifact.artifact.warnings, ...staleWarning];
  const blockers = artifact.artifact.blockers;
  const status = fresh ? artifact.status : "warning";

  return {
    review: {
      ok: true,
      label: "review",
      data: {
        review: {
          status,
          blockers,
          warnings
        },
        planSummary: {
          plannedOrders: artifact.payloadCount
        }
      }
    },
    dryRun: {
      ok: true,
      label: "dryRun",
      data: {
        summary: {
          wouldSubmitCount: artifact.payloadCount,
          payloadsBlocked: blockers.length
        },
        assetClass: "all"
      }
    }
  };
};

export const latestPaperExecutions = async (limit = 50) => {
  if (isPaperDashboardBridgeEnabled()) {
    const summary = await getPaperBridgeSummary();
    return clampRows(summary.executions, limit);
  }
  return [];
};

const latestPaperRecommendationSnapshots = async (limit = 10) => {
  if (isPaperDashboardBridgeEnabled()) {
    const summary = await getPaperBridgeSummary();
    return clampRows(summary.snapshots, limit);
  }
  return [];
};

export const latestHedgeDashboardRecommendation = async () => {
  if (isPaperDashboardBridgeEnabled()) {
    return fetchPaperBridgePayload("api/v1/hedge/recommendation");
  }
  return historicalUnavailable("hedgeRecommendation");
};

export const latestHedgeDashboardRisk = async () => {
  if (isPaperDashboardBridgeEnabled()) {
    return fetchPaperBridgePayload("api/v1/hedge/risk");
  }
  return historicalUnavailable("hedgeRisk");
};

export const latestHedgeDashboardRegime = async () => {
  if (isPaperDashboardBridgeEnabled()) {
    return fetchPaperBridgePayload("api/v1/hedge/regime");
  }
  return historicalUnavailable("hedgeRegime");
};

export const latestHedgeExecutionStatus = async () => {
  if (isPaperDashboardBridgeEnabled()) {
    return fetchPaperBridgePayload("api/v1/hedge/execution");
  }
  return historicalUnavailable("hedgeExecution");
};

export const latestHedgeLearningStatus = async () => {
  if (isPaperDashboardBridgeEnabled()) {
    return fetchPaperBridgePayload("api/v1/hedge/learning");
  }
  return historicalUnavailable("hedgeLearning");
};

export const buildCachedDashboardSnapshot = async (): Promise<DashboardSnapshot> => {
  throw new Error("DASHBOARD_POSTGRES_BRIDGE_REQUIRED");
};

export const buildDashboardSnapshot = async (): Promise<DashboardSnapshot> => {
  assertPaperDashboardAccess();

  if (isPaperDashboardBridgeEnabled()) {
    const bridgeSummary = normalizeDashboardBridgeSummary(await getPaperBridgeSummary());
    return {
      ...bridgeSummary,
      generatedAt: bridgeSummary.generatedAt || new Date().toISOString(),
      paperOnly: true,
      mode: bridgeSummary.mode || VERCEL_READ_ONLY_MODE,
      hedge: bridgeSummary.hedge ?? historicalUnavailable("hedge")
    } as DashboardSnapshot;
  }

  throw new Error("DASHBOARD_POSTGRES_BRIDGE_REQUIRED");
};

export const runPaperResearch = async (input: PaperActionInput) => {
  void input;
  throw new Error("POSTGRES_ONLY_RUNTIME_PATH_DISABLED");
};

export const runPaperPlan = async (input: PaperActionInput) => {
  void input;
  throw new Error("POSTGRES_ONLY_RUNTIME_PATH_DISABLED");
};

export const runPaperReview = async (input: PaperActionInput) => {
  void input;
  throw new Error("POSTGRES_ONLY_RUNTIME_PATH_DISABLED");
};

export const runPaperDryRun = async (input: PaperActionInput) => {
  void input;
  throw new Error("POSTGRES_ONLY_RUNTIME_PATH_DISABLED");
};

export const runPaperConfirm = async (input: PaperActionInput) => {
  void input;
  throw new Error("POSTGRES_ONLY_RUNTIME_PATH_DISABLED");
};

export const runPaperLearningCommit = async () => {
  throw new Error("POSTGRES_ONLY_RUNTIME_PATH_DISABLED");
};

export const runPaperPortfolioReview = async (input: PaperActionInput) => {
  void input;
  throw new Error("POSTGRES_ONLY_RUNTIME_PATH_DISABLED");
};

export const runPaperOptionsDiscovery = async (input: PaperActionInput) => {
  void input;
  throw new Error("POSTGRES_ONLY_RUNTIME_PATH_DISABLED");
};

export const runPaperOpsReviewAction = async () => {
  throw new Error("POSTGRES_ONLY_RUNTIME_PATH_DISABLED");
};

export const runPaperReviewedExecution = async (input: PaperActionInput) => {
  void input;
  throw new Error("POSTGRES_ONLY_RUNTIME_PATH_DISABLED");
};

export const runHedgeReviewAction = async () => {
  throw new Error("POSTGRES_ONLY_RUNTIME_PATH_DISABLED");
};

export const runHedgeExecutionAction = async (input: PaperActionInput) => {
  void input;
  throw new Error("POSTGRES_ONLY_RUNTIME_PATH_DISABLED");
};

export const runHedgeExitReviewAction = async (input: PaperActionInput) => {
  void input;
  throw new Error("POSTGRES_ONLY_RUNTIME_PATH_DISABLED");
};

export const runHedgeExitExecutionAction = async (input: PaperActionInput) => {
  void input;
  throw new Error("POSTGRES_ONLY_RUNTIME_PATH_DISABLED");
};

export const dashboardMoney = (value: unknown) => {
  const numeric = numberOrNull(value);
  return numeric === null
    ? "-"
    : numeric.toLocaleString("en-US", { style: "currency", currency: "USD" });
};
