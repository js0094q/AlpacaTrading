import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { initializeDatabaseHandle } from "../src/lib/db.js";

const tempDir = mkdtempSync(join(tmpdir(), "alpaca-hedge-cli-test-"));
const packageJson = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf8")
) as { scripts: Record<string, string | undefined> };

const safeEnv = {
  ...process.env,
  RESEARCH_DB_PATH: join(tempDir, "research.db"),
  ALPACA_ENV: "paper",
  TRADING_MODE: "paper",
  ALPACA_LIVE_TRADE: "false",
  LIVE_TRADING_ENABLED: "false",
  HEDGE_PAPER_EXECUTION_ENABLED: "false",
  ALPACA_PAPER_API_KEY: "test-key",
  ALPACA_PAPER_SECRET_KEY: "test-secret",
  ALPACA_PAPER_BASE_URL: "http://127.0.0.1:1",
  ALPACA_REQUEST_TIMEOUT_MS: "100",
  ALPACA_MAX_RETRIES: "0"
};

const fixtureDb = new DatabaseSync(safeEnv.RESEARCH_DB_PATH);
initializeDatabaseHandle(fixtureDb);
fixtureDb.close();

const runHedgeCli = (script: string, args: string[]) => {
  const command = script === "hedge:execute" ? "hedge:execute" : script;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./tests/helpers/enableSqliteFixtureInitialization.mjs",
      "src/cli.ts",
      command,
      ...args
    ],
    {
    cwd: process.cwd(),
    env: safeEnv,
    encoding: "utf8",
    timeout: 15_000
    }
  );
  return {
    ...result,
    json: result.stdout.trim() ? JSON.parse(result.stdout) as Record<string, unknown> : null
  };
};

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("production package restores only the PostgreSQL-backed hedge review workflow", () => {
  assert.equal(packageJson.scripts["hedge:review"], "tsx src/postgresOnlyCli.ts hedge:review");
  for (const script of [
    "hedge:risk",
    "hedge:regime",
    "hedge:plan",
    "hedge:execute"
  ]) {
    assert.equal(packageJson.scripts[script], undefined, script);
  }
});

test("hedge execute fails closed before broker access when the paper flag is disabled", () => {
  const result = runHedgeCli("hedge:execute", ["--confirmPaper", "--reviewId=missing", "--format=json"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json?.status, "blocked");
  assert.ok((result.json?.blockers as string[]).includes("HEDGE_EXECUTION_DISABLED"));
});

test("hedge plan requires explicit paperOnly before account work", () => {
  const result = runHedgeCli("hedge:plan", ["--format=json"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json?.status, "blocked");
  assert.equal(result.json?.artifact, null);
  assert.ok(
    (result.json?.blockers as string[]).includes("HEDGE_PAPER_ONLY_CONFIRMATION_REQUIRED")
  );
});

test("hedge risk emits blocked evidence instead of fabricating data", () => {
  const result = runHedgeCli("hedge:risk", ["--format=json"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json?.paperOnly, true);
  assert.equal(result.json?.environment, "paper");
  assert.equal(result.json?.dataQualityStatus, "blocked");
  assert.equal(result.stdout.includes("test-secret"), false);
});

test("hedge regime emits deterministic JSON from persisted evidence", () => {
  const result = runHedgeCli("hedge:regime", ["--format=json"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json?.paperOnly, true);
  assert.equal(result.json?.regime, "insufficient-data");
});

test("legacy paper-only hedge plan never exposes submission payloads", () => {
  const plan = runHedgeCli("hedge:plan", ["--paperOnly", "--format=json"]);

  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(plan.json?.paperOnly, true);
  assert.equal(plan.stdout.includes("client_order_id"), false);
  assert.equal(plan.stdout.includes("test-secret"), false);
});
