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

let server: Server;
let port = 0;

const call = async (
  path: string,
  method: "GET" | "POST" = "GET",
  token?: string
) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined
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
  module.setControlDependenciesForTests({
    authorityStatus: async () => passedAuthority,
    account: async () => ({ paperOnly: true, account: { status: "ACTIVE" } }) as never,
    positions: async () => ({ paperOnly: true, positions: [] }) as never,
    openOrders: async () => ({ paperOnly: true, orders: [] }) as never
  });
});

after(async () => {
  module.setControlDependenciesForTests(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("PostgreSQL-only dashboard control", () => {
  test("exports only broker/PostgreSQL reads plus explicitly disabled mutations", () => {
    for (const path of [
      "/api/v1/health",
      "/api/v1/postgres-authority/status",
      "/api/v1/account",
      "/api/v1/positions",
      "/api/v1/orders",
      "/api/v1/summary"
    ]) {
      assert.equal(module.ACTION_HANDLERS[path]?.method, "GET");
    }
    assert.equal(module.ACTION_HANDLERS["/api/v1/research/run"]?.method, "POST");
    assert.equal(module.ACTION_HANDLERS["/api/v1/execute/confirm"]?.method, "POST");
  });

  test("health proves paper-only PostgreSQL authority", async () => {
    const response = await call("/api/v1/health");
    assert.equal(response.status, 200);
    const data = response.payload.data as Record<string, unknown>;
    assert.equal(data.paperOnly, true);
    assert.equal(data.liveTradingEnabled, false);
    assert.equal(data.autonomousWorker, "stopped_pending_audit");
    assert.deepEqual(data.authority, passedAuthority);
  });

  test("summary contains no SQLite-backed sections", async () => {
    const response = await call("/api/v1/summary");
    assert.equal(response.status, 200);
    const data = response.payload.data as Record<string, unknown>;
    assert.equal(data.mode, "postgres-only-authority");
    assert.equal(data.durableStorageConfigured, true);
    assert.match(JSON.stringify(data), /POSTGRES_ONLY_RUNTIME_PATH_DISABLED/);
    assert.doesNotMatch(JSON.stringify(data), /local-sqlite|research\.db/i);
  });

  test("retired mutation routes are authenticated and fail closed", async () => {
    const unauthenticated = await call("/api/v1/research/run", "POST");
    assert.equal(unauthenticated.status, 401);
    assert.equal(
      (unauthenticated.payload.error as Record<string, unknown>).code,
      "CONTROL_TOKEN_INVALID"
    );

    const disabled = await call(
      "/api/v1/research/run",
      "POST",
      "synthetic-control-token"
    );
    assert.equal(disabled.status, 503);
    assert.equal(
      (disabled.payload.error as Record<string, unknown>).code,
      "POSTGRES_ONLY_RUNTIME_PATH_DISABLED"
    );
  });

  test("PostgreSQL authority failure returns 503 without fallback", async () => {
    module.setControlDependenciesForTests({
      authorityStatus: async () => {
        throw new Error("synthetic postgres unavailable");
      },
      account: async () => ({}) as never,
      positions: async () => ({}) as never,
      openOrders: async () => ({}) as never
    });
    const response = await call("/api/v1/summary");
    assert.equal(response.status, 503);
    assert.equal(
      (response.payload.error as Record<string, unknown>).code,
      "POSTGRES_AUTHORITY_UNAVAILABLE"
    );
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
