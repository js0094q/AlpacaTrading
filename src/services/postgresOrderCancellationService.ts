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
            broker_order.client_order_id, broker_order.status, intent.asset_class
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

  let after = before;
  let status: "already_terminal" | "canceled" | "cancellation_pending";
  if (terminalStatuses.has(beforeStatus)) {
    status = "already_terminal";
  } else {
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
    const cancellationRequest = await input.query.query(
      `INSERT INTO broker_events(
         event_id, account_id, order_id, order_intent_id, broker_order_id,
         client_order_id, event_type, event_status, retryable,
         response_payload, response_fingerprint, occurred_at, received_at
       ) SELECT $1, $2, $3, $4, $5, $6, 'order_cancellation_request',
                'pending', true, $7::jsonb, $8, $9, $9
         WHERE ${fenceSql(10)}
       ON CONFLICT (event_id) DO NOTHING`,
      [
        cancellationEventId,
        target.account_id,
        target.order_id,
        target.order_intent_id,
        expectedBrokerId,
        expectedClientId,
        JSON.stringify(cancellationEvidence),
        canonicalJsonHash(cancellationEvidence),
        new Date().toISOString(),
        ...fenceValues(input.fence)
      ]
    );
    if (
      cancellationRequest.rowCount !== 0 &&
      cancellationRequest.rowCount !== 1
    ) {
      throw new Error("POSTGRES_CANCEL_REQUEST_PERSISTENCE_FAILED");
    }
    try {
      await (input.cancelOrder ?? cancelPaperOrder)(expectedBrokerId);
    } catch (error) {
      const resolved = await getByClient(expectedClientId);
      const resolvedStatus = required(
        resolved.data.status,
        "POSTGRES_CANCEL_BROKER_STATUS_MISSING"
      ).toLowerCase();
      if (!terminalStatuses.has(resolvedStatus)) {
        throw new Error("POSTGRES_CANCEL_SUBMISSION_AMBIGUOUS", {
          cause: error
        });
      }
      after = resolved;
    }
    if (after === before) after = await getByClient(expectedClientId);
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
         AND COALESCE(broker_order.filled_quantity, 0) = 0
         AND (
           broker_order.submitted_at <=
             $1::timestamptz - ($2::integer * interval '1 minute')
           OR review.expires_at <= $1
           OR candidate.lifecycle_status IN (
             'expired', 'rejected', 'blocked', 'execution_deferred'
           )
           OR intent.request_payload->>'cancellable' = 'true'
           OR intent.request_payload->>'cancelBeforeReplace' = 'true'
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
