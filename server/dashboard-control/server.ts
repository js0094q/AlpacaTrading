import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Pool } from "pg";

import { loadDatabaseConfig } from "../../src/lib/database/config.js";
import { createPostgresPool } from "../../src/lib/database/postgres.js";
import { assertPostgresOnlyDatabaseAuthority } from "../../src/lib/database/postgresOnlyRuntime.js";
import { safeTokenEquals } from "../../src/lib/safeToken.js";
import { redactSensitiveData, redactSensitiveText } from "../../src/lib/securityRedaction.js";
import { getAlpacaAccountSnapshot } from "../../src/services/alpacaAccountService.js";
import { listAlpacaOpenOrders } from "../../src/services/alpacaOrderReadService.js";
import { listAlpacaPositions } from "../../src/services/alpacaPositionService.js";
import { readPostgresAuthorityStatus } from "../../src/services/postgresAuthorityCutoverService.js";

type Handler = () => Promise<unknown>;

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

let pool: Pool | null = null;
let testDependencies: ControlDependencies | null = null;

const postgresPool = () => {
  if (pool) return pool;
  const config = loadDatabaseConfig(process.env, { purpose: "application" });
  assertPostgresOnlyDatabaseAuthority(config);
  pool = createPostgresPool(config, "pooled");
  return pool;
};

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
  openOrders: listAlpacaOpenOrders
});

const dependencies = () => testDependencies ?? defaultDependencies();

export const setControlDependenciesForTests = (
  value: ControlDependencies | null
) => {
  testDependencies = value;
};

const authorityStatus = async () => dependencies().authorityStatus();

const currentSummary = async () => {
  const runtime = dependencies();
  const [authority, account, positions, openOrders] = await Promise.all([
    runtime.authorityStatus(),
    runtime.account(),
    runtime.positions(),
    runtime.openOrders()
  ]);
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
    runtime: { ok: false, label: "runtime", error: "EVIDENCE_UTILIZATION_RUNTIME_AUDIT_REQUIRED" },
    plan: { ok: false, label: "plan", error: "POSTGRES_ONLY_RUNTIME_PATH_DISABLED" },
    review: { ok: false, label: "review", error: "POSTGRES_ONLY_RUNTIME_PATH_DISABLED" },
    dryRun: { ok: false, label: "dryRun", error: "POSTGRES_ONLY_RUNTIME_PATH_DISABLED" },
    latestResearch: [],
    latestPaperPlans: [],
    snapshots: [],
    executions: [],
    learningSummary: { ok: false, label: "learningSummary", error: "POSTGRES_ONLY_RUNTIME_PATH_DISABLED" },
    promotionReadiness: [],
    optionContracts: [],
    requestIds: [],
    hedge: { ok: false, label: "hedge", error: "POSTGRES_ONLY_RUNTIME_PATH_DISABLED" }
  };
};

const disabledMutation = async () => {
  await authorityStatus();
  throw new ControlRouteError(
    "POSTGRES_ONLY_RUNTIME_PATH_DISABLED",
    503,
    "Mutation and autonomous workflows remain disabled pending the evidence-utilization and runtime audit."
  );
};

const actionHandlers: Record<string, ActionConfig> = {
  "/api/v1/health": {
    method: "GET",
    requireAdminToken: false,
    action: "health",
    handler: async () => ({
      paperOnly: true,
      environment: "paper",
      liveTradingEnabled: false,
      authority: await authorityStatus(),
      dashboardControl: "ready",
      autonomousWorker: "stopped_pending_audit"
    })
  },
  "/api/v1/postgres-authority/status": {
    method: "GET",
    requireAdminToken: false,
    action: "postgres-authority.status",
    handler: authorityStatus
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
    handler: currentSummary
  }
};

for (const path of [
  "/api/v1/actions/execute",
  "/api/v1/actions/learn/run",
  "/api/v1/actions/options/discover",
  "/api/v1/actions/portfolio/review",
  "/api/v1/actions/research/run",
  "/api/v1/actions/review",
  "/api/v1/execute/confirm",
  "/api/v1/execute/dry-run",
  "/api/v1/hedge/execute",
  "/api/v1/hedge/exit/execute",
  "/api/v1/hedge/exit/review",
  "/api/v1/hedge/review",
  "/api/v1/plan/run",
  "/api/v1/refresh",
  "/api/v1/research/run",
  "/api/v1/review/run"
]) {
  actionHandlers[path] = {
    method: "POST",
    requireAdminToken: true,
    action: "runtime.disabled",
    handler: disabledMutation
  };
}

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
    const data = await route.handler();
    respond(response, 200, {
      ok: true,
      status: "success",
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
      : "POSTGRES_AUTHORITY_UNAVAILABLE";
    const status = error instanceof ControlRouteError ? error.status : 503;
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
