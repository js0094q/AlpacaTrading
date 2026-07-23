import assert from "node:assert/strict";
import test from "node:test";

import { reconcilePostgresPaperOrders } from "../src/services/postgresReconciliationService.js";

const fence = {
  jobName: "reconciliation", workstream: "reconciliation", ownerId: "worker",
  runId: "run", fencingToken: "7"
};

test("ambiguous submissions remain ambiguous when broker identity cannot be resolved", async () => {
  const updates: string[] = [];
  const result = await reconcilePostgresPaperOrders({
    query: {
      query: async (sql: string) => {
        if (sql.includes("FROM order_intents intent")) {
          return { rows: [{
            order_intent_id: "intent-1", account_id: "account-1",
            client_order_id: "client-1", broker_order_id: null,
            symbol: "SPY", asset_class: "equity", side: "buy",
            order_type: "market", time_in_force: "day", quantity: null,
            notional: "1000", limit_price: null, intent_status: "ambiguous"
          }], rowCount: 1 };
        }
        updates.push(sql);
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    getOrderByClientOrderId: async () => { throw new Error("not found"); }
  });

  assert.equal(result.checked, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(updates.some((sql) => sql.includes("UPDATE order_intents")), false);
});

test("resolved broker submissions are recorded exclusively in PostgreSQL", async () => {
  const sql: string[] = [];
  const result = await reconcilePostgresPaperOrders({
    query: {
      query: async (statement: string) => {
        sql.push(statement);
        if (statement.includes("FROM order_intents intent")) {
          return { rows: [{
            order_intent_id: "intent-1", account_id: "account-1",
            client_order_id: "client-1", broker_order_id: null,
            symbol: "SPY", asset_class: "equity", side: "buy",
            order_type: "market", time_in_force: "day", quantity: null,
            notional: "1000", limit_price: null, intent_status: "ambiguous"
          }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    now: new Date("2026-07-20T22:00:00.000Z"),
    getOrderByClientOrderId: async () => ({
      status: 200, requestId: "request-1", data: {
        id: "broker-1", client_order_id: "client-1", symbol: "SPY",
        asset_class: "us_equity", side: "buy", type: "market",
        time_in_force: "day", status: "accepted", qty: null,
        notional: "1000", limit_price: null, filled_qty: "0",
        filled_avg_price: null, submitted_at: "2026-07-20T21:59:59.000Z"
      }
    }) as never
  });

  assert.equal(result.recorded, 1);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO orders")), true);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO broker_events")), true);
  assert.equal(sql.some((statement) => statement.includes("UPDATE order_intents")), true);
});

test("an externally originated broker order is observed without fabricating an intent", async () => {
  const statements: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const result = await reconcilePostgresPaperOrders({
    query: {
      query: async (sql: string, values?: readonly unknown[]) => {
        statements.push({ sql, values });
        if (sql.includes("FROM order_intents intent")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("AS account_exists")) {
          return {
            rows: [{
              account_exists: true,
              intent_exists: false,
              order_exists: false
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    now: new Date("2026-07-21T20:10:00.000Z"),
    externalBrokerOrderId: "broker-external-1",
    getAccountSnapshot: async () => ({ id: "paper-account-1" }),
    getOrderById: async () => ({
      status: 200,
      requestId: "request-external-1",
      data: {
        id: "broker-external-1",
        client_order_id: "broker-assigned-client-1",
        symbol: "TQQQ",
        asset_class: "us_equity",
        side: "buy",
        position_intent: "buy_to_open",
        type: "market",
        time_in_force: "day",
        status: "accepted",
        qty: null,
        notional: "10000",
        limit_price: null,
        filled_qty: "0",
        filled_avg_price: null,
        submitted_at: "2026-07-21T20:06:17.589Z",
        updated_at: "2026-07-21T20:06:17.593Z"
      }
    }),
    safety: {
      environment: "paper",
      tradingMode: "paper",
      liveTradingEnabled: false
    }
  } as never);

  assert.deepEqual(result.externalObservation, {
    brokerOrderId: "broker-external-1",
    clientOrderId: "broker-assigned-client-1",
    status: "accepted",
    provenance: "external_order_without_postgres_intent",
    recorded: true
  });
  assert.equal(statements.some(({ sql }) => sql.includes("INSERT INTO order_intents")), false);
  assert.equal(statements.some(({ sql }) => sql.includes("INSERT INTO orders")), false);
  assert.equal(
    statements.some(({ sql }) =>
      sql.includes("INSERT INTO broker_events") && sql.includes("external_order_observed")
    ),
    true
  );
});
