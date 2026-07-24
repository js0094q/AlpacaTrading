import { canonicalJsonHash } from "../lib/canonicalJson.js";
import type { SchedulerFence } from "../repositories/contracts/common.js";
import { stableRecordId } from "../repositories/postgres/postgresRepositorySupport.js";
import { getAlpacaAccountSnapshot } from "./alpacaAccountService.js";
import {
  getPaperOrder,
  getPaperOrderByClientOrderId,
  type AlpacaApiResponse,
  type AlpacaSubmittedOrder
} from "./alpacaClient.js";
import { paperSubmitConfiguration } from "./paperSubmitSafetyConfig.js";
import { lifecycleStateForBrokerStatus } from "./autonomousTradeLifecycleService.js";
import {
  capturePostgresAuthorityBrokerSnapshot,
  type PostgresAuthorityBrokerSnapshot
} from "./postgresAuthorityBrokerSnapshot.js";

type ReconciliationQuery = {
  query: (sql: string, values?: readonly unknown[]) => Promise<{
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }>;
};

type Target = Record<string, unknown> & {
  order_intent_id: string;
  candidate_id: string | null;
  account_id: string;
  client_order_id: string;
  broker_order_id: string | null;
  reservation_id: string | null;
  strategy_key: string;
  review_type: "entry" | "exit";
  symbol: string;
  asset_class: "equity" | "option";
  side: "buy" | "sell" | "buy_to_open" | "sell_to_close";
  order_type: "market" | "limit" | "stop" | "stop_limit";
  time_in_force: "day" | "gtc" | "opg" | "cls" | "ioc" | "fok";
  quantity: string | null;
  notional: string | null;
  limit_price: string | null;
  intent_status: string;
  intent_updated_at: string;
};

const fenceSql = (start: number) => `EXISTS (
  SELECT 1 FROM scheduler_leases lease
  WHERE lease.job_name = $${start} AND lease.workstream = $${start + 1}
    AND lease.owner_id = $${start + 2} AND lease.run_id = $${start + 3}
    AND lease.fencing_token = $${start + 4} AND lease.status = 'held'
    AND lease.expires_at > now()
)`;
const fenceValues = (fence: SchedulerFence) => [
  fence.jobName, fence.workstream, fence.ownerId, fence.runId, fence.fencingToken
];
const required = (value: unknown, code: string) => {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(code);
  return text;
};
const optional = (value: unknown) => value === null || value === undefined || value === ""
  ? null
  : String(value);

const targetsSql = `SELECT intent.id AS order_intent_id, intent.candidate_id,
       intent.account_id,
       intent.client_order_id, broker_order.broker_order_id,
       intent.reservation_id, intent.strategy_key, review.review_type,
       intent.symbol, intent.asset_class, intent.side, intent.order_type,
       intent.time_in_force, intent.quantity::text, intent.notional::text,
       intent.limit_price::text, intent.status AS intent_status,
       intent.updated_at::text AS intent_updated_at
FROM order_intents intent
JOIN execution_reviews review ON review.id = intent.execution_review_id
LEFT JOIN LATERAL (
  SELECT * FROM orders WHERE order_intent_id = intent.id
  ORDER BY created_at DESC, id DESC LIMIT 1
) broker_order ON true
WHERE intent.environment = 'paper'
  AND intent.status IN ('submission_pending', 'submitted', 'ambiguous')
  AND ($1 = '' OR intent.client_order_id = $1)
ORDER BY intent.created_at, intent.id`;

const terminalStatuses = new Set(["filled", "canceled", "cancelled", "expired", "rejected"]);
const BROKER_ABSENCE_TERMINAL_OBSERVATIONS = 4;
const BROKER_ABSENCE_TERMINAL_AGE_MS = 120_000;

const brokerOrderAbsent = (error: unknown) => {
  const status = Number((error as { status?: unknown } | null)?.status);
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (Number.isFinite(status)) return status === 404;
  return /\b404\b|order not found|not visible/i.test(message);
};

type ExternalOrderObservation = {
  brokerOrderId: string;
  clientOrderId: string;
  status: string;
  provenance: "external_order_without_postgres_intent";
  recorded: boolean;
};

const syncBrokerAccountAndPositions = async (input: {
  query: ReconciliationQuery;
  fence: SchedulerFence;
  snapshot: PostgresAuthorityBrokerSnapshot;
}) => {
  const snapshot = input.snapshot;
  if (
    snapshot.configuration.environment !== "paper" ||
    snapshot.configuration.tradingMode !== "paper" ||
    snapshot.configuration.liveTradingEnabled
  ) {
    throw new Error("POSTGRES_RECONCILIATION_PAPER_SNAPSHOT_REQUIRED");
  }
  const accountId = `account_${snapshot.accountIdentityHash}`;
  const account = await input.query.query(
    `INSERT INTO accounts(
       id, broker_account_id, environment, status, currency, created_at, updated_at
     ) SELECT $1, $2, 'paper', $3, $4, $5, $5
       WHERE ${fenceSql(6)}
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status, currency = EXCLUDED.currency,
       version = accounts.version + 1, updated_at = EXCLUDED.updated_at`,
    [
      accountId,
      snapshot.accountIdentityHash,
      snapshot.account.status,
      snapshot.account.currency,
      snapshot.capturedAt,
      ...fenceValues(input.fence)
    ]
  );
  if (account.rowCount !== 1) {
    throw new Error("POSTGRES_RECONCILIATION_ACCOUNT_PERSISTENCE_FAILED");
  }
  const accountSnapshotId = `snapshot_${canonicalJsonHash({
    accountId,
    capturedAt: snapshot.capturedAt,
    portfolioFingerprint: snapshot.portfolioFingerprint
  })}`;
  const evidence = {
    source: "alpaca_paper_api",
    configurationFingerprint: snapshot.configurationFingerprint,
    structuralPortfolioFingerprint: snapshot.structuralPortfolioFingerprint,
    portfolioFingerprint: snapshot.portfolioFingerprint,
    brokerOpenOrderCount: snapshot.orders.length,
    brokerPositionCount: snapshot.positions.length,
    reconciledAt: snapshot.capturedAt
  };
  const accountSnapshot = await input.query.query(
    `INSERT INTO account_snapshots(
       id, account_id, observed_at, account_status, currency, cash,
       portfolio_value, equity, buying_power, options_buying_power,
       options_approved_level, trading_blocked, account_blocked,
       snapshot_fingerprint, evidence, created_at
     ) SELECT $1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11, $12,
              $13, $14::jsonb, $3
       WHERE ${fenceSql(15)}
     ON CONFLICT (account_id, snapshot_fingerprint) DO NOTHING`,
    [
      accountSnapshotId,
      accountId,
      snapshot.capturedAt,
      snapshot.account.status,
      snapshot.account.currency,
      snapshot.account.cash,
      snapshot.account.equity,
      snapshot.account.buyingPower,
      snapshot.account.optionsBuyingPower,
      snapshot.account.optionsApprovalLevel,
      snapshot.account.tradingBlocked,
      snapshot.account.accountBlocked,
      snapshot.portfolioFingerprint,
      JSON.stringify(evidence),
      ...fenceValues(input.fence)
    ]
  );
  if (accountSnapshot.rowCount !== 0 && accountSnapshot.rowCount !== 1) {
    throw new Error("POSTGRES_RECONCILIATION_ACCOUNT_SNAPSHOT_PERSISTENCE_FAILED");
  }
  const activeKeys = snapshot.positions.map((position) => position.brokerPositionKey);
  const closed = await input.query.query(
    `UPDATE positions
     SET status = 'closed', quantity = 0, available_quantity = 0,
         closed_at = $2, last_reconciled_at = $2,
         version = version + 1, updated_at = $2
     WHERE account_id = $1 AND status IN ('open', 'closing')
       AND NOT (broker_position_key = ANY($3::text[]))
       AND ${fenceSql(4)}`,
    [accountId, snapshot.capturedAt, activeKeys, ...fenceValues(input.fence)]
  );
  if (closed.rowCount === null) {
    throw new Error("POSTGRES_RECONCILIATION_POSITION_CLOSE_FAILED");
  }
  let positionsUpserted = 0;
  for (const position of snapshot.positions) {
    const positionId = `position_${canonicalJsonHash({
      accountId,
      brokerPositionKey: position.brokerPositionKey
    })}`;
    const lineageResult = await input.query.query(
      `SELECT intent.candidate_id, broker_order.id AS opening_order_id,
              COALESCE(
                broker_order.filled_at,
                broker_order.updated_at,
                broker_order.created_at
              )::text AS opening_filled_at
       FROM orders broker_order
       JOIN order_intents intent ON intent.id = broker_order.order_intent_id
       WHERE broker_order.account_id = $1
         AND broker_order.symbol = $2
         AND broker_order.asset_class = $3
         AND broker_order.status IN ('filled', 'partially_filled')
         AND COALESCE(
           broker_order.filled_at,
           broker_order.updated_at,
           broker_order.created_at
         ) <= $5::timestamptz
         AND ABS(
           broker_order.filled_quantity - $6::numeric
         ) <= 0.000000000001
         AND ABS(
           broker_order.filled_average_price - $7::numeric
         ) <= 0.00000001
         AND COALESCE(
           broker_order.filled_at,
           broker_order.updated_at,
           broker_order.created_at
         ) > COALESCE(
           (
             SELECT existing_position.closed_at
             FROM positions existing_position
             WHERE existing_position.account_id = $1
               AND existing_position.broker_position_key = $8
           ),
           '-infinity'::timestamptz
         )
         AND (
           ($4 = 'long' AND intent.side IN ('buy', 'buy_to_open'))
           OR ($4 = 'short' AND intent.side = 'sell'
               AND intent.asset_class = 'equity')
         )
       ORDER BY COALESCE(
         broker_order.filled_at,
         broker_order.updated_at,
         broker_order.created_at
       ) DESC, broker_order.id DESC
       LIMIT 1`,
      [
        accountId,
        position.optionSymbol ?? position.symbol,
        position.assetClass,
        position.side,
        snapshot.capturedAt,
        position.quantity,
        position.averageEntryPrice,
        position.brokerPositionKey
      ]
    );
    const lineage = lineageResult.rows[0];
    const candidateId = optional(lineage?.candidate_id);
    const openingOrderId = optional(lineage?.opening_order_id);
    const openingFilledAt =
      optional(lineage?.opening_filled_at) ?? snapshot.capturedAt;
    const stored = await input.query.query(
      `INSERT INTO positions(
         id, account_id, broker_position_key, candidate_id, opening_order_id,
         closing_order_id, symbol, underlying_symbol, option_symbol,
         asset_class, side, status, quantity, available_quantity,
         average_entry_price, current_price, market_value, cost_basis,
         unrealized_pnl, source_account_snapshot_id, opened_at,
         last_reconciled_at, created_at, updated_at
       ) SELECT $1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10, 'open',
                $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $20, $20
         WHERE ${fenceSql(21)}
       ON CONFLICT (account_id, broker_position_key) DO UPDATE SET
         candidate_id = CASE
           WHEN positions.status = 'closed' THEN EXCLUDED.candidate_id
           ELSE COALESCE(positions.candidate_id, EXCLUDED.candidate_id)
         END,
         opening_order_id = CASE
           WHEN positions.status = 'closed' THEN EXCLUDED.opening_order_id
           ELSE COALESCE(positions.opening_order_id, EXCLUDED.opening_order_id)
         END,
         symbol = EXCLUDED.symbol,
         underlying_symbol = EXCLUDED.underlying_symbol,
         option_symbol = EXCLUDED.option_symbol,
         asset_class = EXCLUDED.asset_class,
         side = EXCLUDED.side,
         status = 'open',
         quantity = EXCLUDED.quantity,
         available_quantity = EXCLUDED.available_quantity,
         average_entry_price = EXCLUDED.average_entry_price,
         current_price = EXCLUDED.current_price,
         market_value = EXCLUDED.market_value,
         cost_basis = EXCLUDED.cost_basis,
         unrealized_pnl = EXCLUDED.unrealized_pnl,
         source_account_snapshot_id = EXCLUDED.source_account_snapshot_id,
         opened_at = CASE
           WHEN positions.status = 'closed' THEN EXCLUDED.opened_at
           ELSE positions.opened_at
         END,
         closed_at = NULL,
         last_reconciled_at = EXCLUDED.last_reconciled_at,
         version = positions.version + 1,
         updated_at = EXCLUDED.updated_at`,
      [
        positionId,
        accountId,
        position.brokerPositionKey,
        candidateId,
        openingOrderId,
        position.symbol,
        position.underlyingSymbol,
        position.optionSymbol,
        position.assetClass,
        position.side,
        position.quantity,
        position.availableQuantity,
        position.averageEntryPrice,
        position.currentPrice,
        position.marketValue,
        position.costBasis,
        position.unrealizedPnl,
        accountSnapshotId,
        openingFilledAt,
        snapshot.capturedAt,
        ...fenceValues(input.fence)
      ]
    );
    if (stored.rowCount !== 1) {
      throw new Error("POSTGRES_RECONCILIATION_POSITION_PERSISTENCE_FAILED");
    }
    positionsUpserted += 1;
  }
  return {
    accountId,
    accountSnapshotId,
    accountSnapshotStored: accountSnapshot.rowCount === 1,
    positionsObserved: snapshot.positions.length,
    positionsUpserted
  };
};

export const persistPostgresAuthorityBrokerSnapshot = syncBrokerAccountAndPositions;

const recordBrokerOrderAbsence = async (input: {
  query: ReconciliationQuery;
  fence: SchedulerFence;
  target: Target;
  now: Date;
}) => {
  const observed = await input.query.query(
    `SELECT
       COUNT(*) FILTER (
         WHERE event_type = 'order_submission_absence'
       )::text AS prior_absence_count,
       COALESCE(
         MIN(occurred_at) FILTER (
           WHERE event_type = 'order_submission_attempt'
         ),
         $3::timestamptz
       )::text AS first_attempt_at
     FROM broker_events
     WHERE order_intent_id = $1 AND client_order_id = $2
       AND event_type IN (
         'order_submission_attempt', 'order_submission_absence'
       )`,
    [
      input.target.order_intent_id,
      input.target.client_order_id,
      input.target.intent_updated_at
    ]
  );
  const priorAbsenceCount = Number(
    observed.rows[0]?.prior_absence_count ?? 0
  );
  const firstAttemptAt = Date.parse(String(
    observed.rows[0]?.first_attempt_at ?? input.target.intent_updated_at
  ));
  if (
    !Number.isSafeInteger(priorAbsenceCount) ||
    priorAbsenceCount < 0 ||
    !Number.isFinite(firstAttemptAt)
  ) {
    throw new Error("POSTGRES_BROKER_ABSENCE_EVIDENCE_INVALID");
  }
  const observation = priorAbsenceCount + 1;
  const terminal = observation >= BROKER_ABSENCE_TERMINAL_OBSERVATIONS &&
    input.now.getTime() - firstAttemptAt >= BROKER_ABSENCE_TERMINAL_AGE_MS;
  const evidence = {
    code: terminal
      ? "POSTGRES_BROKER_SUBMISSION_ABSENCE_CONFIRMED"
      : "POSTGRES_BROKER_SUBMISSION_RECOVERY_PENDING",
    clientOrderId: input.target.client_order_id,
    observation,
    requiredObservations: BROKER_ABSENCE_TERMINAL_OBSERVATIONS,
    firstAttemptAt: new Date(firstAttemptAt).toISOString(),
    terminalAfterMs: BROKER_ABSENCE_TERMINAL_AGE_MS
  };
  const eventId = `broker_event_${stableRecordId(
    "alpaca_broker_submission_absence",
    `${input.target.account_id}:${input.target.client_order_id}:${observation}`
  )}`;
  if (!terminal) {
    const event = await input.query.query(
      `INSERT INTO broker_events(
         event_id, account_id, order_intent_id, client_order_id,
         event_type, event_status, error_classification, retryable,
         response_payload, response_fingerprint, occurred_at, received_at
       ) SELECT $1, $2, $3, $4, 'order_submission_absence', 'pending',
                'broker_order_not_found', true, $5::jsonb, $6, $7, $7
         WHERE ${fenceSql(8)}
       ON CONFLICT (event_id) DO NOTHING`,
      [
        eventId,
        input.target.account_id,
        input.target.order_intent_id,
        input.target.client_order_id,
        JSON.stringify(evidence),
        canonicalJsonHash(evidence),
        input.now.toISOString(),
        ...fenceValues(input.fence)
      ]
    );
    if (event.rowCount !== 0 && event.rowCount !== 1) {
      throw new Error("POSTGRES_BROKER_ABSENCE_PERSISTENCE_FAILED");
    }
    return { status: "pending" as const, observation };
  }

  const terminalized = await input.query.query(
    `WITH absence_event AS (
       INSERT INTO broker_events(
         event_id, account_id, order_intent_id, client_order_id,
         event_type, event_status, error_classification, retryable,
         response_payload, response_fingerprint, occurred_at, received_at
       ) SELECT $1, $2, $3, $4, 'order_submission_absence', 'terminal',
                'broker_order_absence_confirmed', false, $5::jsonb, $6, $7, $7
         WHERE ${fenceSql(8)}
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id
     ), failed_intent AS (
       UPDATE order_intents intent
       SET status = 'failed', terminal_at = $7, updated_at = $7,
           version = intent.version + 1
       WHERE intent.id = $3
         AND intent.status IN ('submission_pending', 'ambiguous')
         AND EXISTS (SELECT 1 FROM absence_event)
         AND ${fenceSql(8)}
       RETURNING intent.reservation_id
     ), released AS (
       UPDATE buying_power_reservations reservation
       SET status = 'released', released_at = $7,
           release_reason = 'broker_order_absence_confirmed',
           updated_at = $7, version = reservation.version + 1
       FROM failed_intent
       WHERE reservation.id = failed_intent.reservation_id
         AND reservation.status IN ('active', 'committed')
         AND ${fenceSql(8)}
       RETURNING reservation.account_id, reservation.strategy_key,
                 reservation.amount
     ), adjusted AS (
       UPDATE strategy_allocations allocation
       SET reserved_amount = GREATEST(
             0, allocation.reserved_amount - released.amount
           ),
           updated_at = $7, version = allocation.version + 1
       FROM released
       WHERE allocation.account_id = released.account_id
         AND allocation.strategy_key = released.strategy_key
         AND allocation.status = 'active' AND allocation.effective_to IS NULL
       RETURNING allocation.id
     )
     SELECT
       (SELECT COUNT(*) FROM failed_intent)::text AS failed_intent_count,
       (SELECT COUNT(*) FROM released)::text AS released_reservation_count,
       (SELECT COUNT(*) FROM adjusted)::text AS adjusted_allocation_count`,
    [
      eventId,
      input.target.account_id,
      input.target.order_intent_id,
      input.target.client_order_id,
      JSON.stringify(evidence),
      canonicalJsonHash(evidence),
      input.now.toISOString(),
      ...fenceValues(input.fence)
    ]
  );
  const row = terminalized.rows[0] ?? {};
  const failedIntentCount = Number(row.failed_intent_count ?? 0);
  const releasedReservationCount = Number(
    row.released_reservation_count ?? 0
  );
  const adjustedAllocationCount = Number(
    row.adjusted_allocation_count ?? 0
  );
  const reservationExpected = Boolean(input.target.reservation_id);
  if (
    failedIntentCount !== 1 ||
    releasedReservationCount !== (reservationExpected ? 1 : 0) ||
    adjustedAllocationCount !== (reservationExpected ? 1 : 0)
  ) {
    throw new Error("POSTGRES_BROKER_ABSENCE_TERMINALIZATION_FAILED");
  }
  if (input.target.candidate_id) {
    const candidate = await input.query.query(
      `UPDATE candidates
       SET lifecycle_status = 'execution_deferred',
           decision_reason = 'POSTGRES_BROKER_SUBMISSION_ABSENCE_CONFIRMED',
           updated_at = $2, version = version + 1
       WHERE id = $1 AND decision = 'selected' AND ${fenceSql(3)}`,
      [
        input.target.candidate_id,
        input.now.toISOString(),
        ...fenceValues(input.fence)
      ]
    );
    if (candidate.rowCount !== 1) {
      throw new Error("POSTGRES_BROKER_ABSENCE_CANDIDATE_PERSISTENCE_FAILED");
    }
  }
  return { status: "failed" as const, observation };
};

const observeExternalBrokerOrder = async (input: {
  query: ReconciliationQuery;
  fence: SchedulerFence;
  brokerOrderId: string;
  now: Date;
  getAccountSnapshot: () => Promise<{ id?: string }>;
  getOrderById: (orderId: string) => Promise<AlpacaApiResponse<AlpacaSubmittedOrder>>;
  safety: { environment: string; tradingMode: string; liveTradingEnabled: boolean };
}): Promise<ExternalOrderObservation> => {
  if (
    input.safety.environment !== "paper" ||
    input.safety.tradingMode !== "paper" ||
    input.safety.liveTradingEnabled
  ) {
    throw new Error("PAPER_RUNTIME_REQUIRED");
  }
  const [account, response] = await Promise.all([
    input.getAccountSnapshot(),
    input.getOrderById(input.brokerOrderId)
  ]);
  const brokerAccountId = required(account.id, "POSTGRES_EXTERNAL_ORDER_ACCOUNT_ID_MISSING");
  const accountId = `account_${canonicalJsonHash({ accountId: brokerAccountId })}`;
  const raw = response.data as unknown as Record<string, unknown>;
  const brokerOrderId = required(response.data.id, "POSTGRES_EXTERNAL_ORDER_BROKER_ID_MISSING");
  if (brokerOrderId !== input.brokerOrderId) {
    throw new Error("POSTGRES_EXTERNAL_ORDER_BROKER_IDENTITY_MISMATCH");
  }
  const clientOrderId = required(
    response.data.client_order_id,
    "POSTGRES_EXTERNAL_ORDER_CLIENT_ID_MISSING"
  );
  const status = required(response.data.status, "POSTGRES_EXTERNAL_ORDER_STATUS_MISSING").toLowerCase();
  const symbol = required(response.data.symbol, "POSTGRES_EXTERNAL_ORDER_SYMBOL_MISSING").toUpperCase();
  const assetClass = String(response.data.asset_class ?? "").toLowerCase().includes("option") ||
    /\d{6}[CP]\d{8}$/.test(symbol)
    ? "option"
    : "equity";
  const occurredAt = required(
    response.data.filled_at ?? raw.canceled_at ?? raw.cancelled_at ?? raw.expired_at ??
      response.data.updated_at ?? response.data.submitted_at,
    "POSTGRES_EXTERNAL_ORDER_TIMESTAMP_MISSING"
  );
  const occurredAtIso = new Date(occurredAt).toISOString();
  const terminalAt = optional(
    response.data.filled_at ?? raw.canceled_at ?? raw.cancelled_at ?? raw.expired_at ??
      raw.rejected_at
  );
  const identity = await input.query.query(
    `SELECT EXISTS(SELECT 1 FROM accounts WHERE id = $1 AND environment = 'paper') AS account_exists,
            EXISTS(SELECT 1 FROM order_intents
                   WHERE account_id = $1 AND client_order_id = $2) AS intent_exists,
            EXISTS(SELECT 1 FROM orders
                   WHERE account_id = $1 AND (client_order_id = $2 OR broker_order_id = $3)) AS order_exists,
            EXISTS(SELECT 1 FROM broker_events
                   WHERE account_id = $1 AND event_type = 'external_order_observed'
                     AND broker_order_id = $3 AND event_status = $4
                     AND occurred_at = $5) AS observation_exists`,
    [accountId, clientOrderId, brokerOrderId, status, occurredAtIso]
  );
  const state = identity.rows[0] ?? {};
  if (state.account_exists !== true) throw new Error("POSTGRES_EXTERNAL_ORDER_ACCOUNT_MISSING");
  if (state.intent_exists === true || state.order_exists === true) {
    throw new Error("POSTGRES_EXTERNAL_ORDER_ALREADY_AUTHORIZED");
  }
  if (state.observation_exists === true) {
    return {
      brokerOrderId,
      clientOrderId,
      status,
      provenance: "external_order_without_postgres_intent",
      recorded: false
    };
  }
  const observedOrder = {
    brokerOrderId,
    clientOrderId,
    symbol,
    assetClass,
    side: required(
      response.data.position_intent ?? response.data.side,
      "POSTGRES_EXTERNAL_ORDER_SIDE_MISSING"
    ).toLowerCase(),
    orderType: required(response.data.type, "POSTGRES_EXTERNAL_ORDER_TYPE_MISSING").toLowerCase(),
    timeInForce: required(
      response.data.time_in_force,
      "POSTGRES_EXTERNAL_ORDER_TIME_IN_FORCE_MISSING"
    ).toLowerCase(),
    status,
    quantity: optional(response.data.qty),
    notional: optional(response.data.notional),
    limitPrice: optional(response.data.limit_price),
    filledQuantity: optional(response.data.filled_qty) ?? "0",
    filledAveragePrice: optional(response.data.filled_avg_price),
    submittedAt: optional(response.data.submitted_at),
    terminalAt,
    lastBrokerUpdateAt: optional(response.data.updated_at)
  };
  const payload = {
    schemaVersion: "external-broker-order-observation-v1",
    source: "alpaca_paper_api",
    provenance: "external_order_without_postgres_intent",
    observedOrder,
    brokerResponse: raw
  };
  const eventId = `broker_event_${stableRecordId(
    "external_order_observed",
    `${accountId}:${brokerOrderId}:${status}:${occurredAtIso}`
  )}`;
  const inserted = await input.query.query(
    `INSERT INTO broker_events(
       event_id, account_id, order_id, order_intent_id, broker,
       broker_order_id, client_order_id, event_type, event_status,
       request_id, http_status, error_classification, retryable,
       response_payload, response_fingerprint, occurred_at, received_at
     ) SELECT $1, $2, NULL, NULL, 'alpaca', $3, $4,
              'external_order_observed', $5, $6, $7,
              'external_order_without_postgres_intent', false,
              $8::jsonb, $9, $10, $11
       WHERE NOT EXISTS(SELECT 1 FROM order_intents
                        WHERE account_id = $2 AND client_order_id = $4)
         AND NOT EXISTS(SELECT 1 FROM orders
                        WHERE account_id = $2 AND (client_order_id = $4 OR broker_order_id = $3))
         AND ${fenceSql(12)}
     ON CONFLICT (event_id) DO NOTHING`,
    [eventId, accountId, brokerOrderId, clientOrderId, status,
      response.requestId ?? null, response.status, JSON.stringify(payload),
      canonicalJsonHash(payload), occurredAtIso, input.now.toISOString(),
      ...fenceValues(input.fence)]
  );
  if (inserted.rowCount !== 1) {
    throw new Error("POSTGRES_EXTERNAL_ORDER_OBSERVATION_PERSISTENCE_FAILED");
  }
  return {
    brokerOrderId,
    clientOrderId,
    status,
    provenance: "external_order_without_postgres_intent",
    recorded: true
  };
};

export const reconcilePostgresPaperOrders = async (input: {
  query: ReconciliationQuery;
  fence: SchedulerFence;
  now?: Date;
  getOrderByClientOrderId?: (
    clientOrderId: string
  ) => Promise<AlpacaApiResponse<AlpacaSubmittedOrder>>;
  externalBrokerOrderId?: string;
  getOrderById?: (orderId: string) => Promise<AlpacaApiResponse<AlpacaSubmittedOrder>>;
  getAccountSnapshot?: () => Promise<{ id?: string }>;
  safety?: { environment: string; tradingMode: string; liveTradingEnabled: boolean };
  syncBrokerState?: boolean;
  captureBrokerSnapshot?: (
    capturedAt?: string
  ) => Promise<PostgresAuthorityBrokerSnapshot>;
  clientOrderId?: string;
}) => {
  const now = input.now ?? new Date();
  const externalObservation = input.externalBrokerOrderId
    ? await observeExternalBrokerOrder({
        query: input.query,
        fence: input.fence,
        brokerOrderId: input.externalBrokerOrderId,
        now,
        getAccountSnapshot: input.getAccountSnapshot ?? getAlpacaAccountSnapshot,
        getOrderById: input.getOrderById ?? getPaperOrder,
        safety: input.safety ?? paperSubmitConfiguration()
      })
    : null;
  const listed = await input.query.query(
    targetsSql,
    [String(input.clientOrderId ?? "").trim()]
  );
  const targets = listed.rows as Target[];
  const result = {
    status: "reconciled" as const,
    externalObservation,
    checked: 0,
    recorded: 0,
    replayed: 0,
    filled: 0,
    partial: 0,
    terminal: 0,
    pending: 0,
    failedAbsent: 0,
    brokerState: null as Awaited<ReturnType<typeof syncBrokerAccountAndPositions>> | null,
    orders: [] as Array<{
      orderId: string;
      orderIntentId: string;
      brokerOrderId: string;
      clientOrderId: string;
      status: string;
    }>,
    errors: [] as Array<{ orderIntentId: string; code: string }>
  };
  const lookup = input.getOrderByClientOrderId ?? getPaperOrderByClientOrderId;
  for (const target of targets) {
    result.checked += 1;
    try {
      const response = await lookup(target.client_order_id);
      const brokerId = required(response.data.id, "POSTGRES_RECONCILIATION_BROKER_ID_MISSING");
      const clientId = required(response.data.client_order_id, "POSTGRES_RECONCILIATION_CLIENT_ID_MISSING");
      if (clientId !== target.client_order_id || (target.broker_order_id && brokerId !== target.broker_order_id)) {
        throw new Error("POSTGRES_RECONCILIATION_BROKER_IDENTITY_MISMATCH");
      }
      const status = required(response.data.status, "POSTGRES_RECONCILIATION_STATUS_MISSING").toLowerCase();
      const raw = response.data as unknown as Record<string, unknown>;
      const occurredAt = required(
        response.data.filled_at ?? raw.canceled_at ?? raw.cancelled_at ?? raw.expired_at ??
        response.data.updated_at ?? response.data.submitted_at ?? now.toISOString(),
        "POSTGRES_RECONCILIATION_TIMESTAMP_MISSING"
      );
      const orderId = `order_${stableRecordId("alpaca_order", `${target.account_id}:${brokerId}`)}`;
      const stored = await input.query.query(
        `INSERT INTO orders(
           id, account_id, order_intent_id, broker_order_id, client_order_id,
           environment, symbol, asset_class, side, order_type, time_in_force,
           status, quantity, notional, limit_price, filled_quantity,
           filled_average_price, broker_request_id, submitted_at,
           last_broker_update_at, raw_status, created_at, updated_at
         ) SELECT $1, $2, $3, $4, $5, 'paper', $6, $7, $8, $9, $10, $11,
                  $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $19, $19
           WHERE ${fenceSql(21)}
         ON CONFLICT (account_id, client_order_id) DO UPDATE SET
           broker_order_id = EXCLUDED.broker_order_id,
           status = EXCLUDED.status, quantity = EXCLUDED.quantity,
           notional = EXCLUDED.notional, limit_price = EXCLUDED.limit_price,
           filled_quantity = EXCLUDED.filled_quantity,
           filled_average_price = EXCLUDED.filled_average_price,
           broker_request_id = EXCLUDED.broker_request_id,
           last_broker_update_at = EXCLUDED.last_broker_update_at,
           raw_status = EXCLUDED.raw_status, version = orders.version + 1,
           updated_at = EXCLUDED.updated_at`,
        [orderId, target.account_id, target.order_intent_id, brokerId, clientId,
          required(response.data.symbol ?? target.symbol, "POSTGRES_RECONCILIATION_SYMBOL_MISSING"),
          target.asset_class, target.side, target.order_type, target.time_in_force,
          status, optional(response.data.qty ?? target.quantity),
          optional(response.data.notional ?? target.notional),
          optional(response.data.limit_price ?? target.limit_price),
          optional(response.data.filled_qty) ?? "0", optional(response.data.filled_avg_price),
          response.requestId ?? null, optional(response.data.submitted_at),
          new Date(occurredAt).toISOString(), JSON.stringify(raw), ...fenceValues(input.fence)]
      );
      if (stored.rowCount !== 1) throw new Error("POSTGRES_RECONCILIATION_ORDER_PERSISTENCE_FAILED");
      const eventId = `broker_event_${stableRecordId("reconciliation", `${brokerId}:${status}:${occurredAt}`)}`;
      const event = await input.query.query(
        `INSERT INTO broker_events(
           event_id, account_id, order_id, order_intent_id, broker_order_id,
           client_order_id, event_type, event_status, request_id, http_status,
           response_payload, response_fingerprint, occurred_at, received_at
         ) SELECT $1, $2, $3, $4, $5, $6, 'reconciliation', $7, $8, $9,
                  $10::jsonb, $11, $12, $13
           WHERE ${fenceSql(14)}
         ON CONFLICT (event_id) DO NOTHING`,
        [eventId, target.account_id, orderId, target.order_intent_id, brokerId,
          clientId, status, response.requestId ?? null, response.status,
          JSON.stringify(raw), canonicalJsonHash(raw), new Date(occurredAt).toISOString(),
          now.toISOString(), ...fenceValues(input.fence)]
      );
      const intentStatus = terminalStatuses.has(status) ? "reconciled" : "submitted";
      const lifecycleState = lifecycleStateForBrokerStatus(target.review_type, status);
      const updated = await input.query.query(
        `UPDATE order_intents SET status = $2,
           lifecycle_state = $5,
           submitted_at = COALESCE(submitted_at, $3),
           terminal_at = CASE WHEN $2 = 'reconciled' THEN $4 ELSE terminal_at END,
           updated_at = $4, version = version + 1
         WHERE id = $1 AND status IN ('submission_pending','submitted','ambiguous')
           AND ${fenceSql(6)}`,
        [target.order_intent_id, intentStatus, optional(response.data.submitted_at) ?? now.toISOString(),
          now.toISOString(), lifecycleState, ...fenceValues(input.fence)]
      );
      if (updated.rowCount !== 1) throw new Error("POSTGRES_RECONCILIATION_INTENT_PERSISTENCE_FAILED");
      if (terminalStatuses.has(status) && target.reservation_id) {
        const reservationTerminalState = status === "canceled"
          ? "cancelled"
          : status;
        const reservationReleaseReason = status === "filled"
          ? "broker_terminal_filled"
          : status === "canceled" || status === "cancelled"
            ? "broker_terminal_cancelled"
            : status === "rejected"
              ? "broker_terminal_rejected"
              : "broker_terminal_expired";
        const terminalTransitionId = `reservation_transition_${stableRecordId(
          "reservation_terminal",
          `${target.reservation_id}:${reservationTerminalState}`
        )}`;
        const reservation = await input.query.query(
          `WITH released AS (
             UPDATE buying_power_reservations reservation
             SET status = 'released', released_at = $3,
                 release_reason = $5,
                 updated_at = $3, version = reservation.version + 1
             WHERE reservation.id = $1
               AND reservation.status IN ('active', 'committed')
               AND ${fenceSql(8)}
             RETURNING reservation.account_id, reservation.strategy_key,
                       reservation.amount
           ), adjusted AS (
             UPDATE strategy_allocations allocation
             SET reserved_amount = GREATEST(0, allocation.reserved_amount - released.amount),
                 deployed_amount = allocation.deployed_amount +
                   CASE WHEN $4 = 'filled' THEN released.amount ELSE 0 END,
                 updated_at = $3, version = allocation.version + 1
             FROM released
             WHERE allocation.account_id = released.account_id
               AND allocation.strategy_key = released.strategy_key
               AND allocation.status = 'active' AND allocation.effective_to IS NULL
             RETURNING allocation.id
           ), terminal_transition AS (
             INSERT INTO reservation_terminal_transitions(
               id, reservation_id, order_intent_id, terminal_state,
               release_reason, idempotency_key, occurred_at
             )
             SELECT $6, $1, $2, $4, $5, $7, $3 FROM released
             ON CONFLICT (reservation_id) DO NOTHING
             RETURNING id
           )
           SELECT
             (SELECT COUNT(*) FROM released)::text AS released_reservation_count,
             (SELECT COUNT(*) FROM adjusted)::text AS adjusted_allocation_count,
             (SELECT COUNT(*) FROM terminal_transition)::text AS terminal_transition_count`,
          [
            target.reservation_id,
            target.order_intent_id,
            now.toISOString(),
            reservationTerminalState,
            reservationReleaseReason,
            terminalTransitionId,
            `${target.order_intent_id}:${reservationTerminalState}`,
            ...fenceValues(input.fence)
          ]
        );
        const releasedCount = Number(
          reservation.rows[0]?.released_reservation_count ?? 0
        );
        const adjustedCount = Number(
          reservation.rows[0]?.adjusted_allocation_count ?? 0
        );
        const terminalTransitionCount = Number(
          reservation.rows[0]?.terminal_transition_count ?? 0
        );
        if (
          releasedCount !== 1 ||
          adjustedCount !== 1 ||
          terminalTransitionCount !== 1
        ) {
          throw new Error("POSTGRES_RECONCILIATION_RESERVATION_RELEASE_FAILED");
        }
      }
      if (event.rowCount === 0) result.replayed += 1;
      else result.recorded += 1;
      result.orders.push({
        orderId,
        orderIntentId: target.order_intent_id,
        brokerOrderId: brokerId,
        clientOrderId: clientId,
        status
      });
      if (status === "filled") result.filled += 1;
      else if (status === "partially_filled") result.partial += 1;
      else if (terminalStatuses.has(status)) result.terminal += 1;
    } catch (error) {
      if (
        ["submission_pending", "ambiguous"].includes(target.intent_status) &&
        brokerOrderAbsent(error)
      ) {
        try {
          const absence = await recordBrokerOrderAbsence({
            query: input.query,
            fence: input.fence,
            target,
            now
          });
          if (absence.status === "pending") result.pending += 1;
          else result.failedAbsent += 1;
          continue;
        } catch (absenceError) {
          result.errors.push({
            orderIntentId: target.order_intent_id,
            code: absenceError instanceof Error
              ? absenceError.message.split(":", 1)[0]
              : "POSTGRES_BROKER_ABSENCE_PERSISTENCE_FAILED"
          });
          continue;
        }
      }
      result.errors.push({
        orderIntentId: target.order_intent_id,
        code: error instanceof Error ? error.message.split(":", 1)[0] : "POSTGRES_RECONCILIATION_FAILED"
      });
    }
  }
  if (input.syncBrokerState !== false) {
    try {
      const snapshot = await (
        input.captureBrokerSnapshot ?? capturePostgresAuthorityBrokerSnapshot
      )(now.toISOString());
      result.brokerState = await syncBrokerAccountAndPositions({
        query: input.query,
        fence: input.fence,
        snapshot
      });
    } catch (error) {
      result.errors.push({
        orderIntentId: "__broker_state__",
        code: error instanceof Error
          ? error.message.split(":", 1)[0]
          : "POSTGRES_RECONCILIATION_BROKER_STATE_FAILED"
      });
    }
  }
  return result;
};

const boundedSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export const recoverAmbiguousPostgresSubmission = async (input: {
  query: ReconciliationQuery;
  fence: SchedulerFence;
  clientOrderId: string;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  getOrderByClientOrderId?: (
    clientOrderId: string
  ) => Promise<AlpacaApiResponse<AlpacaSubmittedOrder>>;
  syncBrokerState?: boolean;
  captureBrokerSnapshot?: (
    capturedAt?: string
  ) => Promise<PostgresAuthorityBrokerSnapshot>;
  assertFence?: () => Promise<void> | void;
}) => {
  const clientOrderId = required(
    input.clientOrderId,
    "POSTGRES_BROKER_SUBMISSION_RECOVERY_CLIENT_ID_REQUIRED"
  );
  const maxAttempts = input.maxAttempts ?? 8;
  const retryDelayMs = input.retryDelayMs ?? 500;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error("POSTGRES_BROKER_SUBMISSION_RECOVERY_POLICY_INVALID");
  }
  if (
    !Number.isSafeInteger(retryDelayMs) ||
    retryDelayMs < 0 ||
    retryDelayMs > 10_000
  ) {
    throw new Error("POSTGRES_BROKER_SUBMISSION_RECOVERY_POLICY_INVALID");
  }
  const lookup = input.getOrderByClientOrderId ?? getPaperOrderByClientOrderId;
  const sleep = input.sleep ?? boundedSleep;
  let absenceOnly = true;
  let sawAbsence = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await input.assertFence?.();
    let response: AlpacaApiResponse<AlpacaSubmittedOrder>;
    try {
      response = await lookup(clientOrderId);
    } catch (error) {
      if (brokerOrderAbsent(error)) {
        sawAbsence = true;
      } else {
        absenceOnly = false;
        const status = Number((error as { status?: unknown } | null)?.status);
        if (Number.isFinite(status) && status >= 400 && status < 500 && status !== 408 && status !== 429) {
          throw new Error("POSTGRES_BROKER_SUBMISSION_RECOVERY_DETERMINISTIC_LOOKUP_FAILED");
        }
      }
      if (attempt < maxAttempts) {
        await sleep(Math.min(retryDelayMs * (2 ** (attempt - 1)), 5_000));
      }
      continue;
    }
    const brokerOrderId = required(
      response.data.id,
      "POSTGRES_RECONCILIATION_BROKER_ID_MISSING"
    );
    const brokerStatus = required(
      response.data.status,
      "POSTGRES_RECONCILIATION_STATUS_MISSING"
    ).toLowerCase();
    if (
      required(
        response.data.client_order_id,
        "POSTGRES_RECONCILIATION_CLIENT_ID_MISSING"
      ) !== clientOrderId
    ) {
      throw new Error("POSTGRES_RECONCILIATION_BROKER_IDENTITY_MISMATCH");
    }
    await input.assertFence?.();
    const reconciliation = await reconcilePostgresPaperOrders({
      query: input.query,
      fence: input.fence,
      clientOrderId,
      getOrderByClientOrderId: async () => response,
      syncBrokerState: input.syncBrokerState,
      captureBrokerSnapshot: input.captureBrokerSnapshot
    });
    if (reconciliation.errors.length > 0) {
      throw new Error("POSTGRES_BROKER_SUBMISSION_RECOVERY_RECONCILIATION_FAILED");
    }
    const order = reconciliation.orders.find(
      (candidate) => candidate.clientOrderId === clientOrderId
    );
    if (!order) {
      throw new Error("POSTGRES_BROKER_SUBMISSION_RECOVERY_ORDER_MISSING");
    }
    return {
      status: "recovered" as const,
      attempts: attempt,
      orderId: order.orderId,
      brokerOrderId,
      brokerStatus
    };
  }
  if (!sawAbsence || !absenceOnly) {
    throw new Error("POSTGRES_BROKER_SUBMISSION_RECOVERY_INFRASTRUCTURE_UNRESOLVED");
  }
  return {
    status: "pending" as const,
    attempts: maxAttempts,
    code: "POSTGRES_BROKER_SUBMISSION_RECOVERY_PENDING" as const
  };
};
