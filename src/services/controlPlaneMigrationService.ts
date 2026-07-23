import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";

import type { DatabaseConfig } from "../lib/database/config.js";
import { withPostgresTransaction } from "../lib/database/postgresTransaction.js";
import {
  canonicalizePostgresNumeric,
  parsePostgresDecimal as parseDecimal
} from "../lib/database/postgresNumeric.js";

export { canonicalizePostgresNumeric } from "../lib/database/postgresNumeric.js";

type JsonValue =
  | boolean
  | number
  | string
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
};

type SqliteRow = Readonly<Record<string, unknown>>;

type SqliteSnapshotSeal = {
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly modifiedAtNs: string;
  readonly sha256: string;
};

export const assertDurableControlPlaneCheckpoint = (
  row: {
    readonly status: string;
    readonly source_checksum: string | null;
    readonly discrepancy_count: number | string;
    readonly cursor_value: unknown;
    readonly source_aggregates: unknown;
    readonly target_aggregates: unknown;
    readonly discrepancy_report: unknown;
    readonly completed_at: Date | string | null;
  } | undefined,
  expected: {
    readonly status: string;
    readonly snapshotSha256: string;
    readonly discrepancyCount: number;
    readonly postgresMigrationVersion: number;
    readonly mappingVersion: number;
    readonly sourceAggregates: JsonValue;
    readonly targetAggregates: JsonValue;
    readonly discrepancies: ReadonlyArray<{ readonly id: string }>;
    readonly completedAt: string;
  }
) => {
  let cursor: Record<string, unknown> | undefined;
  let sourceAggregates: JsonValue | undefined;
  let targetAggregates: JsonValue | undefined;
  let discrepancyReport: JsonValue | undefined;
  let completedAt: string | null = null;
  try {
    cursor = typeof row?.cursor_value === "string"
      ? JSON.parse(row.cursor_value) as Record<string, unknown>
      : row?.cursor_value as Record<string, unknown> | undefined;
    sourceAggregates = typeof row?.source_aggregates === "string"
      ? JSON.parse(row.source_aggregates) as JsonValue
      : row?.source_aggregates as JsonValue | undefined;
    targetAggregates = typeof row?.target_aggregates === "string"
      ? JSON.parse(row.target_aggregates) as JsonValue
      : row?.target_aggregates as JsonValue | undefined;
    discrepancyReport = typeof row?.discrepancy_report === "string"
      ? JSON.parse(row.discrepancy_report) as JsonValue
      : row?.discrepancy_report as JsonValue | undefined;
    completedAt = row?.completed_at === null || row?.completed_at === undefined
      ? null
      : new Date(row.completed_at).toISOString();
  } catch {
    throw new Error("CONTROL_PLANE_DURABLE_CHECKPOINT_VERIFICATION_FAILED");
  }
  if (
    row?.status !== expected.status ||
    row.source_checksum !== expected.snapshotSha256 ||
    Number(row.discrepancy_count) !== expected.discrepancyCount ||
    cursor?.postgresMigrationVersion !== expected.postgresMigrationVersion ||
    cursor?.mappingVersion !== expected.mappingVersion ||
    sourceAggregates === undefined ||
    canonicalJson(sourceAggregates) !== canonicalJson(expected.sourceAggregates) ||
    targetAggregates === undefined ||
    canonicalJson(targetAggregates) !== canonicalJson(expected.targetAggregates) ||
    discrepancyReport === undefined ||
    canonicalJson(discrepancyReport) !== canonicalJson({
      discrepancyIds: expected.discrepancies.map((row) => row.id)
    }) ||
    completedAt !== expected.completedAt
  ) {
    throw new Error("CONTROL_PLANE_DURABLE_CHECKPOINT_VERIFICATION_FAILED");
  }
  return true;
};

export interface SqliteSnapshotInspection {
  readonly path: string;
  readonly sha256: string;
  readonly integrityCheck: readonly string[];
  readonly foreignKeyViolationCount: number;
  readonly tableCounts: Readonly<Record<string, number>>;
}

export interface ControlPlaneResearchRun {
  readonly id: string;
  readonly workstream: "research";
  readonly runKey: string;
  readonly status: "reserved" | "running" | "completed" | "failed" | "cancelled" | "recovered";
  readonly riskProfile: string;
  readonly optionsEnabled: boolean;
  readonly universeSize: number;
  readonly targetsGenerated: number;
  readonly candidatesSelected: number;
  readonly config: JsonValue;
  readonly summary: JsonValue | null;
  readonly errorCode: null;
  readonly errorMessage: string | null;
  readonly workerIdentity: string | null;
  readonly schedulerJobName: null;
  readonly schedulerFencingToken: null;
  readonly requestId: string | null;
  readonly correlationId: string | null;
  readonly startedAt: string;
  readonly heartbeatAt: string | null;
  readonly completedAt: string | null;
  readonly recoveredAt: string | null;
  readonly recoveryReason: string | null;
  readonly recoverySource: string | null;
  readonly version: 1;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ControlPlaneCandidate {
  readonly id: string;
  readonly decisionId: string | null;
  readonly decisionLinkageStatus: string;
  readonly researchRunId: string;
  readonly candidateKey: string;
  readonly symbol: string;
  readonly underlyingSymbol: string | null;
  readonly optionSymbol: string | null;
  readonly assetClass: "equity" | "option";
  readonly asOf: string;
  readonly rank: number;
  readonly direction: "long" | "short" | "neutral";
  readonly horizon: string;
  readonly riskProfile: string;
  readonly preferredExpression: string;
  readonly strategyFamily: string | null;
  readonly score: number;
  readonly confidence: number;
  readonly expectedReturn: number | null;
  readonly estimatedMaxLoss: number | null;
  readonly estimatedMaxProfit: number | null;
  readonly historicalWinRate: number | null;
  readonly historicalAvgReturn: number | null;
  readonly historicalMaxDrawdown: number | null;
  readonly similarSetupCount: number | null;
  readonly optionLiquidityScore: number | null;
  readonly volatilityScore: number | null;
  readonly signalFreshnessDays: number | null;
  readonly recentLearningAdjustment: number | null;
  readonly directionalAccuracy: number | null;
  readonly optionOutperformanceAccuracy: number | null;
  readonly strike: number | null;
  readonly shortStrike: number | null;
  readonly decision: "selected" | "rejected" | "skipped" | "blocked";
  readonly lifecycleStatus: string;
  readonly decisionReason: string | null;
  readonly rationale: JsonValue[];
  readonly signalInputs: { [key: string]: JsonValue };
  readonly dataQualityStatus: string;
  readonly relevantBacktestRunId: string | null;
  readonly sourceCandidateId: string;
  readonly version: 1;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ControlPlaneCandidateLifecycleEvent {
  readonly eventId: string;
  readonly candidateId: string;
  readonly sequenceNumber: number;
  readonly eventType: string;
  readonly priorStatus: string | null;
  readonly status: string;
  readonly reasonCodes: readonly string[];
  readonly evidence: JsonValue;
  readonly idempotencyKey: string;
  readonly sourceEventId: string;
  readonly occurredAt: string;
  readonly producedAt: string;
  readonly runId: string;
  readonly requestId: string | null;
  readonly correlationId: string | null;
  readonly schedulerJobName: null;
  readonly schedulerFencingToken: null;
  readonly createdAt: string;
}

export interface ControlPlaneSnapshotData {
  readonly inspection: SqliteSnapshotInspection;
  readonly researchRuns: readonly ControlPlaneResearchRun[];
  readonly candidates: readonly ControlPlaneCandidate[];
  readonly candidateLifecycleEvents: readonly ControlPlaneCandidateLifecycleEvent[];
  readonly deferredLifecycleEvents: ReadonlyArray<{
    readonly eventId: string;
    readonly decisionId: string;
    readonly status: string;
    readonly sourceType: string;
    readonly sourceId: string;
  }>;
  readonly sourceIssues: ReadonlyArray<{
    readonly domain: string;
    readonly entityId: string | null;
    readonly discrepancyType: string;
    readonly expected: JsonValue | null;
    readonly actual: JsonValue | null;
  }>;
  readonly runtimeWriteLeases: ReadonlyArray<{
    readonly leaseName: string;
    readonly acquiredAt: string;
    readonly expiresAt: string;
  }>;
}

const hashFile = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });

const assertNoSnapshotSidecars = async (path: string) => {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      await stat(`${path}${suffix}`);
      throw new Error("SQLITE_SNAPSHOT_SIDE_FILE_PRESENT");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
};

const sameSnapshotFile = (
  left: Omit<SqliteSnapshotSeal, "sha256">,
  right: Omit<SqliteSnapshotSeal, "sha256">
) =>
  left.device === right.device &&
  left.inode === right.inode &&
  left.size === right.size &&
  left.modifiedAtNs === right.modifiedAtNs;

const captureSnapshotSeal = async (path: string): Promise<SqliteSnapshotSeal> => {
  await assertNoSnapshotSidecars(path);
  const before = await stat(path, { bigint: true });
  if (!before.isFile()) throw new Error("SQLITE_SNAPSHOT_FILE_REQUIRED");
  const beforeFile = {
    device: before.dev.toString(),
    inode: before.ino.toString(),
    size: before.size.toString(),
    modifiedAtNs: before.mtimeNs.toString()
  };
  const firstHash = await hashFile(path);
  const secondHash = await hashFile(path);
  const after = await stat(path, { bigint: true });
  const afterFile = {
    device: after.dev.toString(),
    inode: after.ino.toString(),
    size: after.size.toString(),
    modifiedAtNs: after.mtimeNs.toString()
  };
  await assertNoSnapshotSidecars(path);
  if (!sameSnapshotFile(beforeFile, afterFile) || firstHash !== secondHash) {
    throw new Error("SQLITE_SNAPSHOT_CHANGED_DURING_READ");
  }
  return { ...beforeFile, sha256: firstHash };
};

const assertSnapshotSealUnchanged = async (
  path: string,
  expected: SqliteSnapshotSeal
) => {
  const actual = await captureSnapshotSeal(path);
  if (
    !sameSnapshotFile(expected, actual) ||
    expected.sha256 !== actual.sha256
  ) {
    throw new Error("SQLITE_SNAPSHOT_CHANGED_DURING_READ");
  }
};

const quoteSqliteIdentifier = (identifier: string) =>
  `"${identifier.replaceAll('"', '""')}"`;

export const enableSqliteDefensiveModeIfSupported = (database: {
  enableDefensive?: (enabled: boolean) => void;
}) => {
  if (typeof database.enableDefensive !== "function") return false;
  database.enableDefensive(true);
  return true;
};

const openReadOnlySqlite = (path: string) => {
  const database = new DatabaseSync(path, { readOnly: true });
  enableSqliteDefensiveModeIfSupported(database);
  database.exec(
    "PRAGMA query_only = ON; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;"
  );
  return database;
};

export const inspectSqliteSnapshot = async (
  path: string
): Promise<SqliteSnapshotInspection> => {
  const seal = await captureSnapshotSeal(path);
  const database = openReadOnlySqlite(path);
  try {
    const integrityRows = database.prepare("PRAGMA integrity_check").all() as Array<
      Record<string, unknown>
    >;
    const integrityCheck = integrityRows.map((row) => String(Object.values(row)[0]));
    const foreignKeyViolationCount = database.prepare("PRAGMA foreign_key_check").all().length;
    const tableRows = database
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`
      )
      .all() as Array<{ name: string }>;
    const tableCounts: Record<string, number> = {};
    for (const { name } of tableRows) {
      const countRow = database
        .prepare(`SELECT COUNT(*) AS count FROM ${quoteSqliteIdentifier(name)}`)
        .get() as { count: number | bigint };
      const count = Number(countRow.count);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error(`SQLITE_TABLE_COUNT_INVALID:${name}`);
      }
      tableCounts[name] = count;
    }
    await assertSnapshotSealUnchanged(path, seal);
    return {
      path,
      sha256: seal.sha256,
      integrityCheck,
      foreignKeyViolationCount,
      tableCounts
    };
  } finally {
    database.close();
  }
};

export const createReadConsistentSqliteSnapshot = async (input: {
  readonly sourcePath: string;
  readonly destinationDirectory: string;
}): Promise<SqliteSnapshotInspection> => {
  const sourceFile = await stat(input.sourcePath);
  if (!sourceFile.isFile()) throw new Error("SQLITE_SOURCE_FILE_REQUIRED");
  await mkdir(input.destinationDirectory, { recursive: true, mode: 0o700 });
  const snapshotDirectory = await mkdtemp(
    join(input.destinationDirectory, ".control-plane-snapshot-")
  );
  const sourceExtension = extname(input.sourcePath) || ".db";
  const sourceName = basename(input.sourcePath, extname(input.sourcePath));
  const snapshotPath = join(snapshotDirectory, `${sourceName}-snapshot${sourceExtension}`);
  const source = openReadOnlySqlite(input.sourcePath);
  try {
    await backup(source, snapshotPath);
  } catch (error) {
    await rm(snapshotDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    source.close();
  }
  try {
    await chmod(snapshotPath, 0o400);
    const inspection = await inspectSqliteSnapshot(snapshotPath);
    if (
      inspection.integrityCheck.length !== 1 ||
      inspection.integrityCheck[0]?.toLowerCase() !== "ok"
    ) {
      throw new Error("SQLITE_SNAPSHOT_INTEGRITY_CHECK_FAILED");
    }
    if (inspection.foreignKeyViolationCount > 0) {
      throw new Error("SQLITE_SNAPSHOT_FOREIGN_KEY_CHECK_FAILED");
    }
    return inspection;
  } catch (error) {
    await chmod(snapshotPath, 0o600).catch(() => undefined);
    await rm(snapshotDirectory, { recursive: true, force: true });
    throw error;
  }
};

const columnError = (table: string, column: string) =>
  new Error(`SQLITE_COLUMN_INVALID:${table}.${column}`);

const requiredString = (row: SqliteRow, table: string, column: string) => {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0) throw columnError(table, column);
  return value;
};

const nullableString = (row: SqliteRow, table: string, column: string) => {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw columnError(table, column);
  return value;
};

const requiredNumber = (row: SqliteRow, table: string, column: string) => {
  const raw = row[column];
  const value = typeof raw === "bigint" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) throw columnError(table, column);
  return value;
};

const nullableNumber = (row: SqliteRow, table: string, column: string) => {
  const raw = row[column];
  if (raw === null || raw === undefined) return null;
  const value = typeof raw === "bigint" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) throw columnError(table, column);
  return value;
};

const requiredInteger = (row: SqliteRow, table: string, column: string) => {
  const value = requiredNumber(row, table, column);
  if (!Number.isSafeInteger(value)) throw columnError(table, column);
  return value;
};

const requiredTimestamp = (row: SqliteRow, table: string, column: string) => {
  const value = requiredString(row, table, column);
  if (!Number.isFinite(Date.parse(value))) throw columnError(table, column);
  return new Date(value).toISOString();
};

const nullableTimestamp = (row: SqliteRow, table: string, column: string) => {
  const value = nullableString(row, table, column);
  if (value !== null && !Number.isFinite(Date.parse(value))) throw columnError(table, column);
  return value === null ? null : new Date(value).toISOString();
};

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
};

const parseJson = (
  raw: unknown,
  table: string,
  column: string,
  expectedShape: "array" | "object" | "any",
  nullable = false
): JsonValue | null => {
  if ((raw === null || raw === undefined) && nullable) return null;
  if (typeof raw !== "string") throw new Error(`SQLITE_JSON_INVALID:${table}.${column}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`SQLITE_JSON_INVALID:${table}.${column}`);
  }
  const shapeMatches =
    expectedShape === "any" ||
    (expectedShape === "array" && Array.isArray(parsed)) ||
    (expectedShape === "object" &&
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed));
  if (!shapeMatches || !isJsonValue(parsed)) {
    throw new Error(`SQLITE_JSON_INVALID:${table}.${column}`);
  }
  return parsed;
};

const latestTimestamp = (timestamps: ReadonlyArray<string | null>) =>
  timestamps.reduce<string | null>((latest, value) => {
    if (value === null) return latest;
    if (latest === null || Date.parse(value) > Date.parse(latest)) return value;
    return latest;
  }, null)!;

export const mapSqliteResearchRun = (row: SqliteRow): ControlPlaneResearchRun => {
  const table = "research_runs";
  const id = requiredString(row, table, "id");
  const status = requiredString(row, table, "status");
  if (!new Set(["reserved", "running", "completed", "failed", "cancelled", "recovered"]).has(status)) {
    throw columnError(table, "status");
  }
  const startedAt = requiredTimestamp(row, table, "started_at");
  const heartbeatAt = nullableTimestamp(row, table, "heartbeat_at");
  const completedAt = nullableTimestamp(row, table, "completed_at");
  const recoveredAt = nullableTimestamp(row, table, "recovered_at");
  const optionsEnabled = requiredInteger(row, table, "options_enabled");
  if (optionsEnabled !== 0 && optionsEnabled !== 1) {
    throw columnError(table, "options_enabled");
  }
  return {
    id,
    workstream: "research",
    runKey: id,
    status: status as ControlPlaneResearchRun["status"],
    riskProfile: requiredString(row, table, "risk_profile"),
    optionsEnabled: optionsEnabled === 1,
    universeSize: requiredInteger(row, table, "universe_size"),
    targetsGenerated: requiredInteger(row, table, "targets_generated"),
    candidatesSelected: requiredInteger(row, table, "candidates_selected"),
    config: parseJson(row.config_json, table, "config_json", "object")!,
    summary: parseJson(row.summary_json, table, "summary_json", "any", true),
    errorCode: null,
    errorMessage: nullableString(row, table, "error_message"),
    workerIdentity: nullableString(row, table, "worker_identity"),
    schedulerJobName: null,
    schedulerFencingToken: null,
    requestId: nullableString(row, table, "request_id"),
    correlationId: nullableString(row, table, "correlation_id"),
    startedAt,
    heartbeatAt,
    completedAt,
    recoveredAt,
    recoveryReason: nullableString(row, table, "recovery_reason"),
    recoverySource: nullableString(row, table, "recovery_source"),
    version: 1,
    createdAt: startedAt,
    updatedAt: latestTimestamp([startedAt, heartbeatAt, completedAt, recoveredAt])
  };
};

export const mapSqliteCandidate = (row: SqliteRow): ControlPlaneCandidate => {
  const table = "paper_trade_candidates";
  const id = requiredString(row, table, "id");
  const direction = requiredString(row, table, "direction");
  if (!new Set(["long", "short", "neutral"]).has(direction)) {
    throw columnError(table, "direction");
  }
  const decision = requiredString(row, table, "decision");
  if (!new Set(["selected", "rejected", "skipped", "blocked"]).has(decision)) {
    throw columnError(table, "decision");
  }
  const asOf = requiredTimestamp(row, table, "as_of");
  const symbol = requiredString(row, table, "symbol");
  const optionSymbol = nullableString(row, table, "option_symbol");
  return {
    id,
    decisionId: nullableString(row, table, "decision_id"),
    decisionLinkageStatus: requiredString(row, table, "decision_linkage_status"),
    researchRunId: requiredString(row, table, "research_run_id"),
    candidateKey: id,
    symbol,
    underlyingSymbol: optionSymbol === null ? null : symbol,
    optionSymbol,
    assetClass: optionSymbol === null ? "equity" : "option",
    asOf,
    rank: requiredInteger(row, table, "rank"),
    direction: direction as ControlPlaneCandidate["direction"],
    horizon: requiredString(row, table, "horizon"),
    riskProfile: requiredString(row, table, "risk_profile"),
    preferredExpression: requiredString(row, table, "preferred_expression"),
    strategyFamily: nullableString(row, table, "strategy_family"),
    score: requiredNumber(row, table, "score"),
    confidence: requiredNumber(row, table, "confidence"),
    expectedReturn: nullableNumber(row, table, "expected_return"),
    estimatedMaxLoss: nullableNumber(row, table, "estimated_max_loss"),
    estimatedMaxProfit: nullableNumber(row, table, "estimated_max_profit"),
    historicalWinRate: nullableNumber(row, table, "historical_win_rate"),
    historicalAvgReturn: nullableNumber(row, table, "historical_avg_return"),
    historicalMaxDrawdown: nullableNumber(row, table, "historical_max_drawdown"),
    similarSetupCount: nullableNumber(row, table, "similar_setup_count"),
    optionLiquidityScore: nullableNumber(row, table, "option_liquidity_score"),
    volatilityScore: nullableNumber(row, table, "volatility_score"),
    signalFreshnessDays: nullableNumber(row, table, "signal_freshness_days"),
    recentLearningAdjustment: nullableNumber(row, table, "recent_learning_adjustment"),
    directionalAccuracy: nullableNumber(row, table, "directional_accuracy"),
    optionOutperformanceAccuracy: nullableNumber(
      row,
      table,
      "option_outperformance_accuracy"
    ),
    strike: nullableNumber(row, table, "strike"),
    shortStrike: nullableNumber(row, table, "short_strike"),
    decision: decision as ControlPlaneCandidate["decision"],
    lifecycleStatus: decision,
    decisionReason: nullableString(row, table, "decision_reason"),
    rationale: parseJson(row.rationale, table, "rationale", "array") as JsonValue[],
    signalInputs: parseJson(
      row.signal_inputs_json,
      table,
      "signal_inputs_json",
      "object"
    ) as { [key: string]: JsonValue },
    dataQualityStatus: requiredString(row, table, "data_quality_status"),
    relevantBacktestRunId: nullableString(row, table, "relevant_backtest_run_id"),
    sourceCandidateId: id,
    version: 1,
    createdAt: asOf,
    updatedAt: asOf
  };
};

const sourceLifecycleStatuses: Readonly<Record<string, string>> = {
  DISCOVERED: "discovered",
  DATA_INCOMPLETE: "data_incomplete",
  SCORED: "scored",
  REJECTED: "rejected",
  SKIPPED: "skipped",
  SELECTED: "selected",
  REVIEWED: "reviewed",
  BLOCKED: "blocked",
  PAPER_ELIGIBLE: "paper_eligible",
  SUBMITTED: "submitted",
  FILLED: "filled",
  OPEN: "open",
  CLOSED: "closed",
  EXPIRED: "expired"
};

const sourceIssue = (
  domain: string,
  entityId: string | null,
  discrepancyType: string,
  expected: JsonValue | null,
  actual: JsonValue | null
) => ({ domain, entityId, discrepancyType, expected, actual });

export const readControlPlaneSnapshot = async (
  snapshotPath: string
): Promise<ControlPlaneSnapshotData> => {
  const inspection = await inspectSqliteSnapshot(snapshotPath);
  const snapshotSeal = await captureSnapshotSeal(snapshotPath);
  if (snapshotSeal.sha256 !== inspection.sha256) {
    throw new Error("SQLITE_SNAPSHOT_CHANGED_DURING_READ");
  }
  if (
    inspection.integrityCheck.length !== 1 ||
    inspection.integrityCheck[0]?.toLowerCase() !== "ok"
  ) {
    throw new Error("SQLITE_SNAPSHOT_INTEGRITY_CHECK_FAILED");
  }
  if (inspection.foreignKeyViolationCount > 0) {
    throw new Error("SQLITE_SNAPSHOT_FOREIGN_KEY_CHECK_FAILED");
  }
  for (const table of [
    "research_runs",
    "paper_trade_candidates",
    "decision_snapshots",
    "decision_lifecycle_events"
  ]) {
    if (!(table in inspection.tableCounts)) {
      throw new Error(`SQLITE_SNAPSHOT_TABLE_REQUIRED:${table}`);
    }
  }
  const database = openReadOnlySqlite(snapshotPath);
  try {
    const researchRows = database
      .prepare("SELECT * FROM research_runs ORDER BY id")
      .all() as SqliteRow[];
    const candidateRows = database
      .prepare(
        `SELECT * FROM paper_trade_candidates
         ORDER BY research_run_id, rank, id`
      )
      .all() as SqliteRow[];
    const decisionColumnRows = database
      .prepare("PRAGMA table_info(decision_snapshots)")
      .all() as Array<{ name: string }>;
    const decisionColumns = new Set(decisionColumnRows.map((row) => row.name));
    const requestIdExpression = decisionColumns.has("request_id")
      ? "request_id"
      : "NULL AS request_id";
    const correlationIdExpression = decisionColumns.has("correlation_id")
      ? "correlation_id"
      : "NULL AS correlation_id";
    const decisionRows = database
      .prepare(
        `SELECT decision_id, candidate_id, position_lifecycle_id,
                ${requestIdExpression}, ${correlationIdExpression}
         FROM decision_snapshots
         ORDER BY decision_id`
      )
      .all() as SqliteRow[];
    const lifecycleRows = database
      .prepare(
        `SELECT event_id, decision_id, status, reason_codes_json, occurred_at,
                source_type, source_id, evidence_json
         FROM decision_lifecycle_events
         ORDER BY occurred_at, event_id`
      )
      .all() as SqliteRow[];
    const researchRuns = researchRows.map(mapSqliteResearchRun);
    const candidates = candidateRows.map(mapSqliteCandidate);
    const sourceIssues: ControlPlaneSnapshotData["sourceIssues"][number][] = [];
    const runById = new Map(researchRuns.map((run) => [run.id, run]));
    const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const decisions = decisionRows.map((row) => ({
      decisionId: requiredString(row, "decision_snapshots", "decision_id"),
      originType: requiredString(row, "decision_snapshots", "origin_type"),
      decisionRole: requiredString(row, "decision_snapshots", "decision_role"),
      candidateId: nullableString(row, "decision_snapshots", "candidate_id"),
      positionLifecycleId: nullableString(
        row,
        "decision_snapshots",
        "position_lifecycle_id"
      ),
      requestId: nullableString(row, "decision_snapshots", "request_id"),
      correlationId: nullableString(row, "decision_snapshots", "correlation_id")
    }));
    const decisionById = new Map(decisions.map((decision) => [decision.decisionId, decision]));
    const decisionsByCandidate = new Map<string, string[]>();
    for (const decision of decisions) {
      if (decision.candidateId === null) continue;
      const ids = decisionsByCandidate.get(decision.candidateId) ?? [];
      ids.push(decision.decisionId);
      decisionsByCandidate.set(decision.candidateId, ids);
    }
    const rankOwners = new Map<string, string>();
    const decisionOwners = new Map<string, string>();
    for (const candidate of candidates) {
      const rankKey = `${candidate.researchRunId}:${candidate.rank}`;
      const rankOwner = rankOwners.get(rankKey);
      if (rankOwner !== undefined) {
        sourceIssues.push(
          sourceIssue(
            "candidates",
            candidate.id,
            "CANDIDATE_RANK_CONFLICT",
            { uniqueBy: [candidate.researchRunId, candidate.rank] },
            { candidateIds: [rankOwner, candidate.id].sort() }
          )
        );
      } else {
        rankOwners.set(rankKey, candidate.id);
      }
      if (!runById.has(candidate.researchRunId)) {
        sourceIssues.push(
          sourceIssue(
            "candidates",
            candidate.id,
            "CANDIDATE_RESEARCH_RUN_UNLINKED",
            candidate.researchRunId,
            null
          )
        );
      }
      if (candidate.decisionId === null) {
        sourceIssues.push(
          sourceIssue(
            "candidates",
            candidate.id,
            "CANDIDATE_DECISION_LINK_MISSING",
            "non_null_decision_id",
            null
          )
        );
        continue;
      }
      const decisionOwner = decisionOwners.get(candidate.decisionId);
      if (decisionOwner !== undefined && decisionOwner !== candidate.id) {
        sourceIssues.push(
          sourceIssue(
            "candidates",
            candidate.id,
            "CANDIDATE_DECISION_LINK_CONFLICT",
            candidate.id,
            decisionOwner
          )
        );
      } else {
        decisionOwners.set(candidate.decisionId, candidate.id);
      }
      const linkedDecisionIds = decisionsByCandidate.get(candidate.id) ?? [];
      const exactLegacyReuseWithoutSnapshot =
        candidate.decisionLinkageStatus === "EXACT_LEGACY_REUSE" &&
        candidate.decisionId === candidate.id &&
        decisionById.get(candidate.decisionId) === undefined &&
        linkedDecisionIds.length === 0;
      if (exactLegacyReuseWithoutSnapshot) {
        continue;
      }
      if (linkedDecisionIds.length > 1) {
        sourceIssues.push(
          sourceIssue(
            "candidates",
            candidate.id,
            "CANDIDATE_DECISION_LINK_MULTIPLE",
            [candidate.decisionId],
            [...linkedDecisionIds].sort()
          )
        );
      }
      if (
        !linkedDecisionIds.includes(candidate.decisionId) ||
        decisionById.get(candidate.decisionId)?.candidateId !== candidate.id
      ) {
        sourceIssues.push(
          sourceIssue(
            "candidates",
            candidate.id,
            "CANDIDATE_DECISION_LINK_CONFLICT",
            candidate.decisionId,
            linkedDecisionIds.sort()
          )
        );
      }
    }
    const deferredLifecycleEvents: ControlPlaneSnapshotData["deferredLifecycleEvents"][number][] = [];
    const eventsByCandidate = new Map<
      string,
      Array<{
        eventId: string;
        decisionId: string;
        status: string;
        reasonCodes: string[];
        occurredAt: string;
        sourceType: string;
        sourceId: string;
        evidence: JsonValue;
        requestId: string | null;
        correlationId: string | null;
      }>
    >();
    for (const row of lifecycleRows) {
      const eventId = requiredString(row, "decision_lifecycle_events", "event_id");
      const decisionId = requiredString(row, "decision_lifecycle_events", "decision_id");
      const rawStatus = requiredString(row, "decision_lifecycle_events", "status");
      const status = sourceLifecycleStatuses[rawStatus.toUpperCase()];
      const decision = decisionById.get(decisionId);
      if (status === undefined) {
        sourceIssues.push(
          sourceIssue(
            "candidate_lifecycle_events",
            eventId,
            "LIFECYCLE_STATUS_UNKNOWN",
            Object.values(sourceLifecycleStatuses),
            rawStatus
          )
        );
        continue;
      }
      const sourceType = requiredString(row, "decision_lifecycle_events", "source_type");
      const sourceId = requiredString(row, "decision_lifecycle_events", "source_id");
      if (decision === undefined) {
        sourceIssues.push(
          sourceIssue(
            "candidate_lifecycle_events",
            eventId,
            "LIFECYCLE_DECISION_UNLINKED",
            decisionId,
            null
          )
        );
        continue;
      }
      if (decision.candidateId === null) {
        deferredLifecycleEvents.push({ eventId, decisionId, status, sourceType, sourceId });
        continue;
      }
      const candidate = candidateById.get(decision.candidateId);
      if (candidate === undefined) {
        if (
          decision.originType === "paper_review_artifact" &&
          decision.decisionRole === "entry"
        ) {
          deferredLifecycleEvents.push({ eventId, decisionId, status, sourceType, sourceId });
          continue;
        }
        sourceIssues.push(
          sourceIssue(
            "candidate_lifecycle_events",
            eventId,
            "LIFECYCLE_CANDIDATE_LINK_CONFLICT",
            decision.candidateId,
            null
          )
        );
        continue;
      }
      if (candidate.decisionId !== decisionId) {
        sourceIssues.push(
          sourceIssue(
            "candidate_lifecycle_events",
            eventId,
            "LIFECYCLE_DECISION_CANDIDATE_MISMATCH",
            candidate.decisionId,
            decisionId
          )
        );
        continue;
      }
      const reasonCodes = parseJson(
        row.reason_codes_json,
        "decision_lifecycle_events",
        "reason_codes_json",
        "array"
      ) as JsonValue[];
      if (!reasonCodes.every((value): value is string => typeof value === "string")) {
        throw new Error(
          "SQLITE_JSON_INVALID:decision_lifecycle_events.reason_codes_json"
        );
      }
      const rawEvidence = parseJson(
        row.evidence_json,
        "decision_lifecycle_events",
        "evidence_json",
        "object"
      ) as { [key: string]: JsonValue };
      const candidateEvents = eventsByCandidate.get(candidate.id) ?? [];
      candidateEvents.push({
        eventId,
        decisionId,
        status,
        reasonCodes,
        occurredAt: requiredTimestamp(row, "decision_lifecycle_events", "occurred_at"),
        sourceType,
        sourceId,
        evidence: { sourceType, sourceId, ...rawEvidence },
        requestId: decision.requestId,
        correlationId: decision.correlationId
      });
      eventsByCandidate.set(candidate.id, candidateEvents);
    }
    const candidateLifecycleEvents: ControlPlaneCandidateLifecycleEvent[] = [];
    const latestLifecycleStatusByCandidate = new Map<string, string>();
    for (const candidate of candidates) {
      const run = runById.get(candidate.researchRunId);
      const events = (eventsByCandidate.get(candidate.id) ?? []).sort(
        (left, right) =>
          left.occurredAt.localeCompare(right.occurredAt) || left.eventId.localeCompare(right.eventId)
      );
      let priorStatus: string | null = null;
      events.forEach((event, sequenceNumber) => {
        candidateLifecycleEvents.push({
          eventId: event.eventId,
          candidateId: candidate.id,
          sequenceNumber,
          eventType: `decision.lifecycle.${event.status}`,
          priorStatus,
          status: event.status,
          reasonCodes: event.reasonCodes,
          evidence: event.evidence,
          idempotencyKey: `sqlite:decision_lifecycle_events:${event.eventId}`,
          sourceEventId: event.eventId,
          occurredAt: event.occurredAt,
          producedAt: event.occurredAt,
          runId: candidate.researchRunId,
          requestId: event.requestId ?? run?.requestId ?? null,
          correlationId: event.correlationId ?? run?.correlationId ?? null,
          schedulerJobName: null,
          schedulerFencingToken: null,
          createdAt: event.occurredAt
        });
        priorStatus = event.status;
      });
      if (priorStatus !== null) {
        latestLifecycleStatusByCandidate.set(candidate.id, priorStatus);
      }
    }
    const candidatesWithLifecycle = candidates.map((candidate) => {
      const latestStatus = latestLifecycleStatusByCandidate.get(candidate.id);
      return latestStatus
        ? { ...candidate, lifecycleStatus: latestStatus }
        : candidate;
    });
    const runtimeWriteLeases =
      "runtime_write_leases" in inspection.tableCounts
        ? (database
            .prepare(
              `SELECT lease_name, acquired_at, expires_at
               FROM runtime_write_leases
               ORDER BY lease_name`
            )
            .all() as SqliteRow[]).map((row) => ({
            leaseName: requiredString(row, "runtime_write_leases", "lease_name"),
            acquiredAt: requiredTimestamp(row, "runtime_write_leases", "acquired_at"),
            expiresAt: requiredTimestamp(row, "runtime_write_leases", "expires_at")
          }))
        : [];
    await assertSnapshotSealUnchanged(snapshotPath, snapshotSeal);
    return {
      inspection,
      researchRuns,
      candidates: candidatesWithLifecycle,
      candidateLifecycleEvents,
      deferredLifecycleEvents,
      sourceIssues,
      runtimeWriteLeases
    };
  } finally {
    database.close();
  }
};

const researchRunColumns = [
  "id", "workstream", "run_key", "status", "risk_profile", "options_enabled",
  "universe_size", "targets_generated", "candidates_selected", "config", "summary",
  "error_code", "error_message", "worker_identity", "scheduler_job_name",
  "scheduler_fencing_token", "request_id", "correlation_id", "started_at",
  "heartbeat_at", "completed_at", "recovered_at", "recovery_reason", "recovery_source",
  "version", "created_at", "updated_at"
] as const;

const insertResearchRunSql = `
  INSERT INTO research_runs(
    id, workstream, run_key, status, risk_profile, options_enabled,
    universe_size, targets_generated, candidates_selected, config, summary,
    error_code, error_message, worker_identity, scheduler_job_name,
    scheduler_fencing_token, request_id, correlation_id, started_at,
    heartbeat_at, completed_at, recovered_at, recovery_reason, recovery_source,
    version, created_at, updated_at
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
    $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27
  ) ON CONFLICT (id) DO NOTHING
`;

const researchRunValues = (run: ControlPlaneResearchRun): readonly unknown[] => [
  run.id,
  run.workstream,
  run.runKey,
  run.status,
  run.riskProfile,
  run.optionsEnabled,
  run.universeSize,
  run.targetsGenerated,
  run.candidatesSelected,
  JSON.stringify(run.config),
  run.summary === null ? null : JSON.stringify(run.summary),
  run.errorCode,
  run.errorMessage,
  run.workerIdentity,
  run.schedulerJobName,
  run.schedulerFencingToken,
  run.requestId,
  run.correlationId,
  run.startedAt,
  run.heartbeatAt,
  run.completedAt,
  run.recoveredAt,
  run.recoveryReason,
  run.recoverySource,
  run.version,
  run.createdAt,
  run.updatedAt
];

const candidateColumns = [
  "id", "decision_id", "research_run_id", "candidate_key", "symbol", "underlying_symbol",
  "option_symbol", "asset_class", "as_of", "rank", "direction", "horizon", "risk_profile",
  "preferred_expression", "strategy_family", "score", "confidence", "expected_return",
  "estimated_max_loss", "estimated_max_profit", "historical_win_rate",
  "historical_avg_return", "historical_max_drawdown", "similar_setup_count",
  "option_liquidity_score", "volatility_score", "signal_freshness_days",
  "recent_learning_adjustment", "directional_accuracy", "option_outperformance_accuracy",
  "strike", "short_strike", "decision", "lifecycle_status", "decision_reason", "rationale",
  "signal_inputs", "data_quality_status", "relevant_backtest_run_id", "source_candidate_id",
  "version", "created_at", "updated_at"
] as const;

const candidateNumericColumns = [
  { source: "score", column: "score", precision: 24, scale: 10 },
  { source: "confidence", column: "confidence", precision: 12, scale: 10 },
  { source: "expectedReturn", column: "expected_return", precision: 24, scale: 10 },
  { source: "estimatedMaxLoss", column: "estimated_max_loss", precision: 28, scale: 8 },
  { source: "estimatedMaxProfit", column: "estimated_max_profit", precision: 28, scale: 8 },
  { source: "historicalWinRate", column: "historical_win_rate", precision: 12, scale: 10 },
  { source: "historicalAvgReturn", column: "historical_avg_return", precision: 24, scale: 10 },
  { source: "historicalMaxDrawdown", column: "historical_max_drawdown", precision: 24, scale: 10 },
  { source: "optionLiquidityScore", column: "option_liquidity_score", precision: 24, scale: 10 },
  { source: "volatilityScore", column: "volatility_score", precision: 24, scale: 10 },
  { source: "recentLearningAdjustment", column: "recent_learning_adjustment", precision: 24, scale: 10 },
  { source: "directionalAccuracy", column: "directional_accuracy", precision: 12, scale: 10 },
  { source: "optionOutperformanceAccuracy", column: "option_outperformance_accuracy", precision: 12, scale: 10 },
  { source: "strike", column: "strike", precision: 28, scale: 8 },
  { source: "shortStrike", column: "short_strike", precision: 28, scale: 8 }
] as const;

const CONTROL_PLANE_MAPPING_VERSION = 2;

const insertCandidateSql = `
  INSERT INTO candidates(
    id, decision_id, research_run_id, candidate_key, symbol, underlying_symbol,
    option_symbol, asset_class, as_of, rank, direction, horizon, risk_profile,
    preferred_expression, strategy_family, score, confidence, expected_return,
    estimated_max_loss, estimated_max_profit, historical_win_rate,
    historical_avg_return, historical_max_drawdown, similar_setup_count,
    option_liquidity_score, volatility_score, signal_freshness_days,
    recent_learning_adjustment, directional_accuracy,
    option_outperformance_accuracy, strike, short_strike, decision,
    lifecycle_status, decision_reason, rationale, signal_inputs,
    data_quality_status, relevant_backtest_run_id, source_candidate_id, version,
    created_at, updated_at
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
    $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26,
    $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38,
    $39, $40, $41, $42, $43
  ) ON CONFLICT (id) DO NOTHING
`;

const candidateValues = (candidate: ControlPlaneCandidate): readonly unknown[] => {
  const numeric = (source: typeof candidateNumericColumns[number]["source"]) => {
    const definition = candidateNumericColumns.find((entry) => entry.source === source)!;
    return canonicalizePostgresNumeric(
      candidate[source],
      definition.precision,
      definition.scale
    );
  };
  return [
    candidate.id,
    candidate.decisionId,
    candidate.researchRunId,
    candidate.candidateKey,
    candidate.symbol,
    candidate.underlyingSymbol,
    candidate.optionSymbol,
    candidate.assetClass,
    candidate.asOf,
    candidate.rank,
    candidate.direction,
    candidate.horizon,
    candidate.riskProfile,
    candidate.preferredExpression,
    candidate.strategyFamily,
    numeric("score"),
    numeric("confidence"),
    numeric("expectedReturn"),
    numeric("estimatedMaxLoss"),
    numeric("estimatedMaxProfit"),
    numeric("historicalWinRate"),
    numeric("historicalAvgReturn"),
    numeric("historicalMaxDrawdown"),
    candidate.similarSetupCount,
    numeric("optionLiquidityScore"),
    numeric("volatilityScore"),
    candidate.signalFreshnessDays,
    numeric("recentLearningAdjustment"),
    numeric("directionalAccuracy"),
    numeric("optionOutperformanceAccuracy"),
    numeric("strike"),
    numeric("shortStrike"),
    candidate.decision,
    candidate.lifecycleStatus,
    candidate.decisionReason,
    JSON.stringify(candidate.rationale),
    JSON.stringify(candidate.signalInputs),
    candidate.dataQualityStatus,
    candidate.relevantBacktestRunId,
    candidate.sourceCandidateId,
    candidate.version,
    candidate.createdAt,
    candidate.updatedAt
  ];
};

const candidateEventColumns = [
  "event_id", "candidate_id", "sequence_number", "event_type", "prior_status", "status",
  "reason_codes", "evidence", "idempotency_key", "source_event_id", "occurred_at",
  "produced_at", "run_id", "request_id", "correlation_id", "scheduler_job_name",
  "scheduler_fencing_token", "created_at"
] as const;

const insertCandidateEventSql = `
  INSERT INTO candidate_lifecycle_events(
    event_id, candidate_id, sequence_number, event_type, prior_status, status,
    reason_codes, evidence, idempotency_key, source_event_id, occurred_at,
    produced_at, run_id, request_id, correlation_id, scheduler_job_name,
    scheduler_fencing_token, created_at
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
    $15, $16, $17, $18
  ) ON CONFLICT (event_id) DO NOTHING
`;

const candidateEventValues = (
  event: ControlPlaneCandidateLifecycleEvent
): readonly unknown[] => [
  event.eventId,
  event.candidateId,
  event.sequenceNumber,
  event.eventType,
  event.priorStatus,
  event.status,
  JSON.stringify(event.reasonCodes),
  JSON.stringify(event.evidence),
  event.idempotencyKey,
  event.sourceEventId,
  event.occurredAt,
  event.producedAt,
  event.runId,
  event.requestId,
  event.correlationId,
  event.schedulerJobName,
  event.schedulerFencingToken,
  event.createdAt
];

const insertInBatches = async <T>(input: {
  readonly rows: readonly T[];
  readonly batchSize: number;
  readonly pool: Pool;
  readonly config: DatabaseConfig;
  readonly table: "research_runs" | "candidates" | "candidate_lifecycle_events";
  readonly columns: readonly string[];
  readonly sql: string;
  readonly values: (row: T) => readonly unknown[];
}) => {
  let inserted = 0;
  for (let offset = 0; offset < input.rows.length; offset += input.batchSize) {
    const batch = input.rows.slice(offset, offset + input.batchSize);
    inserted += await withPostgresTransaction(
      input.pool,
      input.config,
      async (client: PoolClient) => {
        let batchInserted = 0;
        for (const row of batch) {
          const values = [...input.values(row)];
          const result = await client.query(input.sql, values);
          batchInserted += result.rowCount ?? 0;
          if ((result.rowCount ?? 0) === 0) {
            const comparison = await client.query<{ matches: boolean }>(
              `SELECT (${input.columns
                .map((column, index) => `${column} IS NOT DISTINCT FROM $${index + 1}`)
                .join(" AND ")}) AS matches
               FROM ${input.table}
               WHERE ${input.columns[0]} = $1`,
              values
            );
            if (comparison.rows[0]?.matches !== true) {
              throw new Error(`CONTROL_PLANE_BACKFILL_CONFLICT:${input.table}`);
            }
          }
        }
        return batchInserted;
      }
    );
  }
  return inserted;
};

export const backfillControlPlaneSnapshot = async (input: {
  readonly snapshotPath: string;
  readonly pool: Pool;
  readonly config: DatabaseConfig;
  readonly batchSize?: number;
}) => {
  if (input.config.backend !== "postgres" || input.config.purpose !== "migration") {
    throw new Error("CONTROL_PLANE_BACKFILL_MIGRATION_CONFIG_REQUIRED");
  }
  const batchSize = input.batchSize ?? 250;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error("CONTROL_PLANE_BACKFILL_BATCH_SIZE_INVALID");
  }
  const snapshot = await readControlPlaneSnapshot(input.snapshotPath);
  if (snapshot.sourceIssues.length > 0) {
    const issueTypes = [...new Set(snapshot.sourceIssues.map((issue) => issue.discrepancyType))]
      .sort()
      .join(",");
    throw new Error(`CONTROL_PLANE_SOURCE_RECONCILIATION_BLOCKED:${issueTypes}`);
  }
  const researchRuns = await insertInBatches({
    rows: snapshot.researchRuns,
    batchSize,
    pool: input.pool,
    config: input.config,
    table: "research_runs",
    columns: researchRunColumns,
    sql: insertResearchRunSql,
    values: researchRunValues
  });
  const candidates = await insertInBatches({
    rows: snapshot.candidates,
    batchSize,
    pool: input.pool,
    config: input.config,
    table: "candidates",
    columns: candidateColumns,
    sql: insertCandidateSql,
    values: candidateValues
  });
  const candidateLifecycleEvents = await insertInBatches({
    rows: snapshot.candidateLifecycleEvents,
    batchSize,
    pool: input.pool,
    config: input.config,
    table: "candidate_lifecycle_events",
    columns: candidateEventColumns,
    sql: insertCandidateEventSql,
    values: candidateEventValues
  });
  return {
    snapshotSha256: snapshot.inspection.sha256,
    sourceRows: {
      researchRuns: snapshot.researchRuns.length,
      candidates: snapshot.candidates.length,
      candidateLifecycleEvents: snapshot.candidateLifecycleEvents.length,
      deferredLifecycleEvents: snapshot.deferredLifecycleEvents.length
    },
    insertedRows: {
      researchRuns,
      candidates,
      candidateLifecycleEvents
    }
  };
};

export interface ControlPlaneReconciliationDiscrepancy {
  readonly id: string;
  readonly checkpointId: string;
  readonly domain: string;
  readonly entityId: string | null;
  readonly discrepancyType: string;
  readonly expected: JsonValue | null;
  readonly actual: JsonValue | null;
  readonly observedAt: string;
}

interface PostgresControlPlaneState {
  readonly researchRuns: ReadonlyArray<{ id: string; status: string }>;
  readonly candidates: ReadonlyArray<{
    id: string;
    decisionId: string | null;
    researchRunId: string;
    lifecycleStatus: string;
    raw: Readonly<Record<string, unknown>>;
  }>;
  readonly candidateLifecycleEvents: ReadonlyArray<{
    eventId: string;
    candidateId: string;
    sequenceNumber: number;
    eventType: string;
    status: string;
    idempotencyKey: string;
    sourceEventId: string | null;
    occurredAt: string;
    producedAt: string;
    requestId: string | null;
    correlationId: string | null;
  }>;
  readonly heldSchedulerLeaseCount: number;
  readonly idempotencyCount: number;
  readonly idempotencyUniqueCount: number;
  readonly workstreamEventCount: number;
  readonly workstreamEventUniqueCount: number;
  readonly workstreamFailureCount: number;
}

const countValue = (value: unknown, label: string) => {
  const count = Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`POSTGRES_RECONCILIATION_COUNT_INVALID:${label}`);
  }
  return count;
};

const readPostgresControlPlaneState = async (
  client: PoolClient
): Promise<PostgresControlPlaneState> => {
  const runs = await client.query<{ id: string; status: string }>(
    "SELECT id, status FROM research_runs ORDER BY id"
  );
  const candidates = await client.query<Record<string, unknown> & {
    id: string;
    decision_id: string | null;
    research_run_id: string;
    lifecycle_status: string;
  }>(
    `SELECT id, decision_id, research_run_id, lifecycle_status,
            ${candidateNumericColumns.map((entry) => entry.column).join(", ")}
     FROM candidates
     ORDER BY research_run_id, rank, id`
  );
  const events = await client.query<{
    event_id: string;
    candidate_id: string;
    sequence_number: number | string;
    event_type: string;
    status: string;
    idempotency_key: string;
    source_event_id: string | null;
    occurred_at: Date | string;
    produced_at: Date | string;
    request_id: string | null;
    correlation_id: string | null;
  }>(
    `SELECT event_id, candidate_id, sequence_number, event_type, status,
            idempotency_key, source_event_id, occurred_at, produced_at,
            request_id, correlation_id
     FROM candidate_lifecycle_events
     ORDER BY candidate_id, sequence_number, event_id`
  );
  const scheduler = await client.query<{ held_count: number | string }>(
    `SELECT COUNT(*) AS held_count
     FROM scheduler_leases
     WHERE status = 'held'`
  );
  const idempotency = await client.query<{
    total_count: number | string;
    unique_count: number | string;
  }>(
    `SELECT COUNT(*) AS total_count,
            COUNT(DISTINCT (scope, idempotency_key)) AS unique_count
     FROM idempotency_records`
  );
  const workstream = await client.query<{
    total_count: number | string;
    unique_count: number | string;
    failure_count: number | string;
  }>(
    `SELECT COUNT(*) AS total_count,
            COUNT(DISTINCT event_id) AS unique_count,
            (SELECT COUNT(*) FROM workstream_event_failures) AS failure_count
     FROM workstream_events`
  );
  return {
    researchRuns: runs.rows.map((row) => ({ id: row.id, status: row.status })),
    candidates: candidates.rows.map((row) => ({
      id: row.id,
      decisionId: row.decision_id,
      researchRunId: row.research_run_id,
      lifecycleStatus: row.lifecycle_status,
      raw: row
    })),
    candidateLifecycleEvents: events.rows.map((row) => ({
      eventId: row.event_id,
      candidateId: row.candidate_id,
      sequenceNumber: countValue(row.sequence_number, "candidate_lifecycle_events.sequence"),
      eventType: row.event_type,
      status: row.status,
      idempotencyKey: row.idempotency_key,
      sourceEventId: row.source_event_id,
      occurredAt: new Date(row.occurred_at).toISOString(),
      producedAt: new Date(row.produced_at).toISOString(),
      requestId: row.request_id,
      correlationId: row.correlation_id
    })),
    heldSchedulerLeaseCount: countValue(scheduler.rows[0]?.held_count, "scheduler_leases"),
    idempotencyCount: countValue(idempotency.rows[0]?.total_count, "idempotency_records"),
    idempotencyUniqueCount: countValue(
      idempotency.rows[0]?.unique_count,
      "idempotency_records.unique"
    ),
    workstreamEventCount: countValue(workstream.rows[0]?.total_count, "workstream_events"),
    workstreamEventUniqueCount: countValue(
      workstream.rows[0]?.unique_count,
      "workstream_events.unique"
    ),
    workstreamFailureCount: countValue(
      workstream.rows[0]?.failure_count,
      "workstream_event_failures"
    )
  };
};

const decimalIdentity = (value: number | string | null) => {
  if (value === null) return null;
  const parsed = parseDecimal(value);
  return `${parsed.coefficient}:${parsed.scale}`;
};

const classifyCandidateNumerics = (
  source: readonly ControlPlaneCandidate[],
  target: PostgresControlPlaneState["candidates"]
) => {
  const targetById = new Map(target.map((candidate) => [candidate.id, candidate]));
  const counts = {
    rowsExamined: 0,
    exactBeforeNormalization: 0,
    normalizedEquivalent: 0,
    overflow: 0,
    invalidNumeric: 0,
    unexplainedMismatch: 0
  };
  for (const candidate of source) {
    counts.rowsExamined += 1;
    const stored = targetById.get(candidate.id);
    if (!stored) {
      counts.unexplainedMismatch += 1;
      continue;
    }
    let exact = true;
    let equivalent = true;
    let overflow = false;
    let invalid = false;
    for (const numeric of candidateNumericColumns) {
      const sourceValue = candidate[numeric.source];
      const targetValue = stored.raw[numeric.column] as number | string | null;
      try {
        if (decimalIdentity(sourceValue) !== decimalIdentity(targetValue)) exact = false;
        if (
          canonicalizePostgresNumeric(sourceValue, numeric.precision, numeric.scale) !==
          canonicalizePostgresNumeric(targetValue, numeric.precision, numeric.scale)
        ) {
          equivalent = false;
        }
      } catch (error) {
        const code = error instanceof Error ? error.message : "POSTGRES_NUMERIC_INVALID";
        if (code === "POSTGRES_NUMERIC_OVERFLOW") overflow = true;
        else invalid = true;
        equivalent = false;
      }
    }
    if (overflow) counts.overflow += 1;
    else if (invalid) counts.invalidNumeric += 1;
    else if (!equivalent) counts.unexplainedMismatch += 1;
    else if (exact) counts.exactBeforeNormalization += 1;
    else counts.normalizedEquivalent += 1;
  }
  return counts;
};

const statusCounts = (statuses: readonly string[]) => {
  const counts: Record<string, number> = {};
  for (const status of [...statuses].sort()) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
};

const candidatesByRun = (
  candidates: ReadonlyArray<{ readonly researchRunId: string }>
) => {
  const counts: Record<string, number> = {};
  for (const candidate of candidates) {
    counts[candidate.researchRunId] = (counts[candidate.researchRunId] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
};

const createDiscrepancy = (input: {
  checkpointId: string;
  domain: string;
  entityId?: string | null;
  discrepancyType: string;
  expected: JsonValue | null;
  actual: JsonValue | null;
  observedAt: string;
}): ControlPlaneReconciliationDiscrepancy => {
  const entityId = input.entityId ?? null;
  const identity = createHash("sha256")
    .update(
      canonicalJson({
        checkpointId: input.checkpointId,
        domain: input.domain,
        entityId,
        discrepancyType: input.discrepancyType,
        expected: input.expected,
        actual: input.actual
      })
    )
    .digest("hex");
  return { id: identity, ...input, entityId };
};

const compareControlPlaneState = (input: {
  checkpointId: string;
  observedAt: string;
  source: ControlPlaneSnapshotData;
  target: PostgresControlPlaneState;
}) => {
  const discrepancies: ControlPlaneReconciliationDiscrepancy[] = input.source.sourceIssues.map(
    (issue) =>
      createDiscrepancy({
        checkpointId: input.checkpointId,
        domain: issue.domain,
        entityId: issue.entityId,
        discrepancyType: issue.discrepancyType,
        expected: issue.expected,
        actual: issue.actual,
        observedAt: input.observedAt
      })
  );
  const compare = (
    domain: string,
    discrepancyType: string,
    expected: JsonValue,
    actual: JsonValue,
    entityId: string | null = null
  ) => {
    if (canonicalJson(expected) === canonicalJson(actual)) return;
    discrepancies.push(
      createDiscrepancy({
        checkpointId: input.checkpointId,
        domain,
        entityId,
        discrepancyType,
        expected,
        actual,
        observedAt: input.observedAt
      })
    );
  };
  const sourceRuns = input.source.researchRuns;
  const sourceCandidates = input.source.candidates;
  const sourceEvents = input.source.candidateLifecycleEvents;
  const candidateNumericClassification = classifyCandidateNumerics(
    sourceCandidates,
    input.target.candidates
  );
  compare("research_runs", "ROW_COUNT_MISMATCH", sourceRuns.length, input.target.researchRuns.length);
  compare(
    "research_runs",
    "PRIMARY_IDS_MISMATCH",
    sourceRuns.map((row) => row.id).sort(),
    input.target.researchRuns.map((row) => row.id).sort()
  );
  compare(
    "research_runs",
    "STATUS_COUNTS_MISMATCH",
    statusCounts(sourceRuns.map((row) => row.status)),
    statusCounts(input.target.researchRuns.map((row) => row.status))
  );
  compare(
    "research_runs",
    "ACTIVE_RESEARCH_RUNS_MISMATCH",
    sourceRuns
      .filter((row) => row.status === "running" || row.status === "reserved")
      .map((row) => row.id)
      .sort(),
    input.target.researchRuns
      .filter((row) => row.status === "running" || row.status === "reserved")
      .map((row) => row.id)
      .sort()
  );
  compare("candidates", "ROW_COUNT_MISMATCH", sourceCandidates.length, input.target.candidates.length);
  compare(
    "candidates",
    "PRIMARY_IDS_MISMATCH",
    sourceCandidates.map((row) => row.id).sort(),
    input.target.candidates.map((row) => row.id).sort()
  );
  compare(
    "candidates",
    "DECISION_IDS_MISMATCH",
    sourceCandidates.map((row) => ({ id: row.id, decisionId: row.decisionId })).sort(
      (left, right) => left.id.localeCompare(right.id)
    ),
    input.target.candidates.map((row) => ({ id: row.id, decisionId: row.decisionId })).sort(
      (left, right) => left.id.localeCompare(right.id)
    )
  );
  compare(
    "candidates",
    "STATUS_COUNTS_MISMATCH",
    statusCounts(sourceCandidates.map((row) => row.lifecycleStatus)),
    statusCounts(input.target.candidates.map((row) => row.lifecycleStatus))
  );
  compare(
    "candidates",
    "CANDIDATES_BY_RUN_MISMATCH",
    candidatesByRun(sourceCandidates),
    candidatesByRun(input.target.candidates)
  );
  compare(
    "candidates",
    "CANDIDATE_NUMERIC_MISMATCH",
    { overflow: 0, invalidNumeric: 0, unexplainedMismatch: 0 },
    {
      overflow: candidateNumericClassification.overflow,
      invalidNumeric: candidateNumericClassification.invalidNumeric,
      unexplainedMismatch: candidateNumericClassification.unexplainedMismatch
    }
  );
  compare(
    "candidate_lifecycle_events",
    "ROW_COUNT_MISMATCH",
    sourceEvents.length,
    input.target.candidateLifecycleEvents.length
  );
  compare(
    "candidate_lifecycle_events",
    "PRIMARY_IDS_MISMATCH",
    sourceEvents.map((row) => row.eventId).sort(),
    input.target.candidateLifecycleEvents.map((row) => row.eventId).sort()
  );
  for (const candidate of sourceCandidates) {
    const expected = sourceEvents
      .filter((event) => event.candidateId === candidate.id)
      .map((event) => ({
        eventId: event.eventId,
        sequenceNumber: event.sequenceNumber,
        eventType: event.eventType,
        status: event.status,
        idempotencyKey: event.idempotencyKey,
        sourceEventId: event.sourceEventId,
        occurredAt: event.occurredAt,
        producedAt: event.producedAt,
        requestId: event.requestId,
        correlationId: event.correlationId
      }));
    const actual = input.target.candidateLifecycleEvents
      .filter((event) => event.candidateId === candidate.id)
      .map((event) => ({
        eventId: event.eventId,
        sequenceNumber: event.sequenceNumber,
        eventType: event.eventType,
        status: event.status,
        idempotencyKey: event.idempotencyKey,
        sourceEventId: event.sourceEventId,
        occurredAt: event.occurredAt,
        producedAt: event.producedAt,
        requestId: event.requestId,
        correlationId: event.correlationId
      }));
    compare(
      "candidate_lifecycle_events",
      "LIFECYCLE_ORDER_MISMATCH",
      expected,
      actual,
      candidate.id
    );
  }
  compare(
    "scheduler_leases",
    "ACTIVE_LEASE_COUNT_MISMATCH",
    0,
    input.target.heldSchedulerLeaseCount
  );
  for (const lease of input.source.runtimeWriteLeases) {
    if (Date.parse(lease.expiresAt) <= Date.parse(input.observedAt)) continue;
    discrepancies.push(
      createDiscrepancy({
        checkpointId: input.checkpointId,
        domain: "runtime_write_leases",
        entityId: lease.leaseName,
        discrepancyType: "LOCAL_RUNTIME_LEASE_ACTIVE",
        expected: { active: false },
        actual: { active: true, expiresAt: lease.expiresAt },
        observedAt: input.observedAt
      })
    );
  }
  compare("idempotency_records", "ROW_COUNT_MISMATCH", 0, input.target.idempotencyCount);
  compare(
    "idempotency_records",
    "DUPLICATE_COUNT_MISMATCH",
    input.target.idempotencyCount,
    input.target.idempotencyUniqueCount
  );
  compare("workstream_events", "ROW_COUNT_MISMATCH", 0, input.target.workstreamEventCount);
  compare(
    "workstream_events",
    "DUPLICATE_COUNT_MISMATCH",
    input.target.workstreamEventCount,
    input.target.workstreamEventUniqueCount
  );
  compare("workstream_event_failures", "ROW_COUNT_MISMATCH", 0, input.target.workstreamFailureCount);
  return {
    discrepancies,
    candidateNumericClassification
  };
};

export const reconcileControlPlaneSnapshot = async (input: {
  readonly snapshotPath: string;
  readonly pool: Pool;
  readonly config: DatabaseConfig;
  readonly checkpointId?: string;
  readonly observedAt?: string;
  readonly dryRun?: boolean;
}) => {
  if (input.config.backend !== "postgres" || input.config.purpose !== "migration") {
    throw new Error("CONTROL_PLANE_RECONCILIATION_MIGRATION_CONFIG_REQUIRED");
  }
  if (input.checkpointId !== undefined && !input.checkpointId.trim()) {
    throw new Error("CONTROL_PLANE_CHECKPOINT_ID_REQUIRED");
  }
  const observedAt = input.observedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new Error("CONTROL_PLANE_RECONCILIATION_TIMESTAMP_INVALID");
  }
  const source = await readControlPlaneSnapshot(input.snapshotPath);
  return withPostgresTransaction(input.pool, input.config, async (client) => {
    await client.query(
      "LOCK TABLE reconciliation_checkpoints IN SHARE ROW EXCLUSIVE MODE"
    );
    const target = await readPostgresControlPlaneState(client);
    let comparison = compareControlPlaneState({
      checkpointId: input.checkpointId ?? "control-plane-attempt",
      observedAt,
      source,
      target
    });
    const checkpointId = input.checkpointId?.trim() || (
      comparison.discrepancies.length === 0
        ? `control-plane-passed-${createHash("sha256")
          .update(`${source.inspection.sha256}:${CONTROL_PLANE_MAPPING_VERSION}`)
          .digest("hex")}`
        : `control-plane-blocked-${observedAt.replace(/[^0-9]/g, "")}`
    );
    if (input.checkpointId === undefined) {
      comparison = compareControlPlaneState({ checkpointId, observedAt, source, target });
    }
    const { discrepancies } = comparison;
    const status = discrepancies.length === 0 ? "passed" : "blocked";
    const sourceAggregates: JsonValue = {
      researchRuns: source.researchRuns.length,
      candidates: source.candidates.length,
      candidateLifecycleEvents: source.candidateLifecycleEvents.length,
      deferredLifecycleEvents: source.deferredLifecycleEvents.length,
      sourceIssues: source.sourceIssues.length,
      activeLocalRuntimeLeases: source.runtimeWriteLeases.filter(
        (lease) => Date.parse(lease.expiresAt) > Date.parse(observedAt)
      ).length,
      idempotencyRecords: 0,
      workstreamEvents: 0,
      workstreamEventFailures: 0
    };
    const targetAggregates: JsonValue = {
      researchRuns: target.researchRuns.length,
      candidates: target.candidates.length,
      candidateLifecycleEvents: target.candidateLifecycleEvents.length,
      heldSchedulerLeases: target.heldSchedulerLeaseCount,
      idempotencyRecords: target.idempotencyCount,
      workstreamEvents: target.workstreamEventCount,
      workstreamEventFailures: target.workstreamFailureCount
    };
    const sourceRowCount =
      source.researchRuns.length + source.candidates.length + source.candidateLifecycleEvents.length;
    const targetRowCount =
      target.researchRuns.length +
      target.candidates.length +
      target.candidateLifecycleEvents.length +
      target.idempotencyCount +
      target.workstreamEventCount +
      target.workstreamFailureCount;
    const lastEventOccurredAt = source.candidateLifecycleEvents
      .map((event) => event.occurredAt)
      .sort()
      .at(-1) ?? null;
    const cursorValue: JsonValue = {
      snapshotSha256: source.inspection.sha256,
      postgresMigrationVersion: 2,
      mappingVersion: CONTROL_PLANE_MAPPING_VERSION
    };
    const discrepancyReport: JsonValue = {
      discrepancyIds: discrepancies.map((row) => row.id)
    };
    const result = (
      checkpointMutationCount: number,
      discrepancyMutationCount: number,
      idempotentReplay: boolean,
      completedAt = observedAt
    ) => ({
      operation: "control_plane_reconciliation",
      checkpointId,
      status,
      authorityAllowed: status === "passed" && !input.dryRun,
      discrepancyCount: discrepancies.length,
      discrepancies,
      sourceAggregates,
      targetAggregates,
      candidateNumericClassification: comparison.candidateNumericClassification,
      candidateMutationCount: 0,
      checkpointMutationCount,
      discrepancyMutationCount,
      mutationCount: checkpointMutationCount + discrepancyMutationCount,
      idempotentReplay,
      dryRun: input.dryRun === true,
      postgresMigrationVersion: 2,
      mappingVersion: CONTROL_PLANE_MAPPING_VERSION,
      snapshotSha256: source.inspection.sha256,
      completedAt
    });
    const existing = await client.query<{
      status: string;
      source_checksum: string | null;
      discrepancy_count: number | string;
      cursor_value: Record<string, unknown> | string;
      source_aggregates: JsonValue | string;
      target_aggregates: JsonValue | string;
      discrepancy_report: JsonValue | string;
      completed_at: Date | string | null;
    }>(
      `SELECT status, source_checksum, discrepancy_count, cursor_value,
              source_aggregates, target_aggregates, discrepancy_report, completed_at
       FROM reconciliation_checkpoints
       WHERE id = $1`,
      [checkpointId]
    );
    if (existing.rows[0]) {
      try {
        if (existing.rows[0].completed_at === null) {
          throw new Error("CONTROL_PLANE_CHECKPOINT_COMPLETION_REQUIRED");
        }
        const replay = result(
          0,
          0,
          true,
          new Date(existing.rows[0].completed_at).toISOString()
        );
        assertDurableControlPlaneCheckpoint(existing.rows[0], replay);
        return replay;
      } catch {
        throw new Error("CONTROL_PLANE_CHECKPOINT_IMMUTABLE");
      }
    }
    if (input.dryRun) return result(0, 0, false);

    const checkpointWrite = await client.query(
      `INSERT INTO reconciliation_checkpoints(
         id, workstream, checkpoint_key, source_name, target_name, status,
         source_checksum, source_row_count, target_row_count, discrepancy_count,
         cursor_value, source_aggregates, target_aggregates, discrepancy_report,
         last_event_occurred_at, started_at, completed_at, version, created_at, updated_at
       ) VALUES (
         $1, 'control_plane', $2, 'sqlite_snapshot', 'postgres_control_plane', $3,
         $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, 1, $13, $13
       )
       ON CONFLICT (id) DO NOTHING`,
      [
        checkpointId,
        checkpointId,
        status,
        source.inspection.sha256,
        sourceRowCount,
        targetRowCount,
        discrepancies.length,
        JSON.stringify(cursorValue),
        JSON.stringify(sourceAggregates),
        JSON.stringify(targetAggregates),
        JSON.stringify(discrepancyReport),
        lastEventOccurredAt,
        observedAt
      ]
    );
    if ((checkpointWrite.rowCount ?? 0) !== 1) {
      throw new Error("CONTROL_PLANE_CHECKPOINT_IMMUTABLE");
    }
    let discrepancyMutationCount = 0;
    for (const discrepancy of discrepancies) {
      const discrepancyWrite = await client.query(
        `INSERT INTO reconciliation_discrepancies(
           id, checkpoint_id, domain, entity_id, discrepancy_type,
           expected, actual, observed_at, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          discrepancy.id,
          discrepancy.checkpointId,
          discrepancy.domain,
          discrepancy.entityId,
          discrepancy.discrepancyType,
          discrepancy.expected === null ? null : JSON.stringify(discrepancy.expected),
          discrepancy.actual === null ? null : JSON.stringify(discrepancy.actual),
          discrepancy.observedAt
        ]
      );
      discrepancyMutationCount += discrepancyWrite.rowCount ?? 0;
    }
    return result(1, discrepancyMutationCount, false);
  }, { isolationLevel: "repeatable read" });
};
