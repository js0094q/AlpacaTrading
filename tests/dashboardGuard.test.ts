import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type DashboardGuards = {
  assertPaperDashboardAccess: () => {
    alpacaEnv: string;
    liveTradingEnabled: boolean;
  };
  assertDashboardAdminToken: (token: string | null) => void;
  assertDashboardRuntimePreflight: (policy: {
    actionType:
      | "research"
      | "review"
      | "options-discovery"
      | "portfolio-review"
      | "learning"
      | "dry-run-execution"
      | "confirmed-paper-execution"
      | "live-execution";
    confirmPaper?: boolean;
    requireOptionsExecution?: boolean;
  }) => {
    checks: {
      paperOnly: boolean;
      environment: string;
      tradingMode: string;
      liveTradingEnabled: boolean;
      paperExecutionEnabled: boolean;
      paperOptionsExecutionEnabled: boolean;
    };
  };
  assertPaperOptionsSubmissionEnabled: () => void;
  assertPaperOrderSubmissionEnabled: () => void;
  sanitizeDashboardError: (error: unknown) => {
    status: number;
    body: unknown;
  };
};

const loadGuards = async () =>
  import(pathToFileURL(`${process.cwd()}/apps/dashboard/lib/guards.ts`).href) as Promise<DashboardGuards>;

const loadSafeToken = async () =>
  import(pathToFileURL(`${process.cwd()}/src/lib/safeToken.ts`).href) as Promise<{
    safeTokenEquals: (provided: string | null | undefined, expected: string | null | undefined) => boolean;
  }>;

beforeEach(() => {
  process.env.ALPACA_ENV = "paper";
  process.env.TRADING_MODE = "paper";
  process.env.ALPACA_LIVE_TRADE = "false";
  process.env.LIVE_TRADING_ENABLED = "false";
  process.env.PAPER_ORDER_EXECUTION_ENABLED = "false";
  process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "false";
  process.env.AUTOMATED_PAPER_EXECUTION_ENABLED = "false";
  process.env.DASHBOARD_ADMIN_TOKEN = "dashboard-admin-secret";
});

describe("dashboard paper guards", () => {
  test("safe token comparison handles valid, invalid, missing, different-length, and empty tokens", async () => {
    const { safeTokenEquals } = await loadSafeToken();

    assert.equal(safeTokenEquals("token-value", "token-value"), true);
    assert.equal(safeTokenEquals("token-value", "wrong-token"), false);
    assert.equal(safeTokenEquals(null, "token-value"), false);
    assert.equal(safeTokenEquals("short", "much-longer-token-value"), false);
    assert.equal(safeTokenEquals("token-value", ""), false);
    assert.equal(safeTokenEquals("", "token-value"), false);
  });

  test("allows paper-only dashboard access", async () => {
    const { assertPaperDashboardAccess } = await loadGuards();
    const state = assertPaperDashboardAccess();
    assert.equal(state.alpacaEnv, "paper");
    assert.equal(state.liveTradingEnabled, false);
  });

  test("blocks live environment access", async () => {
    const { assertPaperDashboardAccess } = await loadGuards();
    process.env.ALPACA_ENV = "live";
    assert.throws(
      () => assertPaperDashboardAccess(),
      /ALPACA_ENV=paper/
    );
  });

  test("blocks live trading flags", async () => {
    const { assertPaperDashboardAccess } = await loadGuards();
    process.env.LIVE_TRADING_ENABLED = "true";
    assert.throws(
      () => assertPaperDashboardAccess(),
      /LIVE_TRADING_ENABLED=false/
    );
  });

  test("dashboard admin token guard fails closed", async () => {
    const { assertDashboardAdminToken } = await loadGuards();

    assert.doesNotThrow(() => assertDashboardAdminToken("dashboard-admin-secret"));
    assert.throws(() => assertDashboardAdminToken("bad-token"), /Invalid dashboard admin token/);
    assert.throws(() => assertDashboardAdminToken(null), /Invalid dashboard admin token/);
    assert.throws(() => assertDashboardAdminToken("x"), /Invalid dashboard admin token/);

    process.env.DASHBOARD_ADMIN_TOKEN = "";
    assert.throws(
      () => assertDashboardAdminToken("dashboard-admin-secret"),
      /Dashboard admin token is not configured/
    );
  });

  test("requires explicit paper order and option submission flags", async () => {
    const {
      assertPaperOptionsSubmissionEnabled,
      assertPaperOrderSubmissionEnabled
    } = await loadGuards();
    assert.throws(
      () => assertPaperOrderSubmissionEnabled(),
      /PAPER_ORDER_EXECUTION_ENABLED=true/
    );
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    assert.doesNotThrow(() => assertPaperOrderSubmissionEnabled());

    assert.throws(
      () => assertPaperOptionsSubmissionEnabled(),
      /PAPER_OPTIONS_EXECUTION_ENABLED=true/
    );
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    assert.doesNotThrow(() => assertPaperOptionsSubmissionEnabled());
  });

  test("runtime preflight allows non-execution actions without paper execution flags", async () => {
    const { assertDashboardRuntimePreflight } = await loadGuards();

    const result = assertDashboardRuntimePreflight({ actionType: "research" });
    assert.equal(result.checks.paperOnly, true);
    assert.equal(result.checks.environment, "paper");
    assert.equal(result.checks.tradingMode, "paper");
    assert.equal(result.checks.liveTradingEnabled, false);
    assert.equal(result.checks.paperExecutionEnabled, false);
  });

  test("runtime preflight fails closed for execution drift and live settings", async () => {
    const { assertDashboardRuntimePreflight } = await loadGuards();

    assert.throws(
      () =>
        assertDashboardRuntimePreflight({
          actionType: "confirmed-paper-execution",
          confirmPaper: true,
          requireOptionsExecution: true
        }),
      /Runtime state does not permit this action/
    );

    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    assert.throws(
      () =>
        assertDashboardRuntimePreflight({
          actionType: "confirmed-paper-execution",
          confirmPaper: false,
          requireOptionsExecution: true
        }),
      /Runtime state does not permit this action/
    );

    assert.doesNotThrow(() =>
      assertDashboardRuntimePreflight({
        actionType: "confirmed-paper-execution",
        confirmPaper: true,
        requireOptionsExecution: true
      })
    );

    process.env.LIVE_TRADING_ENABLED = "true";
    assert.throws(
      () => assertDashboardRuntimePreflight({ actionType: "research" }),
      /Runtime state does not permit this action/
    );
  });

  test("sanitizes non-guard errors", async () => {
    const { sanitizeDashboardError } = await loadGuards();
    const sanitized = sanitizeDashboardError(new Error("paper-secret should not leak"));
    assert.equal(JSON.stringify(sanitized).includes("paper-secret"), false);
    assert.equal(sanitized.status, 500);
  });

  test("dashboard source renders paper-only label and safe submit copy", () => {
    const page = readFileSync("apps/dashboard/app/page.tsx", "utf8");
    const actions = readFileSync("apps/dashboard/app/components/ActionPanel.tsx", "utf8");

    assert.match(page, /PAPER ONLY/);
    assert.match(page, /Quote Status/);
    assert.match(page, /Executable Price/);
    assert.match(page, /Reject Reason/);
    assert.match(actions, /Paper Trading Controls/);
    assert.match(actions, /Execute Reviewed Paper Payloads/);
    assert.match(actions, /Requires confirmPaper/);
    assert.doesNotMatch(actions, /Execute Live|Live Trading/);
  });
});
