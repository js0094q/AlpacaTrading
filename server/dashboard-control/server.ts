import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage } from "node:http";
import { spawn } from "node:child_process";

import {
  buildCachedDashboardSnapshot,
  latestPaperExecutions,
  latestPaperPlans,
  latestResearchRuns,
  runPaperReview
} from "../../apps/dashboard/lib/data.js";
import { getAlpacaAccountSnapshot } from "../../src/services/alpacaAccountService.js";
import { listAlpacaOpenOrders } from "../../src/services/alpacaOrderReadService.js";
import { listAlpacaPositions } from "../../src/services/alpacaPositionService.js";
import { listPaperOperations } from "../../src/services/paperOperationLogService.js";
import { latestReviewArtifactReadiness } from "../../src/services/paperOpsWorkflowService.js";
import {
  buildPersistedHedgeRiskRead,
  latestHedgeRecommendationForCurrentConfig
} from "../../src/services/hedgePersistenceService.js";
import { listPaperExecutionLedgerEntries } from "../../src/services/paperExecutionLedgerService.js";
import { evaluateHedgeLearning, listRecentHedgeLearningEvents } from "../../src/services/hedgeLearningLifecycleService.js";
import { buildZeroDteDashboardSummary } from "../../src/services/zeroDte/zeroDteEngineService.js";
import { getActiveSymbols } from "../../src/services/universeService.js";
import { alpacaStockStream } from "../../src/services/alpacaStockStream.js";
import { safeTokenEquals } from "../../src/lib/safeToken.js";
import { redactSensitiveData, redactSensitiveText } from "../../src/lib/securityRedaction.js";
import {
  RuntimePreflightError,
  assertRuntimeMutationPreflight,
  buildRuntimePreflightChecks,
  type RuntimeMutationActionType,
  type RuntimePreflightChecks
} from "../../src/services/runtimeMutationPreflight.js";
import {
  appendBoundedCommandOutput,
  COMMAND_OUTPUT_LIMIT,
  COMMAND_STREAM_OUTPUT_LIMIT,
  GuardedCommandError,
  normalizeCommandFailure,
  type GuardedCommandFailure
} from "./commandResult.js";

type RiskProfile = "moderate" | "aggressive" | "conservative";
type AssetClass = "all" | "equity" | "option";

type ControlInput = {
  riskProfile: RiskProfile;
  optionsEnabled: boolean;
  maxCandidates: number;
  assetClass: AssetClass;
  confirmPaper: boolean;
  expectedPayloadSignature?: string;
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

type Envelope = {
  ok: true;
  status: string;
  action: string;
  requestId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  summary?: unknown;
  details?: unknown;
  blockers?: unknown;
  warnings?: unknown;
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
  checks?: RuntimePreflightChecks;
  failedChecks?: string[];
  command?: GuardedCommandFailure;
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

type ActionHandler = (
  input: ControlInput,
  requestId: string,
  correlationId: string
) => Promise<unknown>;

type ControlRuntimePreflight = {
  actionType: RuntimeMutationActionType;
  confirmPaper?: boolean;
  confirmPaperFromInput?: boolean;
  requireOptionsExecution?: boolean;
};

type ActionConfig = {
  method: "GET" | "POST";
  timeoutMs: number;
  requireAdminToken: boolean;
  requireMutationPrecheck: boolean;
  requireHedgeDashboardMutations?: boolean;
  runtimePreflight?: ControlRuntimePreflight;
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
  environment: string;
  tradingMode: string;
  liveTradingEnabled: boolean;
  mutationAllowed: boolean;
  paperExecutionEnabled: boolean;
  paperOrderExecutionEnabled: boolean;
  paperOptionsExecutionEnabled: boolean;
  automatedPaperExecutionEnabled: boolean;
  liveApiBaseUrlReachableOrConfigured: boolean;
  paperApiBaseUrlConfigured: boolean;
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

export const parseControlCommandOutput = (
  output: string,
  durationMs: number,
  requestId: string
): Record<string, unknown> => {
  const trimmed = output.trim();
  if (!trimmed) {
    return { _controlDurationMs: durationMs, _controlRequestId: requestId };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        ...(parsed as Record<string, unknown>),
        _controlDurationMs: durationMs,
        _controlRequestId: requestId
      };
    }
    return {
      value: parsed,
      _controlDurationMs: durationMs,
      _controlRequestId: requestId
    };
  } catch {
    const redacted = redactSensitiveText(trimmed);
    const suffix = "...[truncated]";
    const value =
      redacted.length <= COMMAND_OUTPUT_LIMIT
        ? redacted
        : `${redacted.slice(0, COMMAND_OUTPUT_LIMIT - suffix.length)}${suffix}`;
    return { value, _controlDurationMs: durationMs, _controlRequestId: requestId };
  }
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
    let timedOut = false;
    let outputLimitExceeded: "stdout" | "stderr" | null = null;
    let settled = false;
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
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      if (outputLimitExceeded) return;
      const bounded = appendBoundedCommandOutput(output, String(chunk));
      output = bounded.value;
      if (bounded.exceeded) {
        outputLimitExceeded = "stdout";
        killProcessTree(child);
      }
    });
    child.stderr?.on("data", (chunk) => {
      if (outputLimitExceeded) return;
      const bounded = appendBoundedCommandOutput(errored, String(chunk));
      errored = bounded.value;
      if (bounded.exceeded) {
        outputLimitExceeded = "stderr";
        killProcessTree(child);
      }
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const failure = normalizeCommandFailure({
        exitCode: null,
        signal: null,
        timedOut,
        stdout: output,
        stderr: `${errored}\n${error.message}`,
        ...(outputLimitExceeded
          ? {
              errorOverride: {
                code: "COMMAND_OUTPUT_LIMIT_EXCEEDED",
                message: `Command ${outputLimitExceeded} exceeded the ${COMMAND_STREAM_OUTPUT_LIMIT}-character collection limit.`
              }
            }
          : {})
      });
      reject(new GuardedCommandError(action, failure));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const durationMs = Date.now() - started;

      if (code !== 0 || signal || timedOut || outputLimitExceeded) {
        const failure = normalizeCommandFailure({
          exitCode: code,
          signal,
          timedOut,
          stdout: output,
          stderr: errored,
          ...(outputLimitExceeded
            ? {
                errorOverride: {
                  code: "COMMAND_OUTPUT_LIMIT_EXCEEDED",
                  message: `Command ${outputLimitExceeded} exceeded the ${COMMAND_STREAM_OUTPUT_LIMIT}-character collection limit.`
                }
              }
            : {})
        });
        reject(new GuardedCommandError(action, failure));
        return;
      }

      resolve(parseControlCommandOutput(output, durationMs, requestId));
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

const researchRunEnv = (requestId: string, correlationId: string) => ({
  ALPACA_REQUEST_TIMEOUT_MS:
    process.env.VPS_RESEARCH_REQUEST_TIMEOUT_MS?.trim() || "10000",
  ALPACA_MAX_RETRIES:
    process.env.VPS_RESEARCH_MAX_RETRIES?.trim() || "0",
  RESEARCH_REQUEST_ID: requestId,
  RESEARCH_CORRELATION_ID: correlationId
});

const healthRunEnv = () => ({
  ALPACA_HEALTH_OPERATION_TIMEOUT_MS:
    process.env.VPS_HEALTH_OPERATION_TIMEOUT_MS?.trim() || "9000",
  ALPACA_HEALTH_COMPLETION_MARGIN_MS:
    process.env.VPS_HEALTH_COMPLETION_MARGIN_MS?.trim() || "750"
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

const buildEnvironmentGuardState = (payload?: Record<string, unknown>): EnvironmentGuardState => {
  const checks = buildRuntimePreflightChecks(payload || {});

  return {
    ...checks,
    paperOrderExecutionEnabled: checks.paperExecutionEnabled
  };
};

class EnvironmentGuardError extends Error {
  code: string;
  status: number;
  guard: EnvironmentGuardState;
  checks: RuntimePreflightChecks;
  failedChecks: string[];

  constructor(
    code: string,
    message: string,
    guard: EnvironmentGuardState,
    status = 403,
    failedChecks: string[] = []
  ) {
    super(message);
    this.name = "EnvironmentGuardError";
    this.code = code;
    this.status = status;
    this.guard = guard;
    this.checks = guard;
    this.failedChecks = failedChecks;
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
    assetClass: parseAssetClass(body.assetClass),
    confirmPaper: normalizeBoolean(body.confirmPaper, false),
    expectedPayloadSignature:
      typeof body.expectedPayloadSignature === "string"
        ? body.expectedPayloadSignature
        : undefined,
    underlying:
      typeof body.underlying === "string" && body.underlying.trim()
        ? body.underlying.trim().toUpperCase()
        : "SPY",
    dte: safeInteger(body.dte, 0, 0, 30),
    quantity: typeof body.quantity === "number" ? Math.max(1, Math.floor(body.quantity)) : undefined,
    reviewId: typeof body.reviewId === "string" && body.reviewId.trim() ? body.reviewId.trim() : undefined,
    symbol: typeof body.symbol === "string" && body.symbol.trim() ? body.symbol.trim().toUpperCase() : undefined,
    expirationDate: typeof body.expirationDate === "string" ? body.expirationDate : undefined,
    entryPrice: typeof body.entryPrice === "number" ? body.entryPrice : undefined,
    currentPrice: typeof body.currentPrice === "number" ? body.currentPrice : undefined,
    entryAt: typeof body.entryAt === "string" ? body.entryAt : undefined,
    asOf: typeof body.asOf === "string" ? body.asOf : undefined,
    staleThesis: normalizeBoolean(body.staleThesis, false),
    riskNormalizationObservations: typeof body.riskNormalizationObservations === "number" ? body.riskNormalizationObservations : undefined
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
  return safeTokenEquals(presented, configured);
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
    appendFileSync(logPath, `${JSON.stringify(redactSensitiveData(entry))}\n`);
  } catch {
    // Logging is best-effort only.
  }
};

const wrapSuccess = (
  action: string,
  requestId: string,
  correlationId: string,
  data: unknown,
  params: Record<string, unknown>,
  timing: {
    startedAt: string;
    finishedAt: string;
    durationMs: number;
  }
): Envelope => ({
  ok: true,
  status:
    data && typeof data === "object" && "status" in data
      ? String((data as { status?: unknown }).status || "success")
      : "success",
  action,
  requestId,
  correlationId,
  startedAt: timing.startedAt,
  finishedAt: timing.finishedAt,
  durationMs: timing.durationMs,
  ...(data && typeof data === "object" && "summary" in data
    ? { summary: (data as { summary?: unknown }).summary }
    : {}),
  ...(data && typeof data === "object" && "details" in data
    ? { details: (data as { details?: unknown }).details }
    : {}),
  ...(data && typeof data === "object" && "blockers" in data
    ? { blockers: (data as { blockers?: unknown }).blockers }
    : {}),
  ...(data && typeof data === "object" && "warnings" in data
    ? { warnings: (data as { warnings?: unknown }).warnings }
    : {}),
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
  guard?: EnvironmentGuardState,
  failedChecks: string[] = [],
  commandFailure?: GuardedCommandFailure
): ErrorEnvelope => ({
  ok: false,
  action,
  requestId,
  correlationId,
  error: {
    code,
    message: redactSensitiveText(message)
  },
  ...(guard ? { guard, checks: guard, failedChecks } : {}),
  ...(commandFailure ? { command: commandFailure } : {})
});

type MutabilityRequirement = {
  requireAggressiveMode?: boolean;
  requireOptionsExecution?: boolean;
  actionType?: RuntimeMutationActionType;
  confirmPaper?: boolean;
};

const verifyPaperMutability = async (requirements: MutabilityRequirement = {}) => {
  const health = await command(
    "alpaca:health",
    ["--format=json"],
    TIMEOUT_DEFAULT_MS,
    randomUUID(),
    "health",
    { env: healthRunEnv() }
  );
  if (!health || typeof health !== "object") {
    throw new Error("Health check output was not parseable JSON.");
  }

  const payload = health as Record<string, unknown>;
  const guard = buildEnvironmentGuardState(payload);
  try {
    assertRuntimeMutationPreflight(
      {
        actionType: requirements.actionType || "research",
        confirmPaper: requirements.confirmPaper,
        requireOptionsExecution: requirements.requireOptionsExecution
      },
      payload
    );
  } catch (error) {
    if (error instanceof RuntimePreflightError) {
      throw new EnvironmentGuardError(
        error.code,
        error.message,
        buildEnvironmentGuardState(error.checks),
        error.status,
        error.failedChecks
      );
    }
    throw error;
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

const learnRunHandler = (_input: ControlInput, requestId: string) =>
  command(
    "paper:learn",
    ["--format=json"],
    120_000,
    requestId,
    "learn.run"
  );

const portfolioReviewHandler = (_input: ControlInput, requestId: string) =>
  command(
    "paper:portfolio:review",
    ["--format=json"],
    60_000,
    requestId,
    "portfolio.review"
  );

const optionsDiscoverHandler = (input: ControlInput, requestId: string) =>
  command(
    "paper:options:discover",
    [
      `--underlying=${input.underlying}`,
      `--dte=${input.dte}`,
      "--format=json"
    ],
    60_000,
    requestId,
    "options.discover"
  );

const opsReviewHandler = (_input: ControlInput, requestId: string) =>
  command(
    "paper:ops:review",
    ["--format=json"],
    120_000,
    requestId,
    "paper.ops.review"
  );

const executeReviewedHandler = async (input: ControlInput, requestId: string) => {
  if (input.confirmPaper !== true) {
    return {
      paperOnly: true,
      status: "blocked",
      reason: "CONFIRM_PAPER_REQUIRED",
      summary: {
        eligiblePayloads: 0,
        submitted: 0,
        blocked: 1,
        errors: 0
      },
      blockers: ["CONFIRM_PAPER_REQUIRED"],
      warnings: []
    };
  }

  const readiness = latestReviewArtifactReadiness();
  if (!readiness.ready) {
    return {
      paperOnly: true,
      status: readiness.status,
      reason: readiness.reason,
      summary: {
        eligiblePayloads: readiness.artifact?.payloadCount ?? 0,
        submitted: 0,
        blocked: readiness.status === "blocked" ? 1 : 0,
        errors: 0
      },
      blockers: readiness.status === "blocked" ? [readiness.reason] : [],
      warnings: readiness.status === "warning" ? [readiness.reason] : [],
      artifact: readiness.artifact ?? null
    };
  }

  await openOrdersFetcher();
  return command(
    "paper:execute:reviewed",
    [
      "--confirmPaper",
      `--expectedPayloadSignature=${readiness.artifact.payloadSignature}`,
      "--format=json"
    ],
    120_000,
    requestId,
    "execute.reviewed"
  );
};

const hedgeReviewHandler = (_input: ControlInput, requestId: string) =>
  command("hedge:review", ["--format=json"], 120_000, requestId, "hedge.review");

const hedgeExecuteHandler = (input: ControlInput, requestId: string) => {
  if (input.confirmPaper !== true) {
    return Promise.resolve({ paperOnly: true, status: "blocked", blockers: ["CONFIRM_PAPER_REQUIRED"] });
  }
  if (!input.reviewId) {
    return Promise.resolve({ paperOnly: true, status: "blocked", blockers: ["HEDGE_REVIEW_ID_REQUIRED"] });
  }
  return command(
    "hedge:execute",
    [`--reviewId=${input.reviewId}`, "--confirmPaper", "--format=json"],
    120_000,
    requestId,
    "hedge.execute"
  );
};

const hedgeExitReviewHandler = (input: ControlInput, requestId: string) => {
  if (!input.symbol || !input.expirationDate || input.entryPrice === undefined || input.currentPrice === undefined) {
    return Promise.resolve({ paperOnly: true, environment: "paper", status: "blocked", blockers: ["HEDGE_EXIT_INPUT_REQUIRED"] });
  }
  return command(
    "hedge:exit:review",
    [
      `--symbol=${input.symbol}`,
      `--underlying=${input.underlying}`,
      `--quantity=${input.quantity || 1}`,
      `--entryPrice=${input.entryPrice}`,
      `--currentPrice=${input.currentPrice}`,
      `--expirationDate=${input.expirationDate}`,
      `--entryAt=${input.entryAt || new Date().toISOString()}`,
      ...(input.asOf ? [`--asOf=${input.asOf}`] : []),
      ...(input.staleThesis ? ["--staleThesis"] : []),
      `--riskNormalizationObservations=${input.riskNormalizationObservations || 0}`,
      "--format=json"
    ],
    60_000,
    requestId,
    "hedge.exit.review"
  );
};

const hedgeExitExecuteHandler = (input: ControlInput, requestId: string) => {
  if (input.confirmPaper !== true) {
    return Promise.resolve({ paperOnly: true, status: "blocked", blockers: ["CONFIRM_PAPER_REQUIRED"] });
  }
  if (!input.reviewId) {
    return Promise.resolve({ paperOnly: true, status: "blocked", blockers: ["HEDGE_REVIEW_ID_REQUIRED"] });
  }
  return command(
    "hedge:exit:execute",
    [`--reviewId=${input.reviewId}`, "--confirmPaper", "--format=json"],
    120_000,
    requestId,
    "hedge.exit.execute"
  );
};

const actionHandlers: Record<string, ActionConfig> = {
  "/api/v1/health": {
    method: "GET",
    timeoutMs: 10_000,
    requireAdminToken: false,
    requireMutationPrecheck: false,
    action: "health",
    handler: async (_input, requestId) => {
      const health = await command("alpaca:health", ["--format=json"], 10_000, requestId, "health", {
        env: healthRunEnv()
      });
      if (health && typeof health === "object" && !Array.isArray(health)) {
        return { ...health, stockStream: alpacaStockStream.getHealth() };
      }
      return { alpaca: health, stockStream: alpacaStockStream.getHealth() };
    }
  },
  "/api/v1/hedge/recommendation": {
    method: "GET",
    timeoutMs: 30_000,
    requireAdminToken: false,
    requireMutationPrecheck: false,
    action: "hedge.recommendation",
    handler: async () =>
      latestHedgeRecommendationForCurrentConfig() ?? {
        paperOnly: true,
        effectiveStatus: "blocked",
        recommendationStatus: "blocked",
        warnings: ["NO_HEDGE_RECOMMENDATION"],
        blockers: ["NO_HEDGE_RECOMMENDATION"]
      }
  },
  "/api/v1/hedge/risk": {
    method: "GET",
    timeoutMs: 30_000,
    requireAdminToken: false,
    requireMutationPrecheck: false,
    action: "hedge.risk",
    handler: async () =>
      buildPersistedHedgeRiskRead(latestHedgeRecommendationForCurrentConfig())
  },
  "/api/v1/hedge/regime": {
    method: "GET",
    timeoutMs: 30_000,
    requireAdminToken: false,
    requireMutationPrecheck: false,
    action: "hedge.regime",
    handler: async () => {
      const recommendation = latestHedgeRecommendationForCurrentConfig();
      return {
        paperOnly: true,
        effectiveStatus: recommendation?.effectiveStatus ?? "blocked",
        generatedAt: recommendation?.generatedAt ?? null,
        expiresAt: recommendation?.expiresAt ?? null,
        regime: recommendation?.regime ?? null,
        warnings: recommendation?.integrityWarnings ?? ["NO_HEDGE_RECOMMENDATION"],
        blockers: recommendation ? [] : ["NO_HEDGE_RECOMMENDATION"]
      };
    }
  },
  "/api/v1/hedge/review": {
    method: "POST",
    timeoutMs: 120_000,
    requireAdminToken: true,
    requireMutationPrecheck: true,
    requireHedgeDashboardMutations: true,
    runtimePreflight: { actionType: "review" },
    action: "hedge.review",
    handler: hedgeReviewHandler
  },
  "/api/v1/hedge/execute": {
    method: "POST",
    timeoutMs: 120_000,
    requireAdminToken: true,
    requireMutationPrecheck: false,
    requireHedgeDashboardMutations: true,
    runtimePreflight: {
      actionType: "confirmed-paper-execution",
      confirmPaperFromInput: true,
      requireOptionsExecution: true
    },
    action: "hedge.execute",
    handler: hedgeExecuteHandler
  },
  "/api/v1/hedge/exit/review": {
    method: "POST",
    timeoutMs: 60_000,
    requireAdminToken: true,
    requireMutationPrecheck: true,
    requireHedgeDashboardMutations: true,
    runtimePreflight: { actionType: "review" },
    action: "hedge.exit.review",
    handler: hedgeExitReviewHandler
  },
  "/api/v1/hedge/exit/execute": {
    method: "POST",
    timeoutMs: 120_000,
    requireAdminToken: true,
    requireMutationPrecheck: false,
    requireHedgeDashboardMutations: true,
    runtimePreflight: {
      actionType: "confirmed-paper-execution",
      confirmPaperFromInput: true,
      requireOptionsExecution: true
    },
    action: "hedge.exit.execute",
    handler: hedgeExitExecuteHandler
  },
  "/api/v1/hedge/execution": {
    method: "GET",
    timeoutMs: 30_000,
    requireAdminToken: false,
    requireMutationPrecheck: false,
    action: "hedge.execution",
    handler: async () => ({ paperOnly: true, environment: "paper", entries: listPaperExecutionLedgerEntries(100) })
  },
  "/api/v1/hedge/learning": {
    method: "GET",
    timeoutMs: 30_000,
    requireAdminToken: false,
    requireMutationPrecheck: false,
    action: "hedge.learning",
    handler: async (input) => ({
      paperOnly: true,
      environment: "paper",
      reviewId: input.reviewId || null,
      evaluation: input.reviewId ? evaluateHedgeLearning(input.reviewId) : null,
      events: listRecentHedgeLearningEvents(100)
    })
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
    runtimePreflight: { actionType: "research" },
    action: "research.run",
    handler: async (input, requestId, correlationId) =>
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
          env: researchRunEnv(requestId, correlationId)
        }
      )
  },
  "/api/v1/actions/research/run": {
    method: "POST",
    timeoutMs: 420_000,
    requireAdminToken: true,
    requireMutationPrecheck: true,
    runtimePreflight: { actionType: "research" },
    action: "paper.actions.research.run",
    handler: async (input, requestId, correlationId) =>
      command(
        "paper:research",
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
        "paper.actions.research.run",
        {
          env: researchRunEnv(requestId, correlationId)
        }
      )
  },
  "/api/v1/actions/learn/run": {
    method: "POST",
    timeoutMs: 120_000,
    requireAdminToken: true,
    requireMutationPrecheck: true,
    runtimePreflight: { actionType: "learning" },
    action: "paper.actions.learn.run",
    handler: learnRunHandler
  },
  "/api/v1/actions/portfolio/review": {
    method: "POST",
    timeoutMs: 60_000,
    requireAdminToken: true,
    requireMutationPrecheck: true,
    runtimePreflight: { actionType: "portfolio-review" },
    action: "paper.actions.portfolio.review",
    handler: portfolioReviewHandler
  },
  "/api/v1/actions/options/discover": {
    method: "POST",
    timeoutMs: 60_000,
    requireAdminToken: true,
    requireMutationPrecheck: true,
    runtimePreflight: { actionType: "options-discovery" },
    action: "paper.actions.options.discover",
    handler: optionsDiscoverHandler
  },
  "/api/v1/actions/review": {
    method: "POST",
    timeoutMs: 120_000,
    requireAdminToken: true,
    requireMutationPrecheck: true,
    runtimePreflight: { actionType: "review" },
    action: "paper.actions.review",
    handler: opsReviewHandler
  },
  "/api/v1/actions/execute": {
    method: "POST",
    timeoutMs: 120_000,
    requireAdminToken: true,
    requireMutationPrecheck: false,
    runtimePreflight: {
      actionType: "confirmed-paper-execution",
      confirmPaperFromInput: true,
      requireOptionsExecution: true
    },
    action: "paper.actions.execute",
    handler: executeReviewedHandler
  },
  "/api/v1/actions/history": {
    method: "GET",
    timeoutMs: 30_000,
    requireAdminToken: false,
    requireMutationPrecheck: false,
    action: "paper.actions.history",
    handler: async () => ({
      status: "success",
      summary: {
        operations: listPaperOperations(25).length,
        reviewReady: latestReviewArtifactReadiness().ready
      },
      operations: listPaperOperations(25),
      reviewReadiness: latestReviewArtifactReadiness(),
      blockers: [],
      warnings: []
    })
  },
  "/api/v1/review/run": {
    method: "POST",
    timeoutMs: 60_000,
    requireAdminToken: true,
    requireMutationPrecheck: true,
    runtimePreflight: { actionType: "review" },
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
    runtimePreflight: { actionType: "review" },
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
    runtimePreflight: { actionType: "dry-run-execution" },
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
    runtimePreflight: {
      actionType: "confirmed-paper-execution",
      confirmPaperFromInput: true,
      requireOptionsExecution: true
    },
    action: "execute.confirm",
    handler: executeReviewedHandler
  },
  "/api/v1/zero-dte/summary": {
    method: "GET",
    timeoutMs: 30_000,
    requireAdminToken: false,
    requireMutationPrecheck: false,
    action: "zero-dte.summary",
    handler: async () => buildZeroDteDashboardSummary({ limit: 25 })
  },
  "/api/v1/summary": {
    method: "GET",
    timeoutMs: 30_000,
    requireAdminToken: false,
    requireMutationPrecheck: false,
    action: "summary",
    handler: async () => buildCachedDashboardSnapshot()
  },
  "/api/v1/refresh": {
    method: "POST",
    timeoutMs: 60_000,
    requireAdminToken: true,
    requireMutationPrecheck: false,
    runtimePreflight: { actionType: "review" },
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
  redactSensitiveText(
    error instanceof GuardedCommandError
      ? error.result.error.message
      : error instanceof Error
        ? error.message
        : String(error || "Control request failed.")
  );

const classifyErrorCode = (message: string) =>
  message.includes("token")
    ? "CONTROL_TOKEN_INVALID"
    : message.includes("timeout")
      ? "CONTROL_ACTION_TIMEOUT"
      : message.includes("not parse")
        ? "CONTROL_INPUT_INVALID"
        : "CONTROL_ACTION_ERROR";

const routeErrorCode = (error: unknown, message: string) =>
  error instanceof EnvironmentGuardError
    ? error.code
    : error instanceof GuardedCommandError
      ? error.code
      : classifyErrorCode(message);

const routeErrorStatus = (error: unknown, code: string) =>
  error instanceof EnvironmentGuardError
    ? error.status
    : code === "CONTROL_TOKEN_INVALID"
      ? 401
      : 500;

const runtimePreflightForConfig = (
  config: ActionConfig,
  input: ControlInput
): MutabilityRequirement | null => {
  if (config.runtimePreflight) {
    return {
      actionType: config.runtimePreflight.actionType,
      confirmPaper: config.runtimePreflight.confirmPaperFromInput
        ? input.confirmPaper === true
        : config.runtimePreflight.confirmPaper,
      requireOptionsExecution: config.runtimePreflight.requireOptionsExecution
    };
  }

  if (config.requireMutationPrecheck) {
    return { actionType: "research" };
  }

  return null;
};

const routeHandler = async (request: IncomingMessage, response: any, config: ActionConfig) => {
  const startMs = Date.now();
  const startedAt = new Date(startMs).toISOString();
  const correlationId = requestIdFromRequest(request);
  const requestId = randomUUID();

  try {
    if (config.requireAdminToken && !authorize(request)) {
      throw new Error("Missing or invalid control token.");
    }
    if (config.requireHedgeDashboardMutations && process.env.HEDGE_DASHBOARD_MUTATIONS_ENABLED !== "true") {
      throw new EnvironmentGuardError(
        "HEDGE_DASHBOARD_MUTATIONS_DISABLED",
        "Hedge dashboard mutation controls are disabled.",
        buildEnvironmentGuardState()
      );
    }

    const body = request.method === "POST" ? await readBody(request) : {};
    const input = parseInput(body);
    const preflight = runtimePreflightForConfig(config, input);
    if (preflight) {
      await verifyPaperMutability(preflight);
    }

    const data = await config.handler(input, requestId, correlationId);
    const durationMs = Date.now() - startMs;
    const finishedAt = new Date(startMs + durationMs).toISOString();
    const payload = wrapSuccess(
      config.action,
      requestId,
      correlationId,
      data,
      {
        riskProfile: input.riskProfile,
        optionsEnabled: input.optionsEnabled,
        maxCandidates: input.maxCandidates,
        assetClass: input.assetClass,
        confirmPaper: input.confirmPaper,
        underlying: input.underlying,
        dte: input.dte,
        ...(input.reviewId ? { reviewId: input.reviewId } : {})
      },
      {
        startedAt,
        finishedAt,
        durationMs
      }
    );

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
      error instanceof EnvironmentGuardError ? error.guard : undefined,
      error instanceof EnvironmentGuardError ? error.failedChecks : [],
      error instanceof GuardedCommandError ? error.result : undefined
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
      error: redactSensitiveText(message)
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
          redactSensitiveText(error instanceof Error ? error.message : "Request handler failed.")
        )
      )
    );
  }
};

export const createControlServer = () => createServer(requestListener);

const server = createControlServer();

export const closeControlServer = async () => {
  await alpacaStockStream.stop();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
};

const startBackgroundServices = async () => {
  if (!alpacaStockStream.getStatus().enabled) {
    return;
  }

  if (!process.env.ALPACA_STOCK_STREAM_SYMBOLS?.trim()) {
    try {
      const activeSymbols = getActiveSymbols();
      if (activeSymbols.length > 0) {
        await alpacaStockStream.setSymbols(activeSymbols);
      }
    } catch {
      console.warn("Alpaca SIP stream active universe unavailable; using configured symbols");
    }
  }

  await alpacaStockStream.start();
};

if (process.env.DASHBOARD_CONTROL_NO_START !== "1") {
  server.listen(CONTROL_PORT, CONTROL_HOST, () => {
    console.log(`Dashboard control API listening on ${CONTROL_HOST}:${CONTROL_PORT}`);
    void startBackgroundServices();
  });

  let shutdownStarted = false;
  const handleShutdown = () => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    void closeControlServer();
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}
