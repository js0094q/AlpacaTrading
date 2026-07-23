import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Pool } from "pg";

import { loadDatabaseConfig, type DatabaseConfig } from "../lib/database/config.js";
import { createPostgresPool } from "../lib/database/postgres.js";
import type { SchedulerFence } from "../repositories/contracts/common.js";
import { assertControlPlaneFenceActive, withControlPlaneRuntimeContext } from "./controlPlaneRuntimeContext.js";
import {
  resolvePostgresSchedulerJob,
  type PostgresSchedulerCommandInput
} from "./postgresSchedulerCommandRegistry.js";
import {
  runWithPostgresSchedulerLease,
  type RunWithPostgresSchedulerLeaseInput
} from "./postgresSchedulerExecutionService.js";

export type PostgresScheduledCommandOperationContext = {
  readonly pool: Pool;
  readonly config: DatabaseConfig;
  readonly fence: SchedulerFence;
  readonly signal: AbortSignal;
};

export type PostgresScheduledCommandInput<T> = PostgresSchedulerCommandInput & {
  readonly operation: (
    context?: PostgresScheduledCommandOperationContext
  ) => Promise<T>;
};

export interface PostgresScheduledCommandDependencies {
  loadConfig: () => DatabaseConfig;
  createPool: (config: DatabaseConfig) => Pool;
  invocationId: () => string;
  ownerId: () => string;
  runWithLease: <T>(input: RunWithPostgresSchedulerLeaseInput<T>) => Promise<T>;
  reportShadowFailure: (code: string) => void;
}

const defaultDependencies: PostgresScheduledCommandDependencies = {
  loadConfig: () => loadDatabaseConfig(process.env, { purpose: "application" }),
  createPool: (config) => createPostgresPool(config, "pooled"),
  invocationId: () => randomUUID(),
  ownerId: () => {
    const invocation =
      process.env.INVOCATION_ID?.trim() ||
      process.env.RESEARCH_REQUEST_ID?.trim() ||
      String(process.pid);
    return `${hostname()}:${invocation}:${process.pid}`.slice(0, 240);
  },
  runWithLease: runWithPostgresSchedulerLease,
  reportShadowFailure: (code) => {
    process.stderr.write(`${JSON.stringify({ event: "postgres_scheduler_shadow_failure", code })}\n`);
  }
};

export const runPostgresScheduledCommand = async <T>(
  input: PostgresScheduledCommandInput<T>,
  dependencies: PostgresScheduledCommandDependencies = defaultDependencies
): Promise<T> => {
  const job = resolvePostgresSchedulerJob(input);
  if (!job) return input.operation(undefined);

  const config = dependencies.loadConfig();
  const schedulerEnabled =
    config.features.shadowComparison || config.features.schedulerAuthority;
  if (!schedulerEnabled) return input.operation(undefined);

  const pool = dependencies.createPool(config);
  const schedulerInvocationId = dependencies.invocationId();
  const requestId = process.env.RESEARCH_REQUEST_ID?.trim() || null;
  const correlationId = process.env.RESEARCH_CORRELATION_ID?.trim() || null;
  let operationStarted = false;
  let operationCompleted = false;
  let operationResult: T | undefined;
  try {
    try {
      return await dependencies.runWithLease({
        pool,
        config,
        job,
        ownerId: dependencies.ownerId(),
        runId: schedulerInvocationId,
        operationId: `scheduler:${schedulerInvocationId}`,
        requestId,
        correlationId,
        leaseDurationMs: 60_000,
        heartbeatIntervalMs: 15_000,
        operation: async ({ fence, signal }) =>
          withControlPlaneRuntimeContext(
            {
              config,
              pool,
              fence,
              signal,
              operationId: `scheduler:${schedulerInvocationId}`,
              requestId,
              correlationId,
              researchRunVersions: new Map()
            },
            async () => {
              assertControlPlaneFenceActive();
              operationStarted = true;
              const result = await input.operation({ pool, config, fence, signal });
              operationResult = result;
              operationCompleted = true;
              assertControlPlaneFenceActive();
              return result;
            }
          )
      });
    } catch (error) {
      if (!config.features.shadowComparison || config.features.controlPlaneAuthority) {
        throw error;
      }
      if (operationStarted && !operationCompleted) {
        throw error;
      }
      dependencies.reportShadowFailure("POSTGRES_SCHEDULER_SHADOW_FAILED");
      if (operationCompleted) return operationResult as T;
      return input.operation(undefined);
    }
  } finally {
    await pool.end();
  }
};
