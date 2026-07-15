export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface SchedulerFence {
  readonly jobName: string;
  readonly workstream: string;
  readonly ownerId: string;
  readonly runId: string;
  readonly fencingToken: string;
}

/**
 * Carries the checked-out database transaction through every repository call
 * that must commit atomically. It deliberately exposes no generic query API.
 */
export interface TransactionScopedOperationContext<TTransactionScope> {
  readonly transaction: TTransactionScope;
  readonly operationId: string;
  readonly requestId?: string | null;
  readonly correlationId?: string | null;
  readonly actorId: string;
}

export interface FencedRepositoryOperationContext<TTransactionScope>
  extends TransactionScopedOperationContext<TTransactionScope> {
  readonly schedulerFence: SchedulerFence;
}

export type VersionedWriteResult =
  | { readonly status: "updated"; readonly version: number }
  | { readonly status: "not_found" }
  | { readonly status: "version_conflict"; readonly currentVersion: number }
  | { readonly status: "fence_rejected"; readonly currentFencingToken: string | null };
