import assert from "node:assert/strict";
import test from "node:test";

import {
  persistPostgresAuthorityBrokerSnapshot,
  reconcilePostgresPaperOrders,
  recoverAmbiguousPostgresSubmission
} from "../src/services/postgresReconciliationService.js";

const fence = {
  jobName: "reconciliation", workstream: "reconciliation", ownerId: "worker",
  runId: "run", fencingToken: "7"
};

test("recent ambiguous broker absence remains pending without blocking the worker", async () => {
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
            notional: "1000", limit_price: null, intent_status: "ambiguous",
            intent_updated_at: "2026-07-20T21:59:45.000Z"
          }], rowCount: 1 };
        }
        if (sql.includes("AS prior_absence_count")) {
          return {
            rows: [{
              prior_absence_count: "0",
              first_attempt_at: "2026-07-20T21:59:45.000Z"
            }],
            rowCount: 1
          };
        }
        updates.push(sql);
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    syncBrokerState: false,
    now: new Date("2026-07-20T22:00:00.000Z"),
    getOrderByClientOrderId: async () => { throw new Error("404 order not found"); }
  });

  assert.equal(result.checked, 1);
  assert.equal(result.pending, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(updates.some((sql) => sql.includes("UPDATE order_intents")), false);
});

test("defined terminal broker-absence policy fails the intent and releases its reservation", async () => {
  const statements: string[] = [];
  const result = await reconcilePostgresPaperOrders({
    query: {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("FROM order_intents intent")) {
          return {
            rows: [{
              order_intent_id: "intent-absent",
              account_id: "account-1",
              client_order_id: "client-absent",
              broker_order_id: null,
              reservation_id: "reservation-absent",
              strategy_key: "baseline",
              symbol: "AAPL",
              asset_class: "equity",
              side: "buy",
              order_type: "market",
              time_in_force: "day",
              quantity: "1",
              notional: null,
              limit_price: null,
              intent_status: "ambiguous",
              intent_updated_at: "2026-07-20T21:55:00.000Z"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("AS prior_absence_count")) {
          return {
            rows: [{
              prior_absence_count: "3",
              first_attempt_at: "2026-07-20T21:55:00.000Z"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("failed_intent_count")) {
          return {
            rows: [{
              failed_intent_count: "1",
              released_reservation_count: "1",
              adjusted_allocation_count: "1"
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    syncBrokerState: false,
    now: new Date("2026-07-20T22:00:00.000Z"),
    getOrderByClientOrderId: async () => { throw new Error("404 order not found"); }
  });

  assert.equal(result.failedAbsent, 1);
  assert.equal(result.pending, 0);
  assert.equal(result.errors.length, 0);
  assert.equal(
    statements.some((sql) =>
      sql.includes("SET status = 'failed'") &&
      sql.includes("status = 'released'")
    ),
    true
  );
});

test("a worker restart resumes persisted ambiguous submission by exact client identity without resubmission", async () => {
  const lookups: string[] = [];
  const waits: number[] = [];
  const queryValues: Array<readonly unknown[]> = [];
  const result = await recoverAmbiguousPostgresSubmission({
    query: {
      query: async (sql: string, values?: readonly unknown[]) => {
        queryValues.push(values ?? []);
        if (sql.includes("FROM order_intents intent")) {
          return {
            rows: [{
              order_intent_id: "intent-recovery",
              account_id: "account-1",
              client_order_id: "client-recovery",
              broker_order_id: null,
              reservation_id: null,
              strategy_key: "baseline",
              symbol: "AAPL",
              asset_class: "equity",
              side: "buy",
              order_type: "market",
              time_in_force: "day",
              quantity: "1",
              notional: null,
              limit_price: null,
              intent_status: "ambiguous",
              review_type: "entry",
              lifecycle_state: "submission_ambiguous"
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    clientOrderId: "client-recovery",
    maxAttempts: 3,
    retryDelayMs: 25,
    sleep: async (delayMs) => {
      waits.push(delayMs);
    },
    syncBrokerState: false,
    getOrderByClientOrderId: async (clientOrderId) => {
      lookups.push(clientOrderId);
      if (lookups.length === 1) throw new Error("not found yet");
      return {
        status: 200,
        requestId: "request-recovery",
        data: {
          id: "broker-recovery",
          client_order_id: clientOrderId,
          symbol: "AAPL",
          asset_class: "us_equity",
          side: "buy",
          type: "market",
          time_in_force: "day",
          status: "accepted",
          qty: "1",
          filled_qty: "0",
          submitted_at: "2026-07-20T22:00:00.000Z"
        }
      } as never;
    }
  });

  assert.deepEqual(lookups, ["client-recovery", "client-recovery"]);
  assert.deepEqual(waits, [25]);
  assert.equal(result.status, "recovered");
  assert.equal(result.brokerOrderId, "broker-recovery");
  assert.equal(result.attempts, 2);
  assert.equal(
    queryValues.some((values) => values[0] === "client-recovery"),
    true,
    "reconciliation must select only the ambiguous client order"
  );
});

test("ambiguous submission recovery remains pending after the bounded absence policy", async () => {
  let lookups = 0;
  const result = await recoverAmbiguousPostgresSubmission({
    query: {
      query: async () => ({ rows: [], rowCount: 0 })
    },
    fence,
    clientOrderId: "client-not-yet-visible",
    maxAttempts: 3,
    retryDelayMs: 1,
    sleep: async () => undefined,
    syncBrokerState: false,
    getOrderByClientOrderId: async () => {
      lookups += 1;
      throw new Error("broker identity not visible");
    }
  });

  assert.equal(lookups, 3);
  assert.deepEqual(result, {
    status: "pending",
    attempts: 3,
    code: "POSTGRES_BROKER_SUBMISSION_RECOVERY_PENDING"
  });
});

test("default ambiguous recovery uses eight exponential lookups capped at five seconds", async () => {
  const waits: number[] = [];
  let lookups = 0;
  const result = await recoverAmbiguousPostgresSubmission({
    query: { query: async () => ({ rows: [], rowCount: 0 }) },
    fence,
    clientOrderId: "client-default-policy",
    sleep: async (delayMs) => { waits.push(delayMs); },
    syncBrokerState: false,
    getOrderByClientOrderId: async () => {
      lookups += 1;
      throw new Error("not visible yet");
    }
  });
  assert.equal(lookups, 8);
  assert.deepEqual(waits, [500, 1000, 2000, 4000, 5000, 5000, 5000]);
  assert.deepEqual(result, {
    status: "pending",
    attempts: 8,
    code: "POSTGRES_BROKER_SUBMISSION_RECOVERY_PENDING"
  });
});

test("HTTP 500 lookup errors mentioning visibility remain infrastructure failures", async () => {
  await assert.rejects(
    recoverAmbiguousPostgresSubmission({
      query: { query: async () => ({ rows: [], rowCount: 0 }) },
      fence,
      clientOrderId: "client-infrastructure-failure",
      maxAttempts: 2,
      retryDelayMs: 1,
      sleep: async () => undefined,
      syncBrokerState: false,
      getOrderByClientOrderId: async () => {
        throw Object.assign(
          new Error("order not visible while broker unavailable"),
          { status: 500 }
        );
      }
    }),
    /POSTGRES_BROKER_SUBMISSION_RECOVERY_INFRASTRUCTURE_UNRESOLVED/
  );
});

test("resolved broker submissions are recorded exclusively in PostgreSQL", async () => {
  const sql: string[] = [];
  let atomicValues: readonly unknown[] = [];
  const result = await reconcilePostgresPaperOrders({
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        sql.push(statement);
        if (statement.includes("FROM order_intents intent")) {
          return { rows: [{
            order_intent_id: "intent-1", account_id: "account-1",
            client_order_id: "client-1", broker_order_id: null,
            symbol: "SPY", asset_class: "equity", side: "buy",
            order_type: "market", time_in_force: "day", quantity: null,
            notional: "1000", limit_price: null, intent_status: "ambiguous",
            review_type: "entry", lifecycle_state: "submission_ambiguous"
          }], rowCount: 1 };
        }
        if (statement.includes("INSERT INTO orders")) {
          atomicValues = values ?? [];
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    syncBrokerState: false,
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
  const atomicObservation = sql.find((statement) =>
    statement.includes("INSERT INTO orders") &&
    statement.includes("INSERT INTO broker_events") &&
    statement.includes("INSERT INTO autonomous_trade_lifecycle_transitions") &&
    statement.includes("UPDATE order_intents")
  );
  assert.ok(
    atomicObservation,
    "order, event, ordered lifecycle audit, and intent must share one statement"
  );
  assert.match(atomicObservation, /unnest\([\s\S]*WITH ORDINALITY/);
  assert.match(atomicObservation, /ORDER BY transition_path\.ordinal/);
  assert.deepEqual(atomicValues[26], [
    "submission_ambiguous",
    "broker_order_discovered"
  ]);
  assert.deepEqual(atomicValues[27], [
    "broker_order_discovered",
    "broker_order_accepted"
  ]);
});

test("terminal cancellation releases the committed reservation without deployed allocation", async () => {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const result = await reconcilePostgresPaperOrders({
    query: {
      query: async (sql: string, values?: readonly unknown[]) => {
        statements.push({ sql, values: values ?? [] });
        if (sql.includes("FROM order_intents intent")) {
          return {
            rows: [{
              order_intent_id: "intent-cancel", account_id: "account-1",
              client_order_id: "client-cancel", broker_order_id: "broker-cancel",
              reservation_id: "reservation-cancel", strategy_key: "baseline",
              symbol: "AAPL", asset_class: "equity", side: "buy",
              order_type: "limit", time_in_force: "day", quantity: "1",
              notional: null, limit_price: "1", intent_status: "submitted",
              lifecycle_state: "cancel_ambiguous",
              prior_filled_quantity: "0"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("released_reservation_count")) {
          return {
            rows: [{
              released_reservation_count: "1",
              adjusted_allocation_count: "1",
              terminal_transition_count: "1"
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    syncBrokerState: false,
    now: new Date("2026-07-20T22:00:00.000Z"),
    getOrderByClientOrderId: async () => ({
      status: 200,
      requestId: "request-cancel",
      data: {
        id: "broker-cancel",
        client_order_id: "client-cancel",
        symbol: "AAPL",
        asset_class: "us_equity",
        side: "buy",
        type: "limit",
        time_in_force: "day",
        status: "canceled",
        qty: "1",
        notional: null,
        limit_price: "1",
        filled_qty: "0",
        filled_avg_price: null,
        submitted_at: "2026-07-20T21:59:00.000Z",
        updated_at: "2026-07-20T21:59:30.000Z",
        canceled_at: "2026-07-20T21:59:30.000Z"
      }
    }) as never
  });

  assert.equal(result.terminal, 1);
  const release = statements.find(({ sql }) => sql.includes("released_reservation_count"));
  assert.ok(release);
  assert.match(release.sql, /status = 'released'/);
  assert.match(release.sql, /deployed_amount = allocation\.deployed_amount/);
  assert.match(release.sql, /INSERT INTO reservation_terminal_transitions/);
  assert.equal(release.values[3], "cancelled");
  assert.equal(release.values[4], "broker_terminal_cancelled");
  const lifecycle = statements.find(({ sql }) =>
    sql.includes("UPDATE order_intents") &&
    sql.includes("INSERT INTO autonomous_trade_lifecycle_transitions")
  );
  assert.ok(
    lifecycle,
    "lifecycle audit append and lifecycle update must share one atomic statement"
  );
  assert.deepEqual(lifecycle.values[26], ["cancel_ambiguous"]);
  assert.deepEqual(lifecycle.values[27], ["cancelled"]);
});

test("terminal fill transfers the reservation into deployed allocation exactly once", async () => {
  const statements: string[] = [];
  await reconcilePostgresPaperOrders({
    query: {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("FROM order_intents intent")) {
          return {
            rows: [{
              order_intent_id: "intent-fill", account_id: "account-1",
              client_order_id: "client-fill", broker_order_id: "broker-fill",
              reservation_id: "reservation-fill", strategy_key: "baseline",
              symbol: "AAPL", asset_class: "equity", side: "buy",
              order_type: "market", time_in_force: "day", quantity: "1",
              notional: null, limit_price: null, intent_status: "submitted",
              review_type: "entry", lifecycle_state: "broker_order_accepted",
              prior_filled_quantity: "0"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("released_reservation_count")) {
          return {
            rows: [{
              released_reservation_count: "1",
              adjusted_allocation_count: "1",
              terminal_transition_count: "1"
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    syncBrokerState: false,
    now: new Date("2026-07-20T22:00:00.000Z"),
    getOrderByClientOrderId: async () => ({
      status: 200,
      data: {
        id: "broker-fill", client_order_id: "client-fill", symbol: "AAPL",
        asset_class: "us_equity", side: "buy", type: "market",
        time_in_force: "day", status: "filled", qty: "1", filled_qty: "1",
        filled_avg_price: "200", submitted_at: "2026-07-20T21:59:00.000Z",
        filled_at: "2026-07-20T21:59:10.000Z"
      }
    }) as never
  });

  const release = statements.find((sql) => sql.includes("released_reservation_count"));
  assert.ok(release);
  assert.match(release, /CASE WHEN \$4 = 'filled' THEN released\.amount/);
  assert.match(release, /reservation\.status IN \('active', 'committed'\)/);
  assert.match(release, /INSERT INTO reservation_terminal_transitions/);
});

test("terminal exit settlement validates the exit lifecycle state separately from the filled reservation state", async () => {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const result = await reconcilePostgresPaperOrders({
    query: {
      query: async (sql: string, values?: readonly unknown[]) => {
        statements.push({ sql, values: values ?? [] });
        if (sql.includes("FROM order_intents intent")) {
          return {
            rows: [{
              order_intent_id: "intent-exit-fill",
              account_id: "account-1",
              client_order_id: "client-exit-fill",
              broker_order_id: "broker-exit-fill",
              reservation_id: "reservation-exit-fill",
              strategy_key: "baseline",
              review_type: "exit",
              symbol: "AAPL",
              asset_class: "equity",
              side: "sell_to_close",
              order_type: "market",
              time_in_force: "day",
              quantity: "1",
              notional: null,
              limit_price: null,
              intent_status: "submitted",
              lifecycle_state: "exit_submission_attempt_persisted",
              prior_filled_quantity: "0"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("released_reservation_count")) {
          return {
            rows: [{
              released_reservation_count: "1",
              adjusted_allocation_count: "1",
              terminal_transition_count: "1",
              existing_terminal_transition_count: "0",
              legacy_settlement_count: "0"
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    syncBrokerState: false,
    now: new Date("2026-07-24T22:00:00.000Z"),
    getOrderByClientOrderId: async () => ({
      status: 200,
      data: {
        id: "broker-exit-fill",
        client_order_id: "client-exit-fill",
        symbol: "AAPL",
        asset_class: "us_equity",
        side: "sell",
        type: "market",
        time_in_force: "day",
        status: "filled",
        qty: "1",
        filled_qty: "1",
        filled_avg_price: "205",
        submitted_at: "2026-07-24T21:59:59.800Z",
        filled_at: "2026-07-24T21:59:59.900Z",
        updated_at: "2026-07-24T21:59:59.950Z"
      }
    }) as never
  });

  assert.equal(result.filled, 1);
  assert.equal(result.errors.length, 0);
  const settlement = statements.find(({ sql }) =>
    sql.includes("released_reservation_count")
  );
  assert.ok(settlement);
  assert.match(settlement.sql, /current_intent\.lifecycle_state = \$13/);
  assert.equal(settlement.values[3], "filled");
  assert.equal(settlement.values[12], "exit_broker_order_discovered");
});

test("partial fill resizes only the remaining reservation and allocation atomically", async () => {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const result = await reconcilePostgresPaperOrders({
    query: {
      query: async (sql: string, values?: readonly unknown[]) => {
        statements.push({ sql, values: values ?? [] });
        if (sql.includes("FROM order_intents intent")) {
          return {
            rows: [{
              order_intent_id: "intent-partial",
              account_id: "account-1",
              client_order_id: "client-partial",
              broker_order_id: "broker-partial",
              reservation_id: "reservation-partial",
              strategy_key: "baseline",
              review_type: "entry",
              symbol: "AAPL",
              asset_class: "equity",
              side: "buy",
              order_type: "limit",
              time_in_force: "day",
              quantity: "10",
              notional: null,
              limit_price: "100",
              intent_status: "submitted",
              lifecycle_state: "broker_order_accepted",
              prior_filled_quantity: "0"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("partial_reservation_count")) {
          return {
            rows: [{
              stored_order_count: "1",
              event_count: "1",
              updated_intent_count: "1",
              partial_reservation_count: "1",
              adjusted_allocation_count: "1"
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    syncBrokerState: false,
    now: new Date("2026-07-20T22:00:00.000Z"),
    getOrderByClientOrderId: async () => ({
      status: 200,
      data: {
        id: "broker-partial",
        client_order_id: "client-partial",
        symbol: "AAPL",
        asset_class: "us_equity",
        side: "buy",
        type: "limit",
        time_in_force: "day",
        status: "partially_filled",
        qty: "10",
        limit_price: "100",
        filled_qty: "4",
        filled_avg_price: "99",
        submitted_at: "2026-07-20T21:59:00.000Z",
        updated_at: "2026-07-20T21:59:30.000Z"
      }
    }) as never
  });

  assert.equal(result.partial, 1);
  const partial = statements.find(({ sql }) =>
    sql.includes("partial_reservation_count")
  );
  assert.ok(partial);
  assert.match(partial.sql, /UPDATE buying_power_reservations/);
  assert.match(partial.sql, /INSERT INTO orders/);
  assert.match(partial.sql, /INSERT INTO broker_events/);
  assert.match(partial.sql, /UPDATE order_intents/);
  assert.match(partial.sql, /unnest\([\s\S]*WITH ORDINALITY/);
  assert.match(partial.sql, /ORDER BY transition_path\.ordinal/);
  assert.match(partial.sql, /amount = resized\.remaining_amount/);
  assert.match(partial.sql, /reserved_amount = allocation\.reserved_amount - resized\.settled_amount/);
  assert.match(partial.sql, /deployed_amount = allocation\.deployed_amount \+ resized\.settled_amount/);
  assert.doesNotMatch(partial.sql, /reservation_terminal_transitions/);
  assert.deepEqual(partial.values.slice(3, 6), ["4", "10", "0"]);
  assert.deepEqual(partial.values[28], ["broker_order_accepted"]);
  assert.deepEqual(partial.values[29], ["partially_filled"]);
});

test("partial reconciliation rolls back as one statement and replays the same fill exactly once", async () => {
  let committedFilledQuantity = "0";
  let settlementCount = 0;
  let failAtomicWrite = true;
  const query = {
    query: async (sql: string) => {
      if (sql.includes("FROM order_intents intent")) {
        return {
          rows: [{
            order_intent_id: "intent-partial-restart",
            account_id: "account-1",
            client_order_id: "client-partial-restart",
            broker_order_id: "broker-partial-restart",
            reservation_id: "reservation-partial-restart",
            strategy_key: "baseline",
            review_type: "entry",
            symbol: "AAPL",
            asset_class: "equity",
            side: "buy",
            order_type: "limit",
            time_in_force: "day",
            quantity: "10",
            notional: null,
            limit_price: "100",
            intent_status: "submitted",
            lifecycle_state: committedFilledQuantity === "0"
              ? "broker_order_accepted"
              : "partially_filled",
            prior_filled_quantity: committedFilledQuantity
          }],
          rowCount: 1
        };
      }
      if (sql.includes("partial_reservation_count")) {
        assert.match(sql, /INSERT INTO orders/);
        assert.match(sql, /INSERT INTO broker_events/);
        assert.match(sql, /UPDATE order_intents/);
        if (failAtomicWrite) {
          failAtomicWrite = false;
          throw new Error("injected atomic persistence failure");
        }
        if (committedFilledQuantity === "0") {
          committedFilledQuantity = "4";
          settlementCount += 1;
          return {
            rows: [{
              stored_order_count: "1",
              event_count: "1",
              updated_intent_count: "1",
              partial_reservation_count: "1",
              adjusted_allocation_count: "1"
            }],
            rowCount: 1
          };
        }
        return {
          rows: [{
            stored_order_count: "1",
            event_count: "0",
            updated_intent_count: "1",
            partial_reservation_count: "0",
            adjusted_allocation_count: "0"
          }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 1 };
    }
  };
  const run = () => reconcilePostgresPaperOrders({
    query,
    fence,
    syncBrokerState: false,
    now: new Date("2026-07-20T22:00:00.000Z"),
    getOrderByClientOrderId: async () => ({
      status: 200,
      data: {
        id: "broker-partial-restart",
        client_order_id: "client-partial-restart",
        symbol: "AAPL",
        asset_class: "us_equity",
        side: "buy",
        type: "limit",
        time_in_force: "day",
        status: "partially_filled",
        qty: "10",
        limit_price: "100",
        filled_qty: "4",
        filled_avg_price: "99",
        submitted_at: "2026-07-20T21:59:00.000Z",
        updated_at: "2026-07-20T21:59:30.000Z"
      }
    }) as never
  });

  const failed = await run();
  assert.equal(failed.partial, 0);
  assert.match(failed.errors[0]?.code ?? "", /injected atomic persistence failure/);
  assert.equal(committedFilledQuantity, "0");

  const resumed = await run();
  assert.equal(resumed.partial, 1);
  assert.equal(resumed.errors.length, 0);
  assert.equal(settlementCount, 1);

  const replayed = await run();
  assert.equal(replayed.partial, 1);
  assert.equal(replayed.errors.length, 0);
  assert.equal(settlementCount, 1);
});

test("terminal reservation settlement is a successful replay after its unique transition exists", async () => {
  let settlementCalls = 0;
  const result = await reconcilePostgresPaperOrders({
    query: {
      query: async (sql: string) => {
        if (sql.includes("FROM order_intents intent")) {
          return {
            rows: [{
              order_intent_id: "intent-cancel-replay",
              account_id: "account-1",
              client_order_id: "client-cancel-replay",
              broker_order_id: "broker-cancel-replay",
              reservation_id: "reservation-cancel-replay",
              strategy_key: "baseline",
              review_type: "entry",
              symbol: "AAPL",
              asset_class: "equity",
              side: "buy",
              order_type: "limit",
              time_in_force: "day",
              quantity: "1",
              notional: null,
              limit_price: "1",
              intent_status: "submitted",
              lifecycle_state: "cancel_ambiguous",
              prior_filled_quantity: "0"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("released_reservation_count")) {
          settlementCalls += 1;
          return {
            rows: [{
              released_reservation_count: "0",
              adjusted_allocation_count: "0",
              terminal_transition_count: "0",
              existing_terminal_transition_count: "1"
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    syncBrokerState: false,
    now: new Date("2026-07-20T22:00:00.000Z"),
    getOrderByClientOrderId: async () => ({
      status: 200,
      data: {
        id: "broker-cancel-replay",
        client_order_id: "client-cancel-replay",
        symbol: "AAPL",
        asset_class: "us_equity",
        side: "buy",
        type: "limit",
        time_in_force: "day",
        status: "canceled",
        qty: "1",
        limit_price: "1",
        filled_qty: "0",
        submitted_at: "2026-07-20T21:59:00.000Z",
        updated_at: "2026-07-20T21:59:30.000Z",
        canceled_at: "2026-07-20T21:59:30.000Z"
      }
    }) as never
  });

  assert.equal(result.terminal, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(settlementCalls, 1);
});

test("terminal reconciliation preserves monotonic order timestamps when the broker fill predates local persistence", async () => {
  const statements: string[] = [];
  const result = await reconcilePostgresPaperOrders({
    query: {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("FROM order_intents intent")) {
          return {
            rows: [{
              order_intent_id: "intent-terminal-clock-skew",
              account_id: "account-1",
              client_order_id: "client-terminal-clock-skew",
              broker_order_id: "broker-terminal-clock-skew",
              reservation_id: null,
              strategy_key: "baseline",
              review_type: "entry",
              symbol: "AAPL",
              asset_class: "equity",
              side: "buy",
              order_type: "market",
              time_in_force: "day",
              quantity: "1",
              notional: null,
              limit_price: null,
              intent_status: "submitted",
              lifecycle_state: "broker_order_accepted",
              prior_filled_quantity: "0"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("stored_order_count")) {
          return {
            rows: [{
              stored_order_count: "1",
              event_count: "1",
              updated_intent_count: "1",
              lifecycle_transition_count: "1"
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    syncBrokerState: false,
    now: new Date("2026-07-24T22:00:00.000Z"),
    getOrderByClientOrderId: async () => ({
      status: 200,
      data: {
        id: "broker-terminal-clock-skew",
        client_order_id: "client-terminal-clock-skew",
        symbol: "AAPL",
        asset_class: "us_equity",
        side: "buy",
        type: "market",
        time_in_force: "day",
        status: "filled",
        qty: "1",
        filled_qty: "1",
        filled_avg_price: "200",
        submitted_at: "2026-07-24T21:59:59.800Z",
        filled_at: "2026-07-24T21:59:59.900Z",
        updated_at: "2026-07-24T21:59:59.950Z"
      }
    }) as never
  });

  assert.equal(result.errors.length, 0);
  const terminalPersistence = statements.find((sql) =>
    sql.includes("stored_order_count")
  );
  assert.match(
    terminalPersistence ?? "",
    /updated_at = GREATEST\(\s*orders\.updated_at,\s*orders\.created_at,\s*EXCLUDED\.updated_at\s*\)/
  );
  assert.match(
    terminalPersistence ?? "",
    /last_broker_update_at = GREATEST\(\s*orders\.last_broker_update_at,\s*EXCLUDED\.last_broker_update_at\s*\)/
  );
});

test("pre-lifecycle terminal replay releases an unrepresented committed reservation without changing allocation", async () => {
  const statements: string[] = [];
  const result = await reconcilePostgresPaperOrders({
    query: {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("FROM order_intents intent")) {
          return {
            rows: [{
              order_intent_id: "intent-legacy-terminal",
              account_id: "account-1",
              client_order_id: "client-legacy-terminal",
              broker_order_id: "broker-legacy-terminal",
              reservation_id: "reservation-legacy-terminal",
              strategy_key: "baseline",
              review_type: "entry",
              symbol: "AAPL",
              asset_class: "equity",
              side: "buy",
              order_type: "market",
              time_in_force: "day",
              quantity: "1",
              notional: null,
              limit_price: null,
              intent_status: "reconciled",
              lifecycle_state: "filled",
              prior_filled_quantity: "1"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("stored_order_count")) {
          return {
            rows: [{
              stored_order_count: "1",
              event_count: "0",
              updated_intent_count: "1",
              lifecycle_transition_count: "0"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("released_reservation_count")) {
          return {
            rows: [{
              released_reservation_count: "1",
              adjusted_allocation_count: "0",
              terminal_transition_count: "1",
              existing_terminal_transition_count: "0",
              legacy_settlement_count: "1"
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    syncBrokerState: false,
    now: new Date("2026-07-24T22:00:00.000Z"),
    getOrderByClientOrderId: async () => ({
      status: 200,
      data: {
        id: "broker-legacy-terminal",
        client_order_id: "client-legacy-terminal",
        symbol: "AAPL",
        asset_class: "us_equity",
        side: "buy",
        type: "market",
        time_in_force: "day",
        status: "filled",
        qty: "1",
        filled_qty: "1",
        filled_avg_price: "200",
        submitted_at: "2026-07-17T17:41:53.778Z",
        filled_at: "2026-07-17T17:41:53.784Z",
        updated_at: "2026-07-17T17:41:53.785Z"
      }
    }) as never
  });

  assert.equal(result.filled, 1);
  assert.equal(result.errors.length, 0);
  const settlement = statements.find((sql) =>
    sql.includes("released_reservation_count")
  );
  assert.match(settlement ?? "", /FROM schema_migrations/);
  assert.match(settlement ?? "", /migration\.version = 6/);
  assert.match(settlement ?? "", /current_order_intent\.created_at < lifecycle_cutover\.applied_at/);
  assert.match(settlement ?? "", /allocation\.reserved_amount = 0/);
  assert.match(settlement ?? "", /settlement_kind = 'legacy_unrepresented'/);
});

test("overlapping terminal settlement verifies an all-zero stale snapshot in a new fenced statement", async () => {
  const statements: string[] = [];
  const result = await reconcilePostgresPaperOrders({
    query: {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("FROM order_intents intent")) {
          return {
            rows: [{
              order_intent_id: "intent-concurrent-terminal",
              account_id: "account-1",
              client_order_id: "client-concurrent-terminal",
              broker_order_id: "broker-concurrent-terminal",
              reservation_id: "reservation-concurrent-terminal",
              strategy_key: "baseline",
              review_type: "entry",
              symbol: "AAPL",
              asset_class: "equity",
              side: "buy",
              order_type: "market",
              time_in_force: "day",
              quantity: "1",
              notional: null,
              limit_price: null,
              intent_status: "reconciled",
              lifecycle_state: "filled",
              prior_filled_quantity: "1"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("stored_order_count")) {
          return {
            rows: [{
              stored_order_count: "1",
              event_count: "0",
              updated_intent_count: "1",
              lifecycle_transition_count: "0"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("released_reservation_count")) {
          return {
            rows: [{
              released_reservation_count: "0",
              adjusted_allocation_count: "0",
              terminal_transition_count: "0",
              existing_terminal_transition_count: "0",
              legacy_settlement_count: "0"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("concurrent_replay_count")) {
          return {
            rows: [{ concurrent_replay_count: "1" }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    syncBrokerState: false,
    now: new Date("2026-07-24T22:00:00.000Z"),
    getOrderByClientOrderId: async () => ({
      status: 200,
      data: {
        id: "broker-concurrent-terminal",
        client_order_id: "client-concurrent-terminal",
        symbol: "AAPL",
        asset_class: "us_equity",
        side: "buy",
        type: "market",
        time_in_force: "day",
        status: "filled",
        qty: "1",
        filled_qty: "1",
        filled_avg_price: "200",
        submitted_at: "2026-07-17T17:41:53.778Z",
        filled_at: "2026-07-17T17:41:53.784Z",
        updated_at: "2026-07-17T17:41:53.785Z"
      }
    }) as never
  });

  assert.equal(result.filled, 1);
  assert.equal(result.errors.length, 0);
  const replayVerification = statements.find((sql) =>
    sql.includes("concurrent_replay_count")
  );
  assert.match(replayVerification ?? "", /reservation\.status = 'released'/);
  assert.match(replayVerification ?? "", /reservation\.release_reason = \$4/);
  assert.match(replayVerification ?? "", /transition\.terminal_state = \$3/);
  assert.match(replayVerification ?? "", /transition\.release_reason = \$4/);
  assert.match(replayVerification ?? "", /scheduler_leases/);
});

test("all-zero terminal settlement still fails closed when no exact concurrent replay exists", async () => {
  const result = await reconcilePostgresPaperOrders({
    query: {
      query: async (sql: string) => {
        if (sql.includes("FROM order_intents intent")) {
          return {
            rows: [{
              order_intent_id: "intent-zero-terminal",
              account_id: "account-1",
              client_order_id: "client-zero-terminal",
              broker_order_id: "broker-zero-terminal",
              reservation_id: "reservation-zero-terminal",
              strategy_key: "baseline",
              review_type: "entry",
              symbol: "AAPL",
              asset_class: "equity",
              side: "buy",
              order_type: "market",
              time_in_force: "day",
              quantity: "1",
              notional: null,
              limit_price: null,
              intent_status: "reconciled",
              lifecycle_state: "filled",
              prior_filled_quantity: "1"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("stored_order_count")) {
          return {
            rows: [{
              stored_order_count: "1",
              event_count: "0",
              updated_intent_count: "1",
              lifecycle_transition_count: "0"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("released_reservation_count")) {
          return {
            rows: [{
              released_reservation_count: "0",
              adjusted_allocation_count: "0",
              terminal_transition_count: "0",
              existing_terminal_transition_count: "0",
              legacy_settlement_count: "0"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("concurrent_replay_count")) {
          return {
            rows: [{ concurrent_replay_count: "0" }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    syncBrokerState: false,
    now: new Date("2026-07-24T22:00:00.000Z"),
    getOrderByClientOrderId: async () => ({
      status: 200,
      data: {
        id: "broker-zero-terminal",
        client_order_id: "client-zero-terminal",
        symbol: "AAPL",
        asset_class: "us_equity",
        side: "buy",
        type: "market",
        time_in_force: "day",
        status: "filled",
        qty: "1",
        filled_qty: "1",
        filled_avg_price: "200",
        submitted_at: "2026-07-17T17:41:53.778Z",
        filled_at: "2026-07-17T17:41:53.784Z",
        updated_at: "2026-07-17T17:41:53.785Z"
      }
    }) as never
  });

  assert.equal(result.filled, 0);
  assert.deepEqual(result.errors, [{
    orderIntentId: "intent-zero-terminal",
    code: "POSTGRES_RECONCILIATION_RESERVATION_RELEASE_FAILED"
  }]);
});

test("restart can reselect a reconciled intent whose terminal reservation settlement is pending", async () => {
  const statements: string[] = [];
  const result = await reconcilePostgresPaperOrders({
    query: {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("FROM order_intents intent")) {
          return {
            rows: [{
              order_intent_id: "intent-terminal-retry",
              account_id: "account-1",
              client_order_id: "client-terminal-retry",
              broker_order_id: "broker-terminal-retry",
              reservation_id: "reservation-terminal-retry",
              strategy_key: "baseline",
              review_type: "entry",
              symbol: "AAPL",
              asset_class: "equity",
              side: "buy",
              order_type: "limit",
              time_in_force: "day",
              quantity: "1",
              notional: null,
              limit_price: "1",
              intent_status: "reconciled",
              lifecycle_state: "cancelled",
              prior_filled_quantity: "0"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("released_reservation_count")) {
          return {
            rows: [{
              released_reservation_count: "1",
              adjusted_allocation_count: "1",
              terminal_transition_count: "1",
              existing_terminal_transition_count: "0"
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    syncBrokerState: false,
    now: new Date("2026-07-20T22:00:00.000Z"),
    getOrderByClientOrderId: async () => ({
      status: 200,
      data: {
        id: "broker-terminal-retry",
        client_order_id: "client-terminal-retry",
        symbol: "AAPL",
        asset_class: "us_equity",
        side: "buy",
        type: "limit",
        time_in_force: "day",
        status: "canceled",
        qty: "1",
        limit_price: "1",
        filled_qty: "0",
        submitted_at: "2026-07-20T21:59:00.000Z",
        updated_at: "2026-07-20T21:59:30.000Z",
        canceled_at: "2026-07-20T21:59:30.000Z"
      }
    }) as never
  });

  assert.equal(result.terminal, 1);
  const selection = statements.find((sql) =>
    sql.includes("FROM order_intents intent")
  );
  assert.match(selection ?? "", /intent\.status = 'reconciled'/);
  assert.match(selection ?? "", /reservation_terminal_transitions/);
  assert.match(
    selection ?? "",
    /buying_power_reservations[\s\S]*status IN \('active', 'committed'\)/
  );
  const intentUpdate = statements.find((sql) =>
    sql.includes("UPDATE order_intents")
  );
  assert.match(intentUpdate ?? "", /'reconciled'/);
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
    syncBrokerState: false,
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

test("reconciliation synchronizes broker account and positions into PostgreSQL authority", async () => {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const result = await reconcilePostgresPaperOrders({
    query: {
      query: async (sql: string, values?: readonly unknown[]) => {
        statements.push({ sql, values: values ?? [] });
        if (sql.includes("FROM order_intents intent")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("FROM buying_power_reservations")) {
          return { rows: [{ reserved_capital: "100" }], rowCount: 1 };
        }
        if (sql.includes("FROM strategy_allocations")) {
          return {
            rows: [{ strategy_key: "leaps", capital_allocation: "5000" }],
            rowCount: 1
          };
        }
        if (sql.includes("AS opra_available")) {
          return { rows: [{ opra_available: true }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    now: new Date("2026-07-20T22:00:00.000Z"),
    captureBrokerSnapshot: async () => ({
      capturedAt: "2026-07-20T22:00:00.000Z",
      accountId: "paper-account-1",
      accountIdentityHash: "paper-account-hash",
      sourceRequestIds: {
        account: "request-account",
        positions: "request-positions",
        openOrders: "request-open-orders",
        recentOrders: "request-recent-orders",
        marketClock: "request-clock"
      },
      account: {
        status: "ACTIVE",
        currency: "USD",
        cash: 10_000,
        equity: 20_000,
        buyingPower: 30_000,
        optionsBuyingPower: 15_000,
        optionsApprovalLevel: 3,
        tradingBlocked: false,
        accountBlocked: false
      },
      configuration: {
        environment: "paper",
        tradingMode: "paper",
        liveTradingEnabled: false
      },
      configurationFingerprint: "configuration-fingerprint",
      positions: [{
        brokerPositionKey: "equity:AAPL",
        symbol: "AAPL",
        underlyingSymbol: null,
        optionSymbol: null,
        assetClass: "equity",
        side: "short",
        quantity: 1,
        availableQuantity: 1,
        averageEntryPrice: 200,
        currentPrice: 198,
        marketValue: -198,
        costBasis: -200,
        unrealizedPnl: 2
      }],
      orders: [],
      recentOrders: [],
      marketClock: {
        observedAt: "2026-07-20T21:59:59.000Z",
        isOpen: true
      },
      structuralPortfolioFingerprint: "structural-fingerprint",
      portfolioFingerprint: "portfolio-fingerprint"
    }) as never
  });

  assert.deepEqual(result.brokerState, {
    accountId: "account_paper-account-hash",
    accountSnapshotId: "snapshot_f2f45d97351ef778512afc5229ed862ec0db5c09611dd892f758b59fca52b663",
    accountSnapshotStored: true,
    positionsObserved: 1,
    positionsUpserted: 1
  });
  assert.equal(
    statements.some(({ sql }) => sql.includes("INSERT INTO account_snapshots")),
    true
  );
  assert.equal(
    statements.some(({ sql }) => sql.includes("UPDATE positions") && sql.includes("status = 'closed'")),
    true
  );
  const positionInsert = statements.find(({ sql }) => sql.includes("INSERT INTO positions"));
  assert.ok(positionInsert);
  assert.equal(positionInsert.values[5], "AAPL");
  assert.equal(positionInsert.values[9], "short");
  const packetUpdate = statements.find(({ sql }) =>
    sql.includes("UPDATE account_snapshots") && sql.includes("portfolioStatePacket")
  );
  assert.ok(packetUpdate, "the reconciled account snapshot must receive the authoritative packet");
  const packet = JSON.parse(String(packetUpdate.values[1])) as Record<string, unknown>;
  assert.equal(packet.schemaVersion, "portfolio-state-v1");
  assert.equal((packet.authority as Record<string, unknown>).paperOnly, true);
  assert.equal((packet.authority as Record<string, unknown>).postgresOnly, true);
  assert.equal((packet.account as Record<string, unknown>).reservedCapital, 100);
  assert.equal((packet.account as Record<string, unknown>).availableValidatedCapital, 9900);
  assert.equal((packet.reconciliation as Record<string, unknown>).status, "matched");
  assert.deepEqual((packet.orders as Record<string, unknown>).open, []);
  const opraLookup = statements.find(({ sql }) => sql.includes("AS opra_available"));
  assert.ok(opraLookup, "reconciliation must verify current OPRA evidence");
  assert.match(opraLookup.sql, /latest_option_research/);
  assert.match(
    opraLookup.sql,
    /option_snapshot\.option_symbol = candidate\.option_symbol/
  );
  assert.match(opraLookup.sql, /LEFT JOIN LATERAL/);
  assert.match(opraLookup.sql, /BOOL_AND/);
  assert.match(opraLookup.sql, /SELECT option_snapshot\.\*/);
  assert.doesNotMatch(
    opraLookup.sql,
    /FROM option_snapshots snapshot\s+WHERE lower/
  );
});

test("broker reconciliation resets stale deployed allocation to current open position exposure", async () => {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  let deployedAmount = 29_999.99;
  let persistedSnapshotId = "";
  let accountSnapshotStored = false;
  let positionPersistenceCount = 0;
  const refreshCounts: number[] = [];
  const reconciliationInput = {
    query: {
      query: async (sql: string, values?: readonly unknown[]) => {
        statements.push({ sql, values: values ?? [] });
        if (sql.includes("INSERT INTO account_snapshots")) {
          if (accountSnapshotStored) {
            return { rows: [], rowCount: 0 };
          }
          accountSnapshotStored = true;
          persistedSnapshotId = String(values?.[0] ?? "");
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("SELECT id FROM account_snapshots")) {
          return { rows: [{ id: persistedSnapshotId }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO positions")) {
          positionPersistenceCount += 1;
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("current_position_exposure")) {
          assert.ok(
            positionPersistenceCount > 0,
            "allocation refresh must follow broker-position persistence"
          );
          assert.deepEqual(values, [
            "account_paper-account-hash",
            "2026-08-05T18:00:00.000Z",
            "reconciliation",
            "reconciliation",
            "worker",
            "run",
            "7"
          ]);
          const currentPositionExposure = 420;
          const refreshed = deployedAmount === currentPositionExposure ? 0 : 1;
          deployedAmount = currentPositionExposure;
          refreshCounts.push(refreshed);
          return {
            rows: [{ refreshed_count: String(refreshed) }],
            rowCount: 1
          };
        }
        if (sql.includes("FROM buying_power_reservations")) {
          return { rows: [{ reserved_capital: "0" }], rowCount: 1 };
        }
        if (sql.includes("FROM strategy_allocations") &&
            sql.includes("capital_allocation")) {
          return {
            rows: [{ strategy_key: "baseline-v1", capital_allocation: "30000" }],
            rowCount: 1
          };
        }
        if (sql.includes("AS opra_available")) {
          return { rows: [{ opra_available: true }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    snapshot: {
      capturedAt: "2026-08-05T18:00:00.000Z",
      accountId: "paper-account-1",
      accountIdentityHash: "paper-account-hash",
      sourceRequestIds: {
        account: "request-account",
        positions: "request-positions",
        openOrders: "request-open-orders",
        recentOrders: "request-recent-orders",
        marketClock: "request-clock"
      },
      account: {
        status: "ACTIVE",
        currency: "USD",
        cash: 98_000,
        equity: 93_000,
        buyingPower: 350_000,
        optionsBuyingPower: 87_000,
        optionsApprovalLevel: 3,
        tradingBlocked: false,
        accountBlocked: false
      },
      configuration: {
        environment: "paper",
        tradingMode: "paper",
        liveTradingEnabled: false
      },
      configurationFingerprint: "configuration-fingerprint",
      positions: [{
        brokerPositionKey: "equity:AAPL",
        symbol: "AAPL",
        underlyingSymbol: null,
        optionSymbol: null,
        assetClass: "equity",
        side: "long",
        quantity: 2,
        availableQuantity: 2,
        averageEntryPrice: 200,
        currentPrice: 210,
        marketValue: 420,
        costBasis: 400,
        unrealizedPnl: 20
      }],
      orders: [],
      recentOrders: [],
      marketClock: {
        observedAt: "2026-08-05T17:59:59.000Z",
        isOpen: true
      },
      structuralPortfolioFingerprint: "structural-fingerprint",
      portfolioFingerprint: "portfolio-fingerprint"
    } as never
  };
  await persistPostgresAuthorityBrokerSnapshot(reconciliationInput);
  await persistPostgresAuthorityBrokerSnapshot(reconciliationInput);

  assert.equal(deployedAmount, 420);
  assert.deepEqual(refreshCounts, [1, 0]);

  const deployedCapitalRefresh = statements.find(({ sql }) =>
    sql.includes("UPDATE strategy_allocations allocation") &&
    sql.includes("current_position_exposure")
  );
  assert.ok(
    deployedCapitalRefresh,
    "reconciliation must replace the cumulative allocation ledger with current broker-backed exposure"
  );
  assert.match(
    deployedCapitalRefresh.sql,
    /position\.status IN \('open', 'closing'\)/
  );
  assert.match(
    deployedCapitalRefresh.sql,
    /ABS\(COALESCE\(position\.market_value, position\.cost_basis, 0\)\)/
  );
  assert.match(
    deployedCapitalRefresh.sql,
    /deployed_amount = current_position_exposure\.amount/
  );
  assert.doesNotMatch(
    deployedCapitalRefresh.sql,
    /position\.status = 'closed'/
  );
});

test("duplicate broker snapshots reuse the existing canonical ID for positions", async () => {
  const existingSnapshotId = "snapshot-existing";
  let referencedSnapshotId = "";
  const result = await reconcilePostgresPaperOrders({
    query: { query: async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes("FROM order_intents intent")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO account_snapshots")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT id FROM account_snapshots")) {
        return { rows: [{ id: existingSnapshotId }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO positions")) {
        referencedSnapshotId = String(values?.[17] ?? "");
        if (referencedSnapshotId !== existingSnapshotId) {
          throw new Error("positions_source_account_snapshot_id_fkey");
        }
      }
      return { rows: [], rowCount: 1 };
    } },
    fence,
    captureBrokerSnapshot: async () => ({
      capturedAt: "2026-07-20T22:01:00.000Z",
      accountIdentityHash: "paper-account-hash",
      account: { status: "ACTIVE", currency: "USD", cash: 10_000, equity: 20_000,
        buyingPower: 30_000, optionsBuyingPower: 15_000, optionsApprovalLevel: 3,
        tradingBlocked: false, accountBlocked: false },
      configuration: { environment: "paper", tradingMode: "paper", liveTradingEnabled: false },
      configurationFingerprint: "configuration-fingerprint",
      positions: [{ brokerPositionKey: "equity:AAPL", symbol: "AAPL",
        underlyingSymbol: null, optionSymbol: null, assetClass: "equity", side: "long",
        quantity: 1, availableQuantity: 1, averageEntryPrice: 200, currentPrice: 201,
        marketValue: 201, costBasis: 200, unrealizedPnl: 1 }],
      orders: [], structuralPortfolioFingerprint: "structural-fingerprint",
      portfolioFingerprint: "portfolio-fingerprint"
    }) as never
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.checked, 0);
  assert.equal(result.brokerState?.accountSnapshotStored, false);
  assert.equal(result.brokerState?.accountSnapshotId, existingSnapshotId);
  assert.equal(referencedSnapshotId, existingSnapshotId);
});

test("genuine broker-state persistence failures remain reconciliation errors", async () => {
  const result = await reconcilePostgresPaperOrders({
    query: { query: async () => ({ rows: [], rowCount: 0 }) },
    fence,
    captureBrokerSnapshot: async () => { throw new Error("BROKER_STATE_PERSISTENCE_FAILED"); }
  });

  assert.deepEqual(result.errors, [{
    orderIntentId: "__broker_state__", code: "BROKER_STATE_PERSISTENCE_FAILED"
  }]);
});

test("position reconciliation carries matching filled entry lineage through a safe upsert", async () => {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const result = await reconcilePostgresPaperOrders({
    query: {
      query: async (sql: string, values?: readonly unknown[]) => {
        statements.push({ sql, values: values ?? [] });
        if (sql.includes("FROM order_intents intent")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("FROM orders") && sql.includes("filled")) {
          return {
            rows: [{
              candidate_id: "candidate-autonomous-1",
              opening_order_id: "order-entry-1",
              opening_filled_at: "2026-07-20T21:59:58.000Z"
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    now: new Date("2026-07-20T22:00:00.000Z"),
    captureBrokerSnapshot: async () => ({
      capturedAt: "2026-07-20T22:00:00.000Z",
      accountIdentityHash: "paper-account-lineage-hash",
      account: {
        status: "ACTIVE",
        currency: "USD",
        cash: 10_000,
        equity: 20_000,
        buyingPower: 30_000,
        optionsBuyingPower: 15_000,
        optionsApprovalLevel: 3,
        tradingBlocked: false,
        accountBlocked: false
      },
      configuration: {
        environment: "paper",
        tradingMode: "paper",
        liveTradingEnabled: false
      },
      configurationFingerprint: "configuration-fingerprint",
      positions: [{
        brokerPositionKey: "equity:SPY",
        symbol: "SPY",
        underlyingSymbol: null,
        optionSymbol: null,
        assetClass: "equity",
        side: "long",
        quantity: 1,
        availableQuantity: 1,
        averageEntryPrice: 500,
        currentPrice: 501,
        marketValue: 501,
        costBasis: 500,
        unrealizedPnl: 1
      }],
      orders: [],
      structuralPortfolioFingerprint: "structural-fingerprint",
      portfolioFingerprint: "portfolio-fingerprint"
    }) as never
  });

  assert.equal(result.brokerState?.positionsUpserted, 1);
  const lineageLookup = statements.find(({ sql }) =>
    sql.includes("FROM orders broker_order") &&
    sql.includes("JOIN order_intents intent")
  );
  assert.ok(lineageLookup, "reconciliation must derive lineage from matching filled entry");
  assert.match(
    lineageLookup.sql,
    /broker_order\.status IN \('filled', 'partially_filled'\)/
  );
  assert.match(lineageLookup.sql, /intent\.id AS opening_intent_id/);
  assert.match(lineageLookup.sql, /intent\.strategy_classification/);
  assert.match(lineageLookup.sql, /intent\.contract_id/);
  assert.match(
    lineageLookup.sql,
    /ABS\(\s*broker_order\.filled_quantity - \$6::numeric\s*\) <= 0\.000000000001/
  );
  assert.match(
    lineageLookup.sql,
    /ABS\(\s*broker_order\.filled_average_price - \$7::numeric\s*\) <= 0\.00000001/
  );
  assert.equal(lineageLookup.values[5], 1);
  assert.equal(lineageLookup.values[6], 500);
  const positionInsert = statements.find(({ sql }) => sql.includes("INSERT INTO positions"));
  assert.ok(positionInsert);
  assert.equal(positionInsert.values[3], "candidate-autonomous-1");
  assert.equal(positionInsert.values[4], "order-entry-1");
  assert.equal(positionInsert.values[18], "2026-07-20T21:59:58.000Z");
  assert.equal(positionInsert.values[19], "2026-07-20T22:00:00.000Z");
  assert.match(positionInsert.sql, /ON CONFLICT \(account_id, broker_position_key\)/);
  assert.match(
    positionInsert.sql,
    /opened_at,\s*last_reconciled_at, created_at, updated_at[\s\S]*\$19,\s*\$20,\s*\$20,\s*\$20/
  );
  assert.match(
    positionInsert.sql,
    /candidate_id = CASE[\s\S]*positions\.status = 'closed'[\s\S]*EXCLUDED\.candidate_id[\s\S]*COALESCE\(positions\.candidate_id, EXCLUDED\.candidate_id\)/
  );
  assert.match(
    positionInsert.sql,
    /opening_order_id = CASE[\s\S]*positions\.status = 'closed'[\s\S]*EXCLUDED\.opening_order_id[\s\S]*COALESCE\(positions\.opening_order_id, EXCLUDED\.opening_order_id\)/
  );
  assert.match(
    positionInsert.sql,
    /opened_at = CASE[\s\S]*positions\.status = 'closed'[\s\S]*EXCLUDED\.opened_at[\s\S]*positions\.opened_at/
  );
});

test("position reconciliation links a filled autonomous close and closes its lifecycle exactly once", async () => {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const result = await reconcilePostgresPaperOrders({
    query: {
      query: async (sql: string, values?: readonly unknown[]) => {
        statements.push({ sql, values: values ?? [] });
        if (sql.includes("FROM order_intents intent") && sql.includes("intent.status IN")) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    now: new Date("2026-07-20T22:00:00.000Z"),
    captureBrokerSnapshot: async () => ({
      capturedAt: "2026-07-20T22:00:00.000Z",
      accountIdentityHash: "paper-account-close-hash",
      account: {
        status: "ACTIVE",
        currency: "USD",
        cash: 10_000,
        equity: 20_000,
        buyingPower: 30_000,
        optionsBuyingPower: 15_000,
        optionsApprovalLevel: 3,
        tradingBlocked: false,
        accountBlocked: false
      },
      configuration: {
        environment: "paper",
        tradingMode: "paper",
        liveTradingEnabled: false
      },
      configurationFingerprint: "configuration-fingerprint",
      positions: [],
      orders: [],
      structuralPortfolioFingerprint: "structural-fingerprint",
      portfolioFingerprint: "portfolio-fingerprint"
    }) as never
  });

  assert.equal(result.brokerState?.positionsObserved, 0);
  const closeStatement = statements.find(({ sql }) =>
    sql.includes("UPDATE positions") && sql.includes("status = 'closed'")
  );
  assert.ok(closeStatement);
  assert.match(closeStatement.sql, /close_intent\.parent_position_id = positions\.id/);
  assert.match(closeStatement.sql, /closing_order_id = COALESCE/);
  const lifecycleClose = statements.find(({ sql }) =>
    sql.includes("UPDATE order_intents") &&
    sql.includes("lifecycle_state = 'closed'")
  );
  assert.ok(lifecycleClose);
  assert.match(lifecycleClose.sql, /parent_position\.status = 'closed'/);
});

test("the execution transaction can persist its exact captured broker snapshot", async () => {
  const statements: string[] = [];
  const result = await persistPostgresAuthorityBrokerSnapshot({
    query: {
      query: async (sql: string) => {
        statements.push(sql);
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    snapshot: {
      capturedAt: "2026-07-20T22:00:00.000Z",
      accountIdentityHash: "paper-account-hash",
      account: {
        status: "ACTIVE",
        currency: "USD",
        cash: 10_000,
        equity: 20_000,
        buyingPower: 30_000,
        optionsBuyingPower: 15_000,
        optionsApprovalLevel: 3,
        tradingBlocked: false,
        accountBlocked: false
      },
      configuration: {
        environment: "paper",
        tradingMode: "paper",
        liveTradingEnabled: false
      },
      configurationFingerprint: "configuration-fingerprint",
      positions: [],
      orders: [],
      structuralPortfolioFingerprint: "structural-fingerprint",
      portfolioFingerprint: "portfolio-fingerprint"
    } as never
  });

  assert.equal(result.accountId, "account_paper-account-hash");
  assert.equal(typeof result.accountSnapshotId, "string");
  assert.equal(
    statements.some((sql) => sql.includes("INSERT INTO account_snapshots")),
    true
  );
});
