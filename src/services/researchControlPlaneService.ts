import { createHash } from "node:crypto";
import { hostname } from "node:os";
import type { PoolClient } from "pg";

import { withPostgresTransaction } from "../lib/database/postgresTransaction.js";
import type { FencedPostgresRepositoryContext } from "../repositories/postgres/postgresRepositorySupport.js";
import {
  PostgresCandidateLifecycleEventRepository,
  PostgresCandidateRepository
} from "../repositories/postgres/postgresCandidateRepository.js";
import { PostgresResearchRunRepository } from "../repositories/postgres/postgresResearchRunRepository.js";
import type {
  CandidateDecision,
  CandidateDecisionRecord,
  DecisionId,
  PaperTradeCandidateRow,
  RiskProfile
} from "../types.js";
import { persistCandidateDecisions } from "./candidateRankingService.js";
import {
  assertControlPlaneFenceActive,
  currentControlPlaneRuntimeContext,
  type ControlPlaneRuntimeContext
} from "./controlPlaneRuntimeContext.js";
import { createDecisionId } from "./marketDecisionIdentityService.js";
import {
  finishResearchRun,
  heartbeatResearchRun,
  RESEARCH_RECOVERY_REASON,
  RESEARCH_RUN_STALE_AFTER_MS,
  reserveResearchRun,
  type ResearchRunReservation,
  updateResearchRunUniverseSize,
  withActiveResearchRunLease
} from "./researchRunLifecycleService.js";

export interface ResearchReservationInput {
  readonly runId: string;
  readonly now: Date;
  readonly riskProfile: string;
  readonly optionsEnabled: boolean;
  readonly configJson: string;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly workerIdentity?: string;
}

export interface ResearchFinishInput {
  readonly status: "completed" | "failed";
  readonly targetsGenerated: number;
  readonly candidatesSelected: number;
  readonly summaryJson: string;
  readonly errorMessage?: string | null;
  readonly at?: Date;
}

export interface ResearchPersistenceAdapter {
  reserve(input: ResearchReservationInput): Promise<ResearchRunReservation>;
  heartbeat(runId: string, at?: Date): Promise<boolean>;
  updateUniverseSize(runId: string, universeSize: number, at?: Date): Promise<boolean>;
  finish(runId: string, input: ResearchFinishInput): Promise<void>;
  persistCandidates(
    runId: string,
    decisions: readonly CandidateDecisionRecord[]
  ): Promise<Array<PaperTradeCandidateRow & { readonly decision: CandidateDecision }>>;
}

export type ResearchControlPlaneDependencies = {
  readonly sqlite: ResearchPersistenceAdapter;
  readonly postgres: ResearchPersistenceAdapter;
  readonly currentRuntime: () => ControlPlaneRuntimeContext | null;
  readonly reportDiscrepancy?: (code: string) => void;
};

export class ResearchControlPlaneProjectionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ResearchControlPlaneProjectionError";
    this.code = code;
  }
}

const lifecycleEventId = (candidate: {
  readonly id: string;
  readonly decisionId?: DecisionId | null;
  readonly decision?: string;
}) =>
  `candidate-lifecycle-${createHash("sha256")
    .update(candidate.decisionId || candidate.id)
    .update("\0")
    .update(candidate.id)
    .update("\0")
    .update(candidate.decision || "selected")
    .digest("hex")}`;

const withDecisionIds = (
  decisions: readonly CandidateDecisionRecord[],
  persisted?: readonly PaperTradeCandidateRow[]
) => {
  const persistedById = new Map(persisted?.map((candidate) => [candidate.id, candidate]));
  return decisions.map((decision) => ({
    ...decision,
    decisionId:
      persistedById.get(decision.id)?.decisionId || decision.decisionId || createDecisionId()
  }));
};

const sameReservation = (left: ResearchRunReservation, right: ResearchRunReservation) => {
  if (left.status !== right.status) return false;
  if (left.status === "reserved" && right.status === "reserved") {
    return left.runId === right.runId;
  }
  return left.status === "already_running" && right.status === "already_running" &&
    left.activeRunId === right.activeRunId;
};

const sameCandidates = (
  left: ReadonlyArray<PaperTradeCandidateRow & { readonly decision: CandidateDecision }>,
  right: ReadonlyArray<PaperTradeCandidateRow & { readonly decision: CandidateDecision }>
) => {
  const normalize = (rows: readonly PaperTradeCandidateRow[]) =>
    rows.map((row) => ({
      id: row.id,
      decisionId: row.decisionId || null,
      researchRunId: row.researchRunId,
      rank: row.rank,
      symbol: row.symbol
    })).sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
};

const isShadow = (context: ControlPlaneRuntimeContext | null) =>
  Boolean(context?.config.features.shadowComparison && !context.config.features.controlPlaneAuthority);

const isAuthority = (context: ControlPlaneRuntimeContext | null) =>
  Boolean(context?.config.features.controlPlaneAuthority);

export const createResearchControlPlaneService = (
  dependencies: ResearchControlPlaneDependencies
) => {
  const discrepancy = dependencies.reportDiscrepancy || (() => undefined);

  const requireProjection = (context: ControlPlaneRuntimeContext) => {
    if (
      context.config.features.controlPlaneAuthority &&
      !context.config.features.executionStateAuthority &&
      !context.config.features.sqliteAuditMirror
    ) {
      throw new ResearchControlPlaneProjectionError(
        "SQLITE_CONTROL_PLANE_PROJECTION_REQUIRED"
      );
    }
  };

  const projectToSqlite = (context: ControlPlaneRuntimeContext) =>
    context.config.features.sqliteAuditMirror;

  return {
    async reserve(input: ResearchReservationInput) {
      const context = dependencies.currentRuntime();
      if (!context || (!isShadow(context) && !isAuthority(context))) {
        return dependencies.sqlite.reserve(input);
      }
      if (isShadow(context)) {
        const authoritative = await dependencies.sqlite.reserve(input);
        try {
          const shadow = await dependencies.postgres.reserve(input);
          if (!sameReservation(authoritative, shadow)) {
            discrepancy("RESEARCH_RESERVATION_SHADOW_MISMATCH");
          }
        } catch {
          discrepancy("RESEARCH_RESERVATION_SHADOW_WRITE_FAILED");
        }
        return authoritative;
      }
      requireProjection(context);
      const authoritative = await dependencies.postgres.reserve(input);
      if (authoritative.status === "reserved" && projectToSqlite(context)) {
        const projection = await dependencies.sqlite.reserve(input);
        if (!sameReservation(authoritative, projection)) {
          throw new ResearchControlPlaneProjectionError(
            "RESEARCH_RESERVATION_PROJECTION_MISMATCH"
          );
        }
      }
      return authoritative;
    },

    async heartbeat(runId: string, at = new Date()) {
      const context = dependencies.currentRuntime();
      if (!context || (!isShadow(context) && !isAuthority(context))) {
        return dependencies.sqlite.heartbeat(runId, at);
      }
      if (isShadow(context)) {
        const authoritative = await dependencies.sqlite.heartbeat(runId, at);
        try {
          const shadow = await dependencies.postgres.heartbeat(runId, at);
          if (authoritative !== shadow) discrepancy("RESEARCH_HEARTBEAT_SHADOW_MISMATCH");
        } catch {
          discrepancy("RESEARCH_HEARTBEAT_SHADOW_WRITE_FAILED");
        }
        return authoritative;
      }
      requireProjection(context);
      const authoritative = await dependencies.postgres.heartbeat(runId, at);
      if (
        authoritative &&
        projectToSqlite(context) &&
        !context.config.features.schedulerAuthority
      ) {
        const projection = await dependencies.sqlite.heartbeat(runId, at);
        if (!projection) {
          throw new ResearchControlPlaneProjectionError(
            "RESEARCH_HEARTBEAT_PROJECTION_MISMATCH"
          );
        }
      }
      return authoritative;
    },

    async updateUniverseSize(runId: string, universeSize: number, at = new Date()) {
      const context = dependencies.currentRuntime();
      if (!context || (!isShadow(context) && !isAuthority(context))) {
        return dependencies.sqlite.updateUniverseSize(runId, universeSize, at);
      }
      if (isShadow(context)) {
        const authoritative = await dependencies.sqlite.updateUniverseSize(runId, universeSize, at);
        try {
          const shadow = await dependencies.postgres.updateUniverseSize(runId, universeSize, at);
          if (authoritative !== shadow) discrepancy("RESEARCH_PROGRESS_SHADOW_MISMATCH");
        } catch {
          discrepancy("RESEARCH_PROGRESS_SHADOW_WRITE_FAILED");
        }
        return authoritative;
      }
      requireProjection(context);
      const authoritative = await dependencies.postgres.updateUniverseSize(runId, universeSize, at);
      if (authoritative && projectToSqlite(context)) {
        const projection = await dependencies.sqlite.updateUniverseSize(runId, universeSize, at);
        if (!projection) {
          throw new ResearchControlPlaneProjectionError(
            "RESEARCH_PROGRESS_PROJECTION_MISMATCH"
          );
        }
      }
      return authoritative;
    },

    async finish(runId: string, input: ResearchFinishInput) {
      const context = dependencies.currentRuntime();
      if (!context || (!isShadow(context) && !isAuthority(context))) {
        return dependencies.sqlite.finish(runId, input);
      }
      if (isShadow(context)) {
        await dependencies.sqlite.finish(runId, input);
        try {
          await dependencies.postgres.finish(runId, input);
        } catch {
          discrepancy("RESEARCH_FINISH_SHADOW_WRITE_FAILED");
        }
        return;
      }
      requireProjection(context);
      await dependencies.postgres.finish(runId, input);
      if (projectToSqlite(context)) await dependencies.sqlite.finish(runId, input);
    },

    async persistCandidates(
      runId: string,
      decisions: readonly CandidateDecisionRecord[]
    ) {
      const context = dependencies.currentRuntime();
      if (!context || (!isShadow(context) && !isAuthority(context))) {
        return dependencies.sqlite.persistCandidates(runId, decisions);
      }
      if (isShadow(context)) {
        const authoritative = await dependencies.sqlite.persistCandidates(runId, decisions);
        try {
          const shadow = await dependencies.postgres.persistCandidates(
            runId,
            withDecisionIds(decisions, authoritative)
          );
          if (!sameCandidates(authoritative, shadow)) {
            discrepancy("RESEARCH_CANDIDATES_SHADOW_MISMATCH");
          }
        } catch {
          discrepancy("RESEARCH_CANDIDATES_SHADOW_WRITE_FAILED");
        }
        return authoritative;
      }
      requireProjection(context);
      const authoritative = await dependencies.postgres.persistCandidates(
        runId,
        withDecisionIds(decisions)
      );
      if (!projectToSqlite(context)) return authoritative;
      const projection = await dependencies.sqlite.persistCandidates(
        runId,
        withDecisionIds(decisions, authoritative)
      );
      if (!sameCandidates(authoritative, projection)) {
        throw new ResearchControlPlaneProjectionError(
          "RESEARCH_CANDIDATES_PROJECTION_MISMATCH"
        );
      }
      return authoritative;
    }
  };
};

const sqliteAdapter: ResearchPersistenceAdapter = {
  async reserve(input) {
    return reserveResearchRun(input);
  },
  async heartbeat(runId, at) {
    return heartbeatResearchRun(runId, at);
  },
  async updateUniverseSize(runId, universeSize, at) {
    return updateResearchRunUniverseSize(runId, universeSize, at);
  },
  async finish(runId, input) {
    finishResearchRun(runId, input);
  },
  async persistCandidates(runId, decisions) {
    const lifecycleEventIds = Object.fromEntries(
      decisions.map((decision) => [decision.id, lifecycleEventId(decision)])
    );
    return withActiveResearchRunLease(runId, () =>
      persistCandidateDecisions({
        researchRunId: runId,
        decisions: [...decisions],
        lifecycleEventIds
      })
    );
  }
};

const postgresContext = (
  runtime: ControlPlaneRuntimeContext,
  transaction: PoolClient
): FencedPostgresRepositoryContext => ({
  transaction,
  operationId: runtime.operationId,
  requestId: runtime.requestId,
  correlationId: runtime.correlationId,
  actorId: runtime.fence.ownerId,
  schedulerFence: runtime.fence
});

const versionedResult = (
  runtime: ControlPlaneRuntimeContext,
  runId: string,
  result: { status: string; version?: number }
) => {
  if (result.status === "updated" && result.version !== undefined) {
    runtime.researchRunVersions.set(runId, result.version);
    return true;
  }
  if (result.status === "fence_rejected") {
    throw new ResearchControlPlaneProjectionError("RESEARCH_POSTGRES_FENCE_REJECTED");
  }
  return false;
};

const postgresAdapter: ResearchPersistenceAdapter = {
  async reserve(input) {
    const runtime = assertControlPlaneFenceActive();
    const config = JSON.parse(input.configJson) as unknown;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new ResearchControlPlaneProjectionError("RESEARCH_CONFIG_JSON_INVALID");
    }
    const repository = new PostgresResearchRunRepository();
    const result = await withPostgresTransaction(runtime.pool, runtime.config, (client) =>
      repository.reserve(
          {
            runId: input.runId,
            startedAt: input.now.toISOString(),
            staleBefore: new Date(
              input.now.getTime() - RESEARCH_RUN_STALE_AFTER_MS
            ).toISOString(),
            recoveryReason: RESEARCH_RECOVERY_REASON,
            recoverySource: "research_preflight",
            riskProfile: input.riskProfile as RiskProfile,
          optionsEnabled: input.optionsEnabled,
          config: config as Record<string, never>,
          workerIdentity: input.workerIdentity || `${hostname()}:${process.pid}`
        },
        postgresContext(runtime, client)
      )
    );
    if (result.status === "fence_rejected") {
      throw new ResearchControlPlaneProjectionError("RESEARCH_POSTGRES_FENCE_REJECTED");
    }
    if (result.status === "reserved") {
      runtime.researchRunVersions.set(input.runId, result.version);
      return {
        status: "reserved" as const,
        runId: input.runId,
        startedAt: input.now.toISOString()
      };
    }
    return {
      status: "already_running" as const,
      activeRunId: result.activeRunId,
      startedAt: result.startedAt,
      heartbeatAt: result.heartbeatAt
    };
  },

  async heartbeat(runId, at = new Date()) {
    const runtime = assertControlPlaneFenceActive();
    const expectedVersion = runtime.researchRunVersions.get(runId);
    if (expectedVersion === undefined) return false;
    const repository = new PostgresResearchRunRepository();
    const result = await withPostgresTransaction(runtime.pool, runtime.config, (client) =>
      repository.heartbeat(
        { runId, expectedVersion, heartbeatAt: at.toISOString() },
        postgresContext(runtime, client)
      )
    );
    return versionedResult(runtime, runId, result);
  },

  async updateUniverseSize(runId, universeSize, at = new Date()) {
    const runtime = assertControlPlaneFenceActive();
    const expectedVersion = runtime.researchRunVersions.get(runId);
    if (expectedVersion === undefined) return false;
    const repository = new PostgresResearchRunRepository();
    const result = await withPostgresTransaction(runtime.pool, runtime.config, (client) =>
      repository.updateProgress(
        { runId, expectedVersion, heartbeatAt: at.toISOString(), universeSize },
        postgresContext(runtime, client)
      )
    );
    return versionedResult(runtime, runId, result);
  },

  async finish(runId, input) {
    const runtime = assertControlPlaneFenceActive();
    const expectedVersion = runtime.researchRunVersions.get(runId);
    if (expectedVersion === undefined) {
      throw new ResearchControlPlaneProjectionError("RESEARCH_POSTGRES_VERSION_MISSING");
    }
    const summary = JSON.parse(input.summaryJson) as unknown;
    const repository = new PostgresResearchRunRepository();
    const result = await withPostgresTransaction(runtime.pool, runtime.config, (client) =>
      repository.finish(
        {
          runId,
          expectedVersion,
          status: input.status,
          completedAt: (input.at || new Date()).toISOString(),
          targetsGenerated: input.targetsGenerated,
          candidatesSelected: input.candidatesSelected,
          summary: summary as Record<string, never>,
          errorMessage: input.errorMessage
        },
        postgresContext(runtime, client)
      )
    );
    if (!versionedResult(runtime, runId, result)) {
      throw new ResearchControlPlaneProjectionError("RESEARCH_POSTGRES_FINISH_REJECTED");
    }
  },

  async persistCandidates(runId, decisions) {
    const runtime = assertControlPlaneFenceActive();
    const candidateRepository = new PostgresCandidateRepository();
    const eventRepository = new PostgresCandidateLifecycleEventRepository();
    return withPostgresTransaction(runtime.pool, runtime.config, async (client) => {
      const context = postgresContext(runtime, client);
      const results = await candidateRepository.insertMany(
        { researchRunId: runId, candidates: decisions, createdAt: new Date().toISOString() },
        context
      );
      const persisted: Array<PaperTradeCandidateRow & { readonly decision: CandidateDecision }> = [];
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index]!;
        if (result.status === "fence_rejected") {
          throw new ResearchControlPlaneProjectionError("RESEARCH_POSTGRES_FENCE_REJECTED");
        }
        const candidate = result.candidate;
        persisted.push(candidate);
        const existingEvents = result.status === "duplicate"
          ? await eventRepository.listByCandidate({ candidateId: candidate.id }, context)
          : [];
        if (existingEvents.length > 0) continue;
        const decision = decisions[index]!;
        const event = await eventRepository.append(
          {
            eventId: lifecycleEventId({ ...candidate, decision: decision.decision }),
            candidateId: candidate.id,
            researchRunId: runId,
            sequence: 0,
            fromStatus: null,
            toStatus: decision.decision,
            reasonCode: decision.decisionReason,
            occurredAt: decision.asOf,
            producedAt: decision.asOf,
            source: `candidate.initial.${decision.decision}`,
            schemaVersion: 1,
            requestId: runtime.requestId,
            correlationId: runtime.correlationId,
            evidence: {
              decisionId: candidate.decisionId || null,
              dataQualityStatus: decision.dataQualityStatus
            }
          },
          context
        );
        if (event.status !== "inserted" && event.status !== "duplicate") {
          throw new ResearchControlPlaneProjectionError(
            `RESEARCH_POSTGRES_EVENT_REJECTED:${event.status}`
          );
        }
      }
      return persisted;
    });
  }
};

export const researchControlPlaneService = createResearchControlPlaneService({
  sqlite: sqliteAdapter,
  postgres: postgresAdapter,
  currentRuntime: currentControlPlaneRuntimeContext,
  reportDiscrepancy: (code) => {
    process.stderr.write(`${JSON.stringify({ event: "control_plane_shadow_discrepancy", code })}\n`);
  }
});
