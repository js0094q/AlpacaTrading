import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool } from "pg";

import type { DatabaseConfig } from "../lib/database/config.js";
import type { SchedulerFence } from "../repositories/contracts/common.js";

export interface ControlPlaneRuntimeContext {
  readonly config: DatabaseConfig;
  readonly pool: Pool;
  readonly fence: SchedulerFence;
  readonly signal: AbortSignal;
  readonly operationId: string;
  readonly requestId: string | null;
  readonly correlationId: string | null;
  readonly researchRunVersions: Map<string, number>;
}

export class ControlPlaneFenceLostError extends Error {
  readonly code = "CONTROL_PLANE_FENCE_LOST";

  constructor() {
    super("PostgreSQL scheduler fence is no longer active.");
    this.name = "ControlPlaneFenceLostError";
  }
}

const runtimeContext = new AsyncLocalStorage<ControlPlaneRuntimeContext>();

export const currentControlPlaneRuntimeContext = () => runtimeContext.getStore() ?? null;

export const withControlPlaneRuntimeContext = <T>(
  context: ControlPlaneRuntimeContext,
  operation: () => Promise<T>
) => runtimeContext.run(context, operation);

export const assertControlPlaneFenceActive = () => {
  const context = currentControlPlaneRuntimeContext();
  if (!context || context.signal.aborted) {
    throw new ControlPlaneFenceLostError();
  }
  return context;
};

export const assertScheduledWriteFenceActive = () => {
  const context = currentControlPlaneRuntimeContext();
  if (!context || !context.config.features.schedulerAuthority) return context;
  if (context.signal.aborted) throw new ControlPlaneFenceLostError();
  return context;
};
