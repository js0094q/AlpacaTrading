import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { canonicalizeJson, canonicalJsonHash } from "../lib/canonicalJson.js";
import { getDb, queryOne } from "../lib/db.js";
import type {
  DecisionId,
  DecisionRole,
  DecisionStatus,
  PositionLifecycleId
} from "../types.js";
import { createDecisionId } from "./marketDecisionIdentityService.js";

const canonicalJson = (value: unknown) => JSON.stringify(canonicalizeJson(value));

const pathValue = (value: unknown, path: string): unknown => {
  let current = value;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

export const hashAllowlistedConfig = (
  value: unknown,
  allowlistedPaths: readonly string[]
) => {
  const selected: Record<string, unknown> = {};
  for (const path of [...new Set(allowlistedPaths)].sort()) {
    const allowedValue = pathValue(value, path);
    if (allowedValue !== undefined) {
      selected[path] = allowedValue;
    }
  }
  return canonicalJsonHash(selected);
};

const currentGitSha = () => {
  const configured = process.env.GIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA;
  if (configured?.trim()) {
    return configured.trim();
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
};

export interface DecisionSnapshot {
  decisionId: DecisionId;
  originType: string;
  originId: string;
  decisionRole: DecisionRole;
  candidateId: string | null;
  positionLifecycleId: PositionLifecycleId | null;
  createdAt: string;
  decisionStatus: DecisionStatus;
}

interface SnapshotRow {
  decision_id: DecisionId;
  origin_type: string;
  origin_id: string;
  decision_role: DecisionRole;
  candidate_id: string | null;
  position_lifecycle_id: PositionLifecycleId | null;
  created_at: string;
  decision_status: DecisionStatus;
}

const mapSnapshot = (row: SnapshotRow): DecisionSnapshot => ({
  decisionId: row.decision_id,
  originType: row.origin_type,
  originId: row.origin_id,
  decisionRole: row.decision_role,
  candidateId: row.candidate_id,
  positionLifecycleId: row.position_lifecycle_id,
  createdAt: row.created_at,
  decisionStatus: row.decision_status
});

export const persistDecisionSnapshot = (input: {
  decisionId?: DecisionId;
  originType: string;
  originId: string;
  decisionRole: DecisionRole;
  candidateId?: string | null;
  positionLifecycleId?: PositionLifecycleId | null;
  createdAt?: string;
  strategyFamily?: string | null;
  symbol?: string | null;
  underlyingSymbol?: string | null;
  optionSymbol?: string | null;
  researchRunId?: string | null;
  candidateRank?: number | null;
  candidateStatus?: string | null;
  decisionStatus: DecisionStatus;
  score?: number | null;
  confidence?: number | null;
  reasonCodes: readonly string[];
  rationale?: unknown;
  signalInputs?: unknown;
  marketState?: unknown;
  instrumentState?: unknown;
  portfolioState?: unknown;
  riskState?: unknown;
  dataQualityStatus: string;
  sourceTimestamps: Record<string, string | null>;
  environment: "paper" | "live";
  gitSha?: string | null;
  configAllowlistVersion: string;
  strategyConfigHash?: string | null;
  riskConfigHash?: string | null;
  brokerRequestId?: string | null;
  marketDataRequestId?: string | null;
  feed?: string | null;
}): DecisionSnapshot => {
  const existing = queryOne<SnapshotRow>(
    `
    SELECT decision_id, origin_type, origin_id, decision_role, candidate_id,
           position_lifecycle_id, created_at, decision_status
    FROM decision_snapshots
    WHERE origin_type = ? AND origin_id = ? AND decision_role = ?
    LIMIT 1
    `,
    [input.originType, input.originId, input.decisionRole]
  );
  if (existing) {
    if (input.decisionId && input.decisionId !== existing.decision_id) {
      throw new Error("DECISION_ORIGIN_ID_MISMATCH");
    }
    return mapSnapshot(existing);
  }

  const decisionId = input.decisionId ?? createDecisionId();
  const createdAt = input.createdAt ?? new Date().toISOString();
  getDb().prepare(`
    INSERT INTO decision_snapshots(
      decision_id, origin_type, origin_id, decision_role, candidate_id,
      position_lifecycle_id, created_at, strategy_family, symbol,
      underlying_symbol, option_symbol, research_run_id, candidate_rank,
      candidate_status, decision_status, score, confidence, reason_codes_json,
      rationale, signal_inputs_json, market_state_json, instrument_state_json,
      portfolio_state_json, risk_state_json, data_quality_status,
      source_timestamps_json, environment, git_sha, config_allowlist_version,
      strategy_config_hash, risk_config_hash, broker_request_id,
      market_data_request_id, feed
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    decisionId,
    input.originType,
    input.originId,
    input.decisionRole,
    input.candidateId ?? null,
    input.positionLifecycleId ?? null,
    createdAt,
    input.strategyFamily ?? null,
    input.symbol ?? null,
    input.underlyingSymbol ?? null,
    input.optionSymbol ?? null,
    input.researchRunId ?? null,
    input.candidateRank ?? null,
    input.candidateStatus ?? null,
    input.decisionStatus,
    input.score ?? null,
    input.confidence ?? null,
    canonicalJson([...input.reasonCodes]),
    input.rationale === undefined ? null : canonicalJson(input.rationale),
    canonicalJson(input.signalInputs ?? {}),
    input.marketState === undefined ? null : canonicalJson(input.marketState),
    input.instrumentState === undefined ? null : canonicalJson(input.instrumentState),
    input.portfolioState === undefined ? null : canonicalJson(input.portfolioState),
    input.riskState === undefined ? null : canonicalJson(input.riskState),
    input.dataQualityStatus,
    canonicalJson(input.sourceTimestamps),
    input.environment,
    input.gitSha === undefined ? currentGitSha() : input.gitSha,
    input.configAllowlistVersion,
    input.strategyConfigHash ?? null,
    input.riskConfigHash ?? null,
    input.brokerRequestId ?? null,
    input.marketDataRequestId ?? null,
    input.feed ?? null
  );

  return {
    decisionId,
    originType: input.originType,
    originId: input.originId,
    decisionRole: input.decisionRole,
    candidateId: input.candidateId ?? null,
    positionLifecycleId: input.positionLifecycleId ?? null,
    createdAt,
    decisionStatus: input.decisionStatus
  };
};

export const appendDecisionLifecycleEvent = (input: {
  decisionId: DecisionId;
  status: DecisionStatus;
  reasonCodes: readonly string[];
  occurredAt?: string;
  sourceType: string;
  sourceId: string;
  evidence?: unknown;
}) => {
  const existing = queryOne<{
    event_id: string;
    occurred_at: string;
    status: DecisionStatus;
  }>(
    `
    SELECT event_id, occurred_at, status
    FROM decision_lifecycle_events
    WHERE decision_id = ? AND status = ? AND source_type = ? AND source_id = ?
    LIMIT 1
    `,
    [input.decisionId, input.status, input.sourceType, input.sourceId]
  );
  if (existing) {
    return {
      eventId: existing.event_id,
      decisionId: input.decisionId,
      status: existing.status,
      occurredAt: existing.occurred_at
    };
  }
  const eventId = randomUUID();
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  getDb().prepare(`
    INSERT INTO decision_lifecycle_events(
      event_id, decision_id, status, reason_codes_json, occurred_at,
      source_type, source_id, evidence_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    input.decisionId,
    input.status,
    canonicalJson([...input.reasonCodes]),
    occurredAt,
    input.sourceType,
    input.sourceId,
    canonicalJson(input.evidence ?? {})
  );
  return { eventId, decisionId: input.decisionId, status: input.status, occurredAt };
};

export const linkPaperReviewDecision = (input: {
  artifactId: string;
  section: string;
  payloadIndex: number;
  decisionId: DecisionId;
  decisionRole: DecisionRole;
}) => {
  getDb().prepare(`
    INSERT OR IGNORE INTO paper_review_decisions(
      artifact_id, section, payload_index, decision_id, decision_role
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    input.artifactId,
    input.section,
    input.payloadIndex,
    input.decisionId,
    input.decisionRole
  );
};
