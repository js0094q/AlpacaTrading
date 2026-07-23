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
    syncBrokerState: false,
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
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO orders")), true);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO broker_events")), true);
  assert.equal(sql.some((statement) => statement.includes("UPDATE order_intents")), true);
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
              notional: null, limit_price: "1", intent_status: "submitted"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("released_reservation_count")) {
          return {
            rows: [{ released_reservation_count: "1", adjusted_allocation_count: "1" }],
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
  assert.equal(release.values[1], "canceled");
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
              notional: null, limit_price: null, intent_status: "submitted"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("released_reservation_count")) {
          return {
            rows: [{ released_reservation_count: "1", adjusted_allocation_count: "1" }],
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
  assert.match(release, /CASE WHEN \$2 = 'filled' THEN released\.amount/);
  assert.match(release, /reservation\.status IN \('active', 'committed'\)/);
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
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    now: new Date("2026-07-20T22:00:00.000Z"),
    captureBrokerSnapshot: async () => ({
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
      structuralPortfolioFingerprint: "structural-fingerprint",
      portfolioFingerprint: "portfolio-fingerprint"
    }) as never
  });

  assert.deepEqual(result.brokerState, {
    accountId: "account_paper-account-hash",
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
  assert.equal(positionInsert.values[3], "AAPL");
  assert.equal(positionInsert.values[7], "short");
});
