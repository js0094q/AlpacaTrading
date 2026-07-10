import { after, afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const originalFetch = globalThis.fetch;
const tempRoots: string[] = [];

const deleteEnv = (name: string) => {
  delete process.env[name];
};

const importRoute = async <T>(path: string): Promise<T> => {
  const url = pathToFileURL(`${process.cwd()}/${path}`);
  return import(`${url.href}?case=${Date.now()}-${Math.random()}`) as Promise<T>;
};

const readJson = async (response: Response) => ({
  status: response.status,
  body: await response.json() as any
});

const configureVercelPaperEnv = () => {
  process.env.VERCEL = "1";
  process.env.ALPACA_ENV = "paper";
  process.env.TRADING_MODE = "paper";
  process.env.ALPACA_LIVE_TRADE = "false";
  process.env.LIVE_TRADING_ENABLED = "false";
  process.env.PAPER_ORDER_EXECUTION_ENABLED = "false";
  process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "false";

  [
    "ALPACA_PAPER_API_KEY",
    "ALPACA_PAPER_KEY",
    "ALPACA_API_KEY",
    "ALPACA_PAPER_SECRET_KEY",
    "ALPACA_PAPER_SECRET",
    "ALPACA_SECRET_KEY",
    "APCA_API_KEY_ID",
    "APCA_API_SECRET_KEY",
    "DASHBOARD_ADMIN_TOKEN",
    "DASHBOARD_DATABASE_URL"
  ].forEach(deleteEnv);
};

beforeEach(() => {
  configureVercelPaperEnv();
  globalThis.fetch = async () => {
    throw new Error("Unexpected network call in Vercel fallback test.");
  };
});

afterEach(() => {
  deleteEnv("VERCEL");
  deleteEnv("RESEARCH_DB_PATH");
  deleteEnv("DASHBOARD_ADMIN_TOKEN");
  deleteEnv("DASHBOARD_DATABASE_URL");
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Vercel dashboard read-only fallback", () => {
  test("shared SQLite guard rejects Vercel app bundle paths", async () => {
    process.env.RESEARCH_DB_PATH = "/var/task/apps/dashboard/data/research.db";

    const { getDb, LOCAL_SQLITE_UNAVAILABLE_ON_VERCEL } = await importRoute<{
      getDb: () => unknown;
      LOCAL_SQLITE_UNAVAILABLE_ON_VERCEL: string;
    }>("src/lib/db.ts");

    assert.throws(
      () => getDb(),
      (error) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code ===
          LOCAL_SQLITE_UNAVAILABLE_ON_VERCEL
    );
  });

  test("historical route returns fallback without creating app data directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "alpaca-dashboard-vercel-"));
    tempRoots.push(root);
    const dataDir = join(root, "apps", "dashboard", "data");
    process.env.RESEARCH_DB_PATH = join(dataDir, "research.db");

    const { GET } = await importRoute<{ GET: () => Promise<Response> | Response }>(
      "apps/dashboard/app/api/paper/research/latest/route.ts"
    );
    const { status, body } = await readJson(await GET());

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.mode, "vercel-read-only");
    assert.deepEqual(body.data, []);
    assert.match(body.warning, /Historical runtime data is stored on the VPS/);
    assert.equal(existsSync(dataDir), false);
  });

  test("summary route returns Vercel read-only historical state", async () => {
    const { GET } = await importRoute<{ GET: () => Promise<Response> | Response }>(
      "apps/dashboard/app/api/paper/summary/route.ts"
    );
    const { status, body } = await readJson(await GET());

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.mode, "vercel-read-only");
    assert.equal(body.data.historicalDataAvailable, false);
    assert.deepEqual(body.data.latestResearch, []);
    assert.deepEqual(body.data.latestPaperPlans, []);
    assert.deepEqual(body.data.optionContracts, []);
    assert.deepEqual(body.data.requestIds, []);
    assert.equal(body.data.account.ok, false);
    assert.equal(body.data.account.error, "DASHBOARD_ALPACA_ENV_NOT_CONFIGURED");
    assert.equal(JSON.stringify(body).includes("paper-secret"), false);
  });

  test("account route reports missing paper env without leaking secrets", async () => {
    const { GET } = await importRoute<{ GET: () => Promise<Response> | Response }>(
      "apps/dashboard/app/api/paper/account/route.ts"
    );
    const { status, body } = await readJson(await GET());

    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.error, "DASHBOARD_ALPACA_ENV_NOT_CONFIGURED");
    assert.equal(JSON.stringify(body).includes("paper-secret"), false);
  });

  test("account route enforces paper Alpaca environment", async () => {
    process.env.ALPACA_ENV = "live";

    const { GET } = await importRoute<{ GET: () => Promise<Response> | Response }>(
      "apps/dashboard/app/api/paper/account/route.ts"
    );
    const { status, body } = await readJson(await GET());

    assert.equal(status, 403);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "PAPER_ENV_REQUIRED");
  });

  test("historical routes fail closed when live trading is enabled", async () => {
    process.env.LIVE_TRADING_ENABLED = "true";

    const { GET } = await importRoute<{ GET: () => Promise<Response> | Response }>(
      "apps/dashboard/app/api/paper/research/latest/route.ts"
    );
    const { status, body } = await readJson(await GET());

    assert.equal(status, 403);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "LIVE_TRADING_MUST_BE_DISABLED");
  });

  test("Vercel submit route stays disabled even when paper submit env vars are true", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    process.env.DASHBOARD_ADMIN_TOKEN = "dashboard-admin-secret";

    const { POST } = await importRoute<{
      POST: (request: Request) => Promise<Response> | Response;
    }>("apps/dashboard/app/api/paper/execute/confirm/route.ts");
    const response = await POST(new Request("http://localhost/api/paper/execute/confirm", {
      method: "POST",
      headers: {
        authorization: "Bearer dashboard-admin-secret"
      },
      body: JSON.stringify({ assetClass: "equity" })
    }));
    const { status, body } = await readJson(response);

    assert.equal(status, 403);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "PAPER_ORDER_EXECUTION_DISABLED_ON_VERCEL");
  });

  test("historical fallback response does not include configured secret values", async () => {
    process.env.ALPACA_PAPER_API_KEY = "paper-key-that-must-not-leak";
    process.env.ALPACA_PAPER_SECRET_KEY = "paper-secret-that-must-not-leak";

    const { GET } = await importRoute<{ GET: () => Promise<Response> | Response }>(
      "apps/dashboard/app/api/paper/plan/latest/route.ts"
    );
    const response = await GET();
    const text = await response.text();

    assert.equal(text.includes("paper-key-that-must-not-leak"), false);
    assert.equal(text.includes("paper-secret-that-must-not-leak"), false);
  });
});
