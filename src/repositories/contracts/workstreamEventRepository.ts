import type {
  FencedRepositoryOperationContext,
  JsonValue,
  TransactionScopedOperationContext,
  VersionedWriteResult
} from "./common.js";

export const WORKSTREAM_EVENT_STATUSES = [
  "received",
  "processing",
  "completed",
  "deferred",
  "failed",
  "dead_letter"
] as const;
export type WorkstreamEventStatus = (typeof WORKSTREAM_EVENT_STATUSES)[number];

export interface WorkstreamEvent<TPayload extends JsonValue = JsonValue> {
  readonly eventId: string;
  readonly workstream: string;
  readonly eventType: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly occurredAt: string;
  readonly producedAt: string;
  readonly schemaVersion: number;
  readonly runId?: string | null;
  readonly requestId?: string | null;
  readonly correlationId?: string | null;
  readonly entityVersion?: number | null;
  readonly payload: TPayload;
}

export interface WorkstreamEventRecord<TPayload extends JsonValue = JsonValue>
  extends WorkstreamEvent<TPayload> {
  readonly status: WorkstreamEventStatus;
  readonly receivedAt: string;
  readonly processingStartedAt: string | null;
  readonly processedAt: string | null;
  readonly attempts: number;
  readonly version: number;
}

export interface WorkstreamEventFailure {
  readonly failureId: string;
  readonly eventId: string;
  readonly attempt: number;
  readonly errorCode: string;
  readonly errorClassification: string;
  readonly retryable: boolean;
  readonly failedAt: string;
  readonly nextRetryAt: string | null;
  readonly details: JsonValue | null;
}

export type WorkstreamEventAppendResult =
  | { readonly status: "inserted"; readonly record: WorkstreamEventRecord }
  | { readonly status: "duplicate"; readonly record: WorkstreamEventRecord };

export type WorkstreamEventClaimResult =
  | { readonly status: "claimed"; readonly record: WorkstreamEventRecord }
  | { readonly status: "already_completed"; readonly record: WorkstreamEventRecord }
  | { readonly status: "already_processing"; readonly record: WorkstreamEventRecord }
  | {
      readonly status: "out_of_order";
      readonly currentEntityVersion: number | null;
    }
  | { readonly status: "not_found" }
  | { readonly status: "fence_rejected"; readonly currentFencingToken: number | null };

export interface WorkstreamEventRepository<TTransactionScope> {
  find(
    input: { readonly eventId: string },
    context: TransactionScopedOperationContext<TTransactionScope>
  ): Promise<WorkstreamEventRecord | null>;

  append(
    event: WorkstreamEvent,
    context: TransactionScopedOperationContext<TTransactionScope>
  ): Promise<WorkstreamEventAppendResult>;

  claimForProcessing(
    input: {
      readonly eventId: string;
      readonly expectedEntityVersion: number | null;
      readonly processingStartedAt: string;
    },
    context: FencedRepositoryOperationContext<TTransactionScope>
  ): Promise<WorkstreamEventClaimResult>;

  markCompleted(
    input: {
      readonly eventId: string;
      readonly expectedVersion: number;
      readonly processedAt: string;
    },
    context: FencedRepositoryOperationContext<TTransactionScope>
  ): Promise<VersionedWriteResult>;

  markFailed(
    input: {
      readonly eventId: string;
      readonly expectedVersion: number;
      readonly failure: WorkstreamEventFailure;
    },
    context: FencedRepositoryOperationContext<TTransactionScope>
  ): Promise<VersionedWriteResult>;

  listPending(
    input: { readonly workstream: string; readonly limit: number },
    context: TransactionScopedOperationContext<TTransactionScope>
  ): Promise<readonly WorkstreamEventRecord[]>;

  listFailures(
    input: { readonly eventId: string },
    context: TransactionScopedOperationContext<TTransactionScope>
  ): Promise<readonly WorkstreamEventFailure[]>;
}
