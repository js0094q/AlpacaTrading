import type { PoolClient } from "pg";

import type {
  ResearchRunRecord,
  ResearchRunRepository,
  ResearchRunReservationResult
} from "../contracts/researchRunRepository.js";
import type { VersionedWriteResult } from "../contracts/common.js";
import {
  asIsoString,
  currentFenceToken,
  fencePredicate,
  fenceValues,
  parseJsonValue,
  requireCurrentFence,
  type FencedPostgresRepositoryContext,
  type PostgresRepositoryContext
} from "./postgresRepositorySupport.js";

type ResearchRunRow = {
  id: string;
  started_at: Date | string;
  heartbeat_at: Date | string | null;
  completed_at: Date | string | null;
  status: ResearchRunRecord["status"];
  risk_profile: ResearchRunRecord["riskProfile"];
  options_enabled: boolean;
  universe_size: number;
  targets_generated: number;
  candidates_selected: number;
  error_message: string | null;
  config: unknown;
  summary: unknown;
  worker_identity: string | null;
  request_id: string | null;
  correlation_id: string | null;
  recovered_at: Date | string | null;
  recovery_reason: string | null;
  recovery_source: string | null;
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
};

const selectColumns = `
  id, started_at, heartbeat_at, completed_at, status, risk_profile,
  options_enabled, universe_size, targets_generated, candidates_selected,
  error_message, config, summary, worker_identity, request_id, correlation_id,
  recovered_at, recovery_reason, recovery_source, version, created_at, updated_at
`;

const mapResearchRun = (row: ResearchRunRow): ResearchRunRecord => ({
  id: row.id,
  startedAt: asIsoString(row.started_at)!,
  heartbeatAt: asIsoString(row.heartbeat_at),
  completedAt: asIsoString(row.completed_at),
  status: row.status,
  riskProfile: row.risk_profile,
  optionsEnabled: row.options_enabled,
  universeSize: Number(row.universe_size),
  targetsGenerated: Number(row.targets_generated),
  candidatesSelected: Number(row.candidates_selected),
  errorMessage: row.error_message,
  config: parseJsonValue(row.config),
  summary: row.summary === null ? null : parseJsonValue(row.summary),
  workerIdentity: row.worker_identity,
  requestId: row.request_id,
  correlationId: row.correlation_id,
  recoveredAt: asIsoString(row.recovered_at),
  recoveryReason: row.recovery_reason,
  recoverySource: row.recovery_source,
  version: Number(row.version),
  createdAt: asIsoString(row.created_at)!,
  updatedAt: asIsoString(row.updated_at)!
});

const mutationMiss = async (
  client: PoolClient,
  runId: string,
  expectedVersion: number,
  context: FencedPostgresRepositoryContext
): Promise<VersionedWriteResult> => {
  const currentToken = await currentFenceToken(client, context.schedulerFence);
  if (currentToken !== context.schedulerFence.fencingToken) {
    return { status: "fence_rejected", currentFencingToken: currentToken };
  }
  const current = await client.query<{ version: number | string }>(
    "SELECT version FROM research_runs WHERE id = $1",
    [runId]
  );
  if (!current.rows[0]) return { status: "not_found" };
  const version = Number(current.rows[0].version);
  if (version !== expectedVersion) {
    return { status: "version_conflict", currentVersion: version };
  }
  return { status: "not_found" };
};

export class PostgresResearchRunRepository
implements ResearchRunRepository<PoolClient> {
  async findById(
    input: { readonly runId: string },
    context: PostgresRepositoryContext
  ) {
    const result = await context.transaction.query<ResearchRunRow>(
      `SELECT ${selectColumns} FROM research_runs WHERE id = $1`,
      [input.runId]
    );
    return result.rows[0] ? mapResearchRun(result.rows[0]) : null;
  }

  async findActive(
    input: { readonly heartbeatAfter?: string },
    context: PostgresRepositoryContext
  ) {
    const result = await context.transaction.query<ResearchRunRow>(
      `SELECT ${selectColumns}
       FROM research_runs
       WHERE status IN ('reserved', 'running')
         AND ($1::timestamptz IS NULL OR COALESCE(heartbeat_at, started_at) > $1)
       ORDER BY started_at
       LIMIT 1`,
      [input.heartbeatAfter || null]
    );
    return result.rows[0] ? mapResearchRun(result.rows[0]) : null;
  }

  async reserve(
    input: Parameters<ResearchRunRepository<PoolClient>["reserve"]>[0],
    context: FencedPostgresRepositoryContext
  ): Promise<ResearchRunReservationResult> {
    const fence = await requireCurrentFence(context);
    if (!fence.accepted) {
      return { status: "fence_rejected", currentFencingToken: fence.currentFencingToken };
    }
    await context.transaction.query(
      `UPDATE research_runs
       SET status = 'recovered', completed_at = $1, recovered_at = $1,
           recovery_reason = $2, recovery_source = $3,
           error_message = COALESCE(error_message, $2),
           scheduler_job_name = $5, scheduler_fencing_token = $9,
           updated_at = $1, version = version + 1
       WHERE workstream = 'research'
         AND status IN ('reserved', 'running')
         AND COALESCE(heartbeat_at, started_at) <= $4
         AND ${fencePredicate(5)}`,
      [
        input.startedAt,
        input.recoveryReason,
        input.recoverySource,
        input.staleBefore,
        ...fenceValues(context.schedulerFence)
      ]
    );
    const existing = await context.transaction.query<ResearchRunRow>(
      `SELECT ${selectColumns}
       FROM research_runs
       WHERE workstream = 'research' AND status IN ('reserved', 'running')
       ORDER BY started_at
       LIMIT 1
       FOR UPDATE`
    );
    if (existing.rows[0]) {
      const active = mapResearchRun(existing.rows[0]);
      return {
        status: "already_running",
        activeRunId: active.id,
        startedAt: active.startedAt,
        heartbeatAt: active.heartbeatAt || active.startedAt,
        version: active.version
      };
    }

    try {
      const values = [
        input.runId,
        input.riskProfile,
        input.optionsEnabled,
        JSON.stringify(input.config),
        input.workerIdentity,
        context.requestId || null,
        context.correlationId || null,
        input.startedAt,
        ...fenceValues(context.schedulerFence)
      ];
      const result = await context.transaction.query<{ version: number | string }>(
        `INSERT INTO research_runs(
           id, workstream, run_key, status, risk_profile, options_enabled,
           config, worker_identity, scheduler_job_name, scheduler_fencing_token,
           request_id, correlation_id, started_at, heartbeat_at, created_at, updated_at
         )
         SELECT $1, 'research', $1, 'running', $2, $3, $4::jsonb, $5,
                $9, $13, $6, $7, $8, $8, $8, $8
         WHERE ${fencePredicate(9)}
         RETURNING version`,
        values
      );
      if (!result.rows[0]) {
        const current = await currentFenceToken(context.transaction, context.schedulerFence);
        return { status: "fence_rejected", currentFencingToken: current };
      }
      return { status: "reserved", runId: input.runId, version: Number(result.rows[0].version) };
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "23505") throw error;
      const active = await this.findActive({}, context);
      if (!active) throw error;
      return {
        status: "already_running",
        activeRunId: active.id,
        startedAt: active.startedAt,
        heartbeatAt: active.heartbeatAt || active.startedAt,
        version: active.version
      };
    }
  }

  async heartbeat(
    input: Parameters<ResearchRunRepository<PoolClient>["heartbeat"]>[0],
    context: FencedPostgresRepositoryContext
  ): Promise<VersionedWriteResult> {
    const fence = await requireCurrentFence(context);
    if (!fence.accepted) {
      return { status: "fence_rejected", currentFencingToken: fence.currentFencingToken };
    }
    const result = await context.transaction.query<{ version: number | string }>(
      `UPDATE research_runs
       SET heartbeat_at = $3, updated_at = $3, version = version + 1
       WHERE id = $1 AND version = $2 AND status = 'running'
         AND ${fencePredicate(4)}
       RETURNING version`,
      [input.runId, input.expectedVersion, input.heartbeatAt, ...fenceValues(context.schedulerFence)]
    );
    return result.rows[0]
      ? { status: "updated", version: Number(result.rows[0].version) }
      : mutationMiss(context.transaction, input.runId, input.expectedVersion, context);
  }

  async updateProgress(
    input: Parameters<ResearchRunRepository<PoolClient>["updateProgress"]>[0],
    context: FencedPostgresRepositoryContext
  ): Promise<VersionedWriteResult> {
    const fence = await requireCurrentFence(context);
    if (!fence.accepted) {
      return { status: "fence_rejected", currentFencingToken: fence.currentFencingToken };
    }
    const result = await context.transaction.query<{ version: number | string }>(
      `UPDATE research_runs
       SET heartbeat_at = $3,
           universe_size = COALESCE($4, universe_size),
           targets_generated = COALESCE($5, targets_generated),
           candidates_selected = COALESCE($6, candidates_selected),
           updated_at = $3,
           version = version + 1
       WHERE id = $1 AND version = $2 AND status = 'running'
         AND ${fencePredicate(7)}
       RETURNING version`,
      [
        input.runId,
        input.expectedVersion,
        input.heartbeatAt,
        input.universeSize ?? null,
        input.targetsGenerated ?? null,
        input.candidatesSelected ?? null,
        ...fenceValues(context.schedulerFence)
      ]
    );
    return result.rows[0]
      ? { status: "updated", version: Number(result.rows[0].version) }
      : mutationMiss(context.transaction, input.runId, input.expectedVersion, context);
  }

  async finish(
    input: Parameters<ResearchRunRepository<PoolClient>["finish"]>[0],
    context: FencedPostgresRepositoryContext
  ): Promise<VersionedWriteResult> {
    const fence = await requireCurrentFence(context);
    if (!fence.accepted) {
      return { status: "fence_rejected", currentFencingToken: fence.currentFencingToken };
    }
    const result = await context.transaction.query<{ version: number | string }>(
      `UPDATE research_runs
       SET status = $3, completed_at = $4, heartbeat_at = $4,
           targets_generated = $5, candidates_selected = $6,
           summary = $7::jsonb, error_message = $8, updated_at = $4,
           version = version + 1
       WHERE id = $1 AND version = $2 AND status = 'running'
         AND ${fencePredicate(9)}
       RETURNING version`,
      [
        input.runId,
        input.expectedVersion,
        input.status,
        input.completedAt,
        input.targetsGenerated,
        input.candidatesSelected,
        JSON.stringify(input.summary),
        input.errorMessage ?? null,
        ...fenceValues(context.schedulerFence)
      ]
    );
    return result.rows[0]
      ? { status: "updated", version: Number(result.rows[0].version) }
      : mutationMiss(context.transaction, input.runId, input.expectedVersion, context);
  }

  async recoverStale(
    input: Parameters<ResearchRunRepository<PoolClient>["recoverStale"]>[0],
    context: FencedPostgresRepositoryContext
  ) {
    const fence = await requireCurrentFence(context);
    if (!fence.accepted) {
      return input.runs.map((run) => ({
        runId: run.runId,
        status: "fence_rejected" as const,
        currentFencingToken: fence.currentFencingToken
      }));
    }
    const results: Array<{ readonly runId: string } & VersionedWriteResult> = [];
    for (const run of input.runs) {
      const updated = await context.transaction.query<{ version: number | string }>(
        `UPDATE research_runs
         SET status = 'recovered', completed_at = $3, recovered_at = $3,
             recovery_reason = $4, recovery_source = $5, updated_at = $3,
             error_message = COALESCE(error_message, $4),
             scheduler_job_name = $6, scheduler_fencing_token = $10,
             version = version + 1
         WHERE id = $1 AND version = $2 AND status IN ('reserved', 'running')
           AND ${fencePredicate(6)}
         RETURNING version`,
        [
          run.runId,
          run.expectedVersion,
          input.recoveredAt,
          input.recoveryReason,
          input.recoverySource,
          ...fenceValues(context.schedulerFence)
        ]
      );
      results.push({
        runId: run.runId,
        ...(updated.rows[0]
          ? { status: "updated" as const, version: Number(updated.rows[0].version) }
          : await mutationMiss(context.transaction, run.runId, run.expectedVersion, context))
      });
    }
    return results;
  }
}
