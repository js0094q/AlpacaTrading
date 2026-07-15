import type {
  JsonValue,
  TransactionScopedOperationContext,
  VersionedWriteResult
} from "./common.js";

export const IDEMPOTENCY_RECORD_STATUSES = [
  "in_progress",
  "completed",
  "failed",
  "expired"
] as const;
export type IdempotencyRecordStatus =
  (typeof IDEMPOTENCY_RECORD_STATUSES)[number];

export interface IdempotencyRecord {
  readonly scope: string;
  readonly key: string;
  readonly requestHash: string;
  readonly status: IdempotencyRecordStatus;
  readonly response: JsonValue | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
  readonly version: number;
}

export type IdempotencyBeginResult =
  | { readonly status: "acquired"; readonly record: IdempotencyRecord }
  | { readonly status: "replay"; readonly record: IdempotencyRecord }
  | { readonly status: "in_progress"; readonly record: IdempotencyRecord }
  | {
      readonly status: "request_conflict";
      readonly existingRequestHash: string;
    };

export interface IdempotencyRepository<TTransactionScope> {
  find(
    input: { readonly scope: string; readonly key: string },
    context: TransactionScopedOperationContext<TTransactionScope>
  ): Promise<IdempotencyRecord | null>;

  begin(
    input: {
      readonly scope: string;
      readonly key: string;
      readonly requestHash: string;
      readonly startedAt: string;
      readonly expiresAt?: string | null;
    },
    context: TransactionScopedOperationContext<TTransactionScope>
  ): Promise<IdempotencyBeginResult>;

  complete(
    input: {
      readonly scope: string;
      readonly key: string;
      readonly requestHash: string;
      readonly expectedVersion: number;
      readonly response: JsonValue;
      readonly completedAt: string;
    },
    context: TransactionScopedOperationContext<TTransactionScope>
  ): Promise<VersionedWriteResult>;

  fail(
    input: {
      readonly scope: string;
      readonly key: string;
      readonly requestHash: string;
      readonly expectedVersion: number;
      readonly errorCode: string;
      readonly failedAt: string;
    },
    context: TransactionScopedOperationContext<TTransactionScope>
  ): Promise<VersionedWriteResult>;
}
