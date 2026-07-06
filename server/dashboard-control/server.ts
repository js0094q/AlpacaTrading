import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage } from "node:http";
import { spawn } from "node:child_process";

import {
  buildDashboardSnapshot,
  latestPaperExecutions,
  latestPaperPlans,
  latestResearchRuns,
  runPaperReview
} from "../../apps/dashboard/lib/data.js";
import { getAlpacaAccountSnapshot } from "../../src/services/alpacaAccountService.js";
import { listAlpacaOpenOrders } from "../../src/services/alpacaOrderReadService.js";
import { listAlpacaPositions } from "../../src/services/alpacaPositionService.js";

type RiskProfile = "moderate" | "aggressive" | "conservative";
type AssetClass = "all" | "equity" | "option";

type ControlInput = {
  riskProfile: RiskProfile;
  optionsEnabled: boolean;
  maxCandidates: number;
  assetClass: AssetClass;
};

type Envelope = {
  ok: true;
  action: string;
  requestId: string;
  data: unknown;
  params?: Record<string, unknown>;
  correlationId?: string;
};

type ErrorEnvelope = {
  ok: false;
  action: string;
  requestId: string;
  correlationId?: string;
  error: {
    code: string;
    message: string;
  };
  guard?: EnvironmentGuardState;
};

type AuditEntry = {
  timestamp: string;
  action: string;
  method: string;
  requestId: string;
  correlationId: string;
  params: Record<string, unknown>;
  status: "success" | "error";
  durationMs: number;
  resultSummary: string;
  error?: string;
};

type ActionHandler = (input: ControlInput, requestId: string) => Promise<unknown>;

type ActionConfig = {
  method: "GET" | "POST";
  timeoutMs: number;
  requireAdminToken: boolean;
  requireMutationPrecheck: boolean;
  action: string;
  handler: ActionHandler;
};

type CommandRunner = (
  script: string,
  args: string[],
  timeoutMs: number,
  requestId: string,
  action: string,
  options?: {
    env?: Record<string, string>;
  }
) => Promise<unknown>;

type OpenOrdersFetcher = () => Promise<unknown>;

type EnvironmentGuardState = {
  paperOnly: boolean;
  liveTradingEnabled: boolean;
  mutationAllowed: boolean;
  paperOrderExecutionEnabled: boolean;
  paperOptionsExecutionEnabled: boolean;
};

const getControlToken = () => process.env.VPS_CONTROL_TOKEN?.trim() || "";
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
const getLogPath = () =>
  process.env.VPS_CONTROL_AUDIT_PATH?.trim() ||
  process.env.DASHBOARD_CONTROL_LOG_PATH?.trim() ||
  "./logs/dashboard-control-audit.jsonl";

const TIMEOUT_DEFAULT_MS = 10_000;

const killProcessTree = (child: ReturnType<typeof spawn>) => {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to killing the direct child below.
    }
  }
  child.kill("SIGKILL");
};

const runCommandViaSpawn = (
  script: string,
  args: string[],
  timeoutMs: number,
  requestId: string,
  action: string,
  options: {
    env?: Record<string, string>;
  } = {}
): Promise<unknown> => {
  return new Promise((resolve, reject) => {
    let output = "";
    let errored = "";
    const started = Date.now();
    const child = spawn("npm", ["--silent", "run", script, "--", ...args], {
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        ...(options.env || {})
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const timeout = setTimeout(() => {
      killProcessTree(child);
      reject(new Error(`Command timed out after ${timeoutMs}ms (${action}).`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      errored += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const durationMs = Date.now() - started;

      if (signal === "SIGKILL") {
        reject(new Error(`Command terminated by timeout ${timeoutMs}ms`));
        return;
      }

      if (code !== 0) {
        const err = (errored || output || "Command execution failed").trim();
        reject(new Error(`${action} command failed (exit ${code}): ${err}`));
        return;
      }

      const trimmed = output.trim();
      if (!trimmed) {
        resolve({ _controlDurationMs: durationMs, _controlRequestId: requestId });
        return;
      }

      try {
        const parsed = JSON.parse(trimmed);
        resolve({
          ...parsed,
          _controlDurationMs: durationMs,
          _controlRequestId: requestId
        });
      } catch {
        resolve({ value: trimmed, _controlDurationMs: durationMs, _controlRequestId: requestId });
      }
    });
  });
};

let commandRunner: CommandRunner = runCommandViaSpawn;
let openOrdersFetcher: OpenOrdersFetcher = listAlpacaOpenOrders;

export const setControlCommandRunner = (runner: CommandRunner | null) => {
  commandRunner = runner || runCommandViaSpawn;
};

export const setOpenOrdersFetcher = (fetcher: OpenOrdersFetcher | null) => {
  openOrdersFetcher = fetcher || listAlpacaOpenOrders;
};

export const resetControlTestHooks = () => {
  commandRunner = runCommandViaSpawn;
  openOrdersFetcher = listAlpacaOpenOrders;
};

const command = (
  script: string,
  args: string[],
  timeoutMs: number,
  requestId: string,
  action: string,
  options?: {
    env?: Record<string, string>;
  }
) => commandRunner(script, args, timeoutMs, requestId, action, options);

const researchRunEnv = () => ({
  ALPACA_REQUEST_TIMEOUT_MS:
    process.env.VPS_RESEARCH_REQUEST_TIMEOUT_MS?.trim() || "10000",
  ALPACA_MAX_RETRIES:
    process.env.VPS_RESEARCH_MAX_RETRIES?.trim() || "0"
});

const safeInteger = (value: unknown, fallback: number, min = 1, max = 50) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const parsed = Math.floor(value);
  return Math.min(max, Math.max(min, parsed));
};

const normalizeBoolean = (value: unknown, fallback = false) => {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return typeof value === "boolean" ? value : fallback;
};

const parseEnvBoolean = (name: string) =>
  process.env[name] === "true" || process.env[name] === "1";

const buildEnvironmentGuardState = (payload?: Record<string, unknown>): EnvironmentGuardState => {
  const liveTradingEnabled =
    payload?.liveTradingEnabled === true ||
    parseEnvBoolean("LIVE_TRADING_ENABLED") ||
    parseEnvBoolean("ALPACA_LIVE_TRADE");
  const alpacaEnv = String(process.env.ALPACA_ENV || "paper").toLowerCase();

  return {
    paperOnly:
      payload && "paperOnly" in payload
        ? payload.paperOnly === true
        : alpacaEnv === "paper" && !liveTradingEnabled,
    liveTradingEnabled,
    mutationAllowed: payload?.mutationAllowed === true,
    paperOrderExecutionEnabled: parseEnvBoolean("PAPER_ORDER_EXECUTION_ENABLED"),
    paperOptionsExecutionEnabled: parseEnvBoolean("PAPER_OPTIONS_EXECUTION_ENABLED")
  };
};

class EnvironmentGuardError extends Error {
  code: string;
  status: number;
  guard: EnvironmentGuardState;

  constructor(code: string, message: string, guard: EnvironmentGuardState, status = 403) {
    super(message);
    this.name = "EnvironmentGuardError";
    this.code = code;
    this.status = status;
    this.guard = guard;
  }
}

const parseAssetClass = (value: unknown): AssetClass => {
  return value === "equity" || value === "option" ? value : "all";
};

const normalizeRiskProfile = (value: unknown): RiskProfile => {
  return value === "moderate" || value === "conservative" ? value : "aggressive";
};

const parseInput = (raw: unknown): ControlInput => {
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    riskProfile: normalizeRiskProfile(body.riskProfile),
    optionsEnabled: normalizeBoolean(body.optionsEnabled, true),
    maxCandidates: safeInteger(body.maxCandidates, 10),
    assetClass: parseAssetClass(body.assetClass)
  };
};

const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const chunkSize = Buffer.from(chunk).byteLength;
    totalBytes += chunkSize;
    if (totalBytes > 100_000) {
      throw new Error("Request body too large.");
    }
    chunks.push(Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON body.");
  }
};

const summarize = (value: unknown) => {
  if (Array.isArray(value)) {
    return `array:${value.length}`;
  }
  if (value && typeof value === "object") {
    if ("status" in value && typeof value.status === "string") {
      return `status:${String(value.status)}`;
    }
    if ("plan" in value && Array.isArray((value as { plan?: unknown }).plan)) {
      return `plan:${(value as { plan: unknown[] }).plan.length}`;
    }
    if ("review" in value && "planSummary" in value) {
      return "review:present";
    }
  }
  return "result";
};

const authorize = (request: IncomingMessage) => {
  const token = request.headers.authorization;
  if (typeof token !== "string") {
    return false;
  }
  if (!token.toLowerCase().startsWith("bearer ")) {
    return false;
  }
  const presented = token.slice(7).trim();
  const configured = getControlToken();
  return Boolean(configured && presented && presented === configured);
};

const requestIdFromRequest = (request: IncomingMessage) =>
  String(
    Array.isArray(request.headers["x-correlation-id"])
      ? request.headers["x-correlation-id"][0] ?? randomUUID()
      : request.headers["x-correlation-id"] || request.headers["x-request-id"] || randomUUID()
  );

const logEntry = (entry: AuditEntry) => {
  try {
    const logPath = getLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  } catch {
    // Logging is best-effort only.
  }
};

const wrapSuccess = (
  action: string,
  requestId: string,
  correlationId: string,
  data: unknown,
  params: Record<string, unknown>
): Envelope => ({
  ok: true,
  action,
  requestId,
  correlationId,
  data,
  params
});

const wrapError = (action: string, requestId: string, code: string, message: string): ErrorEnvelope => ({
  ok: false,
  action,
  requestId,
  error: {
    code,
    message
  }
});

const wrapRouteError = (
  action: string,
  requestId: string,
  correlationId: string,
  code: string,
  message: string,
  guard?: EnvironmentGuardState
): ErrorEnvelope => ({
  ok: false,
  action,
  requestId,
  correlationId,
  error: {
    code,
    message
  },
  ...(guard ? { guard } : {})
});

type MutabilityRequirement = {
  requireAggressiveMode?: boolean;
  requireOptionsExecution?: boolean;
};

const verifyPaperMutability = async (requirements: MutabilityRequirement = {}) => {
  const health = await command(
    "alpaca:health",
    ["--format=json"],
    TIMEOUT_DEFAULT_MS,
    randomUUID(),
    "health"
  );
  if (!health || typeof health !== "object") {
    throw new Error("Health check output was not parseable JSON.");
  }

  const payload = health as Record<string, unknown>;
  const guard = buildEnvironmentGuardState(payload);
  if (payload.paperOnly !== true) {
    throw new EnvironmentGuardError(
      "PAPER_ENV_REQUIRED",
      "Blocked by safety guard: paper-only mode is required.",
      guard
    );
  }
  if (payload.liveTradingEnabled) {
    throw new EnvironmentGuardError(
      "LIVE_TRADING_MUST_BE_DISABLED",
      "Blocked by safety guard: live trading is enabled in the current environment.",
      guard
    );
  }
  if (payload.mutationAllowed !== false) {
    throw new EnvironmentGuardError(
      "MUTATION_GUARD_STATE_INVALID",
      "Blocked by safety guard: mutation guard state is invalid for paper-only operation.",
      guard
    );
  }
  if (payload.accountStatus !== "ACTIVE") {
    throw new EnvironmentGuardError(
      "PAPER_ACCOUNT_NOT_ACTIVE",
      `Blocked by safety guard: paper account status ${String(payload.accountStatus || "unknown")} blocks operation.`,
      guard
    );
  }

  if (requirements.requireAggressiveMode && process.env.ENABLE_AGGRESSIVE_PAPER_STRATEGIES !== "true") {
    throw new EnvironmentGuardError(
      "AGGRESSIVE_PAPER_MODE_DISABLED",
      "Blocked by safety guard: aggressive paper mode is disabled.",
      guard
    );
  }

  if (requirements.requireOptionsExecution && process.env.PAPER_OPTIONS_EXECUTION_ENABLED !== "true") {
    throw new EnvironmentGuardError(
      "PAPER_OPTIONS_EXECUTION_DISABLED",
      "Blocked by safety guard: paper options execution is disabled.",
      guard
    );
  }
};

const executeConfirmHandler = async (_input: ControlInput, requestId: string) => {
  if (_input.riskProfile !== "aggressive") {
    throw new Error("execute.confirm requires aggressive risk profile.");
  }

  if (!_input.optionsEnabled) {
    throw new Error("execute.confirm requires optionsEnabled=true.");
  }

  if (_input.assetClass !== "all") {
    throw new Error("execute.confirm supports assetClass=all only.");
  }

  if (process.env.PAPER_ORDER_EXECUTION_ENABLED !== "true") {
    throw new EnvironmentGuardError(
      "PAPER_ORDER_EXECUTION_DISABLED",
      "Blocked by safety guard: paper order execution is disabled.",
      buildEnvironmentGuardState()
    );
  }

  await verifyPaperMutability({
    requireAggressiveMode: true,
    requireOptionsExecution: true
  });

  await openOrdersFetcher();
  return command(
    "paper:execute",
    [
      "--confirmPaper",
      "--riskProfile=aggressive",
      "--optionsEnabled=true",
      "--maxCandidates=10",
      "--assetClass=all",
      "--format=json"
    ],
    120_000,
    requestId,
    "execute.confirm"
  );
};

const executeDryRunHandler = (input: ControlInput, requestId: string) =>
  command(
    "paper:execute",
    [
      "--dryRun",
      `--riskProfile=${input.riskProfile}`,
      `--optionsEnabled=${String(input.optionsEnabled)}`,
      `--maxCandidates=${input.maxCandidates}`,
      `--assetClass=${input.assetClass}`,
      "--format=json"
    ],
    120_000,
    requestId,
    "execute.dry-run"
  );

const actionHandlers: Record<string, ActionConfig> = {
  "/api/v1/health": {
    method: "GET",
    timeoutMs: 10_000,
    requireAdminToken: false,
    requireMutationPrecheck: false,
    action: "health",
    handler: async (_input, requestId) =>
      command("alpaca:health", ["--format=json"], 10_000, requestId, "health")
  },
  "/api/v1/account": {
    method: "GET",
    timeoutMs: 30_000,
    requireAdminToken: false,
    requireMutationPrecheck: false,
    action: "account",
    handler: async (_input, requestId) =>
      getAlpacaAccountSnapshot().then((snapshot) => ({
        paperOnly: true,
        environment: "paper",
        ...snapshot,
        _controlRequestId: requestId
      }))
  },
  "/api/v1/positions": {
    method: "GET",
    timeoutMs: 30_000,
    requireAdminToken: false,
    requireMutationPrecheck: false,
    action: "positions",
    handler: async () => listAlpacaPositions()
  },
  "/api/v1/orders": {
    method: "GET",
    timeoutMs: 30_000,
    requireAdminToken: false,
    requireMutationPrecheck: false,
    action: "orders",
    handler: async () => listAlpacaOpenOrders()
  },
  "/api/v1/research/latest": {
    method: "GET",
    timeoutMs: 30_000,
    requireAdminToken: false,
    requireMutationPrecheck: false,
    action: "research.latest",
    handler: async () => latestResearchRuns(10)
  },
  "/api/v1/review/latest": {
    method: "GET",
    timeoutMs: 60_000,
    requireAdminToken: false,
    requireMutationPrecheck: false,
    action: "review.latest",
    handler: async (input) => runPaperReview(input)
  },
  "/api/v1/plan/latest": {
    method: "GET",
    timeoutMs: 30_000,
    requireAdminToken: false,
    requireMutationPrecheck: false,
    action: "plan.latest",
    handler: async () => latestPaperPlans(25)
  },
  "/api/v1/executions": {
    method: "GET",
    timeoutMs: 30_000,
    requireAdminToken: false,
    requireMutationPrecheck: false,
    action: "executions",
    handler: async () => latestPaperExecutions(100)
  },
  "/api/v1/research/run": {
    method: "POST",
    timeoutMs: 420_000,
    requireAdminToken: true,
    requireMutationPrecheck: true,
    action: "research.run",
    handler: async (input, requestId) =>
      command(
        "research:daily",
        [
          `--riskProfile=${input.riskProfile}`,
          `--optionsEnabled=${String(input.optionsEnabled)}`,
          `--maxCandidates=${input.maxCandidates}`,
          "--useAlpacaAssets=true",
          "--barLookbackDays=120",
          "--format=json"
        ],
        420_000,
        requestId,
        "research.run",
        {
          env: researchRunEnv()
        }
      )
  },
  "/api/v1/review/run": {
    method: "POST",
    timeoutMs: 60_000,
    requireAdminToken: true,
    requireMutationPrecheck: true,
    action: "review.run",
    handler: async (input, requestId) =>
      command(
        "paper:review",
        [
          `--riskProfile=${input.riskProfile}`,
          `--optionsEnabled=${String(input.optionsEnabled)}`,
          `--maxCandidates=${input.maxCandidates}`,
          "--format=json"
        ],
        60_000,
        requestId,
        "review.run"
      )
  },
  "/api/v1/plan/run": {
    method: "POST",
    timeoutMs: 60_000,
    requireAdminToken: true,
    requireMutationPrecheck: true,
    action: "plan.run",
    handler: async (input, requestId) =>
      command(
        "paper:plan",
        [
          `--riskProfile=${input.riskProfile}`,
          `--optionsEnabled=${String(input.optionsEnabled)}`,
          `--maxCandidates=${input.maxCandidates}`,
          "--format=json"
        ],
        60_000,
        requestId,
        "plan.run"
      )
  },
  "/api/v1/execute/dry-run": {
    method: "POST",
    timeoutMs: 120_000,
    requireAdminToken: true,
    requireMutationPrecheck: false,
    action: "execute.dry-run",
    handler: executeDryRunHandler
  },
  "/api/v1/execute/dry-run/latest": {
    method: "GET",
    timeoutMs: 120_000,
    requireAdminToken: false,
    requireMutationPrecheck: false,
    action: "execute.dry-run.latest",
    handler: executeDryRunHandler
  },
  "/api/v1/execute/confirm": {
    method: "POST",
    timeoutMs: 120_000,
    requireAdminToken: true,
    requireMutationPrecheck: false,
    action: "execute.confirm",
    handler: executeConfirmHandler
  },
  "/api/v1/summary": {
    method: "GET",
    timeoutMs: 30_000,
    requireAdminToken: false,
    requireMutationPrecheck: false,
    action: "summary",
    handler: async () => buildDashboardSnapshot()
  },
  "/api/v1/refresh": {
    method: "POST",
    timeoutMs: 60_000,
    requireAdminToken: true,
    requireMutationPrecheck: false,
    action: "refresh",
    handler: async (input, requestId) =>
      command(
        "paper:runtime",
        [
          `--riskProfile=${input.riskProfile}`,
          `--optionsEnabled=${String(input.optionsEnabled)}`,
          `--maxCandidates=${input.maxCandidates}`,
          "--format=json"
        ],
        60_000,
        requestId,
        "refresh"
      )
  }
};

export const ACTION_HANDLERS = actionHandlers;

const parseError = (error: unknown) =>
  error instanceof Error ? error.message : String(error || "Control request failed.");

const classifyErrorCode = (message: string) =>
  message.includes("token")
    ? "CONTROL_TOKEN_INVALID"
    : message.includes("timeout")
      ? "CONTROL_ACTION_TIMEOUT"
      : message.includes("not parse")
        ? "CONTROL_INPUT_INVALID"
        : "CONTROL_ACTION_ERROR";

const routeErrorCode = (error: unknown, message: string) =>
  error instanceof EnvironmentGuardError ? error.code : classifyErrorCode(message);

const routeErrorStatus = (error: unknown, code: string) =>
  error instanceof EnvironmentGuardError
    ? error.status
    : code === "CONTROL_TOKEN_INVALID"
      ? 401
      : 500;

const routeHandler = async (request: IncomingMessage, response: any, config: ActionConfig) => {
  const startMs = Date.now();
  const correlationId = requestIdFromRequest(request);
  const requestId = randomUUID();

  try {
    if (config.requireAdminToken && !authorize(request)) {
      throw new Error("Missing or invalid control token.");
    }

    if (config.requireMutationPrecheck) {
      await verifyPaperMutability();
    }

    const body = request.method === "POST" ? await readBody(request) : {};
    const input = parseInput(body);
    const data = await config.handler(input, requestId);
    const payload = wrapSuccess(
      config.action,
      requestId,
      correlationId,
      data,
      {
        riskProfile: input.riskProfile,
        optionsEnabled: input.optionsEnabled,
        maxCandidates: input.maxCandidates,
        assetClass: input.assetClass
      }
    );

    const durationMs = Date.now() - startMs;
    logEntry({
      timestamp: new Date().toISOString(),
      action: config.action,
      method: request.method || "GET",
      requestId,
      correlationId,
      params: payload.params || {},
      status: "success",
      durationMs,
      resultSummary: summarize(data)
    });

    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    response.end(JSON.stringify(payload));
  } catch (error) {
    const message = parseError(error);
    const code = routeErrorCode(error, message);
    const status = routeErrorStatus(error, code);
    const payload = wrapRouteError(
      config.action,
      requestId,
      correlationId,
      code,
      message,
      error instanceof EnvironmentGuardError ? error.guard : undefined
    );
    const durationMs = Date.now() - startMs;

    logEntry({
      timestamp: new Date().toISOString(),
      action: config.action,
      method: request.method || "GET",
      requestId: payload.requestId,
      correlationId,
      params: {
        path: request.url || "",
        method: request.method || "GET"
      },
      status: "error",
      durationMs,
      resultSummary: "error",
      error: message
    });

    response.statusCode = status;
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    response.end(JSON.stringify(payload));
  }
};

const requestListener = async (request: IncomingMessage, response: any) => {
  try {
    const url = new URL(request.url || "/", `http://localhost:${CONTROL_PORT}`);
    const routePath = url.pathname.replace(/\/$/, "");
    const config = actionHandlers[routePath];
    if (!config) {
      response.statusCode = 404;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          wrapError("unknown", randomUUID(), "CONTROL_ROUTE_NOT_FOUND", "Unknown control action.")
        )
      );
      return;
    }

    if ((request.method || "").toUpperCase() !== config.method) {
      response.statusCode = 405;
      response.setHeader("allow", config.method);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          wrapError(
            "unknown",
            randomUUID(),
            "CONTROL_METHOD_NOT_ALLOWED",
            "Method not allowed for this endpoint."
          )
        )
      );
      return;
    }

    await routeHandler(request, response, config);
  } catch (error) {
    response.statusCode = 500;
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    response.end(
      JSON.stringify(
        wrapError(
          "unknown",
          randomUUID(),
          "CONTROL_ROUTE_HANDLER_ERROR",
          error instanceof Error ? error.message : "Request handler failed."
        )
      )
    );
  }
};

export const createControlServer = () => createServer(requestListener);

const server = createControlServer();

export const closeControlServer = () =>
  new Promise((resolve) => {
    server.close(() => resolve(undefined));
  });

if (process.env.DASHBOARD_CONTROL_NO_START !== "1") {
  server.listen(CONTROL_PORT, CONTROL_HOST, () => {
    console.log(`Dashboard control API listening on ${CONTROL_HOST}:${CONTROL_PORT}`);
  });
}
