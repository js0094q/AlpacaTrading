import { hostname } from "node:os";
import type { DatabaseSync as DbHandle } from "node:sqlite";

import { getDb } from "../lib/db.js";
import { runWithSqliteBusyRetry } from "../lib/sqliteConcurrency.js";

export const RESEARCH_RUN_STALE_AFTER_MS = 15 * 60_000;
export const RESEARCH_RECOVERY_REASON =
  "WORKER_TERMINATED_OR_HEARTBEAT_EXPIRED";

export interface RecoverableResearchRun {
  id: string;
  startedAt: string;
  lastHeartbeatAt: string;
  workerIdentity: string | null;
  requestId: string | null;
  correlationId: string | null;
}

export class ResearchRunLeaseLostError extends Error {
  readonly code = "RESEARCH_RUN_LEASE_LOST";

  constructor(runId: string) {
    super(`Research run ${runId} lost its active lifecycle lease.`);
    this.name = "ResearchRunLeaseLostError";
  }
}

interface ResearchRunRow {
  id: string;
  started_at: string;
  heartbeat_at: string | null;
  worker_identity: string | null;
  request_id: string | null;
  correlation_id: string | null;
}

const cutoffIso = (now: Date): string =>
  new Date(now.getTime() - RESEARCH_RUN_STALE_AFTER_MS).toISOString();

const staleRows = (db: DbHandle, now: Date): ResearchRunRow[] =>
  db
    .prepare(`
      SELECT id, started_at, heartbeat_at, worker_identity, request_id, correlation_id
      FROM research_runs
      WHERE status = 'running'
        AND COALESCE(heartbeat_at, started_at) <= ?
      ORDER BY started_at ASC
    `)
    .all(cutoffIso(now)) as unknown as ResearchRunRow[];

export const countStaleResearchRuns = (
  now = new Date(),
  db: DbHandle = getDb()
): number => staleRows(db, now).length;

export const recoverStaleResearchRunsInTransaction = (input: {
  db: DbHandle;
  now: Date;
  source: string;
}): RecoverableResearchRun[] => {
  const rows = staleRows(input.db, input.now);
  const statement = input.db.prepare(`
    UPDATE research_runs
    SET status = 'failed',
        completed_at = COALESCE(completed_at, ?),
        error_message = COALESCE(error_message, ?),
        recovered_at = COALESCE(recovered_at, ?),
        recovery_reason = COALESCE(recovery_reason, ?),
        recovery_source = COALESCE(recovery_source, ?)
    WHERE id = ?
      AND status = 'running'
      AND COALESCE(heartbeat_at, started_at) <= ?
  `);
  const recovered: RecoverableResearchRun[] = [];
  const recoveredAt = input.now.toISOString();
  const cutoff = cutoffIso(input.now);
  for (const row of rows) {
    const result = statement.run(
      recoveredAt,
      RESEARCH_RECOVERY_REASON,
      recoveredAt,
      RESEARCH_RECOVERY_REASON,
      input.source,
      row.id,
      cutoff
    );
    if (Number(result.changes) !== 1) {
      continue;
    }
    recovered.push({
      id: row.id,
      startedAt: row.started_at,
      lastHeartbeatAt: row.heartbeat_at || row.started_at,
      workerIdentity: row.worker_identity,
      requestId: row.request_id,
      correlationId: row.correlation_id
    });
  }
  return recovered;
};

export const recoverStaleResearchRuns = (input: {
  now?: Date;
  source: string;
}): RecoverableResearchRun[] => {
  const db = getDb();
  const now = input.now || new Date();
  try {
    db.exec("BEGIN IMMEDIATE;");
    const recovered = recoverStaleResearchRunsInTransaction({
      db,
      now,
      source: input.source
    });
    db.exec("COMMIT;");
    return recovered;
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the original recovery failure.
    }
    throw error;
  }
};

export type ResearchRunReservation =
  | {
      status: "reserved";
      runId: string;
      startedAt: string;
    }
  | {
      status: "already_running";
      activeRunId: string;
      startedAt: string;
      heartbeatAt: string;
    };

type ActiveResearchRunRow = {
  id: string;
  started_at: string;
  heartbeat_at: string;
};

const activeResearchRun = (
  db: DbHandle,
  cutoff?: string
): ActiveResearchRunRow | undefined => {
  const cutoffClause = cutoff
    ? " AND COALESCE(heartbeat_at, started_at) > ?"
    : "";
  const params = cutoff ? [cutoff] : [];
  return db
    .prepare(`
      SELECT id, started_at, COALESCE(heartbeat_at, started_at) AS heartbeat_at
      FROM research_runs
      WHERE status = 'running'${cutoffClause}
      ORDER BY started_at ASC
      LIMIT 1
    `)
    .get(...params) as ActiveResearchRunRow | undefined;
};

export const reserveResearchRun = (input: {
  runId: string;
  now?: Date;
  riskProfile: string;
  optionsEnabled: boolean;
  configJson: string;
  requestId?: string;
  correlationId?: string;
  workerIdentity?: string;
}): ResearchRunReservation => {
  const db = getDb();
  const now = input.now || new Date();
  const startedAt = now.toISOString();
  const freshActive = activeResearchRun(
    db,
    new Date(now.getTime() - RESEARCH_RUN_STALE_AFTER_MS).toISOString()
  );
  if (freshActive) {
    return {
      status: "already_running",
      activeRunId: freshActive.id,
      startedAt: freshActive.started_at,
      heartbeatAt: freshActive.heartbeat_at
    };
  }
  try {
    db.exec("BEGIN IMMEDIATE;");
    recoverStaleResearchRunsInTransaction({
      db,
      now,
      source: "research_preflight"
    });
    const active = activeResearchRun(db);
    if (active) {
      db.exec("COMMIT;");
      return {
        status: "already_running",
        activeRunId: active.id,
        startedAt: active.started_at,
        heartbeatAt: active.heartbeat_at
      };
    }

    db.prepare(`
      INSERT INTO research_runs(
        id, started_at, heartbeat_at, status, risk_profile, options_enabled,
        universe_size, targets_generated, candidates_selected, error_message,
        config_json, summary_json, worker_identity, request_id, correlation_id
      ) VALUES (?, ?, ?, 'running', ?, ?, 0, 0, 0, NULL, ?, NULL, ?, ?, ?)
    `).run(
      input.runId,
      startedAt,
      startedAt,
      input.riskProfile,
      input.optionsEnabled ? 1 : 0,
      input.configJson,
      input.workerIdentity || `${hostname()}:${process.pid}`,
      input.requestId || null,
      input.correlationId || null
    );
    db.exec("COMMIT;");
    return { status: "reserved", runId: input.runId, startedAt };
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the original reservation failure.
    }
    throw error;
  }
};

export const heartbeatResearchRun = (
  runId: string,
  at = new Date()
): boolean => runWithSqliteBusyRetry(
  () => Number(
    getDb()
      .prepare(
        "UPDATE research_runs SET heartbeat_at = ? WHERE id = ? AND status = 'running'"
      )
      .run(at.toISOString(), runId).changes
  ) === 1,
  {
    operation: "research_run.heartbeat",
    transaction: "research_run_heartbeat",
    runId,
    idempotent: true
  }
);

export const withActiveResearchRunLease = <T>(
  runId: string,
  operation: () => T,
  at = new Date()
): T => {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE;");
  try {
    const renewed = Number(
      db
        .prepare(
          "UPDATE research_runs SET heartbeat_at = ? WHERE id = ? AND status = 'running'"
        )
        .run(at.toISOString(), runId).changes
    ) === 1;
    if (!renewed) {
      throw new ResearchRunLeaseLostError(runId);
    }
    const result = operation();
    db.exec("COMMIT;");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the original lease or persistence failure.
    }
    throw error;
  }
};

export const updateResearchRunUniverseSize = (
  runId: string,
  universeSize: number,
  at = new Date()
): boolean => runWithSqliteBusyRetry(
  () => Number(
    getDb()
      .prepare(`
        UPDATE research_runs
        SET universe_size = ?, heartbeat_at = ?
        WHERE id = ? AND status = 'running'
      `)
      .run(universeSize, at.toISOString(), runId).changes
  ) === 1,
  {
    operation: "research_run.universe_progress",
    transaction: "research_run_universe_progress",
    runId,
    idempotent: true
  }
);

export const finishResearchRun = (
  runId: string,
  input: {
    status: "completed" | "failed";
    targetsGenerated: number;
    candidatesSelected: number;
    summaryJson: string;
    errorMessage?: string | null;
    at?: Date;
  }
): void => {
  const completedAt = (input.at || new Date()).toISOString();
  runWithSqliteBusyRetry(
    () => {
      getDb()
        .prepare(`
          UPDATE research_runs
          SET status = ?,
              completed_at = ?,
              heartbeat_at = ?,
              targets_generated = ?,
              candidates_selected = ?,
              error_message = COALESCE(?, error_message),
              summary_json = COALESCE(?, summary_json)
          WHERE id = ? AND status = 'running'
        `)
        .run(
          input.status,
          completedAt,
          completedAt,
          input.targetsGenerated,
          input.candidatesSelected,
          input.errorMessage || null,
          input.summaryJson,
          runId
        );
    },
    {
      operation: "research_run.finish",
      transaction: "research_run_finish",
      runId,
      idempotent: true
    }
  );
};
