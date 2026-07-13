import { getDb, queryAll } from "../lib/db.js";
import { insertPaperLearningRecord } from "./paperLearningLedgerService.js";

export type HedgeLearningEventType =
  | "decision"
  | "selection"
  | "sizing"
  | "submit"
  | "accept"
  | "reject"
  | "fill"
  | "partial"
  | "cancel"
  | "reprice"
  | "protection"
  | "exit"
  | "outcome";

export interface HedgeLearningEvent {
  eventId: string;
  reviewId: string;
  eventType: HedgeLearningEventType;
  createdAt: string;
  evidence: Record<string, unknown>;
}

interface HedgeLearningEventRow {
  event_id: string;
  review_id: string;
  event_type: HedgeLearningEventType;
  created_at: string;
  evidence_json: string;
}

const sensitiveKey = /(secret|token|password|authorization|credential|api[_-]?key|private[_-]?key)/i;

const sanitize = (value: unknown, depth = 0): unknown => {
  if (depth > 5 || value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") return value.slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => sanitize(entry, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (!sensitiveKey.test(key)) output[key] = sanitize(entry, depth + 1);
    }
    return output;
  }
  return null;
};

const mapRow = (row: HedgeLearningEventRow): HedgeLearningEvent => ({
  eventId: row.event_id,
  reviewId: row.review_id,
  eventType: row.event_type,
  createdAt: row.created_at,
  evidence: JSON.parse(row.evidence_json) as Record<string, unknown>
});

const maybeCreateLearningLedgerRecord = (event: HedgeLearningEvent) => {
  const decision = ["submit", "accept", "fill", "partial"].includes(event.eventType)
    ? "submitted"
    : event.eventType === "reject"
      ? "rejected"
      : "no_op";
  try {
    insertPaperLearningRecord({
      id: `hedge-learning-${event.reviewId}`,
      strategyFamily: "portfolio_hedge",
      symbol: String(event.evidence.symbol ?? "PORTFOLIO_HEDGE"),
      underlyingSymbol: typeof event.evidence.underlying === "string" ? event.evidence.underlying : null,
      optionSymbol: typeof event.evidence.optionSymbol === "string" ? event.evidence.optionSymbol : null,
      decision,
      hypothesis: "Record paper hedge lifecycle evidence for post-trade evaluation.",
      signalInputs: {
        reviewId: event.reviewId,
        eventType: event.eventType,
        evidence: event.evidence
      },
      learningStatus: "pending",
      sourceCandidateId: typeof event.evidence.candidateId === "string" ? event.evidence.candidateId : null
    });
  } catch {
    // The event ledger remains authoritative when a legacy learning row already exists.
  }
};

export const recordHedgeLearningEvent = (input: {
  eventId: string;
  reviewId: string;
  eventType: HedgeLearningEventType;
  createdAt?: string;
  evidence?: Record<string, unknown>;
}) => {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const evidence = (sanitize(input.evidence ?? {}) ?? {}) as Record<string, unknown>;
  const result = getDb()
    .prepare(
      `
      INSERT INTO hedge_learning_events(event_id, review_id, event_type, created_at, evidence_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING
      `
    )
    .run(input.eventId, input.reviewId, input.eventType, createdAt, JSON.stringify(evidence));
  const created = Number(result.changes) === 1;
  const event: HedgeLearningEvent = {
    eventId: input.eventId,
    reviewId: input.reviewId,
    eventType: input.eventType,
    createdAt,
    evidence
  };
  if (created) maybeCreateLearningLedgerRecord(event);
  return { created, event };
};

export const listHedgeLearningEvents = (reviewId: string): HedgeLearningEvent[] =>
  queryAll<HedgeLearningEventRow>(
    `SELECT * FROM hedge_learning_events WHERE review_id = ? ORDER BY created_at ASC, event_id ASC`,
    [reviewId]
  ).map(mapRow);

export const evaluateHedgeLearning = (reviewId: string) => {
  const events = listHedgeLearningEvents(reviewId);
  const observed = (types: HedgeLearningEventType[]) =>
    events.some((event) => types.includes(event.eventType)) ? "observed" : "unavailable";
  return {
    paperOnly: true as const,
    reviewId,
    evaluatedAt: new Date().toISOString(),
    eventCount: events.length,
    qualityDimensions: {
      decision: observed(["decision"]),
      selection: observed(["selection"]),
      sizing: observed(["sizing"]),
      execution: observed(["submit", "accept", "reject", "fill", "partial", "cancel", "reprice"]),
      protection: observed(["protection"]),
      exit: observed(["exit", "outcome"])
    }
  };
};
