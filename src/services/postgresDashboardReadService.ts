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
  const [research, plans, reviews, orders, options, readyIntents] = await Promise.all([
    query.query(
      `SELECT id, workstream, status, risk_profile, options_enabled,
              request_id,
              candidates_selected, started_at, completed_at, error_code, error_message
       FROM research_runs
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [boundedLimit]
    ),
    query.query(
      `SELECT id, symbol, option_symbol, asset_class, direction,
              preferred_expression, strategy_family, score, confidence,
              decision, lifecycle_status, decision_reason, as_of, updated_at
       FROM candidates
       ORDER BY updated_at DESC, rank, id
       LIMIT $1`,
      [boundedLimit]
    ),
    query.query(
      `SELECT id, review_type, status, environment, paper_only,
              live_trading_enabled, client_order_id, expires_at, created_at,
              blockers, warnings
       FROM execution_reviews
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [boundedLimit]
    ),
    query.query(
      `SELECT id, broker_order_id, client_order_id, symbol, asset_class,
              side, order_type, time_in_force, status, quantity, notional,
              filled_quantity, filled_average_price, submitted_at, updated_at
       FROM orders
       ORDER BY updated_at DESC, id DESC
       LIMIT $1`,
      [boundedLimit]
    ),
    query.query(
      `SELECT contract.option_symbol, contract.underlying_symbol,
              contract.type, contract.expiration_date, contract.strike,
              contract.tradable, quote.bid, quote.ask, quote.midpoint,
              quote.last, quote.quote_timestamp, quote.observed_at
       FROM option_contracts contract
       LEFT JOIN LATERAL (
         SELECT bid, ask, midpoint, last, quote_timestamp, observed_at
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
    executions: orders.rows,
    optionContracts: options.rows,
    readyIntentCount: integerValue(readyIntents.rows[0]?.ready_count),
    requestIds: research.rows
      .map((row) => textValue(row.request_id))
      .filter((value): value is string => Boolean(value))
  };
};
