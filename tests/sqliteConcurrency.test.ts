import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";

const dbDir = mkdtempSync(join(tmpdir(), "alpaca-sqlite-concurrency-"));
const dbPath = join(dbDir, "research.db");
process.env.RESEARCH_DB_PATH = dbPath;
process.env.SQLITE_BUSY_TIMEOUT_MS = "25";
process.env.TRADING_MODE = "paper";
process.env.ALPACA_ENV = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";

const [{ closeDbForTests, configureDatabaseConnection, getDb, initializeDatabaseHandle }, lifecycle] = await Promise.all([
  import("../src/lib/db.js"),
  import("../src/services/researchRunLifecycleService.js")
]);
const { isSqliteBusyError, runWithSqliteBusyRetry } = await import("../src/lib/sqliteConcurrency.js");
const { withHeavyPersistenceLease } = await import("../src/services/sqliteWriteLeaseService.js");

const runId = "research-sqlite-concurrency-test";

const startHolder = async (holdMs: number) => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "tests/helpers/sqliteConcurrencyWorker.ts", "hold-writer", dbPath, String(holdMs)],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }
  );
  let stdout = "";
  let stderr = "";
  let ready = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const done = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.once("error", (error) => {
      if (!ready) rejectReady(error instanceof Error ? error : new Error(String(error)));
      reject(error);
    });
    child.once("close", (code) => {
      if (!ready) rejectReady(new Error(`writer exited before ready: ${stderr}`));
      resolve({ code, stderr });
    });
  });
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
    if (!ready && stdout.includes("ready\n")) {
      ready = true;
      resolveReady();
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const timeout = setTimeout(() => {
    if (!ready) rejectReady(new Error(`writer did not become ready: ${stderr}`));
  }, 2_000);
  await readyPromise;
  clearTimeout(timeout);
  return { done };
};

before(() => {
  initializeDatabaseHandle(getDb());
  getDb()
    .prepare(`
      INSERT INTO research_runs(
        id, started_at, heartbeat_at, status, risk_profile, options_enabled,
        universe_size, targets_generated, candidates_selected, error_message,
        config_json
      ) VALUES (?, ?, ?, 'running', 'moderate', 1, 0, 0, 0, NULL, '{}')
    `)
    .run(runId, new Date().toISOString(), new Date().toISOString());
});

after(() => {
  closeDbForTests();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("steady-state SQLite contention", () => {
  test("every relevant connection applies the bounded busy timeout and foreign-key guard", () => {
    const direct = new DatabaseSync(dbPath);
    configureDatabaseConnection(direct);
    assert.equal(
      (direct.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout,
      25
    );
    assert.equal(
      (direct.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys,
      1
    );
    direct.close();
    assert.equal(
      (getDb().prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout,
      25
    );
  });

  test("busy retry is bounded and non-idempotent writes are never retried blindly", () => {
    const busyError = Object.assign(new Error("database is locked"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 5
    });
    assert.equal(isSqliteBusyError(busyError), true);
    assert.equal(
      isSqliteBusyError(Object.assign(new Error("database table is locked"), { errcode: 6 })),
      false
    );
    let attempts = 0;
    const sleeps: number[] = [];
    const events: string[] = [];
    assert.throws(
      () => runWithSqliteBusyRetry(
        () => {
          attempts += 1;
          throw busyError;
        },
        {
          operation: "test.busy_bound",
          transaction: "test_transaction",
          runId,
          idempotent: true,
          maxAttempts: 3,
          retryDelayMs: 7,
          sleep: (milliseconds) => sleeps.push(milliseconds),
          emit: (event) => events.push(event.outcome)
        }
      ),
      /database is locked/
    );
    assert.equal(attempts, 3);
    assert.deepEqual(sleeps, [7, 7]);
    assert.deepEqual(events, ["retry", "retry", "failed"]);

    attempts = 0;
    events.length = 0;
    const retryResult = runWithSqliteBusyRetry(
      () => {
        attempts += 1;
        if (attempts < 3) throw busyError;
        return "completed";
      },
      {
        operation: "test.retry_success",
        transaction: "test_transaction",
        runId,
        correlationId: "correlation-test",
        idempotent: true,
        maxAttempts: 4,
        retryDelayMs: 0,
        sleep: () => undefined,
        emit: (event) => events.push(`${event.outcome}:${event.retryCount}`)
      }
    );
    assert.equal(retryResult, "completed");
    assert.equal(attempts, 3);
    assert.deepEqual(events, ["retry:1", "retry:2", "success:2"]);

    attempts = 0;
    events.length = 0;
    assert.throws(
      () => runWithSqliteBusyRetry(
        () => {
          attempts += 1;
          throw busyError;
        },
        {
          operation: "test.non_idempotent",
          transaction: "test_transaction",
          idempotent: false,
          maxAttempts: 8,
          sleep: () => {
            throw new Error("must not sleep");
          },
          emit: (event) => events.push(event.outcome)
        }
      ),
      /database is locked/
    );
    assert.equal(attempts, 1);
    assert.deepEqual(events, ["not_retried"]);
  });

  test("a lost heavy persistence lease prevents further writes", () => {
    let writes = 0;
    assert.throws(
      () => withHeavyPersistenceLease({
        maxWaitMs: 100,
        operation: (lease) => {
          getDb()
            .prepare(
              "UPDATE runtime_write_leases SET owner_id = ?, expires_at = ? WHERE lease_name = ?"
            )
            .run("other-process", new Date(Date.now() + 60_000).toISOString(), lease.leaseName);
          lease.assertOwnership();
          writes += 1;
        }
      }),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code === "SQLITE_WRITE_LEASE_LOST"
    );
    assert.equal(writes, 0);
    getDb().prepare("DELETE FROM runtime_write_leases").run();
  });

  test("heartbeat succeeds while a representative scheduled writer holds DELETE-journal lock", async () => {
    const holder = await startHolder(200);
    assert.equal(lifecycle.heartbeatResearchRun(runId), true);
    const result = await holder.done;
    assert.equal(result.code, 0, result.stderr);
  });

  test("research reaches a terminal status after the writer releases", () => {
    assert.equal(lifecycle.heartbeatResearchRun(runId), true);
    lifecycle.finishResearchRun(runId, {
      status: "completed",
      targetsGenerated: 1,
      candidatesSelected: 0,
      summaryJson: JSON.stringify({ warnings: [] })
    });
    const row = getDb()
      .prepare("SELECT status, targets_generated FROM research_runs WHERE id = ?")
      .get(runId) as { status: string; targets_generated: number };
    assert.deepEqual({ status: row.status, targets_generated: row.targets_generated }, {
      status: "completed",
      targets_generated: 1
    });
  });
});
