import { after, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetSqliteTestDb } from "./helpers/sqliteTestDb.js"

const dbDir = mkdtempSync(join(tmpdir(), "alpaca-autonomous-recovery-"))
process.env.RESEARCH_DB_PATH = join(dbDir, "research.db")
process.env.TRADING_MODE = "paper"
process.env.ALPACA_LIVE_TRADE = "false"
process.env.LIVE_TRADING_ENABLED = "false"
process.env.ALPACA_ENV = "paper"

import { closeDbForTests, getDb } from "../src/lib/db.js"
import {
  applyAutonomousRecovery,
  getAutonomousRecoveryStatus
} from "../src/services/autonomousRecoveryService.js"

interface TableColumn {
  name: string
  notnull: number
  dflt_value: unknown
}

const oldTimestamp = (): string => new Date(Date.now() - 20 * 60_000).toISOString()

const requiredFallback = (column: string, startedAt: string): string | number => {
  if (column === "status") return "running"
  if (column === "started_at") return startedAt
  if (column === "action_type") return "paper.ops.morning"
  if (column === "trigger_source") return "scheduler"
  if (column.endsWith("_json")) return "{}"
  if (column.includes("count") || column.includes("scanned") || column.includes("written")) return 0
  if (column.includes("sha") || column.includes("hash") || column.includes("version")) return "test"
  return "test"
}

const insertRunningRow = (
  table: string,
  id: string,
  startedAt: string,
  extra: Record<string, string | number | null> = {}
): void => {
  const db = getDb()
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as TableColumn[]
  const values: Record<string, string | number | null> = { id, status: "running", started_at: startedAt, ...extra }

  for (const column of columns) {
    if (column.name in values || !column.notnull || column.dflt_value !== null) continue
    values[column.name] = requiredFallback(column.name, startedAt)
  }

  const names = columns.map((column) => column.name).filter((name) => name in values)
  db.prepare(
    `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`
  ).run(...names.map((name) => values[name]))
}

const resetDatabase = () => {
  resetSqliteTestDb(getDb(), `
    DELETE FROM autonomous_recovery_events;
    DELETE FROM autonomous_recovery_runs;
    DELETE FROM universe_lifecycle_events;
    DELETE FROM universe_lifecycle_runs;
    DELETE FROM paper_learning_governance_decisions;
    DELETE FROM paper_learning_governance_runs;
    DELETE FROM paper_operation_log;
    DELETE FROM research_runs;
  `)
}

beforeEach(() => {
  resetDatabase()
})

after(() => {
  closeDbForTests()
  rmSync(dbDir, { recursive: true, force: true })
})

describe("autonomous recovery service", () => {
  test("terminalizes stale local records with immutable recovery evidence", () => {
    const startedAt = oldTimestamp()
    const db = getDb()

    insertRunningRow("universe_lifecycle_runs", "stale-lifecycle", startedAt)
    insertRunningRow("paper_learning_governance_runs", "stale-governance", startedAt)
    insertRunningRow("paper_operation_log", "stale-paper-ops", startedAt, {
      action_type: "paper.ops.morning",
      trigger_source: "scheduler"
    })
    insertRunningRow("research_runs", "stale-research", startedAt, {
      heartbeat_at: startedAt,
      worker_identity: "test-worker:123",
      request_id: "test-request",
      correlation_id: "test-correlation"
    })

    const previousGitSha = process.env.GIT_SHA
    process.env.GIT_SHA = "test-recovery-sha"
    const result = (() => {
      try {
        return applyAutonomousRecovery()
      } finally {
        if (previousGitSha === undefined) {
          delete process.env.GIT_SHA
        } else {
          process.env.GIT_SHA = previousGitSha
        }
      }
    })()

    assert.deepEqual(result.recovered, {
      universeLifecycleRuns: 1,
      learningGovernanceRuns: 1,
      paperOperations: 1,
      researchRuns: 1
    })
    assert.equal(
      (db.prepare("SELECT status FROM universe_lifecycle_runs WHERE id = ?").get("stale-lifecycle") as { status: string }).status,
      "failed"
    )
    assert.equal(
      (db.prepare("SELECT error_message FROM paper_learning_governance_runs WHERE id = ?").get("stale-governance") as { error_message: string }).error_message,
      "RECOVERED_INCOMPLETE_RUN"
    )
    assert.equal(
      (db.prepare("SELECT error_message FROM paper_operation_log WHERE id = ?").get("stale-paper-ops") as { error_message: string }).error_message,
      "RECOVERED_INCOMPLETE_OPERATION"
    )
    const research = db.prepare(
      "SELECT status, recovery_reason, recovery_source, worker_identity FROM research_runs WHERE id = ?"
    ).get("stale-research") as {
      status: string
      recovery_reason: string
      recovery_source: string
      worker_identity: string
    }
    assert.deepEqual({ ...research }, {
      status: "failed",
      recovery_reason: "WORKER_TERMINATED_OR_HEARTBEAT_EXPIRED",
      recovery_source: "autonomous_recovery",
      worker_identity: "test-worker:123"
    })
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM autonomous_recovery_events").get() as { count: number }).count,
      4
    )
    assert.equal(result.gitSha, "test-recovery-sha")
    assert.equal(
      (db.prepare("SELECT git_sha FROM autonomous_recovery_events LIMIT 1").get() as { git_sha: string }).git_sha,
      "test-recovery-sha"
    )
  })

  test("leaves fresh and execution records untouched and does not repeat recovery", () => {
    const db = getDb()
    const freshTimestamp = new Date().toISOString()

    insertRunningRow("universe_lifecycle_runs", "fresh-lifecycle", freshTimestamp)
    insertRunningRow("paper_operation_log", "execution-operation", oldTimestamp(), {
      action_type: "paper.execute",
      trigger_source: "scheduler"
    })
    insertRunningRow("research_runs", "fresh-research", freshTimestamp, {
      heartbeat_at: freshTimestamp
    })

    const first = applyAutonomousRecovery()
    const second = applyAutonomousRecovery()
    const status = getAutonomousRecoveryStatus()

    assert.deepEqual(first.recovered, {
      universeLifecycleRuns: 0,
      learningGovernanceRuns: 0,
      paperOperations: 0,
      researchRuns: 0
    })
    assert.deepEqual(second.recovered, first.recovered)
    assert.equal(
      (db.prepare("SELECT status FROM universe_lifecycle_runs WHERE id = ?").get("fresh-lifecycle") as { status: string }).status,
      "running"
    )
    assert.equal(
      (db.prepare("SELECT status FROM paper_operation_log WHERE id = ?").get("execution-operation") as { status: string }).status,
      "running"
    )
    assert.equal(
      (db.prepare("SELECT status FROM research_runs WHERE id = ?").get("fresh-research") as { status: string }).status,
      "running"
    )
    assert.equal(status.staleCounts.universeLifecycleRuns, 0)
    assert.equal(status.staleCounts.researchRuns, 0)
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM autonomous_recovery_events").get() as { count: number }).count,
      0
    )
  })
})
