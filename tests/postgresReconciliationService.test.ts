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
