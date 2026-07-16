import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { getDb, queryAll, queryOne } from "../lib/db.js";
import { assertScheduledWriteFenceActive } from "./controlPlaneRuntimeContext.js";

export type PaperLearningGovernanceState = "observe" | "prioritized" | "suspended";
export type PaperLearningGovernanceScope = "strategy_family" | "symbol";

interface ScopePolicy {
  minEvaluatedTrades: number;
  minObservedDays: number;
  prioritizeProfitFactor: number;
  suspendProfitFactor: number;
  priorityMultiplier: number;
}

export interface PaperLearningGovernancePolicy {
  configVersion: string;
  maxRecordsPerStrategy: number;
  maxSymbolScopes: number;
  strategyPolicies: Record<string, ScopePolicy>;
  symbolPolicy: ScopePolicy;
}

const policy: PaperLearningGovernancePolicy = {
  configVersion: "paper-learning-governance-v1",
  maxRecordsPerStrategy: 250,
  maxSymbolScopes: 100,
  strategyPolicies: {
    equity: {
      minEvaluatedTrades: 50,
      minObservedDays: 20,
      prioritizeProfitFactor: 1.05,
      suspendProfitFactor: 0.8,
      priorityMultiplier: 1.12
    },
    standard_option: {
      minEvaluatedTrades: 50,
      minObservedDays: 20,
      prioritizeProfitFactor: 1.05,
      suspendProfitFactor: 0.8,
      priorityMultiplier: 1.12
    },
    zero_dte_spy: {
      minEvaluatedTrades: 100,
      minObservedDays: 20,
      prioritizeProfitFactor: 1.05,
      suspendProfitFactor: 0.8,
      priorityMultiplier: 1.12
    },
    leaps: {
      minEvaluatedTrades: 25,
      minObservedDays: 30,
      prioritizeProfitFactor: 1.05,
      suspendProfitFactor: 0.8,
      priorityMultiplier: 1.12
    }
  },
  symbolPolicy: {
    minEvaluatedTrades: 50,
    minObservedDays: 20,
    prioritizeProfitFactor: 1.05,
    suspendProfitFactor: 0.8,
    priorityMultiplier: 1.08
  }
};

interface LearningRecordRow {
  strategy_family: string;
  symbol: string;
  created_at: string;
  outcome_json: string | null;
}

interface ScannedLearningRecord extends LearningRecordRow {
  pnlLiveLike: number | null;
}

interface EvidenceMetrics {
  scannedRecords: number;
  evaluatedTrades: number;
  invalidOutcomeRecords: number;
  observedTradingDays: number;
  grossProfitLiveLike: number;
  grossLossLiveLike: number;
  netPnlLiveLike: number;
  profitFactorLiveLike: number;
  maxDrawdownLiveLike: number;
  latestRecordAt: string | null;
}

interface DesiredDecision {
  scopeType: PaperLearningGovernanceScope;
  scopeKey: string;
  state: PaperLearningGovernanceState;
  priorityMultiplier: number;
  reasonCode: string;
  evidence: Record<string, unknown>;
}

export interface CurrentPaperLearningGovernanceDecision {
  id: string;
  runId: string;
  scopeType: PaperLearningGovernanceScope;
  scopeKey: string;
  state: PaperLearningGovernanceState;
  priorityMultiplier: number;
  reasonCode: string;
  evidence: Record<string, unknown>;
  effectiveAt: string;
  gitSha: string;
  configVersion: string;
  configHash: string;
}

export interface PaperLearningGovernanceRunResult {
  paperOnly: true;
  nonBrokerMutating: true;
  runId: string;
  startedAt: string;
  completedAt: string;
  status: "completed";
  scannedRecords: number;
  validOutcomes: number;
  decisionsWritten: number;
  stateCounts: Record<PaperLearningGovernanceState, number>;
  currentDecisions: CurrentPaperLearningGovernanceDecision[];
  gitSha: string;
  configVersion: string;
  configHash: string;
}

export interface CandidateLearningGovernance {
  suspended: boolean;
  priorityMultiplier: number;
  reasonCodes: string[];
  rationale: string[];
}

const round = (value: number) => Math.round(value * 10_000) / 10_000;

const defaultGitSha = () => {
  const configured =
    process.env.GIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || process.env.SOURCE_VERSION;
  if (configured?.trim()) {
    return configured.trim();
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
};

const policyHash = () =>
  createHash("sha256").update(JSON.stringify(policy)).digest("hex");

const normalizeStrategyFamily = (value: string) => value.trim().toLowerCase();

const normalizeSymbol = (value: string) => value.trim().toUpperCase();

const parseLiveLikePnl = (outcomeJson: string | null) => {
  if (!outcomeJson) {
    return null;
  }
  try {
    const outcome = JSON.parse(outcomeJson) as { pnlLiveLike?: unknown };
    return typeof outcome.pnlLiveLike === "number" && Number.isFinite(outcome.pnlLiveLike)
      ? outcome.pnlLiveLike
      : null;
  } catch {
    return null;
  }
};

const scanEvaluatedLearningRecords = () => {
  const records: ScannedLearningRecord[] = [];
  for (const strategyFamily of Object.keys(policy.strategyPolicies)) {
    const rows = queryAll<LearningRecordRow>(`
      SELECT strategy_family, symbol, created_at, outcome_json
      FROM paper_learning_records
      WHERE learning_status = 'evaluated'
        AND strategy_family = ?
      ORDER BY created_at DESC
      LIMIT ?
    `, [strategyFamily, policy.maxRecordsPerStrategy]);
    for (const row of rows) {
      records.push({
        ...row,
        strategy_family: normalizeStrategyFamily(row.strategy_family),
        symbol: normalizeSymbol(row.symbol),
        pnlLiveLike: parseLiveLikePnl(row.outcome_json)
      });
    }
  }
  return records;
};

const evidenceMetrics = (records: ScannedLearningRecord[]): EvidenceMetrics => {
  const valid = records
    .filter((record): record is ScannedLearningRecord & { pnlLiveLike: number } => record.pnlLiveLike !== null)
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
  const grossProfitLiveLike = valid.reduce(
    (total, record) => total + Math.max(record.pnlLiveLike, 0),
    0
  );
  const grossLossLiveLike = valid.reduce(
    (total, record) => total + Math.abs(Math.min(record.pnlLiveLike, 0)),
    0
  );
  const netPnlLiveLike = valid.reduce((total, record) => total + record.pnlLiveLike, 0);
  let runningPnl = 0;
  let peakPnl = 0;
  let maxDrawdownLiveLike = 0;
  for (const record of valid) {
    runningPnl += record.pnlLiveLike;
    peakPnl = Math.max(peakPnl, runningPnl);
    maxDrawdownLiveLike = Math.min(maxDrawdownLiveLike, runningPnl - peakPnl);
  }
  return {
    scannedRecords: records.length,
    evaluatedTrades: valid.length,
    invalidOutcomeRecords: records.length - valid.length,
    observedTradingDays: new Set(valid.map((record) => record.created_at.slice(0, 10))).size,
    grossProfitLiveLike: round(grossProfitLiveLike),
    grossLossLiveLike: round(grossLossLiveLike),
    netPnlLiveLike: round(netPnlLiveLike),
    profitFactorLiveLike:
      grossLossLiveLike > 0
        ? grossProfitLiveLike / grossLossLiveLike
        : grossProfitLiveLike > 0
          ? Number.POSITIVE_INFINITY
          : 0,
    maxDrawdownLiveLike: round(maxDrawdownLiveLike),
    latestRecordAt: records[0]?.created_at ?? null
  };
};

const decideScope = (input: {
  scopeType: PaperLearningGovernanceScope;
  scopeKey: string;
  records: ScannedLearningRecord[];
  scopePolicy: ScopePolicy;
}) => {
  const metrics = evidenceMetrics(input.records);
  const sufficientEvidence =
    metrics.evaluatedTrades >= input.scopePolicy.minEvaluatedTrades &&
    metrics.observedTradingDays >= input.scopePolicy.minObservedDays;
  let state: PaperLearningGovernanceState = "observe";
  let priorityMultiplier = 1;
  let reasonCode = "INSUFFICIENT_EVALUATED_LIVE_LIKE_EVIDENCE";

  if (sufficientEvidence) {
    if (
      metrics.netPnlLiveLike < 0 &&
      metrics.profitFactorLiveLike <= input.scopePolicy.suspendProfitFactor
    ) {
      state = "suspended";
      priorityMultiplier = 0;
      reasonCode = "NEGATIVE_LIVE_LIKE_PERFORMANCE";
    } else if (
      metrics.netPnlLiveLike > 0 &&
      metrics.profitFactorLiveLike >= input.scopePolicy.prioritizeProfitFactor
    ) {
      state = "prioritized";
      priorityMultiplier = input.scopePolicy.priorityMultiplier;
      reasonCode = "POSITIVE_LIVE_LIKE_PERFORMANCE";
    } else {
      reasonCode = "MIXED_LIVE_LIKE_PERFORMANCE";
    }
  }

  return {
    scopeType: input.scopeType,
    scopeKey: input.scopeKey,
    state,
    priorityMultiplier,
    reasonCode,
    evidence: {
      source: "paper_learning_records",
      boundedRecordLimit:
        input.scopeType === "strategy_family"
          ? policy.maxRecordsPerStrategy
          : policy.maxRecordsPerStrategy * Object.keys(policy.strategyPolicies).length,
      ...metrics,
      profitFactorLiveLike: Number.isFinite(metrics.profitFactorLiveLike)
        ? round(metrics.profitFactorLiveLike)
        : null,
      allLiveLikeOutcomesProfitable:
        metrics.grossProfitLiveLike > 0 && metrics.grossLossLiveLike === 0,
      policy: input.scopePolicy
    }
  } satisfies DesiredDecision;
};

const desiredDecisions = (records: ScannedLearningRecord[]) => {
  const decisions: DesiredDecision[] = [];
  for (const [strategyFamily, scopePolicy] of Object.entries(policy.strategyPolicies)) {
    decisions.push(
      decideScope({
        scopeType: "strategy_family",
        scopeKey: strategyFamily,
        records: records.filter((record) => record.strategy_family === strategyFamily),
        scopePolicy
      })
    );
  }

  const bySymbol = new Map<string, ScannedLearningRecord[]>();
  for (const record of records) {
    const bucket = bySymbol.get(record.symbol) ?? [];
    bucket.push(record);
    bySymbol.set(record.symbol, bucket);
  }
  const selectedSymbols = [...bySymbol.entries()]
    .sort((left, right) => {
      const leftLatest = left[1][0]?.created_at ?? "";
      const rightLatest = right[1][0]?.created_at ?? "";
      return rightLatest.localeCompare(leftLatest) || left[0].localeCompare(right[0]);
    })
    .slice(0, policy.maxSymbolScopes);
  for (const [symbol, symbolRecords] of selectedSymbols) {
    decisions.push(
      decideScope({
        scopeType: "symbol",
        scopeKey: symbol,
        records: symbolRecords,
        scopePolicy: policy.symbolPolicy
      })
    );
  }
  return decisions;
};

const parseEvidence = (value: string) => {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

export const getCurrentPaperLearningGovernance = (): CurrentPaperLearningGovernanceDecision[] =>
  queryAll<{
    id: string;
    run_id: string;
    scope_type: PaperLearningGovernanceScope;
    scope_key: string;
    state: PaperLearningGovernanceState;
    priority_multiplier: number;
    reason_code: string;
    evidence_json: string;
    effective_at: string;
    git_sha: string;
    config_version: string;
    config_hash: string;
  }>(`
    SELECT id, run_id, scope_type, scope_key, state, priority_multiplier, reason_code,
           evidence_json, effective_at, git_sha, config_version, config_hash
    FROM paper_learning_governance_decisions
    WHERE superseded_at IS NULL
    ORDER BY scope_type, scope_key
  `).map((row) => ({
    id: row.id,
    runId: row.run_id,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    state: row.state,
    priorityMultiplier: Number(row.priority_multiplier),
    reasonCode: row.reason_code,
    evidence: parseEvidence(row.evidence_json),
    effectiveAt: row.effective_at,
    gitSha: row.git_sha,
    configVersion: row.config_version,
    configHash: row.config_hash
  }));

export const resolveCandidateLearningGovernance = (
  input: { symbol: string; strategyFamily: string },
  decisions: CurrentPaperLearningGovernanceDecision[] = getCurrentPaperLearningGovernance()
): CandidateLearningGovernance => {
  const strategyFamily = normalizeStrategyFamily(input.strategyFamily);
  const symbol = normalizeSymbol(input.symbol);
  const relevant = decisions.filter(
    (decision) =>
      (decision.scopeType === "strategy_family" && decision.scopeKey === strategyFamily) ||
      (decision.scopeType === "symbol" && decision.scopeKey === symbol)
  );
  const suspended = relevant.some((decision) => decision.state === "suspended");
  const priorityMultiplier = suspended
    ? 0
    : Math.min(
        1.25,
        relevant.reduce(
          (multiplier, decision) => multiplier * decision.priorityMultiplier,
          1
        )
      );
  const nonObserve = relevant.filter((decision) => decision.state !== "observe");
  return {
    suspended,
    priorityMultiplier,
    reasonCodes: nonObserve.map((decision) => decision.reasonCode),
    rationale: nonObserve.map((decision) =>
      decision.state === "suspended"
        ? `Learning governance suspended ${decision.scopeType}:${decision.scopeKey} (${decision.reasonCode}).`
        : `Learning governance prioritized ${decision.scopeType}:${decision.scopeKey} by ${decision.priorityMultiplier.toFixed(2)} (${decision.reasonCode}).`
    )
  };
};

export const applyPaperLearningGovernance = (input: {
  now?: () => Date;
  getGitSha?: () => string;
} = {}): PaperLearningGovernanceRunResult => {
  assertScheduledWriteFenceActive();
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const runId = `paper_learning_governance_${crypto.randomUUID()}`;
  const gitSha = (input.getGitSha ?? defaultGitSha)();
  const configHash = policyHash();
  const db = getDb();
  db.prepare(`
    INSERT INTO paper_learning_governance_runs(
      id, started_at, status, scanned_records, valid_outcomes, decisions_written,
      git_sha, config_version, config_hash, summary_json, error_message
    ) VALUES (?, ?, 'running', 0, 0, 0, ?, ?, ?, NULL, NULL)
  `).run(runId, startedAt, gitSha, policy.configVersion, configHash);

  let transactionOpen = false;
  try {
    const scanned = scanEvaluatedLearningRecords();
    const desired = desiredDecisions(scanned);
    const currentByScope = new Map(
      getCurrentPaperLearningGovernance().map((decision) => [
        `${decision.scopeType}:${decision.scopeKey}`,
        decision
      ])
    );
    const completedAt = now().toISOString();
    const stateCounts: Record<PaperLearningGovernanceState, number> = {
      observe: 0,
      prioritized: 0,
      suspended: 0
    };
    desired.forEach((decision) => {
      stateCounts[decision.state] += 1;
    });

    db.exec("BEGIN IMMEDIATE;");
    transactionOpen = true;
    let decisionsWritten = 0;
    for (const decision of desired) {
      const key = `${decision.scopeType}:${decision.scopeKey}`;
      const current = currentByScope.get(key);
      const changed =
        !current ||
        current.state !== decision.state ||
        current.priorityMultiplier !== decision.priorityMultiplier ||
        current.reasonCode !== decision.reasonCode;
      if (!changed) {
        continue;
      }
      db.prepare(`
        UPDATE paper_learning_governance_decisions
        SET superseded_at = ?
        WHERE scope_type = ? AND scope_key = ? AND superseded_at IS NULL
      `).run(completedAt, decision.scopeType, decision.scopeKey);
      db.prepare(`
        INSERT INTO paper_learning_governance_decisions(
          id, run_id, scope_type, scope_key, state, priority_multiplier, reason_code,
          evidence_json, effective_at, superseded_at, git_sha, config_version, config_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        runId,
        decision.scopeType,
        decision.scopeKey,
        decision.state,
        decision.priorityMultiplier,
        decision.reasonCode,
        JSON.stringify(decision.evidence),
        completedAt,
        gitSha,
        policy.configVersion,
        configHash
      );
      decisionsWritten += 1;
    }
    const validOutcomes = scanned.filter((record) => record.pnlLiveLike !== null).length;
    db.prepare(`
      UPDATE paper_learning_governance_runs
      SET completed_at = ?, status = 'completed', scanned_records = ?, valid_outcomes = ?,
          decisions_written = ?, summary_json = ?
      WHERE id = ?
    `).run(
      completedAt,
      scanned.length,
      validOutcomes,
      decisionsWritten,
      JSON.stringify({
        stateCounts,
        desiredDecisions: desired.map((decision) => ({
          scopeType: decision.scopeType,
          scopeKey: decision.scopeKey,
          state: decision.state,
          reasonCode: decision.reasonCode
        }))
      }),
      runId
    );
    assertScheduledWriteFenceActive();
    db.exec("COMMIT;");
    transactionOpen = false;
    return {
      paperOnly: true,
      nonBrokerMutating: true,
      runId,
      startedAt,
      completedAt,
      status: "completed",
      scannedRecords: scanned.length,
      validOutcomes,
      decisionsWritten,
      stateCounts,
      currentDecisions: getCurrentPaperLearningGovernance(),
      gitSha,
      configVersion: policy.configVersion,
      configHash
    };
  } catch (error) {
    if (transactionOpen) {
      db.exec("ROLLBACK;");
    }
    const message = error instanceof Error ? error.message : "Paper learning governance failed.";
    try {
      assertScheduledWriteFenceActive();
      db.prepare(`
        UPDATE paper_learning_governance_runs
        SET completed_at = ?, status = 'failed', error_message = ?
        WHERE id = ?
      `).run(now().toISOString(), message.slice(0, 500), runId);
    } catch {
      // A stale worker must not write even its terminal status.
    }
    throw error;
  }
};

export const getPaperLearningGovernanceStatus = () => {
  const latestRun = queryOne<{
    id: string;
    started_at: string;
    completed_at: string | null;
    status: string;
    scanned_records: number;
    valid_outcomes: number;
    decisions_written: number;
    git_sha: string;
    config_version: string;
    config_hash: string;
    summary_json: string | null;
    error_message: string | null;
  }>(`
    SELECT id, started_at, completed_at, status, scanned_records, valid_outcomes,
           decisions_written, git_sha, config_version, config_hash, summary_json, error_message
    FROM paper_learning_governance_runs
    ORDER BY started_at DESC
    LIMIT 1
  `);
  return {
    paperOnly: true as const,
    nonBrokerMutating: true as const,
    policy: {
      configVersion: policy.configVersion,
      configHash: policyHash()
    },
    latestRun: latestRun
      ? {
          id: latestRun.id,
          startedAt: latestRun.started_at,
          completedAt: latestRun.completed_at,
          status: latestRun.status,
          scannedRecords: latestRun.scanned_records,
          validOutcomes: latestRun.valid_outcomes,
          decisionsWritten: latestRun.decisions_written,
          gitSha: latestRun.git_sha,
          configVersion: latestRun.config_version,
          configHash: latestRun.config_hash,
          summary: latestRun.summary_json ? parseEvidence(latestRun.summary_json) : null,
          errorMessage: latestRun.error_message
        }
      : null,
    currentDecisions: getCurrentPaperLearningGovernance()
  };
};
