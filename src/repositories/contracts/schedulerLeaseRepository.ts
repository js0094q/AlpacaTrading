import type {
  SchedulerFence,
  TransactionScopedOperationContext
} from "./common.js";

export const SCHEDULER_LEASE_STATUSES = ["held", "released", "expired"] as const;
export type SchedulerLeaseStatus = (typeof SCHEDULER_LEASE_STATUSES)[number];

export interface SchedulerLeaseRecord extends SchedulerFence {
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
  readonly status: SchedulerLeaseStatus;
  readonly version: number;
}

export type SchedulerLeaseAcquisitionResult =
  | { readonly status: "acquired"; readonly lease: SchedulerLeaseRecord }
  | { readonly status: "held"; readonly lease: SchedulerLeaseRecord };

export type SchedulerLeaseMutationResult =
  | { readonly status: "updated"; readonly lease: SchedulerLeaseRecord }
  | { readonly status: "not_found" }
  | { readonly status: "fence_rejected"; readonly currentFencingToken: number | null };

export interface SchedulerLeaseRepository<TTransactionScope> {
  findByJobName(
    input: { readonly jobName: string },
    context: TransactionScopedOperationContext<TTransactionScope>
  ): Promise<SchedulerLeaseRecord | null>;

  acquire(
    input: {
      readonly jobName: string;
      readonly workstream: string;
      readonly ownerId: string;
      readonly runId: string;
      readonly acquiredAt: string;
      readonly expiresAt: string;
    },
    context: TransactionScopedOperationContext<TTransactionScope>
  ): Promise<SchedulerLeaseAcquisitionResult>;

  heartbeat(
    input: {
      readonly jobName: string;
      readonly ownerId: string;
      readonly runId: string;
      readonly fencingToken: number;
      readonly heartbeatAt: string;
      readonly expiresAt: string;
    },
    context: TransactionScopedOperationContext<TTransactionScope>
  ): Promise<SchedulerLeaseMutationResult>;

  release(
    input: {
      readonly jobName: string;
      readonly ownerId: string;
      readonly runId: string;
      readonly fencingToken: number;
      readonly releasedAt: string;
    },
    context: TransactionScopedOperationContext<TTransactionScope>
  ): Promise<SchedulerLeaseMutationResult>;

  isCurrentFence(
    fence: SchedulerFence,
    context: TransactionScopedOperationContext<TTransactionScope>
  ): Promise<boolean>;
}
