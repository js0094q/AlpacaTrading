import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Pool } from "pg";

import { loadDatabaseConfig } from "../../src/lib/database/config.js";
import { createPostgresPool } from "../../src/lib/database/postgres.js";
import { assertPostgresOnlyDatabaseAuthority } from "../../src/lib/database/postgresOnlyRuntime.js";
import { withPostgresTransaction } from "../../src/lib/database/postgresTransaction.js";
import { safeTokenEquals } from "../../src/lib/safeToken.js";
import { redactSensitiveData, redactSensitiveText } from "../../src/lib/securityRedaction.js";
import { getTradingSafetyState } from "../../src/services/tradingSafetyService.js";
import { getAlpacaAccountSnapshot } from "../../src/services/alpacaAccountService.js";
import { getAlpacaMarketClock } from "../../src/services/alpacaMarketClockService.js";
import { listAlpacaOpenOrders } from "../../src/services/alpacaOrderReadService.js";
import { listAlpacaPositions } from "../../src/services/alpacaPositionService.js";
import { submitPaperOrder } from "../../src/services/alpacaClient.js";
import { readPostgresAuthorityStatus } from "../../src/services/postgresAuthorityCutoverService.js";
import { runPostgresScheduledCommand } from "../../src/services/postgresScheduledCommandService.js";
import { runPostgresResearchWorkflow } from "../../src/services/postgresResearchWorkflowService.js";
import { runPostgresReviewWorkflow } from "../../src/services/postgresReviewWorkflowService.js";
import { runAutonomousPostgresCommand } from "../../src/services/autonomousPostgresCommandService.js";
import { runAutonomousPostgresExecutionCommand } from "../../src/services/autonomousPostgresExecutionService.js";
import { capturePostgresAuthorityBrokerSnapshot } from "../../src/services/postgresAuthorityBrokerSnapshot.js";
import { paperSubmitConfiguration } from "../../src/services/paperSubmitSafetyConfig.js";
import {
  readPostgresDashboardData,
  readPostgresWorkerHealth,
  readPostgresZeroDteDashboardSummary,
  type PostgresDashboardQuery,
  type PostgresWorkerHealth,
  type PostgresZeroDteDashboardSummary
} from "../../src/services/postgresDashboardReadService.js";

type RiskProfile = "moderate" | "aggressive" | "conservative";
type AssetClass = "all" | "equity" | "option";

type ControlInput = {
  riskProfile: RiskProfile;
  optionsEnabled: boolean;
  maxCandidates: number;
  assetClass: AssetClass;
  confirmPaper: boolean;
  expectedPayloadSignature?: string;
  sections?: string;
  underlying: string;
  dte: number;
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
};

type ControlContext = {
  readonly input: ControlInput;
  readonly requestId: string;
  readonly correlationId: string;
};

type Handler = (context: ControlContext) => Promise<unknown>;

type ActionConfig = {
  method: "GET" | "POST";
  requireAdminToken: boolean;
  action: string;
  handler: Handler;
};

type ControlDependencies = {
  authorityStatus: () => Promise<unknown>;
  account: typeof getAlpacaAccountSnapshot;
  positions: typeof listAlpacaPositions;
  openOrders: typeof listAlpacaOpenOrders;
  query?: () => PostgresDashboardQuery;
  workerHealth?: () => Promise<PostgresWorkerHealth>;
  dashboardData?: (limit?: number) => Promise<Awaited<ReturnType<typeof readPostgresDashboardData>>>;
  zeroDteSummary?: (limit?: number) => Promise<PostgresZeroDteDashboardSummary>;
  scheduledCommand?: (
    command: string,
    context: ControlContext
  ) => Promise<unknown>;
};

class ControlRouteError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ControlRouteError";
  }
}

const CONTROL_HOST =
  process.env.VPS_CONTROL_BIND_HOST?.trim() ||
  process.env.DASHBOARD_CONTROL_HOST?.trim() ||
  "127.0.0.1";
const CONTROL_PORT = Number(
  process.env.VPS_CONTROL_PORT?.trim() ||
    process.env.DASHBOARD_CONTROL_PORT?.trim() ||
    process.env.PORT ||
    "4100"
);
const MAX_REQUEST_BODY_BYTES = 100_000;

let pool: Pool | null = null;
let testDependencies: ControlDependencies | null = null;

const postgresPool = () => {
  if (pool) return pool;
  const config = loadDatabaseConfig(process.env, { purpose: "application" });
  assertPostgresOnlyDatabaseAuthority(config);
  pool = createPostgresPool(config, "pooled");
  return pool;
};

const queryAdapter = (queryable: {
  query: (sql: string, values?: unknown[]) => Promise<unknown>;
}): PostgresDashboardQuery => ({
  query: (sql, values) => queryable.query(sql, values ? [...values] : undefined) as never
});

const defaultDependencies = (): ControlDependencies => ({
  authorityStatus: async () => {
    const database = postgresPool();
    await database.query("SELECT 1 AS postgres_authority_available");
    const status = await readPostgresAuthorityStatus(database);
    if (!status.latestCheckpoint || status.latestCheckpoint.status !== "passed") {
      throw new ControlRouteError(
        "POSTGRES_AUTHORITY_BASELINE_REQUIRED",
        503,
        "A passed PostgreSQL authority baseline is required."
      );
    }
    return status;
  },
  account: getAlpacaAccountSnapshot,
  positions: listAlpacaPositions,
  openOrders: listAlpacaOpenOrders,
  query: () => queryAdapter(postgresPool()),
  workerHealth: () => readPostgresWorkerHealth(queryAdapter(postgresPool())),
  dashboardData: (limit = 25) => readPostgresDashboardData(queryAdapter(postgresPool()), limit),
  zeroDteSummary: (limit = 25) => readPostgresZeroDteDashboardSummary({
    query: queryAdapter(postgresPool()),
    limit
  })
});

const dependencies = () => testDependencies ?? defaultDependencies();

export const setControlDependenciesForTests = (value: ControlDependencies | null) => {
  testDependencies = value;
};

const authorityStatus = async () => dependencies().authorityStatus();

const assertPaperRuntime = () => {
  const safety = getTradingSafetyState();
  if (
    safety.alpacaEnv !== "paper" ||
    String(process.env.TRADING_MODE || "paper").toLowerCase() !== "paper" ||
    safety.liveTradingEnabled
  ) {
    throw new ControlRouteError(
      "PAPER_RUNTIME_REQUIRED",
      503,
      "Dashboard control actions require paper mode with live trading disabled."
    );
  }
};

const normalizeInput = (value: unknown): ControlInput => {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const riskProfile = body.riskProfile === "moderate" || body.riskProfile === "conservative"
    ? body.riskProfile
    : "aggressive";
  const maxCandidates = Number(body.maxCandidates);
  const dte = Number(body.dte);
  const quantity = Number(body.quantity);
  const numberOrUndefined = (entry: unknown) => {
    const parsed = Number(entry);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return {
    riskProfile,
    optionsEnabled: body.optionsEnabled !== false,
    maxCandidates: Number.isSafeInteger(maxCandidates) && maxCandidates > 0
      ? Math.min(50, maxCandidates)
      : 10,
    assetClass: body.assetClass === "equity" || body.assetClass === "option"
      ? body.assetClass
      : "all",
    confirmPaper: body.confirmPaper === true,
    expectedPayloadSignature:
      typeof body.expectedPayloadSignature === "string"
        ? body.expectedPayloadSignature.trim() || undefined
        : undefined,
    sections: typeof body.sections === "string" ? body.sections : undefined,
    underlying:
      typeof body.underlying === "string" && body.underlying.trim()
        ? body.underlying.trim().toUpperCase()
        : "SPY",
    dte: Number.isSafeInteger(dte) && dte >= 0 ? Math.min(730, dte) : 0,
    quantity: Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : undefined,
    reviewId: typeof body.reviewId === "string" ? body.reviewId.trim() || undefined : undefined,
    symbol: typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() || undefined : undefined,
    expirationDate: typeof body.expirationDate === "string" ? body.expirationDate : undefined,
    entryPrice: numberOrUndefined(body.entryPrice),
    currentPrice: numberOrUndefined(body.currentPrice),
    entryAt: typeof body.entryAt === "string" ? body.entryAt : undefined,
    asOf: typeof body.asOf === "string" ? body.asOf : undefined,
    staleThesis: body.staleThesis === true,
    riskNormalizationObservations: numberOrUndefined(body.riskNormalizationObservations)
  };
};

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      throw new ControlRouteError("CONTROL_INPUT_TOO_LARGE", 413, "Request body is too large.");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ControlRouteError("CONTROL_INPUT_INVALID", 400, "Request body must be valid JSON.");
  }
};

const queryFor = () => dependencies().query?.() || queryAdapter(postgresPool());

const readCurrentSummary = async () => {
  const runtime = dependencies();
  const [authority, account, positions, openOrders, dashboard, worker] = await Promise.all([
    runtime.authorityStatus(),
    runtime.account(),
    runtime.positions(),
    runtime.openOrders(),
    runtime.dashboardData?.(25) || readPostgresDashboardData(queryFor(), 25),
    runtime.workerHealth?.() || readPostgresWorkerHealth(queryFor())
  ]);
  const readyIntentCount = dashboard.readyIntentCount;
  return {
    paperOnly: true,
    environment: "paper",
    liveTradingEnabled: false,
    generatedAt: new Date().toISOString(),
    mode: "postgres-only-authority",
    historicalDataAvailable: true,
    durableStorageConfigured: true,
    historicalWarning: null,
    durableStorageWarning: null,
    authority,
    account: { ok: true, label: "account", data: account },
    positions: { ok: true, label: "positions", data: positions },
    openOrders: { ok: true, label: "openOrders", data: openOrders },
    runtime: { ok: true, label: "runtime", data: worker },
    plan: {
      ok: true,
      label: "plan",
      data: { plan: dashboard.latestPaperPlans, planSummary: { count: dashboard.latestPaperPlans.length } }
    },
    review: {
      ok: true,
      label: "review",
      data: {
        review: dashboard.reviews[0] ?? { status: "blocked", blockers: ["NO_POSTGRES_REVIEW"] },
        planSummary: { plannedOrders: readyIntentCount }
      }
    },
    dryRun: {
      ok: true,
      label: "dryRun",
      data: {
        summary: { wouldSubmitCount: readyIntentCount, payloadsBlocked: 0 },
        assetClass: "all"
      }
    },
    latestResearch: dashboard.latestResearch,
    latestPaperPlans: dashboard.latestPaperPlans,
    snapshots: dashboard.optionContracts,
    executions: { ok: true, label: "executions", data: dashboard.executions },
    learningSummary: {
      ok: true,
      label: "learningSummary",
      data: { authority: "postgres", status: "available_through_postgres_commands" }
    },
    promotionReadiness: [],
    optionContracts: dashboard.optionContracts,
    requestIds: dashboard.requestIds,
    hedge: {
      ok: true,
      label: "hedge",
      data: { paperOnly: true, status: "blocked", blockers: ["NO_POSTGRES_HEDGE_STATE"] }
    }
  };
};

const readDryRun = async () => {
  await authorityStatus();
  const result = await queryFor().query(
    `SELECT COUNT(*) AS ready_count
     FROM order_intents
     WHERE status = 'ready_for_submission' AND environment = 'paper'`,
    []
  );
  const readyCount = Number(result.rows[0]?.ready_count ?? 0);
  return {
    paperOnly: true,
    environment: "paper",
    liveTradingEnabled: false,
    status: "completed",
    summary: { wouldSubmitCount: Number.isSafeInteger(readyCount) ? readyCount : 0, payloadsBlocked: 0 },
    assetClass: "all",
    mutationAttempted: false
  };
};

const runScheduledCommand = async (command: string, context: ControlContext) => {
  const injected = dependencies().scheduledCommand;
  if (injected) return injected(command, context);
  return runPostgresScheduledCommand({
    command,
    action: context.requestId,
    sections: context.input.sections,
    operation: async (scheduledContext) => {
      if (!scheduledContext) throw new ControlRouteError(
        "POSTGRES_SCHEDULER_CONTEXT_REQUIRED",
        503,
        "A PostgreSQL scheduler context is required."
      );
      const query = queryAdapter(scheduledContext.pool);
      if (command === "research:daily") {
        return runPostgresResearchWorkflow({
          query,
          fence: scheduledContext.fence,
          riskProfile: context.input.riskProfile,
          optionsEnabled: context.input.optionsEnabled,
          maxCandidates: context.input.maxCandidates
        });
      }
      if ([
        "paper:review",
        "paper:portfolio:review",
        "paper:options:discover",
        "paper:ops:review",
        "paper:exit:review",
        "hedge:review",
        "hedge:exit:review",
        "zero-dte:exit:review"
      ].includes(command)) {
        return runPostgresReviewWorkflow({
          command,
          query,
          fence: scheduledContext.fence,
          underlying: context.input.underlying,
          dte: context.input.dte
        });
      }
      if (command === "paper:learn" || command === "system:recover") {
        return runAutonomousPostgresCommand({
          command,
          query,
          fence: scheduledContext.fence
        });
      }
      if ([
        "paper:execute:reviewed",
        "paper:exit:execute",
        "hedge:exit:execute",
        "zero-dte:engine"
      ].includes(command)) {
        const safety = paperSubmitConfiguration();
        return runAutonomousPostgresExecutionCommand({
          command,
          query,
          transaction: (operation) => withPostgresTransaction(
            scheduledContext.pool,
            scheduledContext.config,
            (client) => operation(queryAdapter(client) as never)
          ),
          marketOpen: async () => Boolean((await getAlpacaMarketClock()).isOpen),
          captureBrokerSnapshot: capturePostgresAuthorityBrokerSnapshot,
          submitOrder: submitPaperOrder,
          fence: scheduledContext.fence,
          safety: {
            environment: safety.environment,
            tradingMode: safety.tradingMode,
            liveTradingEnabled: safety.liveTradingEnabled,
            paperOrderExecutionEnabled: safety.paperOrderExecutionEnabled,
            paperOptionsExecutionEnabled: safety.paperOptionsExecutionEnabled,
            quoteMaxAgeSeconds: safety.quoteMaxAgeSeconds
          },
          confirmPaper: context.input.confirmPaper,
          expectedPayloadSignature: context.input.expectedPayloadSignature
        });
      }
      throw new ControlRouteError(
        "POSTGRES_COMMAND_UNSUPPORTED",
        503,
        `PostgreSQL command ${command} is not supported by the dashboard bridge.`
      );
    }
  });
};

const blockedResult = (code: string) => ({
  paperOnly: true,
  environment: "paper",
  liveTradingEnabled: false,
  status: "blocked",
  code,
  blockers: [code],
  mutationAttempted: false
});

const actionHandlers: Record<string, ActionConfig> = {
  "/api/v1/health": {
    method: "GET",
    requireAdminToken: false,
    action: "health",
    handler: async () => {
      const worker = dependencies().workerHealth
        ? await dependencies().workerHealth!()
        : await readPostgresWorkerHealth(queryFor());
      return {
        paperOnly: true,
        environment: "paper",
        liveTradingEnabled: false,
        authority: await authorityStatus(),
        dashboardControl: "ready",
        autonomousWorker: worker.status,
        worker
      };
    }
  },
  "/api/v1/postgres-authority/status": {
    method: "GET",
    requireAdminToken: false,
    action: "postgres-authority.status",
    handler: async () => authorityStatus()
  },
  "/api/v1/account": {
    method: "GET",
    requireAdminToken: false,
    action: "account",
    handler: async () => {
      await authorityStatus();
      return dependencies().account();
    }
  },
  "/api/v1/positions": {
    method: "GET",
    requireAdminToken: false,
    action: "positions",
    handler: async () => {
      await authorityStatus();
      return dependencies().positions();
    }
  },
  "/api/v1/orders": {
    method: "GET",
    requireAdminToken: false,
    action: "orders.open",
    handler: async () => {
      await authorityStatus();
      return dependencies().openOrders();
    }
  },
  "/api/v1/summary": {
    method: "GET",
    requireAdminToken: false,
    action: "summary",
    handler: async () => readCurrentSummary()
  },
  "/api/v1/research/latest": {
    method: "GET",
    requireAdminToken: false,
    action: "research.latest",
    handler: async () => {
      await authorityStatus();
      return (dependencies().dashboardData
        ? (await dependencies().dashboardData!(10)).latestResearch
        : (await readPostgresDashboardData(queryFor(), 10)).latestResearch);
    }
  },
  "/api/v1/review/latest": {
    method: "GET",
    requireAdminToken: false,
    action: "review.latest",
    handler: async () => {
      await authorityStatus();
      return (dependencies().dashboardData
        ? (await dependencies().dashboardData!(10)).reviews
        : (await readPostgresDashboardData(queryFor(), 10)).reviews);
    }
  },
  "/api/v1/plan/latest": {
    method: "GET",
    requireAdminToken: false,
    action: "plan.latest",
    handler: async () => {
      await authorityStatus();
      return (dependencies().dashboardData
        ? (await dependencies().dashboardData!(25)).latestPaperPlans
        : (await readPostgresDashboardData(queryFor(), 25)).latestPaperPlans);
    }
  },
  "/api/v1/executions": {
    method: "GET",
    requireAdminToken: false,
    action: "executions",
    handler: async () => {
      await authorityStatus();
      return (dependencies().dashboardData
        ? (await dependencies().dashboardData!(100)).executions
        : (await readPostgresDashboardData(queryFor(), 100)).executions);
    }
  },
  "/api/v1/execute/dry-run/latest": {
    method: "GET",
    requireAdminToken: false,
    action: "execute.dry-run.latest",
    handler: async () => readDryRun()
  },
  "/api/v1/zero-dte/summary": {
    method: "GET",
    requireAdminToken: false,
    action: "zero-dte.summary",
    handler: async () => {
      await authorityStatus();
      return dependencies().zeroDteSummary
        ? dependencies().zeroDteSummary!(25)
        : readPostgresZeroDteDashboardSummary({ query: queryFor(), limit: 25 });
    }
  },
  "/api/v1/hedge/recommendation": {
    method: "GET",
    requireAdminToken: false,
    action: "hedge.recommendation",
    handler: async () => blockedResult("NO_POSTGRES_HEDGE_STATE")
  },
  "/api/v1/hedge/risk": {
    method: "GET",
    requireAdminToken: false,
    action: "hedge.risk",
    handler: async () => blockedResult("NO_POSTGRES_HEDGE_STATE")
  },
  "/api/v1/hedge/regime": {
    method: "GET",
    requireAdminToken: false,
    action: "hedge.regime",
    handler: async () => blockedResult("NO_POSTGRES_HEDGE_STATE")
  },
  "/api/v1/hedge/execution": {
    method: "GET",
    requireAdminToken: false,
    action: "hedge.execution",
    handler: async () => blockedResult("NO_POSTGRES_HEDGE_STATE")
  },
  "/api/v1/hedge/learning": {
    method: "GET",
    requireAdminToken: false,
    action: "hedge.learning",
    handler: async () => blockedResult("NO_POSTGRES_HEDGE_STATE")
  },
  "/api/v1/actions/history": {
    method: "GET",
    requireAdminToken: false,
    action: "paper.actions.history",
    handler: async () => {
      await authorityStatus();
      const data = dependencies().dashboardData
        ? await dependencies().dashboardData!(25)
        : await readPostgresDashboardData(queryFor(), 25);
      return {
        paperOnly: true,
        status: "completed",
        operations: data.executions,
        reviewReadiness: data.reviews[0] ?? null
      };
    }
  }
};

const addPostRoute = (
  path: string,
  action: string,
  handler: Handler
) => {
  actionHandlers[path] = {
    method: "POST",
    requireAdminToken: true,
    action,
    handler
  };
};

const runReviewRoute = (command: string): Handler => async (context) => {
  assertPaperRuntime();
  await authorityStatus();
  return runScheduledCommand(command, context);
};

const runExecutionRoute = (command: string): Handler => async (context) => {
  assertPaperRuntime();
  await authorityStatus();
  if (!context.input.confirmPaper) return blockedResult("PAPER_CONFIRMATION_REQUIRED");
  return runScheduledCommand(command, context);
};

addPostRoute("/api/v1/actions/research/run", "paper.actions.research.run", runReviewRoute("research:daily"));
addPostRoute("/api/v1/research/run", "research.run", runReviewRoute("research:daily"));
addPostRoute("/api/v1/actions/learn/run", "paper.actions.learn.run", runReviewRoute("paper:learn"));
addPostRoute("/api/v1/actions/portfolio/review", "paper.actions.portfolio.review", runReviewRoute("paper:portfolio:review"));
addPostRoute("/api/v1/actions/options/discover", "paper.actions.options.discover", runReviewRoute("paper:options:discover"));
addPostRoute("/api/v1/actions/review", "paper.actions.review", runReviewRoute("paper:ops:review"));
addPostRoute("/api/v1/review/run", "review.run", runReviewRoute("paper:review"));
addPostRoute("/api/v1/plan/run", "plan.run", runReviewRoute("paper:review"));
addPostRoute("/api/v1/actions/execute", "paper.actions.execute", runExecutionRoute("paper:execute:reviewed"));
addPostRoute("/api/v1/execute/confirm", "execute.confirm", runExecutionRoute("paper:execute:reviewed"));
addPostRoute("/api/v1/execute/dry-run", "execute.dry-run", async () => readDryRun());
addPostRoute("/api/v1/refresh", "refresh", async () => {
  assertPaperRuntime();
  return readCurrentSummary();
});
addPostRoute("/api/v1/hedge/review", "hedge.review", runReviewRoute("hedge:review"));
addPostRoute("/api/v1/hedge/exit/review", "hedge.exit.review", runReviewRoute("hedge:exit:review"));
addPostRoute("/api/v1/hedge/exit/execute", "hedge.exit.execute", runExecutionRoute("hedge:exit:execute"));
addPostRoute("/api/v1/hedge/execute", "hedge.execute", async () => blockedResult("POSTGRES_HEDGE_ENTRY_EXECUTION_UNSUPPORTED"));

export const ACTION_HANDLERS = actionHandlers;

const auditPath = () =>
  process.env.VPS_CONTROL_AUDIT_PATH?.trim() ||
  process.env.DASHBOARD_CONTROL_LOG_PATH?.trim() ||
  "./logs/dashboard-control-audit.jsonl";

const audit = (payload: Record<string, unknown>) => {
  try {
    const path = auditPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(redactSensitiveData(payload))}\n`, { mode: 0o600 });
  } catch {
    // Audit-file failures must not expose secrets or change route responses.
  }
};

const authorize = (request: IncomingMessage) => {
  const configured = process.env.VPS_CONTROL_TOKEN?.trim() || "";
  const authorization = request.headers.authorization || "";
  const supplied = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : String(request.headers["x-dashboard-bridge-token"] || "");
  return Boolean(configured && supplied && safeTokenEquals(configured, supplied));
};

const correlationId = (request: IncomingMessage) =>
  String(request.headers["x-correlation-id"] || "").trim().slice(0, 128) || randomUUID();

const respond = (response: ServerResponse, status: number, payload: unknown) => {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(redactSensitiveData(payload)));
};

const requestListener = async (request: IncomingMessage, response: ServerResponse) => {
  const startedAt = Date.now();
  const requestId = randomUUID();
  const requestCorrelationId = correlationId(request);
  const url = new URL(request.url || "/", `http://localhost:${CONTROL_PORT}`);
  const path = url.pathname.replace(/\/$/, "");
  const route = actionHandlers[path];
  if (!route) {
    respond(response, 404, {
      ok: false,
      requestId,
      error: { code: "CONTROL_ROUTE_NOT_FOUND", message: "Unknown control action." }
    });
    return;
  }
  if ((request.method || "").toUpperCase() !== route.method) {
    respond(response, 405, {
      ok: false,
      requestId,
      error: { code: "CONTROL_METHOD_NOT_ALLOWED", message: "Method not allowed." }
    });
    return;
  }
  try {
    if (route.requireAdminToken && !authorize(request)) {
      throw new ControlRouteError("CONTROL_TOKEN_INVALID", 401, "Missing or invalid control token.");
    }
    const input = request.method === "POST" ? normalizeInput(await readBody(request)) : normalizeInput({});
    const data = await route.handler({ input, requestId, correlationId: requestCorrelationId });
    const dataStatus = data && typeof data === "object" && !Array.isArray(data) &&
      typeof (data as Record<string, unknown>).status === "string"
      ? String((data as Record<string, unknown>).status)
      : "success";
    respond(response, 200, {
      ok: true,
      status: dataStatus,
      action: route.action,
      requestId,
      correlationId: requestCorrelationId,
      data
    });
    audit({
      timestamp: new Date().toISOString(),
      action: route.action,
      method: route.method,
      requestId,
      correlationId: requestCorrelationId,
      status: "success",
      durationMs: Date.now() - startedAt
    });
  } catch (error) {
    const code = error instanceof ControlRouteError
      ? error.code
      : typeof (error as { code?: unknown })?.code === "string"
        ? String((error as { code: string }).code)
        : "POSTGRES_AUTHORITY_UNAVAILABLE";
    const status = error instanceof ControlRouteError
      ? error.status
      : code === "CONTROL_TOKEN_INVALID"
        ? 401
        : 503;
    const message = redactSensitiveText(
      error instanceof Error ? error.message : "PostgreSQL authority is unavailable."
    );
    respond(response, status, {
      ok: false,
      action: route.action,
      requestId,
      correlationId: requestCorrelationId,
      error: { code, message }
    });
    audit({
      timestamp: new Date().toISOString(),
      action: route.action,
      method: route.method,
      requestId,
      correlationId: requestCorrelationId,
      status: "error",
      durationMs: Date.now() - startedAt,
      error: message
    });
  }
};

export const createControlServer = () => createServer(requestListener);

const server = createControlServer();

export const closeControlServer = async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (pool) {
    await pool.end();
    pool = null;
  }
};

const start = async () => {
  await defaultDependencies().authorityStatus();
  server.listen(CONTROL_PORT, CONTROL_HOST, () => {
    process.stdout.write(`Dashboard control API listening on ${CONTROL_HOST}:${CONTROL_PORT}\n`);
  });
};

if (process.env.DASHBOARD_CONTROL_NO_START !== "1") {
  void start().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      event: "dashboard_control_start_failed",
      code: "POSTGRES_AUTHORITY_UNAVAILABLE",
      message: redactSensitiveText(error instanceof Error ? error.message : "Startup failed.")
    })}\n`);
    process.exitCode = 1;
  });
}
