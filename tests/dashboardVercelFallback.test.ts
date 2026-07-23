import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const importRoute = async <T>(path: string): Promise<T> => {
  const url = pathToFileURL(`${process.cwd()}/${path}`);
  return import(`${url.href}?case=${Date.now()}-${Math.random()}`) as Promise<T>;
};

const responseJson = async (response: Response) => ({
  status: response.status,
  body: await response.json() as Record<string, unknown>
});

beforeEach(() => {
  process.env.VERCEL = "1";
  process.env.ALPACA_ENV = "paper";
  process.env.TRADING_MODE = "paper";
  process.env.ALPACA_LIVE_TRADE = "false";
  process.env.LIVE_TRADING_ENABLED = "false";
  process.env.PAPER_ORDER_EXECUTION_ENABLED = "false";
  process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "false";
  delete process.env.VPS_CONTROL_BASE_URL;
  delete process.env.PAPER_DASHBOARD_BRIDGE_URL;
  delete process.env.VPS_CONTROL_TOKEN;
  delete process.env.PAPER_DASHBOARD_BRIDGE_TOKEN;
});

afterEach(() => {
  delete process.env.VERCEL;
});

describe("Vercel dashboard PostgreSQL bridge requirement", () => {
  test("local dashboard action helpers are disabled", () => {
    const source = readFileSync("apps/dashboard/lib/data.ts", "utf8");
    assert.match(source, /runPaperConfirm[\s\S]*POSTGRES_ONLY_RUNTIME_PATH_DISABLED/);
    assert.doesNotMatch(source, /mode:\s*"local-sqlite"/);
    assert.doesNotMatch(source, /queryAll<|queryAllRows/);
  });

  test("summary fails closed without the PostgreSQL bridge", async () => {
    const { GET } = await importRoute<{ GET: () => Promise<Response> }>(
      "apps/dashboard/app/api/paper/summary/route.ts"
    );
    const response = await responseJson(await GET());
    assert.equal(response.status, 503);
    assert.equal(response.body.ok, false);
    assert.equal(
      (response.body.error as Record<string, unknown>).code,
      "DASHBOARD_POSTGRES_BRIDGE_REQUIRED"
    );
  });

  test("historical endpoints do not return an empty SQLite fallback", async () => {
    const { GET } = await importRoute<{ GET: () => Promise<Response> }>(
      "apps/dashboard/app/api/paper/research/latest/route.ts"
    );
    const response = await responseJson(await GET());
    assert.equal(response.status, 503);
    assert.equal(response.body.ok, false);
    assert.equal(
      (response.body.error as Record<string, unknown>).code,
      "DASHBOARD_POSTGRES_BRIDGE_REQUIRED"
    );
  });

  test("broker account endpoint also requires PostgreSQL authority", async () => {
    const { GET } = await importRoute<{ GET: () => Promise<Response> }>(
      "apps/dashboard/app/api/paper/account/route.ts"
    );
    const response = await responseJson(await GET());
    assert.equal(response.status, 503);
    assert.equal(
      (response.body.error as Record<string, unknown>).code,
      "DASHBOARD_POSTGRES_BRIDGE_REQUIRED"
    );
  });

  test("live trading remains rejected before bridge resolution", async () => {
    process.env.LIVE_TRADING_ENABLED = "true";
    const { GET } = await importRoute<{ GET: () => Promise<Response> }>(
      "apps/dashboard/app/api/paper/summary/route.ts"
    );
    const response = await responseJson(await GET());
    assert.equal(response.status, 403);
    assert.equal(
      (response.body.error as Record<string, unknown>).code,
      "LIVE_TRADING_MUST_BE_DISABLED"
    );
  });
});
