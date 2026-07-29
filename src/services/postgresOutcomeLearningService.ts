import type { QueryResult } from "pg";

import { canonicalJsonHash } from "../lib/canonicalJson.js";
import type { SchedulerFence } from "../repositories/contracts/common.js";
import {
  buildHistoricalOutcomeAggregates,
  buildOutcomeLearningRecord,
  OUTCOME_LEARNING_SCHEMA_VERSION,
  type ExcursionObservationInput,
  type HistoricalOutcomeAggregate,
  type MarketObservationInput,
  type OutcomeEnvironment,
  type OutcomeLearningInput,
  type OutcomeLearningRecord
} from "./outcomeLearningModel.js";

export type OutcomeLearningQueryExecutor = {
  query: (
    sql: string,
    values?: readonly unknown[]
  ) => Promise<Pick<QueryResult<Record<string, unknown>>, "rows" | "rowCount">>;
};

export const OUTCOME_LEARNING_DEFAULT_MAX_RECORDS = 250;
export const OUTCOME_LEARNING_MAX_RECORDS = 500;
export const OUTCOME_LEARNING_MAX_RANGE_MS = 31 * 86_400_000;
export const OUTCOME_LEARNING_REFERENCE_TOLERANCE_MS = 60_000;
export const OUTCOME_LEARNING_MINIMUM_SAMPLE = 5;
export const OUTCOME_LEARNING_MAXIMUM_INCOMPLETE_JOIN_RATIO = 0.25;
export const OUTCOME_LEARNING_MAX_AGGREGATES = 2_000;
export const OUTCOME_LEARNING_RELATION_LIMITS = Object.freeze({
  arbitrationsPerCandidate: 8,
  reviewsPerCandidate: 16,
  intentsPerCandidate: 32,
  positionsPerCandidate: 16,
  ordersPerIntent: 8,
  brokerEventsPerLineage: 64,
  researchSignalsPerCandidate: 16,
  marketEvidencePerReview: 32
});

export const OUTCOME_CANDIDATE_SOURCE_SQL = `SELECT
  candidate.id,
  candidate.research_run_id,
  candidate.symbol,
  candidate.underlying_symbol,
  candidate.option_symbol,
  candidate.asset_class,
  candidate.as_of,
  candidate.horizon,
  candidate.strategy_family,
  candidate.score,
  candidate.confidence,
  candidate.decision,
  candidate.lifecycle_status,
  candidate.decision_reason,
  candidate.rationale,
  candidate.signal_inputs,
  candidate.option_liquidity_score,
  contract.contract_id AS option_contract_id,
  contract.multiplier AS contract_multiplier,
  candidate.updated_at
FROM candidates candidate
LEFT JOIN option_contracts contract
  ON contract.option_symbol = candidate.option_symbol
WHERE candidate.as_of >= $1
  AND candidate.as_of < $2
  AND (
    EXISTS (
      SELECT 1
      FROM portfolio_arbitration_decisions arbitration
      WHERE arbitration.proposal_id = candidate.id
    )
    OR EXISTS (
      SELECT 1
      FROM execution_reviews review
      WHERE review.candidate_id = candidate.id
    )
  )
ORDER BY candidate.as_of, candidate.id
LIMIT $3`;

export const OUTCOME_REFERENCE_LOOKUP_SQL = `WITH reference_events AS (
  SELECT *
  FROM jsonb_to_recordset($1::jsonb) AS event(
    candidate_id text,
    instrument text,
    asset_class text,
    event_at timestamptz,
    tolerance_ms integer
  )
)
SELECT
  event.candidate_id,
  COALESCE(stock.id, option_row.id) AS id,
  event.instrument,
  COALESCE(stock.observed_at, option_row.observed_at) AS observed_at,
  COALESCE(stock.received_at, option_row.received_at) AS received_at,
  COALESCE(stock.persisted_at, option_row.persisted_at) AS persisted_at,
  COALESCE(stock.source, option_row.source) AS provider,
  COALESCE(stock.feed, option_row.feed) AS feed,
  COALESCE(stock.bid, option_row.bid) AS bid,
  COALESCE(stock.ask, option_row.ask) AS ask,
  COALESCE(stock.midpoint, option_row.midpoint) AS midpoint,
  COALESCE(stock.last, option_row.last) AS last,
  COALESCE(stock.request_id, option_row.request_id) AS request_id
FROM reference_events event
LEFT JOIN LATERAL (
  SELECT
    snapshot.id,
    COALESCE(snapshot.source_timestamp, snapshot.observed_at) AS observed_at,
    snapshot.observed_at AS received_at,
    snapshot.created_at AS persisted_at,
    snapshot.source,
    snapshot.effective_feed AS feed,
    snapshot.evidence->>'bidPrice' AS bid,
    snapshot.evidence->>'askPrice' AS ask,
    snapshot.evidence->>'midpoint' AS midpoint,
    snapshot.evidence->>'latestTradePrice' AS last,
    snapshot.request_id
  FROM stock_snapshots snapshot
  WHERE event.asset_class = 'equity'
    AND snapshot.symbol = event.instrument
    AND snapshot.observed_at <= event.event_at
    AND snapshot.observed_at >= event.event_at -
      (event.tolerance_ms * interval '1 millisecond')
    AND COALESCE(snapshot.source_timestamp, snapshot.observed_at)
      <= event.event_at
    AND COALESCE(snapshot.source_timestamp, snapshot.observed_at)
      >= event.event_at - (event.tolerance_ms * interval '1 millisecond')
    AND snapshot.created_at <= event.event_at
  ORDER BY snapshot.observed_at DESC
  LIMIT 1
) stock ON true
LEFT JOIN LATERAL (
  SELECT
    'option_snapshot:' || snapshot.option_symbol || ':' ||
      to_char(snapshot.observed_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS id,
    COALESCE(
      snapshot.quote_timestamp,
      snapshot.snapshot_timestamp,
      snapshot.trade_timestamp,
      snapshot.observed_at
    ) AS observed_at,
    snapshot.observed_at AS received_at,
    snapshot.created_at AS persisted_at,
    snapshot.source,
    NULL::text AS feed,
    snapshot.bid::text AS bid,
    snapshot.ask::text AS ask,
    snapshot.midpoint::text AS midpoint,
    snapshot.last::text AS last,
    snapshot.request_id
  FROM option_snapshots snapshot
  WHERE event.asset_class = 'option'
    AND snapshot.option_symbol = event.instrument
    AND snapshot.observed_at <= event.event_at
    AND snapshot.observed_at >= event.event_at -
      (event.tolerance_ms * interval '1 millisecond')
    AND COALESCE(
      snapshot.quote_timestamp,
      snapshot.snapshot_timestamp,
      snapshot.trade_timestamp,
      snapshot.observed_at
    ) <= event.event_at
    AND COALESCE(
      snapshot.quote_timestamp,
      snapshot.snapshot_timestamp,
      snapshot.trade_timestamp,
      snapshot.observed_at
    ) >= event.event_at - (event.tolerance_ms * interval '1 millisecond')
    AND snapshot.created_at <= event.event_at
  ORDER BY snapshot.observed_at DESC
  LIMIT 1
) option_row ON true`;

export const OUTCOME_EXCURSION_LOOKUP_SQL = `WITH outcome_windows AS (
  SELECT *
  FROM jsonb_to_recordset($1::jsonb) AS outcome_window(
    candidate_id text,
    instrument text,
    asset_class text,
    start_at timestamptz,
    end_at timestamptz
  )
)
SELECT
  outcome_window.candidate_id,
  point.id,
  outcome_window.instrument,
  point.observed_at,
  point.high,
  point.low,
  point.price,
  point.source,
  point.granularity
FROM outcome_windows outcome_window
LEFT JOIN LATERAL (
  (
    SELECT
      'market_bar:' || bar.symbol || ':' || bar.timeframe || ':' ||
        to_char(bar.observed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS id,
      bar.observed_at,
      bar.high,
      bar.low,
      bar.close AS price,
      bar.source,
      bar.timeframe AS granularity
    FROM market_bars bar
    WHERE outcome_window.asset_class = 'equity'
      AND bar.symbol = outcome_window.instrument
      AND bar.timeframe = '1Day'
      AND bar.observed_at >= outcome_window.start_at
      AND bar.observed_at <= outcome_window.end_at
    ORDER BY bar.observed_at
    LIMIT 64
  )
  UNION ALL
  (
    SELECT
      'option_snapshot:' || snapshot.option_symbol || ':' ||
        to_char(snapshot.observed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS id,
      snapshot.observed_at,
      COALESCE(snapshot.midpoint, snapshot.last) AS high,
      COALESCE(snapshot.midpoint, snapshot.last) AS low,
      COALESCE(snapshot.midpoint, snapshot.last) AS price,
      snapshot.source,
      'snapshot'::text AS granularity
    FROM option_snapshots snapshot
    WHERE outcome_window.asset_class = 'option'
      AND snapshot.option_symbol = outcome_window.instrument
      AND snapshot.observed_at >= outcome_window.start_at
      AND snapshot.observed_at <= outcome_window.end_at
    ORDER BY snapshot.observed_at
    LIMIT 500
  )
) point ON true`;

const iso = (value: unknown): string | null => {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const objectValue = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const arrayValue = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const textArray = (value: unknown): string[] =>
  [...new Set(
    arrayValue(value)
      .map((entry) => typeof entry === "string" ? entry.trim() : "")
      .filter(Boolean)
  )];

const boundedEnvironment = (value: unknown): OutcomeEnvironment =>
  value === "paper" || value === "live" ? value : "unknown";

const normalizeForFingerprint = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeForFingerprint);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeForFingerprint(entry)])
  );
};

const parseMaximum = (value: string | number | undefined) => {
  if (value === undefined || value === "") {
    return OUTCOME_LEARNING_DEFAULT_MAX_RECORDS;
  }
  const text = String(value).trim();
  if (!/^[0-9]+$/.test(text)) {
    throw new Error("OUTCOME_LEARNING_MAX_RECORDS_INVALID");
  }
  const parsed = Number(text);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > OUTCOME_LEARNING_MAX_RECORDS
  ) {
    throw new Error("OUTCOME_LEARNING_MAX_RECORDS_OUT_OF_BOUNDS");
  }
  return parsed;
};

const parseRange = (start: string, end: string) => {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new Error("OUTCOME_LEARNING_TIMESTAMP_INVALID");
  }
  if (endMs <= startMs) {
    throw new Error("OUTCOME_LEARNING_RANGE_INVALID");
  }
  if (endMs - startMs > OUTCOME_LEARNING_MAX_RANGE_MS) {
    throw new Error("OUTCOME_LEARNING_RANGE_TOO_WIDE");
  }
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString()
  };
};

export const parseOutcomeLearningWindow = (input: {
  mode: "scheduled" | "backfill";
  start?: string;
  end?: string;
  maxRecords?: string | number;
  now?: Date;
}) => {
  const hasStart = Boolean(input.start?.trim());
  const hasEnd = Boolean(input.end?.trim());
  if (input.mode === "backfill" || hasStart || hasEnd) {
    if (!hasStart || !hasEnd) {
      throw new Error("OUTCOME_LEARNING_EXPLICIT_RANGE_REQUIRED");
    }
    return {
      ...parseRange(input.start!, input.end!),
      maxRecords: parseMaximum(input.maxRecords)
    };
  }
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("OUTCOME_LEARNING_TIMESTAMP_INVALID");
  }
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  return {
    start: new Date(today - 86_400_000).toISOString(),
    end: new Date(today).toISOString(),
    maxRecords: parseMaximum(input.maxRecords)
  };
};

const arbitrationSql = `WITH parent_ids AS (
  SELECT unnest($1::text[]) AS candidate_id
)
SELECT arbitration.*
FROM parent_ids parent
JOIN LATERAL (
  SELECT
    source_row.id,
    source_row.proposal_id,
    source_row.cycle_id,
    source_row.scheduler_run_id,
    source_row.lane,
    source_row.action,
    source_row.reason_codes,
    source_row.created_at,
    source_row.decision_fingerprint
  FROM portfolio_arbitration_decisions source_row
  WHERE source_row.proposal_id = parent.candidate_id
  ORDER BY source_row.created_at, source_row.id
  LIMIT $2
) arbitration ON true
ORDER BY arbitration.proposal_id, arbitration.created_at, arbitration.id`;

const reviewsSql = `WITH parent_ids AS (
  SELECT unnest($1::text[]) AS candidate_id
)
SELECT review.*
FROM parent_ids parent
JOIN LATERAL (
  SELECT
    source_row.id,
    source_row.candidate_id,
    source_row.review_type,
    source_row.environment,
    source_row.status,
    source_row.market_evidence,
    source_row.warnings,
    source_row.blockers,
    source_row.created_at,
    source_row.updated_at
  FROM execution_reviews source_row
  WHERE source_row.candidate_id = parent.candidate_id
  ORDER BY source_row.created_at, source_row.id
  LIMIT $2
) review ON true
ORDER BY review.candidate_id, review.created_at, review.id`;

const intentsSql = `WITH parent_ids AS (
  SELECT unnest($1::text[]) AS candidate_id
)
SELECT intent.*
FROM parent_ids parent
JOIN LATERAL (
  SELECT
    source_row.id,
    source_row.candidate_id,
    COALESCE(
      source_row.review_id,
      source_row.execution_review_id
    ) AS review_id,
    source_row.client_order_id,
    source_row.status,
    source_row.quantity,
    source_row.parent_position_id,
    source_row.created_at,
    source_row.submitted_at,
    source_row.updated_at
  FROM order_intents source_row
  WHERE source_row.candidate_id = parent.candidate_id
  ORDER BY source_row.created_at, source_row.id
  LIMIT $2
) intent ON true
ORDER BY intent.candidate_id, intent.created_at, intent.id`;

const ordersSql = `WITH parent_ids AS (
  SELECT unnest($1::text[]) AS intent_id
)
SELECT broker_order.*
FROM parent_ids parent
JOIN LATERAL (
  SELECT
    source_row.id,
    source_row.order_intent_id,
    source_row.client_order_id,
    source_row.broker_order_id,
    source_row.status,
    source_row.side,
    source_row.quantity,
    source_row.filled_quantity,
    source_row.filled_average_price,
    source_row.submitted_at,
    source_row.filled_at,
    source_row.created_at,
    source_row.updated_at
  FROM orders source_row
  WHERE source_row.order_intent_id = parent.intent_id
  ORDER BY source_row.created_at, source_row.id
  LIMIT $2
) broker_order ON true
ORDER BY broker_order.order_intent_id, broker_order.created_at, broker_order.id`;

const brokerEventsSql = `WITH order_ids AS (
  SELECT unnest($1::text[]) AS order_id
),
intent_ids AS (
  SELECT unnest($2::text[]) AS intent_id
),
events_by_order AS (
  SELECT event.*
  FROM order_ids parent
  JOIN LATERAL (
    SELECT
      source_row.event_id,
      source_row.broker_event_id,
      source_row.order_id,
      source_row.order_intent_id,
      source_row.event_type,
      source_row.event_status,
      source_row.response_payload->>'filled_qty' AS response_filled_qty,
      source_row.response_payload->>'filledQuantity'
        AS response_filled_quantity_camel,
      source_row.response_payload->>'filled_quantity'
        AS response_filled_quantity_snake,
      source_row.occurred_at,
      source_row.received_at
    FROM broker_events source_row
    WHERE source_row.order_id = parent.order_id
    ORDER BY source_row.occurred_at, source_row.event_id
    LIMIT $3
  ) event ON true
),
events_by_intent_without_order AS (
  SELECT event.*
  FROM intent_ids parent
  JOIN LATERAL (
    SELECT
      source_row.event_id,
      source_row.broker_event_id,
      source_row.order_id,
      source_row.order_intent_id,
      source_row.event_type,
      source_row.event_status,
      source_row.response_payload->>'filled_qty' AS response_filled_qty,
      source_row.response_payload->>'filledQuantity'
        AS response_filled_quantity_camel,
      source_row.response_payload->>'filled_quantity'
        AS response_filled_quantity_snake,
      source_row.occurred_at,
      source_row.received_at
    FROM broker_events source_row
    WHERE source_row.order_id IS NULL
      AND source_row.order_intent_id = parent.intent_id
    ORDER BY source_row.occurred_at, source_row.event_id
    LIMIT $3
  ) event ON true
)
SELECT * FROM events_by_order
UNION ALL
SELECT * FROM events_by_intent_without_order
ORDER BY occurred_at, event_id`;

const positionsSql = `WITH parent_ids AS (
  SELECT unnest($1::text[]) AS candidate_id
)
SELECT position.*
FROM parent_ids parent
JOIN LATERAL (
  SELECT
    source_row.id,
    source_row.candidate_id,
    source_row.opening_order_id,
    source_row.closing_order_id,
    source_row.status,
    source_row.asset_class,
    source_row.quantity,
    source_row.average_entry_price,
    source_row.current_price,
    source_row.unrealized_pnl,
    source_row.realized_pnl,
    source_row.cost_basis,
    source_row.opened_at,
    source_row.closed_at,
    source_row.last_reconciled_at,
    source_row.source_account_snapshot_id,
    contract.multiplier AS contract_multiplier,
    source_row.updated_at
  FROM positions source_row
  LEFT JOIN option_contracts contract
    ON contract.option_symbol = source_row.option_symbol
  WHERE source_row.candidate_id = parent.candidate_id
  ORDER BY source_row.opened_at, source_row.id
  LIMIT $2
) position ON true
ORDER BY position.candidate_id, position.opened_at, position.id`;

const researchSignalsSql = `WITH parent_ids AS (
  SELECT unnest($1::text[]) AS signal_id
)
SELECT signal.*
FROM parent_ids parent
JOIN LATERAL (
  SELECT
    source_row.id,
    source_row.horizon,
    source_row.catalysts,
    source_row.as_of,
    source_row.ingestion_timestamp,
    source_row.content_hash
  FROM research_signals source_row
  WHERE source_row.id = parent.signal_id
  ORDER BY source_row.id
  LIMIT $2
) signal ON true
ORDER BY signal.id`;

const fencePredicate = (start: number) => `EXISTS (
  SELECT 1
  FROM scheduler_leases lease
  WHERE lease.job_name = $${start}
    AND lease.workstream = $${start + 1}
    AND lease.owner_id = $${start + 2}
    AND lease.run_id = $${start + 3}
    AND lease.fencing_token = $${start + 4}
    AND lease.status = 'held'
    AND lease.expires_at > now()
)`;

const fenceValues = (fence: SchedulerFence) => [
  fence.jobName,
  fence.workstream,
  fence.ownerId,
  fence.runId,
  fence.fencingToken
];

const countResult = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

const assertFencedWrite = (
  result: Pick<QueryResult<Record<string, unknown>>, "rows" | "rowCount">,
  expected: number
) => {
  const row = result.rows[0];
  if (!row || row.fence_held !== true) {
    throw new Error("SCHEDULER_FENCE_LOST");
  }
  if (countResult(row.affected_count) !== expected) {
    throw new Error("OUTCOME_LEARNING_PERSISTENCE_COUNT_MISMATCH");
  }
};

const evidenceIdentity = (value: Record<string, unknown>) =>
  `market_evidence_${canonicalJsonHash({
    source: value.source ?? null,
    symbol: value.symbol ?? null,
    timestamp: value.timestamp ?? null,
    requestId: value.requestId ?? null
  })}`;

const directMarketEvidence = (reviewRow: Record<string, unknown>) => {
  const observations: MarketObservationInput[] = [];
  const ids: string[] = [];
  const evidenceRows = arrayValue(reviewRow.market_evidence);
  for (
    const entry of evidenceRows.slice(
      0,
      OUTCOME_LEARNING_RELATION_LIMITS.marketEvidencePerReview
    )
  ) {
    const value = objectValue(entry);
    const timestamp = iso(
      value.timestamp ??
      value.quoteTimestamp ??
      value.tradeTimestamp ??
      value.providerTimestamp
    );
    const instrument = String(value.symbol ?? "").trim();
    if (!timestamp || !instrument) continue;
    const id = evidenceIdentity(value);
    ids.push(id);
    observations.push({
      id,
      instrument,
      observedAt: timestamp,
      receivedAt: iso(
        value.receivedAt ??
        value.receiptTimestamp ??
        value.retrievedAt
      ),
      persistedAt: iso(
        value.persistedAt ??
        value.persistenceTimestamp
      ),
      provider: String(value.provider ?? value.source ?? "persisted_review_evidence"),
      feed: String(
        value.effectiveFeed ?? value.requestedFeed ?? value.feed ?? ""
      ) || null,
      bid: finite(value.bid ?? value.bidPrice),
      ask: finite(value.ask ?? value.askPrice),
      midpoint: finite(value.midpoint),
      last: finite(
        value.last ?? value.latestTradePrice ?? value.referencePrice
      ),
      requestId: String(value.requestId ?? "") || null
    });
  }
  return {
    ids: [...new Set(ids)],
    observations,
    truncated:
      evidenceRows.length >
      OUTCOME_LEARNING_RELATION_LIMITS.marketEvidencePerReview
  };
};

const allResearchReferences = (candidateRow: Record<string, unknown>) => {
  const signalInputs = objectValue(candidateRow.signal_inputs);
  const evidence = objectValue(signalInputs.researchEvidence);
  return [...new Set([
    String(evidence.signalId ?? "").trim(),
    ...textArray(evidence.signalIds)
  ].filter(Boolean))];
};

const researchReferences = (candidateRow: Record<string, unknown>) =>
  allResearchReferences(candidateRow).slice(
    0,
    OUTCOME_LEARNING_RELATION_LIMITS.researchSignalsPerCandidate
  );

const candidateReasons = (candidateRow: Record<string, unknown>) => [
  String(candidateRow.decision_reason ?? "").trim(),
  ...textArray(candidateRow.rationale)
].filter(Boolean);

const optionSpreadBps = (candidateRow: Record<string, unknown>) => {
  const inputs = objectValue(candidateRow.signal_inputs);
  const market = objectValue(inputs.marketDecisionInputs);
  const option = objectValue(market.option);
  const spreadPct = finite(option.spreadPct);
  return spreadPct === null ? null : spreadPct * 10_000;
};

const brokerFilledQuantity = (eventRow: Record<string, unknown>) => {
  return finite(
    eventRow.response_filled_qty ??
    eventRow.response_filled_quantity_camel ??
    eventRow.response_filled_quantity_snake
  );
};

const orderSide = (value: unknown): "buy" | "sell" | undefined => {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized === "buy" || normalized === "buy_to_open") return "buy";
  if (normalized === "sell" || normalized === "sell_to_close") return "sell";
  return undefined;
};

const rowBy = (
  rows: readonly Record<string, unknown>[],
  field: string
) => {
  const map = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = String(row[field] ?? "");
    if (!key) continue;
    const entries = map.get(key) ?? [];
    entries.push(row);
    map.set(key, entries);
  }
  return map;
};

const boundRowsByParent = (input: {
  rows: readonly Record<string, unknown>[];
  parentKey: (row: Record<string, unknown>) => string;
  limit: number;
}) => {
  const counts = new Map<string, number>();
  const rows: Record<string, unknown>[] = [];
  const truncatedParents = new Set<string>();
  for (const row of input.rows) {
    const parent = input.parentKey(row);
    if (!parent) continue;
    const count = counts.get(parent) ?? 0;
    counts.set(parent, count + 1);
    if (count < input.limit) {
      rows.push(row);
    } else {
      truncatedParents.add(parent);
    }
  }
  return { rows, truncatedParents };
};

const selectSourceEntryOrder = (input: {
  candidateId: string;
  intentsByCandidate: Map<string, Record<string, unknown>[]>;
  ordersByIntent: Map<string, Record<string, unknown>[]>;
  positionsByCandidate: Map<string, Record<string, unknown>[]>;
}) => {
  const entryIntents = (input.intentsByCandidate.get(input.candidateId) ?? [])
    .filter((intent) => !intent.parent_position_id);
  const intentById = new Map(
    entryIntents.map((intent) => [String(intent.id), intent])
  );
  const entryOrders = entryIntents.flatMap(
    (intent) => input.ordersByIntent.get(String(intent.id)) ?? []
  );
  const entryOrderById = new Map(
    entryOrders.map((order) => [String(order.id), order])
  );
  const positionLinked = (
    input.positionsByCandidate.get(input.candidateId) ?? []
  ).flatMap((position) => {
    const order = entryOrderById.get(String(position.opening_order_id ?? ""));
    if (!order) return [];
    const intent = intentById.get(String(order.order_intent_id ?? ""));
    return intent ? [{ intent, order, position }] : [];
  });
  if (positionLinked.length === 1) return positionLinked[0]!;
  if (positionLinked.length > 1 || entryOrders.length !== 1) return null;
  const order = entryOrders[0]!;
  const intent = intentById.get(String(order.order_intent_id ?? ""));
  return intent ? { intent, order, position: null } : null;
};

const loadSourceState = async (input: {
  query: OutcomeLearningQueryExecutor;
  start: string;
  end: string;
  maxRecords: number;
  now: Date;
}) => {
  const candidateResult = await input.query.query(OUTCOME_CANDIDATE_SOURCE_SQL, [
    input.start,
    input.end,
    input.maxRecords + 1
  ]);
  const candidateSourceTruncated =
    candidateResult.rows.length > input.maxRecords;
  const candidates = candidateResult.rows.slice(0, input.maxRecords);
  const candidateIds = candidates.map((row) => String(row.id));
  const truncatedCandidateIds = new Set<string>();
  for (const candidate of candidates) {
    if (
      allResearchReferences(candidate).length >
      OUTCOME_LEARNING_RELATION_LIMITS.researchSignalsPerCandidate
    ) {
      truncatedCandidateIds.add(String(candidate.id));
    }
  }
  const [
    rawArbitrationsResult,
    rawReviewsResult,
    rawIntentsResult,
    rawPositionsResult
  ] = await Promise.all([
    input.query.query(arbitrationSql, [
      candidateIds,
      OUTCOME_LEARNING_RELATION_LIMITS.arbitrationsPerCandidate + 1
    ]),
    input.query.query(reviewsSql, [
      candidateIds,
      OUTCOME_LEARNING_RELATION_LIMITS.reviewsPerCandidate + 1
    ]),
    input.query.query(intentsSql, [
      candidateIds,
      OUTCOME_LEARNING_RELATION_LIMITS.intentsPerCandidate + 1
    ]),
    input.query.query(positionsSql, [
      candidateIds,
      OUTCOME_LEARNING_RELATION_LIMITS.positionsPerCandidate + 1
    ])
  ]);
  const arbitrationsResult = boundRowsByParent({
    rows: rawArbitrationsResult.rows,
    parentKey: (row) => String(row.proposal_id ?? ""),
    limit: OUTCOME_LEARNING_RELATION_LIMITS.arbitrationsPerCandidate
  });
  const reviewsResult = boundRowsByParent({
    rows: rawReviewsResult.rows,
    parentKey: (row) => String(row.candidate_id ?? ""),
    limit: OUTCOME_LEARNING_RELATION_LIMITS.reviewsPerCandidate
  });
  const intentsResult = boundRowsByParent({
    rows: rawIntentsResult.rows,
    parentKey: (row) => String(row.candidate_id ?? ""),
    limit: OUTCOME_LEARNING_RELATION_LIMITS.intentsPerCandidate
  });
  const positionsResult = boundRowsByParent({
    rows: rawPositionsResult.rows,
    parentKey: (row) => String(row.candidate_id ?? ""),
    limit: OUTCOME_LEARNING_RELATION_LIMITS.positionsPerCandidate
  });
  for (const result of [
    arbitrationsResult,
    reviewsResult,
    intentsResult,
    positionsResult
  ]) {
    for (const candidateId of result.truncatedParents) {
      truncatedCandidateIds.add(candidateId);
    }
  }

  const intentCandidateById = new Map(
    intentsResult.rows.map((row) => [
      String(row.id),
      String(row.candidate_id)
    ])
  );
  const intentIds = [...intentCandidateById.keys()];
  const rawOrdersResult = await input.query.query(ordersSql, [
    intentIds,
    OUTCOME_LEARNING_RELATION_LIMITS.ordersPerIntent + 1
  ]);
  const ordersResult = boundRowsByParent({
    rows: rawOrdersResult.rows,
    parentKey: (row) => String(row.order_intent_id ?? ""),
    limit: OUTCOME_LEARNING_RELATION_LIMITS.ordersPerIntent
  });
  for (const intentId of ordersResult.truncatedParents) {
    const candidateId = intentCandidateById.get(intentId);
    if (candidateId) truncatedCandidateIds.add(candidateId);
  }
  const orderCandidateById = new Map(
    ordersResult.rows.map((row) => [
      String(row.id),
      intentCandidateById.get(String(row.order_intent_id)) ?? ""
    ])
  );
  const orderIds = [...orderCandidateById.keys()];
  const signalIds = [...new Set(candidates.flatMap(researchReferences))];
  const [rawBrokerEventsResult, researchSignalsResult] = await Promise.all([
    input.query.query(brokerEventsSql, [
      orderIds,
      intentIds,
      OUTCOME_LEARNING_RELATION_LIMITS.brokerEventsPerLineage + 1
    ]),
    input.query.query(researchSignalsSql, [signalIds, 1])
  ]);
  const brokerEventsResult = boundRowsByParent({
    rows: rawBrokerEventsResult.rows,
    parentKey: (row) => {
      const orderId = String(row.order_id ?? "");
      return orderId
        ? `order:${orderId}`
        : `intent:${String(row.order_intent_id ?? "")}`;
    },
    limit: OUTCOME_LEARNING_RELATION_LIMITS.brokerEventsPerLineage
  });
  for (const parent of brokerEventsResult.truncatedParents) {
    const separator = parent.indexOf(":");
    const kind = parent.slice(0, separator);
    const id = parent.slice(separator + 1);
    const candidateId = kind === "order"
      ? orderCandidateById.get(id)
      : intentCandidateById.get(id);
    if (candidateId) truncatedCandidateIds.add(candidateId);
  }

  const intentsByCandidate = rowBy(intentsResult.rows, "candidate_id");
  const ordersByIntent = rowBy(ordersResult.rows, "order_intent_id");
  const positionsByCandidate = rowBy(positionsResult.rows, "candidate_id");
  const directEvidenceByCandidate = new Map<string, MarketObservationInput[]>();
  const marketIdsByReview = new Map<string, string[]>();
  for (const review of reviewsResult.rows) {
    const direct = directMarketEvidence(review);
    marketIdsByReview.set(String(review.id), direct.ids);
    const candidateId = String(review.candidate_id ?? "");
    if (direct.truncated) truncatedCandidateIds.add(candidateId);
    directEvidenceByCandidate.set(candidateId, [
      ...(directEvidenceByCandidate.get(candidateId) ?? []),
      ...direct.observations
    ]);
  }
  const sourceTruncated =
    candidateSourceTruncated || truncatedCandidateIds.size > 0;
  const referenceEvents: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    const candidateId = String(candidate.id);
    const entry = selectSourceEntryOrder({
      candidateId,
      intentsByCandidate,
      ordersByIntent,
      positionsByCandidate
    });
    if (!entry) continue;
    const eventAt = iso(
      entry.order.submitted_at ?? entry.intent.submitted_at
    );
    if (!eventAt) continue;
    referenceEvents.push({
      candidate_id: candidateId,
      instrument: String(
        candidate.option_symbol ?? candidate.symbol ?? ""
      ),
      asset_class: String(candidate.asset_class ?? ""),
      event_at: eventAt,
      tolerance_ms: OUTCOME_LEARNING_REFERENCE_TOLERANCE_MS
    });
  }
  const referenceResult = referenceEvents.length
    ? await input.query.query(OUTCOME_REFERENCE_LOOKUP_SQL, [
        JSON.stringify(referenceEvents)
      ])
    : { rows: [], rowCount: 0 };
  const nearestEvidenceByCandidate = new Map<string, MarketObservationInput[]>();
  for (const row of referenceResult.rows) {
    const observedAt = iso(row.observed_at);
    const id = String(row.id ?? "");
    const candidateId = String(row.candidate_id ?? "");
    if (!observedAt || !id || !candidateId) continue;
    const observation: MarketObservationInput = {
      id,
      instrument: String(row.instrument ?? ""),
      observedAt,
      receivedAt: iso(row.received_at),
      persistedAt: iso(row.persisted_at),
      provider: String(row.provider ?? "persisted_market_snapshot"),
      feed: String(row.feed ?? "") || null,
      bid: finite(row.bid),
      ask: finite(row.ask),
      midpoint: finite(row.midpoint),
      last: finite(row.last),
      requestId: String(row.request_id ?? "") || null
    };
    nearestEvidenceByCandidate.set(candidateId, [
      ...(nearestEvidenceByCandidate.get(candidateId) ?? []),
      observation
    ]);
  }

  const eventsByOrder = rowBy(brokerEventsResult.rows, "order_id");
  const outcomeWindows: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    const candidateId = String(candidate.id);
    const entry = selectSourceEntryOrder({
      candidateId,
      intentsByCandidate,
      ordersByIntent,
      positionsByCandidate
    });
    if (!entry?.position) continue;
    const events = eventsByOrder.get(String(entry.order.id)) ?? [];
    const firstFill = events
      .filter((event) =>
        ["partially_filled", "filled"].includes(String(event.event_status ?? ""))
      )
      .map((event) => iso(event.occurred_at))
      .filter((value): value is string => value !== null)
      .sort()[0];
    const position = entry.position;
    const startAt = firstFill ?? iso(position.opened_at);
    const naturalEnd = iso(
      position.closed_at ?? position.last_reconciled_at
    ) ?? input.now.toISOString();
    if (!startAt) continue;
    const endMs = Math.min(
      Date.parse(naturalEnd),
      Date.parse(startAt) + OUTCOME_LEARNING_MAX_RANGE_MS,
      input.now.getTime()
    );
    if (!Number.isFinite(endMs) || endMs < Date.parse(startAt)) continue;
    outcomeWindows.push({
      candidate_id: candidateId,
      instrument: String(
        candidate.option_symbol ?? candidate.symbol ?? ""
      ),
      asset_class: String(candidate.asset_class ?? ""),
      start_at: startAt,
      end_at: new Date(endMs).toISOString()
    });
  }
  const excursionResult = outcomeWindows.length
    ? await input.query.query(OUTCOME_EXCURSION_LOOKUP_SQL, [
        JSON.stringify(outcomeWindows)
      ])
    : { rows: [], rowCount: 0 };
  const excursionsByCandidate = new Map<string, ExcursionObservationInput[]>();
  for (const row of excursionResult.rows) {
    const observedAt = iso(row.observed_at);
    const id = String(row.id ?? "");
    const candidateId = String(row.candidate_id ?? "");
    if (!observedAt || !id || !candidateId) continue;
    excursionsByCandidate.set(candidateId, [
      ...(excursionsByCandidate.get(candidateId) ?? []),
      {
        id,
        instrument: String(row.instrument ?? ""),
        observedAt,
        high: finite(row.high),
        low: finite(row.low),
        price: finite(row.price),
        source: String(row.source ?? "persisted_market_evidence"),
        granularity: String(row.granularity ?? "")
      }
    ]);
  }

  return {
    candidates,
    arbitrations: arbitrationsResult.rows,
    reviews: reviewsResult.rows,
    intents: intentsResult.rows,
    orders: ordersResult.rows,
    brokerEvents: brokerEventsResult.rows,
    positions: positionsResult.rows,
    researchSignals: researchSignalsResult.rows,
    directEvidenceByCandidate,
    nearestEvidenceByCandidate,
    marketIdsByReview,
    excursionsByCandidate,
    sourceTruncated,
    truncatedCandidateIds,
    fingerprintState: normalizeForFingerprint({
      sourceTruncated,
      truncatedCandidateIds: [...truncatedCandidateIds].sort(),
      candidates,
      arbitrations: arbitrationsResult.rows,
      reviews: reviewsResult.rows,
      intents: intentsResult.rows,
      orders: ordersResult.rows,
      brokerEvents: brokerEventsResult.rows,
      positions: positionsResult.rows,
      researchSignals: researchSignalsResult.rows,
      referenceRows: referenceResult.rows,
      excursionRows: excursionResult.rows
    })
  };
};

const buildRecords = (input: {
  source: Awaited<ReturnType<typeof loadSourceState>>;
  refreshRunId: string;
  environment: OutcomeEnvironment;
  calculatedAt: string;
}) => {
  const arbitrationByCandidate = rowBy(input.source.arbitrations, "proposal_id");
  const reviewsByCandidate = rowBy(input.source.reviews, "candidate_id");
  const intentsByCandidate = rowBy(input.source.intents, "candidate_id");
  const ordersByIntent = rowBy(input.source.orders, "order_intent_id");
  const eventsByOrder = rowBy(input.source.brokerEvents, "order_id");
  const eventsByIntent = rowBy(input.source.brokerEvents, "order_intent_id");
  const positionsByCandidate = rowBy(input.source.positions, "candidate_id");
  const researchById = new Map(
    input.source.researchSignals.map((row) => [String(row.id), row])
  );

  return input.source.candidates.map((candidate) => {
    const candidateId = String(candidate.id);
    const intents = intentsByCandidate.get(candidateId) ?? [];
    const intentIds = intents.map((row) => String(row.id));
    const orders = intentIds.flatMap((id) => ordersByIntent.get(id) ?? []);
    const orderIds = orders.map((row) => String(row.id));
    const brokerEvents = [
      ...orderIds.flatMap((id) => eventsByOrder.get(id) ?? []),
      ...intentIds.flatMap((id) => eventsByIntent.get(id) ?? [])
    ].filter(
      (row, index, rows) =>
        rows.findIndex((entry) => entry.event_id === row.event_id) === index
    );
    const researchSignalIds = researchReferences(candidate);
    const reviewRows = reviewsByCandidate.get(candidateId) ?? [];
    const modelInput: OutcomeLearningInput = {
      calculatedAt: input.calculatedAt,
      refreshRunId: input.refreshRunId,
      environment: input.environment,
      sourceLimitations: input.source.truncatedCandidateIds.has(candidateId)
        ? ["DEPENDENT_SOURCE_LIMIT_REACHED"]
        : [],
      candidate: {
        id: candidateId,
        symbol: String(candidate.option_symbol ?? candidate.symbol ?? ""),
        underlyingSymbol: String(
          candidate.underlying_symbol ?? candidate.symbol ?? ""
        ),
        optionContractId: String(candidate.option_contract_id ?? "") || undefined,
        strategyFamily: String(candidate.strategy_family ?? ""),
        timeHorizon: String(candidate.horizon ?? "") || undefined,
        score: finite(candidate.score),
        confidence: finite(candidate.confidence),
        decision: String(candidate.decision ?? ""),
        lifecycleStatus: String(candidate.lifecycle_status ?? ""),
        asOf: iso(candidate.as_of) ?? input.calculatedAt,
        reasonCodes: candidateReasons(candidate),
        researchSignalIds,
        researchHorizons: researchSignalIds.flatMap((id) => {
          const horizon = String(researchById.get(id)?.horizon ?? "").trim();
          return horizon ? [horizon] : [];
        }),
        catalysts: researchSignalIds.flatMap((id) =>
          textArray(researchById.get(id)?.catalysts)
        ),
        spreadBps: optionSpreadBps(candidate),
        liquidityScore: finite(candidate.option_liquidity_score)
      },
      arbitrations: (arbitrationByCandidate.get(candidateId) ?? []).map((row) => ({
        id: String(row.id),
        proposalId: String(row.proposal_id),
        cycleId: String(row.cycle_id ?? "") || undefined,
        schedulerRunId: String(row.scheduler_run_id ?? "") || undefined,
        lane: String(row.lane ?? ""),
        action: String(row.action ?? ""),
        reasonCodes: textArray(row.reason_codes),
        createdAt: iso(row.created_at) ?? input.calculatedAt
      })),
      reviews: reviewRows.map((row) => ({
        id: String(row.id),
        candidateId: String(row.candidate_id),
        reviewType: row.review_type === "exit" ? "exit" : "entry",
        environment: String(row.environment ?? ""),
        status: String(row.status ?? ""),
        createdAt: iso(row.created_at) ?? input.calculatedAt,
        marketEvidenceIds: input.source.marketIdsByReview.get(String(row.id)) ?? [],
        reasonCodes: [
          ...textArray(row.warnings),
          ...textArray(row.blockers)
        ]
      })),
      intents: intents.map((row) => ({
        id: String(row.id),
        candidateId: String(row.candidate_id),
        reviewId: String(row.review_id ?? "") || undefined,
        clientOrderId: String(row.client_order_id ?? "") || undefined,
        status: String(row.status ?? ""),
        quantity: finite(row.quantity),
        parentPositionId: String(row.parent_position_id ?? "") || undefined,
        createdAt: iso(row.created_at) ?? input.calculatedAt,
        submittedAt: iso(row.submitted_at) ?? undefined
      })),
      orders: orders.map((row) => ({
        id: String(row.id),
        intentId: String(row.order_intent_id),
        clientOrderId: String(row.client_order_id ?? "") || undefined,
        brokerOrderId: String(row.broker_order_id ?? "") || undefined,
        status: String(row.status ?? ""),
        side: orderSide(row.side),
        requestedQuantity: finite(row.quantity),
        filledQuantity: finite(row.filled_quantity),
        averageFillPrice: finite(row.filled_average_price),
        submittedAt: iso(row.submitted_at) ?? undefined,
        filledAt: iso(row.filled_at) ?? undefined
      })),
      brokerEvents: brokerEvents.map((row) => ({
        id: String(row.event_id),
        brokerEventId: String(row.broker_event_id ?? "") || undefined,
        orderId: String(row.order_id ?? "") || undefined,
        intentId: String(row.order_intent_id ?? "") || undefined,
        status: String(row.event_status ?? ""),
        filledQuantity: brokerFilledQuantity(row),
        occurredAt: iso(row.occurred_at) ?? input.calculatedAt
      })),
      positions: (positionsByCandidate.get(candidateId) ?? []).map((row) => ({
        id: String(row.id),
        candidateId: String(row.candidate_id ?? "") || undefined,
        openingOrderId: String(row.opening_order_id ?? "") || undefined,
        closingOrderId: String(row.closing_order_id ?? "") || undefined,
        status: String(row.status ?? ""),
        assetClass: String(row.asset_class ?? ""),
        quantity: finite(row.quantity),
        averageEntryPrice: finite(row.average_entry_price),
        currentPrice: finite(row.current_price),
        unrealizedPnl: finite(row.unrealized_pnl),
        realizedPnl: finite(row.realized_pnl),
        costBasis: finite(row.cost_basis),
        contractMultiplier: finite(row.contract_multiplier),
        openedAt: iso(row.opened_at) ?? undefined,
        closedAt: iso(row.closed_at) ?? undefined,
        lastReconciledAt: iso(row.last_reconciled_at) ?? undefined,
        sourceAccountSnapshotId:
          String(row.source_account_snapshot_id ?? "") || undefined
      })),
      marketObservations: [
        ...(input.source.directEvidenceByCandidate.get(candidateId) ?? []),
        ...(input.source.nearestEvidenceByCandidate.get(candidateId) ?? [])
      ],
      excursionObservations:
        input.source.excursionsByCandidate.get(candidateId) ?? [],
      referenceToleranceMs: OUTCOME_LEARNING_REFERENCE_TOLERANCE_MS
    };
    return buildOutcomeLearningRecord(modelInput);
  });
};

type ColumnSpec = readonly [name: string, postgresType: string];

const outcomeColumns: readonly ColumnSpec[] = [
  ["outcome_id", "text"],
  ["refresh_run_id", "text"],
  ["environment", "text"],
  ["cycle_id", "text"],
  ["scheduler_run_id", "text"],
  ["lane", "text"],
  ["candidate_id", "text"],
  ["proposal_id", "text"],
  ["arbitration_decision_id", "text"],
  ["review_id", "text"],
  ["intent_id", "text"],
  ["order_record_id", "text"],
  ["client_order_id", "text"],
  ["alpaca_order_id", "text"],
  ["position_id", "text"],
  ["exit_review_id", "text"],
  ["exit_intent_id", "text"],
  ["exit_order_id", "text"],
  ["reconciliation_identity", "text"],
  ["symbol", "text"],
  ["underlying_symbol", "text"],
  ["option_contract_id", "text"],
  ["time_horizon", "text"],
  ["broker_event_ids", "jsonb"],
  ["fill_activity_ids", "jsonb"],
  ["research_signal_ids", "jsonb"],
  ["research_horizons", "jsonb"],
  ["catalyst_ids", "jsonb"],
  ["market_evidence_ids", "jsonb"],
  ["entry_reason_codes", "jsonb"],
  ["arbitration_reason_codes", "jsonb"],
  ["exit_reason_codes", "jsonb"],
  ["proposal_score", "numeric"],
  ["proposal_confidence", "numeric"],
  ["score_bucket", "text"],
  ["confidence_bucket", "text"],
  ["spread_bucket", "text"],
  ["liquidity_bucket", "text"],
  ["arbitration_action", "text"],
  ["proposed_at", "timestamptz"],
  ["reviewed_at", "timestamptz"],
  ["intent_created_at", "timestamptz"],
  ["submitted_at", "timestamptz"],
  ["first_fill_at", "timestamptz"],
  ["full_fill_at", "timestamptz"],
  ["closed_at", "timestamptz"],
  ["submitted_status", "text"],
  ["final_order_status", "text"],
  ["fill_status", "text"],
  ["requested_quantity", "numeric"],
  ["filled_quantity", "numeric"],
  ["average_fill_price", "numeric"],
  ["reference_bid", "numeric"],
  ["reference_ask", "numeric"],
  ["reference_midpoint", "numeric"],
  ["reference_last", "numeric"],
  ["reference_timestamp", "timestamptz"],
  ["reference_received_at", "timestamptz"],
  ["reference_persisted_at", "timestamptz"],
  ["reference_source", "text"],
  ["reference_feed", "text"],
  ["reference_lookup_method", "text"],
  ["reference_lookup_distance_ms", "bigint"],
  ["reference_tolerance_ms", "bigint"],
  ["reference_freshness_status", "text"],
  ["fill_vs_bid", "numeric"],
  ["fill_vs_ask", "numeric"],
  ["fill_vs_midpoint", "numeric"],
  ["fill_vs_last", "numeric"],
  ["spread_at_reference_value", "numeric"],
  ["spread_at_reference_bps", "numeric"],
  ["slippage_value", "numeric"],
  ["slippage_bps", "numeric"],
  ["slippage_basis", "text"],
  ["time_intent_to_submission_ms", "bigint"],
  ["time_proposal_to_submission_ms", "bigint"],
  ["time_to_first_fill_ms", "bigint"],
  ["time_to_full_fill_ms", "bigint"],
  ["time_first_fill_to_close_ms", "bigint"],
  ["realized_pnl", "numeric"],
  ["realized_return", "numeric"],
  ["unrealized_return_checkpoints", "jsonb"],
  ["maximum_favorable_excursion", "numeric"],
  ["maximum_adverse_excursion", "numeric"],
  ["excursion_source", "text"],
  ["excursion_start", "timestamptz"],
  ["excursion_end", "timestamptz"],
  ["holding_period_ms", "bigint"],
  ["join_status", "text"],
  ["join_methods", "jsonb"],
  ["partial_join_reasons", "jsonb"],
  ["missing_join_reasons", "jsonb"],
  ["ambiguous_join_reasons", "jsonb"],
  ["unsupported_join_reasons", "jsonb"],
  ["metric_limitations", "jsonb"],
  ["paper_limitations", "jsonb"],
  ["source_watermark", "timestamptz"],
  ["calculated_at", "timestamptz"],
  ["schema_version", "integer"],
  ["content_hash", "text"]
];

const aggregateColumns: readonly ColumnSpec[] = [
  ["id", "text"],
  ["refresh_run_id", "text"],
  ["environment", "text"],
  ["lane", "text"],
  ["dimension", "text"],
  ["grouping_key", "text"],
  ["date_range_start", "timestamptz"],
  ["date_range_end", "timestamptz"],
  ["source_truncated", "boolean"],
  ["sample_count", "integer"],
  ["proposed_count", "integer"],
  ["approved_count", "integer"],
  ["resized_count", "integer"],
  ["skipped_count", "integer"],
  ["submitted_count", "integer"],
  ["filled_count", "integer"],
  ["rejected_count", "integer"],
  ["canceled_count", "integer"],
  ["closed_count", "integer"],
  ["average_time_to_first_fill_ms", "numeric"],
  ["average_slippage_bps", "numeric"],
  ["median_slippage_bps", "numeric"],
  ["realized_return_average", "numeric"],
  ["realized_return_median", "numeric"],
  ["win_rate", "numeric"],
  ["maximum_favorable_excursion_average", "numeric"],
  ["maximum_adverse_excursion_average", "numeric"],
  ["missing_join_count", "integer"],
  ["ambiguous_join_count", "integer"],
  ["unsupported_metric_count", "integer"],
  ["usable_as_evidence", "boolean"],
  ["paper_limitations", "jsonb"],
  ["bucket_definitions", "jsonb"],
  ["source_watermark", "timestamptz"],
  ["calculated_at", "timestamptz"],
  ["schema_version", "integer"],
  ["content_hash", "text"]
];

const recordsetDefinition = (columns: readonly ColumnSpec[]) =>
  columns.map(([name, type]) => `${name} ${type}`).join(", ");

const upsertSql = (input: {
  table: string;
  columns: readonly ColumnSpec[];
  conflict: readonly string[];
  immutable: readonly string[];
}) => {
  const names = input.columns.map(([name]) => name);
  const updates = names
    .filter((name) => !input.immutable.includes(name))
    .map((name) => `${name} = EXCLUDED.${name}`)
    .join(", ");
  return `WITH fence_state AS (
    SELECT ${fencePredicate(2)} AS held
  ), input_rows AS (
    SELECT input_row.*
    FROM jsonb_to_recordset($1::jsonb) AS input_row(
      ${recordsetDefinition(input.columns)}
    )
  ), persisted AS (
    INSERT INTO ${input.table} (${names.join(", ")})
    SELECT ${names.map((name) => `input_rows.${name}`).join(", ")}
    FROM input_rows, fence_state
    WHERE fence_state.held
    ON CONFLICT (${input.conflict.join(", ")}) DO UPDATE SET ${updates}
    RETURNING 1
  )
  SELECT fence_state.held AS fence_held,
         (SELECT COUNT(*)::integer FROM persisted) AS affected_count
  FROM fence_state`;
};

const outcomeUpsertSql = upsertSql({
  table: "outcome_learning_records",
  columns: outcomeColumns,
  conflict: ["environment", "candidate_id", "schema_version"],
  immutable: [
    "outcome_id",
    "environment",
    "candidate_id",
    "proposal_id",
    "schema_version"
  ]
});

const aggregateUpsertSql = upsertSql({
  table: "historical_outcome_aggregates",
  columns: aggregateColumns,
  conflict: [
    "environment",
    "lane",
    "dimension",
    "grouping_key",
    "date_range_start",
    "date_range_end",
    "schema_version"
  ],
  immutable: [
    "id",
    "environment",
    "lane",
    "dimension",
    "grouping_key",
    "date_range_start",
    "date_range_end",
    "schema_version"
  ]
});

const outcomeRecordRow = (record: OutcomeLearningRecord) => ({
  outcome_id: record.outcomeId,
  refresh_run_id: record.refreshRunId,
  environment: record.environment,
  cycle_id: record.cycleId,
  scheduler_run_id: record.schedulerRunId,
  lane: record.lane,
  candidate_id: record.candidateId,
  proposal_id: record.proposalId,
  arbitration_decision_id: record.arbitrationDecisionId,
  review_id: record.reviewId,
  intent_id: record.intentId,
  order_record_id: record.orderRecordId,
  client_order_id: record.clientOrderId,
  alpaca_order_id: record.alpacaOrderId,
  position_id: record.positionId,
  exit_review_id: record.exitReviewId,
  exit_intent_id: record.exitIntentId,
  exit_order_id: record.exitOrderId,
  reconciliation_identity: record.reconciliationIdentity,
  symbol: record.symbol,
  underlying_symbol: record.underlyingSymbol,
  option_contract_id: record.optionContractId,
  time_horizon: record.timeHorizon,
  broker_event_ids: record.brokerEventIds,
  fill_activity_ids: record.fillActivityIds,
  research_signal_ids: record.researchSignalIds,
  research_horizons: record.researchHorizons,
  catalyst_ids: record.catalysts,
  market_evidence_ids: record.marketEvidenceIds,
  entry_reason_codes: record.entryReasonCodes,
  arbitration_reason_codes: record.arbitrationReasonCodes,
  exit_reason_codes: record.exitReasonCodes,
  proposal_score: record.proposalScore,
  proposal_confidence: record.proposalConfidence,
  score_bucket: record.scoreBucket,
  confidence_bucket: record.confidenceBucket,
  spread_bucket: record.spreadBucket,
  liquidity_bucket: record.liquidityBucket,
  arbitration_action: record.arbitrationAction,
  proposed_at: record.proposedAt,
  reviewed_at: record.reviewedAt,
  intent_created_at: record.intentCreatedAt,
  submitted_at: record.submittedAt,
  first_fill_at: record.firstFillAt,
  full_fill_at: record.fullFillAt,
  closed_at: record.closedAt,
  submitted_status: record.submittedStatus,
  final_order_status: record.finalOrderStatus,
  fill_status: record.fillStatus,
  requested_quantity: record.requestedQuantity,
  filled_quantity: record.filledQuantity,
  average_fill_price: record.averageFillPrice,
  reference_bid: record.referenceBid,
  reference_ask: record.referenceAsk,
  reference_midpoint: record.referenceMidpoint,
  reference_last: record.referenceLast,
  reference_timestamp: record.referenceTimestamp,
  reference_received_at: record.referenceReceivedAt,
  reference_persisted_at: record.referencePersistedAt,
  reference_source: record.referenceSource,
  reference_feed: record.referenceFeed,
  reference_lookup_method: record.referenceLookupMethod,
  reference_lookup_distance_ms: record.referenceLookupDistanceMs,
  reference_tolerance_ms: record.referenceToleranceMs,
  reference_freshness_status: record.referenceFreshnessStatus,
  fill_vs_bid: record.fillVsBid,
  fill_vs_ask: record.fillVsAsk,
  fill_vs_midpoint: record.fillVsMidpoint,
  fill_vs_last: record.fillVsLast,
  spread_at_reference_value: record.spreadAtReferenceValue,
  spread_at_reference_bps: record.spreadAtReferenceBps,
  slippage_value: record.slippageValue,
  slippage_bps: record.slippageBps,
  slippage_basis: record.slippageBasis,
  time_intent_to_submission_ms: record.timeIntentToSubmissionMs,
  time_proposal_to_submission_ms: record.timeProposalToSubmissionMs,
  time_to_first_fill_ms: record.timeToFirstFillMs,
  time_to_full_fill_ms: record.timeToFullFillMs,
  time_first_fill_to_close_ms: record.timeFirstFillToCloseMs,
  realized_pnl: record.realizedPnl,
  realized_return: record.realizedReturn,
  unrealized_return_checkpoints: record.unrealizedReturnCheckpoints,
  maximum_favorable_excursion: record.maximumFavorableExcursion,
  maximum_adverse_excursion: record.maximumAdverseExcursion,
  excursion_source: record.excursionSource,
  excursion_start: record.excursionStart,
  excursion_end: record.excursionEnd,
  holding_period_ms: record.holdingPeriodMs,
  join_status: record.joinStatus,
  join_methods: record.joinMethods,
  partial_join_reasons: record.partialJoinReasons,
  missing_join_reasons: record.missingJoinReasons,
  ambiguous_join_reasons: record.ambiguousJoinReasons,
  unsupported_join_reasons: record.unsupportedJoinReasons,
  metric_limitations: record.metricLimitations,
  paper_limitations: record.paperLimitations,
  source_watermark: record.sourceWatermark,
  calculated_at: record.calculatedAt,
  schema_version: record.schemaVersion,
  content_hash: record.contentHash
});

const aggregateRow = (aggregate: HistoricalOutcomeAggregate) => ({
  id: aggregate.id,
  refresh_run_id: aggregate.refreshRunId,
  environment: aggregate.environment,
  lane: aggregate.lane,
  dimension: aggregate.dimension,
  grouping_key: aggregate.groupingKey,
  date_range_start: aggregate.dateRangeStart,
  date_range_end: aggregate.dateRangeEnd,
  source_truncated: aggregate.sourceTruncated,
  sample_count: aggregate.sampleCount,
  proposed_count: aggregate.proposedCount,
  approved_count: aggregate.approvedCount,
  resized_count: aggregate.resizedCount,
  skipped_count: aggregate.skippedCount,
  submitted_count: aggregate.submittedCount,
  filled_count: aggregate.filledCount,
  rejected_count: aggregate.rejectedCount,
  canceled_count: aggregate.canceledCount,
  closed_count: aggregate.closedCount,
  average_time_to_first_fill_ms: aggregate.averageTimeToFirstFillMs,
  average_slippage_bps: aggregate.averageSlippageBps,
  median_slippage_bps: aggregate.medianSlippageBps,
  realized_return_average: aggregate.realizedReturnAverage,
  realized_return_median: aggregate.realizedReturnMedian,
  win_rate: aggregate.winRate,
  maximum_favorable_excursion_average:
    aggregate.maximumFavorableExcursionAverage,
  maximum_adverse_excursion_average:
    aggregate.maximumAdverseExcursionAverage,
  missing_join_count: aggregate.missingJoinCount,
  ambiguous_join_count: aggregate.ambiguousJoinCount,
  unsupported_metric_count: aggregate.unsupportedMetricCount,
  usable_as_evidence: aggregate.usableAsEvidence,
  paper_limitations: aggregate.paperLimitations,
  bucket_definitions: aggregate.bucketDefinitions,
  source_watermark: aggregate.sourceWatermark,
  calculated_at: aggregate.calculatedAt,
  schema_version: aggregate.schemaVersion,
  content_hash: aggregate.contentHash
});

const persistRefreshStart = async (input: {
  query: OutcomeLearningQueryExecutor;
  fence: SchedulerFence;
  id: string;
  environment: OutcomeEnvironment;
  start: string;
  end: string;
  maxRecords: number;
  sourceRecordCount: number;
  sourceTruncated: boolean;
  sourceFingerprint: string;
  startedAt: string;
}) => {
  const sql = `WITH fence_state AS (
    SELECT ${fencePredicate(10)} AS held
  ), persisted AS (
    INSERT INTO outcome_learning_refresh_runs(
      id, environment, date_range_start, date_range_end,
      requested_max_records, source_record_count, outcome_record_count,
      aggregate_record_count, source_truncated, status, source_fingerprint,
      started_at, scheduler_job_name, scheduler_workstream, scheduler_run_id,
      scheduler_fencing_token, schema_version
    )
    SELECT $1, $2, $3, $4, $5, $6, 0, 0, $7, 'running', $8, $9,
           $10, $11, $13, $14, $15
    FROM fence_state
    WHERE fence_state.held
    ON CONFLICT (
      environment, date_range_start, date_range_end, requested_max_records,
      source_fingerprint, schema_version
    ) DO UPDATE SET
      status = 'running',
      source_record_count = EXCLUDED.source_record_count,
      source_truncated = EXCLUDED.source_truncated,
      scheduler_job_name = EXCLUDED.scheduler_job_name,
      scheduler_workstream = EXCLUDED.scheduler_workstream,
      scheduler_run_id = EXCLUDED.scheduler_run_id,
      scheduler_fencing_token = EXCLUDED.scheduler_fencing_token,
      started_at = EXCLUDED.started_at,
      completed_at = NULL,
      error_code = NULL
    RETURNING id
  )
  SELECT fence_state.held AS fence_held,
         (SELECT COUNT(*)::integer FROM persisted) AS affected_count
  FROM fence_state`;
  const values = [
    input.id,
    input.environment,
    input.start,
    input.end,
    input.maxRecords,
    input.sourceRecordCount,
    input.sourceTruncated,
    input.sourceFingerprint,
    input.startedAt,
    ...fenceValues(input.fence),
    OUTCOME_LEARNING_SCHEMA_VERSION
  ];
  const result = await input.query.query(sql, values);
  assertFencedWrite(result, 1);
};

const completeRefresh = async (input: {
  query: OutcomeLearningQueryExecutor;
  fence: SchedulerFence;
  id: string;
  status: "completed" | "no_op" | "failed";
  outcomeCount: number;
  aggregateCount: number;
  resultFingerprint: string;
  limitations: string[];
  errorCode?: string;
  completedAt: string;
}) => {
  const result = await input.query.query(
    `WITH fence_state AS (
       SELECT ${fencePredicate(9)} AS held
     ), persisted AS (
       UPDATE outcome_learning_refresh_runs refresh
       SET status = $2,
           outcome_record_count = $3,
           aggregate_record_count = $4,
           result_fingerprint = $5,
           limitations = $6::jsonb,
           error_code = $7,
           completed_at = $8
       FROM fence_state
       WHERE refresh.id = $1 AND fence_state.held
       RETURNING refresh.id
     )
     SELECT fence_state.held AS fence_held,
            (SELECT COUNT(*)::integer FROM persisted) AS affected_count
     FROM fence_state`,
    [
      input.id,
      input.status,
      input.outcomeCount,
      input.aggregateCount,
      input.resultFingerprint,
      JSON.stringify(input.limitations),
      input.errorCode ?? null,
      input.completedAt,
      ...fenceValues(input.fence)
    ]
  );
  assertFencedWrite(result, 1);
};

const persistDerivedRows = async (input: {
  query: OutcomeLearningQueryExecutor;
  fence: SchedulerFence;
  records: OutcomeLearningRecord[];
  aggregates: HistoricalOutcomeAggregate[];
}) => {
  for (let index = 0; index < input.records.length; index += 50) {
    const chunk = input.records.slice(index, index + 50).map(outcomeRecordRow);
    const result = await input.query.query(outcomeUpsertSql, [
      JSON.stringify(chunk),
      ...fenceValues(input.fence)
    ]);
    assertFencedWrite(result, chunk.length);
  }
  for (let index = 0; index < input.aggregates.length; index += 100) {
    const chunk = input.aggregates.slice(index, index + 100).map(aggregateRow);
    const result = await input.query.query(aggregateUpsertSql, [
      JSON.stringify(chunk),
      ...fenceValues(input.fence)
    ]);
    assertFencedWrite(result, chunk.length);
  }
};

export type OutcomeLearningRefreshResult = {
  status: "completed" | "no_op";
  code?: string;
  refreshRunId: string;
  environment: OutcomeEnvironment;
  dateRangeStart: string;
  dateRangeEnd: string;
  requestedMaxRecords: number;
  sourceRecordCount: number;
  outcomeRecordCount: number;
  aggregateRecordCount: number;
  sourceTruncated: boolean;
  limitations: string[];
  sourceFingerprint: string;
  resultFingerprint: string | null;
  durationMs: number;
};

export const runPostgresOutcomeLearningRefresh = async (input: {
  query: OutcomeLearningQueryExecutor;
  fence: SchedulerFence;
  environment: OutcomeEnvironment;
  start: string;
  end: string;
  maxRecords: number;
  now?: Date;
  minimumSample?: number;
  maximumIncompleteJoinRatio?: number;
}): Promise<OutcomeLearningRefreshResult> => {
  const bounds = parseOutcomeLearningWindow({
    mode: "backfill",
    start: input.start,
    end: input.end,
    maxRecords: input.maxRecords,
    now: input.now
  });
  const started = input.now ?? new Date();
  const startedAt = started.toISOString();
  const source = await loadSourceState({
    query: input.query,
    start: bounds.start,
    end: bounds.end,
    maxRecords: bounds.maxRecords,
    now: started
  });
  const sourceFingerprint = canonicalJsonHash(source.fingerprintState);
  const existing = await input.query.query(
    `SELECT id, status, source_record_count, outcome_record_count,
            aggregate_record_count, source_truncated, result_fingerprint
     FROM outcome_learning_refresh_runs
     WHERE environment = $1
       AND date_range_start = $2
       AND date_range_end = $3
       AND requested_max_records = $4
       AND source_fingerprint = $5
       AND schema_version = $6
       AND status IN ('completed', 'no_op')
     LIMIT 1`,
    [
      input.environment,
      bounds.start,
      bounds.end,
      bounds.maxRecords,
      sourceFingerprint,
      OUTCOME_LEARNING_SCHEMA_VERSION
    ]
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    return {
      status: "no_op",
      code: "OUTCOME_LEARNING_REPLAY_UNCHANGED",
      refreshRunId: String(row.id),
      environment: input.environment,
      dateRangeStart: bounds.start,
      dateRangeEnd: bounds.end,
      requestedMaxRecords: bounds.maxRecords,
      sourceRecordCount: countResult(row.source_record_count),
      outcomeRecordCount: countResult(row.outcome_record_count),
      aggregateRecordCount: countResult(row.aggregate_record_count),
      sourceTruncated: Boolean(row.source_truncated),
      limitations: [],
      sourceFingerprint,
      resultFingerprint: String(row.result_fingerprint ?? "") || null,
      durationMs: Math.max(0, Date.now() - started.getTime())
    };
  }

  const refreshRunId =
    `outcome-refresh:v${OUTCOME_LEARNING_SCHEMA_VERSION}:${
      canonicalJsonHash({
        environment: input.environment,
        start: bounds.start,
        end: bounds.end,
        maxRecords: bounds.maxRecords,
        sourceFingerprint
      }).slice(0, 48)
    }`;
  await persistRefreshStart({
    query: input.query,
    fence: input.fence,
    id: refreshRunId,
    environment: input.environment,
    start: bounds.start,
    end: bounds.end,
    maxRecords: bounds.maxRecords,
    sourceRecordCount: source.candidates.length,
    sourceTruncated: source.sourceTruncated,
    sourceFingerprint,
    startedAt
  });
  const limitations = source.sourceTruncated
    ? ["SOURCE_RECORD_LIMIT_REACHED"]
    : [];
  if (source.candidates.length === 0) {
    const resultFingerprint = canonicalJsonHash({
      sourceFingerprint,
      records: [],
      aggregates: []
    });
    await completeRefresh({
      query: input.query,
      fence: input.fence,
      id: refreshRunId,
      status: "no_op",
      outcomeCount: 0,
      aggregateCount: 0,
      resultFingerprint,
      limitations,
      errorCode: "NO_BOUNDED_OUTCOME_SOURCES",
      completedAt: startedAt
    });
    return {
      status: "no_op",
      code: "NO_BOUNDED_OUTCOME_SOURCES",
      refreshRunId,
      environment: input.environment,
      dateRangeStart: bounds.start,
      dateRangeEnd: bounds.end,
      requestedMaxRecords: bounds.maxRecords,
      sourceRecordCount: 0,
      outcomeRecordCount: 0,
      aggregateRecordCount: 0,
      sourceTruncated: source.sourceTruncated,
      limitations,
      sourceFingerprint,
      resultFingerprint,
      durationMs: 0
    };
  }

  const records = buildRecords({
    source,
    refreshRunId,
    environment: input.environment,
    calculatedAt: startedAt
  });
  const allAggregates = buildHistoricalOutcomeAggregates({
    refreshRunId,
    records,
    dateRangeStart: bounds.start,
    dateRangeEnd: bounds.end,
    calculatedAt: startedAt,
    minimumSample: Math.max(
      1,
      Math.min(500, input.minimumSample ?? OUTCOME_LEARNING_MINIMUM_SAMPLE)
    ),
    maximumIncompleteJoinRatio: Math.max(
      0,
      Math.min(
        1,
        input.maximumIncompleteJoinRatio ??
          OUTCOME_LEARNING_MAXIMUM_INCOMPLETE_JOIN_RATIO
      )
    ),
    sourceTruncated: source.sourceTruncated
  });
  const aggregateLimitReached =
    allAggregates.length > OUTCOME_LEARNING_MAX_AGGREGATES;
  const aggregates = allAggregates
    .slice(0, OUTCOME_LEARNING_MAX_AGGREGATES)
    .map((aggregate) => {
      if (!aggregateLimitReached) return aggregate;
      const limited = {
        ...aggregate,
        sourceTruncated: true,
        usableAsEvidence: false
      };
      return {
        ...limited,
        contentHash: canonicalJsonHash({
          ...limited,
          refreshRunId: undefined,
          calculatedAt: undefined,
          contentHash: undefined
        })
      };
    });
  if (aggregateLimitReached) limitations.push("AGGREGATE_RECORD_LIMIT_REACHED");
  await persistDerivedRows({
    query: input.query,
    fence: input.fence,
    records,
    aggregates
  });
  const resultFingerprint = canonicalJsonHash({
    recordHashes: records.map((record) => record.contentHash),
    aggregateHashes: aggregates.map((aggregate) => aggregate.contentHash),
    limitations
  });
  const completedAt = new Date().toISOString();
  await completeRefresh({
    query: input.query,
    fence: input.fence,
    id: refreshRunId,
    status: "completed",
    outcomeCount: records.length,
    aggregateCount: aggregates.length,
    resultFingerprint,
    limitations,
    completedAt
  });
  return {
    status: "completed",
    refreshRunId,
    environment: input.environment,
    dateRangeStart: bounds.start,
    dateRangeEnd: bounds.end,
    requestedMaxRecords: bounds.maxRecords,
    sourceRecordCount: source.candidates.length,
    outcomeRecordCount: records.length,
    aggregateRecordCount: aggregates.length,
    sourceTruncated: source.sourceTruncated,
    limitations,
    sourceFingerprint,
    resultFingerprint,
    durationMs: Math.max(0, Date.parse(completedAt) - started.getTime())
  };
};

export const readBoundedOutcomeLearningRecords = async (input: {
  query: OutcomeLearningQueryExecutor;
  start: string;
  end: string;
  environment?: OutcomeEnvironment;
  lane?: string;
  candidateId?: string;
  limit?: number;
}) => {
  const range = parseRange(input.start, input.end);
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("OUTCOME_LEARNING_QUERY_LIMIT_OUT_OF_BOUNDS");
  }
  const environment = input.environment ?? "paper";
  if (!["paper", "live", "unknown"].includes(environment)) {
    throw new Error("OUTCOME_LEARNING_ENVIRONMENT_INVALID");
  }
  const allowedLanes = ["equity", "options_0dte", "options_leaps", "unknown"];
  if (input.lane && !allowedLanes.includes(input.lane)) {
    throw new Error("OUTCOME_LEARNING_LANE_INVALID");
  }
  const result = await input.query.query(
    `SELECT
       outcome_id, refresh_run_id, environment, cycle_id, scheduler_run_id, lane,
       candidate_id, proposal_id, arbitration_decision_id, review_id,
       intent_id, order_record_id, client_order_id, alpaca_order_id,
       position_id, exit_review_id, exit_intent_id, exit_order_id,
       reconciliation_identity, symbol, underlying_symbol,
       option_contract_id, time_horizon, broker_event_ids, fill_activity_ids,
       research_signal_ids, research_horizons, catalyst_ids,
       market_evidence_ids,
       entry_reason_codes, arbitration_reason_codes, exit_reason_codes,
       proposal_score, proposal_confidence, score_bucket, confidence_bucket,
       spread_bucket, liquidity_bucket, arbitration_action, proposed_at,
       reviewed_at, intent_created_at, submitted_at, first_fill_at,
       full_fill_at, closed_at, submitted_status, final_order_status,
       fill_status, requested_quantity, filled_quantity,
       average_fill_price, reference_bid, reference_ask, reference_midpoint,
       reference_last, reference_timestamp, reference_received_at,
       reference_persisted_at, reference_source, reference_feed,
       reference_lookup_method, reference_lookup_distance_ms,
       reference_tolerance_ms, reference_freshness_status,
       fill_vs_bid, fill_vs_ask, fill_vs_midpoint,
       fill_vs_last, spread_at_reference_value, spread_at_reference_bps,
       slippage_value, slippage_bps, slippage_basis,
       time_intent_to_submission_ms, time_proposal_to_submission_ms,
       time_to_first_fill_ms, time_to_full_fill_ms,
       time_first_fill_to_close_ms, realized_pnl,
       realized_return, unrealized_return_checkpoints,
       maximum_favorable_excursion, maximum_adverse_excursion,
       excursion_source, excursion_start, excursion_end, holding_period_ms,
       join_status, join_methods,
       partial_join_reasons, missing_join_reasons, ambiguous_join_reasons,
       unsupported_join_reasons, metric_limitations, paper_limitations,
       source_watermark, calculated_at, schema_version, content_hash
     FROM outcome_learning_records
     WHERE proposed_at >= $1
       AND proposed_at < $2
       AND environment = $3
       AND ($4::text IS NULL OR lane = $4)
       AND ($5::text IS NULL OR candidate_id = $5)
     ORDER BY proposed_at DESC, outcome_id
     LIMIT $6`,
    [
      range.start,
      range.end,
      environment,
      input.lane ?? null,
      input.candidateId ?? null,
      limit
    ]
  );
  return result.rows;
};

export const readBoundedHistoricalOutcomeAggregates = async (input: {
  query: OutcomeLearningQueryExecutor;
  start: string;
  end: string;
  environment?: OutcomeEnvironment;
  lane?: string;
  limit?: number;
}) => {
  const range = parseRange(input.start, input.end);
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("OUTCOME_LEARNING_QUERY_LIMIT_OUT_OF_BOUNDS");
  }
  const environment = input.environment ?? "paper";
  if (!["paper", "live", "unknown"].includes(environment)) {
    throw new Error("OUTCOME_LEARNING_ENVIRONMENT_INVALID");
  }
  const allowedLanes = ["equity", "options_0dte", "options_leaps", "unknown"];
  if (input.lane && !allowedLanes.includes(input.lane)) {
    throw new Error("OUTCOME_LEARNING_LANE_INVALID");
  }
  const result = await input.query.query(
    `SELECT *
     FROM historical_outcome_aggregates
     WHERE date_range_start = $1
       AND date_range_end = $2
       AND environment = $3
       AND ($4::text IS NULL OR lane = $4)
     ORDER BY lane, dimension, grouping_key
     LIMIT $5`,
    [
      range.start,
      range.end,
      environment,
      input.lane ?? null,
      limit
    ]
  );
  return result.rows;
};
