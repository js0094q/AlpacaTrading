import assert from "node:assert/strict";
import test from "node:test";

import {
  runAutonomousPostgresPaperOrderCancellation,
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

const paperSafety = {
  environment: "paper",
  tradingMode: "paper",
  liveTradingEnabled: false,
  paperOrderExecutionEnabled: true
};

test("production cancellation verifies broker identity, cancels, and reconciles PostgreSQL", async () => {
  let cancelCalls = 0;
  let reconcileCalls = 0;
  const statements: string[] = [];
  const result = await runPostgresPaperOrderCancellation({
    query: {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("FROM orders broker_order")) {
          return {
            rows: [{
              order_id: "order-1",
              order_intent_id: "intent-1",
              account_id: "account-1",
              broker_order_id: "broker-order-1",
              client_order_id: "E2E-CANCEL-20260723",
              status: "accepted",
              lifecycle_state: "broker_order_accepted"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("AS transition_count")) {
          return {
            rows: [{
              transition_count: "1",
              updated_intent_count: "1",
              event_count: "1"
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
    safety: paperSafety,
    getOrderById: async () => brokerOrder("accepted") as never,
    cancelOrder: async (orderId) => {
      cancelCalls += 1;
      assert.equal(
        statements.some((sql) =>
          sql.includes("INSERT INTO broker_events") &&
          sql.includes("order_cancellation_request") &&
          sql.includes("INSERT INTO autonomous_trade_lifecycle_transitions") &&
          sql.includes("cancel_requested") &&
          sql.includes("UPDATE order_intents")
        ),
        true,
        "the cancellation request must be durable before DELETE reaches Alpaca"
      );
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
        pending: 0,
        failedAbsent: 0,
        brokerState: null,
        orders: [],
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

test("autonomous cancellation selects a stale eligible order and runs the production path", async () => {
  const selectedSql: string[] = [];
  let cancellationCalls = 0;
  const result = await runAutonomousPostgresPaperOrderCancellation({
    query: {
      query: async (sql: string) => {
        selectedSql.push(sql);
        if (sql.includes("autonomous_cancellation_target")) {
          return {
            rows: [{
              broker_order_id: "broker-stale",
              client_order_id: "client-stale"
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    confirmPaper: true,
    now: new Date("2026-07-23T18:45:00.000Z"),
    staleAfterMinutes: 30,
    safety: paperSafety,
    runCancellation: async (input) => {
      cancellationCalls += 1;
      assert.equal(input.brokerOrderId, "broker-stale");
      assert.equal(input.clientOrderId, "client-stale");
      return {
        status: "canceled",
        paperOnly: true,
        liveTradingEnabled: false,
        brokerOrderId: "broker-stale",
        clientOrderId: "client-stale",
        brokerStatus: "canceled",
        reconciliation: { errors: [] }
      } as never;
    }
  });

  assert.equal(cancellationCalls, 1);
  assert.equal(result.status, "canceled");
  assert.equal(
    selectedSql.some((sql) =>
      sql.includes("review.expires_at") &&
      sql.includes("candidate.lifecycle_status") &&
      sql.includes("cancellable") &&
      sql.includes("materiallyObsolete") &&
      sql.includes("recoveryCancellable") &&
      sql.includes("cancelBeforeReplace")
    ),
    true
  );
});

test("autonomous cancellation treats an empty policy selection as successful no-action", async () => {
  const result = await runAutonomousPostgresPaperOrderCancellation({
    query: {
      query: async () => ({ rows: [], rowCount: 0 })
    },
    fence,
    confirmPaper: true,
    safety: paperSafety,
    runCancellation: async () => {
      throw new Error("must not cancel");
    }
  });

  assert.deepEqual(result, {
    status: "no_op",
    code: "NO_CANCELLABLE_POSTGRES_ORDERS",
    canceledOrderCount: 0,
    paperOnly: true
  });
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
    safety: paperSafety,
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
      pending: 0,
      failedAbsent: 0,
      brokerState: null,
      orders: [],
      errors: []
    })
  });

  assert.equal(result.status, "already_terminal");
  assert.equal(cancelCalls, 0);
});

test("filled broker state is reconciled before cancellation and never calls DELETE", async () => {
  let cancelCalls = 0;
  let reconcileCalls = 0;
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
              status: "accepted",
              lifecycle_state: "broker_order_accepted"
            }],
            rowCount: 1
          }
        : { rows: [], rowCount: 1 }
    },
    fence,
    brokerOrderId: "broker-order-1",
    confirmPaper: true,
    safety: paperSafety,
    getOrderById: async () => brokerOrder("filled") as never,
    cancelOrder: async () => {
      cancelCalls += 1;
      return { data: null, status: 204, url: "paper" };
    },
    getOrderByClientOrderId: async () => brokerOrder("filled") as never,
    reconcile: async () => {
      reconcileCalls += 1;
      return {
        status: "reconciled",
        externalObservation: null,
        checked: 1,
        recorded: 1,
        replayed: 0,
        filled: 1,
        partial: 0,
        terminal: 0,
        pending: 0,
        failedAbsent: 0,
        brokerState: null,
        orders: [],
        errors: []
      };
    }
  });

  assert.equal(result.status, "already_terminal");
  assert.equal(result.brokerStatus, "filled");
  assert.equal(cancelCalls, 0);
  assert.equal(reconcileCalls, 1);
});

test("ambiguous cancellation persists state and performs bounded authoritative recovery without a second DELETE", async () => {
  const statements: string[] = [];
  const waits: number[] = [];
  let cancelCalls = 0;
  let lookups = 0;
  const result = await runPostgresPaperOrderCancellation({
    query: {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("FROM orders broker_order")) {
          return {
            rows: [{
              order_id: "order-1",
              order_intent_id: "intent-1",
              account_id: "account-1",
              broker_order_id: "broker-order-1",
              client_order_id: "E2E-CANCEL-20260723",
              status: "accepted",
              lifecycle_state: "broker_order_accepted"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("AS transition_count")) {
          return {
            rows: [{
              transition_count: "1",
              updated_intent_count: "1",
              event_count: "1"
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    brokerOrderId: "broker-order-1",
    confirmPaper: true,
    safety: paperSafety,
    maxRecoveryAttempts: 3,
    recoveryDelayMs: 5,
    sleep: async (delayMs) => { waits.push(delayMs); },
    getOrderById: async () => brokerOrder("accepted") as never,
    cancelOrder: async () => {
      cancelCalls += 1;
      throw new Error("connection reset after DELETE");
    },
    getOrderByClientOrderId: async () => {
      lookups += 1;
      return brokerOrder(lookups === 3 ? "canceled" : "pending_cancel") as never;
    },
    reconcile: async () => ({
      status: "reconciled",
      externalObservation: null,
      checked: 1,
      recorded: 1,
      replayed: 0,
      filled: 0,
      partial: 0,
      terminal: 1,
      pending: 0,
      failedAbsent: 0,
      brokerState: null,
      orders: [],
      errors: []
    })
  });

  assert.equal(result.status, "canceled");
  assert.equal(cancelCalls, 1);
  assert.equal(lookups, 3);
  assert.deepEqual(waits, [5, 10]);
  assert.equal(
    statements.some((sql) =>
      sql.includes("order_cancellation_ambiguous") &&
      sql.includes("cancel_ambiguous") &&
      sql.includes("autonomous_trade_lifecycle_transitions")
    ),
    true
  );
});

test("restart resumes cancel_ambiguous by lookup and never repeats DELETE", async () => {
  let cancelCalls = 0;
  let lookups = 0;
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
              status: "pending_cancel",
              lifecycle_state: "cancel_ambiguous"
            }],
            rowCount: 1
          }
        : { rows: [], rowCount: 1 }
    },
    fence,
    brokerOrderId: "broker-order-1",
    confirmPaper: true,
    safety: paperSafety,
    maxRecoveryAttempts: 2,
    recoveryDelayMs: 1,
    sleep: async () => undefined,
    getOrderById: async () => brokerOrder("pending_cancel") as never,
    cancelOrder: async () => {
      cancelCalls += 1;
      return { data: null, status: 204, url: "paper" };
    },
    getOrderByClientOrderId: async () => {
      lookups += 1;
      return brokerOrder(lookups === 2 ? "canceled" : "pending_cancel") as never;
    },
    reconcile: async () => ({
      status: "reconciled",
      externalObservation: null,
      checked: 1,
      recorded: 1,
      replayed: 0,
      filled: 0,
      partial: 0,
      terminal: 1,
      pending: 0,
      failedAbsent: 0,
      brokerState: null,
      orders: [],
      errors: []
    })
  });

  assert.equal(result.status, "canceled");
  assert.equal(cancelCalls, 0);
  assert.equal(lookups, 2);
});

test("authoritative recovery rejects a mismatched broker identity instead of treating it as pending", async () => {
  await assert.rejects(
    runPostgresPaperOrderCancellation({
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
                status: "accepted",
                lifecycle_state: "broker_order_accepted"
              }],
              rowCount: 1
            };
          }
          if (sql.includes("AS transition_count")) {
            return {
              rows: [{
                transition_count: "1",
                updated_intent_count: "1",
                event_count: "1"
              }],
              rowCount: 1
            };
          }
          return { rows: [], rowCount: 1 };
        }
      },
      fence,
      brokerOrderId: "broker-order-1",
      confirmPaper: true,
      safety: paperSafety,
      maxRecoveryAttempts: 2,
      recoveryDelayMs: 1,
      sleep: async () => undefined,
      getOrderById: async () => brokerOrder("accepted") as never,
      cancelOrder: async () => ({ data: null, status: 204, url: "paper" }),
      getOrderByClientOrderId: async () => ({
        ...brokerOrder("pending_cancel"),
        data: {
          ...brokerOrder("pending_cancel").data,
          id: "different-broker-order"
        }
      }) as never
    }),
    /POSTGRES_CANCEL_RECOVERY_IDENTITY_MISMATCH/
  );
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
