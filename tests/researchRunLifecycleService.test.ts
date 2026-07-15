import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";

const dbDir = mkdtempSync(join(tmpdir(), "alpaca-research-lifecycle-"));
const dbPath = join(dbDir, "research.db");
process.env.RESEARCH_DB_PATH = dbPath;
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_ENV = "paper";

const [libDb, lifecycle] = await Promise.all([
  import("../src/lib/db.js"),
  import("../src/services/researchRunLifecycleService.js")
]);

const { closeDbForTests, getDb } = libDb;
const {
  RESEARCH_RECOVERY_REASON,
  RESEARCH_RUN_STALE_AFTER_MS,
  recoverStaleResearchRuns,
  reserveResearchRun,
  updateResearchRunUniverseSize,
  withActiveResearchRunLease
} = lifecycle;

const now = new Date("2026-07-15T16:00:00.000Z");
const old = new Date(now.getTime() - RESEARCH_RUN_STALE_AFTER_MS - 1_000).toISOString();
const fresh = new Date(now.getTime() - 60_000).toISOString();

const spawnLifecycle = (...args: string[]) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "tests/helpers/runResearchLifecycle.ts", ...args],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

const insertRun = (input: {
  id: string;
  startedAt: string;
  heartbeatAt?: string;
  workerIdentity?: string;
  requestId?: string;
  correlationId?: string;
}) => {
  getDb()
    .prepare(`
      INSERT INTO research_runs(
        id, started_at, heartbeat_at, status, risk_profile, options_enabled,
        universe_size, targets_generated, candidates_selected, error_message,
        config_json, summary_json, worker_identity, request_id, correlation_id
      ) VALUES (?, ?, ?, 'running', 'moderate', 0, 0, 0, 0, NULL, '{}', NULL, ?, ?, ?)
    `)
    .run(
      input.id,
      input.startedAt,
      input.heartbeatAt || input.startedAt,
      input.workerIdentity || null,
      input.requestId || null,
      input.correlationId || null
    );
};

beforeEach(() => {
  getDb().exec("DELETE FROM research_runs");
});

after(() => {
  closeDbForTests();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("research run lifecycle", () => {
  test("universe progress updates only the reserved active run", () => {
    const reservation = reserveResearchRun({
      runId: "research-progress",
      now,
      riskProfile: "balanced",
      optionsEnabled: true,
      configJson: "{}"
    });
    assert.equal(reservation.status, "reserved");

    const heartbeatAt = new Date("2026-07-15T16:01:00.000Z");
    updateResearchRunUniverseSize("research-progress", 42, heartbeatAt);

    const row = getDb()
      .prepare(
        "SELECT universe_size, heartbeat_at FROM research_runs WHERE id = 'research-progress'"
      )
      .get() as { universe_size: number; heartbeat_at: string };
    assert.equal(row.universe_size, 42);
    assert.equal(row.heartbeat_at, heartbeatAt.toISOString());
  });

  test("refuses durable work when the persisted research lease is no longer active", () => {
    insertRun({ id: "lost-before-persistence", startedAt: fresh, heartbeatAt: fresh });
    getDb()
      .prepare(`
        UPDATE research_runs
        SET status = 'failed', completed_at = ?, recovery_reason = 'TEST_LEASE_RECOVERY'
        WHERE id = 'lost-before-persistence'
      `)
      .run(now.toISOString());
    let operationCalled = false;

    assert.throws(
      () =>
        withActiveResearchRunLease("lost-before-persistence", () => {
          operationCalled = true;
        }),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code === "RESEARCH_RUN_LEASE_LOST"
    );
    assert.equal(operationCalled, false);
    assert.equal(
      (getDb()
        .prepare("SELECT status FROM research_runs WHERE id = 'lost-before-persistence'")
        .get() as { status: string }).status,
      "failed"
    );
  });

  test("terminalizes stale running rows with retained interruption evidence", () => {
    insertRun({
      id: "stale-run",
      startedAt: old,
      heartbeatAt: old,
      workerIdentity: "vps-worker:123",
      requestId: "request-1",
      correlationId: "correlation-1"
    });

    const recovered = recoverStaleResearchRuns({
      now,
      source: "autonomous_recovery"
    });
    const row = getDb()
      .prepare("SELECT * FROM research_runs WHERE id = 'stale-run'")
      .get() as Record<string, unknown>;

    assert.equal(recovered.length, 1);
    assert.equal(row.status, "failed");
    assert.equal(row.completed_at, now.toISOString());
    assert.equal(row.recovered_at, now.toISOString());
    assert.equal(row.recovery_reason, RESEARCH_RECOVERY_REASON);
    assert.equal(row.recovery_source, "autonomous_recovery");
    assert.equal(row.worker_identity, "vps-worker:123");
    assert.equal(row.request_id, "request-1");
    assert.equal(row.correlation_id, "correlation-1");
    assert.equal(recovered[0]?.lastHeartbeatAt, old);
  });

  test("leaves a fresh active run running and reports it as already_running", () => {
    insertRun({ id: "fresh-run", startedAt: fresh, heartbeatAt: fresh });

    assert.deepEqual(
      recoverStaleResearchRuns({ now, source: "autonomous_recovery" }),
      []
    );
    const reservation = reserveResearchRun({
      runId: "replacement",
      now,
      riskProfile: "moderate",
      optionsEnabled: false,
      configJson: "{}"
    });

    assert.deepEqual(reservation, {
      status: "already_running",
      activeRunId: "fresh-run",
      startedAt: fresh,
      heartbeatAt: fresh
    });
    assert.equal(
      (getDb().prepare("SELECT status FROM research_runs WHERE id = 'fresh-run'").get() as { status: string }).status,
      "running"
    );
  });

  test("recovery is idempotent and compare-and-set prevents a double transition", () => {
    insertRun({ id: "stale-once", startedAt: old });

    const first = recoverStaleResearchRuns({ now, source: "autonomous_recovery" });
    const second = recoverStaleResearchRuns({ now, source: "autonomous_recovery" });

    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
    assert.equal(
      (getDb().prepare("SELECT COUNT(*) AS count FROM research_runs WHERE recovery_reason = ?").get(RESEARCH_RECOVERY_REASON) as { count: number }).count,
      1
    );
  });

  test("concurrent recovery workers transition a stale row exactly once", async () => {
    insertRun({ id: "stale-concurrent", startedAt: old });

    const results = await Promise.all([
      spawnLifecycle("recover", dbPath, now.toISOString()),
      spawnLifecycle("recover", dbPath, now.toISOString())
    ]);

    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
    }
    const recoveredCounts = results
      .map((result) => JSON.parse(result.stdout).recovered as number)
      .sort();
    assert.deepEqual(recoveredCounts, [0, 1]);
    assert.equal(
      (getDb()
        .prepare("SELECT COUNT(*) AS count FROM research_runs WHERE id = 'stale-concurrent' AND status = 'failed'")
        .get() as { count: number }).count,
      1
    );
  });

  test("concurrent reservations create one active run and return one already_running result", async () => {
    const results = await Promise.all([
      spawnLifecycle("reserve", dbPath, now.toISOString(), "concurrent-a"),
      spawnLifecycle("reserve", dbPath, now.toISOString(), "concurrent-b")
    ]);

    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
    }
    const statuses = results
      .map((result) => JSON.parse(result.stdout).status as string)
      .sort();
    assert.deepEqual(statuses, ["already_running", "reserved"]);
    assert.equal(
      (getDb()
        .prepare("SELECT COUNT(*) AS count FROM research_runs WHERE status = 'running'")
        .get() as { count: number }).count,
      1
    );
  });

  test("stale recovery completes before a replacement run is reserved", () => {
    insertRun({ id: "stale-before-replacement", startedAt: old });

    const reservation = reserveResearchRun({
      runId: "replacement-run",
      now,
      riskProfile: "moderate",
      optionsEnabled: false,
      configJson: "{}",
      requestId: "replacement-request"
    });

    assert.equal(reservation.status, "reserved");
    assert.equal(
      (getDb().prepare("SELECT status FROM research_runs WHERE id = 'stale-before-replacement'").get() as { status: string }).status,
      "failed"
    );
    assert.deepEqual(
      {
        ...(getDb()
          .prepare("SELECT status, request_id FROM research_runs WHERE id = 'replacement-run'")
          .get() as Record<string, unknown>)
      },
      { status: "running", request_id: "replacement-request" }
    );
  });
});
