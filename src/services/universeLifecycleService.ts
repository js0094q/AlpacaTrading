import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { getDb, queryAll, queryOne } from "../lib/db.js";
import { normalizeSymbol } from "../lib/utils.js";
import type { UniverseLifecycleState, UniverseSymbolRow } from "../types.js";
import {
  listAlpacaAssets,
  type AlpacaAssetSnapshot
} from "./alpacaAssetService.js";
import {
  assertLiveTradingDisabled,
  assertReadOnlyAlpacaAccessAllowed
} from "./tradingSafetyService.js";
import {
  getAllUniverse,
  getUniverseSymbol,
  seedInitialUniverse
} from "./universeService.js";

const lifecycleStates: UniverseLifecycleState[] = [
  "discovered",
  "observe_only",
  "research_eligible",
  "paper_eligible",
  "paper_active",
  "suspended",
  "retired"
];

const activeLifecycleStates = new Set<UniverseLifecycleState>([
  "research_eligible",
  "paper_eligible",
  "paper_active"
]);

const assessmentPriority: Record<UniverseLifecycleState, number> = {
  paper_active: 0,
  paper_eligible: 1,
  research_eligible: 2,
  observe_only: 3,
  discovered: 4,
  suspended: 5,
  retired: 6
};

export interface UniverseLifecyclePolicy {
  configVersion: string;
  discoveryScanLimit: number;
  discoveryMaxNewSymbols: number;
  assessmentMaxSymbols: number;
  approvedExchanges: string[];
  minimumPrice: number;
  minimumDailyDollarVolume: number;
  maximumSpreadPct: number;
  minimumHistoryBars: number;
  minimumGoodObservations: number;
  maximumObservationAgeHours: number;
  evidenceLookbackDays: number;
  dataFailureLookbackDays: number;
  requiredResearchSelections: number;
  requireOptions: boolean;
  maximumDataFailures: number;
  maximumExecutionFailures: number;
  maximumUnderperformingOutcomes: number;
  underperformanceReturnPct: number;
  suspensionRetirementDays: number;
}

export interface UniverseLifecycleRunInput {
  listAssets?: typeof listAlpacaAssets;
  now?: () => Date;
  getGitSha?: () => string;
  policy?: Partial<UniverseLifecyclePolicy>;
}

export interface UniverseLifecycleRunResult {
  runId: string;
  status: "completed";
  startedAt: string;
  completedAt: string;
  paperOnly: true;
  nonBrokerMutating: true;
  discovery: {
    cursorStart: string | null;
    cursorEnd: string | null;
    scanned: number;
    discovered: number;
  };
  symbolsAssessed: number;
  historicalCoveragePendingSymbols: string[];
  transitionsApplied: number;
  stateCounts: Record<UniverseLifecycleState, number>;
  gitSha: string;
  configVersion: string;
  configHash: string;
}

export interface UniverseLifecycleStatus {
  latestRun: Record<string, unknown> | null;
  stateCounts: Record<UniverseLifecycleState, number>;
}

interface LifecycleContext {
  runId: string;
  gitSha: string;
  configVersion: string;
  configHash: string;
  eventSequence: number;
  transitionsApplied: number;
}

interface LatestSnapshotRow {
  observed_at: string;
  data_quality_status: string;
  latest_trade_price: number | null;
  daily_close: number | null;
  daily_volume: number | null;
  spread_pct: number | null;
}

interface LatestBarRow {
  close: number;
  volume: number;
}

interface SymbolEvidence {
  qualifiesForResearch: boolean;
  dataFailures: number;
  liquidityFailures: number;
  executionFailures: number;
  underperformingOutcomes: number;
  activePositions: number;
  researchSelections: number;
  evidence: Record<string, unknown>;
}

const defaultPolicy = (): UniverseLifecyclePolicy => ({
  ...config.universeLifecycle,
  approvedExchanges: config.universeLifecycle.approvedExchanges.map((exchange) =>
    exchange.toUpperCase()
  )
});

const mergePolicy = (
  input: Partial<UniverseLifecyclePolicy> | undefined
): UniverseLifecyclePolicy => {
  const base = defaultPolicy();
  return {
    ...base,
    ...input,
    approvedExchanges: (input?.approvedExchanges ?? base.approvedExchanges).map((exchange) =>
      exchange.toUpperCase()
    )
  };
};

const policyHash = (policy: UniverseLifecyclePolicy) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        ...policy,
        approvedExchanges: [...policy.approvedExchanges].sort()
      })
    )
    .digest("hex");

const defaultGitSha = () => {
  const fromEnvironment =
    process.env.GIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || process.env.SOURCE_VERSION;
  if (fromEnvironment?.trim()) {
    return fromEnvironment.trim();
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim() || "unknown";
  } catch {
    return "unknown";
  }
};

const count = (sql: string, params: Array<string | number | null> = []) =>
  Number(queryOne<{ count: number }>(sql, params)?.count ?? 0);

const isoDaysAgo = (now: Date, days: number) =>
  new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

const ageInDays = (value: string | null, now: Date) => {
  if (!value) {
    return 0;
  }
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? Math.max(0, (now.getTime() - time) / 86_400_000) : 0;
};

const boolFlag = (value: boolean | undefined): 0 | 1 | null =>
  value === undefined ? null : value ? 1 : 0;

const hasOptionsAttribute = (asset: AlpacaAssetSnapshot) =>
  (asset.attributes ?? []).some((attribute) =>
    ["has_options", "options_enabled", "options-enabled"].includes(attribute.trim().toLowerCase())
  );

const assetIssue = (asset: AlpacaAssetSnapshot | undefined, policy: UniverseLifecyclePolicy) => {
  if (!asset) return "ASSET_MISSING_FROM_ACTIVE_INVENTORY";
  if (asset.class !== "us_equity") return "ASSET_CLASS_INELIGIBLE";
  if (asset.status !== "active") return "ASSET_INACTIVE";
  if (asset.tradable !== true) return "ASSET_NOT_TRADABLE";
  if (!policy.approvedExchanges.includes((asset.exchange ?? "").toUpperCase())) {
    return "EXCHANGE_NOT_APPROVED";
  }
  if (policy.requireOptions && !hasOptionsAttribute(asset)) {
    return "OPTIONS_ATTRIBUTE_REQUIRED";
  }
  return null;
};

const safeError = (error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown";
  return message.length > 240 ? message.slice(0, 240) + "..." : message;
};

const eventId = (context: LifecycleContext) => {
  context.eventSequence += 1;
  return context.runId + ":event:" + String(context.eventSequence).padStart(6, "0");
};

const writeEvent = (
  context: LifecycleContext,
  input: {
    symbol: string;
    fromState: UniverseLifecycleState | null;
    toState: UniverseLifecycleState;
    reasonCode: string;
    evidence: Record<string, unknown>;
    occurredAt: string;
  }
) => {
  getDb().prepare(
    "INSERT INTO universe_lifecycle_events(" +
      "id, run_id, symbol, from_state, to_state, reason_code, evidence_json, " +
      "occurred_at, git_sha, config_version, config_hash" +
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    eventId(context),
    context.runId,
    input.symbol,
    input.fromState,
    input.toState,
    input.reasonCode,
    JSON.stringify(input.evidence),
    input.occurredAt,
    context.gitSha,
    context.configVersion,
    context.configHash
  );
  context.transitionsApplied += 1;
};

const transitionSymbol = (
  context: LifecycleContext,
  row: UniverseSymbolRow,
  toState: UniverseLifecycleState,
  reasonCode: string,
  evidence: Record<string, unknown>,
  occurredAt: string
) => {
  if (row.lifecycleState === toState) {
    return false;
  }
  const db = getDb();
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.prepare(
      "UPDATE universe_symbols SET lifecycle_state = ?, lifecycle_reason_code = ?, " +
        "lifecycle_entered_at = ?, lifecycle_updated_at = ?, lifecycle_config_version = ?, " +
        "enabled = ?, updated_at = ? WHERE symbol = ?"
    ).run(
      toState,
      reasonCode,
      occurredAt,
      occurredAt,
      context.configVersion,
      activeLifecycleStates.has(toState) ? 1 : 0,
      occurredAt,
      row.symbol
    );
    writeEvent(context, {
      symbol: row.symbol,
      fromState: row.lifecycleState,
      toState,
      reasonCode,
      evidence,
      occurredAt
    });
    db.exec("COMMIT;");
    return true;
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
};

const recordBaseline = (
  context: LifecycleContext,
  row: UniverseSymbolRow,
  occurredAt: string
) => {
  if (
    count("SELECT COUNT(*) AS count FROM universe_lifecycle_events WHERE symbol = ?", [
      row.symbol
    ]) > 0
  ) {
    return;
  }
  const db = getDb();
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.prepare(
      "UPDATE universe_symbols SET lifecycle_entered_at = COALESCE(lifecycle_entered_at, ?), " +
        "lifecycle_updated_at = COALESCE(lifecycle_updated_at, ?), " +
        "lifecycle_config_version = COALESCE(lifecycle_config_version, ?) WHERE symbol = ?"
    ).run(occurredAt, occurredAt, context.configVersion, row.symbol);
    writeEvent(context, {
      symbol: row.symbol,
      fromState: null,
      toState: row.lifecycleState,
      reasonCode: "LEGACY_UNIVERSE_BASELINE",
      evidence: { source: row.source, enabled: row.enabled, tradable: row.tradable },
      occurredAt
    });
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
};

const updateAssetMetadata = (symbol: string, asset: AlpacaAssetSnapshot, occurredAt: string) => {
  const attributes = asset.attributes ?? [];
  getDb().prepare(
    "UPDATE universe_symbols SET tradable = ?, asset_id = ?, asset_status = ?, exchange = ?, " +
      "fractionable = ?, shortable = ?, marginable = ?, options_enabled = ?, " +
      "asset_attributes_json = ?, asset_validated_at = ?, asset_request_id = ?, " +
      "updated_at = ? WHERE symbol = ?"
  ).run(
    asset.tradable === true ? 1 : 0,
    asset.id ?? null,
    asset.status ?? null,
    asset.exchange ?? null,
    boolFlag(asset.fractionable),
    boolFlag(asset.shortable),
    boolFlag(asset.marginable),
    hasOptionsAttribute(asset) ? 1 : 0,
    JSON.stringify(attributes),
    occurredAt,
    asset.requestId ?? null,
    occurredAt,
    symbol
  );
};

const insertDiscoveredSymbol = (
  context: LifecycleContext,
  asset: AlpacaAssetSnapshot,
  occurredAt: string
) => {
  const symbol = normalizeSymbol(asset.symbol);
  if (!symbol || getUniverseSymbol(symbol)) {
    return null;
  }
  const attributes = asset.attributes ?? [];
  const db = getDb();
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.prepare(
      "INSERT INTO universe_symbols(" +
        "symbol, asset_class, enabled, source, tradable, asset_id, asset_status, exchange, " +
        "fractionable, shortable, marginable, options_enabled, asset_attributes_json, " +
        "asset_validated_at, asset_request_id, lifecycle_state, lifecycle_reason_code, " +
        "lifecycle_entered_at, lifecycle_updated_at, lifecycle_config_version, created_at, updated_at" +
      ") VALUES (?, 'stock', 0, 'alpaca_universe_lifecycle', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, " +
        "'discovered', 'DISCOVERED_FROM_ALPACA', ?, ?, ?, ?, ?)"
    ).run(
      symbol,
      asset.tradable === true ? 1 : 0,
      asset.id ?? null,
      asset.status ?? null,
      asset.exchange ?? null,
      boolFlag(asset.fractionable),
      boolFlag(asset.shortable),
      boolFlag(asset.marginable),
      hasOptionsAttribute(asset) ? 1 : 0,
      JSON.stringify(attributes),
      occurredAt,
      asset.requestId ?? null,
      occurredAt,
      occurredAt,
      context.configVersion,
      occurredAt,
      occurredAt
    );
    writeEvent(context, {
      symbol,
      fromState: null,
      toState: "discovered",
      reasonCode: "DISCOVERED_FROM_ALPACA",
      evidence: {
        assetClass: asset.class ?? null,
        assetStatus: asset.status ?? null,
        exchange: asset.exchange ?? null,
        tradable: asset.tradable === true,
        optionsEnabled: hasOptionsAttribute(asset),
        requestId: asset.requestId ?? null
      },
      occurredAt
    });
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
  return getUniverseSymbol(symbol);
};

const createRun = (input: {
  id: string;
  startedAt: string;
  cursorStart: string | null;
  gitSha: string;
  configVersion: string;
  configHash: string;
}) => {
  getDb().prepare(
    "INSERT INTO universe_lifecycle_runs(" +
      "id, started_at, status, discovery_cursor_start, discovery_cursor_end, " +
      "git_sha, config_version, config_hash" +
    ") VALUES (?, ?, 'running', ?, NULL, ?, ?, ?)"
  ).run(
    input.id,
    input.startedAt,
    input.cursorStart,
    input.gitSha,
    input.configVersion,
    input.configHash
  );
};

const finishRun = (input: {
  runId: string;
  status: "completed" | "failed";
  completedAt: string;
  cursorEnd: string | null;
  assetsScanned: number;
  assetsDiscovered: number;
  symbolsAssessed: number;
  transitionsApplied: number;
  errorSummary?: string | null;
}) => {
  getDb().prepare(
    "UPDATE universe_lifecycle_runs SET completed_at = ?, status = ?, discovery_cursor_end = ?, " +
      "assets_scanned = ?, assets_discovered = ?, symbols_assessed = ?, transitions_applied = ?, " +
      "error_summary = ? WHERE id = ?"
  ).run(
    input.completedAt,
    input.status,
    input.cursorEnd,
    input.assetsScanned,
    input.assetsDiscovered,
    input.symbolsAssessed,
    input.transitionsApplied,
    input.errorSummary ?? null,
    input.runId
  );
};

const recoverIncompleteRuns = (recoveredAt: string) => {
  getDb().prepare(
    "UPDATE universe_lifecycle_runs SET status = 'failed', completed_at = COALESCE(completed_at, ?), " +
      "error_summary = COALESCE(error_summary, 'RECOVERED_INCOMPLETE_RUN') WHERE status = 'running'"
  ).run(recoveredAt);
};

const latestCursor = () =>
  queryOne<{ discovery_cursor_end: string | null }>(
    "SELECT discovery_cursor_end FROM universe_lifecycle_runs " +
      "WHERE status = 'completed' AND discovery_cursor_end IS NOT NULL " +
      "ORDER BY completed_at DESC, id DESC LIMIT 1"
  )?.discovery_cursor_end ?? null;

const buildAssetMap = (assets: AlpacaAssetSnapshot[]) => {
  const result = new Map<string, AlpacaAssetSnapshot>();
  for (const asset of assets) {
    const symbol = normalizeSymbol(asset.symbol);
    if (symbol) {
      result.set(symbol, { ...asset, symbol });
    }
  }
  return result;
};

const selectDiscoveryAssets = (input: {
  assets: AlpacaAssetSnapshot[];
  existingSymbols: Set<string>;
  cursorStart: string | null;
  policy: UniverseLifecyclePolicy;
}) => {
  const eligible = input.assets
    .filter((asset) => assetIssue(asset, input.policy) === null)
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
  const afterCursor = input.cursorStart
    ? eligible.filter((asset) => asset.symbol > input.cursorStart!)
    : eligible;
  const rotation = afterCursor.length ? afterCursor : eligible;
  const scanned = rotation.slice(0, input.policy.discoveryScanLimit);
  return {
    scanned,
    discovered: scanned
      .filter((asset) => !input.existingSymbols.has(asset.symbol))
      .slice(0, input.policy.discoveryMaxNewSymbols),
    cursorEnd: scanned.at(-1)?.symbol ?? input.cursorStart
  };
};

const stateCounts = (): Record<UniverseLifecycleState, number> => {
  const counts = Object.fromEntries(lifecycleStates.map((state) => [state, 0])) as Record<
    UniverseLifecycleState,
    number
  >;
  const rows = queryAll<{ lifecycle_state: string; count: number }>(
    "SELECT lifecycle_state, COUNT(*) AS count FROM universe_symbols GROUP BY lifecycle_state"
  );
  for (const row of rows) {
    if (lifecycleStates.includes(row.lifecycle_state as UniverseLifecycleState)) {
      counts[row.lifecycle_state as UniverseLifecycleState] = Number(row.count);
    }
  }
  return counts;
};

const negativeLearningOutcomes = (symbol: string) => {
  const rows = queryAll<{ outcome_json: string | null }>(
    "SELECT outcome_json FROM paper_learning_records " +
      "WHERE (symbol = ? OR underlying_symbol = ?) AND learning_status = 'evaluated' " +
      "AND outcome_json IS NOT NULL",
    [symbol, symbol]
  );
  return rows.filter((row) => {
    try {
      const outcome = JSON.parse(row.outcome_json ?? "{}") as Record<string, unknown>;
      return ["pnlPaper", "pnlLiveLike", "returnPct", "realizedReturnPct"].some((key) => {
        const value = outcome[key];
        return typeof value === "number" && Number.isFinite(value) && value < 0;
      });
    } catch {
      return false;
    }
  }).length;
};

const buildEvidence = (
  row: UniverseSymbolRow,
  asset: AlpacaAssetSnapshot | undefined,
  policy: UniverseLifecyclePolicy,
  now: Date
): SymbolEvidence => {
  const observationCutoff = isoDaysAgo(now, policy.evidenceLookbackDays);
  const failureCutoff = isoDaysAgo(now, policy.dataFailureLookbackDays);
  const latestSnapshot = queryOne<LatestSnapshotRow>(
    "SELECT observed_at, data_quality_status, latest_trade_price, daily_close, daily_volume, spread_pct " +
      "FROM stock_snapshots WHERE symbol = ? ORDER BY observed_at DESC, id DESC LIMIT 1",
    [row.symbol]
  );
  const latestBar = queryOne<LatestBarRow>(
    "SELECT close, volume FROM market_bars WHERE symbol = ? AND timeframe = '1Day' " +
      "ORDER BY timestamp DESC LIMIT 1",
    [row.symbol]
  );
  const historyBars = count(
    "SELECT COUNT(*) AS count FROM market_bars WHERE symbol = ? AND timeframe = '1Day'",
    [row.symbol]
  );
  const goodObservations = count(
    "SELECT COUNT(*) AS count FROM stock_snapshots WHERE symbol = ? AND observed_at >= ? " +
      "AND data_quality_status = 'COMPLETE'",
    [row.symbol, observationCutoff]
  );
  const dataFailures = count(
    "SELECT COUNT(*) AS count FROM stock_snapshots WHERE symbol = ? AND observed_at >= ? " +
      "AND data_quality_status = 'SOURCE_ERROR'",
    [row.symbol, failureCutoff]
  );
  const liquidityFailures = count(
    "SELECT COUNT(*) AS count FROM stock_snapshots WHERE symbol = ? AND observed_at >= ? " +
      "AND data_quality_status = 'COMPLETE' AND (" +
      "COALESCE(latest_trade_price, daily_close, 0) < ? OR " +
      "COALESCE(daily_volume, 0) * COALESCE(latest_trade_price, daily_close, 0) < ? OR " +
      "COALESCE(spread_pct, 999999) > ?)",
    [
      row.symbol,
      failureCutoff,
      policy.minimumPrice,
      policy.minimumDailyDollarVolume,
      policy.maximumSpreadPct
    ]
  );
  const researchSelections = count(
    "SELECT COUNT(*) AS count FROM paper_trade_candidates WHERE symbol = ? " +
      "AND decision = 'selected' AND as_of >= ?",
    [row.symbol, observationCutoff]
  );
  const executionFailures = count(
    "SELECT COUNT(*) AS count FROM paper_execution_ledger WHERE symbol = ? AND created_at >= ? " +
      "AND (LOWER(status) IN ('blocked', 'failed', 'rejected') OR blocked_reason IS NOT NULL " +
      "OR error_message IS NOT NULL)",
    [row.symbol, observationCutoff]
  );
  const documentedUnderperformance = count(
    "SELECT COUNT(*) AS count FROM paper_position_outcomes outcomes " +
      "JOIN paper_positions positions ON positions.position_lifecycle_id = outcomes.position_lifecycle_id " +
      "WHERE positions.symbol = ? AND outcomes.completeness_status = 'COMPLETE' " +
      "AND outcomes.realized_return_pct <= ?",
    [row.symbol, policy.underperformanceReturnPct]
  );
  const learningFailures = negativeLearningOutcomes(row.symbol);
  const activePositions = count(
    "SELECT COUNT(*) AS count FROM paper_positions WHERE symbol = ? AND status = 'OPEN'",
    [row.symbol]
  );
  const price = latestSnapshot?.latest_trade_price ?? latestSnapshot?.daily_close ?? latestBar?.close ?? null;
  const volume = latestSnapshot?.daily_volume ?? latestBar?.volume ?? null;
  const dailyDollarVolume = price !== null && volume !== null ? price * volume : null;
  const observationAgeHours = latestSnapshot
    ? (now.getTime() - new Date(latestSnapshot.observed_at).getTime()) / 3_600_000
    : null;
  const qualifiesForResearch =
    latestSnapshot?.data_quality_status === "COMPLETE" &&
    observationAgeHours !== null &&
    Number.isFinite(observationAgeHours) &&
    observationAgeHours >= 0 &&
    observationAgeHours <= policy.maximumObservationAgeHours &&
    goodObservations >= policy.minimumGoodObservations &&
    historyBars >= policy.minimumHistoryBars &&
    price !== null &&
    price >= policy.minimumPrice &&
    dailyDollarVolume !== null &&
    dailyDollarVolume >= policy.minimumDailyDollarVolume &&
    latestSnapshot.spread_pct !== null &&
    latestSnapshot.spread_pct <= policy.maximumSpreadPct;

  return {
    qualifiesForResearch,
    dataFailures,
    liquidityFailures,
    executionFailures,
    underperformingOutcomes: documentedUnderperformance + learningFailures,
    activePositions,
    researchSelections,
    evidence: {
      asset: asset
        ? {
            assetClass: asset.class ?? null,
            status: asset.status ?? null,
            exchange: asset.exchange ?? null,
            tradable: asset.tradable === true,
            optionsEnabled: hasOptionsAttribute(asset),
            requestId: asset.requestId ?? null
          }
        : null,
      data: {
        latestObservationAt: latestSnapshot?.observed_at ?? null,
        latestDataQualityStatus: latestSnapshot?.data_quality_status ?? null,
        observationAgeHours,
        goodObservations,
        dataFailures,
        liquidityFailures,
        historyBars,
        price,
        dailyDollarVolume,
        spreadPct: latestSnapshot?.spread_pct ?? null
      },
      researchSelections,
      executionFailures,
      documentedUnderperformance,
      learningFailures,
      activePositions
    }
  };
};

const shouldRetire = (row: UniverseSymbolRow, policy: UniverseLifecyclePolicy, now: Date) =>
  ageInDays(row.lifecycleEnteredAt, now) >= policy.suspensionRetirementDays;

const assessSymbol = (input: {
  context: LifecycleContext;
  row: UniverseSymbolRow;
  asset: AlpacaAssetSnapshot | undefined;
  policy: UniverseLifecyclePolicy;
  now: Date;
}) => {
  const occurredAt = input.now.toISOString();
  if (input.row.lifecycleState === "retired") {
    return;
  }
  if (input.asset) {
    updateAssetMetadata(input.row.symbol, input.asset, occurredAt);
  }
  const issue = assetIssue(input.asset, input.policy);
  const evidence = buildEvidence(input.row, input.asset, input.policy, input.now);
  const enrichedEvidence = {
    ...evidence.evidence,
    policy: {
      minimumPrice: input.policy.minimumPrice,
      minimumDailyDollarVolume: input.policy.minimumDailyDollarVolume,
      maximumSpreadPct: input.policy.maximumSpreadPct,
      minimumHistoryBars: input.policy.minimumHistoryBars
    },
    assetIssue: issue
  };

  if (issue) {
    if (input.row.lifecycleState === "suspended" && shouldRetire(input.row, input.policy, input.now)) {
      transitionSymbol(
        input.context,
        input.row,
        "retired",
        "SUSPENSION_RETIREMENT_THRESHOLD",
        enrichedEvidence,
        occurredAt
      );
    } else if (input.row.lifecycleState !== "suspended") {
      transitionSymbol(input.context, input.row, "suspended", issue, enrichedEvidence, occurredAt);
    }
    return;
  }
  if (input.row.lifecycleState === "suspended") {
    if (shouldRetire(input.row, input.policy, input.now)) {
      transitionSymbol(
        input.context,
        input.row,
        "retired",
        "SUSPENSION_RETIREMENT_THRESHOLD",
        enrichedEvidence,
        occurredAt
      );
    } else if (evidence.qualifiesForResearch) {
      transitionSymbol(
        input.context,
        input.row,
        "observe_only",
        "RECOVERY_REQUALIFICATION",
        enrichedEvidence,
        occurredAt
      );
    }
    return;
  }
  if (evidence.dataFailures >= input.policy.maximumDataFailures) {
    transitionSymbol(
      input.context,
      input.row,
      "suspended",
      "DATA_FAILURE_THRESHOLD",
      enrichedEvidence,
      occurredAt
    );
    return;
  }
  if (evidence.liquidityFailures >= input.policy.maximumDataFailures) {
    transitionSymbol(
      input.context,
      input.row,
      "suspended",
      "LIQUIDITY_FAILURE_THRESHOLD",
      enrichedEvidence,
      occurredAt
    );
    return;
  }
  if (evidence.executionFailures >= input.policy.maximumExecutionFailures) {
    transitionSymbol(
      input.context,
      input.row,
      "suspended",
      "EXECUTION_QUALITY_FAILURE",
      enrichedEvidence,
      occurredAt
    );
    return;
  }
  if (evidence.underperformingOutcomes >= input.policy.maximumUnderperformingOutcomes) {
    transitionSymbol(
      input.context,
      input.row,
      "suspended",
      "UNDERPERFORMANCE_THRESHOLD",
      enrichedEvidence,
      occurredAt
    );
    return;
  }
  if (evidence.activePositions > 0 && input.row.lifecycleState !== "paper_active") {
    transitionSymbol(
      input.context,
      input.row,
      "paper_active",
      "RECONCILED_PAPER_POSITION_OPEN",
      enrichedEvidence,
      occurredAt
    );
    return;
  }
  if (input.row.lifecycleState === "paper_active" && evidence.activePositions === 0) {
    transitionSymbol(
      input.context,
      input.row,
      "paper_eligible",
      "RECONCILED_PAPER_POSITION_CLOSED",
      enrichedEvidence,
      occurredAt
    );
    return;
  }
  if (input.row.lifecycleState === "discovered") {
    transitionSymbol(
      input.context,
      input.row,
      "observe_only",
      "ASSET_METADATA_ACCEPTED",
      enrichedEvidence,
      occurredAt
    );
    return;
  }
  if (input.row.lifecycleState === "observe_only" && evidence.qualifiesForResearch) {
    const changed = transitionSymbol(
      input.context,
      input.row,
      "research_eligible",
      "OBSERVATION_AND_HISTORY_QUALIFIED",
      enrichedEvidence,
      occurredAt
    );
    if (changed && evidence.researchSelections >= input.policy.requiredResearchSelections) {
      const current = getUniverseSymbol(input.row.symbol);
      if (current) {
        transitionSymbol(
          input.context,
          current,
          "paper_eligible",
          "RESEARCH_AND_QUALITY_QUALIFIED",
          enrichedEvidence,
          occurredAt
        );
      }
    }
    return;
  }
  if (
    input.row.lifecycleState === "research_eligible" &&
    evidence.qualifiesForResearch &&
    evidence.researchSelections >= input.policy.requiredResearchSelections
  ) {
    transitionSymbol(
      input.context,
      input.row,
      "paper_eligible",
      "RESEARCH_AND_QUALITY_QUALIFIED",
      enrichedEvidence,
      occurredAt
    );
  }
};

export const runAutonomousUniverseLifecycle = async (
  input: UniverseLifecycleRunInput = {}
): Promise<UniverseLifecycleRunResult> => {
  const policy = mergePolicy(input.policy);
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const gitSha = (input.getGitSha ?? defaultGitSha)();
  const configHash = policyHash(policy);
  const cursorStart = latestCursor();
  const runId = "universe_lifecycle_" + crypto.randomUUID();
  const context: LifecycleContext = {
    runId,
    gitSha,
    configVersion: policy.configVersion,
    configHash,
    eventSequence: 0,
    transitionsApplied: 0
  };
  let cursorEnd = cursorStart;
  let assetsScanned = 0;
  let assetsDiscovered = 0;
  let symbolsAssessed = 0;
  let historicalCoveragePendingSymbols: string[] = [];

  recoverIncompleteRuns(startedAt);
  createRun({
    id: runId,
    startedAt,
    cursorStart,
    gitSha,
    configVersion: policy.configVersion,
    configHash
  });

  try {
    assertReadOnlyAlpacaAccessAllowed();
    assertLiveTradingDisabled();
    await seedInitialUniverse();
    const listAssets = input.listAssets ?? listAlpacaAssets;
    const assets = await listAssets({ status: "all", assetClass: "us_equity" });
    const assetBySymbol = buildAssetMap(assets);
    const initialUniverse = getAllUniverse();
    initialUniverse.forEach((row) => recordBaseline(context, row, startedAt));

    const discovery = selectDiscoveryAssets({
      assets: [...assetBySymbol.values()],
      existingSymbols: new Set(initialUniverse.map((row) => row.symbol)),
      cursorStart,
      policy
    });
    assetsScanned = discovery.scanned.length;
    cursorEnd = discovery.cursorEnd;
    for (const asset of discovery.discovered) {
      const discovered = insertDiscoveredSymbol(context, asset, startedAt);
      if (!discovered) {
        continue;
      }
      assetsDiscovered += 1;
      transitionSymbol(
        context,
        discovered,
        "observe_only",
        "ASSET_METADATA_ACCEPTED",
        {
          assetClass: asset.class ?? null,
          status: asset.status ?? null,
          exchange: asset.exchange ?? null,
          tradable: asset.tradable === true,
          optionsEnabled: hasOptionsAttribute(asset),
          requestId: asset.requestId ?? null
        },
        startedAt
      );
    }

    const assessable = getAllUniverse()
      .filter((row) => row.lifecycleState !== "retired")
      .sort(
        (left, right) =>
          assessmentPriority[left.lifecycleState] - assessmentPriority[right.lifecycleState] ||
          left.symbol.localeCompare(right.symbol)
      )
      .slice(0, policy.assessmentMaxSymbols);
    historicalCoveragePendingSymbols = assessable
      .filter((row) => row.lifecycleState === "observe_only")
      .filter((row) => assetIssue(assetBySymbol.get(row.symbol), policy) === null)
      .filter(
        (row) =>
          count(
            "SELECT COUNT(*) AS count FROM market_bars WHERE symbol = ? AND timeframe = '1Day'",
            [row.symbol]
          ) < policy.minimumHistoryBars
      )
      .map((row) => row.symbol);

    for (const row of assessable) {
      assessSymbol({
        context,
        row: getUniverseSymbol(row.symbol) ?? row,
        asset: assetBySymbol.get(row.symbol),
        policy,
        now: now()
      });
      symbolsAssessed += 1;
    }

    const completedAt = now().toISOString();
    const counts = stateCounts();
    finishRun({
      runId,
      status: "completed",
      completedAt,
      cursorEnd,
      assetsScanned,
      assetsDiscovered,
      symbolsAssessed,
      transitionsApplied: context.transitionsApplied
    });
    return {
      runId,
      status: "completed",
      startedAt,
      completedAt,
      paperOnly: true,
      nonBrokerMutating: true,
      discovery: {
        cursorStart,
        cursorEnd,
        scanned: assetsScanned,
        discovered: assetsDiscovered
      },
      symbolsAssessed,
      historicalCoveragePendingSymbols,
      transitionsApplied: context.transitionsApplied,
      stateCounts: counts,
      gitSha,
      configVersion: policy.configVersion,
      configHash
    };
  } catch (error) {
    finishRun({
      runId,
      status: "failed",
      completedAt: now().toISOString(),
      cursorEnd,
      assetsScanned,
      assetsDiscovered,
      symbolsAssessed,
      transitionsApplied: context.transitionsApplied,
      errorSummary: safeError(error)
    });
    throw error;
  }
};

export const getUniverseLifecycleStatus = (): UniverseLifecycleStatus => {
  const latestRun =
    queryOne<Record<string, unknown>>(
      "SELECT * FROM universe_lifecycle_runs ORDER BY started_at DESC, id DESC LIMIT 1"
    ) ?? null;
  return { latestRun, stateCounts: stateCounts() };
};
