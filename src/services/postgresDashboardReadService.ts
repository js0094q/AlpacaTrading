import type { QueryResult } from "pg";

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

const objectValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

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

  const lastEventAt = textValue(row.occurred_at);
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
    lastCycleCompletedAt: textValue(row.last_cycle_completed_at)
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
              intent.status AS intent_status,
              COALESCE(
                intent.request_payload->>'terminalReasonCode',
                intent.request_payload->>'recoveryReason',
                intent.request_payload #>> '{staleReadyRecovery,reason}'
              ) AS intent_terminal_reason,
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
              COALESCE(
                intent.request_payload->>'terminalReasonCode',
                intent.request_payload->>'recoveryReason',
                intent.request_payload #>> '{staleReadyRecovery,reason}'
              ) AS intent_terminal_reason,
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
       )
       SELECT event.entity_id AS cycle_id, event.event_type,
              event.payload->>'workstream' AS workstream,
              CASE WHEN event.payload->>'position' ~ '^[0-9]+$'
                THEN (event.payload->>'position')::integer ELSE NULL END AS position,
              CASE
                WHEN event.event_type = 'cycle_completed' THEN 'success'
                WHEN event.event_type = 'cycle_failed'
                  THEN COALESCE(event.payload->>'classification', 'blocked')
                ELSE event.payload->>'classification'
              END AS classification,
              COALESCE(event.payload->>'reasonCode', event.payload->>'code')
                AS reason_code,
              CASE WHEN event.payload->>'durationMs' ~ '^[0-9]+(\\.[0-9]+)?$'
                THEN (event.payload->>'durationMs')::numeric ELSE NULL END
                AS duration_ms,
              event.occurred_at
       FROM workstream_events event
       JOIN latest_terminal terminal ON terminal.entity_id = event.entity_id
       WHERE event.workstream = 'autonomous_worker'
         AND event.event_type IN (
           'workstream_completed', 'workstream_failed',
           'cycle_completed', 'cycle_failed'
         )
       ORDER BY position NULLS LAST, event.occurred_at, event.event_id
       LIMIT $1`,
      [Math.max(21, boundedLimit)]
    ),
    query.query(
      `SELECT COUNT(*) AS ready_count
       FROM order_intents
       WHERE status = 'ready_for_submission' AND environment = 'paper'`,
      []
    )
  ]);
  return {
    latestResearch: research.rows,
    latestPaperPlans: plans.rows,
    reviews: reviews.rows,
    orderIntents: intents.rows,
    executions: orders.rows,
    optionContracts: options.rows,
    autonomousLifecycle: lifecycle.rows,
    readyIntentCount: integerValue(readyIntents.rows[0]?.ready_count),
    requestIds: research.rows
      .map((row) => textValue(row.request_id))
      .filter((value): value is string => Boolean(value))
  };
};
