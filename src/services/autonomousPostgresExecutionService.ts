import type { QueryResult } from "pg";

import { canonicalJsonHash } from "../lib/canonicalJson.js";
import type { SchedulerFence } from "../repositories/contracts/common.js";
import { stableRecordId } from "../repositories/postgres/postgresRepositorySupport.js";
import type {
  AlpacaApiResponse,
  AlpacaPaperOrderRequest,
  AlpacaSubmittedOrder
} from "./alpacaClient.js";
import type { PostgresAuthorityBrokerSnapshot } from "./postgresAuthorityBrokerSnapshot.js";

export type AutonomousExecutionIntentRow = {
  order_intent_id: string;
  candidate_id: string | null;
  account_id: string;
  broker_account_id: string;
  account_snapshot_fingerprint: string;
  review_account_fingerprint: string;
  reservation_id: string | null;
  execution_review_id: string;
  confirmation_evidence_id: string;
  review_signature?: string | null;
  payload_fingerprint?: string | null;
  client_order_id: string;
  strategy_key: string;
  symbol: string;
  asset_class: "equity" | "option";
  side: "buy" | "sell" | "buy_to_open" | "sell_to_close";
  order_type: "market" | "limit";
  time_in_force: "day";
  quantity: string | null;
  notional: string | null;
  limit_price: string | null;
  stop_price: string | null;
  intent_version: string | number;
  market_evidence: unknown;
};

export type AutonomousExecutionBrokerSnapshot = Pick<
  PostgresAuthorityBrokerSnapshot,
  "capturedAt" | "accountIdentityHash" | "portfolioFingerprint" | "structuralPortfolioFingerprint"
> & { readonly brokerAccountId?: string };

export type AutonomousExecutionSafety = {
  readonly environment: string;
  readonly tradingMode: string;
  readonly liveTradingEnabled: boolean;
  readonly paperOrderExecutionEnabled: boolean;
  readonly paperOptionsExecutionEnabled: boolean;
  readonly quoteMaxAgeSeconds: number;
};

export type AutonomousExecutionQuery = {
  query: (
    sql: string,
    values?: readonly unknown[]
  ) => Promise<Pick<QueryResult<Record<string, unknown>>, "rows" | "rowCount">>;
};

export type AutonomousExecutionTransaction = <T>(
  operation: (query: AutonomousExecutionQuery) => Promise<T>
) => Promise<T>;

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const positive = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const marketEvidence = (
  value: unknown,
  symbol: string
): { referencePrice: number; timestamp: string } | null => {
  const visit = (entry: unknown): { referencePrice: number; timestamp: string } | null => {
    if (Array.isArray(entry)) {
      for (const item of entry) {
        const found = visit(item);
        if (found) return found;
      }
      return null;
    }
    if (!entry || typeof entry !== "object") return null;
    const record = entry as Record<string, unknown>;
    const entrySymbol = text(record.symbol || record.optionSymbol || record.underlyingSymbol).toUpperCase();
    const price = positive(record.referencePrice ?? record.marketReferencePrice ?? record.price);
    const timestamp = text(
      record.timestamp ?? record.marketTimestamp ?? record.quoteTimestamp ??
      record.observedAt ?? record.capturedAt
    );
    if ((!entrySymbol || entrySymbol === symbol.toUpperCase()) && price && timestamp) {
      return { referencePrice: price, timestamp };
    }
    for (const nested of Object.values(record)) {
      const found = visit(nested);
      if (found) return found;
    }
    return null;
  };
  return visit(value);
};

export const validateAutonomousExecutionEvidence = (
  intent: AutonomousExecutionIntentRow,
  broker: AutonomousExecutionBrokerSnapshot,
  now: Date,
  quoteMaxAgeSeconds: number
): AlpacaPaperOrderRequest => {
  const brokerAccountIdentity = broker.brokerAccountId ?? broker.accountIdentityHash;
  if (brokerAccountIdentity !== intent.broker_account_id) {
    throw new Error("POSTGRES_BROKER_ACCOUNT_IDENTITY_CONFLICT");
  }
  if (broker.portfolioFingerprint !== intent.account_snapshot_fingerprint) {
    throw new Error("POSTGRES_BROKER_PORTFOLIO_EVIDENCE_CONFLICT");
  }
  if (broker.structuralPortfolioFingerprint !== intent.review_account_fingerprint) {
    throw new Error("POSTGRES_REVIEW_ACCOUNT_EVIDENCE_CONFLICT");
  }
  const evidence = marketEvidence(intent.market_evidence, intent.symbol);
  if (!evidence) {
    const serialized = JSON.stringify(intent.market_evidence);
    if (!/timestamp|marketTimestamp|quoteTimestamp|observedAt|capturedAt/.test(serialized)) {
      throw new Error("POSTGRES_MARKET_EVIDENCE_TIMESTAMP_MISSING");
    }
    throw new Error("POSTGRES_MARKET_REFERENCE_PRICE_MISSING");
  }
  const observedAt = Date.parse(evidence.timestamp);
  const ageSeconds = (now.getTime() - observedAt) / 1_000;
  if (
    !Number.isFinite(observedAt) || ageSeconds < 0 ||
    ageSeconds > quoteMaxAgeSeconds
  ) {
    throw new Error("POSTGRES_MARKET_EVIDENCE_STALE");
  }
  if (!intent.quantity && !intent.notional) {
    throw new Error("POSTGRES_ORDER_INTENT_SIZE_MISSING");
  }
  if (intent.order_type === "limit" && !positive(intent.limit_price)) {
    throw new Error("POSTGRES_ORDER_INTENT_LIMIT_PRICE_MISSING");
  }
  const positionIntent = intent.side === "buy_to_open" || intent.side === "sell_to_close"
    ? intent.side
    : undefined;
  const payload: AlpacaPaperOrderRequest = {
    symbol: intent.symbol,
    ...(intent.quantity ? { qty: intent.quantity } : {}),
    ...(intent.notional ? { notional: intent.notional } : {}),
    side: intent.side.startsWith("buy") ? "buy" : "sell",
    type: intent.order_type,
    time_in_force: intent.time_in_force,
    ...(intent.limit_price ? { limit_price: intent.limit_price } : {}),
    client_order_id: intent.client_order_id,
    ...(positionIntent ? { position_intent: positionIntent } : {})
  };
  return payload;
};

const commandFilter = (command: string) => {
  if (command === "paper:execute:reviewed") {
    return "intent.side IN ('buy', 'buy_to_open')";
  }
  if (command === "paper:exit:execute") {
    return "intent.side IN ('sell', 'sell_to_close')";
  }
  if (command === "hedge:exit:execute") {
    return "intent.side IN ('sell', 'sell_to_close') AND intent.strategy_key ILIKE '%hedge%'";
  }
  if (command === "zero-dte:engine") {
    return "intent.side IN ('buy', 'buy_to_open') AND (intent.strategy_key ILIKE '%zero%dte%' OR intent.strategy_key ILIKE '%0dte%')";
  }
  throw new Error(`POSTGRES_EXECUTION_COMMAND_UNSUPPORTED: ${command}`);
};

const fenceSql = (start: number) => `EXISTS (
  SELECT 1 FROM scheduler_leases lease
  WHERE lease.job_name = $${start} AND lease.workstream = $${start + 1}
    AND lease.owner_id = $${start + 2} AND lease.run_id = $${start + 3}
    AND lease.fencing_token = $${start + 4} AND lease.status = 'held'
    AND lease.expires_at > now()
)`;

const fenceValues = (fence: SchedulerFence) => [
  fence.jobName,
  fence.workstream,
  fence.ownerId,
  fence.runId,
  fence.fencingToken
];

const persistCandidateExecutionStage = async (
  query: AutonomousExecutionQuery,
  intent: AutonomousExecutionIntentRow,
  fence: SchedulerFence,
  now: Date,
  status: "execution_deferred" | "execution_ambiguous" | "executed",
  reason: string
) => {
  if (!intent.candidate_id) return;
  const result = await query.query(
    `UPDATE candidates
     SET lifecycle_status = $2, decision_reason = $3, updated_at = $4,
         version = version + 1
     WHERE id = $1 AND decision = 'selected' AND ${fenceSql(5)}`,
    [
      intent.candidate_id,
      status,
      reason,
      now.toISOString(),
      ...fenceValues(fence)
    ]
  );
  if (result.rowCount !== 1) throw new Error("POSTGRES_CANDIDATE_STAGE_PERSISTENCE_FAILED");
};

const claimIntent = async (
  query: AutonomousExecutionQuery,
  command: string,
  fence: SchedulerFence,
  now: Date,
  expectedPayloadSignature?: string
) => {
  const selected = await query.query(
    `SELECT intent.id AS order_intent_id, intent.candidate_id, intent.account_id,
            account.broker_account_id,
            snapshot.snapshot_fingerprint AS account_snapshot_fingerprint,
            review.account_fingerprint AS review_account_fingerprint,
            intent.reservation_id, intent.execution_review_id,
            intent.confirmation_evidence_id, review.signature AS review_signature,
            review.payload_fingerprint, intent.client_order_id,
            intent.strategy_key, intent.symbol, intent.asset_class,
            intent.side, intent.order_type, intent.time_in_force,
            intent.quantity::text AS quantity, intent.notional::text AS notional,
            intent.limit_price::text AS limit_price,
            intent.stop_price::text AS stop_price, intent.version AS intent_version,
            review.market_evidence
     FROM order_intents intent
     JOIN accounts account ON account.id = intent.account_id
     JOIN LATERAL (
       SELECT * FROM account_snapshots current_snapshot
       WHERE current_snapshot.account_id = intent.account_id
       ORDER BY current_snapshot.observed_at DESC, current_snapshot.id DESC LIMIT 1
     ) snapshot ON true
     JOIN execution_reviews review ON review.id = intent.execution_review_id
     JOIN confirmation_evidence confirmation
       ON confirmation.id = intent.confirmation_evidence_id
     JOIN strategy_allocations allocation
       ON allocation.account_id = intent.account_id
      AND allocation.strategy_key = intent.strategy_key
      AND allocation.status = 'active' AND allocation.effective_to IS NULL
     JOIN risk_limits limits ON limits.account_id = intent.account_id
      AND limits.status = 'active' AND limits.effective_to IS NULL
     JOIN LATERAL (
       SELECT id FROM portfolio_exposure exposure
       WHERE exposure.account_id = intent.account_id
       ORDER BY exposure.observed_at DESC, exposure.id DESC LIMIT 1
     ) exposure ON true
     LEFT JOIN buying_power_reservations reservation ON reservation.id = intent.reservation_id
     WHERE intent.status = 'ready_for_submission' AND intent.environment = 'paper'
       AND ${commandFilter(command)}
       AND review.status = 'valid' AND review.environment = 'paper'
       AND review.paper_only AND NOT review.live_trading_enabled
       AND review.expires_at > $1
       AND confirmation.status = 'valid' AND confirmation.paper_only
       AND confirmation.expires_at > $1
       AND (
         intent.reservation_id IS NULL OR
         (reservation.status = 'active' AND reservation.expires_at > $1
          AND reservation.account_snapshot_id = snapshot.id)
       )
     ORDER BY intent.ready_at, intent.created_at, intent.id
     LIMIT 1
     FOR UPDATE OF intent, review, confirmation SKIP LOCKED`,
    [now.toISOString()]
  );
  const intent = selected.rows[0] as AutonomousExecutionIntentRow | undefined;
  if (!intent) throw new Error("POSTGRES_EXECUTION_EVIDENCE_GATE_FAILED");
  if (
    expectedPayloadSignature &&
    intent.review_signature !== expectedPayloadSignature &&
    intent.payload_fingerprint !== expectedPayloadSignature
  ) {
    throw new Error("PAPER_REVIEW_ARTIFACT_MISMATCH");
  }
  const claimed = await query.query(
    `UPDATE order_intents
     SET status = 'submission_pending', updated_at = $2, version = version + 1
     WHERE id = $1 AND version = $3 AND status = 'ready_for_submission'
       AND ${fenceSql(4)}`,
    [
      intent.order_intent_id,
      now.toISOString(),
      intent.intent_version,
      ...fenceValues(fence)
    ]
  );
  if (claimed.rowCount !== 1) throw new Error("POSTGRES_EXECUTION_INTENT_CLAIM_FAILED");
  return intent;
};

const releaseClaim = async (
  query: AutonomousExecutionQuery,
  intent: AutonomousExecutionIntentRow,
  fence: SchedulerFence,
  now: Date,
  reason: string
) => {
  const released = await query.query(
    `UPDATE order_intents
     SET status = 'ready_for_submission', updated_at = $2, version = version + 1
     WHERE id = $1 AND status = 'submission_pending' AND ${fenceSql(3)}`,
    [intent.order_intent_id, now.toISOString(), ...fenceValues(fence)]
  );
  if (released.rowCount !== 1) {
    throw new Error("POSTGRES_EXECUTION_INTENT_RELEASE_FAILED");
  }
  await persistCandidateExecutionStage(
    query,
    intent,
    fence,
    now,
    "execution_deferred",
    reason
  );
};

const recordSubmission = async (
  query: AutonomousExecutionQuery,
  intent: AutonomousExecutionIntentRow,
  response: AlpacaApiResponse<AlpacaSubmittedOrder>,
  fence: SchedulerFence,
  now: Date
) => {
  const brokerOrderId = text(response.data.id);
  const brokerClientOrderId = text(response.data.client_order_id);
  const status = text(response.data.status).toLowerCase();
  if (!brokerOrderId || brokerClientOrderId !== intent.client_order_id || !status) {
    throw new Error("POSTGRES_BROKER_SUBMISSION_IDENTITY_INCOMPLETE");
  }
  const orderId = `order_${stableRecordId("alpaca_order", `${intent.account_id}:${brokerOrderId}`)}`;
  const occurredAt = text(response.data.submitted_at || response.data.created_at) || now.toISOString();
  const payload = response.data as unknown as Record<string, unknown>;
  const eventId = `broker_event_${stableRecordId("alpaca_broker_event", `${orderId}:${status}:${occurredAt}`)}`;
  const values = fenceValues(fence);
  await query.query(
    `INSERT INTO orders(
       id, account_id, order_intent_id, broker_order_id, client_order_id,
       environment, symbol, asset_class, side, order_type, time_in_force,
       status, quantity, notional, limit_price, stop_price, filled_quantity,
       filled_average_price, broker_request_id, submitted_at,
       last_broker_update_at, raw_status, created_at, updated_at
     ) SELECT $1, $2, $3, $4, $5, 'paper', $6, $7, $8, $9, $10,
              $11, $12, $13, $14, $15, $16, $17, $18, $19, $19,
              $20::jsonb, $19, $19
       WHERE ${fenceSql(21)}
     ON CONFLICT (account_id, client_order_id) DO NOTHING`,
    [
      orderId, intent.account_id, intent.order_intent_id, brokerOrderId,
      intent.client_order_id, intent.symbol, intent.asset_class, intent.side,
      intent.order_type, intent.time_in_force, status,
      response.data.qty ?? intent.quantity, response.data.notional ?? intent.notional,
      response.data.limit_price ?? intent.limit_price,
      response.data.stop_price ?? intent.stop_price,
      response.data.filled_qty ?? "0", response.data.filled_avg_price ?? null,
      response.requestId ?? null, occurredAt, JSON.stringify(payload), ...values
    ]
  );
  await query.query(
    `INSERT INTO broker_events(
       event_id, account_id, order_id, order_intent_id, broker_order_id,
       client_order_id, event_type, event_status, request_id, http_status,
       response_payload, response_fingerprint, occurred_at, received_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'order_submission', $7, $8, $9,
               $10::jsonb, $11, $12, $13)
     ON CONFLICT (event_id) DO NOTHING`,
    [
      eventId, intent.account_id, orderId, intent.order_intent_id, brokerOrderId,
      intent.client_order_id, status, response.requestId ?? null, response.status,
      JSON.stringify(payload), canonicalJsonHash(payload), occurredAt, now.toISOString()
    ]
  );
  const updated = await query.query(
    `UPDATE order_intents
     SET status = 'submitted', submitted_at = $2, updated_at = $2, version = version + 1
     WHERE id = $1 AND status = 'submission_pending' AND ${fenceSql(3)}`,
    [intent.order_intent_id, now.toISOString(), ...values]
  );
  if (updated.rowCount !== 1) throw new Error("POSTGRES_EXECUTION_RESULT_PERSISTENCE_FAILED");
  if (intent.reservation_id) {
    await query.query(
      `UPDATE buying_power_reservations
       SET status = 'committed', committed_at = $2, updated_at = $2, version = version + 1
       WHERE id = $1 AND status = 'active' AND ${fenceSql(3)}`,
      [intent.reservation_id, now.toISOString(), ...values]
    );
  }
  await query.query(
    `UPDATE execution_reviews
     SET status = 'consumed', consumed_at = $2, updated_at = $2, version = version + 1
     WHERE id = $1 AND status = 'valid' AND ${fenceSql(3)}`,
    [intent.execution_review_id, now.toISOString(), ...values]
  );
  await query.query(
    `UPDATE confirmation_evidence
     SET status = 'consumed', consumed_at = $2, updated_at = $2, version = version + 1
     WHERE id = $1 AND status = 'valid' AND ${fenceSql(3)}`,
    [intent.confirmation_evidence_id, now.toISOString(), ...values]
  );
  await persistCandidateExecutionStage(
    query,
    intent,
    fence,
    now,
    "executed",
    "PAPER_ORDER_SUBMITTED"
  );
  return { orderId, brokerOrderId, status };
};

const recordAmbiguousSubmission = async (
  query: AutonomousExecutionQuery,
  intent: AutonomousExecutionIntentRow,
  error: unknown,
  fence: SchedulerFence,
  now: Date
) => {
  const message = error instanceof Error
    ? error.message.slice(0, 500)
    : "Broker submission ended without a verified response.";
  const payload = { code: "POSTGRES_BROKER_SUBMISSION_AMBIGUOUS", message };
  const eventId = `broker_event_${stableRecordId(
    "alpaca_broker_submission_ambiguous",
    `${intent.account_id}:${intent.client_order_id}:${now.toISOString()}`
  )}`;
  const values = fenceValues(fence);
  const updated = await query.query(
    `UPDATE order_intents
     SET status = 'ambiguous', updated_at = $2, version = version + 1
     WHERE id = $1 AND status = 'submission_pending' AND ${fenceSql(3)}`,
    [intent.order_intent_id, now.toISOString(), ...values]
  );
  if (updated.rowCount !== 1) {
    throw new Error("POSTGRES_BROKER_SUBMISSION_AMBIGUITY_PERSISTENCE_FAILED");
  }
  const inserted = await query.query(
    `INSERT INTO broker_events(
       event_id, account_id, order_intent_id, client_order_id,
       event_type, event_status, error_classification, retryable,
       response_payload, response_fingerprint, occurred_at, received_at
     ) SELECT $1, $2, $3, $4, 'order_submission', 'ambiguous',
              'ambiguous_network_result', true, $5::jsonb, $6, $7, $7
       WHERE ${fenceSql(8)}
     ON CONFLICT (event_id) DO NOTHING`,
    [
      eventId,
      intent.account_id,
      intent.order_intent_id,
      intent.client_order_id,
      JSON.stringify(payload),
      canonicalJsonHash(payload),
      now.toISOString(),
      ...values
    ]
  );
  if (inserted.rowCount !== 1) {
    throw new Error("POSTGRES_BROKER_SUBMISSION_AMBIGUITY_PERSISTENCE_FAILED");
  }
  await persistCandidateExecutionStage(
    query,
    intent,
    fence,
    now,
    "execution_ambiguous",
    "POSTGRES_BROKER_SUBMISSION_AMBIGUOUS"
  );
};

const assertSafety = (safety: AutonomousExecutionSafety, confirmPaper: boolean) => {
  if (safety.environment !== "paper" || safety.tradingMode !== "paper") {
    throw new Error("PAPER_RUNTIME_REQUIRED");
  }
  if (safety.liveTradingEnabled) throw new Error("LIVE_TRADING_MUST_BE_DISABLED");
  if (!safety.paperOrderExecutionEnabled) throw new Error("PAPER_ORDER_EXECUTION_DISABLED");
  if (!confirmPaper) throw new Error("PAPER_CONFIRMATION_REQUIRED");
};

export const runAutonomousPostgresExecutionCommand = async (input: {
  readonly command: string;
  readonly query: AutonomousExecutionQuery;
  readonly transaction: AutonomousExecutionTransaction;
  readonly marketOpen?: () => Promise<boolean>;
  readonly captureBrokerSnapshot: () => Promise<AutonomousExecutionBrokerSnapshot>;
  readonly submitOrder: (
    payload: AlpacaPaperOrderRequest
  ) => Promise<AlpacaApiResponse<AlpacaSubmittedOrder>>;
  readonly fence: SchedulerFence;
  readonly safety: AutonomousExecutionSafety;
  readonly confirmPaper: boolean;
  readonly expectedPayloadSignature?: string;
  readonly now?: Date;
}) => {
  assertSafety(input.safety, input.confirmPaper);
  const filter = commandFilter(input.command);
  const countResult = await input.query.query(
    `SELECT COUNT(*) AS ready_count FROM order_intents intent
     WHERE intent.status = 'ready_for_submission' AND intent.environment = 'paper'
       AND ${filter}`
  );
  const readyCount = Number(countResult.rows[0]?.ready_count ?? 0);
  if (!Number.isSafeInteger(readyCount) || readyCount < 0) {
    throw new Error("POSTGRES_READY_INTENT_COUNT_INVALID");
  }
  if (readyCount === 0) {
    return {
      status: "no_op" as const,
      code: "NO_READY_POSTGRES_ORDER_INTENTS",
      submittedOrderCount: 0,
      evidence: { readyIntentCount: 0 }
    };
  }

  if (input.marketOpen && !(await input.marketOpen())) {
    return {
      status: "no_op" as const,
      code: "PAPER_MARKET_CLOSED",
      submittedOrderCount: 0,
      evidence: { readyIntentCount: readyCount, marketOpen: false }
    };
  }

  const now = input.now ?? new Date();
  const broker = await input.captureBrokerSnapshot();
  const intent = await input.transaction((query) =>
    claimIntent(query, input.command, input.fence, now, input.expectedPayloadSignature)
  );
  let payload: AlpacaPaperOrderRequest;
  try {
    if (intent.asset_class === "option" && !input.safety.paperOptionsExecutionEnabled) {
      throw new Error("PAPER_OPTIONS_EXECUTION_DISABLED");
    }
    payload = validateAutonomousExecutionEvidence(
      intent,
      broker,
      now,
      input.safety.quoteMaxAgeSeconds
    );
  } catch (error) {
    const reason = error instanceof Error
      ? error.message.slice(0, 240)
      : "POSTGRES_EXECUTION_EVIDENCE_GATE_FAILED";
    await input.transaction((query) =>
      releaseClaim(query, intent, input.fence, now, reason)
    );
    throw error;
  }
  let recorded: Awaited<ReturnType<typeof recordSubmission>>;
  try {
    const response = await input.submitOrder(payload);
    recorded = await input.transaction((query) =>
      recordSubmission(query, intent, response, input.fence, now)
    );
  } catch (error) {
    await input.transaction((query) =>
      recordAmbiguousSubmission(query, intent, error, input.fence, now)
    );
    throw new Error("POSTGRES_BROKER_SUBMISSION_AMBIGUOUS");
  }
  return {
    status: "completed" as const,
    submittedOrderCount: 1,
    evidence: {
      readyIntentCount: readyCount,
      orderIntentId: intent.order_intent_id,
      orderId: recorded.orderId,
      brokerOrderId: recorded.brokerOrderId,
      brokerStatus: recorded.status
    }
  };
};
