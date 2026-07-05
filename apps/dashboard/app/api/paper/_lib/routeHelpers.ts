import {
  DashboardGuardError,
  assertDashboardAdminToken,
  assertPaperDashboardAccess,
  assertPaperOptionsSubmissionEnabled,
  assertPaperOrderSubmissionEnabled,
  noStoreJson,
  sanitizeDashboardError
} from "../../../../lib/guards";
import { parsePaperActionInput, type PaperActionInput } from "../../../../lib/data";
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
        return (error as { message: string }).message;
      }
      if ("code" in error) {
        return `Control error ${(error as { code?: unknown }).code}`;
      }
      return JSON.stringify(error);
    }
    if (typeof error === "string") {
      return error;
    }
  }
  return null;
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
      payload = { ok: false, error: raw || "VPS control response was not JSON" };
    }

    if (!response.ok) {
      const message =
        parseVpsError(payload) ||
        (payload && typeof payload === "object" && "error" in payload
          ? String((payload as { error: unknown }).error)
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
      return noStoreJson(response);
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
      return noStoreJson(response);
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
    vpsPath?: string;
    timeoutMs?: number;
  } = {}
) => {
  try {
    assertPaperDashboardAccess();
    const normalizedRequest = normalizeRequest(request);
    const input = await readActionInput(normalizedRequest);

    const useBridge = isPaperDashboardBridgeEnabled() && Boolean(options.vpsPath);
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

    if (options.requireAdminToken) {
      assertDashboardAdminToken(adminTokenFromRequest(normalizedRequest));
    }

    if (useBridge) {
      const response = await guardForVpsBridge(normalizedRequest, "POST", options.vpsPath!, {
        requireAdmin: options.requireAdminToken,
        timeoutMs: options.timeoutMs,
        input
      });
      return noStoreJson(response);
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
    vpsPath?: string;
    timeoutMs?: number;
  } = {}
) => {
  try {
    assertPaperDashboardAccess();
    const normalizedRequest = normalizeRequest(request);
    const input = await readActionInput(normalizedRequest);
    const useBridge = isPaperDashboardBridgeEnabled() && Boolean(options.vpsPath);

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

    if (options.requireAdminToken) {
      assertDashboardAdminToken(adminTokenFromRequest(normalizedRequest));
    }

    if (shouldUseVercelReadOnlyFallback()) {
      return noStoreJson(buildVercelHistoricalFallback([]));
    }

    if (isPaperDashboardBridgeEnabled() && options.vpsPath) {
      const response = await guardForVpsBridge(normalizedRequest, "POST", options.vpsPath, {
        requireAdmin: options.requireAdminToken,
        timeoutMs: options.timeoutMs,
        input
      });
      return noStoreJson(response);
    }

    return noStoreJson({ ok: true, data: await handler(input) });
  } catch (error) {
    const sanitized = sanitizeDashboardError(error);
    return noStoreJson(sanitized.body, { status: sanitized.status });
  }
};
