import type {
  CandidateDecision,
  CandidateDecisionRecord,
  PaperTradeCandidateRow
} from "../../types.js";
import type {
  FencedRepositoryOperationContext,
  JsonValue,
  TransactionScopedOperationContext,
  VersionedWriteResult
} from "./common.js";

export const CANDIDATE_LIFECYCLE_STATUSES = [
  "selected",
  "rejected",
  "skipped",
  "blocked"
] as const satisfies readonly CandidateDecision[];

export type CandidateLifecycleStatus =
  (typeof CANDIDATE_LIFECYCLE_STATUSES)[number];

export interface CandidateRecord extends PaperTradeCandidateRow {
  readonly decision: CandidateDecision;
  readonly decisionReason: string;
  readonly strategyFamily: string;
  readonly signalInputs: Readonly<Record<string, string | number | null>>;
  readonly dataQualityStatus: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface CandidateLifecycleEvent {
  readonly eventId: string;
  readonly candidateId: string;
  readonly researchRunId: string;
  readonly sequence: number;
  readonly fromStatus: CandidateLifecycleStatus | null;
  readonly toStatus: CandidateLifecycleStatus;
  readonly reasonCode: string;
  readonly occurredAt: string;
  readonly producedAt: string;
  readonly source: string;
  readonly schemaVersion: number;
  readonly requestId: string | null;
  readonly correlationId: string | null;
  readonly evidence: JsonValue;
}

export type CandidateInsertResult =
  | { readonly status: "inserted"; readonly candidate: CandidateRecord }
  | { readonly status: "duplicate"; readonly candidate: CandidateRecord }
  | { readonly status: "fence_rejected"; readonly currentFencingToken: number | null };

export interface CandidateRepository<TTransactionScope> {
  findById(
    input: { readonly candidateId: string },
    context: TransactionScopedOperationContext<TTransactionScope>
  ): Promise<CandidateRecord | null>;

  listByResearchRun(
    input: { readonly researchRunId: string },
    context: TransactionScopedOperationContext<TTransactionScope>
  ): Promise<readonly CandidateRecord[]>;

  insertMany(
    input: {
      readonly researchRunId: string;
      readonly candidates: readonly CandidateDecisionRecord[];
      readonly createdAt: string;
    },
    context: FencedRepositoryOperationContext<TTransactionScope>
  ): Promise<readonly CandidateInsertResult[]>;

  transition(
    input: {
      readonly candidateId: string;
      readonly expectedVersion: number;
      readonly decision: CandidateLifecycleStatus;
      readonly decisionReason: string;
      readonly lifecycleEvent: CandidateLifecycleEvent;
      readonly updatedAt: string;
    },
    context: FencedRepositoryOperationContext<TTransactionScope>
  ): Promise<VersionedWriteResult>;
}

export interface CandidateLifecycleEventRepository<TTransactionScope> {
  append(
    event: CandidateLifecycleEvent,
    context: FencedRepositoryOperationContext<TTransactionScope>
  ): Promise<
    | { readonly status: "inserted" }
    | { readonly status: "duplicate" }
    | { readonly status: "sequence_conflict"; readonly latestSequence: number }
    | { readonly status: "fence_rejected"; readonly currentFencingToken: number | null }
  >;

  listByCandidate(
    input: { readonly candidateId: string; readonly afterSequence?: number },
    context: TransactionScopedOperationContext<TTransactionScope>
  ): Promise<readonly CandidateLifecycleEvent[]>;
}
