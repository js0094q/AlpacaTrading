import type { DatabaseSync } from "node:sqlite";

import { getDb } from "../../lib/db.js";
import { redactSensitiveText } from "../../lib/securityRedaction.js";
import { nowIso, uuid } from "../../lib/utils.js";
import { buildZeroDteDecisionId } from "./zeroDteIdentityService.js";
import type { ZeroDteDirection, ZeroDtePlaybook } from "./zeroDteTypes.js";

export const ZERO_DTE_LIFECYCLE_EVENT_TYPES = [
  "candidate_discovered",
  "candidate_observed",
  "candidate_strengthened",
  "candidate_weakened",
  "candidate_reappeared",
  "candidate_became_eligible",
  "candidate_selected",
  "candidate_skipped",
  "candidate_rejected",
  "candidate_expired",
  "candidate_invalidated",
  "paper_order_requested",
  "paper_order_accepted",
  "paper_order_rejected",
  "paper_order_filled",
  "paper_order_partially_filled",
  "paper_order_canceled",
  "position_opened",
  "position_marked",
  "exit_triggered",
  "exit_order_requested",
  "position_closed",
  "shadow_opened",
  "shadow_marked",
  "shadow_closed",
  "terminal_outcome_recorded"
] as const;

export type ZeroDteLifecycleEventType =
  (typeof ZERO_DTE_LIFECYCLE_EVENT_TYPES)[number];

export type ZeroDteAccountMode = "paper" | "shadow" | "dry_run" | "test";

export interface ZeroDteLifecycleContext {
  engineRunId?: string | null;
  accountMode: string;
  strategyVersion: string;
  configurationVersionId: string;
  marketTimestamp?: string | null;
  occurredAt?: string;
  decisionId?: string | null;
  decisionGroupId?: string | null;
  paperTradeId?: string | null;
  shadowTradeId?: string | null;
  details?: unknown;
}

export interface ZeroDteDecisionInput {
  decisionId?: string;
  decisionGroupId: string;
  engineRunId: string;
  candidateId: string;
  tradingDate: string;
  action: string;
  accountMode: string;
  strategyVersion: string;
  configurationVersionId: string;
  marketTimestamp?: string | null;
  decidedAt?: string;
  score?: number | null;
  scoreThreshold?: number | null;
  appliedThresholds?: unknown;
  reasonCodes?: string[];
  evidence?: unknown;
  clientOrderId?: string | null;
  createdAt?: string;
}

export interface ZeroDteDecision {
  decisionId: string;
  decisionGroupId: string;
  engineRunId: string;
  candidateId: string;
  tradingDate: string;
  action: string;
  accountMode: string;
  strategyVersion: string;
  configurationVersionId: string;
  marketTimestamp: string | null;
  decidedAt: string;
  score: number | null;
  scoreThreshold: number | null;
  appliedThresholds: Record<string, unknown>;
  reasonCodes: string[];
  evidence: Record<string, unknown>;
  clientOrderId: string | null;
  createdAt: string;
}

export interface ZeroDteLifecycleEventInput {
  eventId?: string;
  eventType: ZeroDteLifecycleEventType;
  reasonCode?: string | null;
  engineRunId?: string | null;
  candidateId?: string | null;
  decisionId?: string | null;
  decisionGroupId?: string | null;
  paperTradeId?: string | null;
  shadowTradeId?: string | null;
  accountMode: string;
  strategyVersion: string;
  configurationVersionId: string;
  marketTimestamp?: string | null;
  occurredAt?: string;
  details?: unknown;
  createdAt?: string;
}

export interface ZeroDteLifecycleEvent {
  eventId: string;
  eventType: ZeroDteLifecycleEventType;
  reasonCode: string | null;
  engineRunId: string | null;
  candidateId: string | null;
  decisionId: string | null;
  decisionGroupId: string | null;
  paperTradeId: string | null;
  shadowTradeId: string | null;
  accountMode: string;
  strategyVersion: string;
  configurationVersionId: string;
  marketTimestamp: string | null;
  occurredAt: string;
  details: Record<string, unknown>;
  createdAt: string;
}

const MAX_JSON_DEPTH = 6;
const MAX_JSON_ITEMS = 100;
const MAX_JSON_STRING_LENGTH = 4_000;
const MAX_JSON_LENGTH = 100_000;
const SENSITIVE_KEY = /(api[_-]?key|secret|token|authorization|password|private[_-]?key|credential|raw[_-]?payload|access[_-]?key|headers?)/i;

const requiredText = (value: string | null | undefined, field: string) => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`0DTE ${field} is required`);
  }
  return value.trim();
};

const optionalText = (value: string | null | undefined) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const isoTimestamp = (value: string | null | undefined, field: string) => {
  const candidate = value ?? nowIso();
  const parsed = Date.parse(candidate);
  if (!Number.isFinite(parsed)) {
    throw new RangeError(`0DTE ${field} must be a valid timestamp`);
  }
  return new Date(parsed).toISOString();
};

const optionalIsoTimestamp = (value: string | null | undefined, field: string) =>
  value === null || value === undefined ? null : isoTimestamp(value, field);

const assertPaperOnlyAccountMode = (value: string) => {
  const mode = requiredText(value, "account mode").toLowerCase();
  if (mode.includes("live") || mode === "production" || mode === "prod") {
    throw new Error(
      "ZERO_DTE_PAPER_ONLY_ACCOUNT_MODE_REQUIRED: live account mode is forbidden"
    );
  }
  return mode;
};

const sanitizeJsonValue = (
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>()
): unknown => {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return typeof value === "number" && !Number.isFinite(value) ? null : value;
  }
  if (typeof value === "string") {
    return redactSensitiveText(value).slice(0, MAX_JSON_STRING_LENGTH);
  }
  if (depth >= MAX_JSON_DEPTH) return "[TRUNCATED]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_JSON_ITEMS)
      .map((entry) => sanitizeJsonValue(entry, depth + 1, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (entry === undefined) continue;
    output[key] = sanitizeJsonValue(entry, depth + 1, seen);
    if (Object.keys(output).length >= MAX_JSON_ITEMS) break;
  }
  return output;
};

export const serializeZeroDteJson = (value: unknown, fallback = "{}") => {
  const sanitized = sanitizeJsonValue(value ?? {}, 0);
  const serialized = JSON.stringify(sanitized);
  if (!serialized || serialized.length > MAX_JSON_LENGTH) return fallback;
  return serialized;
};

const parseJson = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const withTransaction = <T>(db: DatabaseSync, operation: () => T): T => {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = operation();
    db.exec("COMMIT;");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the original persistence error.
    }
    throw error;
  }
};

const rowToDecision = (row: Record<string, unknown>): ZeroDteDecision => ({
  decisionId: String(row.decision_id),
  decisionGroupId: String(row.decision_group_id),
  engineRunId: String(row.engine_run_id),
  candidateId: String(row.candidate_id),
  tradingDate: String(row.trading_date),
  action: String(row.action),
  accountMode: String(row.account_mode),
  strategyVersion: String(row.strategy_version),
  configurationVersionId: String(row.configuration_version_id),
  marketTimestamp: row.market_timestamp === null ? null : String(row.market_timestamp),
  decidedAt: String(row.decided_at),
  score: typeof row.score === "number" ? row.score : null,
  scoreThreshold: typeof row.score_threshold === "number" ? row.score_threshold : null,
  appliedThresholds: asRecord(parseJson(row.applied_thresholds_json as string | null, {})),
  reasonCodes: asStringArray(parseJson(row.reason_codes_json as string | null, [])),
  evidence: asRecord(parseJson(row.evidence_json as string | null, {})),
  clientOrderId: row.client_order_id === null ? null : String(row.client_order_id),
  createdAt: String(row.created_at)
});

const rowToLifecycleEvent = (row: Record<string, unknown>): ZeroDteLifecycleEvent => ({
  eventId: String(row.event_id),
  eventType: String(row.event_type) as ZeroDteLifecycleEventType,
  reasonCode: row.reason_code === null ? null : String(row.reason_code),
  engineRunId: row.engine_run_id === null ? null : String(row.engine_run_id),
  candidateId: row.candidate_id === null ? null : String(row.candidate_id),
  decisionId: row.decision_id === null ? null : String(row.decision_id),
  decisionGroupId: row.decision_group_id === null ? null : String(row.decision_group_id),
  paperTradeId: row.paper_trade_id === null ? null : String(row.paper_trade_id),
  shadowTradeId: row.shadow_trade_id === null ? null : String(row.shadow_trade_id),
  accountMode: String(row.account_mode),
  strategyVersion: String(row.strategy_version),
  configurationVersionId: String(row.configuration_version_id),
  marketTimestamp: row.market_timestamp === null ? null : String(row.market_timestamp),
  occurredAt: String(row.occurred_at),
  details: asRecord(parseJson(row.details_json as string | null, {})),
  createdAt: String(row.created_at)
});

export const insertZeroDteDecisionRow = (
  db: DatabaseSync,
  input: ZeroDteDecisionInput
): ZeroDteDecision => {
  const decisionId = requiredText(
    input.decisionId ?? buildZeroDteDecisionId(input.engineRunId, input.candidateId),
    "decision ID"
  );
  const decisionGroupId = requiredText(input.decisionGroupId, "decision group ID");
  const engineRunId = requiredText(input.engineRunId, "engine run ID");
  const candidateId = requiredText(input.candidateId, "candidate ID");
  const tradingDate = requiredText(input.tradingDate, "trading date");
  const action = requiredText(input.action, "decision action");
  const accountMode = assertPaperOnlyAccountMode(input.accountMode);
  const strategyVersion = requiredText(input.strategyVersion, "strategy version");
  const configurationVersionId = requiredText(
    input.configurationVersionId,
    "configuration version ID"
  );
  const decidedAt = isoTimestamp(input.decidedAt, "decision timestamp");
  const createdAt = isoTimestamp(input.createdAt ?? decidedAt, "created timestamp");
  const score = input.score === undefined || input.score === null ? null : input.score;
  const scoreThreshold =
    input.scoreThreshold === undefined || input.scoreThreshold === null
      ? null
      : input.scoreThreshold;
  if (score !== null && !Number.isFinite(score)) throw new RangeError("0DTE decision score must be finite");
  if (scoreThreshold !== null && !Number.isFinite(scoreThreshold)) {
    throw new RangeError("0DTE score threshold must be finite");
  }
  const reasonCodes = (input.reasonCodes ?? []).map((code) => requiredText(code, "reason code"));
  db.prepare(
    `INSERT INTO zero_dte_decisions
      (decision_id, decision_group_id, engine_run_id, candidate_id, trading_date,
       action, account_mode, strategy_version, configuration_version_id,
       market_timestamp, decided_at, score, score_threshold,
       applied_thresholds_json, reason_codes_json, evidence_json,
       client_order_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    decisionId,
    decisionGroupId,
    engineRunId,
    candidateId,
    tradingDate,
    action,
    accountMode,
    strategyVersion,
    configurationVersionId,
    optionalIsoTimestamp(input.marketTimestamp, "market timestamp"),
    decidedAt,
    score,
    scoreThreshold,
    serializeZeroDteJson(input.appliedThresholds ?? {}, "{}"),
    serializeZeroDteJson(reasonCodes, "[]"),
    serializeZeroDteJson(input.evidence ?? {}, "{}"),
    optionalText(input.clientOrderId),
    createdAt
  );

  return rowToDecision(
    db.prepare("SELECT * FROM zero_dte_decisions WHERE decision_id = ?").get(decisionId) as Record<string, unknown>
  );
};

export const insertZeroDteDecision = (input: ZeroDteDecisionInput) =>
  withTransaction(getDb(), () => insertZeroDteDecisionRow(getDb(), input));

export const insertZeroDteLifecycleEventRow = (
  db: DatabaseSync,
  input: ZeroDteLifecycleEventInput
): ZeroDteLifecycleEvent => {
  const eventId = requiredText(input.eventId ?? uuid(), "event ID");
  if (!ZERO_DTE_LIFECYCLE_EVENT_TYPES.includes(input.eventType)) {
    throw new RangeError(`Unsupported 0DTE lifecycle event type: ${input.eventType}`);
  }
  const accountMode = assertPaperOnlyAccountMode(input.accountMode);
  const strategyVersion = requiredText(input.strategyVersion, "strategy version");
  const configurationVersionId = requiredText(
    input.configurationVersionId,
    "configuration version ID"
  );
  const occurredAt = isoTimestamp(input.occurredAt, "event timestamp");
  const createdAt = isoTimestamp(input.createdAt ?? occurredAt, "created timestamp");
  const reasonCode = optionalText(input.reasonCode);
  const engineRunId = optionalText(input.engineRunId);
  const candidateId = optionalText(input.candidateId);
  const decisionId = optionalText(input.decisionId);
  const decisionGroupId = optionalText(input.decisionGroupId);
  const paperTradeId = optionalText(input.paperTradeId);
  const shadowTradeId = optionalText(input.shadowTradeId);
  if (paperTradeId && shadowTradeId) {
    throw new Error("ZERO_DTE_LIFECYCLE_EVENT_TRADE_DOMAIN_CONFLICT");
  }

  db.prepare(
    `INSERT INTO zero_dte_lifecycle_events
      (event_id, event_type, reason_code, engine_run_id, candidate_id,
       decision_id, decision_group_id, paper_trade_id, shadow_trade_id,
       account_mode, strategy_version, configuration_version_id,
       market_timestamp, occurred_at, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    eventId,
    input.eventType,
    reasonCode,
    engineRunId,
    candidateId,
    decisionId,
    decisionGroupId,
    paperTradeId,
    shadowTradeId,
    accountMode,
    strategyVersion,
    configurationVersionId,
    optionalIsoTimestamp(input.marketTimestamp, "market timestamp"),
    occurredAt,
    serializeZeroDteJson(input.details ?? {}, "{}"),
    createdAt
  );

  return rowToLifecycleEvent(
    db.prepare("SELECT * FROM zero_dte_lifecycle_events WHERE event_id = ?").get(eventId) as Record<string, unknown>
  );
};

export const appendZeroDteLifecycleEvent = (input: ZeroDteLifecycleEventInput) =>
  withTransaction(getDb(), () => insertZeroDteLifecycleEventRow(getDb(), input));
