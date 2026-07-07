import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type DashboardGuards = {
  assertPaperDashboardAccess: () => {
    alpacaEnv: string;
    liveTradingEnabled: boolean;
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

beforeEach(() => {
  process.env.ALPACA_ENV = "paper";
  process.env.TRADING_MODE = "paper";
  process.env.ALPACA_LIVE_TRADE = "false";
  process.env.LIVE_TRADING_ENABLED = "false";
  process.env.PAPER_ORDER_EXECUTION_ENABLED = "false";
  process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "false";
});

describe("dashboard paper guards", () => {
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
