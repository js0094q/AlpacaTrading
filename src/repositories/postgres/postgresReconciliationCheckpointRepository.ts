import type { PoolClient } from "pg";

import type { VersionedWriteResult } from "../contracts/common.js";
import type {
  ReconciliationCheckpointRecord,
  ReconciliationCheckpointRepository,
  ReconciliationDiscrepancy
} from "../contracts/reconciliationCheckpointRepository.js";
import {
  asIsoString,
  parseJsonValue,
  requireCurrentFence,
  type FencedPostgresRepositoryContext,
  type PostgresRepositoryContext
} from "./postgresRepositorySupport.js";

type CheckpointRow = {
  id: string;
  workstream: string;
  source_checksum: string | null;
  cursor_value: unknown;
  source_row_count: number | string | null;
  target_row_count: number | string | null;
  discrepancy_count: number | string;
  status: ReconciliationCheckpointRecord["status"];
  started_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
  version: number | string;
};

const checkpointColumns = `id, workstream, source_checksum, cursor_value,
  source_row_count, target_row_count, discrepancy_count, status, started_at,
  updated_at, completed_at, version`;

const mapCheckpoint = (row: CheckpointRow): ReconciliationCheckpointRecord => ({
  checkpointId: row.id,
  domain: row.workstream,
  sourceChecksum: row.source_checksum || "",
  sourceCursor: row.cursor_value === null ? null : parseJsonValue(row.cursor_value),
  sourceRowsProcessed: Number(row.source_row_count || 0),
  targetRowsWritten: Number(row.target_row_count || 0),
  discrepancyCount: Number(row.discrepancy_count),
  status: row.status,
  startedAt: asIsoString(row.started_at)!,
  updatedAt: asIsoString(row.updated_at)!,
  completedAt: asIsoString(row.completed_at),
  version: Number(row.version)
});

type DiscrepancyRow = {
  id: string;
  checkpoint_id: string;
  domain: string;
  entity_id: string | null;
  discrepancy_type: string;
  expected: unknown;
  actual: unknown;
  observed_at: Date | string;
};

const mapDiscrepancy = (row: DiscrepancyRow): ReconciliationDiscrepancy => ({
  discrepancyId: row.id,
  checkpointId: row.checkpoint_id,
  domain: row.domain,
  entityId: row.entity_id,
  discrepancyType: row.discrepancy_type,
  expected: row.expected === null ? null : parseJsonValue(row.expected),
  actual: row.actual === null ? null : parseJsonValue(row.actual),
  observedAt: asIsoString(row.observed_at)!
});

const mutationMiss = async (
  input: { checkpointId: string; expectedVersion: number },
  context: FencedPostgresRepositoryContext
): Promise<VersionedWriteResult> => {
  const current = await context.transaction.query<{ version: number | string }>(
    "SELECT version FROM reconciliation_checkpoints WHERE id = $1",
    [input.checkpointId]
  );
  if (!current.rows[0]) return { status: "not_found" };
  const version = Number(current.rows[0].version);
  return version === input.expectedVersion
    ? { status: "not_found" }
    : { status: "version_conflict", currentVersion: version };
};

export class PostgresReconciliationCheckpointRepository
implements ReconciliationCheckpointRepository<PoolClient> {
  async find(
    input: { readonly checkpointId: string },
    context: PostgresRepositoryContext
  ) {
    const result = await context.transaction.query<CheckpointRow>(
      `SELECT ${checkpointColumns} FROM reconciliation_checkpoints WHERE id = $1`,
      [input.checkpointId]
    );
    return result.rows[0] ? mapCheckpoint(result.rows[0]) : null;
  }

  async startOrResume(
    input: Parameters<ReconciliationCheckpointRepository<PoolClient>["startOrResume"]>[0],
    context: FencedPostgresRepositoryContext
  ) {
    const fence = await requireCurrentFence(context);
    if (!fence.accepted) {
      return { status: "fence_rejected" as const, currentFencingToken: fence.currentFencingToken };
    }
    const selected = await context.transaction.query<CheckpointRow>(
      `SELECT ${checkpointColumns}
       FROM reconciliation_checkpoints WHERE id = $1 FOR UPDATE`,
      [input.checkpointId]
    );
    if (selected.rows[0]) {
      const checkpoint = mapCheckpoint(selected.rows[0]);
      if (checkpoint.sourceChecksum !== input.sourceChecksum) {
        return { status: "source_conflict" as const, currentSourceChecksum: checkpoint.sourceChecksum };
      }
      return { status: "resumed" as const, checkpoint };
    }
    const inserted = await context.transaction.query<CheckpointRow>(
      `INSERT INTO reconciliation_checkpoints(
         id, workstream, checkpoint_key, source_name, target_name, status,
         source_checksum, source_row_count, target_row_count, discrepancy_count,
         started_at, created_at, updated_at
       ) VALUES ($1, $2, $1, 'sqlite', 'neon_postgres', 'running', $3, 0, 0, 0, $4, $4, $4)
       RETURNING ${checkpointColumns}`,
      [input.checkpointId, input.domain, input.sourceChecksum, input.startedAt]
    );
    return { status: "created" as const, checkpoint: mapCheckpoint(inserted.rows[0]!) };
  }

  async advance(
    input: Parameters<ReconciliationCheckpointRepository<PoolClient>["advance"]>[0],
    context: FencedPostgresRepositoryContext
  ): Promise<VersionedWriteResult> {
    const fence = await requireCurrentFence(context);
    if (!fence.accepted) return { status: "fence_rejected", currentFencingToken: fence.currentFencingToken };
    const result = await context.transaction.query<{ version: number | string }>(
      `UPDATE reconciliation_checkpoints
       SET cursor_value = $3::jsonb, source_row_count = $4, target_row_count = $5,
           discrepancy_count = $6, updated_at = $7, version = version + 1
       WHERE id = $1 AND version = $2 AND status = 'running'
       RETURNING version`,
      [
        input.checkpointId,
        input.expectedVersion,
        input.sourceCursor === null ? null : JSON.stringify(input.sourceCursor),
        input.sourceRowsProcessed,
        input.targetRowsWritten,
        input.discrepancyCount,
        input.updatedAt
      ]
    );
    return result.rows[0]
      ? { status: "updated", version: Number(result.rows[0].version) }
      : mutationMiss(input, context);
  }

  async complete(
    input: Parameters<ReconciliationCheckpointRepository<PoolClient>["complete"]>[0],
    context: FencedPostgresRepositoryContext
  ): Promise<VersionedWriteResult> {
    return this.finishCheckpoint(input, false, context);
  }

  async block(
    input: Parameters<ReconciliationCheckpointRepository<PoolClient>["block"]>[0],
    context: FencedPostgresRepositoryContext
  ): Promise<VersionedWriteResult> {
    return this.finishCheckpoint(
      {
        checkpointId: input.checkpointId,
        expectedVersion: input.expectedVersion,
        completedAt: input.blockedAt,
        discrepancyCount: input.discrepancyCount
      },
      true,
      context
    );
  }

  private async finishCheckpoint(
    input: {
      checkpointId: string;
      expectedVersion: number;
      completedAt: string;
      discrepancyCount: number;
    },
    forceBlocked: boolean,
    context: FencedPostgresRepositoryContext
  ): Promise<VersionedWriteResult> {
    const fence = await requireCurrentFence(context);
    if (!fence.accepted) return { status: "fence_rejected", currentFencingToken: fence.currentFencingToken };
    const persisted = await context.transaction.query<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM reconciliation_discrepancies WHERE checkpoint_id = $1",
      [input.checkpointId]
    );
    const persistedCount = Number(persisted.rows[0]?.count ?? 0);
    if (!Number.isSafeInteger(persistedCount) || persistedCount < 0) {
      throw new Error("POSTGRES_RECONCILIATION_DISCREPANCY_COUNT_INVALID");
    }
    const discrepancyCount = Math.max(input.discrepancyCount, persistedCount);
    const status = forceBlocked || discrepancyCount > 0 ? "blocked" : "passed";
    const result = await context.transaction.query<{ version: number | string }>(
      `UPDATE reconciliation_checkpoints
       SET status = $3, discrepancy_count = $4, completed_at = $5,
           updated_at = $5, version = version + 1
       WHERE id = $1 AND version = $2 AND status = 'running'
       RETURNING version`,
      [
        input.checkpointId,
        input.expectedVersion,
        status,
        discrepancyCount,
        input.completedAt
      ]
    );
    return result.rows[0]
      ? { status: "updated", version: Number(result.rows[0].version) }
      : mutationMiss(input, context);
  }

  async appendDiscrepancy(
    discrepancy: ReconciliationDiscrepancy,
    context: FencedPostgresRepositoryContext
  ) {
    const fence = await requireCurrentFence(context);
    if (!fence.accepted) throw new Error("POSTGRES_RECONCILIATION_FENCE_REJECTED");
    const checkpoint = await context.transaction.query<{ status: string }>(
      `SELECT status FROM reconciliation_checkpoints
       WHERE id = $1 FOR UPDATE`,
      [discrepancy.checkpointId]
    );
    if (!checkpoint.rows[0]) {
      throw new Error("POSTGRES_RECONCILIATION_CHECKPOINT_NOT_FOUND");
    }
    if (checkpoint.rows[0].status !== "running") {
      throw new Error("POSTGRES_RECONCILIATION_CHECKPOINT_TERMINAL");
    }
    const result = await context.transaction.query(
      `INSERT INTO reconciliation_discrepancies(
         id, checkpoint_id, domain, entity_id, discrepancy_type,
         expected, actual, observed_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        discrepancy.discrepancyId,
        discrepancy.checkpointId,
        discrepancy.domain,
        discrepancy.entityId,
        discrepancy.discrepancyType,
        discrepancy.expected === null ? null : JSON.stringify(discrepancy.expected),
        discrepancy.actual === null ? null : JSON.stringify(discrepancy.actual),
        discrepancy.observedAt
      ]
    );
    return result.rows[0] ? "inserted" as const : "duplicate" as const;
  }

  async listDiscrepancies(
    input: { readonly checkpointId: string },
    context: PostgresRepositoryContext
  ) {
    const result = await context.transaction.query<DiscrepancyRow>(
      `SELECT id, checkpoint_id, domain, entity_id, discrepancy_type,
              expected, actual, observed_at
       FROM reconciliation_discrepancies
       WHERE checkpoint_id = $1
       ORDER BY observed_at, id`,
      [input.checkpointId]
    );
    return result.rows.map(mapDiscrepancy);
  }
}
