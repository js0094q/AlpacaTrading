import assert from "node:assert/strict";
import test from "node:test";

import {
  runPostgresPaperOrderCancellation
} from "../src/services/postgresOrderCancellationService.js";

const fence = {
  jobName: "reconciliation",
  workstream: "reconciliation",
  ownerId: "worker",
  runId: "run",
  fencingToken: "7"
};

const brokerOrder = (status: string) => ({
  status: 200,
  url: "paper",
  data: {
    id: "broker-order-1",
    client_order_id: "E2E-CANCEL-20260723",
    symbol: "AAPL",
    asset_class: "us_equity",
    side: "buy",
    type: "limit",
    time_in_force: "day",
    status,
    qty: "1",
    limit_price: "1",
    filled_qty: "0",
    submitted_at: "2026-07-23T18:00:00.000Z",
    updated_at: "2026-07-23T18:00:01.000Z"
  }
});

test("production cancellation verifies broker identity, cancels, and reconciles PostgreSQL", async () => {
  let cancelCalls = 0;
  let reconcileCalls = 0;
  const result = await runPostgresPaperOrderCancellation({
    query: {
      query: async (sql: string) => {
        if (sql.includes("FROM orders broker_order")) {
          return {
            rows: [{
              order_id: "order-1",
              order_intent_id: "intent-1",
              account_id: "account-1",
              broker_order_id: "broker-order-1",
              client_order_id: "E2E-CANCEL-20260723",
              status: "accepted"
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    clientOrderId: "E2E-CANCEL-20260723",
    confirmPaper: true,
    safety: {
      environment: "paper",
      tradingMode: "paper",
      liveTradingEnabled: false,
      paperOrderExecutionEnabled: true
    },
    getOrderById: async () => brokerOrder("accepted") as never,
    cancelOrder: async (orderId) => {
      cancelCalls += 1;
      assert.equal(orderId, "broker-order-1");
      return { data: null, status: 204, url: "paper" };
    },
    getOrderByClientOrderId: async () => brokerOrder("canceled") as never,
    reconcile: async (input) => {
      reconcileCalls += 1;
      const observation = await input.getOrderByClientOrderId?.(
        "E2E-CANCEL-20260723"
      );
      assert.equal(observation?.data.status, "canceled");
      return {
        status: "reconciled",
        externalObservation: null,
        checked: 1,
        recorded: 1,
        replayed: 0,
        filled: 0,
        partial: 0,
        terminal: 1,
        brokerState: null,
        errors: []
      };
    }
  });

  assert.equal(result.status, "canceled");
  assert.equal(result.brokerOrderId, "broker-order-1");
  assert.equal(result.clientOrderId, "E2E-CANCEL-20260723");
  assert.equal(result.brokerStatus, "canceled");
  assert.equal(cancelCalls, 1);
  assert.equal(reconcileCalls, 1);
});

test("already-terminal cancellation is idempotent and does not call DELETE again", async () => {
  let cancelCalls = 0;
  const result = await runPostgresPaperOrderCancellation({
    query: {
      query: async (sql: string) => sql.includes("FROM orders broker_order")
        ? {
            rows: [{
              order_id: "order-1",
              order_intent_id: "intent-1",
              account_id: "account-1",
              broker_order_id: "broker-order-1",
              client_order_id: "E2E-CANCEL-20260723",
              status: "canceled"
            }],
            rowCount: 1
          }
        : { rows: [], rowCount: 1 }
    },
    fence,
    brokerOrderId: "broker-order-1",
    confirmPaper: true,
    safety: {
      environment: "paper",
      tradingMode: "paper",
      liveTradingEnabled: false,
      paperOrderExecutionEnabled: true
    },
    getOrderById: async () => brokerOrder("canceled") as never,
    cancelOrder: async () => {
      cancelCalls += 1;
      return { data: null, status: 204, url: "paper" };
    },
    getOrderByClientOrderId: async () => brokerOrder("canceled") as never,
    reconcile: async () => ({
      status: "reconciled",
      externalObservation: null,
      checked: 1,
      recorded: 1,
      replayed: 0,
      filled: 0,
      partial: 0,
      terminal: 1,
      brokerState: null,
      errors: []
    })
  });

  assert.equal(result.status, "already_terminal");
  assert.equal(cancelCalls, 0);
});

test("cancellation fails closed outside the paper runtime before PostgreSQL or Alpaca", async () => {
  await assert.rejects(
    runPostgresPaperOrderCancellation({
      query: {
        query: async () => {
          throw new Error("must not query");
        }
      },
      fence,
      brokerOrderId: "broker-order-1",
      confirmPaper: true,
      safety: {
        environment: "live",
        tradingMode: "live",
        liveTradingEnabled: true,
        paperOrderExecutionEnabled: true
      },
      getOrderById: async () => {
        throw new Error("must not read broker");
      },
      cancelOrder: async () => {
        throw new Error("must not cancel");
      }
    }),
    /PAPER_RUNTIME_REQUIRED/
  );
});
