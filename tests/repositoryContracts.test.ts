import assert from "node:assert/strict";
import test from "node:test";

import {
  CANDIDATE_LIFECYCLE_STATUSES,
  IDEMPOTENCY_RECORD_STATUSES,
  RECONCILIATION_CHECKPOINT_STATUSES,
  RESEARCH_RUN_STATUSES,
  SCHEDULER_LEASE_STATUSES,
  WORKSTREAM_EVENT_STATUSES,
  type CandidateLifecycleEventRepository,
  type CandidateRepository,
  type ControlPlaneRepositories,
  type FencedRepositoryOperationContext,
  type IdempotencyRepository,
  type ReconciliationCheckpointRepository,
  type ResearchRunRepository,
  type SchedulerLeaseRepository,
  type TransactionScopedOperationContext,
  type WorkstreamEventRepository
} from "../src/repositories/contracts/index.js";

interface TestTransactionScope {
  readonly clientId: string;
}

const transactionContext: TransactionScopedOperationContext<TestTransactionScope> = {
  transaction: { clientId: "client-1" },
  operationId: "operation-1",
  requestId: "request-1",
  correlationId: "correlation-1",
  actorId: "worker-1"
};

const fencedContext: FencedRepositoryOperationContext<TestTransactionScope> = {
  ...transactionContext,
  schedulerFence: {
    jobName: "research",
    workstream: "research",
    ownerId: "worker-1",
    runId: "run-1",
    fencingToken: "7"
  }
};

test("control-plane status contracts expose only durable states", () => {
  assert.deepEqual(RESEARCH_RUN_STATUSES, [
    "reserved",
    "running",
    "completed",
    "failed",
    "cancelled",
    "recovered"
  ]);
  assert.deepEqual(CANDIDATE_LIFECYCLE_STATUSES, [
    "discovered",
    "data_incomplete",
    "scored",
    "selected",
    "rejected",
    "skipped",
    "reviewed",
    "blocked",
    "paper_eligible",
    "submitted",
    "filled",
    "open",
    "closed",
    "expired"
  ]);
  assert.deepEqual(SCHEDULER_LEASE_STATUSES, ["held", "released", "expired"]);
  assert.deepEqual(RECONCILIATION_CHECKPOINT_STATUSES, [
    "pending",
    "running",
    "passed",
    "failed",
    "blocked"
  ]);
  assert.deepEqual(IDEMPOTENCY_RECORD_STATUSES, [
    "in_progress",
    "completed",
    "failed",
    "expired"
  ]);
  assert.deepEqual(WORKSTREAM_EVENT_STATUSES, [
    "received",
    "processing",
    "completed",
    "deferred",
    "failed",
    "dead_letter"
  ]);
});

test("repository contracts carry one transaction scope, versions, and scheduler fencing", async () => {
  let observedClientId = "";
  let observedExpectedVersion = 0;
  let observedFencingToken = "";

  const researchRuns: ResearchRunRepository<TestTransactionScope> = {
    async findById() {
      return null;
    },
    async findActive() {
      return null;
    },
    async reserve(_input, context) {
      observedClientId = context.transaction.clientId;
      observedFencingToken = context.schedulerFence.fencingToken;
      return { status: "reserved", runId: "research-1", version: 1 };
    },
    async heartbeat(input, context) {
      observedExpectedVersion = input.expectedVersion;
      observedFencingToken = context.schedulerFence.fencingToken;
      return { status: "updated", version: input.expectedVersion + 1 };
    },
    async updateProgress(input) {
      return { status: "updated", version: input.expectedVersion + 1 };
    },
    async finish(input) {
      return { status: "updated", version: input.expectedVersion + 1 };
    },
    async recoverStale(input) {
      return input.runs.map((run) => ({
        runId: run.runId,
        status: "updated" as const,
        version: run.expectedVersion + 1
      }));
    }
  };

  const reserved = await researchRuns.reserve(
    {
      runId: "research-1",
      startedAt: "2026-07-15T20:00:00.000Z",
      staleBefore: "2026-07-15T19:45:00.000Z",
      recoveryReason: "WORKER_TERMINATED_OR_HEARTBEAT_EXPIRED",
      recoverySource: "research_preflight",
      riskProfile: "aggressive",
      optionsEnabled: true,
      config: {},
      workerIdentity: "worker-1"
    },
    fencedContext
  );
  const heartbeat = await researchRuns.heartbeat(
    {
      runId: "research-1",
      expectedVersion: 3,
      heartbeatAt: "2026-07-15T20:01:00.000Z"
    },
    fencedContext
  );

  assert.equal(reserved.status, "reserved");
  assert.equal(heartbeat.status, "updated");
  assert.equal(observedClientId, "client-1");
  assert.equal(observedExpectedVersion, 3);
  assert.equal(observedFencingToken, "7");
});

test("all control-plane repositories compose without a generic query interface", () => {
  const candidates = {} as CandidateRepository<TestTransactionScope>;
  const candidateLifecycleEvents =
    {} as CandidateLifecycleEventRepository<TestTransactionScope>;
  const schedulerLeases = {} as SchedulerLeaseRepository<TestTransactionScope>;
  const reconciliationCheckpoints =
    {} as ReconciliationCheckpointRepository<TestTransactionScope>;
  const idempotency = {} as IdempotencyRepository<TestTransactionScope>;
  const workstreamEvents = {} as WorkstreamEventRepository<TestTransactionScope>;

  const repositories = {
    researchRuns: {} as ResearchRunRepository<TestTransactionScope>,
    candidates,
    candidateLifecycleEvents,
    schedulerLeases,
    reconciliationCheckpoints,
    idempotency,
    workstreamEvents
  } satisfies ControlPlaneRepositories<TestTransactionScope>;

  assert.deepEqual(Object.keys(repositories), [
    "researchRuns",
    "candidates",
    "candidateLifecycleEvents",
    "schedulerLeases",
    "reconciliationCheckpoints",
    "idempotency",
    "workstreamEvents"
  ]);
  assert.equal("query" in repositories, false);
});
