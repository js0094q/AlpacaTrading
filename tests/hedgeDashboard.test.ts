import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";

const dbDir = mkdtempSync(join(tmpdir(), "alpaca-hedge-dashboard-test-"));
process.env.RESEARCH_DB_PATH = join(dbDir, "research.db");
process.env.DASHBOARD_CONTROL_NO_START = "1";
process.env.ALPACA_ENV = "paper";
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.HEDGE_PAPER_EXECUTION_ENABLED = "false";

const routePaths = [
  "apps/dashboard/app/api/paper/hedge/risk/route.ts",
  "apps/dashboard/app/api/paper/hedge/regime/route.ts",
  "apps/dashboard/app/api/paper/hedge/recommendation/route.ts"
];

let serverModule: {
  ACTION_HANDLERS: Record<string, {
    method: string;
    requireAdminToken: boolean;
    requireMutationPrecheck: boolean;
    handler: (input: unknown, requestId: string) => Promise<unknown>;
  }>;
  setControlCommandRunner: (runner: (...args: unknown[]) => Promise<unknown>) => void;
  setOpenOrdersFetcher: (fetcher: () => Promise<unknown>) => void;
  resetControlTestHooks: () => void;
};

before(async () => {
  const url = pathToFileURL(join(process.cwd(), "server/dashboard-control/server.ts"));
  serverModule = await import(`${url.href}?hedge-dashboard=${Date.now()}`) as typeof serverModule;
});

after(async () => {
  serverModule.resetControlTestHooks();
  const { closeDbForTests } = await import("../src/lib/db.js");
  closeDbForTests();
  rmSync(dbDir, { recursive: true, force: true });
});

test("dashboard hedge route files expose GET only", () => {
  for (const path of routePaths) {
    const source = readFileSync(join(process.cwd(), path), "utf8");
    assert.match(source, /export const GET/);
    assert.doesNotMatch(source, /export const POST|guardedPost|hedge:execute/);
    assert.match(source, /runtime = "nodejs"/);
  }
});

test("control hedge routes are cached GET reads with no command or order calls", async () => {
  let commandCalls = 0;
  let orderCalls = 0;
  serverModule.setControlCommandRunner(async () => {
    commandCalls += 1;
    return {};
  });
  serverModule.setOpenOrdersFetcher(async () => {
    orderCalls += 1;
    return [];
  });

  for (const path of [
    "/api/v1/hedge/risk",
    "/api/v1/hedge/regime",
    "/api/v1/hedge/recommendation"
  ]) {
    const route = serverModule.ACTION_HANDLERS[path];
    assert.equal(route?.method, "GET");
    assert.equal(route?.requireAdminToken, false);
    assert.equal(route?.requireMutationPrecheck, false);
    await route.handler({}, "hedge-dashboard-request");
  }

  assert.equal(commandCalls, 0);
  assert.equal(orderCalls, 0);
});

test("expired recommendation remains expired through the Vercel bridge", async () => {
  const originalFetch = globalThis.fetch;
  process.env.VERCEL = "1";
  process.env.VPS_CONTROL_BASE_URL = "https://vps.internal:4100";
  process.env.VPS_CONTROL_TOKEN = "bridge-secret";
  let calledUrl = "";
  globalThis.fetch = async (input) => {
    calledUrl = String(input);
    return new Response(
      JSON.stringify({
        ok: true,
        data: {
          recommendationId: "expired-recommendation",
          effectiveStatus: "expired",
          generatedAt: "2026-07-10T13:00:00.000Z",
          expiresAt: "2026-07-10T13:30:00.000Z"
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const url = pathToFileURL(
      join(process.cwd(), "apps/dashboard/app/api/paper/hedge/recommendation/route.ts")
    );
    const { GET } = await import(`${url.href}?expired=${Date.now()}`) as {
      GET: (request?: Request) => Promise<Response> | Response;
    };
    const response = await GET();
    const payload = await response.json() as {
      ok: true;
      data: { effectiveStatus: string };
    };

    assert.equal(response.status, 200);
    assert.equal(calledUrl, "https://vps.internal:4100/api/v1/hedge/recommendation");
    assert.equal(payload.data.effectiveStatus, "expired");
    assert.notEqual(payload.data.effectiveStatus, "current");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.VERCEL;
    delete process.env.VPS_CONTROL_BASE_URL;
    delete process.env.VPS_CONTROL_TOKEN;
  }
});
