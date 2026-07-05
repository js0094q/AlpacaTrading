import { getTradingSafetyState } from "../../../src/services/tradingSafetyService";
import { isVercelRuntime } from "./runtime";

export class DashboardGuardError extends Error {
  status: number;
  code: string;

  constructor(code: string, message: string, status = 403) {
    super(message);
    this.name = "DashboardGuardError";
    this.status = status;
    this.code = code;
  }
}

const boolEnv = (name: string) =>
  process.env[name] === "true" || process.env[name] === "1";

export const assertPaperDashboardAccess = () => {
  const state = getTradingSafetyState();
  const tradingMode = String(process.env.TRADING_MODE || "paper").toLowerCase();

  if (state.alpacaEnv !== "paper") {
    throw new DashboardGuardError(
      "PAPER_ENV_REQUIRED",
      "Dashboard routes require ALPACA_ENV=paper."
    );
  }

  if (tradingMode === "live") {
    throw new DashboardGuardError(
      "TRADING_MODE_MUST_BE_PAPER",
      "Dashboard routes require TRADING_MODE=paper."
    );
  }

  if (state.liveTradingEnabled) {
    throw new DashboardGuardError(
      "LIVE_TRADING_MUST_BE_DISABLED",
      "Dashboard routes require LIVE_TRADING_ENABLED=false and ALPACA_LIVE_TRADE=false."
    );
  }

  return state;
};

export const assertPaperOrderSubmissionEnabled = () => {
  if (isVercelRuntime()) {
    throw new DashboardGuardError(
      "PAPER_ORDER_EXECUTION_DISABLED_ON_VERCEL",
      "Vercel dashboard deployments are read-only and cannot submit paper orders."
    );
  }

  if (!boolEnv("PAPER_ORDER_EXECUTION_ENABLED")) {
    throw new DashboardGuardError(
      "PAPER_ORDER_EXECUTION_DISABLED",
      "Submit to Alpaca Paper Account requires PAPER_ORDER_EXECUTION_ENABLED=true."
    );
  }
};

export const assertPaperOptionsSubmissionEnabled = () => {
  if (!boolEnv("PAPER_OPTIONS_EXECUTION_ENABLED")) {
    throw new DashboardGuardError(
      "PAPER_OPTIONS_EXECUTION_DISABLED",
      "Paper option submission requires PAPER_OPTIONS_EXECUTION_ENABLED=true."
    );
  }
};

export const assertDashboardAdminToken = (token: string | null) => {
  const expected = process.env.DASHBOARD_ADMIN_TOKEN;
  if (!expected) {
    throw new DashboardGuardError(
      "DASHBOARD_ADMIN_TOKEN_MISSING",
      "Dashboard admin token is not configured. Set DASHBOARD_ADMIN_TOKEN to enable dashboard actions."
    );
  }

  if (!token || token !== expected) {
    throw new DashboardGuardError(
      "DASHBOARD_ADMIN_TOKEN_INVALID",
      "Invalid dashboard admin token."
    );
  }
};

export const sanitizeDashboardError = (error: unknown) => {
  if (error instanceof DashboardGuardError) {
    return {
      status: error.status,
      body: {
        ok: false,
        error: {
          code: error.code,
          message: error.message
        }
      }
    };
  }

  if (
    error instanceof Error &&
    /Missing Alpaca paper credentials/.test(error.message)
  ) {
    return {
      status: 200,
      body: {
        ok: false,
        error: "DASHBOARD_ALPACA_ENV_NOT_CONFIGURED"
      }
    };
  }

  return {
    status: 500,
    body: {
      ok: false,
      error: {
        code: "DASHBOARD_REQUEST_FAILED",
        message: "Dashboard request failed. Check server logs for details."
      }
    }
  };
};

export const noStoreJson = (body: unknown, init: ResponseInit = {}) =>
  Response.json(body, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...(init.headers || {})
    }
  });
