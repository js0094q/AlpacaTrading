import { randomUUID } from "node:crypto";

import { seedUniverse } from "../config/universe.seed.js";
import { canonicalJsonHash } from "../lib/canonicalJson.js";
import type { SchedulerFence } from "../repositories/contracts/common.js";
import { PostgresMarketDataRepository } from "../repositories/postgres/postgresMarketDataRepository.js";
import type { FencedPostgresRepositoryContext } from "../repositories/postgres/postgresRepositorySupport.js";
import type { RiskProfile } from "../types.js";
import {
  paperExplorationProfile,
  paperExplorationThresholds,
  type PaperExplorationThresholds
} from "./paperExplorationConfig.js";
import { buildPostgresFeaturesAndTargets } from "./postgresFeatureTargetService.js";
import { refreshPostgresMarketData } from "./postgresMarketDataService.js";

export type PostgresResearchQuery = {
  query: (sql: string, values?: readonly unknown[]) => Promise<{
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }>;
};

type MarketResult = Awaited<ReturnType<typeof refreshPostgresMarketData>>;
type FeatureTargetResult = Awaited<ReturnType<typeof buildPostgresFeaturesAndTargets>>;

type PostgresLearningModelCapability = {
  authority: "postgres";
  relation: "public.learning_runs";
  status: "absent";
  verifiedAt: string;
};

type ResearchDependencies = {
  symbols: readonly string[];
  refreshMarketData: typeof refreshPostgresMarketData;
  buildFeaturesAndTargets: typeof buildPostgresFeaturesAndTargets;
};

const dependencies: ResearchDependencies = {
  symbols: seedUniverse,
  refreshMarketData: refreshPostgresMarketData,
  buildFeaturesAndTargets: buildPostgresFeaturesAndTargets
};

const fenceSql = (start: number) => `EXISTS (
  SELECT 1 FROM scheduler_leases lease
  WHERE lease.job_name = $${start} AND lease.workstream = $${start + 1}
    AND lease.owner_id = $${start + 2} AND lease.run_id = $${start + 3}
    AND lease.fencing_token = $${start + 4} AND lease.status = 'held'
    AND lease.expires_at > now()
)`;

const fenceValues = (fence: SchedulerFence) => [
  fence.jobName, fence.workstream, fence.ownerId, fence.runId, fence.fencingToken
];

const EVIDENCE_BATCH_SIZE = 250;
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

type ResearchEvidenceRow = {
  type: string;
  symbol: string;
  observedAt: string;
  table: string;
  key: string;
  fingerprint: string;
  payload: unknown;
};

const failResearchRun = async (input: {
  query: PostgresResearchQuery;
  fence: SchedulerFence;
  runId: string;
  message: string;
}) => {
  const failedAt = new Date().toISOString();
  const values = [
    input.runId,
    input.message.split(":", 1)[0],
    input.message,
    failedAt
  ];
  try {
    const fenced = await input.query.query(
      `UPDATE research_runs
       SET status = 'failed', error_code = $2, error_message = $3,
           completed_at = $4, heartbeat_at = $4, updated_at = $4,
           version = version + 1
       WHERE id = $1 AND status = 'running' AND ${fenceSql(5)}`,
      [...values, ...fenceValues(input.fence)]
    );
    if (fenced.rowCount === 1) return;
  } catch {
    // Retry below with exact run ownership when the fenced query itself failed.
  }
  const owned = await input.query.query(
    `UPDATE research_runs
     SET status = 'failed', error_code = $2, error_message = $3,
         completed_at = $4, heartbeat_at = $4, updated_at = $4,
         version = version + 1
     WHERE id = $1 AND status = 'running'
       AND worker_identity = $5 AND scheduler_job_name = $6
       AND scheduler_fencing_token = $7`,
    [...values, input.fence.ownerId, input.fence.jobName, input.fence.fencingToken]
  );
  if (owned.rowCount !== 1) {
    const current = await input.query.query(
      "SELECT status FROM research_runs WHERE id = $1",
      [input.runId]
    );
    if (current.rows[0]?.status === "reserved" || current.rows[0]?.status === "running") {
      throw new Error("POSTGRES_RESEARCH_FAILURE_PERSIST_FAILED");
    }
  }
};

const resolvePostgresLearningModelCapability = async (
  query: PostgresResearchQuery,
  verifiedAt: string
): Promise<PostgresLearningModelCapability> => {
  const result = await query.query(
    "SELECT to_regclass('public.learning_runs')::text AS learning_model_relation"
  );
  if (result.rowCount !== 1 || !result.rows[0] ||
      !("learning_model_relation" in result.rows[0])) {
    throw new Error("POSTGRES_LEARNING_MODEL_CAPABILITY_UNVERIFIED");
  }
  const relation = result.rows[0].learning_model_relation;
  if (relation !== null) {
    throw new Error("POSTGRES_LEARNING_MODEL_PRESENT_UNSUPPORTED");
  }
  return {
    authority: "postgres",
    relation: "public.learning_runs",
    status: "absent",
    verifiedAt
  };
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const newYorkDate = (date: Date) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
};

const executableOption = (target: FeatureTargetResult["targets"][number]) => {
  const raw = target.optionsStrategy?.optionsCandidate;
  const option = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  const expectedType = target.preferredExpression === "long_call"
    ? "call"
    : target.preferredExpression === "long_put"
      ? "put"
      : null;
  return expectedType && option?.type === expectedType && typeof option.optionSymbol === "string"
    ? option
    : null;
};

const scoreTarget = (target: FeatureTargetResult["targets"][number], now: Date) => {
  const ageDays = Math.max(0, (now.getTime() - Date.parse(target.asOf)) / 86_400_000);
  const freshness = clamp(15 - clamp(ageDays * 0.8, 0, 15), 0, 15);
  const option = target.optionsStrategy?.optionsCandidate as { liquidityScore?: unknown } | null | undefined;
  const liquidity = Number(option?.liquidityScore ?? 0);
  let score = target.confidence * 42;
  score += clamp((target.expectedReturn ?? 0) * 100, -10, 20) * 1.7;
  score += clamp((target.volatilityAdjustedScore ?? 1) * 3, -4, 8);
  score += freshness;
  if (target.preferredExpression !== "shares") score += clamp(liquidity * 18, 0, 18) + 4;
  if (target.riskProfile === "aggressive") score += 6;
  return clamp(score, 0, 100);
};

const persistEvidence = async (input: {
  query: PostgresResearchQuery;
  fence: SchedulerFence;
  researchRunId: string;
  market: MarketResult;
  features: FeatureTargetResult["features"];
  targets: FeatureTargetResult["targets"];
  now: string;
}) => {
  const latestBars = new Map<string, MarketResult["bars"][number]>();
  for (const bar of input.market.bars) {
    const existing = latestBars.get(bar.symbol);
    if (!existing || Date.parse(existing.observedAt) < Date.parse(bar.observedAt)) latestBars.set(bar.symbol, bar);
  }
  const latestFeatures = new Map<string, FeatureTargetResult["features"][number]>();
  for (const feature of input.features) {
    const existing = latestFeatures.get(feature.symbol);
    if (!existing || Date.parse(existing.observedAt) < Date.parse(feature.observedAt)) {
      latestFeatures.set(feature.symbol, feature);
    }
  }
  const rows: ResearchEvidenceRow[] = [...latestBars.values()].map((row) => ({
    type: "market_bar", symbol: row.symbol, observedAt: row.observedAt,
    table: "market_bars", key: `${row.symbol}:${row.timeframe}:${row.observedAt}`,
    fingerprint: canonicalJsonHash(row), payload: row
  }));
  for (let index = 0; index < input.market.stockSnapshots.length; index += 1) {
    const row = input.market.stockSnapshots[index]!;
    rows.push({
      type: "stock_snapshot", symbol: row.symbol,
      observedAt: row.sourceTimestamp ?? row.observedAt, table: "stock_snapshots",
      key: row.id, fingerprint: canonicalJsonHash(row.evidence), payload: row.evidence
    });
    if ((index + 1) % EVIDENCE_BATCH_SIZE === 0) await yieldToEventLoop();
  }
  for (let index = 0; index < input.market.optionSnapshots.length; index += 1) {
    const row = input.market.optionSnapshots[index]!;
    rows.push({
      type: "option_snapshot", symbol: row.underlyingSymbol,
      observedAt: row.quoteTimestamp ?? row.observedAt, table: "option_snapshots",
      key: `${row.optionSymbol}:${row.observedAt}`,
      fingerprint: canonicalJsonHash(row.evidence), payload: row.evidence
    });
    if ((index + 1) % EVIDENCE_BATCH_SIZE === 0) await yieldToEventLoop();
  }
  rows.push(...[...latestFeatures.values()].map((row) => ({
    type: "feature_snapshot", symbol: row.symbol, observedAt: row.observedAt,
    table: "feature_snapshots", key: `${row.symbol}:${row.observedAt}`,
    fingerprint: row.sourceFingerprint, payload: row.features
  })));
  rows.push(...input.targets.map((row) => ({
    type: "target_snapshot", symbol: row.symbol, observedAt: row.asOf,
    table: "target_snapshots", key: `${row.symbol}:${row.asOf}:${row.riskProfile}`,
    fingerprint: row.sourceFingerprint, payload: row
  })));
  const uniqueById = new Map<string, Record<string, unknown>>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const id = `research_evidence_${canonicalJsonHash({ run: input.researchRunId, type: row.type, key: row.key, fingerprint: row.fingerprint })}`;
    uniqueById.set(id, {
      id, evidence_type: row.type, symbol: row.symbol, observed_at: row.observedAt,
      source_table: row.table, source_key: row.key, source_fingerprint: row.fingerprint,
      payload: row.payload
    });
    if ((index + 1) % EVIDENCE_BATCH_SIZE === 0) await yieldToEventLoop();
  }
  const unique = [...uniqueById.values()];
  for (let offset = 0; offset < unique.length; offset += EVIDENCE_BATCH_SIZE) {
    const batch = unique.slice(offset, offset + EVIDENCE_BATCH_SIZE);
    const fence = await input.query.query(
      `SELECT 1 WHERE ${fenceSql(1)}`,
      fenceValues(input.fence)
    );
    if (fence.rowCount !== 1) throw new Error("POSTGRES_RESEARCH_EVIDENCE_FENCE_REJECTED");
    const result = await input.query.query(
      `INSERT INTO research_evidence(
         id, research_run_id, evidence_type, symbol, observed_at, source_table,
         source_key, source_fingerprint, payload, created_at
       ) SELECT r.id, $2, r.evidence_type, r.symbol, r.observed_at::timestamptz,
                r.source_table, r.source_key, r.source_fingerprint, r.payload::jsonb, $3
         FROM jsonb_to_recordset($1::jsonb) AS r(
           id text, evidence_type text, symbol text, observed_at text,
           source_table text, source_key text, source_fingerprint text, payload jsonb)
         WHERE ${fenceSql(4)}
       ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(batch), input.researchRunId, input.now, ...fenceValues(input.fence)]
    );
    if (result.rowCount === 0 && batch.length > 0) {
      const stillHeld = await input.query.query(`SELECT 1 WHERE ${fenceSql(1)}`, fenceValues(input.fence));
      if (stillHeld.rowCount !== 1) throw new Error("POSTGRES_RESEARCH_EVIDENCE_FENCE_REJECTED");
    } else if (result.rowCount === null || result.rowCount > batch.length) {
      throw new Error("POSTGRES_RESEARCH_EVIDENCE_PERSISTENCE_FAILED");
    }
  }
  return unique.length;
};

const persistCandidates = async (input: {
  query: PostgresResearchQuery;
  fence: SchedulerFence;
  researchRunId: string;
  targets: FeatureTargetResult["targets"];
  maxCandidates: number;
  now: Date;
  explorationThresholds: PaperExplorationThresholds;
}) => {
  const evaluated = input.targets
    .map((target) => {
      const option = executableOption(target);
      const reasons: string[] = [];
      if (target.direction === "neutral") reasons.push("DIRECTION_THRESHOLD_NOT_MET");
      if (target.preferredExpression === "none") reasons.push("STRATEGY_ELIGIBILITY_NOT_MET");
      if (target.preferredExpression !== "shares" && !option) {
        reasons.push("CURRENT_OPTION_EVIDENCE_REQUIRED");
      }
      const optionSymbol = typeof option?.optionSymbol === "string" ? option.optionSymbol : null;
      const expirationDate = typeof option?.expirationDate === "string" ? option.expirationDate : null;
      const strategyFamily = optionSymbol
        ? target.symbol === "SPY" && expirationDate === newYorkDate(input.now)
          ? "zero_dte_spy"
          : "standard_option"
        : "equity";
      return {
        target,
        option,
        optionSymbol,
        strategyFamily,
        score: scoreTarget(target, input.now),
        reasons
      };
    })
    .sort((left, right) => right.score - left.score);
  const eligible = evaluated.filter((row) => row.reasons.length === 0);
  const selectedKeys = new Set(
    eligible.slice(0, input.maxCandidates).map((row) => row.target.sourceFingerprint)
  );
  const decisions = evaluated.map((row) => ({
    ...row,
    selected: selectedKeys.has(row.target.sourceFingerprint),
    reasons: row.reasons.length > 0
      ? row.reasons
      : selectedKeys.has(row.target.sourceFingerprint)
        ? ["RANKED_SELECTED"]
        : ["CANDIDATE_LIMIT_EXCEEDED"]
  }));
  const selectedCount = decisions.filter((row) => row.selected).length;
  const learningModelCapability = selectedCount > 0
    ? await resolvePostgresLearningModelCapability(input.query, input.now.toISOString())
    : null;
  for (let index = 0; index < decisions.length; index += 1) {
    const { target, option, optionSymbol, strategyFamily, score, selected, reasons } = decisions[index]!;
    const id = `candidate_${canonicalJsonHash({ run: input.researchRunId, source: target.sourceFingerprint })}`;
    const signalInputs = {
      targetSourceFingerprint: target.sourceFingerprint,
      marketEvidenceTimestamp: target.asOf,
      entryReference: target.entryReference,
      stopLoss: target.stopLoss,
      takeProfit: target.takeProfit,
      marketDecisionInputs: {
        ...(target.optionsStrategy?.decisionInputs as Record<string, unknown> | undefined),
        option: option?.decisionInputs ?? null
      },
      decisionGates: {
        profile: paperExplorationProfile(input.explorationThresholds),
        outcome: selected ? "passed" : "failed",
        reasons
      },
      learningAdjustmentStatus: "not_applicable_no_postgres_learning_model",
      learningModelCapability
    };
    const result = await input.query.query(
      `INSERT INTO candidates(
         id, decision_id, research_run_id, candidate_key, symbol, underlying_symbol,
         option_symbol, asset_class, as_of, rank, direction, horizon,
         risk_profile, preferred_expression, strategy_family, score, confidence,
         expected_return, estimated_max_loss, estimated_max_profit,
         option_liquidity_score, volatility_score, strike, decision,
         lifecycle_status, decision_reason, rationale, signal_inputs,
         data_quality_status, created_at, updated_at
       ) SELECT $1, $1, $2, $1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                $13, $14, $15, $16, $17, $18, $19, $20, $21,
                $22, $23, $24, $25::jsonb,
                $26::jsonb, 'CURRENT_POSTGRES_MARKET_EVIDENCE', $27, $27
         WHERE ${fenceSql(28)}
       ON CONFLICT (id) DO NOTHING`,
      [
        id, input.researchRunId, target.symbol, optionSymbol ? target.symbol : null,
        optionSymbol, optionSymbol ? "option" : "equity", target.asOf, index + 1,
        target.direction, target.horizon, target.riskProfile,
        target.preferredExpression, strategyFamily, score, target.confidence, target.expectedReturn,
        target.stopLoss === null ? null : Math.abs(target.entryReference - target.stopLoss),
        target.takeProfit === null ? null : Math.abs(target.takeProfit - target.entryReference),
        Number(option?.liquidityScore ?? 0), target.volatilityAdjustedScore,
        typeof option?.strike === "number" ? option.strike : null,
        selected ? "selected" : "rejected",
        selected ? "selected" : "rejected",
        reasons[0],
        JSON.stringify(target.rationale), JSON.stringify(signalInputs),
        input.now.toISOString(), ...fenceValues(input.fence)
      ]
    );
    if (result.rowCount !== 1 && result.rowCount !== 0) throw new Error("POSTGRES_CANDIDATE_PERSISTENCE_FAILED");
  }
  return {
    selected: selectedCount,
    rejected: decisions.length - selectedCount
  };
};

export const runPostgresResearchWorkflow = async (input: {
  query: PostgresResearchQuery;
  fence: SchedulerFence;
  riskProfile: RiskProfile;
  optionsEnabled: boolean;
  maxCandidates: number;
  now?: Date;
  dependencies?: Partial<ResearchDependencies>;
  explorationThresholds?: PaperExplorationThresholds;
}) => {
  const deps = { ...dependencies, ...input.dependencies };
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const runId = `research_${randomUUID()}`;
  const explorationThresholds = input.explorationThresholds ?? paperExplorationThresholds();
  const explorationProfile = paperExplorationProfile({
    ...explorationThresholds,
    maxCandidates: input.maxCandidates
  });
  const config = {
    riskProfile: input.riskProfile,
    optionsEnabled: input.optionsEnabled,
    maxCandidates: input.maxCandidates,
    barLookbackDays: 365,
    marketDataAuthority: "postgres",
    stockFeed: "sip",
    optionFeed: "opra",
    explorationProfile
  };
  await input.query.query(
    `UPDATE research_runs
     SET status = 'recovered',
         error_code = 'WORKER_TERMINATED_OR_HEARTBEAT_EXPIRED',
         error_message = COALESCE(error_message, 'Active research run was abandoned by an older scheduler lease.'),
         completed_at = $1, recovered_at = $1,
         recovery_reason = 'WORKER_TERMINATED_OR_HEARTBEAT_EXPIRED',
         recovery_source = 'research_preflight', updated_at = $1,
         version = version + 1
     WHERE workstream = 'research' AND status IN ('reserved', 'running')
       AND (worker_identity IS DISTINCT FROM $2
         OR scheduler_job_name IS DISTINCT FROM $3
         OR scheduler_fencing_token IS DISTINCT FROM $7)
       AND ${fenceSql(3)}`,
    [nowIso, input.fence.ownerId, ...fenceValues(input.fence)]
  );
  const reserved = await input.query.query(
    `INSERT INTO research_runs(
       id, workstream, run_key, status, risk_profile, options_enabled, config,
       worker_identity, scheduler_job_name, scheduler_fencing_token,
       started_at, heartbeat_at, created_at, updated_at
     ) SELECT $1, 'research', $1, 'running', $2, $3, $4::jsonb, $5,
              $7, $11, $6, $6, $6, $6
       WHERE ${fenceSql(7)}
     RETURNING version`,
    [runId, input.riskProfile, input.optionsEnabled, JSON.stringify(config),
      input.fence.ownerId, nowIso, ...fenceValues(input.fence)]
  );
  if (!reserved.rows[0]) throw new Error("POSTGRES_RESEARCH_RESERVATION_FAILED");

  const repository = new PostgresMarketDataRepository();
  const context = {
    transaction: input.query,
    operationId: `research:${runId}`,
    actorId: input.fence.ownerId,
    schedulerFence: input.fence
  } as unknown as FencedPostgresRepositoryContext;
  try {
    const market = await deps.refreshMarketData({
      symbols: deps.symbols,
      timeframe: "1Day",
      start: new Date(now.getTime() - 365 * 86_400_000).toISOString(),
      end: nowIso,
      optionsEnabled: input.optionsEnabled,
      now,
      repository,
      context
    });
    const generated = await deps.buildFeaturesAndTargets({
      bars: market.bars,
      stockSnapshots: market.stockSnapshots,
      optionContracts: market.optionContracts,
      optionSnapshots: market.optionSnapshots,
      riskProfile: input.riskProfile,
      optionsEnabled: input.optionsEnabled,
      decisionThresholds: explorationThresholds,
      repository,
      context
    });
    const evidenceStored = await persistEvidence({
      query: input.query, fence: input.fence, researchRunId: runId,
      market, features: generated.features, targets: generated.targets, now: nowIso
    });
    const candidateDecisions = await persistCandidates({
      query: input.query, fence: input.fence, researchRunId: runId,
      targets: generated.targets, maxCandidates: input.maxCandidates, now,
      explorationThresholds: {
        ...explorationThresholds,
        maxCandidates: input.maxCandidates
      }
    });
    const completed = await input.query.query(
      `UPDATE research_runs
       SET status = 'completed', universe_size = $2, targets_generated = $3,
           candidates_selected = $4, summary = $5::jsonb, completed_at = $6,
           heartbeat_at = $6, updated_at = $6, version = version + 1
       WHERE id = $1 AND status = 'running' AND ${fenceSql(7)}`,
      [runId, deps.symbols.length, generated.targets.length, candidateDecisions.selected,
        JSON.stringify({
          ...market.summary,
          evidenceStored,
          candidateDecisionCounts: candidateDecisions,
          explorationProfile
        }), nowIso,
        ...fenceValues(input.fence)]
    );
    if (completed.rowCount !== 1) throw new Error("POSTGRES_RESEARCH_COMPLETION_FAILED");
    return {
      status: "completed" as const,
      runId,
      universeSize: deps.symbols.length,
      targetsGenerated: generated.targets.length,
      candidatesSelected: candidateDecisions.selected,
      candidatesRejected: candidateDecisions.rejected,
      evidenceStored,
      market: market.summary
    };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 240) : "POSTGRES_RESEARCH_FAILED";
    await failResearchRun({ query: input.query, fence: input.fence, runId, message });
    throw error;
  }
};
