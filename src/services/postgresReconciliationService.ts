import { canonicalJsonHash } from "../lib/canonicalJson.js";
import type { SchedulerFence } from "../repositories/contracts/common.js";
import { stableRecordId } from "../repositories/postgres/postgresRepositorySupport.js";
import {
  getPaperOrderByClientOrderId,
  type AlpacaApiResponse,
  type AlpacaSubmittedOrder
} from "./alpacaClient.js";

type ReconciliationQuery = {
  query: (sql: string, values?: readonly unknown[]) => Promise<{
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }>;
};

type Target = Record<string, unknown> & {
  order_intent_id: string;
  account_id: string;
  client_order_id: string;
  broker_order_id: string | null;
  symbol: string;
  asset_class: "equity" | "option";
  side: "buy" | "sell" | "buy_to_open" | "sell_to_close";
  order_type: "market" | "limit" | "stop" | "stop_limit";
  time_in_force: "day" | "gtc" | "opg" | "cls" | "ioc" | "fok";
  quantity: string | null;
  notional: string | null;
  limit_price: string | null;
  intent_status: string;
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

const targetsSql = `SELECT intent.id AS order_intent_id, intent.account_id,
       intent.client_order_id, broker_order.broker_order_id,
       intent.symbol, intent.asset_class, intent.side, intent.order_type,
       intent.time_in_force, intent.quantity::text, intent.notional::text,
       intent.limit_price::text, intent.status AS intent_status
FROM order_intents intent
LEFT JOIN LATERAL (
  SELECT * FROM orders WHERE order_intent_id = intent.id
  ORDER BY created_at DESC, id DESC LIMIT 1
) broker_order ON true
WHERE intent.environment = 'paper'
  AND intent.status IN ('submission_pending', 'submitted', 'ambiguous')
ORDER BY intent.created_at, intent.id`;

const terminalStatuses = new Set(["filled", "canceled", "cancelled", "expired", "rejected"]);

export const reconcilePostgresPaperOrders = async (input: {
  query: ReconciliationQuery;
  fence: SchedulerFence;
  now?: Date;
  getOrderByClientOrderId?: (
    clientOrderId: string
  ) => Promise<AlpacaApiResponse<AlpacaSubmittedOrder>>;
}) => {
  const now = input.now ?? new Date();
  const listed = await input.query.query(targetsSql);
  const targets = listed.rows as Target[];
  const result = {
    status: "reconciled" as const,
    checked: 0,
    recorded: 0,
    replayed: 0,
    filled: 0,
    partial: 0,
    terminal: 0,
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
      const updated = await input.query.query(
        `UPDATE order_intents SET status = $2,
           submitted_at = COALESCE(submitted_at, $3),
           terminal_at = CASE WHEN $2 = 'reconciled' THEN $4 ELSE terminal_at END,
           updated_at = $4, version = version + 1
         WHERE id = $1 AND status IN ('submission_pending','submitted','ambiguous')
           AND ${fenceSql(5)}`,
        [target.order_intent_id, intentStatus, optional(response.data.submitted_at) ?? now.toISOString(),
          now.toISOString(), ...fenceValues(input.fence)]
      );
      if (updated.rowCount !== 1) throw new Error("POSTGRES_RECONCILIATION_INTENT_PERSISTENCE_FAILED");
      if (event.rowCount === 0) result.replayed += 1;
      else result.recorded += 1;
      if (status === "filled") result.filled += 1;
      else if (status === "partially_filled") result.partial += 1;
      else if (terminalStatuses.has(status)) result.terminal += 1;
    } catch (error) {
      result.errors.push({
        orderIntentId: target.order_intent_id,
        code: error instanceof Error ? error.message.split(":", 1)[0] : "POSTGRES_RECONCILIATION_FAILED"
      });
    }
  }
  return result;
};
