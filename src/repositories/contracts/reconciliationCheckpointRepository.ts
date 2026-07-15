import type {
  FencedRepositoryOperationContext,
  JsonValue,
  TransactionScopedOperationContext,
  VersionedWriteResult
} from "./common.js";

export const RECONCILIATION_CHECKPOINT_STATUSES = [
  "pending",
  "running",
  "passed",
  "failed",
  "blocked",
] as const;
export type ReconciliationCheckpointStatus =
  (typeof RECONCILIATION_CHECKPOINT_STATUSES)[number];

export interface ReconciliationCheckpointRecord {
  readonly checkpointId: string;
  readonly domain: string;
  readonly sourceChecksum: string;
  readonly sourceCursor: JsonValue | null;
  readonly sourceRowsProcessed: number;
  readonly targetRowsWritten: number;
  readonly discrepancyCount: number;
  readonly status: ReconciliationCheckpointStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly version: number;
}

export interface ReconciliationDiscrepancy {
  readonly discrepancyId: string;
  readonly checkpointId: string;
  readonly domain: string;
  readonly entityId: string | null;
  readonly discrepancyType: string;
  readonly expected: JsonValue | null;
  readonly actual: JsonValue | null;
  readonly observedAt: string;
}

export type ReconciliationCheckpointStartResult =
  | { readonly status: "created"; readonly checkpoint: ReconciliationCheckpointRecord }
  | { readonly status: "resumed"; readonly checkpoint: ReconciliationCheckpointRecord }
  | {
      readonly status: "source_conflict";
      readonly currentSourceChecksum: string;
    }
  | { readonly status: "fence_rejected"; readonly currentFencingToken: number | null };

export interface ReconciliationCheckpointRepository<TTransactionScope> {
  find(
    input: { readonly checkpointId: string },
    context: TransactionScopedOperationContext<TTransactionScope>
  ): Promise<ReconciliationCheckpointRecord | null>;

  startOrResume(
    input: {
      readonly checkpointId: string;
      readonly domain: string;
      readonly sourceChecksum: string;
      readonly startedAt: string;
    },
    context: FencedRepositoryOperationContext<TTransactionScope>
  ): Promise<ReconciliationCheckpointStartResult>;

  advance(
    input: {
      readonly checkpointId: string;
      readonly expectedVersion: number;
      readonly sourceCursor: JsonValue;
      readonly sourceRowsProcessed: number;
      readonly targetRowsWritten: number;
      readonly discrepancyCount: number;
      readonly updatedAt: string;
    },
    context: FencedRepositoryOperationContext<TTransactionScope>
  ): Promise<VersionedWriteResult>;

  complete(
    input: {
      readonly checkpointId: string;
      readonly expectedVersion: number;
      readonly completedAt: string;
      readonly discrepancyCount: number;
    },
    context: FencedRepositoryOperationContext<TTransactionScope>
  ): Promise<VersionedWriteResult>;

  block(
    input: {
      readonly checkpointId: string;
      readonly expectedVersion: number;
      readonly blockedAt: string;
      readonly discrepancyCount: number;
    },
    context: FencedRepositoryOperationContext<TTransactionScope>
  ): Promise<VersionedWriteResult>;

  appendDiscrepancy(
    discrepancy: ReconciliationDiscrepancy,
    context: FencedRepositoryOperationContext<TTransactionScope>
  ): Promise<"inserted" | "duplicate">;

  listDiscrepancies(
    input: { readonly checkpointId: string },
    context: TransactionScopedOperationContext<TTransactionScope>
  ): Promise<readonly ReconciliationDiscrepancy[]>;
}
