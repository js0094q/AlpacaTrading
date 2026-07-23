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
const {
  classifySqliteContentionError,
  isSqliteBusyError,
  runWithSqliteBusyRetry
} = await import("../src/lib/sqliteConcurrency.js");
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

  test("classifies SQLITE_BUSY and SQLITE_LOCKED across numeric, named, and message forms", () => {
    const cases: Array<[unknown, "busy" | "locked" | null]> = [
      [Object.assign(new Error("sqlite error"), { errcode: 5 }), "busy"],
      [Object.assign(new Error("sqlite error"), { errcode: 5 | (2 << 8) }), "busy"],
      [Object.assign(new Error("unrelated"), { code: "ERR_SQLITE_ERROR", errcode: 5 }), "busy"],
      [Object.assign(new Error("sqlite error"), { code: "SQLITE_BUSY_SNAPSHOT" }), "busy"],
      [new Error("database is locked"), "busy"],
      [Object.assign(new Error("sqlite error"), { errcode: 6 }), "locked"],
      [Object.assign(new Error("sqlite error"), { errno: 6 | (1 << 8) }), "locked"],
      [Object.assign(new Error("unrelated"), { code: "ERR_SQLITE_ERROR", errno: 6 }), "locked"],
      [Object.assign(new Error("sqlite error"), { code: "SQLITE_LOCKED_SHAREDCACHE" }), "locked"],
      [new Error("database table is locked"), "locked"],
      [Object.assign(new Error("constraint failed"), { code: "SQLITE_CONSTRAINT" }), null],
      [Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" }), null],
      [new Error("application validation failed"), null]
    ];

    for (const [error, expected] of cases) {
      assert.equal(classifySqliteContentionError(error), expected);
    }
    assert.equal(isSqliteBusyError(new Error("database is locked")), true);
    assert.equal(isSqliteBusyError(new Error("database table is locked")), false);
  });

  test("retries only explicitly safe SQLITE_BUSY and SQLITE_LOCKED operations", () => {
    const busyError = Object.assign(new Error("database is locked"), { errcode: 5 });
    const lockedError = Object.assign(new Error("database table is locked"), {
      code: "SQLITE_LOCKED_SHAREDCACHE"
    });
    let attempts = 0;
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
          retryDelayMs: 0,
          sleep: () => undefined,
          emit: (event) => events.push(event.outcome)
        }
      ),
      /database is locked/
    );
    assert.equal(attempts, 3);
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
          random: () => {
            throw new Error("must not randomize");
          },
          emit: (event) => events.push(event.outcome)
        }
      ),
      /database is locked/
    );
    assert.equal(attempts, 1);
    assert.deepEqual(events, ["not_retried"]);

    attempts = 0;
    const lockedResult = runWithSqliteBusyRetry(
      () => {
        attempts += 1;
        if (attempts === 1) throw lockedError;
        return "transaction completed";
      },
      {
        operation: "test.transactionally_safe",
        transaction: "test_transaction",
        idempotent: false,
        transactionallySafe: true,
        maxAttempts: 2,
        retryDelayMs: 0,
        sleep: () => undefined
      }
    );
    assert.equal(lockedResult, "transaction completed");
    assert.equal(attempts, 2);
  });

  test("uses bounded exponential jittered backoff and emits deadline-aware telemetry", () => {
    const busyError = Object.assign(new Error("database is locked"), { errcode: 5 });
    let now = 1_000;
    const sleeps: number[] = [];
    const events: Array<Record<string, unknown>> = [];
    const randomValues = [0, 1];
    let attempts = 0;

    const result = runWithSqliteBusyRetry(
      () => {
        attempts += 1;
        if (attempts < 3) throw busyError;
        return "completed";
      },
      {
        operation: "test.jittered_backoff",
        transaction: "test_transaction",
        idempotent: true,
        maxAttempts: 4,
        retryDelayMs: 10,
        maxRetryDelayMs: 25,
        jitterRatio: 0.2,
        retryDeadlineMs: 100,
        now: () => now,
        random: () => randomValues.shift() ?? 0.5,
        sleep: (milliseconds) => {
          sleeps.push(milliseconds);
          now += milliseconds;
        },
        emit: (event) => events.push(event as unknown as Record<string, unknown>)
      }
    );

    assert.equal(result, "completed");
    assert.equal(attempts, 3);
    assert.deepEqual(sleeps, [8, 24]);
    assert.deepEqual(events.map((event) => event.outcome), ["retry", "retry", "success"]);
    assert.deepEqual(events.slice(0, 2).map((event) => event.contentionClass), ["busy", "busy"]);
    assert.deepEqual(events.slice(0, 2).map((event) => event.delayMs), [8, 24]);
    assert.deepEqual(events.slice(0, 2).map((event) => event.deadlineAtMs), [1_100, 1_100]);
    assert.deepEqual(events.slice(0, 2).map((event) => event.remainingDeadlineMs), [100, 92]);
  });

  test("redacts secret-bearing contention errors before telemetry emission", () => {
    const connectionUrl = "postgresql://operator:synthetic-url-password@db.example/neondb?token=synthetic-query-token";
    const password = "synthetic-dsn-password";
    const busyError = Object.assign(
      new Error(`database is locked while opening ${connectionUrl} password=${password}`),
      { errcode: 5 }
    );
    const events: Array<{ errorMessage?: string | null }> = [];

    assert.throws(
      () => runWithSqliteBusyRetry(
        () => {
          throw busyError;
        },
        {
          operation: "test.redacted_telemetry",
          idempotent: true,
          maxAttempts: 2,
          retryDelayMs: 0,
          sleep: () => undefined,
          emit: (event) => events.push(event)
        }
      ),
      /database is locked/
    );

    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(
        event.errorMessage,
        "database is locked while opening [REDACTED:POSTGRES_CONNECTION_URL] password=[REDACTED]"
      );
      assert.ok(!event.errorMessage?.includes(connectionUrl));
      assert.ok(!event.errorMessage?.includes(password));
    }
  });

  test("stops at the total retry deadline and rethrows the exact final causal error", () => {
    const firstError = Object.assign(new Error("database is locked first"), { errcode: 5 });
    const finalError = Object.assign(new Error("database is locked final"), { errcode: 5 });
    let now = 500;
    let attempts = 0;
    const sleeps: number[] = [];
    const events: Array<Record<string, unknown>> = [];
    let thrown: unknown;

    try {
      runWithSqliteBusyRetry(
        () => {
          attempts += 1;
          throw attempts === 1 ? firstError : finalError;
        },
        {
          operation: "test.deadline",
          transaction: "test_transaction",
          idempotent: true,
          maxAttempts: 4,
          retryDelayMs: 10,
          retryDeadlineMs: 15,
          jitterRatio: 0,
          now: () => now,
          random: () => 0.5,
          sleep: (milliseconds) => {
            sleeps.push(milliseconds);
            now += milliseconds;
          },
          emit: (event) => events.push(event as unknown as Record<string, unknown>)
        }
      );
    } catch (error) {
      thrown = error;
    }

    assert.strictEqual(thrown, finalError);
    assert.equal(attempts, 2);
    assert.deepEqual(sleeps, [10]);
    assert.deepEqual(events.map((event) => event.outcome), ["retry", "failed"]);
    assert.equal(events[1].deadlineAtMs, 515);
    assert.equal(events[1].remainingDeadlineMs, 5);
    assert.equal(events[1].delayMs, 20);
  });

  test("does not start another operation when sleep reaches or overshoots the deadline", () => {
    const causalError = Object.assign(new Error("database is locked before oversleep"), {
      errcode: 5
    });
    let now = 1_000;
    let attempts = 0;
    const events: Array<Record<string, unknown>> = [];
    let thrown: unknown;

    try {
      runWithSqliteBusyRetry(
        () => {
          attempts += 1;
          throw causalError;
        },
        {
          operation: "test.deadline_oversleep",
          idempotent: true,
          maxAttempts: 4,
          retryDelayMs: 5,
          retryDeadlineMs: 10,
          jitterRatio: 0,
          now: () => now,
          sleep: () => {
            now += 10;
          },
          emit: (event) => events.push(event as unknown as Record<string, unknown>)
        }
      );
    } catch (error) {
      thrown = error;
    }

    assert.strictEqual(thrown, causalError);
    assert.equal(attempts, 1);
    assert.deepEqual(events.map((event) => event.outcome), ["retry", "failed"]);
    assert.equal(events[1].remainingDeadlineMs, 0);
    assert.equal(events[1].delayMs, null);
  });

  test("does not retry validation, constraint, corruption, or application errors", () => {
    const errors = [
      Object.assign(new Error("validation failed"), { code: "SQLITE_CONSTRAINT" }),
      Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" }),
      new Error("application validation failed")
    ];

    for (const error of errors) {
      let attempts = 0;
      let thrown: unknown;
      try {
        runWithSqliteBusyRetry(
          () => {
            attempts += 1;
            throw error;
          },
          {
            operation: "test.non_contention",
            idempotent: true,
            sleep: () => {
              throw new Error("must not sleep");
            },
            random: () => {
              throw new Error("must not randomize");
            }
          }
        );
      } catch (caught) {
        thrown = caught;
      }
      assert.strictEqual(thrown, error);
      assert.equal(attempts, 1);
    }
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

  test("duplicate reservation rejects before the writer transaction while the active lease is fresh", async () => {
    const holder = await startHolder(500);
    assert.deepEqual(
      lifecycle.reserveResearchRun({
        runId: "duplicate-while-writing",
        now: new Date(),
        riskProfile: "moderate",
        optionsEnabled: true,
        configJson: "{}"
      }),
      {
        status: "already_running",
        activeRunId: runId,
        startedAt: (getDb()
          .prepare("SELECT started_at FROM research_runs WHERE id = ?")
          .get(runId) as { started_at: string }).started_at,
        heartbeatAt: (getDb()
          .prepare("SELECT heartbeat_at FROM research_runs WHERE id = ?")
          .get(runId) as { heartbeat_at: string }).heartbeat_at
      }
    );
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
