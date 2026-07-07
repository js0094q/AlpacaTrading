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

export type DashboardSnapshotMode = "local-sqlite" | typeof VERCEL_READ_ONLY_MODE | string;

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
}

export type OptionContractDisplayCategory = "Discovered" | "Quoted" | "Executable" | "Rejected";

export interface OptionContractDashboardRow {
  underlying_symbol: string;
  option_symbol: string;
  type: string;
  expiration_date: string;
  strike: number | null;
  tradable: boolean;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  last: number | null;
  quoteStatus: "valid" | "missing" | "invalid" | "stale";
  executable: boolean;
  executablePrice: number | null;
  executablePriceSource: string | null;
  rejectionReason: string | null;
  quoteTimestamp: string | null;
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

const normalizeRiskProfile = (value: unknown): RiskProfileInput => {
  return value === "aggressive" || value === "conservative" || value === "moderate"
    ? value
    : "aggressive";
};

const normalizeAssetClass = (value: unknown): "all" | "equity" | "option" => {
  return value === "equity" || value === "option" || value === "all" ? value : "all";
};

const queryAllRows = async <T = Record<string, unknown>>(
  sql: string,
  params: Array<string | number | null> = []
): Promise<T[]> => {
  const { queryAll } = await import("../../../src/lib/db");
  return queryAll<T>(sql, params);
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
    dte: safeLimit(record.dte, 0, 30)
  };
};

export const latestResearchRuns = async (limit = 5) =>
  shouldUseVercelReadOnlyFallback()
    ? []
    : isPaperDashboardBridgeEnabled()
      ? getPaperBridgeSummary().then((summary) => clampRows(summary.latestResearch, limit))
    : queryAllRows(
        `
        SELECT id, started_at, completed_at, status, risk_profile, options_enabled, candidates_selected
        FROM research_runs
        ORDER BY started_at DESC
        LIMIT ?
        `,
        [safeLimit(limit, 5, 25)]
      );

export const latestPaperPlans = async (limit = 10) =>
  shouldUseVercelReadOnlyFallback()
    ? []
    : isPaperDashboardBridgeEnabled()
      ? getPaperBridgeSummary().then((summary) => clampRows(summary.latestPaperPlans, limit))
    : queryAllRows(
        `
        SELECT id, research_run_id, symbol, created_at, status, direction, expression, option_symbol, estimated_max_loss, estimated_max_profit
        FROM paper_trade_plans
        ORDER BY created_at DESC
        LIMIT ?
        `,
        [safeLimit(limit, 10, 50)]
      );

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

const normalizeOptionContractDashboardRow = (row: {
  underlying_symbol: string;
  option_symbol: string;
  type: string;
  expiration_date: string;
  strike: number | null;
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

  return {
    underlying_symbol: row.underlying_symbol,
    option_symbol: row.option_symbol,
    type: row.type,
    expiration_date: row.expiration_date,
    strike: row.strike,
    tradable: row.tradable === 1,
    bid: row.bid,
    ask: row.ask,
    midpoint: row.midpoint,
    last: row.last,
    quoteStatus,
    executable,
    executablePrice: executable ? row.executable_price : null,
    executablePriceSource: executable ? row.executable_price_source : null,
    rejectionReason,
    quoteTimestamp: row.quote_timestamp,
    timestamp: row.timestamp,
    displayCategory: optionDisplayCategory({
      hasSnapshot: Boolean(row.timestamp),
      quoteStatus,
      executable,
      rejectionReason
    })
  };
};

export const latestOptionContracts = async (limit = 10) =>
  shouldUseVercelReadOnlyFallback()
    ? []
    : isPaperDashboardBridgeEnabled()
      ? getPaperBridgeSummary().then((summary) => clampRows(summary.optionContracts, limit))
    : queryAllRows<{
        underlying_symbol: string;
        option_symbol: string;
        type: string;
        expiration_date: string;
        strike: number | null;
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
        timestamp: string | null;
      }>(
        `
        SELECT
          c.underlying_symbol,
          c.option_symbol,
          c.type,
          c.expiration_date,
          c.strike,
          c.tradable,
          s.bid,
          s.ask,
          s.midpoint,
          s.last,
          s.quote_status,
          s.executable,
          s.executable_price,
          s.executable_price_source,
          s.rejection_reason,
          s.quote_timestamp,
          s.timestamp
        FROM option_contracts c
        LEFT JOIN option_snapshots s
          ON s.option_symbol = c.option_symbol
          AND s.timestamp = (
            SELECT MAX(timestamp)
            FROM option_snapshots
            WHERE option_symbol = c.option_symbol
          )
        ORDER BY COALESCE(s.timestamp, c.expiration_date) DESC
        LIMIT ?
        `,
        [safeLimit(limit, 10, 50)]
      ).then((rows) => rows.map(normalizeOptionContractDashboardRow));

export const latestOpenOrders = async (limit = 12) =>
  shouldUseVercelReadOnlyFallback()
    ? []
    : isPaperDashboardBridgeEnabled()
      ? getPaperBridgeSummary().then((summary) =>
          clampRows(normalizeOpenOrdersRows(summary.openOrders), limit)
        )
    : listAlpacaOpenOrders().then((result) => clampRows(result.orders, limit));

export const latestApiRequestIds = async (limit = 12) =>
  shouldUseVercelReadOnlyFallback()
    ? []
    : isPaperDashboardBridgeEnabled()
      ? getPaperBridgeSummary().then((summary) => clampRows(summary.requestIds, limit))
    : queryAllRows(
        `
        SELECT provider, endpoint, method, status, request_id, created_at
        FROM api_request_log
        WHERE request_id IS NOT NULL
        ORDER BY created_at DESC
        LIMIT ?
        `,
        [safeLimit(limit, 12, 50)]
      );

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

const cachedPlanResult = (latestPlans: unknown[]): DashboardSnapshot["plan"] => ({
  ok: true,
  label: "plan",
  data: {
    plan: latestPlans.map((row, index) => {
      const record = row && typeof row === "object" ? row as Record<string, unknown> : {};
      const strategy = [record.direction, record.expression, record.option_symbol]
        .map((entry) => typeof entry === "string" ? entry : "")
        .filter(Boolean)
        .join(" / ");
      return {
        symbol: typeof record.symbol === "string" ? record.symbol : "-",
        decision:
          typeof record.status === "string"
            ? record.status
            : typeof record.direction === "string"
              ? record.direction
              : "-",
        latestRank: index + 1,
        strategy: strategy || null,
        estimatedNotional:
          numberOrNull(record.estimated_max_loss) ??
          numberOrNull(record.estimated_max_profit)
      };
    })
  }
});

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
  if (shouldUseVercelReadOnlyFallback()) {
    return [];
  }
  if (isPaperDashboardBridgeEnabled()) {
    const summary = await getPaperBridgeSummary();
    return clampRows(summary.executions, limit);
  }
  const { listPaperExecutionLedgerEntries } = await import(
    "../../../src/services/paperExecutionLedgerService"
  );
  return listPaperExecutionLedgerEntries(limit);
};

const latestPaperRecommendationSnapshots = async (limit = 10) => {
  if (shouldUseVercelReadOnlyFallback()) {
    return [];
  }
  if (isPaperDashboardBridgeEnabled()) {
    const summary = await getPaperBridgeSummary();
    return clampRows(summary.snapshots, limit);
  }
  const { listPaperRecommendationSnapshots } = await import(
    "../../../src/services/paperRecommendationSnapshotService"
  );
  return listPaperRecommendationSnapshots({ limit });
};

export const buildCachedDashboardSnapshot = async (): Promise<DashboardSnapshot> => {
  const state = assertPaperDashboardAccess();

  const [account, positions, openOrders, latestResearch, latestPlans, executions, snapshots, requestIds] =
    await Promise.all([
      captureWithTimeout("account", () => getAlpacaAccountSnapshot()),
      captureWithTimeout("positions", () => listAlpacaPositions()),
      captureWithTimeout("openOrders", () => listAlpacaOpenOrders()),
      latestResearchRuns(5),
      latestPaperPlans(10),
      captureWithTimeout("executions", () => latestPaperExecutions(25)),
      latestPaperRecommendationSnapshots(10),
      latestApiRequestIds(12)
    ]);

  const [reviewDryRun, learningSummary, promotionReadiness] = await Promise.all([
    captureWithTimeout("review", () => cachedReviewAndDryRun(), 3_000),
    captureWithTimeout("learningSummary", async () => {
      const { paperLearningSummary } = await import(
        "../../../src/services/paperLearningLedgerService"
      );
      return paperLearningSummary();
    }, 3_000),
    Promise.resolve()
      .then(async () => {
        const service = await import("../../../src/services/paperLearningLedgerService");
        return service.buildPromotionReadinessAnalytics();
      })
      .catch(() => [])
  ]);

  const review =
    reviewDryRun.ok
      ? reviewDryRun.data.review
      : {
          ok: false as const,
          label: "review",
          error: reviewDryRun.error
        };
  const dryRun =
    reviewDryRun.ok
      ? reviewDryRun.data.dryRun
      : {
          ok: false as const,
          label: "dryRun",
          error: reviewDryRun.error
        };

  return {
    paperOnly: true,
    environment: state.alpacaEnv,
    liveTradingEnabled: state.liveTradingEnabled,
    generatedAt: new Date().toISOString(),
    mode: "vps-cached-summary",
    historicalDataAvailable: true,
    durableStorageConfigured: false,
    historicalWarning: null,
    durableStorageWarning: null,
    account,
    positions,
    runtime: cachedSummaryUnavailable("runtime"),
    plan: cachedPlanResult(latestPlans),
    review,
    dryRun,
    openOrders,
    latestResearch,
    latestPaperPlans: latestPlans,
    snapshots,
    executions,
    learningSummary,
    promotionReadiness: Array.isArray(promotionReadiness) ? promotionReadiness : [],
    optionContracts: [],
    requestIds
  } as DashboardSnapshot;
};

export const buildDashboardSnapshot = async (): Promise<DashboardSnapshot> => {
  const state = assertPaperDashboardAccess();

  if (isPaperDashboardBridgeEnabled()) {
    const bridgeSummary = await getPaperBridgeSummary();
    return {
      ...bridgeSummary,
      generatedAt: bridgeSummary.generatedAt || new Date().toISOString(),
      paperOnly: true,
      mode: bridgeSummary.mode || VERCEL_READ_ONLY_MODE
    } as DashboardSnapshot;
  }

  if (shouldUseVercelReadOnlyFallback()) {
    const [account, positions, openOrders] = await Promise.all([
      capture("account", () => getAlpacaAccountSnapshot()),
      capture("positions", () => listAlpacaPositions()),
      capture("openOrders", () => listAlpacaOpenOrders())
    ]);

    return {
      paperOnly: true,
      environment: state.alpacaEnv,
      liveTradingEnabled: state.liveTradingEnabled,
      generatedAt: new Date().toISOString(),
      mode: VERCEL_READ_ONLY_MODE,
      historicalDataAvailable: false,
      durableStorageConfigured: hasDashboardDurableStorageConfig(),
      historicalWarning: VERCEL_HISTORICAL_UNAVAILABLE_MESSAGE,
      durableStorageWarning: VERCEL_HISTORICAL_STORAGE_WARNING,
      account,
      positions,
      runtime: historicalUnavailable("runtime"),
      plan: historicalUnavailable("plan"),
      review: historicalUnavailable("review"),
      dryRun: historicalUnavailable("dryRun"),
      latestResearch: [],
      latestPaperPlans: [],
      openOrders,
      snapshots: [],
      executions: historicalUnavailable("executions"),
      learningSummary: historicalUnavailable("learningSummary"),
      promotionReadiness: [],
      optionContracts: [],
      requestIds: []
    };
  }

  const [account, positions, openOrders, runtime, plan, review, dryRun, executions, learningSummary] =
    await Promise.all([
      capture("account", () => getAlpacaAccountSnapshot()),
      capture("positions", () => listAlpacaPositions()),
      capture("openOrders", () => listAlpacaOpenOrders()),
      capture("runtime", async () => {
        const { buildPaperRuntimeReport } = await import(
          "../../../src/services/paperRuntimeService"
        );
        return buildPaperRuntimeReport({
          riskProfile: "aggressive",
          optionsEnabled: true,
          maxCandidates: 10
        });
      }),
      capture("plan", async () => {
        const { buildPaperPlanReport } = await import(
          "../../../src/services/paperPlanService"
        );
        return buildPaperPlanReport({
          riskProfile: "aggressive",
          optionsEnabled: true,
          maxCandidates: 10
        });
      }),
      capture("review", async () => {
        const { buildPaperReviewReport } = await import(
          "../../../src/services/paperReviewService"
        );
        return buildPaperReviewReport({
          riskProfile: "aggressive",
          optionsEnabled: true,
          maxCandidates: 10
        });
      }),
      capture("dryRun", async () => {
        const { buildPaperExecuteDryRunReport } = await import(
          "../../../src/services/paperExecuteDryRunService"
        );
        return buildPaperExecuteDryRunReport({
          dryRun: true,
          riskProfile: "aggressive",
          optionsEnabled: true,
          maxCandidates: 10,
          assetClass: "all"
        });
      }),
      capture("executions", () => latestPaperExecutions(25)),
      capture("learningSummary", async () => {
        const { paperLearningSummary } = await import(
          "../../../src/services/paperLearningLedgerService"
        );
        return paperLearningSummary();
      })
    ]);
  const [
    latestResearch,
    latestPlans,
    latestOpenOrderRows,
    snapshots,
    promotionReadiness,
    optionContracts,
    requestIds
  ] = await Promise.all([
    latestResearchRuns(5),
    latestPaperPlans(10),
    latestOpenOrders(12),
    latestPaperRecommendationSnapshots(10),
    import("../../../src/services/paperLearningLedgerService").then((service) =>
      service.buildPromotionReadinessAnalytics()
    ),
    latestOptionContracts(10),
    latestApiRequestIds(12)
  ]);

  return {
    paperOnly: true,
    environment: state.alpacaEnv,
    liveTradingEnabled: state.liveTradingEnabled,
    generatedAt: new Date().toISOString(),
    mode: "local-sqlite" as const,
    historicalDataAvailable: true,
    durableStorageConfigured: false,
    historicalWarning: null,
    durableStorageWarning: null,
    account,
    positions,
    runtime,
    plan,
    review,
    dryRun,
    openOrders,
    latestResearch,
    latestPaperPlans: latestPlans,
    snapshots,
    executions,
    learningSummary,
    promotionReadiness,
    optionContracts,
    requestIds
  } as DashboardSnapshot;
};

export const runPaperResearch = async (input: PaperActionInput) => {
  const { runResearchDaily } = await import("../../../src/services/researchOrchestrator");
  return runResearchDaily({
    riskProfile: input.riskProfile,
    optionsEnabled: input.optionsEnabled,
    maxCandidates: input.maxCandidates,
    useAlpacaAssets: true
  });
};

export const runPaperPlan = async (input: PaperActionInput) => {
  const { buildPaperPlanReport } = await import("../../../src/services/paperPlanService");
  return buildPaperPlanReport({
    riskProfile: input.riskProfile,
    optionsEnabled: input.optionsEnabled,
    maxCandidates: input.maxCandidates
  });
};

export const runPaperReview = async (input: PaperActionInput) => {
  const { buildPaperReviewReport } = await import("../../../src/services/paperReviewService");
  return buildPaperReviewReport({
    riskProfile: input.riskProfile,
    optionsEnabled: input.optionsEnabled,
    maxCandidates: input.maxCandidates
  });
};

export const runPaperDryRun = async (input: PaperActionInput) => {
  const { buildPaperExecuteDryRunReport } = await import(
    "../../../src/services/paperExecuteDryRunService"
  );
  return buildPaperExecuteDryRunReport({
    dryRun: true,
    riskProfile: input.riskProfile,
    optionsEnabled: input.optionsEnabled,
    maxCandidates: input.maxCandidates,
    assetClass: input.assetClass
  });
};

export const runPaperConfirm = async (input: PaperActionInput) => {
  const { buildPaperExecuteConfirmPaperReport } = await import(
    "../../../src/services/paperExecuteDryRunService"
  );
  return buildPaperExecuteConfirmPaperReport({
    confirmPaper: true,
    riskProfile: input.riskProfile,
    optionsEnabled: input.optionsEnabled,
    maxCandidates: input.maxCandidates,
    assetClass: input.assetClass
  });
};

export const runPaperLearningCommit = async () => {
  const service = await import("../../../src/services/paperLearningLedgerService");
  const evaluation = service.evaluatePaperLearningRecords({ limit: 100 });
  return {
    paperOnly: true,
    status: "success",
    summary: {
      evaluatedRows: evaluation.evaluated,
      submittedRows: 0,
      pendingRows: evaluation.stillPending,
      promotedSignals: service.paperLearningSummary().promoted,
      demotedSignals: service.paperLearningSummary().rejected,
      skippedReasons: evaluation.pendingReasons.slice(0, 20)
    },
    evaluation,
    learningSummary: service.paperLearningSummary(),
    promotionReadiness: service.buildPromotionReadinessAnalytics(),
    blockers: [],
    warnings: []
  };
};

export const runPaperPortfolioReview = async (input: PaperActionInput) => {
  const { buildPaperPortfolioReviewReport } = await import(
    "../../../src/services/paperPortfolioReviewService"
  );
  return buildPaperPortfolioReviewReport({
    moment: "manual"
  });
};

export const runPaperOptionsDiscovery = async (input: PaperActionInput) => {
  const { buildPaperOptionsDiscoveryReport } = await import(
    "../../../src/services/paperOptionsDiscoveryService"
  );
  return buildPaperOptionsDiscoveryReport({
    underlying: input.underlying,
    dte: input.dte
  });
};

export const runPaperOpsReviewAction = async () => {
  const { runPaperOpsReview } = await import(
    "../../../src/services/paperOpsWorkflowService"
  );
  return runPaperOpsReview({ triggerSource: "dashboard" });
};

export const runPaperReviewedExecution = async (input: PaperActionInput) => {
  const { buildPaperReviewedPayloadExecutionReport } = await import(
    "../../../src/services/paperReviewedPayloadExecutionService"
  );
  return buildPaperReviewedPayloadExecutionReport({
    confirmPaper: input.confirmPaper,
    expectedPayloadSignature: input.expectedPayloadSignature
  });
};

export const dashboardMoney = (value: unknown) => {
  const numeric = numberOrNull(value);
  return numeric === null
    ? "-"
    : numeric.toLocaleString("en-US", { style: "currency", currency: "USD" });
};
