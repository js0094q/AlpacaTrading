import type { QueryResult } from "pg";

import { redactSensitiveText } from "../lib/securityRedaction.js";

export type PostgresDashboardQuery = {
  query: (
    sql: string,
    values?: readonly unknown[]
  ) => Promise<Pick<QueryResult<Record<string, unknown>>, "rows" | "rowCount">>;
};

const numberValue = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const integerValue = (value: unknown, fallback = 0) => {
  const parsed = numberValue(value, fallback);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
};

const textValue = (value: unknown, fallback: string | null = null) => {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
};

const timestampValue = (value: unknown): string | null => {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};

const objectValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const sensitiveDashboardKey = (key: string) =>
  /(?:authorization|cookie|password|secret|token|api[_-]?key|raw[_-]?headers?|^headers?$)/i
    .test(key);

const sanitizeDashboardValue = (value: unknown): unknown => {
  if (value instanceof Date) return timestampValue(value);
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(sanitizeDashboardValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !sensitiveDashboardKey(key))
      .map(([key, entry]) => [key, sanitizeDashboardValue(entry)])
  );
};

const selectedObject = (
  value: unknown,
  fields: readonly string[]
): Record<string, unknown> | null => {
  const source = objectValue(value);
  if (Object.keys(source).length === 0) return null;
  return Object.fromEntries(fields.map((field) => [
    field,
    sanitizeDashboardValue(source[field] ?? null)
  ]));
};

const premiumDecisionEvidence = (value: unknown): Record<string, unknown> => {
  const source = objectValue(value);
  const scalarFields = [
    "sipPrice",
    "sipFreshnessStatus",
    "opraFeed",
    "bid",
    "ask",
    "spread",
    "spreadPct",
    "volume",
    "openInterest",
    "impliedVolatility",
    "delta",
    "gamma",
    "theta",
    "vega",
    "rho",
    "historicalBarCount",
    "realizedVolatility",
    "liquidityScore",
    "finalConfidence",
    "expectedReturn"
  ] as const;
  return {
    ...Object.fromEntries(
      scalarFields.map((field) => [field, sanitizeDashboardValue(source[field] ?? null)])
    ),
    historicalBarStart: timestampValue(source.historicalBarStart),
    historicalBarEnd: timestampValue(source.historicalBarEnd),
    scoreComponents: selectedObject(source.scoreComponents, [
      "confidence",
      "expectedReturn",
      "volatilityAdjusted",
      "freshness",
      "optionLiquidity",
      "riskProfile"
    ]),
    strategyClassification: selectedObject(source.strategyClassification, [
      "family",
      "daysToExpiration",
      "leapsMinDte",
      "leapsMaxDte"
    ]),
    positionSizingInput: selectedObject(source.positionSizingInput, [
      "quantity",
      "notional",
      "referencePrice",
      "allocationAmount"
    ]),
    limitPriceConstruction: selectedObject(source.limitPriceConstruction, [
      "limitPrice",
      "bid",
      "ask",
      "midpoint",
      "referencePrice"
    ])
  };
};

const RESEARCH_DASHBOARD_FIELDS = [
  "id",
  "workstream",
  "status",
  "risk_profile",
  "options_enabled",
  "request_id",
  "candidates_selected",
  "started_at",
  "completed_at",
  "created_at",
  "updated_at",
  "error_code",
  "error_message"
] as const;

const PLAN_DASHBOARD_FIELDS = [
  "id",
  "candidate_id",
  "symbol",
  "option_symbol",
  "asset_class",
  "direction",
  "preferred_expression",
  "strategy_family",
  "score",
  "confidence",
  "expected_return",
  "option_liquidity_score",
  "volatility_score",
  "decision",
  "lifecycle_status",
  "decision_reason",
  "as_of",
  "candidate_created_at",
  "candidate_updated_at",
  "review_id",
  "review_status",
  "review_created_at",
  "review_updated_at",
  "review_expires_at",
  "confirmation_id",
  "confirmation_status",
  "confirmed_at",
  "confirmation_expires_at",
  "confirmation_created_at",
  "intent_id",
  "client_order_id",
  "intent_status",
  "operation",
  "strategy_classification",
  "lifecycle_state",
  "autonomous_cycle_id",
  "workstream_execution_id",
  "parent_position_id",
  "opening_intent_id",
  "intent_terminal_reason",
  "exit_trigger",
  "lifecycle_reason_code",
  "ready_at",
  "intent_submitted_at",
  "terminal_at",
  "intent_created_at",
  "intent_updated_at",
  "reservation_id",
  "reservation_status",
  "release_reason",
  "reservation_amount",
  "reservation_expires_at",
  "reservation_released_at",
  "reservation_created_at",
  "broker_order_id",
  "broker_order_status",
  "filled_quantity",
  "filled_average_price",
  "submitted_at",
  "accepted_at",
  "filled_at",
  "cancelled_at",
  "expired_at",
  "last_broker_update_at",
  "latest_broker_event_type",
  "latest_broker_event_status",
  "latest_broker_event_at",
  "position_id",
  "position_status",
  "position_side",
  "opened_at",
  "closed_at",
  "last_reconciled_at",
  "premium_decision_evidence"
] as const;

const REVIEW_DASHBOARD_FIELDS = [
  "id",
  "review_id",
  "candidate_id",
  "review_type",
  "status",
  "environment",
  "paper_only",
  "live_trading_enabled",
  "client_order_id",
  "expires_at",
  "created_at",
  "updated_at",
  "consumed_at",
  "blockers",
  "warnings",
  "confirmation_id",
  "confirmation_status",
  "confirmed_at",
  "confirmation_expires_at",
  "confirmation_consumed_at",
  "intent_id",
  "intent_status",
  "intent_client_order_id",
  "reservation_id",
  "ready_at",
  "submitted_at",
  "terminal_at",
  "intent_created_at",
  "intent_updated_at",
  "intent_terminal_reason",
  "reservation_status",
  "release_reason",
  "reservation_expires_at",
  "reservation_released_at",
  "broker_order_id",
  "broker_order_status",
  "filled_quantity",
  "filled_average_price",
  "broker_submitted_at",
  "broker_filled_at",
  "latest_broker_event_type",
  "latest_broker_event_status",
  "latest_broker_event_at",
  "position_id",
  "position_status",
  "last_reconciled_at"
] as const;

const INTENT_DASHBOARD_FIELDS = [
  "intent_id",
  "candidate_id",
  "review_id",
  "confirmation_id",
  "confirmation_status",
  "reservation_id",
  "reservation_status",
  "release_reason",
  "reservation_expires_at",
  "reservation_released_at",
  "symbol",
  "asset_class",
  "side",
  "intent_status",
  "client_order_id",
  "operation",
  "strategy_classification",
  "lifecycle_state",
  "autonomous_cycle_id",
  "workstream_execution_id",
  "parent_position_id",
  "opening_intent_id",
  "intent_terminal_reason",
  "exit_trigger",
  "lifecycle_reason_code",
  "ready_at",
  "intent_submitted_at",
  "terminal_at",
  "intent_created_at",
  "intent_updated_at",
  "broker_order_id",
  "broker_order_status",
  "filled_quantity",
  "filled_average_price",
  "broker_submitted_at",
  "broker_filled_at",
  "latest_broker_event_type",
  "latest_broker_event_status",
  "latest_broker_event_at",
  "position_id",
  "position_status",
  "strategy_family",
  "opened_at",
  "closed_at",
  "last_reconciled_at"
] as const;

const EXECUTION_DASHBOARD_FIELDS = [
  "id",
  "broker_execution_id",
  "order_intent_id",
  "execution_review_id",
  "candidate_id",
  "reservation_id",
  "operation",
  "strategy_classification",
  "lifecycle_state",
  "autonomous_cycle_id",
  "workstream_execution_id",
  "parent_position_id",
  "opening_intent_id",
  "broker_order_id",
  "client_order_id",
  "symbol",
  "asset_class",
  "side",
  "order_type",
  "time_in_force",
  "status",
  "quantity",
  "notional",
  "filled_quantity",
  "filled_average_price",
  "submitted_at",
  "accepted_at",
  "filled_at",
  "cancelled_at",
  "expired_at",
  "last_broker_update_at",
  "updated_at",
  "latest_broker_event_type",
  "latest_broker_event_status",
  "latest_broker_event_at",
  "position_id",
  "position_status",
  "last_reconciled_at"
] as const;

const OPTION_DASHBOARD_FIELDS = [
  "option_symbol",
  "underlying_symbol",
  "type",
  "expiration_date",
  "strike",
  "multiplier",
  "tradable",
  "bid",
  "ask",
  "midpoint",
  "last",
  "volume",
  "open_interest",
  "implied_volatility",
  "delta",
  "gamma",
  "theta",
  "vega",
  "rho",
  "quote_timestamp",
  "snapshot_timestamp",
  "observed_at",
  "source",
  "requested_feed",
  "effective_feed",
  "underlying_price",
  "spread_percentage"
] as const;

const LIFECYCLE_DASHBOARD_FIELDS = [
  "row_kind",
  "cycle_scope",
  "cycle_id",
  "event_type",
  "workstream",
  "position",
  "classification",
  "reason_code",
  "duration_ms",
  "occurred_at",
  "candidate_id",
  "review_id",
  "confirmation_id",
  "intent_id",
  "parent_position_id",
  "opening_intent_id",
  "client_order_id",
  "broker_order_id",
  "broker_status",
  "operation",
  "strategy_classification",
  "lifecycle_state",
  "reservation_state",
  "reservation_release_reason",
  "position_id",
  "position_side",
  "open_quantity",
  "latest_reconciled_at",
  "autonomous_cycle_id",
  "workstream_execution_id",
  "exit_trigger",
  "lifecycle_reason_code",
  "decision_evidence"
] as const;

const normalizeDashboardRow = (
  row: Record<string, unknown>,
  allowedFields: readonly string[]
): Record<string, unknown> => {
  const normalized: Record<string, unknown> = {};
  for (const key of allowedFields) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
    const value = row[key];
    if (key === "premium_decision_evidence" || key === "decision_evidence") {
      normalized[key] = premiumDecisionEvidence(value);
      continue;
    }
    if (key === "as_of" || /(?:_at|_timestamp)$/.test(key)) {
      normalized[key] = timestampValue(value);
      continue;
    }
    normalized[key] = sanitizeDashboardValue(value);
  }
  return normalized;
};

const normalizeDashboardRows = (
  rows: Array<Record<string, unknown>>,
  allowedFields: readonly string[]
) => rows.map((row) => normalizeDashboardRow(row, allowedFields));

const newYorkDate = (now: Date) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

export type PostgresWorkerHealth = {
  status: "running" | "stopped" | "failed" | "stale" | "unknown";
  active: boolean;
  lastEventType: string | null;
  lastEventAt: string | null;
  cycleId: string | null;
  lastCycleCompletedAt: string | null;
};

export const readPostgresWorkerHealth = async (
  query: PostgresDashboardQuery,
  now = new Date()
): Promise<PostgresWorkerHealth> => {
  const result = await query.query(
    `WITH latest AS (
       SELECT event_type, entity_id, occurred_at
       FROM workstream_events
       WHERE workstream = 'autonomous_worker'
       ORDER BY occurred_at DESC, event_id DESC
       LIMIT 1
     ), completed AS (
       SELECT occurred_at
       FROM workstream_events
       WHERE workstream = 'autonomous_worker'
         AND event_type = 'cycle_completed'
       ORDER BY occurred_at DESC, event_id DESC
       LIMIT 1
     )
     SELECT latest.event_type, latest.entity_id, latest.occurred_at,
            completed.occurred_at AS last_cycle_completed_at
     FROM latest
     LEFT JOIN completed ON true`,
    []
  );
  const row = result.rows[0];
  if (!row) {
    return {
      status: "unknown",
      active: false,
      lastEventType: null,
      lastEventAt: null,
      cycleId: null,
      lastCycleCompletedAt: null
    };
  }

  const lastEventAt = timestampValue(row.occurred_at);
  const ageMs = lastEventAt ? now.getTime() - Date.parse(lastEventAt) : Number.POSITIVE_INFINITY;
  const stale = !Number.isFinite(ageMs) || ageMs > 6 * 60 * 60 * 1_000;
  const eventType = textValue(row.event_type);
  const status = stale
    ? "stale"
    : eventType === "worker_stopped"
      ? "stopped"
      : eventType === "cycle_failed" || eventType === "preflight_failed"
        ? "failed"
        : "running";

  return {
    status,
    active: status === "running",
    lastEventType: eventType,
    lastEventAt,
    cycleId: textValue(row.entity_id),
    lastCycleCompletedAt: timestampValue(row.last_cycle_completed_at)
  };
};

export type PostgresZeroDteDashboardSummary = {
  paperOnly: true;
  generatedAt: string;
  tradingDate: string | null;
  engine: {
    enabled: boolean;
    lastRunAt: string | null;
    status: string;
    queueSize: number;
    staleDataCount: number;
  };
  queue: Array<Record<string, unknown>>;
  paperPositions: Array<Record<string, unknown>>;
  shadowTrades: Array<Record<string, unknown>>;
  lifecycle: {
    counts: Record<string, number>;
    recent: Array<Record<string, unknown>>;
  };
  learning: Record<string, unknown> | null;
  blockers: string[];
};

const zeroDteQueue = async (
  query: PostgresDashboardQuery,
  tradingDate: string,
  limit: number
) => query.query(
  `WITH latest_research AS (
     SELECT id
     FROM research_runs
     WHERE status = 'completed'
     ORDER BY completed_at DESC NULLS LAST, id DESC
     LIMIT 1
   ), latest_quotes AS (
     SELECT DISTINCT ON (option_symbol)
            option_symbol, bid, ask, midpoint, volume, open_interest,
            quote_timestamp, observed_at
     FROM option_snapshots
     ORDER BY option_symbol, observed_at DESC
   )
   SELECT candidate.id AS candidate_id, candidate.rank,
          candidate.option_symbol, candidate.strategy_family,
          candidate.direction, candidate.decision, candidate.lifecycle_status,
          candidate.score, candidate.confidence, candidate.signal_inputs,
          candidate.rationale, candidate.data_quality_status,
          candidate.updated_at,
          contract.expiration_date, contract.strike,
          quote.bid, quote.ask, quote.midpoint, quote.volume,
          quote.open_interest, quote.quote_timestamp, quote.observed_at
   FROM candidates candidate
   JOIN latest_research research ON research.id = candidate.research_run_id
   LEFT JOIN option_contracts contract ON contract.option_symbol = candidate.option_symbol
   LEFT JOIN latest_quotes quote ON quote.option_symbol = candidate.option_symbol
   WHERE candidate.strategy_family = 'zero_dte_spy'
     AND candidate.symbol = 'SPY'
     AND COALESCE(contract.expiration_date::text, $1) = $1
   ORDER BY candidate.rank, candidate.updated_at DESC, candidate.id
   LIMIT $2`,
  [tradingDate, limit]
);

const zeroDtePositions = async (
  query: PostgresDashboardQuery,
  tradingDate: string,
  limit: number
) => query.query(
  `SELECT position.id, position.option_symbol, position.status,
          position.quantity, position.average_entry_price,
          position.current_price, position.unrealized_pnl,
          position.updated_at
   FROM positions position
   WHERE position.asset_class = 'option'
     AND position.status IN ('open', 'closing')
     AND position.option_symbol IS NOT NULL
     AND substring(position.option_symbol from '[0-9]{6}') = to_char($1::date, 'YYMMDD')
   ORDER BY position.updated_at DESC, position.id
   LIMIT $2`,
  [tradingDate, limit]
);

const zeroDteLifecycle = async (
  query: PostgresDashboardQuery,
  limit: number
) => query.query(
  `SELECT event_type, entity_id, occurred_at, payload
   FROM workstream_events
   WHERE workstream = 'zero_dte'
   ORDER BY occurred_at DESC, event_id DESC
   LIMIT $1`,
  [limit]
);

export const readPostgresZeroDteDashboardSummary = async (input: {
  query: PostgresDashboardQuery;
  limit?: number;
  now?: Date;
}): Promise<PostgresZeroDteDashboardSummary> => {
  const now = input.now ?? new Date();
  const tradingDate = newYorkDate(now);
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 25)));
  const [queueResult, positionResult, lifecycleResult] = await Promise.all([
    zeroDteQueue(input.query, tradingDate, limit),
    zeroDtePositions(input.query, tradingDate, limit),
    zeroDteLifecycle(input.query, limit)
  ]);

  const queue = queueResult.rows.map((row) => {
    const signalInputs = objectValue(row.signal_inputs);
    const dataQualityStatus = textValue(row.data_quality_status);
    const blockers = [
      dataQualityStatus && dataQualityStatus !== "CURRENT_POSTGRES_MARKET_EVIDENCE"
        ? dataQualityStatus
        : null,
      textValue(row.decision) === "blocked" ? "STRATEGY_DECISION_BLOCKED" : null,
      textValue(row.lifecycle_status) === "blocked" ? "CANDIDATE_LIFECYCLE_BLOCKED" : null
    ].filter((value): value is string => Boolean(value));
    const bid = row.bid === null || row.bid === undefined ? null : numberValue(row.bid, NaN);
    const ask = row.ask === null || row.ask === undefined ? null : numberValue(row.ask, NaN);
    const midpoint = row.midpoint === null || row.midpoint === undefined
      ? null
      : numberValue(row.midpoint, NaN);
    const spreadPct = bid !== null && ask !== null && Number.isFinite(bid) && Number.isFinite(ask) && midpoint && midpoint > 0
      ? ((ask - bid) / midpoint) * 100
      : null;
    return {
      candidateId: textValue(row.candidate_id),
      tradingDate,
      underlyingSymbol: "SPY",
      optionSymbol: textValue(row.option_symbol),
      playbook: textValue(signalInputs.playbook, "postgres_zero_dte") ?? "postgres_zero_dte",
      direction: textValue(row.direction),
      expirationDate: textValue(row.expiration_date, tradingDate),
      strike: row.strike === null ? null : numberValue(row.strike, NaN),
      state: textValue(row.lifecycle_status, textValue(row.decision, "blocked")) ?? "blocked",
      rank: integerValue(row.rank, 0),
      totalScore: row.score === null ? null : numberValue(row.score, NaN),
      score: row.score === null ? null : numberValue(row.score, NaN),
      confidence: row.confidence === null ? null : numberValue(row.confidence, NaN),
      signalSlope: numberValue(signalInputs.signalSlope, NaN),
      quote: {
        bid: Number.isFinite(bid) ? bid : null,
        ask: Number.isFinite(ask) ? ask : null,
        midpoint: Number.isFinite(midpoint) ? midpoint : null,
        premium: Number.isFinite(midpoint) ? midpoint : null,
        spreadPct: Number.isFinite(spreadPct) ? spreadPct : null,
        volume: row.volume === null ? null : numberValue(row.volume, NaN),
        openInterest: row.open_interest === null ? null : numberValue(row.open_interest, NaN),
        impliedVolatility: null,
        delta: null,
        gamma: null,
        theta: null,
        vega: null,
        marketTimestamp: textValue(row.quote_timestamp, textValue(row.observed_at))
      },
      blockers,
      eligible: textValue(row.decision) === "selected" && blockers.length === 0,
      executable: textValue(row.decision) === "selected" && blockers.length === 0 && Number.isFinite(midpoint),
      lastSeenAt: textValue(row.updated_at, textValue(row.observed_at))
    };
  });

  const lifecycleCounts: Record<string, number> = {};
  for (const row of lifecycleResult.rows) {
    const eventType = textValue(row.event_type, "unknown") ?? "unknown";
    lifecycleCounts[eventType] = (lifecycleCounts[eventType] ?? 0) + 1;
  }
  const latestLifecycle = lifecycleResult.rows[0];
  const blockers = queue.length === 0
    ? ["NO_CURRENT_POSTGRES_ZERO_DTE_CANDIDATES"]
    : queue.flatMap((candidate) => candidate.blockers as string[]).filter(Boolean);

  return {
    paperOnly: true,
    generatedAt: now.toISOString(),
    tradingDate,
    engine: {
      enabled: true,
      lastRunAt: textValue(latestLifecycle?.occurred_at),
      status: queue.length === 0 ? "blocked" : blockers.length > 0 ? "blocked" : "completed",
      queueSize: queue.length,
      staleDataCount: queue.filter((candidate) => candidate.blockers.length > 0).length
    },
    queue,
    paperPositions: positionResult.rows.map((row) => ({
      paperTradeId: textValue(row.id),
      optionSymbol: textValue(row.option_symbol),
      status: textValue(row.status),
      playbook: "postgres_zero_dte",
      quantity: numberValue(row.quantity, 0),
      entryPremium: row.average_entry_price === null ? null : numberValue(row.average_entry_price, NaN),
      currentMark: row.current_price === null ? null : numberValue(row.current_price, NaN),
      unrealizedPnl: row.unrealized_pnl === null ? null : numberValue(row.unrealized_pnl, NaN)
    })),
    shadowTrades: [],
    lifecycle: {
      counts: lifecycleCounts,
      recent: lifecycleResult.rows.map((row) => ({
        eventType: textValue(row.event_type),
        entityId: textValue(row.entity_id),
        occurredAt: textValue(row.occurred_at),
        payload: objectValue(row.payload)
      }))
    },
    learning: null,
    blockers
  };
};

export const readPostgresDashboardData = async (
  query: PostgresDashboardQuery,
  limit = 25
) => {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const [
    research,
    plans,
    reviews,
    intents,
    orders,
    options,
    lifecycle,
    readyIntents
  ] = await Promise.all([
    query.query(
      `SELECT research.id, research.workstream, research.status,
              research.risk_profile, research.options_enabled,
              research.request_id, research.candidates_selected,
              research.started_at, research.completed_at, research.created_at,
              research.updated_at, research.error_code, research.error_message
       FROM research_runs research
       ORDER BY research.created_at DESC, research.id DESC
       LIMIT $1`,
      [boundedLimit]
    ),
    query.query(
      `SELECT candidate.id, candidate.id AS candidate_id, candidate.symbol,
              candidate.option_symbol, candidate.asset_class, candidate.direction,
              candidate.preferred_expression, candidate.strategy_family,
              candidate.score, candidate.confidence, candidate.expected_return,
              candidate.option_liquidity_score, candidate.volatility_score,
              candidate.decision, candidate.lifecycle_status,
              candidate.decision_reason, candidate.as_of,
              candidate.created_at AS candidate_created_at,
              candidate.updated_at AS candidate_updated_at,
              review.id AS review_id, review.status AS review_status,
              review.created_at AS review_created_at,
              review.updated_at AS review_updated_at,
              review.expires_at AS review_expires_at,
              confirmation.id AS confirmation_id,
              confirmation.status AS confirmation_status,
              confirmation.confirmed_at, confirmation.expires_at AS confirmation_expires_at,
              confirmation.created_at AS confirmation_created_at,
              intent.id AS intent_id, intent.client_order_id,
              intent.status AS intent_status, intent.operation,
              intent.strategy_classification, intent.lifecycle_state,
              intent.autonomous_cycle_id, intent.workstream_execution_id,
              intent.parent_position_id, intent.opening_intent_id,
              COALESCE(
                intent.request_payload->>'terminalReasonCode',
                intent.request_payload->>'recoveryReason',
                intent.request_payload #>> '{staleReadyRecovery,reason}'
              ) AS intent_terminal_reason,
              COALESCE(
                review.portfolio_evidence #>> '{trigger,reason}',
                intent.request_payload->>'exitTrigger'
              ) AS exit_trigger,
              COALESCE(
                intent.request_payload->>'reasonCode',
                review.portfolio_evidence #>> '{trigger,reason}',
                candidate.decision_reason
              ) AS lifecycle_reason_code,
              intent.ready_at, intent.submitted_at AS intent_submitted_at,
              intent.terminal_at, intent.created_at AS intent_created_at,
              intent.updated_at AS intent_updated_at,
              reservation.id AS reservation_id,
              reservation.status AS reservation_status,
              reservation.release_reason, reservation.amount AS reservation_amount,
              reservation.expires_at AS reservation_expires_at,
              reservation.released_at AS reservation_released_at,
              reservation.created_at AS reservation_created_at,
              order_row.broker_order_id, order_row.status AS broker_order_status,
              order_row.filled_quantity, order_row.filled_average_price,
              order_row.submitted_at, order_row.accepted_at, order_row.filled_at,
              order_row.cancelled_at, order_row.expired_at,
              order_row.last_broker_update_at,
              broker_event.event_type AS latest_broker_event_type,
              broker_event.event_status AS latest_broker_event_status,
              broker_event.occurred_at AS latest_broker_event_at,
              position.id AS position_id, position.status AS position_status,
              position.side AS position_side, position.opened_at,
              position.closed_at, position.last_reconciled_at,
              jsonb_build_object(
                'sipPrice', candidate.signal_inputs #> '{marketDecisionInputs,currentTradablePrice}',
                'sipFreshnessStatus', candidate.signal_inputs #> '{marketDecisionInputs,stockEvidenceFreshnessStatus}',
                'opraFeed', to_jsonb(COALESCE(
                  review.market_evidence->0->>'effectiveFeed',
                  candidate.signal_inputs #>> '{marketDecisionInputs,option,feed}'
                )),
                'bid', review.market_evidence->0->'bid',
                'ask', review.market_evidence->0->'ask',
                'spread', COALESCE(
                  review.market_evidence->0->'spread',
                  review.market_evidence->0->'spreadPct'
                ),
                'spreadPct', COALESCE(
                  review.market_evidence->0->'spreadPct',
                  candidate.signal_inputs #> '{marketDecisionInputs,option,spreadPct}'
                ),
                'volume', COALESCE(
                  review.market_evidence->0->'volume',
                  candidate.signal_inputs #> '{marketDecisionInputs,option,volume}'
                ),
                'openInterest', COALESCE(
                  review.market_evidence->0->'openInterest',
                  candidate.signal_inputs #> '{marketDecisionInputs,option,openInterest}'
                ),
                'impliedVolatility', COALESCE(
                  review.market_evidence->0->'impliedVolatility',
                  candidate.signal_inputs #> '{marketDecisionInputs,option,impliedVolatility}',
                  candidate.signal_inputs #> '{marketDecisionInputs,impliedVolatility}'
                ),
                'delta', COALESCE(
                  review.market_evidence->0->'delta',
                  candidate.signal_inputs #> '{marketDecisionInputs,option,delta}'
                ),
                'gamma', COALESCE(
                  review.market_evidence->0->'gamma',
                  candidate.signal_inputs #> '{marketDecisionInputs,option,gamma}'
                ),
                'theta', COALESCE(
                  review.market_evidence->0->'theta',
                  candidate.signal_inputs #> '{marketDecisionInputs,option,theta}'
                ),
                'vega', COALESCE(
                  review.market_evidence->0->'vega',
                  candidate.signal_inputs #> '{marketDecisionInputs,option,vega}'
                ),
                'rho', COALESCE(
                  review.market_evidence->0->'rho',
                  candidate.signal_inputs #> '{marketDecisionInputs,option,rho}'
                ),
                'historicalBarCount', to_jsonb(history.historical_bar_count),
                'historicalBarStart', to_jsonb(history.first_observed_at),
                'historicalBarEnd', to_jsonb(history.last_observed_at),
                'realizedVolatility', COALESCE(
                  candidate.signal_inputs #> '{marketDecisionInputs,realizedVolatility20}',
                  feature.features->'realizedVolatility20'
                ),
                'liquidityScore', to_jsonb(candidate.option_liquidity_score),
                'finalConfidence', to_jsonb(candidate.confidence),
                'expectedReturn', to_jsonb(candidate.expected_return),
                'scoreComponents', candidate.signal_inputs #> '{candidateScore,components}',
                'scoreInputs', candidate.signal_inputs #> '{candidateScore,inputs}',
                'strategyClassification', candidate.signal_inputs->'strategyClassification',
                'positionSizingInput', jsonb_build_object(
                  'quantity', review.order_intent->'quantity',
                  'notional', review.order_intent->'notional',
                  'referencePrice', review.market_evidence->0->'referencePrice',
                  'allocationAmount', to_jsonb(reservation.amount)
                ),
                'limitPriceConstruction', jsonb_build_object(
                  'limitPrice', review.order_intent->'limitPrice',
                  'bid', review.market_evidence->0->'bid',
                  'ask', review.market_evidence->0->'ask',
                  'midpoint', review.market_evidence->0->'midpoint',
                  'referencePrice', review.market_evidence->0->'referencePrice'
                )
              ) AS premium_decision_evidence
       FROM candidates candidate
       LEFT JOIN LATERAL (
         SELECT review.* FROM execution_reviews review
         WHERE review.candidate_id = candidate.id
         ORDER BY review.created_at DESC, review.id DESC LIMIT 1
       ) review ON true
       LEFT JOIN LATERAL (
         SELECT confirmation.* FROM confirmation_evidence confirmation
         WHERE confirmation.execution_review_id = review.id
         ORDER BY confirmation.created_at DESC, confirmation.id DESC LIMIT 1
       ) confirmation ON true
       LEFT JOIN LATERAL (
         SELECT intent.* FROM order_intents intent
         WHERE intent.candidate_id = candidate.id
         ORDER BY intent.created_at DESC, intent.id DESC LIMIT 1
       ) intent ON true
       LEFT JOIN buying_power_reservations reservation ON reservation.id = intent.reservation_id
       LEFT JOIN LATERAL (
         SELECT order_row.* FROM orders order_row
         WHERE order_row.order_intent_id = intent.id
         ORDER BY order_row.updated_at DESC, order_row.id DESC LIMIT 1
       ) order_row ON true
       LEFT JOIN LATERAL (
         SELECT broker_event.* FROM broker_events broker_event
         WHERE broker_event.order_intent_id = intent.id
         ORDER BY broker_event.occurred_at DESC, broker_event.event_id DESC LIMIT 1
       ) broker_event ON true
       LEFT JOIN LATERAL (
         SELECT position.* FROM positions position
         WHERE position.candidate_id = candidate.id
         ORDER BY position.updated_at DESC, position.id DESC LIMIT 1
       ) position ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::integer AS historical_bar_count,
                MIN(bar.observed_at) AS first_observed_at,
                MAX(bar.observed_at) AS last_observed_at
         FROM market_bars bar
         WHERE bar.symbol = candidate.symbol
           AND bar.timeframe = '1Day'
           AND bar.observed_at <= candidate.as_of
           AND bar.observed_at >= candidate.as_of - interval '365 days'
       ) history ON true
       LEFT JOIN LATERAL (
         SELECT feature_snapshot.features
         FROM feature_snapshots feature_snapshot
         WHERE feature_snapshot.symbol = candidate.symbol
           AND feature_snapshot.observed_at <= candidate.as_of
         ORDER BY feature_snapshot.observed_at DESC LIMIT 1
       ) feature ON true
       ORDER BY candidate.updated_at DESC, candidate.rank, candidate.id
       LIMIT $1`,
      [boundedLimit]
    ),
    query.query(
      `SELECT review.id, review.id AS review_id, review.candidate_id,
              review.review_type, review.status, review.environment,
              review.paper_only, review.live_trading_enabled,
              review.client_order_id, review.expires_at, review.created_at,
              review.updated_at, review.consumed_at, review.blockers, review.warnings,
              confirmation.id AS confirmation_id,
              confirmation.status AS confirmation_status,
              confirmation.confirmed_at,
              confirmation.expires_at AS confirmation_expires_at,
              confirmation.consumed_at AS confirmation_consumed_at,
              intent.id AS intent_id, intent.status AS intent_status,
              intent.client_order_id AS intent_client_order_id,
              intent.reservation_id, intent.ready_at, intent.submitted_at,
              intent.terminal_at, intent.created_at AS intent_created_at,
              intent.updated_at AS intent_updated_at,
              COALESCE(
                intent.request_payload->>'terminalReasonCode',
                intent.request_payload->>'recoveryReason',
                intent.request_payload #>> '{staleReadyRecovery,reason}'
              ) AS intent_terminal_reason,
              reservation.status AS reservation_status,
              reservation.release_reason, reservation.expires_at AS reservation_expires_at,
              reservation.released_at AS reservation_released_at,
              order_row.broker_order_id, order_row.status AS broker_order_status,
              order_row.filled_quantity, order_row.filled_average_price,
              order_row.submitted_at AS broker_submitted_at,
              order_row.filled_at AS broker_filled_at,
              broker_event.event_type AS latest_broker_event_type,
              broker_event.event_status AS latest_broker_event_status,
              broker_event.occurred_at AS latest_broker_event_at,
              position.id AS position_id, position.status AS position_status,
              position.last_reconciled_at
       FROM execution_reviews review
       LEFT JOIN LATERAL (
         SELECT confirmation.* FROM confirmation_evidence confirmation
         WHERE confirmation.execution_review_id = review.id
         ORDER BY confirmation.created_at DESC, confirmation.id DESC LIMIT 1
       ) confirmation ON true
       LEFT JOIN LATERAL (
         SELECT intent.* FROM order_intents intent
         WHERE intent.execution_review_id = review.id
         ORDER BY intent.created_at DESC, intent.id DESC LIMIT 1
       ) intent ON true
       LEFT JOIN buying_power_reservations reservation ON reservation.id = intent.reservation_id
       LEFT JOIN LATERAL (
         SELECT order_row.* FROM orders order_row
         WHERE order_row.order_intent_id = intent.id
         ORDER BY order_row.updated_at DESC, order_row.id DESC LIMIT 1
       ) order_row ON true
       LEFT JOIN LATERAL (
         SELECT broker_event.* FROM broker_events broker_event
         WHERE broker_event.order_intent_id = intent.id
         ORDER BY broker_event.occurred_at DESC, broker_event.event_id DESC LIMIT 1
       ) broker_event ON true
       LEFT JOIN LATERAL (
         SELECT position.* FROM positions position
         WHERE position.opening_order_id = order_row.id
            OR position.closing_order_id = order_row.id
         ORDER BY position.updated_at DESC, position.id DESC LIMIT 1
       ) position ON true
       ORDER BY review.created_at DESC, review.id DESC
       LIMIT $1`,
      [boundedLimit]
    ),
    query.query(
      `SELECT intent.id AS intent_id, intent.candidate_id,
              intent.execution_review_id AS review_id,
              intent.confirmation_evidence_id AS confirmation_id,
              confirmation.status AS confirmation_status,
              intent.reservation_id, reservation.status AS reservation_status,
              reservation.release_reason, reservation.expires_at AS reservation_expires_at,
              reservation.released_at AS reservation_released_at,
              intent.symbol, intent.asset_class, intent.side,
              intent.status AS intent_status, intent.client_order_id,
              intent.operation, intent.strategy_classification,
              intent.lifecycle_state, intent.autonomous_cycle_id,
              intent.workstream_execution_id, intent.parent_position_id,
              intent.opening_intent_id,
              COALESCE(
                intent.request_payload->>'terminalReasonCode',
                intent.request_payload->>'recoveryReason',
                intent.request_payload #>> '{staleReadyRecovery,reason}'
              ) AS intent_terminal_reason,
              COALESCE(
                review.portfolio_evidence #>> '{trigger,reason}',
                intent.request_payload->>'exitTrigger'
              ) AS exit_trigger,
              COALESCE(
                intent.request_payload->>'reasonCode',
                review.portfolio_evidence #>> '{trigger,reason}',
                candidate.decision_reason
              ) AS lifecycle_reason_code,
              intent.ready_at, intent.submitted_at AS intent_submitted_at,
              intent.terminal_at, intent.created_at AS intent_created_at,
              intent.updated_at AS intent_updated_at,
              COALESCE(
                order_row.broker_order_id,
                intent.request_payload #>> '{staleReadyRecovery,brokerOrderId}'
              ) AS broker_order_id,
              COALESCE(
                order_row.status,
                intent.request_payload #>> '{staleReadyRecovery,brokerStatus}'
              ) AS broker_order_status,
              order_row.filled_quantity, order_row.filled_average_price,
              order_row.submitted_at AS broker_submitted_at,
              order_row.filled_at AS broker_filled_at,
              broker_event.event_type AS latest_broker_event_type,
              broker_event.event_status AS latest_broker_event_status,
              broker_event.occurred_at AS latest_broker_event_at,
              position.id AS position_id, position.status AS position_status,
              candidate.strategy_family,
              position.opened_at, position.closed_at, position.last_reconciled_at
       FROM order_intents intent
       LEFT JOIN candidates candidate ON candidate.id = intent.candidate_id
       LEFT JOIN execution_reviews review ON review.id = intent.execution_review_id
       LEFT JOIN confirmation_evidence confirmation
         ON confirmation.id = intent.confirmation_evidence_id
       LEFT JOIN buying_power_reservations reservation
         ON reservation.id = intent.reservation_id
       LEFT JOIN LATERAL (
         SELECT order_row.* FROM orders order_row
         WHERE order_row.order_intent_id = intent.id
         ORDER BY order_row.updated_at DESC, order_row.id DESC LIMIT 1
       ) order_row ON true
       LEFT JOIN LATERAL (
         SELECT broker_event.* FROM broker_events broker_event
         WHERE broker_event.order_intent_id = intent.id
         ORDER BY broker_event.occurred_at DESC, broker_event.event_id DESC LIMIT 1
       ) broker_event ON true
       LEFT JOIN LATERAL (
         SELECT position.* FROM positions position
         WHERE position.opening_order_id = order_row.id
            OR position.closing_order_id = order_row.id
         ORDER BY position.updated_at DESC, position.id DESC LIMIT 1
       ) position ON true
       WHERE intent.environment = 'paper'
       ORDER BY intent.updated_at DESC, intent.id DESC
       LIMIT $1`,
      [boundedLimit]
    ),
    query.query(
      `SELECT order_row.id, order_row.id AS broker_execution_id,
              order_row.order_intent_id, intent.execution_review_id,
              intent.candidate_id, intent.reservation_id,
              intent.operation, intent.strategy_classification,
              intent.lifecycle_state, intent.autonomous_cycle_id,
              intent.workstream_execution_id, intent.parent_position_id,
              intent.opening_intent_id,
              order_row.broker_order_id, order_row.client_order_id,
              order_row.symbol, order_row.asset_class, order_row.side,
              order_row.order_type, order_row.time_in_force, order_row.status,
              order_row.quantity, order_row.notional,
              order_row.filled_quantity, order_row.filled_average_price,
              order_row.submitted_at, order_row.accepted_at, order_row.filled_at,
              order_row.cancelled_at, order_row.expired_at,
              order_row.last_broker_update_at, order_row.updated_at,
              broker_event.event_type AS latest_broker_event_type,
              broker_event.event_status AS latest_broker_event_status,
              broker_event.occurred_at AS latest_broker_event_at,
              position.id AS position_id, position.status AS position_status,
              position.last_reconciled_at
       FROM orders order_row
       LEFT JOIN order_intents intent ON intent.id = order_row.order_intent_id
       LEFT JOIN LATERAL (
         SELECT broker_event.* FROM broker_events broker_event
         WHERE broker_event.order_id = order_row.id
         ORDER BY broker_event.occurred_at DESC, broker_event.event_id DESC LIMIT 1
       ) broker_event ON true
       LEFT JOIN LATERAL (
         SELECT position.* FROM positions position
         WHERE position.opening_order_id = order_row.id
            OR position.closing_order_id = order_row.id
         ORDER BY position.updated_at DESC, position.id DESC LIMIT 1
       ) position ON true
       ORDER BY order_row.updated_at DESC, order_row.id DESC
       LIMIT $1`,
      [boundedLimit]
    ),
    query.query(
      `SELECT contract.option_symbol, contract.underlying_symbol,
              contract.type, contract.expiration_date, contract.strike,
              contract.multiplier,
              contract.tradable, quote.bid, quote.ask, quote.midpoint,
              quote.last, quote.volume, quote.open_interest,
              quote.implied_volatility, quote.delta, quote.gamma,
              quote.theta, quote.vega, quote.rho,
              quote.quote_timestamp, quote.snapshot_timestamp,
              quote.observed_at, quote.source,
              quote.evidence->>'requestedFeed' AS requested_feed,
              quote.evidence->>'effectiveFeed' AS effective_feed,
              quote.evidence->'underlyingPrice' AS underlying_price,
              quote.evidence->'spreadPct' AS spread_percentage
       FROM option_contracts contract
       LEFT JOIN LATERAL (
         SELECT bid, ask, midpoint, last, volume, open_interest,
                implied_volatility, delta, gamma, theta, vega, rho,
                quote_timestamp, snapshot_timestamp, observed_at,
                source, evidence
         FROM option_snapshots snapshot
         WHERE snapshot.option_symbol = contract.option_symbol
         ORDER BY snapshot.observed_at DESC
         LIMIT 1
       ) quote ON true
       ORDER BY contract.updated_at DESC, contract.option_symbol
       LIMIT $1`,
      [boundedLimit]
    ),
    query.query(
      `WITH latest_terminal AS (
         SELECT event_id, entity_id, event_type, occurred_at, payload
         FROM workstream_events
         WHERE workstream = 'autonomous_worker'
           AND event_type IN ('cycle_completed', 'cycle_failed')
         ORDER BY occurred_at DESC, event_id DESC
         LIMIT 1
       ), current_cycle AS (
         SELECT started.entity_id
         FROM workstream_events started
         WHERE started.workstream = 'autonomous_worker'
           AND started.event_type = 'cycle_started'
           AND NOT EXISTS (
             SELECT 1
             FROM workstream_events terminal
             WHERE terminal.workstream = 'autonomous_worker'
               AND terminal.entity_id = started.entity_id
               AND terminal.event_type IN (
                 'cycle_completed', 'cycle_failed', 'worker_stopped'
               )
           )
         ORDER BY started.occurred_at DESC, started.event_id DESC
         LIMIT 1
       ), interrupted_cycle AS (
         SELECT started.entity_id, stopped.occurred_at AS stopped_at
         FROM workstream_events started
         JOIN LATERAL (
           SELECT interrupted.occurred_at
           FROM workstream_events interrupted
           WHERE interrupted.workstream = 'autonomous_worker'
             AND interrupted.entity_id = started.entity_id
             AND interrupted.event_type = 'worker_stopped'
           ORDER BY interrupted.occurred_at DESC, interrupted.event_id DESC
           LIMIT 1
         ) stopped ON true
         WHERE started.workstream = 'autonomous_worker'
           AND started.event_type = 'cycle_started'
           AND NOT EXISTS (
             SELECT 1
             FROM workstream_events terminal
             WHERE terminal.workstream = 'autonomous_worker'
               AND terminal.entity_id = started.entity_id
               AND terminal.event_type IN ('cycle_completed', 'cycle_failed')
           )
         ORDER BY stopped.occurred_at DESC, started.event_id DESC
         LIMIT 1
       ), cycle_scope AS (
         SELECT current_cycle.entity_id AS cycle_id, 'current'::text AS cycle_scope
         FROM current_cycle
         UNION ALL
         SELECT interrupted_cycle.entity_id, 'interrupted'::text
         FROM interrupted_cycle
         WHERE NOT EXISTS (
           SELECT 1 FROM current_cycle
           WHERE current_cycle.entity_id = interrupted_cycle.entity_id
         )
         UNION ALL
         SELECT latest_terminal.entity_id,
                CASE
                  WHEN latest_terminal.event_type = 'cycle_completed'
                    THEN 'last_completed'::text
                  ELSE 'last_failed'::text
                END
         FROM latest_terminal
         WHERE NOT EXISTS (
           SELECT 1 FROM current_cycle
           WHERE current_cycle.entity_id = latest_terminal.entity_id
         )
           AND NOT EXISTS (
             SELECT 1 FROM interrupted_cycle
             WHERE interrupted_cycle.entity_id = latest_terminal.entity_id
           )
       ), worker_projection AS (
         SELECT 'workstream'::text AS row_kind, scope.cycle_scope,
                event.entity_id AS cycle_id, event.event_type,
                event.payload->>'workstream' AS workstream,
                CASE WHEN event.payload->>'position' ~ '^[0-9]+$'
                  THEN (event.payload->>'position')::integer ELSE NULL END AS position,
                CASE
                  WHEN event.event_type = 'cycle_completed' THEN 'success'
                  WHEN event.event_type = 'cycle_failed'
                    THEN COALESCE(event.payload->>'classification', 'blocked')
                  WHEN event.event_type = 'worker_stopped'
                    AND scope.cycle_scope = 'interrupted' THEN 'interrupted'
                  WHEN event.event_type = 'worker_stopped' THEN 'stopped'
                  WHEN event.event_type IN ('cycle_started', 'workstream_started')
                    THEN 'running'
                  ELSE event.payload->>'classification'
                END AS classification,
                COALESCE(event.payload->>'reasonCode', event.payload->>'code')
                  AS reason_code,
                CASE WHEN event.payload->>'durationMs' ~ '^[0-9]+(\\.[0-9]+)?$'
                  THEN (event.payload->>'durationMs')::numeric ELSE NULL END
                  AS duration_ms,
                event.occurred_at,
                NULL::text AS candidate_id, NULL::text AS review_id,
                NULL::text AS confirmation_id, NULL::text AS intent_id,
                NULL::text AS parent_position_id, NULL::text AS opening_intent_id,
                NULL::text AS client_order_id, NULL::text AS broker_order_id,
                NULL::text AS broker_status, NULL::text AS operation,
                NULL::text AS strategy_classification,
                NULL::text AS lifecycle_state, NULL::text AS reservation_state,
                NULL::text AS reservation_release_reason,
                NULL::text AS position_id, NULL::text AS position_side,
                NULL::text AS open_quantity,
                NULL::timestamptz AS latest_reconciled_at,
                event.entity_id AS autonomous_cycle_id,
                event.payload->>'workstreamExecutionId' AS workstream_execution_id,
                NULL::text AS exit_trigger,
                COALESCE(event.payload->>'reasonCode', event.payload->>'code')
                  AS lifecycle_reason_code,
                NULL::jsonb AS decision_evidence
         FROM workstream_events event
         JOIN cycle_scope scope ON scope.cycle_id = event.entity_id
         WHERE event.workstream = 'autonomous_worker'
           AND event.event_type IN (
             'cycle_started', 'workstream_started', 'workstream_completed',
             'workstream_failed', 'cycle_completed', 'cycle_failed',
             'worker_stopped'
           )
       ), trade_projection AS (
         SELECT 'trade_lifecycle'::text AS row_kind, scope.cycle_scope,
                intent.autonomous_cycle_id AS cycle_id,
                NULL::text AS event_type,
                intent.workstream_execution_id AS workstream,
                NULL::integer AS position,
                CASE
                  WHEN intent.lifecycle_state IN ('closed', 'cancelled') THEN 'success'
                  WHEN intent.lifecycle_state IN (
                    'rejected', 'expired', 'failed_terminal'
                  ) THEN 'blocked'
                  ELSE 'pending'
                END AS classification,
                COALESCE(
                  intent.request_payload->>'reasonCode',
                  intent.request_payload->>'terminalReasonCode',
                  review.portfolio_evidence #>> '{trigger,reason}',
                  candidate.decision_reason
                ) AS reason_code,
                NULL::numeric AS duration_ms,
                intent.updated_at AS occurred_at,
                intent.candidate_id, intent.execution_review_id AS review_id,
                intent.confirmation_evidence_id AS confirmation_id,
                intent.id AS intent_id, intent.parent_position_id,
                intent.opening_intent_id, intent.client_order_id,
                order_row.broker_order_id,
                COALESCE(
                  order_row.status,
                  broker_event.event_status
                ) AS broker_status,
                intent.operation, intent.strategy_classification,
                intent.lifecycle_state, reservation.status AS reservation_state,
                reservation.release_reason AS reservation_release_reason,
                position.id AS position_id, position.side AS position_side,
                position.quantity::text AS open_quantity,
                position.last_reconciled_at AS latest_reconciled_at,
                intent.autonomous_cycle_id, intent.workstream_execution_id,
                COALESCE(
                  review.portfolio_evidence #>> '{trigger,reason}',
                  intent.request_payload->>'exitTrigger'
                ) AS exit_trigger,
                COALESCE(
                  intent.request_payload->>'reasonCode',
                  review.portfolio_evidence #>> '{trigger,reason}',
                  candidate.decision_reason
                ) AS lifecycle_reason_code,
                jsonb_build_object(
                  'opraFeed', COALESCE(
                    review.market_evidence->0->>'effectiveFeed',
                    candidate.signal_inputs #>> '{marketDecisionInputs,option,feed}'
                  ),
                  'bid', review.market_evidence->0->'bid',
                  'ask', review.market_evidence->0->'ask',
                  'spreadPct', review.market_evidence->0->'spreadPct',
                  'volume', review.market_evidence->0->'volume',
                  'openInterest', review.market_evidence->0->'openInterest',
                  'impliedVolatility', review.market_evidence->0->'impliedVolatility',
                  'delta', review.market_evidence->0->'delta',
                  'gamma', review.market_evidence->0->'gamma',
                  'theta', review.market_evidence->0->'theta',
                  'vega', review.market_evidence->0->'vega',
                  'rho', review.market_evidence->0->'rho',
                  'finalConfidence', to_jsonb(candidate.confidence),
                  'expectedReturn', to_jsonb(candidate.expected_return),
                  'liquidityScore', to_jsonb(candidate.option_liquidity_score)
                ) AS decision_evidence
         FROM order_intents intent
         JOIN cycle_scope scope ON scope.cycle_id = intent.autonomous_cycle_id
         LEFT JOIN candidates candidate ON candidate.id = intent.candidate_id
         LEFT JOIN execution_reviews review
           ON review.id = intent.execution_review_id
         LEFT JOIN buying_power_reservations reservation
           ON reservation.id = intent.reservation_id
         LEFT JOIN LATERAL (
           SELECT broker_order.*
           FROM orders broker_order
           WHERE broker_order.order_intent_id = intent.id
           ORDER BY broker_order.updated_at DESC, broker_order.id DESC
           LIMIT 1
         ) order_row ON true
         LEFT JOIN LATERAL (
           SELECT event.event_status
           FROM broker_events event
           WHERE event.order_intent_id = intent.id
           ORDER BY event.occurred_at DESC, event.event_id DESC
           LIMIT 1
         ) broker_event ON true
         LEFT JOIN LATERAL (
           SELECT reconciled_position.*
           FROM positions reconciled_position
           WHERE reconciled_position.id = intent.parent_position_id
              OR reconciled_position.opening_order_id = order_row.id
              OR reconciled_position.closing_order_id = order_row.id
           ORDER BY reconciled_position.updated_at DESC,
                    reconciled_position.id DESC
           LIMIT 1
         ) position ON true
       )
       SELECT * FROM worker_projection
       UNION ALL
       SELECT * FROM trade_projection
       ORDER BY cycle_scope, position NULLS LAST, occurred_at, intent_id
       LIMIT $1`,
      [Math.min(200, Math.max(42, boundedLimit * 4))]
    ),
    query.query(
      `SELECT COUNT(*) AS ready_count
       FROM order_intents
       WHERE status = 'ready_for_submission' AND environment = 'paper'`,
      []
    )
  ]);
  const latestResearch = normalizeDashboardRows(
    research.rows,
    RESEARCH_DASHBOARD_FIELDS
  );
  const latestPaperPlans = normalizeDashboardRows(
    plans.rows,
    PLAN_DASHBOARD_FIELDS
  );
  const normalizedReviews = normalizeDashboardRows(
    reviews.rows,
    REVIEW_DASHBOARD_FIELDS
  );
  const orderIntents = normalizeDashboardRows(
    intents.rows,
    INTENT_DASHBOARD_FIELDS
  );
  const executions = normalizeDashboardRows(
    orders.rows,
    EXECUTION_DASHBOARD_FIELDS
  );
  const optionContracts = normalizeDashboardRows(
    options.rows,
    OPTION_DASHBOARD_FIELDS
  );
  const autonomousLifecycle = normalizeDashboardRows(
    lifecycle.rows,
    LIFECYCLE_DASHBOARD_FIELDS
  );
  return {
    latestResearch,
    latestPaperPlans,
    reviews: normalizedReviews,
    orderIntents,
    executions,
    optionContracts,
    autonomousLifecycle,
    readyIntentCount: integerValue(readyIntents.rows[0]?.ready_count),
    requestIds: latestResearch
      .map((row) => textValue(row.request_id))
      .filter((value): value is string => Boolean(value))
  };
};
