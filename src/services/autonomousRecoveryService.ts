import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"

import { getDb } from "../lib/db.js"
import {
  RESEARCH_RECOVERY_REASON,
  RESEARCH_RUN_STALE_AFTER_MS,
  countStaleResearchRuns,
  recoverStaleResearchRunsInTransaction
} from "./researchRunLifecycleService.js"
import { assertScheduledWriteFenceActive } from "./controlPlaneRuntimeContext.js"

export const AUTONOMOUS_RECOVERY_CONFIG_VERSION = "autonomous-recovery-v1"

const RECOVERY_POLICY = {
  universeLifecycleStaleAfterMs: 90_000,
  learningGovernanceStaleAfterMs: 5 * 60_000,
  paperOperationStaleAfterMs: 15 * 60_000,
  researchRunStaleAfterMs: RESEARCH_RUN_STALE_AFTER_MS,
  recoverablePaperOperationActions: [
    "paper.ops.morning",
    "paper.ops.midday",
    "paper.ops.late_day",
    "paper.ops.review"
  ]
} as const

const RECOVERY_CODE = "RECOVERED_INCOMPLETE_RUN"
const PAPER_OPERATION_RECOVERY_CODE = "RECOVERED_INCOMPLETE_OPERATION"

interface StaleRow {
  id: string
  started_at: string
}

interface PaperOperationRow extends StaleRow {
  action_type: string
  blockers_json: string | null
}

export interface AutonomousRecoveryResult {
  id: string
  startedAt: string
  completedAt: string
  status: "completed"
  recovered: {
    universeLifecycleRuns: number
    learningGovernanceRuns: number
    paperOperations: number
    researchRuns: number
  }
  gitSha: string
  configVersion: string
  configHash: string
}

const getConfigHash = (): string =>
  createHash("sha256")
    .update(JSON.stringify(RECOVERY_POLICY))
    .digest("hex")

const getGitSha = (): string => {
  const configured =
    process.env.GIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || process.env.SOURCE_VERSION
  if (configured?.trim()) {
    return configured.trim()
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim() || "unknown"
  } catch {
    return "unknown"
  }
}

const getCutoff = (now: Date, staleAfterMs: number): string =>
  new Date(now.getTime() - staleAfterMs).toISOString()

const getStaleRows = (
  table: "universe_lifecycle_runs" | "paper_learning_governance_runs",
  cutoff: string
): StaleRow[] =>
  getDb()
    .prepare(
      `SELECT id, started_at FROM ${table} WHERE status = 'running' AND started_at <= ? ORDER BY started_at ASC`
    )
    .all(cutoff) as unknown as StaleRow[]

const getStalePaperOperations = (cutoff: string): PaperOperationRow[] => {
  const placeholders = RECOVERY_POLICY.recoverablePaperOperationActions
    .map(() => "?")
    .join(", ")

  return getDb()
    .prepare(
      `SELECT id, started_at, action_type, blockers_json FROM paper_operation_log ` +
        `WHERE status = 'running' AND started_at <= ? AND action_type IN (${placeholders}) ` +
        "ORDER BY started_at ASC"
    )
    .all(cutoff, ...RECOVERY_POLICY.recoverablePaperOperationActions) as unknown as PaperOperationRow[]
}

const appendRecoveryBlocker = (blockersJson: string | null): string => {
  let blockers: string[] = []
  try {
    const parsed = blockersJson ? JSON.parse(blockersJson) : []
    blockers = Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : []
  } catch {
    blockers = []
  }
  return JSON.stringify([...new Set([...blockers, PAPER_OPERATION_RECOVERY_CODE])])
}

const writeRecoveryEvent = (input: {
  recoveryRunId: string
  sourceTable: string
  source: StaleRow
  recoveredAt: string
  recoveryCode: string
  staleAfterMs: number
  gitSha: string
  configHash: string
  extraEvidence?: Record<string, unknown>
}): void => {
  getDb()
    .prepare(
      `INSERT INTO autonomous_recovery_events (
        id, recovery_run_id, source_table, source_id, previous_status,
        recovery_code, recovered_at, evidence_json, git_sha, config_version, config_hash
      ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `autonomous_recovery_event_${randomUUID()}`,
      input.recoveryRunId,
      input.sourceTable,
      input.source.id,
      input.recoveryCode,
      input.recoveredAt,
      JSON.stringify({
        startedAt: input.source.started_at,
        staleAfterMs: input.staleAfterMs,
        ...(input.extraEvidence ?? {})
      }),
      input.gitSha,
      AUTONOMOUS_RECOVERY_CONFIG_VERSION,
      input.configHash
    )
}

const markStaleLifecycleRunsFailed = (rows: StaleRow[], recoveredAt: string): StaleRow[] => {
  const statement = getDb().prepare(
    `UPDATE universe_lifecycle_runs
     SET status = 'failed',
         completed_at = COALESCE(completed_at, ?),
         error_summary = COALESCE(error_summary, ?)
     WHERE id = ? AND status = 'running'`
  )
  for (const row of rows) {
    statement.run(recoveredAt, RECOVERY_CODE, row.id)
  }
  return rows
}

const markStaleLearningGovernanceRunsFailed = (
  rows: StaleRow[],
  recoveredAt: string
): StaleRow[] => {
  const statement = getDb().prepare(
    `UPDATE paper_learning_governance_runs
     SET status = 'failed',
         completed_at = COALESCE(completed_at, ?),
         error_message = COALESCE(error_message, ?)
     WHERE id = ? AND status = 'running'`
  )
  for (const row of rows) {
    statement.run(recoveredAt, RECOVERY_CODE, row.id)
  }
  return rows
}

const markStalePaperOperationsFailed = (
  rows: PaperOperationRow[],
  recoveredAt: string
): PaperOperationRow[] => {
  const statement = getDb().prepare(
    `UPDATE paper_operation_log
     SET status = 'failed',
         finished_at = COALESCE(finished_at, ?),
         blockers_json = ?,
         error_message = COALESCE(error_message, ?)
     WHERE id = ? AND status = 'running'`
  )
  for (const row of rows) {
    statement.run(
      recoveredAt,
      appendRecoveryBlocker(row.blockers_json),
      PAPER_OPERATION_RECOVERY_CODE,
      row.id
    )
  }
  return rows
}

export const applyAutonomousRecovery = (now = new Date()): AutonomousRecoveryResult => {
  assertScheduledWriteFenceActive()
  const db = getDb()
  const startedAt = now.toISOString()
  const id = `autonomous_recovery_${randomUUID()}`
  const gitSha = getGitSha()
  const configHash = getConfigHash()

  db.prepare(
    `INSERT INTO autonomous_recovery_runs (
      id, started_at, status, git_sha, config_version, config_hash
    ) VALUES (?, ?, 'running', ?, ?, ?)`
  ).run(id, startedAt, gitSha, AUTONOMOUS_RECOVERY_CONFIG_VERSION, configHash)

  try {
    db.exec("BEGIN IMMEDIATE")
    const lifecycleRows = getStaleRows(
      "universe_lifecycle_runs",
      getCutoff(now, RECOVERY_POLICY.universeLifecycleStaleAfterMs)
    )
    const learningRows = getStaleRows(
      "paper_learning_governance_runs",
      getCutoff(now, RECOVERY_POLICY.learningGovernanceStaleAfterMs)
    )
    const paperOperationRows = getStalePaperOperations(
      getCutoff(now, RECOVERY_POLICY.paperOperationStaleAfterMs)
    )
    const recoveredAt = new Date().toISOString()
    const recoveredLifecycleRows = markStaleLifecycleRunsFailed(lifecycleRows, recoveredAt)
    const recoveredLearningRows = markStaleLearningGovernanceRunsFailed(learningRows, recoveredAt)
    const recoveredPaperOperations = markStalePaperOperationsFailed(paperOperationRows, recoveredAt)
    const recoveredResearchRuns = recoverStaleResearchRunsInTransaction({
      db,
      now: new Date(recoveredAt),
      source: "autonomous_recovery"
    })

    for (const row of recoveredLifecycleRows) {
      writeRecoveryEvent({
        recoveryRunId: id,
        sourceTable: "universe_lifecycle_runs",
        source: row,
        recoveredAt,
        recoveryCode: RECOVERY_CODE,
        staleAfterMs: RECOVERY_POLICY.universeLifecycleStaleAfterMs,
        gitSha,
        configHash
      })
    }
    for (const row of recoveredLearningRows) {
      writeRecoveryEvent({
        recoveryRunId: id,
        sourceTable: "paper_learning_governance_runs",
        source: row,
        recoveredAt,
        recoveryCode: RECOVERY_CODE,
        staleAfterMs: RECOVERY_POLICY.learningGovernanceStaleAfterMs,
        gitSha,
        configHash
      })
    }
    for (const row of recoveredPaperOperations) {
      writeRecoveryEvent({
        recoveryRunId: id,
        sourceTable: "paper_operation_log",
        source: row,
        recoveredAt,
        recoveryCode: PAPER_OPERATION_RECOVERY_CODE,
        staleAfterMs: RECOVERY_POLICY.paperOperationStaleAfterMs,
        gitSha,
        configHash,
        extraEvidence: { actionType: row.action_type }
      })
    }
    for (const row of recoveredResearchRuns) {
      writeRecoveryEvent({
        recoveryRunId: id,
        sourceTable: "research_runs",
        source: { id: row.id, started_at: row.startedAt },
        recoveredAt,
        recoveryCode: RESEARCH_RECOVERY_REASON,
        staleAfterMs: RECOVERY_POLICY.researchRunStaleAfterMs,
        gitSha,
        configHash,
        extraEvidence: {
          lastHeartbeatAt: row.lastHeartbeatAt,
          workerIdentity: row.workerIdentity,
          requestId: row.requestId,
          correlationId: row.correlationId
        }
      })
    }

    const recovered = {
      universeLifecycleRuns: recoveredLifecycleRows.length,
      learningGovernanceRuns: recoveredLearningRows.length,
      paperOperations: recoveredPaperOperations.length,
      researchRuns: recoveredResearchRuns.length
    }
    const completedAt = new Date().toISOString()
    db.prepare(
      `UPDATE autonomous_recovery_runs
       SET status = 'completed',
           completed_at = ?,
           recovered_universe_lifecycle_runs = ?,
           recovered_learning_governance_runs = ?,
           recovered_paper_operations = ?,
           recovered_research_runs = ?
       WHERE id = ?`
    ).run(
      completedAt,
      recovered.universeLifecycleRuns,
      recovered.learningGovernanceRuns,
      recovered.paperOperations,
      recovered.researchRuns,
      id
    )
    assertScheduledWriteFenceActive()
    db.exec("COMMIT")

    return {
      id,
      startedAt,
      completedAt,
      status: "completed",
      recovered,
      gitSha,
      configVersion: AUTONOMOUS_RECOVERY_CONFIG_VERSION,
      configHash
    }
  } catch (error) {
    try {
      db.exec("ROLLBACK")
    } catch {
      // The transaction may not have started.
    }
    try {
      assertScheduledWriteFenceActive()
      db.prepare(
        `UPDATE autonomous_recovery_runs
         SET status = 'failed', completed_at = ?, error_message = ?
         WHERE id = ?`
      ).run(
        new Date().toISOString(),
        error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
        id
      )
    } catch {
      // A stale worker must not write even its terminal status.
    }
    throw error
  }
}

export const getAutonomousRecoveryStatus = (now = new Date()) => {
  const db = getDb()
  return {
    policy: {
      configVersion: AUTONOMOUS_RECOVERY_CONFIG_VERSION,
      configHash: getConfigHash(),
      ...RECOVERY_POLICY
    },
    latestRun: db
      .prepare("SELECT * FROM autonomous_recovery_runs ORDER BY started_at DESC LIMIT 1")
      .get() ?? null,
    staleCounts: {
      universeLifecycleRuns: getStaleRows(
        "universe_lifecycle_runs",
        getCutoff(now, RECOVERY_POLICY.universeLifecycleStaleAfterMs)
      ).length,
      learningGovernanceRuns: getStaleRows(
        "paper_learning_governance_runs",
        getCutoff(now, RECOVERY_POLICY.learningGovernanceStaleAfterMs)
      ).length,
      paperOperations: getStalePaperOperations(
        getCutoff(now, RECOVERY_POLICY.paperOperationStaleAfterMs)
      ).length,
      researchRuns: countStaleResearchRuns(now, db)
    }
  }
}
