import type { RiskProfile } from "../../types.js";
import type {
  FencedRepositoryOperationContext,
  JsonValue,
  TransactionScopedOperationContext,
  VersionedWriteResult
} from "./common.js";

export const RESEARCH_RUN_STATUSES = [
  "reserved",
  "running",
  "completed",
  "failed",
  "cancelled",
  "recovered"
] as const;
export type ResearchRunStatus = (typeof RESEARCH_RUN_STATUSES)[number];

export interface ResearchRunRecord {
  readonly id: string;
  readonly startedAt: string;
  readonly heartbeatAt: string | null;
  readonly completedAt: string | null;
  readonly status: ResearchRunStatus;
  readonly riskProfile: RiskProfile;
  readonly optionsEnabled: boolean;
  readonly universeSize: number;
  readonly targetsGenerated: number;
  readonly candidatesSelected: number;
  readonly errorMessage: string | null;
  readonly config: JsonValue;
  readonly summary: JsonValue | null;
  readonly workerIdentity: string | null;
  readonly requestId: string | null;
  readonly correlationId: string | null;
  readonly recoveredAt: string | null;
  readonly recoveryReason: string | null;
  readonly recoverySource: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReserveResearchRunInput {
  readonly runId: string;
  readonly startedAt: string;
  readonly staleBefore: string;
  readonly recoveryReason: string;
  readonly recoverySource: string;
  readonly riskProfile: RiskProfile;
  readonly optionsEnabled: boolean;
  readonly config: JsonValue;
  readonly workerIdentity: string;
}

export type ResearchRunReservationResult =
  | { readonly status: "reserved"; readonly runId: string; readonly version: number }
  | {
      readonly status: "already_running";
      readonly activeRunId: string;
      readonly startedAt: string;
      readonly heartbeatAt: string;
      readonly version: number;
    }
  | { readonly status: "fence_rejected"; readonly currentFencingToken: string | null };

export interface ResearchRunRepository<TTransactionScope> {
  findById(
    input: { readonly runId: string },
    context: TransactionScopedOperationContext<TTransactionScope>
  ): Promise<ResearchRunRecord | null>;

  findActive(
    input: { readonly heartbeatAfter?: string },
    context: TransactionScopedOperationContext<TTransactionScope>
  ): Promise<ResearchRunRecord | null>;

  reserve(
    input: ReserveResearchRunInput,
    context: FencedRepositoryOperationContext<TTransactionScope>
  ): Promise<ResearchRunReservationResult>;

  heartbeat(
    input: {
      readonly runId: string;
      readonly expectedVersion: number;
      readonly heartbeatAt: string;
    },
    context: FencedRepositoryOperationContext<TTransactionScope>
  ): Promise<VersionedWriteResult>;

  updateProgress(
    input: {
      readonly runId: string;
      readonly expectedVersion: number;
      readonly heartbeatAt: string;
      readonly universeSize?: number;
      readonly targetsGenerated?: number;
      readonly candidatesSelected?: number;
    },
    context: FencedRepositoryOperationContext<TTransactionScope>
  ): Promise<VersionedWriteResult>;

  finish(
    input: {
      readonly runId: string;
      readonly expectedVersion: number;
      readonly status: "completed" | "failed";
      readonly completedAt: string;
      readonly targetsGenerated: number;
      readonly candidatesSelected: number;
      readonly summary: JsonValue;
      readonly errorMessage?: string | null;
    },
    context: FencedRepositoryOperationContext<TTransactionScope>
  ): Promise<VersionedWriteResult>;

  recoverStale(
    input: {
      readonly runs: ReadonlyArray<{
        readonly runId: string;
        readonly expectedVersion: number;
      }>;
      readonly recoveredAt: string;
      readonly recoveryReason: string;
      readonly recoverySource: string;
    },
    context: FencedRepositoryOperationContext<TTransactionScope>
  ): Promise<ReadonlyArray<{ readonly runId: string } & VersionedWriteResult>>;
}
