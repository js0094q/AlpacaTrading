import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

process.env.DASHBOARD_CONTROL_NO_START = "1";
process.env.VPS_CONTROL_TOKEN = "synthetic-control-token";
process.env.ALPACA_ENV = "paper";
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";

const module = await import("../server/dashboard-control/server.js");

const passedAuthority = {
  authority: "postgres",
  sqliteRuntimeRole: "none",
  latestCheckpoint: {
    id: "postgres-authority-cutover-test",
    status: "passed",
    baselineType: "fresh_postgresql_authority_cutover",
    historicalSqliteReconciliation: false
  }
};

const dashboardData = {
  latestResearch: [{ id: "research-1", status: "completed" }],
  latestPaperPlans: [{ id: "candidate-1", decision: "blocked" }],
  reviews: [{ id: "review-1", status: "blocked" }],
  executions: [],
  optionContracts: [],
  readyIntentCount: 0,
  requestIds: ["request-1"]
};

const workerHealth = {
  status: "running" as const,
  active: true,
  lastEventType: "cycle_completed",
  lastEventAt: "2026-07-22T15:00:00.000Z",
  cycleId: "cycle-1",
  lastCycleCompletedAt: "2026-07-22T15:00:00.000Z"
};

const zeroDteSummary = {
  paperOnly: true as const,
  generatedAt: "2026-07-22T15:00:00.000Z",
  tradingDate: "2026-07-22",
  engine: { enabled: true, lastRunAt: null, status: "blocked", queueSize: 0, staleDataCount: 0 },
  queue: [],
  paperPositions: [],
  shadowTrades: [],
  lifecycle: { counts: {}, recent: [] },
  learning: null,
  blockers: ["NO_CURRENT_POSTGRES_ZERO_DTE_CANDIDATES"]
};

let scheduledCommands: string[];
let server: Server;
let port = 0;

const call = async (
  path: string,
  method: "GET" | "POST" = "GET",
  token?: string,
  body?: Record<string, unknown>
) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return {
    status: response.status,
    payload: await response.json() as Record<string, unknown>
  };
};

before(async () => {
  server = module.createControlServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS_MISSING");
      port = address.port;
      resolve();
    });
  });
});

beforeEach(() => {
  scheduledCommands = [];
  module.setControlDependenciesForTests({
    authorityStatus: async () => passedAuthority,
    account: async () => ({ paperOnly: true, account: { status: "ACTIVE" } }) as never,
    positions: async () => ({ paperOnly: true, positions: [] }) as never,
    openOrders: async () => ({ paperOnly: true, orders: [] }) as never,
    dashboardData: async () => dashboardData,
    workerHealth: async () => workerHealth,
    zeroDteSummary: async () => zeroDteSummary,
    scheduledCommand: async (command) => {
      scheduledCommands.push(command);
      return {
        paperOnly: true,
        status: "blocked",
        code: "NO_ELIGIBLE_POSTGRES_CANDIDATES",
        blockers: ["NO_ELIGIBLE_POSTGRES_CANDIDATES"]
      };
    }
  });
});

after(async () => {
  module.setControlDependenciesForTests(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("PostgreSQL-only dashboard control", () => {
  test("registers PostgreSQL reads and guarded paper actions", () => {
    for (const path of [
      "/api/v1/health",
      "/api/v1/postgres-authority/status",
      "/api/v1/account",
      "/api/v1/positions",
      "/api/v1/orders",
      "/api/v1/summary",
      "/api/v1/zero-dte/summary"
    ]) {
      assert.equal(module.ACTION_HANDLERS[path]?.method, "GET");
    }
    for (const path of [
      "/api/v1/actions/research/run",
      "/api/v1/actions/portfolio/review",
      "/api/v1/actions/options/discover",
      "/api/v1/actions/review",
      "/api/v1/actions/execute",
      "/api/v1/execute/confirm",
      "/api/v1/orders/cancel",
      "/api/v1/refresh"
    ]) {
      assert.equal(module.ACTION_HANDLERS[path]?.method, "POST");
      assert.equal(module.ACTION_HANDLERS[path]?.requireAdminToken, true);
    }
  });

  test("health derives autonomousWorker from persisted worker evidence", async () => {
    const response = await call("/api/v1/health");
    assert.equal(response.status, 200);
    const data = response.payload.data as Record<string, unknown>;
    assert.equal(data.paperOnly, true);
    assert.equal(data.liveTradingEnabled, false);
    assert.equal(data.autonomousWorker, "running");
    assert.deepEqual(data.worker, workerHealth);
    assert.deepEqual(data.authority, passedAuthority);
  });

  test("summary is PostgreSQL-backed and preserves blocked domain decisions", async () => {
    const response = await call("/api/v1/summary");
    assert.equal(response.status, 200);
    const data = response.payload.data as Record<string, unknown>;
    assert.equal(data.mode, "postgres-only-authority");
    assert.equal(JSON.stringify(data).includes("POSTGRES_ONLY_RUNTIME_PATH_DISABLED"), false);
    assert.equal((data.plan as Record<string, unknown>).ok, true);
    assert.equal(((data.plan as Record<string, unknown>).data as Record<string, unknown>).plan instanceof Array, true);
  });

  test("0DTE summary is a PostgreSQL read and returns blocked state as data", async () => {
    const response = await call("/api/v1/zero-dte/summary");
    assert.equal(response.status, 200);
    const data = response.payload.data as Record<string, unknown>;
    assert.equal(data.paperOnly, true);
    assert.equal((data.engine as Record<string, unknown>).status, "blocked");
    assert.deepEqual(data.blockers, ["NO_CURRENT_POSTGRES_ZERO_DTE_CANDIDATES"]);
  });

  test("action routes require the control token", async () => {
    const response = await call("/api/v1/actions/portfolio/review", "POST");
    assert.equal(response.status, 401);
    assert.equal(
      (response.payload.error as Record<string, unknown>).code,
      "CONTROL_TOKEN_INVALID"
    );
  });

  test("routes guarded paper actions to PostgreSQL workflows", async () => {
    const response = await call(
      "/api/v1/actions/portfolio/review",
      "POST",
      "synthetic-control-token",
      { riskProfile: "aggressive", optionsEnabled: true }
    );
    assert.equal(response.status, 200);
    assert.equal(response.payload.status, "blocked");
    assert.deepEqual(scheduledCommands, ["paper:portfolio:review"]);
  });

  test("rejects non-paper action runtime before invoking a workflow", async () => {
    process.env.ALPACA_ENV = "live";
    try {
      const response = await call(
        "/api/v1/actions/research/run",
        "POST",
        "synthetic-control-token"
      );
      assert.equal(response.status, 503);
      assert.equal(
        (response.payload.error as Record<string, unknown>).code,
        "PAPER_RUNTIME_REQUIRED"
      );
      assert.deepEqual(scheduledCommands, []);
    } finally {
      process.env.ALPACA_ENV = "paper";
    }
  });

  test("requires confirmPaper for reviewed execution and does not invoke submission", async () => {
    const response = await call(
      "/api/v1/actions/execute",
      "POST",
      "synthetic-control-token",
      {}
    );
    assert.equal(response.status, 200);
    assert.equal(response.payload.status, "blocked");
    assert.equal(
      ((response.payload.data as Record<string, unknown>).code),
      "PAPER_CONFIRMATION_REQUIRED"
    );
    assert.deepEqual(scheduledCommands, []);
  });

  test("routes confirmed paper cancellation through the PostgreSQL workflow", async () => {
    const response = await call(
      "/api/v1/orders/cancel",
      "POST",
      "synthetic-control-token",
      {
        brokerOrderId: "paper-order-123",
        clientOrderId: "E2E-CANCEL-123",
        confirmPaper: true
      }
    );
    assert.equal(response.status, 200);
    assert.deepEqual(scheduledCommands, ["paper:order:cancel"]);
  });

  test("non-mutating guarded refresh returns current PostgreSQL summary", async () => {
    const response = await call(
      "/api/v1/refresh",
      "POST",
      "synthetic-control-token",
      {}
    );
    assert.equal(response.status, 200);
    assert.equal((response.payload.data as Record<string, unknown>).mode, "postgres-only-authority");
    assert.deepEqual(scheduledCommands, []);
  });

  test("audit log records no control token", async () => {
    const directory = mkdtempSync(join(tmpdir(), "postgres-dashboard-audit-"));
    const path = join(directory, "audit.jsonl");
    process.env.VPS_CONTROL_AUDIT_PATH = path;
    const response = await call("/api/v1/health");
    assert.equal(response.status, 200);
    const audit = readFileSync(path, "utf8");
    assert.match(audit, /"action":"health"/);
    assert.doesNotMatch(audit, /synthetic-control-token/);
    delete process.env.VPS_CONTROL_AUDIT_PATH;
  });
});
