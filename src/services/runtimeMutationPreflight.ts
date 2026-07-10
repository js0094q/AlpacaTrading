export type RuntimeMutationActionType =
  | "read-only"
  | "research"
  | "review"
  | "options-discovery"
  | "portfolio-review"
  | "learning"
  | "dry-run-execution"
  | "confirmed-paper-execution"
  | "live-execution";

export type RuntimePreflightChecks = {
  paperOnly: boolean;
  environment: string;
  tradingMode: string;
  liveTradingEnabled: boolean;
  mutationAllowed: boolean;
  paperExecutionEnabled: boolean;
  paperOptionsExecutionEnabled: boolean;
  automatedPaperExecutionEnabled: boolean;
  liveApiBaseUrlReachableOrConfigured: boolean;
  paperApiBaseUrlConfigured: boolean;
};

export type RuntimePreflightPolicy = {
  actionType: RuntimeMutationActionType;
  confirmPaper?: boolean;
  requireOptionsExecution?: boolean;
};

type RuntimeEnv = Record<string, string | undefined>;

export type RuntimePreflightResult =
  | {
      ok: true;
      actionType: RuntimeMutationActionType;
      checks: RuntimePreflightChecks;
      failedChecks: [];
    }
  | {
      ok: false;
      actionType: RuntimeMutationActionType;
      checks: RuntimePreflightChecks;
      failedChecks: string[];
      code: "RUNTIME_PREFLIGHT_FAILED";
      message: string;
    };

export class RuntimePreflightError extends Error {
  code = "RUNTIME_PREFLIGHT_FAILED" as const;
  status = 403;
  actionType: RuntimeMutationActionType;
  checks: RuntimePreflightChecks;
  failedChecks: string[];

  constructor(result: Extract<RuntimePreflightResult, { ok: false }>) {
    super(result.message);
    this.name = "RuntimePreflightError";
    this.actionType = result.actionType;
    this.checks = result.checks;
    this.failedChecks = result.failedChecks;
  }
}

const parseBoolean = (value: unknown): boolean =>
  value === true || value === "true" || value === "1";

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const firstTrimmed = (...values: Array<string | undefined>) =>
  values.find((value) => value?.trim())?.trim() || "";

const isLiveAlpacaBaseUrl = (value: string) => {
  const normalized = value.toLowerCase();
  return normalized.includes("api.alpaca.markets") && !normalized.includes("paper-api.alpaca.markets");
};

export const buildRuntimePreflightChecks = (
  payload: Record<string, unknown> = {},
  env: RuntimeEnv = process.env
): RuntimePreflightChecks => {
  const environment = (
    stringValue(payload.environment) ||
    stringValue(payload.alpacaEnv) ||
    env.ALPACA_ENV ||
    "paper"
  ).toLowerCase();
  const tradingMode = String(env.TRADING_MODE || "paper").toLowerCase();
  const liveTradingEnabled =
    payload.liveTradingEnabled === true ||
    parseBoolean(env.LIVE_TRADING_ENABLED) ||
    parseBoolean(env.ALPACA_LIVE_TRADE);
  const reportedPaperOnly =
    typeof payload.paperOnly === "boolean"
      ? payload.paperOnly
      : environment === "paper";
  const paperOnly =
    reportedPaperOnly && environment === "paper" && tradingMode !== "live" && !liveTradingEnabled;
  const liveBaseUrl = firstTrimmed(
    env.ALPACA_LIVE_BASE_URL,
    env.ALPACA_LIVE_API_BASE_URL
  );
  const genericApiBaseUrl = firstTrimmed(env.APCA_API_BASE_URL, env.ALPACA_API_BASE_URL);
  const paperBaseUrl =
    firstTrimmed(env.ALPACA_PAPER_BASE_URL, env.ALPACA_PAPER_API_BASE_URL) ||
    (genericApiBaseUrl.includes("paper-api.alpaca.markets") ? genericApiBaseUrl : "") ||
    "https://paper-api.alpaca.markets";

  return {
    paperOnly,
    environment,
    tradingMode,
    liveTradingEnabled,
    mutationAllowed: payload.mutationAllowed === true,
    paperExecutionEnabled: parseBoolean(env.PAPER_ORDER_EXECUTION_ENABLED),
    paperOptionsExecutionEnabled: parseBoolean(env.PAPER_OPTIONS_EXECUTION_ENABLED),
    automatedPaperExecutionEnabled: parseBoolean(env.AUTOMATED_PAPER_EXECUTION_ENABLED),
    liveApiBaseUrlReachableOrConfigured:
      Boolean(liveBaseUrl) || isLiveAlpacaBaseUrl(genericApiBaseUrl),
    paperApiBaseUrlConfigured: Boolean(paperBaseUrl)
  };
};

export const evaluateRuntimeMutationPreflight = (
  policy: RuntimePreflightPolicy,
  payload: Record<string, unknown> = {},
  env: RuntimeEnv = process.env
): RuntimePreflightResult => {
  const checks = buildRuntimePreflightChecks(payload, env);
  const failedChecks: string[] = [];

  if (policy.actionType === "live-execution") {
    failedChecks.push("liveExecutionUnsupported");
  }

  if (policy.actionType !== "read-only") {
    if (!checks.paperOnly) failedChecks.push("paperOnly");
    if (checks.environment !== "paper") failedChecks.push("environment");
    if (checks.tradingMode !== "paper") failedChecks.push("tradingMode");
    if (checks.liveTradingEnabled) failedChecks.push("liveTradingEnabled");
    if (checks.mutationAllowed) failedChecks.push("mutationAllowed");
    if (!checks.paperApiBaseUrlConfigured) failedChecks.push("paperApiBaseUrlConfigured");
  }

  if (policy.actionType === "confirmed-paper-execution") {
    if (!policy.confirmPaper) failedChecks.push("confirmPaper");
    if (!checks.paperExecutionEnabled) failedChecks.push("paperExecutionEnabled");
    if (policy.requireOptionsExecution && !checks.paperOptionsExecutionEnabled) {
      failedChecks.push("paperOptionsExecutionEnabled");
    }
  }

  if (failedChecks.length > 0) {
    return {
      ok: false,
      actionType: policy.actionType,
      checks,
      failedChecks,
      code: "RUNTIME_PREFLIGHT_FAILED",
      message: "Runtime state does not permit this action."
    };
  }

  return {
    ok: true,
    actionType: policy.actionType,
    checks,
    failedChecks: []
  };
};

export const assertRuntimeMutationPreflight = (
  policy: RuntimePreflightPolicy,
  payload: Record<string, unknown> = {},
  env: RuntimeEnv = process.env
) => {
  const result = evaluateRuntimeMutationPreflight(policy, payload, env);
  if (!result.ok) {
    throw new RuntimePreflightError(result);
  }
  return result;
};
