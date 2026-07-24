import { canonicalJsonHash } from "../lib/canonicalJson.js";
import type { SchedulerFence } from "../repositories/contracts/common.js";
import { stableRecordId } from "../repositories/postgres/postgresRepositorySupport.js";
import {
  cancelPaperOrder,
  getPaperOrder,
  getPaperOrderByClientOrderId,
  type AlpacaApiResponse,
  type AlpacaSubmittedOrder
} from "./alpacaClient.js";
import { paperSubmitConfiguration } from "./paperSubmitSafetyConfig.js";
import {
  reconcilePostgresPaperOrders
} from "./postgresReconciliationService.js";

type CancellationQuery = {
  query: (sql: string, values?: readonly unknown[]) => Promise<{
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }>;
};

type CancellationTarget = {
  order_id: string;
  order_intent_id: string;
  account_id: string;
  broker_order_id: string;
  client_order_id: string;
  status: string;
  asset_class: string;
  lifecycle_state: string;
};

type CancellationSafety = {
  environment: string;
  tradingMode: string;
  liveTradingEnabled: boolean;
  paperOrderExecutionEnabled: boolean;
  paperOptionsExecutionEnabled?: boolean;
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

const required = (value: unknown, code: string) => {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(code);
  return normalized;
};

const terminalStatuses = new Set([
  "filled",
  "canceled",
  "cancelled",
  "expired",
  "rejected"
]);
const DEFAULT_CANCEL_RECOVERY_ATTEMPTS = 8;
const DEFAULT_CANCEL_RECOVERY_DELAY_MS = 500;
const MAX_CANCEL_RECOVERY_DELAY_MS = 5_000;
const defaultSleep = async (delayMs: number) => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

const assertCurrentFence = async (
  query: CancellationQuery,
  fence: SchedulerFence
) => {
  const result = await query.query(
    `SELECT 1 AS current_fence WHERE ${fenceSql(1)}`,
    fenceValues(fence)
  );
  if (result.rowCount !== 1) throw new Error("SCHEDULER_FENCE_LOST");
};

const assertSafety = (safety: CancellationSafety, confirmPaper: boolean) => {
  if (safety.environment !== "paper" || safety.tradingMode !== "paper") {
    throw new Error("PAPER_RUNTIME_REQUIRED");
  }
  if (safety.liveTradingEnabled) throw new Error("LIVE_TRADING_MUST_BE_DISABLED");
  if (!safety.paperOrderExecutionEnabled) throw new Error("PAPER_ORDER_EXECUTION_DISABLED");
  if (!confirmPaper) throw new Error("PAPER_CONFIRMATION_REQUIRED");
};

export const runPostgresPaperOrderCancellation = async (input: {
  query: CancellationQuery;
  fence: SchedulerFence;
  brokerOrderId?: string;
  clientOrderId?: string;
  confirmPaper: boolean;
  safety?: CancellationSafety;
  getOrderById?: (
    orderId: string
  ) => Promise<AlpacaApiResponse<AlpacaSubmittedOrder>>;
  getOrderByClientOrderId?: (
    clientOrderId: string
  ) => Promise<AlpacaApiResponse<AlpacaSubmittedOrder>>;
  cancelOrder?: typeof cancelPaperOrder;
  reconcile?: typeof reconcilePostgresPaperOrders;
  maxRecoveryAttempts?: number;
  recoveryDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  assertFence?: () => Promise<void>;
}) => {
  const safety = input.safety ?? paperSubmitConfiguration();
  assertSafety(safety, input.confirmPaper);
  const brokerOrderId = String(input.brokerOrderId ?? "").trim();
  const clientOrderId = String(input.clientOrderId ?? "").trim();
  if (!brokerOrderId && !clientOrderId) {
    throw new Error("POSTGRES_CANCEL_ORDER_ID_REQUIRED");
  }
  const targetResult = await input.query.query(
    `SELECT broker_order.id AS order_id, broker_order.order_intent_id,
            broker_order.account_id, broker_order.broker_order_id,
            broker_order.client_order_id, broker_order.status, intent.asset_class,
            intent.lifecycle_state
     FROM orders broker_order
     JOIN order_intents intent ON intent.id = broker_order.order_intent_id
     WHERE broker_order.environment = 'paper'
       AND ($1 = '' OR broker_order.broker_order_id = $1)
       AND ($2 = '' OR broker_order.client_order_id = $2)
       AND ${fenceSql(3)}
     ORDER BY broker_order.created_at DESC, broker_order.id DESC
     LIMIT 1`,
    [brokerOrderId, clientOrderId, ...fenceValues(input.fence)]
  );
  const target = targetResult.rows[0] as CancellationTarget | undefined;
  if (!target) throw new Error("POSTGRES_CANCEL_ORDER_NOT_FOUND");
  if (
    String(target.asset_class || "").toLowerCase() === "option" &&
    safety.paperOptionsExecutionEnabled !== true
  ) {
    throw new Error("PAPER_OPTIONS_EXECUTION_DISABLED");
  }
  const expectedBrokerId = required(
    target.broker_order_id,
    "POSTGRES_CANCEL_BROKER_ORDER_ID_MISSING"
  );
  const expectedClientId = required(
    target.client_order_id,
    "POSTGRES_CANCEL_CLIENT_ORDER_ID_MISSING"
  );
  if (
    (brokerOrderId && expectedBrokerId !== brokerOrderId) ||
    (clientOrderId && expectedClientId !== clientOrderId)
  ) {
    throw new Error("POSTGRES_CANCEL_ORDER_IDENTITY_MISMATCH");
  }

  const getById = input.getOrderById ?? getPaperOrder;
  const getByClient = input.getOrderByClientOrderId ?? getPaperOrderByClientOrderId;
  const before = await getById(expectedBrokerId);
  if (
    required(before.data.id, "POSTGRES_CANCEL_BROKER_ID_MISSING") !== expectedBrokerId ||
    required(before.data.client_order_id, "POSTGRES_CANCEL_CLIENT_ID_MISSING") !==
      expectedClientId
  ) {
    throw new Error("POSTGRES_CANCEL_BROKER_IDENTITY_MISMATCH");
  }
  const beforeStatus = required(
    before.data.status,
    "POSTGRES_CANCEL_BROKER_STATUS_MISSING"
  ).toLowerCase();
  const lifecycleState = String(target.lifecycle_state ?? "").trim().toLowerCase();
  const maxRecoveryAttempts = input.maxRecoveryAttempts ??
    DEFAULT_CANCEL_RECOVERY_ATTEMPTS;
  const recoveryDelayMs = input.recoveryDelayMs ??
    DEFAULT_CANCEL_RECOVERY_DELAY_MS;
  const assertFence = input.assertFence ??
    (() => assertCurrentFence(input.query, input.fence));
  if (
    !Number.isSafeInteger(maxRecoveryAttempts) ||
    maxRecoveryAttempts < 1 ||
    maxRecoveryAttempts > 32 ||
    !Number.isSafeInteger(recoveryDelayMs) ||
    recoveryDelayMs < 0 ||
    recoveryDelayMs > MAX_CANCEL_RECOVERY_DELAY_MS
  ) {
    throw new Error("POSTGRES_CANCEL_RECOVERY_POLICY_INVALID");
  }

  let after = before;
  let status: "already_terminal" | "canceled" | "cancellation_pending";
  if (terminalStatuses.has(beforeStatus)) {
    status = "already_terminal";
  } else {
    const currentLifecycleState = required(
      lifecycleState,
      "POSTGRES_CANCEL_LIFECYCLE_STATE_MISSING"
    );
    const cancellationAlreadyPersisted = lifecycleState === "cancel_requested" ||
      lifecycleState === "cancel_ambiguous";
    const now = new Date().toISOString();
    if (!cancellationAlreadyPersisted) {
      const cancellationEvidence = {
        brokerOrderId: expectedBrokerId,
        clientOrderId: expectedClientId,
        brokerStatus: beforeStatus,
        requestedBy: "autonomous_postgres_cancellation"
      };
      const cancellationEventId = `broker_event_${stableRecordId(
        "alpaca_order_cancellation_request",
        `${target.account_id}:${expectedBrokerId}:${expectedClientId}`
      )}`;
      const transitionId = `lifecycle_transition_${stableRecordId(
        "cancel_requested",
        `${target.order_intent_id}:${expectedBrokerId}`
      )}`;
      const cancellationRequest = await input.query.query(
        `WITH current_intent AS MATERIALIZED (
           SELECT intent.id, intent.lifecycle_state, intent.operation,
                  intent.autonomous_cycle_id, intent.workstream_execution_id,
                  intent.authorization_snapshot_id
           FROM order_intents intent
           WHERE intent.id = $2 AND intent.lifecycle_state = $10
             AND ${fenceSql(13)}
           FOR UPDATE
         ), lifecycle_transition AS (
           INSERT INTO autonomous_trade_lifecycle_transitions(
             id, order_intent_id, from_state, to_state, operation,
             idempotency_key, autonomous_cycle_id, workstream_execution_id,
             authorization_snapshot_id, evidence, occurred_at
           )
           SELECT $1, current_intent.id, current_intent.lifecycle_state,
                  'cancel_requested', current_intent.operation, $9,
                  current_intent.autonomous_cycle_id,
                  current_intent.workstream_execution_id,
                  current_intent.authorization_snapshot_id, $7::jsonb, $8
           FROM current_intent
           ON CONFLICT (order_intent_id, idempotency_key) DO NOTHING
           RETURNING order_intent_id
         ), updated_intent AS (
           UPDATE order_intents intent
           SET lifecycle_state = 'cancel_requested', updated_at = $8,
               version = intent.version + 1
           FROM lifecycle_transition
           WHERE intent.id = lifecycle_transition.order_intent_id
             AND intent.lifecycle_state = $10
           RETURNING intent.id
         ), request_event AS (
           INSERT INTO broker_events(
             event_id, account_id, order_id, order_intent_id, broker_order_id,
             client_order_id, event_type, event_status, retryable,
             response_payload, response_fingerprint, occurred_at, received_at
           )
           SELECT $3, $4, $5, updated_intent.id, $6, $11,
                  'order_cancellation_request', 'pending', true,
                  $7::jsonb, $12, $8, $8
           FROM updated_intent
           ON CONFLICT (event_id) DO NOTHING
           RETURNING event_id
         )
         SELECT
           (SELECT COUNT(*) FROM lifecycle_transition)::text AS transition_count,
           (SELECT COUNT(*) FROM updated_intent)::text AS updated_intent_count,
           (SELECT COUNT(*) FROM request_event)::text AS event_count`,
        [
          transitionId,
          target.order_intent_id,
          cancellationEventId,
          target.account_id,
          target.order_id,
          expectedBrokerId,
          JSON.stringify(cancellationEvidence),
          now,
          `cancel-request:${expectedBrokerId}`,
          currentLifecycleState,
          expectedClientId,
          canonicalJsonHash(cancellationEvidence),
          ...fenceValues(input.fence)
        ]
      );
      const requestResult = cancellationRequest.rows[0] ?? {};
      if (
        Number(requestResult.transition_count ?? 0) !== 1 ||
        Number(requestResult.updated_intent_count ?? 0) !== 1 ||
        Number(requestResult.event_count ?? 0) !== 1
      ) {
        throw new Error("POSTGRES_CANCEL_REQUEST_PERSISTENCE_FAILED");
      }

    }

    let mutationClaimed = lifecycleState === "cancel_ambiguous";
    if (!mutationClaimed) {
      // Claim the one broker mutation durably before touching Alpaca. A
      // concurrent/restarted runner that observes an existing claim must stay
      // lookup-only; it must never issue a second DELETE.
      await assertFence();
      const ambiguousEvidence = {
        brokerOrderId: expectedBrokerId,
        clientOrderId: expectedClientId,
        brokerStatus: beforeStatus,
        mutationAttempt: "pending",
        mutationOutcome: "not_started"
      };
      const ambiguousEventId = `broker_event_${stableRecordId(
        "alpaca_order_cancellation_ambiguous",
        `${target.account_id}:${expectedBrokerId}:${expectedClientId}`
      )}`;
      const ambiguousTransitionId = `lifecycle_transition_${stableRecordId(
        "cancel_ambiguous",
        `${target.order_intent_id}:${expectedBrokerId}`
      )}`;
      const ambiguous = await input.query.query(
        `WITH current_intent AS MATERIALIZED (
           SELECT intent.id, intent.lifecycle_state, intent.operation,
                  intent.autonomous_cycle_id, intent.workstream_execution_id,
                  intent.authorization_snapshot_id
           FROM order_intents intent
           WHERE intent.id = $2 AND intent.lifecycle_state = 'cancel_requested'
             AND ${fenceSql(12)}
           FOR UPDATE
         ), lifecycle_transition AS (
           INSERT INTO autonomous_trade_lifecycle_transitions(
             id, order_intent_id, from_state, to_state, operation,
             idempotency_key, autonomous_cycle_id, workstream_execution_id,
             authorization_snapshot_id, evidence, occurred_at
           )
           SELECT $1, current_intent.id, 'cancel_requested',
                  'cancel_ambiguous', current_intent.operation, $9,
                  current_intent.autonomous_cycle_id,
                  current_intent.workstream_execution_id,
                  current_intent.authorization_snapshot_id, $7::jsonb, $8
           FROM current_intent
           ON CONFLICT (order_intent_id, idempotency_key) DO NOTHING
           RETURNING order_intent_id
         ), updated_intent AS (
           UPDATE order_intents intent
           SET lifecycle_state = 'cancel_ambiguous', updated_at = $8,
               version = intent.version + 1
           FROM lifecycle_transition
           WHERE intent.id = lifecycle_transition.order_intent_id
             AND intent.lifecycle_state = 'cancel_requested'
           RETURNING intent.id
         ), ambiguous_event AS (
           INSERT INTO broker_events(
             event_id, account_id, order_id, order_intent_id, broker_order_id,
             client_order_id, event_type, event_status, retryable,
             response_payload, response_fingerprint, occurred_at, received_at
           )
           SELECT $3, $4, $5, updated_intent.id, $6, $10,
                  'order_cancellation_ambiguous', 'pending', true,
                  $7::jsonb, $11, $8, $8
           FROM updated_intent
           ON CONFLICT (event_id) DO NOTHING
           RETURNING event_id
         )
         SELECT
           (SELECT COUNT(*) FROM lifecycle_transition)::text AS transition_count,
           (SELECT COUNT(*) FROM updated_intent)::text AS updated_intent_count,
           (SELECT COUNT(*) FROM ambiguous_event)::text AS event_count`,
        [
          ambiguousTransitionId,
          target.order_intent_id,
          ambiguousEventId,
          target.account_id,
          target.order_id,
          expectedBrokerId,
          JSON.stringify(ambiguousEvidence),
          now,
          `cancel-ambiguous:${expectedBrokerId}`,
          expectedClientId,
          canonicalJsonHash(ambiguousEvidence),
          ...fenceValues(input.fence)
        ]
      );
      const ambiguousResult = ambiguous.rows[0];
      if (!ambiguousResult) {
        throw new Error("POSTGRES_CANCEL_AMBIGUITY_PERSISTENCE_FAILED");
      }
      const parseCount = (value: unknown) => {
        if (typeof value === "number" && Number.isInteger(value) && (value === 0 || value === 1)) {
          return value;
        }
        if (typeof value === "string" && /^[01]$/.test(value)) return Number(value);
        throw new Error("POSTGRES_CANCEL_AMBIGUITY_PERSISTENCE_FAILED");
      };
      const transitionCount = parseCount(ambiguousResult.transition_count);
      const updatedIntentCount = parseCount(ambiguousResult.updated_intent_count);
      const eventCount = parseCount(ambiguousResult.event_count);
      if (!(
        (transitionCount === 0 && updatedIntentCount === 0 && eventCount === 0) ||
        (transitionCount === 1 && updatedIntentCount === 1 && eventCount === 1)
      )) {
        throw new Error("POSTGRES_CANCEL_AMBIGUITY_PERSISTENCE_FAILED");
      }
      // Only the transaction that inserted the transition/event owns the
      // mutation opportunity. A zero count is an already-claimed restart or
      // concurrent runner and therefore remains lookup-only.
      mutationClaimed = transitionCount === 1 && updatedIntentCount === 1 && eventCount === 1;
      if ((transitionCount > 0 || updatedIntentCount > 0 || eventCount > 0) && !mutationClaimed) {
        throw new Error("POSTGRES_CANCEL_AMBIGUITY_PERSISTENCE_FAILED");
      }
    }

    if (mutationClaimed && lifecycleState !== "cancel_ambiguous") {
      await assertFence();
      try {
        await (input.cancelOrder ?? cancelPaperOrder)(expectedBrokerId);
      } catch {
        // The durable cancel_ambiguous marker is authoritative. Recovery below
        // remains lookup-only regardless of the broker response or process
        // interruption after DELETE.
      }
    }

    let lastLookupError: unknown = null;
    for (let attempt = 1; attempt <= maxRecoveryAttempts; attempt += 1) {
      await assertFence();
      try {
        const observed = await getByClient(expectedClientId);
        if (
          required(observed.data.id, "POSTGRES_CANCEL_BROKER_ID_MISSING") !==
            expectedBrokerId ||
          required(
            observed.data.client_order_id,
            "POSTGRES_CANCEL_CLIENT_ID_MISSING"
          ) !== expectedClientId
        ) {
          throw new Error("POSTGRES_CANCEL_RECOVERY_IDENTITY_MISMATCH");
        }
        after = observed;
        lastLookupError = null;
        const observedStatus = required(
          observed.data.status,
          "POSTGRES_CANCEL_BROKER_STATUS_MISSING"
        ).toLowerCase();
        if (terminalStatuses.has(observedStatus)) break;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "POSTGRES_CANCEL_RECOVERY_IDENTITY_MISMATCH"
        ) {
          throw error;
        }
        lastLookupError = error;
        // The mutation has already been attempted. Lookup failures are
        // deliberately retried without a second DELETE.
      }
      if (attempt < maxRecoveryAttempts) {
        const delay = Math.min(
          recoveryDelayMs * 2 ** (attempt - 1),
          MAX_CANCEL_RECOVERY_DELAY_MS
        );
        await (input.sleep ?? defaultSleep)(delay);
      }
    }
    if (lastLookupError) {
      throw new Error(
        "POSTGRES_CANCEL_RECOVERY_INFRASTRUCTURE_UNRESOLVED",
        { cause: lastLookupError }
      );
    }
    const afterStatus = required(
      after.data.status,
      "POSTGRES_CANCEL_BROKER_STATUS_MISSING"
    ).toLowerCase();
    status = afterStatus === "canceled" || afterStatus === "cancelled"
      ? "canceled"
      : terminalStatuses.has(afterStatus)
        ? "already_terminal"
        : "cancellation_pending";
  }

  const reconcile = input.reconcile ?? reconcilePostgresPaperOrders;
  const reconciliation = await reconcile({
    query: input.query,
    fence: input.fence,
    getOrderByClientOrderId: async (lookupClientOrderId) => {
      if (lookupClientOrderId === expectedClientId) return after;
      return getByClient(lookupClientOrderId);
    }
  });
  if (reconciliation.errors.length > 0) {
    throw new Error("POSTGRES_CANCEL_RECONCILIATION_FAILED");
  }

  return {
    status,
    paperOnly: true as const,
    liveTradingEnabled: false as const,
    brokerOrderId: expectedBrokerId,
    clientOrderId: expectedClientId,
    brokerStatus: required(after.data.status, "POSTGRES_CANCEL_BROKER_STATUS_MISSING")
      .toLowerCase(),
    reconciliation
  };
};

export const runAutonomousPostgresPaperOrderCancellation = async (input: {
  query: CancellationQuery;
  fence: SchedulerFence;
  confirmPaper: boolean;
  now?: Date;
  staleAfterMinutes?: number;
  safety?: CancellationSafety;
  getOrderById?: (
    orderId: string
  ) => Promise<AlpacaApiResponse<AlpacaSubmittedOrder>>;
  getOrderByClientOrderId?: (
    clientOrderId: string
  ) => Promise<AlpacaApiResponse<AlpacaSubmittedOrder>>;
  cancelOrder?: typeof cancelPaperOrder;
  reconcile?: typeof reconcilePostgresPaperOrders;
  runCancellation?: typeof runPostgresPaperOrderCancellation;
}) => {
  const safety = input.safety ?? paperSubmitConfiguration();
  assertSafety(safety, input.confirmPaper);
  const staleAfterMinutes = input.staleAfterMinutes ?? 30;
  if (
    !Number.isSafeInteger(staleAfterMinutes) ||
    staleAfterMinutes < 1 ||
    staleAfterMinutes > 24 * 60
  ) {
    throw new Error("POSTGRES_AUTONOMOUS_CANCEL_POLICY_INVALID");
  }
  const now = input.now ?? new Date();
  const selected = await input.query.query(
    `WITH autonomous_cancellation_target AS (
       SELECT broker_order.broker_order_id, broker_order.client_order_id
       FROM orders broker_order
       JOIN order_intents intent ON intent.id = broker_order.order_intent_id
       LEFT JOIN execution_reviews review ON review.id = intent.execution_review_id
       LEFT JOIN candidates candidate ON candidate.id = intent.candidate_id
       WHERE broker_order.environment = 'paper'
         AND broker_order.status IN (
           'new', 'accepted', 'pending_new', 'partially_filled', 'held',
           'pending_replace', 'pending_cancel'
         )
         AND (
           broker_order.quantity IS NULL
           OR COALESCE(broker_order.filled_quantity, 0) < broker_order.quantity
         )
         AND (
           broker_order.submitted_at <=
             $1::timestamptz - ($2::integer * interval '1 minute')
           OR review.expires_at <= $1
          OR candidate.lifecycle_status IN (
             'expired', 'rejected', 'blocked', 'execution_deferred'
           )
           OR intent.request_payload->>'cancellable' = 'true'
           OR intent.request_payload->>'materiallyObsolete' = 'true'
           OR intent.request_payload->>'recoveryCancellable' = 'true'
           OR intent.request_payload->>'cancelBeforeReplace' = 'true'
           OR intent.lifecycle_state IN ('cancel_requested', 'cancel_ambiguous')
         )
         AND broker_order.broker_order_id IS NOT NULL
         AND broker_order.client_order_id IS NOT NULL
         AND ${fenceSql(3)}
       ORDER BY broker_order.submitted_at, broker_order.created_at, broker_order.id
       LIMIT 1
     )
     SELECT broker_order_id, client_order_id
     FROM autonomous_cancellation_target`,
    [now.toISOString(), staleAfterMinutes, ...fenceValues(input.fence)]
  );
  const target = selected.rows[0];
  if (!target) {
    return {
      status: "no_op" as const,
      code: "NO_CANCELLABLE_POSTGRES_ORDERS",
      canceledOrderCount: 0,
      paperOnly: true as const
    };
  }
  const runCancellation = input.runCancellation ??
    runPostgresPaperOrderCancellation;
  return runCancellation({
    query: input.query,
    fence: input.fence,
    brokerOrderId: required(
      target.broker_order_id,
      "POSTGRES_CANCEL_BROKER_ORDER_ID_MISSING"
    ),
    clientOrderId: required(
      target.client_order_id,
      "POSTGRES_CANCEL_CLIENT_ORDER_ID_MISSING"
    ),
    confirmPaper: input.confirmPaper,
    safety,
    getOrderById: input.getOrderById,
    getOrderByClientOrderId: input.getOrderByClientOrderId,
    cancelOrder: input.cancelOrder,
    reconcile: input.reconcile
  });
};
