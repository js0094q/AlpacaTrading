import {
  DashboardGuardError,
  assertDashboardAdminToken,
  assertDashboardRuntimePreflight,
  assertPaperDashboardAccess,
  assertPaperOptionsSubmissionEnabled,
  assertPaperOrderSubmissionEnabled,
  noStoreJson,
  sanitizeDashboardError
} from "../../../../lib/guards";
import { parsePaperActionInput, type PaperActionInput } from "../../../../lib/data";
import { redactSensitiveData, redactSensitiveText } from "../../../../../../src/lib/securityRedaction";
import type { RuntimeMutationActionType } from "../../../../../../src/services/runtimeMutationPreflight";
import {
  buildVercelHistoricalFallback,
  isPaperDashboardBridgeEnabled,
  shouldUseVercelReadOnlyFallback
} from "../../../../lib/runtime";

const readActionInput = async (request: Request): Promise<PaperActionInput> => {
  try {
    return parsePaperActionInput(await request.json());
  } catch {
    return parsePaperActionInput({});
  }
};

const normalizeRequest = (request?: Request) => request || new Request("http://localhost");

const adminTokenFromRequest = (request: Request): string | null => {
  const header = request.headers.get("authorization") || "";
  if (!header.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  return header.slice(7).trim();
};

const resolveControlBaseUrl = () =>
  process.env.VPS_CONTROL_BASE_URL?.trim() || process.env.PAPER_DASHBOARD_BRIDGE_URL?.trim();

const resolveControlToken = () =>
  process.env.VPS_CONTROL_TOKEN?.trim() || process.env.PAPER_DASHBOARD_BRIDGE_TOKEN?.trim();

const buildVpsUrl = (path: string) => {
  const baseUrl = resolveControlBaseUrl() || "";
  if (!baseUrl) {
    throw new Error("DASHBOARD_CONTROL_BASE_URL_NOT_CONFIGURED");
  }
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  return `${normalizedBase}${normalizedPath}`;
};

const parseVpsError = (payload: unknown) => {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error: unknown }).error;
    if (error && typeof error === "object") {
      if ("message" in error && typeof (error as { message?: unknown }).message === "string") {
        return redactSensitiveText((error as { message: string }).message);
      }
      if ("code" in error) {
        return redactSensitiveText(`Control error ${(error as { code?: unknown }).code}`);
      }
      return redactSensitiveText(JSON.stringify(error));
    }
    if (typeof error === "string") {
      return redactSensitiveText(error);
    }
  }
  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object");

const noStoreVpsControlJson = (payload: unknown) => {
  const redactedPayload = redactSensitiveData(payload);
  if (isRecord(redactedPayload) && typeof redactedPayload._status === "number") {
    const { _status, ...body } = redactedPayload;
    return noStoreJson(body, { status: _status });
  }
  return noStoreJson(redactedPayload);
};

const inferRuntimeActionType = (
  vpsPath: string | undefined,
  options: {
    requireOrderSubmission?: boolean;
  }
): RuntimeMutationActionType => {
  if (vpsPath?.includes("/execute/confirm") || vpsPath?.includes("/actions/execute")) {
    return "confirmed-paper-execution";
  }
  if (vpsPath?.includes("/execute/dry-run")) {
    return "dry-run-execution";
  }
  if (vpsPath?.includes("/actions/options/discover")) {
    return "options-discovery";
  }
  if (vpsPath?.includes("/actions/portfolio/review")) {
    return "portfolio-review";
  }
  if (vpsPath?.includes("/actions/learn/run")) {
    return "learning";
  }
  if (vpsPath?.includes("/review") || vpsPath?.includes("/plan") || vpsPath?.includes("/refresh")) {
    return "review";
  }
  if (options.requireOrderSubmission) {
    return "confirmed-paper-execution";
  }
  return "research";
};

const assertDashboardMutationPreflight = (
  input: PaperActionInput,
  options: {
    requireOrderSubmission?: boolean;
    vpsPath?: string;
  }
) => {
  const actionType = inferRuntimeActionType(options.vpsPath, options);
  const isConfirmRoute = options.vpsPath?.includes("/execute/confirm") === true;
  const isReviewedExecutionRoute = options.vpsPath?.includes("/actions/execute") === true;
  const confirmPaper =
    actionType !== "confirmed-paper-execution" ||
    isConfirmRoute ||
    input.confirmPaper === true;
  const requireOptionsExecution =
    actionType === "confirmed-paper-execution" &&
    (isReviewedExecutionRoute ||
      input.optionsEnabled !== false ||
      input.assetClass === "option");

  return assertDashboardRuntimePreflight({
    actionType,
    confirmPaper,
    requireOptionsExecution
  });
};

const callVpsControl = async (
  path: string,
  method: "GET" | "POST",
  request: Request,
  input?: PaperActionInput,
  timeoutMs?: number
) => {
  const headers: Record<string, string> = {
    Accept: "application/json"
  };

  const controlToken = resolveControlToken();
  if (controlToken) {
    headers.authorization = `Bearer ${controlToken}`;
  }
  if (!controlToken) {
    throw new DashboardGuardError("DASHBOARD_CONTROL_TOKEN_MISSING", "Dashboard control token is missing.");
  }

  const body = input ? JSON.stringify(input) : undefined;
  if (body) {
    headers["Content-Type"] = "application/json";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs || 10_000);

  const correlationId =
    request.headers.get("x-correlation-id") ||
    request.headers.get("x-request-id") ||
    "";

  if (correlationId) {
    headers["x-correlation-id"] = correlationId;
  }

  try {
    const response = await fetch(buildVpsUrl(path), {
      method,
      headers,
      body,
      signal: controller.signal
    });

    const raw = await response.text();
    let payload: unknown;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = {
        ok: false,
        error: redactSensitiveText(raw || "VPS control response was not JSON")
      };
    }

    if (!response.ok && isRecord(payload)) {
      return {
        ...payload,
        _status: response.status,
        headers: Object.fromEntries(response.headers.entries())
      };
    }

    if (!response.ok) {
      const message =
        parseVpsError(payload) ||
        (payload && typeof payload === "object" && "error" in payload
          ? redactSensitiveText(String((payload as { error: unknown }).error))
          : "VPS control request failed.");
      throw new DashboardGuardError("DASHBOARD_CONTROL_PROXY_ERROR", message, response.status);
    }

    if (!(payload && typeof payload === "object" && "ok" in payload)) {
      throw new DashboardGuardError("DASHBOARD_CONTROL_PROXY_ERROR", "VPS response format is invalid.");
    }
    return { ...payload, headers: Object.fromEntries(response.headers.entries()) };
  } finally {
    clearTimeout(timer);
  }
};

const guardForVpsBridge = async (
  request: Request,
  method: "GET" | "POST",
  vpsPath?: string,
  options: {
    requireAdmin?: boolean;
    timeoutMs?: number;
    input?: PaperActionInput;
  } = {}
) => {
  if (!vpsPath) {
    throw new Error("DASHBOARD_CONTROL_PATH_MISSING");
  }

  const vpsInput =
    options.input || (method === "POST" ? await readActionInput(request) : undefined);

  if (options.requireAdmin) {
    assertDashboardAdminToken(adminTokenFromRequest(request));
  }

  const result = await callVpsControl(
    vpsPath,
    method,
    request,
    vpsInput,
    options.timeoutMs
  );

  return result;
};

export const guardedGet = async (
  request: Request = new Request("http://localhost"),
  handler: () => Promise<unknown> | unknown,
  options: { vpsPath?: string; timeoutMs?: number } = {}
) => {
  try {
    assertPaperDashboardAccess();
    if (isPaperDashboardBridgeEnabled() && options.vpsPath) {
      const normalizedRequest = normalizeRequest(request);
      const response = await guardForVpsBridge(normalizedRequest, "GET", options.vpsPath, {
        timeoutMs: options.timeoutMs
      });
      return noStoreVpsControlJson(response);
    }

    return noStoreJson({ ok: true, data: await handler() });
  } catch (error) {
    const sanitized = sanitizeDashboardError(error);
    return noStoreJson(sanitized.body, { status: sanitized.status });
  }
};

export const guardedHistoricalGet = async (
  request: Request = new Request("http://localhost"),
  handler: () => Promise<unknown> | unknown,
  options: { vpsPath?: string; timeoutMs?: number } = {}
) => {
  try {
    assertPaperDashboardAccess();
    if (isPaperDashboardBridgeEnabled() && options.vpsPath) {
      const normalizedRequest = normalizeRequest(request);
      const response = await guardForVpsBridge(normalizedRequest, "GET", options.vpsPath, {
        timeoutMs: options.timeoutMs
      });
      return noStoreVpsControlJson(response);
    }
    if (shouldUseVercelReadOnlyFallback()) {
      return noStoreJson(buildVercelHistoricalFallback([]));
    }
    return noStoreJson({ ok: true, data: await handler() });
  } catch (error) {
    const sanitized = sanitizeDashboardError(error);
    return noStoreJson(sanitized.body, { status: sanitized.status });
  }
};

export const guardedPost = async (
  request: Request,
  handler: (input: PaperActionInput) => Promise<unknown> | unknown,
  options: {
    requireOrderSubmission?: boolean;
    requireOptionsSubmission?: boolean;
    requireAdminToken?: boolean;
    requireHedgeDashboardMutations?: boolean;
    vpsPath?: string;
    timeoutMs?: number;
  } = {}
) => {
  try {
    assertPaperDashboardAccess();
    const normalizedRequest = normalizeRequest(request);
    const input = await readActionInput(normalizedRequest);
    const requireAdminToken = options.requireAdminToken !== false;

    const useBridge = isPaperDashboardBridgeEnabled() && Boolean(options.vpsPath);
    if (requireAdminToken) {
      assertDashboardAdminToken(adminTokenFromRequest(normalizedRequest));
    }
    if (options.requireHedgeDashboardMutations && process.env.HEDGE_DASHBOARD_MUTATIONS_ENABLED !== "true") {
      throw new DashboardGuardError("HEDGE_DASHBOARD_MUTATIONS_DISABLED", "Hedge dashboard mutation controls are disabled.");
    }

    assertDashboardMutationPreflight(input, {
      requireOrderSubmission: options.requireOrderSubmission,
      vpsPath: options.vpsPath
    });

    if (options.requireOrderSubmission && !useBridge) {
      assertPaperOrderSubmissionEnabled();
    }
    if (
      !useBridge &&
      (options.requireOptionsSubmission ||
        (options.requireOrderSubmission && input.assetClass !== "equity"))
    ) {
      assertPaperOptionsSubmissionEnabled();
    }

    if (useBridge) {
      const response = await guardForVpsBridge(normalizedRequest, "POST", options.vpsPath!, {
        requireAdmin: requireAdminToken,
        timeoutMs: options.timeoutMs,
        input
      });
      return noStoreVpsControlJson(response);
    }

    return noStoreJson({ ok: true, data: await handler(input) });
  } catch (error) {
    const sanitized = sanitizeDashboardError(error);
    return noStoreJson(sanitized.body, { status: sanitized.status });
  }
};

export const guardedHistoricalPost = async (
  request: Request,
  handler: (input: PaperActionInput) => Promise<unknown> | unknown,
  options: {
    requireOrderSubmission?: boolean;
    requireOptionsSubmission?: boolean;
    requireAdminToken?: boolean;
    requireHedgeDashboardMutations?: boolean;
    vpsPath?: string;
    timeoutMs?: number;
  } = {}
) => {
  try {
    assertPaperDashboardAccess();
    const normalizedRequest = normalizeRequest(request);
    const input = await readActionInput(normalizedRequest);
    const useBridge = isPaperDashboardBridgeEnabled() && Boolean(options.vpsPath);
    const requireAdminToken = options.requireAdminToken !== false;

    if (requireAdminToken) {
      assertDashboardAdminToken(adminTokenFromRequest(normalizedRequest));
    }
    if (options.requireHedgeDashboardMutations && process.env.HEDGE_DASHBOARD_MUTATIONS_ENABLED !== "true") {
      throw new DashboardGuardError("HEDGE_DASHBOARD_MUTATIONS_DISABLED", "Hedge dashboard mutation controls are disabled.");
    }

    assertDashboardMutationPreflight(input, {
      requireOrderSubmission: options.requireOrderSubmission,
      vpsPath: options.vpsPath
    });

    if (options.requireOrderSubmission && !useBridge) {
      assertPaperOrderSubmissionEnabled();
    }
    if (
      !useBridge &&
      (options.requireOptionsSubmission ||
        (options.requireOrderSubmission && input.assetClass !== "equity"))
    ) {
      assertPaperOptionsSubmissionEnabled();
    }

    if (shouldUseVercelReadOnlyFallback()) {
      return noStoreJson(buildVercelHistoricalFallback([]));
    }

    if (isPaperDashboardBridgeEnabled() && options.vpsPath) {
      const response = await guardForVpsBridge(normalizedRequest, "POST", options.vpsPath, {
        requireAdmin: requireAdminToken,
        timeoutMs: options.timeoutMs,
        input
      });
      return noStoreVpsControlJson(response);
    }

    return noStoreJson({ ok: true, data: await handler(input) });
  } catch (error) {
    const sanitized = sanitizeDashboardError(error);
    return noStoreJson(sanitized.body, { status: sanitized.status });
  }
};
