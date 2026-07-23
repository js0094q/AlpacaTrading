export * from "./common.js";
export * from "./executionStateRepository.js";
export * from "./researchRunRepository.js";
export * from "./candidateRepository.js";
export * from "./schedulerLeaseRepository.js";
export * from "./reconciliationCheckpointRepository.js";
export * from "./idempotencyRepository.js";
export * from "./workstreamEventRepository.js";

import type { CandidateLifecycleEventRepository, CandidateRepository } from "./candidateRepository.js";
import type { IdempotencyRepository } from "./idempotencyRepository.js";
import type { ReconciliationCheckpointRepository } from "./reconciliationCheckpointRepository.js";
import type { ResearchRunRepository } from "./researchRunRepository.js";
import type { SchedulerLeaseRepository } from "./schedulerLeaseRepository.js";
import type { WorkstreamEventRepository } from "./workstreamEventRepository.js";

export interface ControlPlaneRepositories<TTransactionScope> {
  readonly researchRuns: ResearchRunRepository<TTransactionScope>;
  readonly candidates: CandidateRepository<TTransactionScope>;
  readonly candidateLifecycleEvents: CandidateLifecycleEventRepository<TTransactionScope>;
  readonly schedulerLeases: SchedulerLeaseRepository<TTransactionScope>;
  readonly reconciliationCheckpoints: ReconciliationCheckpointRepository<TTransactionScope>;
  readonly idempotency: IdempotencyRepository<TTransactionScope>;
  readonly workstreamEvents: WorkstreamEventRepository<TTransactionScope>;
}
