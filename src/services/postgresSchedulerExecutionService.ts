import type { Pool, PoolClient } from "pg";

import type { DatabaseConfig } from "../lib/database/config.js";
import { withPostgresTransaction } from "../lib/database/postgresTransaction.js";
import type { SchedulerFence } from "../repositories/contracts/common.js";
import type {
  SchedulerLeaseAcquisitionResult,
  SchedulerLeaseMutationResult,
  SchedulerLeaseRepository
} from "../repositories/contracts/schedulerLeaseRepository.js";
import { PostgresSchedulerLeaseRepository } from "../repositories/postgres/postgresSchedulerLeaseRepository.js";
import type { PostgresRepositoryContext } from "../repositories/postgres/postgresRepositorySupport.js";

export type PostgresSchedulerJob = {
  readonly jobName: string;
  readonly workstream: string;
};

export const POSTGRES_SCHEDULER_JOBS = {
  research: { jobName: "research", workstream: "research" },
  zeroDte: { jobName: "zero-dte", workstream: "zero_dte" },
  observatory: { jobName: "observatory", workstream: "observatory" },
  reconciliation: {
    jobName: "reconciliation",
    workstream: "reconciliation"
  },
  exitReview: { jobName: "exit-review", workstream: "exit_review" },
  paperExit: { jobName: "paper-exit", workstream: "paper_exit" },
  paperExecution: {
    jobName: "paper-execution",
    workstream: "paper_execution"
  },
  allocation: { jobName: "allocation", workstream: "allocation" },
  marketDataRefresh: {
    jobName: "market-data-refresh",
    workstream: "market_data_refresh"
  },
  universeLifecycle: {
    jobName: "universe-lifecycle",
    workstream: "universe_lifecycle"
  },
  autonomousRecovery: {
    jobName: "autonomous-recovery",
    workstream: "autonomous_recovery"
  },
  optionDiscovery: {
    jobName: "option-discovery",
    workstream: "option_discovery"
  },
  hedgeReview: { jobName: "hedge-review", workstream: "hedge_review" },
  hedgeExit: { jobName: "hedge-exit", workstream: "hedge_exit" },
  learning: { jobName: "learning", workstream: "learning" },
  autonomousWorkerState: {
    jobName: "autonomous-worker-state",
    workstream: "autonomous_worker_state"
  }
} as const satisfies Record<string, PostgresSchedulerJob>;

export type PostgresSchedulerLeaseStore = Pick<
  SchedulerLeaseRepository<PoolClient>,
  "acquire" | "heartbeat" | "release"
>;

export class PostgresSchedulerExecutionError extends Error {
  readonly code: string;
  override readonly cause?: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = "PostgresSchedulerExecutionError";
    this.code = code;
    this.cause = cause;
  }
}

export type PostgresSchedulerOperationContext = {
  readonly fence: SchedulerFence;
  readonly signal: AbortSignal;
};

export type RunWithPostgresSchedulerLeaseInput<T> = {
  readonly pool: Pool;
  readonly config: DatabaseConfig;
  readonly job: PostgresSchedulerJob;
  readonly ownerId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly requestId?: string | null;
  readonly correlationId?: string | null;
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
  readonly externalSignal?: AbortSignal;
  readonly operation: (
    context: PostgresSchedulerOperationContext
  ) => Promise<T>;
};

export type PostgresSchedulerExecutionDependencies = {
  readonly repository?: PostgresSchedulerLeaseStore;
  readonly now?: () => Date;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly emit?: (event: Record<string, unknown>) => void;
};

const waitFor = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });

const isoAt = (date: Date, millisecondsAfter = 0) =>
  new Date(date.getTime() + millisecondsAfter).toISOString();

const HEARTBEAT_RETRY_INTERVAL_MS = 1_000;
const HEARTBEAT_EXPIRY_SAFETY_MS = 5_000;
const TRANSIENT_HEARTBEAT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "40001",
  "40P01",
  "53300",
  "55P03",
  "57P01",
  "57P02",
  "57P03"
]);

const safeErrorIdentity = (error: unknown) => {
  const candidate =
    error !== null && typeof error === "object"
      ? error as { name?: unknown; code?: unknown }
      : {};
  return {
    errorName:
      typeof candidate.name === "string" && candidate.name.trim()
        ? candidate.name
        : "Error",
    errorCode:
      typeof candidate.code === "string" && candidate.code.trim()
        ? candidate.code
        : null
  };
};

const isTransientHeartbeatError = (error: unknown) => {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0 && seen.size < 12) {
    const candidate = pending.shift();
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      seen.has(candidate)
    ) {
      continue;
    }
    seen.add(candidate);
    const record = candidate as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    const code = typeof record.code === "string"
      ? record.code.trim().toUpperCase()
      : "";
    if (
      code.startsWith("08") ||
      TRANSIENT_HEARTBEAT_ERROR_CODES.has(code)
    ) {
      return true;
    }
    if (
      typeof record.message === "string" &&
      /\b(connection|socket)\b.*\b(closed|reset|terminated|timeout|timed out)\b|\bsocket hang up\b/i.test(
        record.message
      )
    ) {
      return true;
    }
    if (record.cause !== undefined) pending.push(record.cause);
    if (Array.isArray(record.errors)) pending.push(...record.errors);
  }
  return false;
};

const requireNonempty = (value: string, code: string) => {
  if (!value.trim()) {
    throw new PostgresSchedulerExecutionError(code, "Scheduler identity is required.");
  }
};

const validateInput = <T>(input: RunWithPostgresSchedulerLeaseInput<T>) => {
  if (
    (!input.config.features.schedulerAuthority &&
      !input.config.features.shadowComparison) ||
    !input.config.features.postgresReads ||
    !input.config.features.postgresWrites
  ) {
    throw new PostgresSchedulerExecutionError(
      "POSTGRES_CONTROL_PLANE_AUTHORITY_REQUIRED",
      "PostgreSQL shadow comparison or scheduler authority is required for scheduler execution."
    );
  }
  requireNonempty(input.job.jobName, "SCHEDULER_JOB_NAME_REQUIRED");
  requireNonempty(input.job.workstream, "SCHEDULER_WORKSTREAM_REQUIRED");
  requireNonempty(input.ownerId, "SCHEDULER_OWNER_REQUIRED");
  requireNonempty(input.runId, "SCHEDULER_RUN_REQUIRED");
  requireNonempty(input.operationId, "SCHEDULER_OPERATION_REQUIRED");
  if (
    !Number.isSafeInteger(input.leaseDurationMs) ||
    !Number.isSafeInteger(input.heartbeatIntervalMs) ||
    input.leaseDurationMs <= 0 ||
    input.heartbeatIntervalMs <= 0 ||
    input.heartbeatIntervalMs >= input.leaseDurationMs
  ) {
    throw new PostgresSchedulerExecutionError(
      "SCHEDULER_HEARTBEAT_BOUNDS_INVALID",
      "Heartbeat interval must be positive and shorter than the lease duration."
    );
  }
};

const operationContext = <T>(
  input: RunWithPostgresSchedulerLeaseInput<T>,
  transaction: PoolClient
): PostgresRepositoryContext => ({
  transaction,
  operationId: input.operationId,
  requestId: input.requestId,
  correlationId: input.correlationId,
  actorId: input.ownerId
});

const fencedMutationError = (
  code: "SCHEDULER_FENCE_LOST" | "SCHEDULER_RELEASE_REJECTED",
  action: "heartbeat" | "release",
  result: SchedulerLeaseMutationResult
) =>
  new PostgresSchedulerExecutionError(
    code,
    `Scheduler lease ${action} was rejected with status ${result.status}.`
  );

export const runWithPostgresSchedulerLease = async <T>(
  input: RunWithPostgresSchedulerLeaseInput<T>,
  dependencies: PostgresSchedulerExecutionDependencies = {}
): Promise<T> => {
  validateInput(input);
  const repository = dependencies.repository || new PostgresSchedulerLeaseRepository();
  const now = dependencies.now || (() => new Date());
  const wait = dependencies.wait || waitFor;
  const emit = dependencies.emit || ((event: Record<string, unknown>) => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  });

  const acquiredAt = now();
  const acquisitionStartedAt = performance.now();
  let acquisition: SchedulerLeaseAcquisitionResult;
  try {
    acquisition = await withPostgresTransaction(
      input.pool,
      input.config,
      (client) =>
        repository.acquire(
          {
            jobName: input.job.jobName,
            workstream: input.job.workstream,
            ownerId: input.ownerId,
            runId: input.runId,
            acquiredAt: isoAt(acquiredAt),
            expiresAt: isoAt(acquiredAt, input.leaseDurationMs)
          },
          operationContext(input, client)
        )
    );
  } catch (error) {
    throw new PostgresSchedulerExecutionError(
      "SCHEDULER_ACQUIRE_FAILED",
      "Scheduler lease acquisition failed.",
      error
    );
  }

  if (acquisition.status === "held") {
    throw new PostgresSchedulerExecutionError(
      "SCHEDULER_LEASE_HELD",
      "The scheduler job is already owned by another active lease."
    );
  }
  const fence: SchedulerFence = {
    jobName: acquisition.lease.jobName,
    workstream: acquisition.lease.workstream,
    ownerId: acquisition.lease.ownerId,
    runId: acquisition.lease.runId,
    fencingToken: acquisition.lease.fencingToken
  };
  if (
    fence.jobName !== input.job.jobName ||
    fence.workstream !== input.job.workstream ||
    fence.ownerId !== input.ownerId ||
    fence.runId !== input.runId ||
    acquisition.lease.status !== "held"
  ) {
    throw new PostgresSchedulerExecutionError(
      "SCHEDULER_ACQUISITION_IDENTITY_MISMATCH",
      "The acquired scheduler lease does not match the requested identity."
    );
  }
  const acquiredLeaseExpiresAtMs = Date.parse(acquisition.lease.expiresAt);
  if (!Number.isFinite(acquiredLeaseExpiresAtMs)) {
    throw new PostgresSchedulerExecutionError(
      "SCHEDULER_ACQUISITION_LEASE_INVALID",
      "The acquired scheduler lease has no valid expiry timestamp."
    );
  }
  emit({
    event: "postgres_scheduler_lease_acquired",
    jobName: fence.jobName,
    workstream: fence.workstream,
    leaseOwner: fence.ownerId,
    runId: fence.runId,
    fencingToken: fence.fencingToken,
    acquisitionLatencyMs: performance.now() - acquisitionStartedAt,
    acquiredAt: acquisition.lease.acquiredAt,
    expiresAt: acquisition.lease.expiresAt,
    remainingLeaseMs: Math.max(
      0,
      Date.parse(acquisition.lease.expiresAt) - now().getTime()
    )
  });

  const heartbeatStop = new AbortController();
  const operationAbort = new AbortController();
  let leaseExpiresAtMs = acquiredLeaseExpiresAtMs;
  let heartbeatFailure: PostgresSchedulerExecutionError | undefined;
  let terminationFailure: PostgresSchedulerExecutionError | undefined;
  const abortForExternalTermination = () => {
    terminationFailure = new PostgresSchedulerExecutionError(
      "SCHEDULER_COMMAND_TERMINATED",
      "The scheduled PostgreSQL command was terminated before completion.",
      input.externalSignal?.reason
    );
    operationAbort.abort(terminationFailure);
  };
  if (input.externalSignal?.aborted) {
    abortForExternalTermination();
  } else {
    input.externalSignal?.addEventListener(
      "abort",
      abortForExternalTermination,
      { once: true }
    );
  }

  const heartbeatLoop = async () => {
    while (!heartbeatStop.signal.aborted) {
      try {
        await wait(input.heartbeatIntervalMs, heartbeatStop.signal);
      } catch (error) {
        if (heartbeatStop.signal.aborted) return;
        heartbeatFailure = new PostgresSchedulerExecutionError(
          "SCHEDULER_HEARTBEAT_FAILED",
          "Scheduler heartbeat wait failed.",
          error
        );
        operationAbort.abort(heartbeatFailure);
        return;
      }
      if (heartbeatStop.signal.aborted) return;

      let retryAttempt = 0;
      while (!heartbeatStop.signal.aborted) {
        const heartbeatAt = now();
        const renewalStartedAt = performance.now();
        try {
          const heartbeat = await withPostgresTransaction(
            input.pool,
            input.config,
            (client) =>
              repository.heartbeat(
                {
                  jobName: fence.jobName,
                  ownerId: fence.ownerId,
                  runId: fence.runId,
                  fencingToken: fence.fencingToken,
                  heartbeatAt: isoAt(heartbeatAt),
                  expiresAt: isoAt(heartbeatAt, input.leaseDurationMs)
                },
                operationContext(input, client)
              )
          );
          if (heartbeat.status !== "updated") {
            heartbeatFailure = fencedMutationError(
              "SCHEDULER_FENCE_LOST",
              "heartbeat",
              heartbeat
            );
            operationAbort.abort(heartbeatFailure);
            return;
          }
          const renewedLeaseExpiresAtMs = Date.parse(heartbeat.lease.expiresAt);
          if (!Number.isFinite(renewedLeaseExpiresAtMs)) {
            throw new PostgresSchedulerExecutionError(
              "SCHEDULER_HEARTBEAT_LEASE_INVALID",
              "The renewed scheduler lease has no valid expiry timestamp."
            );
          }
          leaseExpiresAtMs = renewedLeaseExpiresAtMs;
          emit({
            event: "postgres_scheduler_fence_renewed",
            jobName: fence.jobName,
            workstream: fence.workstream,
            leaseOwner: fence.ownerId,
            runId: fence.runId,
            fencingToken: fence.fencingToken,
            heartbeatAt: heartbeat.lease.heartbeatAt,
            expiresAt: heartbeat.lease.expiresAt,
            renewalTimingMs: input.heartbeatIntervalMs,
            renewalLatencyMs: performance.now() - renewalStartedAt,
            remainingLeaseMs: Math.max(
              0,
              leaseExpiresAtMs - now().getTime()
            )
          });
          break;
        } catch (error) {
          const remainingLeaseMs = Math.max(
            0,
            leaseExpiresAtMs - now().getTime()
          );
          const retryDelayMs = Math.min(
            HEARTBEAT_RETRY_INTERVAL_MS,
            Math.max(0, remainingLeaseMs - HEARTBEAT_EXPIRY_SAFETY_MS)
          );
          if (
            error instanceof PostgresSchedulerExecutionError ||
            !isTransientHeartbeatError(error) ||
            retryDelayMs <= 0
          ) {
            heartbeatFailure =
              error instanceof PostgresSchedulerExecutionError
                ? error
                : new PostgresSchedulerExecutionError(
                    "SCHEDULER_HEARTBEAT_FAILED",
                    "Scheduler heartbeat failed before the safe renewal deadline.",
                    error
                  );
            emit({
              event: "postgres_scheduler_fence_renewal_failed",
              jobName: fence.jobName,
              workstream: fence.workstream,
              leaseOwner: fence.ownerId,
              runId: fence.runId,
              fencingToken: fence.fencingToken,
              retryAttempt,
              remainingLeaseMs,
              ...safeErrorIdentity(error)
            });
            operationAbort.abort(heartbeatFailure);
            return;
          }
          retryAttempt += 1;
          emit({
            event: "postgres_scheduler_fence_renewal_retry",
            jobName: fence.jobName,
            workstream: fence.workstream,
            leaseOwner: fence.ownerId,
            runId: fence.runId,
            fencingToken: fence.fencingToken,
            retryAttempt,
            retryDelayMs,
            remainingLeaseMs,
            ...safeErrorIdentity(error)
          });
          try {
            await wait(retryDelayMs, heartbeatStop.signal);
          } catch (waitError) {
            heartbeatFailure = new PostgresSchedulerExecutionError(
              "SCHEDULER_HEARTBEAT_FAILED",
              "Scheduler heartbeat retry wait failed.",
              waitError
            );
            operationAbort.abort(heartbeatFailure);
            return;
          }
          if (heartbeatStop.signal.aborted) return;
        }
      }
    }
  };

  let value: T | undefined;
  let operationError: unknown;
  const operationPromise = Promise.resolve().then(() =>
    input.operation({ fence, signal: operationAbort.signal })
  );
  const heartbeatPromise = heartbeatLoop();
  try {
    value = await operationPromise;
  } catch (error) {
    operationError = error;
  } finally {
    heartbeatStop.abort();
    await heartbeatPromise;
    input.externalSignal?.removeEventListener(
      "abort",
      abortForExternalTermination
    );
  }
  if (terminationFailure && operationError === undefined) {
    operationError = terminationFailure;
  }

  const releasedAt = now();
  const releaseStartedAt = performance.now();
  let releaseFailure: PostgresSchedulerExecutionError | undefined;
  try {
    const release = await withPostgresTransaction(
      input.pool,
      input.config,
      (client) =>
        repository.release(
          {
            jobName: fence.jobName,
            ownerId: fence.ownerId,
            runId: fence.runId,
            fencingToken: fence.fencingToken,
            releasedAt: isoAt(releasedAt),
            releaseReason: heartbeatFailure
              ? "fence_lost"
              : operationError
                ? "failed"
                : "completed"
          },
          operationContext(input, client)
        )
    );
    if (release.status !== "updated") {
      releaseFailure = fencedMutationError(
        "SCHEDULER_RELEASE_REJECTED",
        "release",
        release
      );
    } else {
      emit({
        event: "postgres_scheduler_lease_released",
        jobName: fence.jobName,
        workstream: fence.workstream,
        leaseOwner: fence.ownerId,
        runId: fence.runId,
        fencingToken: fence.fencingToken,
        releasedAt: release.lease.releasedAt,
        releaseReason: release.lease.releaseReason,
        releaseLatencyMs: performance.now() - releaseStartedAt
      });
    }
  } catch (error) {
    releaseFailure =
      error instanceof PostgresSchedulerExecutionError
        ? error
        : new PostgresSchedulerExecutionError(
            "SCHEDULER_RELEASE_FAILED",
            "Scheduler lease release failed.",
            error
          );
  }

  if (heartbeatFailure) throw heartbeatFailure;
  if (releaseFailure) throw releaseFailure;
  if (terminationFailure) throw terminationFailure;
  if (operationError !== undefined) throw operationError;
  return value as T;
};
