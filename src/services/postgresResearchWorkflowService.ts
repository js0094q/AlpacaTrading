import { randomUUID } from "node:crypto";

import { seedUniverse } from "../config/universe.seed.js";
import { canonicalJsonHash } from "../lib/canonicalJson.js";
import { optionDaysToExpiration } from "./optionSymbolService.js";
import {
  postgresErrorTelemetry,
  readPostgresQueryTelemetry
} from "../lib/database/postgresTelemetry.js";
import type { SchedulerFence } from "../repositories/contracts/common.js";
import { PostgresMarketDataRepository } from "../repositories/postgres/postgresMarketDataRepository.js";
import type { FencedPostgresRepositoryContext } from "../repositories/postgres/postgresRepositorySupport.js";
import { loadResearchSignalsForSymbols } from "../repositories/postgres/postgresResearchSignalRepository.js";
import type { RiskProfile } from "../types.js";
import {
  paperExplorationProfile,
  paperExplorationThresholds,
  type PaperExplorationThresholds
} from "./paperExplorationConfig.js";
import {
  alpacaDataHub,
  type AlpacaDataCycle
} from "./alpacaDataHubService.js";
import { runInvestmentOrchestrator } from "./investmentOrchestratorService.js";
import { buildPostgresFeaturesAndTargets } from "./postgresFeatureTargetService.js";
import { refreshPostgresMarketData } from "./postgresMarketDataService.js";
import {
  buildLaneResearchInfluence,
  researchSignalConfiguration,
  type LaneResearchInfluence,
  type NormalizedResearchSignal,
  type ResearchDecisionLane,
  type ResearchSignalConfiguration
} from "./researchSignalAdapterService.js";
import {
  attachHistoricalOutcomeEvidence,
  historicalOutcomeEvidenceConfig,
  loadHistoricalOutcomeEvidence,
  selectHistoricalOutcomeEvidence,
  type HistoricalOutcomeEvidenceIndex
} from "./historicalOutcomeEvidenceService.js";

export type PostgresResearchQuery = {
  telemetryEnabled?: boolean;
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
  loadResearchSignals: typeof loadResearchSignalsForSymbols;
  loadHistoricalOutcomeEvidence: typeof loadHistoricalOutcomeEvidence;
  dataHub: Pick<typeof alpacaDataHub, "hydrateCycle">;
};

const dependencies: ResearchDependencies = {
  symbols: seedUniverse,
  refreshMarketData: refreshPostgresMarketData,
  buildFeaturesAndTargets: buildPostgresFeaturesAndTargets,
  loadResearchSignals: loadResearchSignalsForSymbols,
  loadHistoricalOutcomeEvidence,
  dataHub: alpacaDataHub
};
const INVESTMENT_LANE_FAMILIES = [
  ["equity", "equity"],
  ["options_0dte", "zero_dte_spy"],
  ["options_leaps", "leaps"]
] as const;
const RESEARCH_READINESS_DEFERRALS = new Set([
  "POSTGRES_STOCK_SNAPSHOT_STALE",
  "POSTGRES_OPTION_SNAPSHOTS_CURRENT_MISSING",
  "POSTGRES_DECISION_MARKET_SESSION_INELIGIBLE"
]);
const investmentLaneEnabled = (lane: string, optionsEnabled: boolean) =>
  lane === "equity" || optionsEnabled;

const OPRA_BOUNDED_RESULTS = new Set([
  "ALPACA_OPRA_NOT_AUTHORIZED",
  "ALPACA_OPRA_DATA_UNAVAILABLE",
  "ALPACA_OPRA_QUOTE_STALE",
  "ALPACA_OPRA_GREEKS_UNAVAILABLE"
]);

const OPTION_EVIDENCE_PROFILES = {
  zero_dte_spy: {
    lane: "options_0dte",
    horizon: "intraday",
    priorityInputs: [
      "bid", "ask", "spreadDollars", "spreadPct", "quoteTimestamp",
      "underlyingPrice", "intradayReturn", "intradayVolatility", "volume",
      "openInterest", "hoursToExpiration", "delta", "gamma", "theta", "vega", "rho"
    ]
  },
  leaps: {
    lane: "options_leaps",
    horizon: "long_horizon",
    priorityInputs: [
      "expirationDate", "daysToExpiration", "strike", "moneyness",
      "openInterest", "openInterestDate", "spreadDollars", "spreadPct",
      "impliedVolatility", "delta", "gamma", "theta", "vega", "rho",
      "underlyingHistoricalVolatility"
    ]
  }
} as const;

const optionDecisionInputsForFamily = (
  option: Record<string, unknown> | null,
  family: string
) => {
  if (!option) return null;
  const profile = family === "zero_dte_spy"
    ? OPTION_EVIDENCE_PROFILES.zero_dte_spy
    : family === "leaps"
      ? OPTION_EVIDENCE_PROFILES.leaps
      : null;
  return profile ? { ...option, evidenceProfile: profile } : option;
};

const researchLaneForStrategyFamily = (
  family: string
): ResearchDecisionLane | null =>
  family === "equity"
    ? "equity"
    : family === "zero_dte_spy"
      ? "options_0dte"
      : family === "leaps"
        ? "options_leaps"
        : null;

const nonApplicableResearchInfluence = (): LaneResearchInfluence => ({
  signalId: null,
  provider: null,
  asOf: null,
  horizon: null,
  sourceReferences: [],
  state: "unavailable",
  scoreAdjustment: 0,
  reasonCodes: ["RESEARCH_NOT_APPLICABLE_STANDARD_OPTION"]
});

const zeroDteOpraBoundedResult = (
  summary: MarketResult["summary"]
): string | null => {
  const evidence = summary.optionEvidenceByUnderlying?.SPY;
  const direct = evidence?.finalBoundedResult;
  if (typeof direct === "string" && OPRA_BOUNDED_RESULTS.has(direct)) {
    return direct;
  }
  const rejection = (summary.optionDataRejectionReasons ?? []).find((reason) => {
    const [code, symbol] = reason.split(":");
    return symbol === "SPY" && OPRA_BOUNDED_RESULTS.has(code ?? "");
  });
  return rejection?.split(":", 1)[0] ?? null;
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
export const POSTGRES_RESEARCH_EVIDENCE_BATCH_MAX_BYTES = 4_000_000;
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
const RESEARCH_EVIDENCE_INSERT_SQL = `INSERT INTO research_evidence(
  id, research_run_id, evidence_type, symbol, observed_at, source_table,
  source_key, source_fingerprint, payload, created_at
) SELECT r.id, $2, r.evidence_type, r.symbol, r.observed_at::timestamptz,
         r.source_table, r.source_key, r.source_fingerprint, r.payload::jsonb, $3
  FROM jsonb_to_recordset($1::jsonb) AS r(
    id text, evidence_type text, symbol text, observed_at text,
    source_table text, source_key text, source_fingerprint text, payload jsonb)
  WHERE ${fenceSql(4)}
ON CONFLICT (id) DO NOTHING`;
const RESEARCH_FEATURE_EVIDENCE_INSERT_SQL = `INSERT INTO research_evidence(
  id, research_run_id, evidence_type, symbol, observed_at, source_table,
  source_key, source_fingerprint, payload, created_at
) SELECT $1, $2, 'feature_snapshot', f.symbol, f.observed_at,
         'feature_snapshots', $3, f.source_fingerprint, f.features, $4
  FROM feature_snapshots f
  WHERE f.symbol = $5
    AND f.observed_at = $6::timestamptz
    AND f.source_fingerprint = $7
    AND ${fenceSql(8)}
ON CONFLICT (id) DO NOTHING
RETURNING id, pg_column_size(payload)::bigint AS source_payload_bytes`;
const RESEARCH_FEATURE_EVIDENCE_REPLAY_SQL = `SELECT
  EXISTS(
    SELECT 1 FROM research_evidence WHERE id = $1
  ) AS evidence_exists,
  EXISTS(
    SELECT 1
    FROM feature_snapshots
    WHERE symbol = $2
      AND observed_at = $3::timestamptz
      AND source_fingerprint = $4
  ) AS source_exists
WHERE ${fenceSql(5)}`;

type ResearchEvidenceRow = {
  type: string;
  symbol: string;
  observedAt: string;
  table: string;
  key: string;
  fingerprint: string;
  payload: unknown;
};

type ResearchFeatureEvidenceRow = Omit<ResearchEvidenceRow, "payload">;

const evidenceBatches = (rows: readonly Record<string, unknown>[]) => {
  const batches: Array<{
    rows: Record<string, unknown>[];
    payload: string;
    bytes: number;
  }> = [];
  let currentRows: Record<string, unknown>[] = [];
  let serializedRows: string[] = [];
  let currentBytes = 2;
  const flush = () => {
    if (!currentRows.length) return;
    const payload = `[${serializedRows.join(",")}]`;
    batches.push({
      rows: currentRows,
      payload,
      bytes: Buffer.byteLength(payload)
    });
    currentRows = [];
    serializedRows = [];
    currentBytes = 2;
  };
  for (const row of rows) {
    const serialized = JSON.stringify(row);
    const serializedBytes = Buffer.byteLength(serialized);
    if (serializedBytes + 2 > POSTGRES_RESEARCH_EVIDENCE_BATCH_MAX_BYTES) {
      throw new Error(
        `POSTGRES_RESEARCH_EVIDENCE_ROW_TOO_LARGE:bytes=${serializedBytes}:max=${POSTGRES_RESEARCH_EVIDENCE_BATCH_MAX_BYTES}`
      );
    }
    const addedBytes = serializedBytes + (currentRows.length > 0 ? 1 : 0);
    if (
      currentRows.length >= EVIDENCE_BATCH_SIZE ||
      currentBytes + addedBytes > POSTGRES_RESEARCH_EVIDENCE_BATCH_MAX_BYTES
    ) {
      flush();
    }
    currentRows.push(row);
    serializedRows.push(serialized);
    currentBytes += serializedBytes + (currentRows.length > 1 ? 1 : 0);
  }
  flush();
  return batches;
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

export const postgresLeapsPolicy = (env: NodeJS.ProcessEnv = process.env) => {
  const configuredMin = Number.parseInt(String(env.PAPER_LEAPS_MIN_DTE || "180"), 10);
  const configuredMax = Number.parseInt(String(env.PAPER_LEAPS_MAX_DTE || "730"), 10);
  const minDte = Number.isSafeInteger(configuredMin) && configuredMin >= 180
    ? configuredMin
    : 180;
  const maxDte = Number.isSafeInteger(configuredMax) && configuredMax >= minDte
    ? configuredMax
    : 730;
  return { minDte, maxDte };
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
  const components = {
    confidence: target.confidence * 42,
    expectedReturn: clamp((target.expectedReturn ?? 0) * 100, -10, 20) * 1.7,
    volatilityAdjusted: clamp((target.volatilityAdjustedScore ?? 1) * 3, -4, 8),
    freshness,
    optionLiquidity: target.preferredExpression !== "shares"
      ? clamp(liquidity * 18, 0, 18) + 4
      : 0,
    riskProfile: target.riskProfile === "aggressive" ? 6 : 0
  };
  return {
    total: clamp(
      Object.values(components).reduce((sum, value) => sum + value, 0),
      0,
      100
    ),
    inputs: {
      confidence: target.confidence,
      expectedReturn: target.expectedReturn,
      volatilityAdjustedScore: target.volatilityAdjustedScore,
      ageDays,
      optionLiquidityScore: liquidity,
      preferredExpression: target.preferredExpression,
      riskProfile: target.riskProfile
    },
    components
  };
};

const persistEvidence = async (input: {
  query: PostgresResearchQuery;
  fence: SchedulerFence;
  researchRunId: string;
  market: MarketResult;
  features: FeatureTargetResult["features"];
  targets: FeatureTargetResult["targets"];
  now: string;
  emitTelemetry?: (event: Record<string, unknown>) => void;
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
  const featureRows: ResearchFeatureEvidenceRow[] = [...latestFeatures.values()].map((row) => ({
    type: "feature_snapshot", symbol: row.symbol, observedAt: row.observedAt,
    table: "feature_snapshots", key: `${row.symbol}:${row.observedAt}`,
    fingerprint: row.sourceFingerprint
  }));
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
  const uniqueFeatureById = new Map<string, ResearchFeatureEvidenceRow & { id: string }>();
  for (const row of featureRows) {
    const id = `research_evidence_${canonicalJsonHash({
      run: input.researchRunId,
      type: row.type,
      key: row.key,
      fingerprint: row.fingerprint
    })}`;
    uniqueFeatureById.set(id, { ...row, id });
  }
  const uniqueFeatures = [...uniqueFeatureById.values()];
  const inlineBatches = evidenceBatches(unique);
  const batchCount = inlineBatches.length + uniqueFeatures.length;
  for (let batchIndex = 0; batchIndex < inlineBatches.length; batchIndex += 1) {
    const batch = inlineBatches[batchIndex]!;
    const batchNumber = batchIndex + 1;
    const startedAt = performance.now();
    try {
      const fence = await input.query.query(
        `SELECT 1 WHERE ${fenceSql(1)}`,
        fenceValues(input.fence)
      );
      if (fence.rowCount !== 1) throw new Error("POSTGRES_RESEARCH_EVIDENCE_FENCE_REJECTED");
      const result = await input.query.query(
        RESEARCH_EVIDENCE_INSERT_SQL,
        [batch.payload, input.researchRunId, input.now, ...fenceValues(input.fence)]
      );
      if (result.rowCount === 0 && batch.rows.length > 0) {
        const stillHeld = await input.query.query(`SELECT 1 WHERE ${fenceSql(1)}`, fenceValues(input.fence));
        if (stillHeld.rowCount !== 1) throw new Error("POSTGRES_RESEARCH_EVIDENCE_FENCE_REJECTED");
      } else if (result.rowCount === null || result.rowCount > batch.rows.length) {
        throw new Error("POSTGRES_RESEARCH_EVIDENCE_PERSISTENCE_FAILED");
      }
      input.emitTelemetry?.({
        event: "postgres_research_evidence_batch",
        researchRunId: input.researchRunId,
        batchNumber,
        batchCount,
        batchSize: batch.rows.length,
        payloadBytes: batch.bytes,
        rowsAttempted: batch.rows.length,
        rowsCommitted: result.rowCount ?? 0,
        transactionDurationMs: performance.now() - startedAt,
        leaseOwner: input.fence.ownerId,
        fencingToken: input.fence.fencingToken,
        statementName: "research_evidence_batch_insert",
        ...readPostgresQueryTelemetry(result)
      });
    } catch (error) {
      input.emitTelemetry?.({
        event: "postgres_research_evidence_batch",
        researchRunId: input.researchRunId,
        batchNumber,
        batchCount,
        batchSize: batch.rows.length,
        payloadBytes: batch.bytes,
        rowsAttempted: batch.rows.length,
        rowsCommitted: 0,
        transactionDurationMs: performance.now() - startedAt,
        leaseOwner: input.fence.ownerId,
        fencingToken: input.fence.fencingToken,
        statementName: "research_evidence_batch_insert",
        outcome: "failed",
        ...readPostgresQueryTelemetry(error)
      });
      input.emitTelemetry?.(postgresErrorTelemetry(error, {
        failingStatement: RESEARCH_EVIDENCE_INSERT_SQL,
        batchNumber,
        symbol: null
      }));
      throw error;
    }
  }
  for (let featureIndex = 0; featureIndex < uniqueFeatures.length; featureIndex += 1) {
    const feature = uniqueFeatures[featureIndex]!;
    const batchNumber = inlineBatches.length + featureIndex + 1;
    const startedAt = performance.now();
    try {
      const fence = await input.query.query(
        `SELECT 1 WHERE ${fenceSql(1)}`,
        fenceValues(input.fence)
      );
      if (fence.rowCount !== 1) throw new Error("POSTGRES_RESEARCH_EVIDENCE_FENCE_REJECTED");
      const result = await input.query.query(
        RESEARCH_FEATURE_EVIDENCE_INSERT_SQL,
        [
          feature.id,
          input.researchRunId,
          feature.key,
          input.now,
          feature.symbol,
          feature.observedAt,
          feature.fingerprint,
          ...fenceValues(input.fence)
        ]
      );
      let outcome = "committed";
      if (result.rowCount === 0) {
        const replay = await input.query.query(
          RESEARCH_FEATURE_EVIDENCE_REPLAY_SQL,
          [
            feature.id,
            feature.symbol,
            feature.observedAt,
            feature.fingerprint,
            ...fenceValues(input.fence)
          ]
        );
        const state = replay.rows[0];
        if (!state) throw new Error("POSTGRES_RESEARCH_EVIDENCE_FENCE_REJECTED");
        if (state.source_exists !== true) {
          throw new Error(
            `POSTGRES_RESEARCH_FEATURE_EVIDENCE_SOURCE_MISSING:${feature.symbol}`
          );
        }
        if (state.evidence_exists !== true) {
          throw new Error("POSTGRES_RESEARCH_EVIDENCE_PERSISTENCE_FAILED");
        }
        outcome = "already_persisted";
      } else if (result.rowCount !== 1) {
        throw new Error("POSTGRES_RESEARCH_EVIDENCE_PERSISTENCE_FAILED");
      }
      const sourcePayloadBytes = Number(result.rows[0]?.source_payload_bytes);
      input.emitTelemetry?.({
        event: "postgres_research_evidence_batch",
        researchRunId: input.researchRunId,
        evidenceType: "feature_snapshot",
        batchNumber,
        batchCount,
        batchSize: 1,
        symbol: feature.symbol,
        rowsAttempted: 1,
        rowsCommitted: result.rowCount ?? 0,
        sourcePayloadBytes: Number.isFinite(sourcePayloadBytes)
          ? sourcePayloadBytes
          : null,
        transactionDurationMs: performance.now() - startedAt,
        leaseOwner: input.fence.ownerId,
        fencingToken: input.fence.fencingToken,
        statementName: "research_feature_evidence_server_copy",
        outcome,
        ...readPostgresQueryTelemetry(result)
      });
    } catch (error) {
      input.emitTelemetry?.({
        event: "postgres_research_evidence_batch",
        researchRunId: input.researchRunId,
        evidenceType: "feature_snapshot",
        batchNumber,
        batchCount,
        batchSize: 1,
        symbol: feature.symbol,
        rowsAttempted: 1,
        rowsCommitted: 0,
        transactionDurationMs: performance.now() - startedAt,
        leaseOwner: input.fence.ownerId,
        fencingToken: input.fence.fencingToken,
        statementName: "research_feature_evidence_server_copy",
        outcome: "failed",
        ...readPostgresQueryTelemetry(error)
      });
      input.emitTelemetry?.(postgresErrorTelemetry(error, {
        failingStatement: RESEARCH_FEATURE_EVIDENCE_INSERT_SQL,
        batchNumber,
        symbol: feature.symbol
      }));
      throw error;
    }
  }
  return unique.length + uniqueFeatures.length;
};

const persistCandidates = async (input: {
  query: PostgresResearchQuery;
  fence: SchedulerFence;
  researchRunId: string;
  cycleId: string;
  optionsEnabled: boolean;
  targets: FeatureTargetResult["targets"];
  maxCandidates: number;
  now: Date;
  explorationThresholds: PaperExplorationThresholds;
  researchSignals: readonly NormalizedResearchSignal[];
  researchConfiguration: ResearchSignalConfiguration;
  researchUnavailableReasonCode: string | null;
  historicalOutcomeEvidence: HistoricalOutcomeEvidenceIndex;
  marketSummary: MarketResult["summary"];
  cycleData: AlpacaDataCycle<MarketResult>;
  emitTelemetry?: (event: Record<string, unknown>) => void;
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
      const optionDte = expirationDate
        ? optionDaysToExpiration(
            expirationDate,
            `${newYorkDate(input.now)}T00:00:00.000Z`
          )
        : null;
      const leapsPolicy = postgresLeapsPolicy();
      const strategyFamily = optionSymbol
        ? target.symbol === "SPY" && expirationDate === newYorkDate(input.now)
          ? "zero_dte_spy"
          : optionDte !== null &&
              optionDte >= leapsPolicy.minDte &&
              optionDte <= leapsPolicy.maxDte
            ? "leaps"
            : "standard_option"
        : "equity";
      const baseCandidateScore = scoreTarget(target, input.now);
      const researchLane = researchLaneForStrategyFamily(strategyFamily);
      const researchInfluence = researchLane
        ? buildLaneResearchInfluence({
            signals: input.researchSignals.filter(
              (signal) => signal.symbol === target.symbol
            ),
            lane: researchLane,
            targetDirection: target.direction,
            now: input.now,
            config: input.researchConfiguration,
            unavailableReasonCode: input.researchUnavailableReasonCode
          })
        : nonApplicableResearchInfluence();
      const historicalEvidence = researchLane
        ? selectHistoricalOutcomeEvidence(input.historicalOutcomeEvidence, {
            environment: "paper",
            lane: researchLane,
            symbol: target.symbol,
            underlyingSymbol: target.symbol,
            now: input.now
          })
        : null;
      const candidateScore = {
        ...baseCandidateScore,
        baseTotal: baseCandidateScore.total,
        research: researchInfluence,
        total: clamp(
          baseCandidateScore.total + researchInfluence.scoreAdjustment,
          0,
          100
        )
      };
      return {
        target,
        option,
        optionSymbol,
        optionDte,
        leapsPolicy,
        strategyFamily,
        score: candidateScore.total,
        candidateScore,
        researchInfluence,
        historicalEvidence,
        reasons
      };
    })
    .sort((left, right) => right.score - left.score);
  const eligible = evaluated.filter((row) => row.reasons.length === 0);
  const selectedKeys = new Set(
    eligible.slice(0, input.maxCandidates).map((row) => row.target.sourceFingerprint)
  );
  const decisions = evaluated.map((row, index) => ({
    ...row,
    rank: index + 1,
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
  const persistDecisionRows = async (
    rows: typeof decisions,
    emptyReasonCode?: string | null
  ) => {
    const sharedQuotes = new Map(
      rows.map((row) => [
        row.target.symbol,
        input.cycleData.getLatestQuote(row.target.symbol)
      ])
    );
    for (const row of rows) {
      const {
        target, option, optionSymbol, optionDte, leapsPolicy, strategyFamily,
        score, candidateScore, researchInfluence, historicalEvidence, rank,
        selected, reasons
      } = row;
      const id = `candidate_${canonicalJsonHash({ run: input.researchRunId, source: target.sourceFingerprint })}`;
      const signalInputs = attachHistoricalOutcomeEvidence({
        targetSourceFingerprint: target.sourceFingerprint,
        marketEvidenceTimestamp: target.asOf,
        entryReference: target.entryReference,
        stopLoss: target.stopLoss,
        takeProfit: target.takeProfit,
        marketDecisionInputs: {
          ...(target.optionsStrategy?.decisionInputs as Record<string, unknown> | undefined),
          option: optionDecisionInputsForFamily(
            option?.decisionInputs && typeof option.decisionInputs === "object"
              ? option.decisionInputs as Record<string, unknown>
              : null,
            strategyFamily
          )
        },
        strategyClassification: {
          family: strategyFamily,
          daysToExpiration: optionDte,
          leapsMinDte: leapsPolicy.minDte,
          leapsMaxDte: leapsPolicy.maxDte
        },
        researchEvidence: researchInfluence,
        candidateScore,
        decisionGates: {
          profile: paperExplorationProfile(input.explorationThresholds),
          outcome: selected ? "passed" : "failed",
          reasons
        },
        learningAdjustmentStatus: "not_applicable_no_postgres_learning_model",
        learningModelCapability
      }, historicalEvidence);
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
          optionSymbol, optionSymbol ? "option" : "equity", target.asOf, rank,
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
      if (result.rowCount !== 1 && result.rowCount !== 0) {
        throw new Error("POSTGRES_CANDIDATE_PERSISTENCE_FAILED");
      }
    }
    const selected = rows.filter((row) => row.selected);
    const quoteReferences = Array.from(
      new Set(
        selected.flatMap((row) => {
          const quote = sharedQuotes.get(row.target.symbol);
          return quote
            ? [
                [
                  "alpaca_quote",
                  quote.provenance.feed,
                  quote.provenance.symbol,
                  quote.provenance.providerTimestamp,
                  quote.provenance.receiptTimestamp
                ].join(":")
              ]
            : [];
        })
      )
    );
    return {
      proposals: selected.map((row) => row.target),
      evidence_references: [
        `research_run:${input.researchRunId}`,
        ...selected.map((row) => `target:${row.target.sourceFingerprint}`),
        ...selected.flatMap((row) =>
          row.researchInfluence.signalId
            ? [`research_signal:${row.researchInfluence.signalId}`]
            : []
        ),
        ...quoteReferences
      ],
      confidence: selected.length
        ? Math.max(...selected.map((row) => row.target.confidence))
        : undefined,
      reason_codes: selected.length
        ? ["RANKED_SELECTED"]
        : [emptyReasonCode ?? "NO_ELIGIBLE_POSTGRES_CANDIDATES"],
      ...(emptyReasonCode && selected.length === 0 ? {
        diagnostic_summary:
          `Lane could not evaluate current OPRA evidence: ${emptyReasonCode}`
      } : {})
    };
  };
  const investmentCycle = await runInvestmentOrchestrator<
    typeof decisions,
    FeatureTargetResult["targets"][number]
  >({
    cycleId: input.cycleId,
    loadSharedContext: async () => decisions,
    lanes: INVESTMENT_LANE_FAMILIES.map(([lane, family]) => ({
      lane,
      enabled: investmentLaneEnabled(lane, input.optionsEnabled),
      execute: (sharedDecisions) => {
        const laneDecisions = sharedDecisions.filter(
          (row) => row.strategyFamily === family
        );
        return persistDecisionRows(
          laneDecisions,
          lane === "options_0dte" && laneDecisions.every((row) => !row.selected)
            ? zeroDteOpraBoundedResult(input.marketSummary)
            : null
        );
      }
    }))
  });
  input.emitTelemetry?.({
    event: "postgres_investment_orchestrator_completed",
    researchRunId: input.researchRunId,
    cycleId: investmentCycle.cycleId,
    enabledLanes: investmentCycle.enabledLanes,
    laneResults: investmentCycle.workstreamResults.map((result) => ({
      lane: result.lane,
      outcome: result.outcome,
      proposalCount: result.proposals.length,
      reasonCodes: result.reason_codes
    }))
  });
  const standardOptionResult = await persistDecisionRows(
    decisions.filter((row) => row.strategyFamily === "standard_option")
  );
  return {
    selected: investmentCycle.proposals.length + standardOptionResult.proposals.length,
    rejected: decisions.length - selectedCount,
    workstreamResults: investmentCycle.workstreamResults
  };
};

export const runPostgresResearchWorkflow = async (input: {
  query: PostgresResearchQuery;
  fence: SchedulerFence;
  riskProfile: RiskProfile;
  optionsEnabled: boolean;
  maxCandidates: number;
  cycleId?: string;
  now?: Date;
  signal?: AbortSignal;
  dependencies?: Partial<ResearchDependencies>;
  explorationThresholds?: PaperExplorationThresholds;
  emitTelemetry?: (event: Record<string, unknown>) => void;
}) => {
  const deps = { ...dependencies, ...input.dependencies };
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const runId = `research_${randomUUID()}`;
  const cycleId = input.cycleId ?? process.env.AUTONOMOUS_CYCLE_ID?.trim() ?? runId;
  const explorationThresholds = input.explorationThresholds ?? paperExplorationThresholds();
  const researchConfiguration = researchSignalConfiguration();
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
    researchAdapter: {
      mode: "structured_json_import",
      ...researchConfiguration
    },
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
    schedulerFence: input.fence,
    emitTelemetry: input.emitTelemetry,
    profileOptionReadbackQuery: input.query.telemetryEnabled === true
  } as unknown as FencedPostgresRepositoryContext;
  try {
    const marketCycle = await deps.dataHub.hydrateCycle({
      cycleId,
      reason: "startup",
      feed: "sip",
      load: () => deps.refreshMarketData({
        symbols: deps.symbols,
        timeframe: "1Day",
        start: new Date(now.getTime() - 365 * 86_400_000).toISOString(),
        end: nowIso,
        optionsEnabled: input.optionsEnabled,
        now,
        signal: input.signal,
        repository,
        context
      })
    });
    const market = marketCycle.payload;
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
    let researchSignals: readonly NormalizedResearchSignal[] = [];
    let researchUnavailableReasonCode: string | null = null;
    try {
      researchSignals = await deps.loadResearchSignals({
        query: input.query,
        symbols: generated.targets.map(({ symbol }) => symbol)
      });
    } catch {
      researchUnavailableReasonCode = "RESEARCH_LOOKUP_UNAVAILABLE";
      input.emitTelemetry?.({
        event: "postgres_research_signal_lookup",
        researchRunId: runId,
        cycleId,
        outcome: "unavailable",
        reasonCode: researchUnavailableReasonCode,
        retryCount: 0
      });
    }
    const historicalOutcomeEvidence = await deps.loadHistoricalOutcomeEvidence({
      query: input.query,
      now,
      environment: "paper",
      config: historicalOutcomeEvidenceConfig()
    });
    const evidenceStored = await persistEvidence({
      query: input.query, fence: input.fence, researchRunId: runId,
      market, features: generated.features, targets: generated.targets, now: nowIso,
      emitTelemetry: input.emitTelemetry
    });
    const candidateDecisions = await persistCandidates({
      query: input.query, fence: input.fence, researchRunId: runId,
      cycleId,
      optionsEnabled: input.optionsEnabled,
      targets: generated.targets, maxCandidates: input.maxCandidates, now,
      explorationThresholds: {
        ...explorationThresholds,
        maxCandidates: input.maxCandidates
      },
      researchSignals,
      researchConfiguration,
      researchUnavailableReasonCode,
      historicalOutcomeEvidence,
      marketSummary: market.summary,
      cycleData: marketCycle,
      emitTelemetry: input.emitTelemetry
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
          candidateDecisionCounts: {
            selected: candidateDecisions.selected,
            rejected: candidateDecisions.rejected
          },
          workstreamResults: candidateDecisions.workstreamResults,
          researchAdapter: {
            mode: "structured_json_import",
            storedSignalCount: researchSignals.length,
            lookupStatus:
              researchUnavailableReasonCode ?? "RESEARCH_LOOKUP_COMPLETED"
          },
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
      workstreamResults: candidateDecisions.workstreamResults,
      evidenceStored,
      research: {
        storedSignalCount: researchSignals.length,
        lookupStatus:
          researchUnavailableReasonCode ?? "RESEARCH_LOOKUP_COMPLETED"
      },
      market: market.summary
    };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 240) : "POSTGRES_RESEARCH_FAILED";
    const reasonCode = message.split(":", 1)[0]!;
    if (RESEARCH_READINESS_DEFERRALS.has(reasonCode)) {
      const deferred = await runInvestmentOrchestrator<
        { reasonCode: string },
        FeatureTargetResult["targets"][number]
      >({
        cycleId,
        loadSharedContext: async () => ({ reasonCode }),
        lanes: INVESTMENT_LANE_FAMILIES.map(([lane]) => ({
          lane,
          enabled: investmentLaneEnabled(lane, input.optionsEnabled),
          execute: async (context) => ({
            proposals: [],
            reason_codes: [context.reasonCode],
            diagnostic_summary: `Lane deferred before evaluation: ${context.reasonCode}`
          })
        })),
        now: () => now
      });
      input.emitTelemetry?.({
        event: "postgres_investment_orchestrator_deferred",
        researchRunId: runId,
        cycleId,
        enabledLanes: deferred.enabledLanes,
        workstreamResults: deferred.workstreamResults
      });
    }
    await failResearchRun({ query: input.query, fence: input.fence, runId, message });
    throw error;
  }
};
