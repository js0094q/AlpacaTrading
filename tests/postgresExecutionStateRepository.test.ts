import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient, QueryResult } from "pg";

import { PostgresExecutionStateRepository } from "../src/repositories/postgres/postgresExecutionStateRepository.js";
import type { ExecutionEvidenceInput } from "../src/repositories/contracts/executionStateRepository.js";

const fence = {
  jobName: "paper-execution",
  workstream: "paper_execution",
  ownerId: "worker-1",
  runId: "scheduler-run-1",
  fencingToken: "41"
};

const contextFor = (client: PoolClient) => ({
  transaction: client,
  operationId: "execution-operation-1",
  actorId: fence.ownerId,
  schedulerFence: fence
});

const currentFence = {
  fencing_token: fence.fencingToken,
  workstream: fence.workstream,
  owner_id: fence.ownerId,
  run_id: fence.runId,
  current: true
};

test("finds the active strategy key for execution reservation routing", async () => {
  let queryText = "";
  const client = {
    query: async (text: string) => {
      queryText = text;
      return {
        rows: [{
          account_id: "account-1",
          account_snapshot_id: "snapshot-1",
          strategy_key: "reviewed-paper"
        }]
      } as unknown as QueryResult;
    }
  } as unknown as PoolClient;

  const result = await new PostgresExecutionStateRepository().findCurrentAccount({
    transaction: client
  });

  assert.deepEqual(result, {
    accountId: "account-1",
    accountSnapshotId: "snapshot-1",
    strategyKey: "reviewed-paper"
  });
  assert.match(queryText, /allocation\.strategy_key AS strategy_key/);
});

test("reuses an equivalent existing account snapshot for exposure foreign keys", async () => {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    query: async (text: string, values: unknown[] = []) => {
      queries.push({ text, values });
      if (text.includes("FROM scheduler_leases") && text.includes("FOR UPDATE")) {
        return { rows: [currentFence] } as unknown as QueryResult;
      }
      if (text.includes("INSERT INTO account_snapshots")) {
        return { rows: [] } as unknown as QueryResult;
      }
      if (text.includes("FROM account_snapshots")) {
        return { rows: [{ id: "legacy-snapshot-1" }] } as unknown as QueryResult;
      }
      if (text.includes("INSERT INTO portfolio_exposure")) {
        assert.equal(values[2], "legacy-snapshot-1");
        return { rows: [] } as unknown as QueryResult;
      }
      return { rows: [] } as unknown as QueryResult;
    }
  } as unknown as PoolClient;

  const result = await new PostgresExecutionStateRepository().syncAccountState(
    {
      accountId: "account-1",
      brokerAccountId: "broker-account-1",
      accountSnapshotId: "new-snapshot-1",
      observedAt: "2026-07-17T16:00:00.000Z",
      accountStatus: "ACTIVE",
      currency: "USD",
      cash: "100000.00",
      portfolioValue: "100000.00",
      equity: "100000.00",
      buyingPower: "100000.00",
      optionsBuyingPower: "100000.00",
      optionsApprovedLevel: 3,
      tradingBlocked: false,
      accountBlocked: false,
      snapshotFingerprint: "snapshot-fingerprint-1",
      evidence: {},
      positions: [],
      riskLimit: {
        id: "risk-limit-1",
        cashReserveAmount: "20000.00",
        cashReserveRatio: "0.20",
        maxDeploymentAmount: "30000.00",
        maxDeploymentRatio: "0.50",
        maxGrossExposure: "30000.00",
        maxNetExposure: "30000.00",
        maxOpenOrderExposure: "30000.00",
        maxPositionNotional: "5000.00",
        maxSymbolNotional: "5000.00",
        maxPositionCount: 3,
        maxOrderCount: 10,
        configVersion: "v1",
        configFingerprint: "risk-fingerprint-1"
      },
      strategyAllocation: {
        id: "allocation-1",
        strategyKey: "reviewed-paper",
        allocationAmount: "30000.00",
        allocationRatio: "1.00",
        configVersion: "v1",
        configFingerprint: "allocation-fingerprint-1"
      },
      exposure: {
        id: "exposure-1",
        grossExposure: "0.00",
        netExposure: "0.00",
        longExposure: "0.00",
        shortExposure: "0.00",
        openOrderExposure: "0.00",
        activeReservationAmount: "0.00",
        deployedAmount: "0.00",
        cashReserveAmount: "20000.00",
        availableBuyingPower: "100000.00",
        positionCount: 0,
        openOrderCount: 0,
        fingerprint: "exposure-fingerprint-1",
        evidence: {}
      }
    },
    contextFor(client)
  );

  assert.deepEqual(result, {
    status: "synced",
    accountId: "account-1",
    snapshotId: "legacy-snapshot-1"
  });
  assert.equal(queries.some(({ text }) => text.includes("INSERT INTO portfolio_exposure")), true);
});

const reservationInput = {
  reservationId: "reservation-1",
  reservationRequired: true,
  orderIntentId: "intent-1",
  accountId: "account-1",
  accountSnapshotId: "snapshot-1",
  candidateId: null,
  strategyKey: "reviewed-paper",
  symbol: "SPY",
  assetClass: "equity" as const,
  amount: "250.00000000",
  idempotencyKey: "client-order-1",
  reservationFingerprint: "reservation-fingerprint-1",
  expiresAt: "2026-07-16T16:05:00.000Z",
  clientOrderId: "client-order-1",
  side: "buy" as const,
  orderType: "limit" as const,
  timeInForce: "day" as const,
  quantity: "1",
  notional: null,
  limitPrice: "250.00000000",
  stopPrice: null,
  estimatedPremium: "250.00000000",
  maxRisk: "250.00000000",
  intentFingerprint: "intent-fingerprint-1",
  lifecycleFingerprint: "lifecycle-fingerprint-1",
  executionReviewId: "review-1",
  confirmationEvidenceId: "confirmation-1",
  requestPayload: { symbol: "SPY", qty: "1" },
  requestId: "request-1",
  correlationId: "correlation-1",
  createdAt: "2026-07-16T16:00:00.000Z"
};

const brokerResultInput = {
  eventId: "broker-event-1",
  orderId: "order-1",
  orderIntentId: "intent-1",
  brokerOrderId: "broker-order-1",
  clientOrderId: "client-order-1",
  symbol: "SPY",
  assetClass: "equity" as const,
  side: "buy" as const,
  orderType: "limit" as const,
  timeInForce: "day" as const,
  status: "accepted",
  quantity: "1",
  notional: null,
  limitPrice: "250.00000000",
  stopPrice: null,
  filledQuantity: "0",
  filledAveragePrice: null,
  requestId: "request-1",
  httpStatus: 200,
  errorClassification: null,
  retryable: null,
  responsePayload: { status: "accepted" },
  responseFingerprint: "response-fingerprint-1",
  occurredAt: "2026-07-16T16:00:01.000Z",
  receivedAt: "2026-07-16T16:00:01.000Z"
};

test("0DTE activity state is read under the current scheduler fence", async () => {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes("FROM scheduler_leases") && text.includes("FOR UPDATE")) {
        return { rows: [currentFence] } as unknown as QueryResult;
      }
      if (text.includes("FROM orders order_state")) {
        return { rows: [{
          id: "order-1",
          created_at: "2026-07-16T15:00:00.000Z",
          asset_class: "option",
          symbol: "SPY260716C00600000",
          side: "buy_to_open",
          status: "filled",
          quantity: "1.000000000000",
          limit_price: "1.25000000",
          estimated_premium: "125.00000000",
          client_order_id: "client-order-1",
          broker_order_id: "broker-order-1",
          filled_quantity: "1.000000000000",
          filled_average_price: "1.20000000"
        }] } as unknown as QueryResult;
      }
      if (text.includes("FROM positions position_state")) {
        return { rows: [] } as unknown as QueryResult;
      }
      throw new Error(`UNEXPECTED_QUERY:${text}`);
    }
  } as unknown as PoolClient;

  const result = await new PostgresExecutionStateRepository()
    .listZeroDteActivityState({ tradingDate: "2026-07-16" }, contextFor(client));

  assert.equal(result.status, "listed");
  if (result.status === "listed") {
    assert.equal(result.ledger[0]?.id, "order-1");
    assert.deepEqual(result.ledger[0]?.rawResponse, {
      status: "filled",
      filled_qty: "1.000000000000",
      filled_avg_price: "1.20000000"
    });
  }
  assert.equal(queries.length, 3);
});

test("broker reconciliation targets require the current scheduler fence", async () => {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes("FROM scheduler_leases") && text.includes("FOR UPDATE")) {
        return { rows: [currentFence] } as unknown as QueryResult;
      }
      if (text.includes("FROM order_intents intent")) {
        return {
          rows: [{
            order_intent_id: "intent-1",
            order_id: "order-1",
            account_id: "account-1",
            client_order_id: "client-order-1",
            symbol: "SPY",
            underlying_symbol: null,
            asset_class: "equity",
            side: "buy",
            order_type: "limit",
            time_in_force: "day",
            quantity: "1.000000000000",
            notional: null,
            limit_price: "250.00000000",
            stop_price: null,
            intent_status: "ambiguous",
            created_at: "2026-07-16T16:00:00.000Z"
          }]
        } as unknown as QueryResult;
      }
      throw new Error(`UNEXPECTED_QUERY:${text}`);
    }
  } as unknown as PoolClient;

  const result = await new PostgresExecutionStateRepository()
    .listBrokerReconciliationTargets(contextFor(client));

  assert.equal(result.status, "listed");
  if (result.status === "listed") {
    assert.equal(result.targets[0]?.clientOrderId, "client-order-1");
    assert.equal(result.targets[0]?.createdAt, "2026-07-16T16:00:00.000Z");
  }
  assert.match(queries[1] ?? "", /ready_for_submission.*submission_pending.*ambiguous/s);
});

test("broker replace and cancel authorization requires the current active order and fence", async () => {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes("FROM scheduler_leases") && text.includes("FOR UPDATE")) {
        return { rows: [currentFence] } as unknown as QueryResult;
      }
      if (text.includes("FROM order_intents") && text.includes("client_order_id")) {
        return { rows: [{ status: "submitted" }] } as unknown as QueryResult;
      }
      if (text.includes("FROM orders") && text.includes("replacement_order_id IS NULL")) {
        return {
          rows: [{ broker_order_id: "broker-order-1", status: "accepted" }]
        } as unknown as QueryResult;
      }
      throw new Error(`UNEXPECTED_QUERY:${text}`);
    }
  } as unknown as PoolClient;

  const result = await new PostgresExecutionStateRepository().authorizeBrokerMutation(
    {
      accountId: "account-1",
      orderIntentId: "intent-1",
      clientOrderId: "client-order-1",
      brokerOrderId: "broker-order-1",
      mutation: "replace"
    },
    contextFor(client)
  );

  assert.deepEqual(result, { status: "authorized" });
  assert.equal(queries.some((query) => query.includes("FROM order_intents")), true);
  assert.equal(queries.some((query) => query.includes("FROM orders")), true);
});

test("a stale fence rejects broker mutation authorization before order access", async () => {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes("FROM scheduler_leases") && text.includes("FOR UPDATE")) {
        return {
          rows: [{ ...currentFence, fencing_token: "42", current: true }]
        } as unknown as QueryResult;
      }
      throw new Error(`UNEXPECTED_QUERY:${text}`);
    }
  } as unknown as PoolClient;

  const result = await new PostgresExecutionStateRepository().authorizeBrokerMutation(
    {
      accountId: "account-1",
      orderIntentId: "intent-1",
      clientOrderId: "client-order-1",
      brokerOrderId: "broker-order-1",
      mutation: "cancel"
    },
    contextFor(client)
  );

  assert.deepEqual(result, { status: "fence_rejected", currentFencingToken: "42" });
  assert.equal(queries.some((query) => query.includes("FROM order_intents")), false);
  assert.equal(queries.some((query) => query.includes("FROM orders")), false);
});

test("atomic reservation locks the account and evaluates exact numeric limits before inserting", async () => {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes("FROM scheduler_leases") && text.includes("FOR UPDATE")) {
        return { rows: [currentFence] } as unknown as QueryResult;
      }
      if (text.includes("FROM accounts") && text.includes("FOR UPDATE")) {
        return { rows: [{ id: "account-1" }] } as unknown as QueryResult;
      }
      if (text.includes("FROM order_intents") && text.includes("idempotency_key")) {
        return { rows: [] } as unknown as QueryResult;
      }
      if (text.includes("FROM execution_reviews review")) {
        return {
          rows: [{
            review_status: "valid",
            confirmation_status: "valid",
            review_expires_at: "2026-07-16T17:00:00.000Z",
            confirmation_expires_at: "2026-07-16T17:00:00.000Z"
          }]
        } as unknown as QueryResult;
      }
      if (text.includes("AS buying_power_allowed")) {
        return {
          rows: [{
            buying_power_allowed: true,
            deployment_allowed: true,
            strategy_allowed: true,
            symbol_allowed: true,
            position_count_allowed: true,
            order_count_allowed: true
          }]
        } as unknown as QueryResult;
      }
      if (text.startsWith("INSERT INTO buying_power_reservations")) {
        return { rows: [{ id: "reservation-1" }], rowCount: 1 } as unknown as QueryResult;
      }
      if (text.startsWith("UPDATE strategy_allocations")) {
        return { rows: [], rowCount: 1 } as unknown as QueryResult;
      }
      if (
        text.startsWith("UPDATE execution_reviews") ||
        text.startsWith("UPDATE confirmation_evidence")
      ) {
        return { rows: [], rowCount: 1 } as unknown as QueryResult;
      }
      if (text.startsWith("INSERT INTO order_intents")) {
        return { rows: [{ id: "intent-1" }], rowCount: 1 } as unknown as QueryResult;
      }
      if (text.startsWith("INSERT INTO lifecycle_fingerprints")) {
        return { rows: [], rowCount: 1 } as unknown as QueryResult;
      }
      throw new Error(`UNEXPECTED_QUERY:${text}`);
    }
  } as unknown as PoolClient;

  const result = await new PostgresExecutionStateRepository().reserveAndCreateOrderIntent(
    reservationInput,
    contextFor(client)
  );

  assert.deepEqual(result, {
    status: "authorized",
    reservationId: "reservation-1",
    orderIntentId: "intent-1"
  });
  assert.ok(queries.some((query) => query.includes("FROM accounts") && query.includes("FOR UPDATE")));
  assert.ok(queries.some((query) => query.includes("AS buying_power_allowed")));
  assert.ok(queries.some((query) => query.startsWith("INSERT INTO order_intents")));
});

test("atomic reservation returns blockers and writes nothing when a PostgreSQL limit fails", async () => {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes("FROM scheduler_leases") && text.includes("FOR UPDATE")) {
        return { rows: [currentFence] } as unknown as QueryResult;
      }
      if (text.includes("FROM accounts") && text.includes("FOR UPDATE")) {
        return { rows: [{ id: "account-1" }] } as unknown as QueryResult;
      }
      if (text.includes("FROM order_intents") && text.includes("idempotency_key")) {
        return { rows: [] } as unknown as QueryResult;
      }
      if (text.includes("FROM execution_reviews review")) {
        return {
          rows: [{
            review_status: "valid",
            confirmation_status: "valid",
            review_expires_at: "2026-07-16T17:00:00.000Z",
            confirmation_expires_at: "2026-07-16T17:00:00.000Z"
          }]
        } as unknown as QueryResult;
      }
      if (text.includes("AS buying_power_allowed")) {
        return {
          rows: [{
            buying_power_allowed: false,
            deployment_allowed: true,
            strategy_allowed: true,
            symbol_allowed: true,
            position_count_allowed: true,
            order_count_allowed: true
          }]
        } as unknown as QueryResult;
      }
      throw new Error(`UNEXPECTED_QUERY:${text}`);
    }
  } as unknown as PoolClient;

  const result = await new PostgresExecutionStateRepository().reserveAndCreateOrderIntent(
    reservationInput,
    contextFor(client)
  );

  assert.deepEqual(result, {
    status: "blocked",
    blockers: ["BUYING_POWER_LIMIT_EXCEEDED"]
  });
  assert.equal(queries.some((query) => query.startsWith("INSERT INTO buying_power_reservations")), false);
});

test("sell-to-close creates an intent without a buying-power reservation", async () => {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes("FROM scheduler_leases") && text.includes("FOR UPDATE")) {
        return { rows: [currentFence] } as unknown as QueryResult;
      }
      if (text.includes("FROM accounts") && text.includes("FOR UPDATE")) {
        return { rows: [{ id: "account-1" }] } as unknown as QueryResult;
      }
      if (text.includes("FROM order_intents") && text.includes("idempotency_key")) {
        return { rows: [] } as unknown as QueryResult;
      }
      if (text.includes("FROM execution_reviews review")) {
        return {
          rows: [{
            review_status: "valid",
            confirmation_status: "valid",
            review_expires_at: "2026-07-16T17:00:00.000Z",
            confirmation_expires_at: "2026-07-16T17:00:00.000Z"
          }]
        } as unknown as QueryResult;
      }
      if (
        text.startsWith("UPDATE execution_reviews") ||
        text.startsWith("UPDATE confirmation_evidence")
      ) {
        return { rows: [], rowCount: 1 } as unknown as QueryResult;
      }
      if (text.startsWith("INSERT INTO order_intents")) {
        return { rows: [{ id: "intent-1" }], rowCount: 1 } as unknown as QueryResult;
      }
      if (text.startsWith("INSERT INTO lifecycle_fingerprints")) {
        return { rows: [], rowCount: 1 } as unknown as QueryResult;
      }
      throw new Error(`UNEXPECTED_QUERY:${text}`);
    }
  } as unknown as PoolClient;

  const result = await new PostgresExecutionStateRepository().reserveAndCreateOrderIntent(
    {
      ...reservationInput,
      reservationId: null,
      reservationRequired: false,
      side: "sell_to_close"
    },
    contextFor(client)
  );

  assert.deepEqual(result, {
    status: "authorized",
    reservationId: null,
    orderIntentId: "intent-1"
  });
  assert.equal(queries.some((query) => query.includes("AS buying_power_allowed")), false);
  assert.equal(queries.some((query) => query.startsWith("INSERT INTO buying_power_reservations")), false);
});

test("a stale fence cannot create a reservation or order intent", async () => {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes("FROM scheduler_leases") && text.includes("FOR UPDATE")) {
        return {
          rows: [{ ...currentFence, fencing_token: "42", current: true }]
        } as unknown as QueryResult;
      }
      throw new Error(`UNEXPECTED_QUERY:${text}`);
    }
  } as unknown as PoolClient;

  const result = await new PostgresExecutionStateRepository().reserveAndCreateOrderIntent(
    reservationInput,
    contextFor(client)
  );

  assert.deepEqual(result, { status: "fence_rejected", currentFencingToken: "42" });
  assert.equal(queries.some((query) => query.startsWith("INSERT INTO")), false);
});

test("an execution intent without reviewed confirmation evidence fails closed", async () => {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes("FROM scheduler_leases") && text.includes("FOR UPDATE")) {
        return { rows: [currentFence] } as unknown as QueryResult;
      }
      if (text.includes("FROM accounts") && text.includes("FOR UPDATE")) {
        return { rows: [{ id: "account-1" }] } as unknown as QueryResult;
      }
      if (text.includes("FROM order_intents") && text.includes("idempotency_key")) {
        return { rows: [] } as unknown as QueryResult;
      }
      throw new Error(`UNEXPECTED_QUERY:${text}`);
    }
  } as unknown as PoolClient;

  const result = await new PostgresExecutionStateRepository().reserveAndCreateOrderIntent(
    {
      ...reservationInput,
      executionReviewId: null,
      confirmationEvidenceId: null
    },
    contextFor(client)
  );

  assert.deepEqual(result, {
    status: "blocked",
    blockers: ["EXECUTION_CONFIRMATION_EVIDENCE_REQUIRED"]
  });
  assert.equal(queries.some((query) => query.startsWith("INSERT INTO")), false);
});

test("broker-result replay is idempotent and cannot duplicate its event effect", async () => {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes("FROM scheduler_leases") && text.includes("FOR UPDATE")) {
        return { rows: [currentFence] } as unknown as QueryResult;
      }
      if (text.includes("FROM order_intents") && text.includes("FOR UPDATE")) {
        return {
          rows: [{ id: "intent-1", account_id: "account-1", reservation_id: "reservation-1" }]
        } as unknown as QueryResult;
      }
      if (text.includes("FROM broker_events WHERE event_id")) {
        return {
          rows: [{
            response_fingerprint: "response-fingerprint-1",
            order_id: "order-1",
            order_intent_id: "intent-1"
          }]
        } as unknown as QueryResult;
      }
      if (text.startsWith("INSERT INTO lifecycle_fingerprints")) {
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      }
      throw new Error(`UNEXPECTED_QUERY:${text}`);
    }
  } as unknown as PoolClient;

  const result = await new PostgresExecutionStateRepository().recordBrokerResult(
    brokerResultInput,
    contextFor(client)
  );

  assert.deepEqual(result, { status: "duplicate", orderId: "order-1" });
  assert.equal(queries.some((query) => query.startsWith("INSERT INTO orders")), false);
  assert.equal(queries.some((query) => query.startsWith("INSERT INTO broker_events")), false);
  assert.equal(
    queries.some((query) => query.startsWith("INSERT INTO lifecycle_fingerprints")),
    true
  );
});

test("broker results fail closed when the persisted intent identity differs", async () => {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes("FROM scheduler_leases") && text.includes("FOR UPDATE")) {
        return { rows: [currentFence] } as unknown as QueryResult;
      }
      if (text.includes("FROM order_intents") && text.includes("FOR UPDATE")) {
        return {
          rows: [{
            id: "intent-1",
            account_id: "account-1",
            reservation_id: "reservation-1",
            candidate_id: null,
            client_order_id: "different-client-order",
            symbol: "SPY",
            asset_class: "equity",
            side: "buy",
            order_type: "limit",
            time_in_force: "day",
            quantity: "1.000000000000",
            notional: null,
            limit_price: "250.00000000",
            stop_price: null,
            status: "ready_for_submission",
            identity_matches: false
          }]
        } as unknown as QueryResult;
      }
      throw new Error(`UNEXPECTED_QUERY:${text}`);
    }
  } as unknown as PoolClient;

  await assert.rejects(
    new PostgresExecutionStateRepository().recordBrokerResult(
      brokerResultInput,
      contextFor(client)
    ),
    /POSTGRES_BROKER_RESULT_INTENT_MISMATCH/
  );
  assert.equal(queries.some((query) => query.startsWith("INSERT INTO")), false);
});

test("a stale broker response cannot regress a terminal PostgreSQL order", async () => {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes("FROM scheduler_leases") && text.includes("FOR UPDATE")) {
        return { rows: [currentFence] } as unknown as QueryResult;
      }
      if (text.includes("FROM order_intents") && text.includes("FOR UPDATE")) {
        return {
          rows: [{
            id: "intent-1",
            account_id: "account-1",
            reservation_id: "reservation-1",
            candidate_id: null,
            client_order_id: "client-order-1",
            symbol: "SPY",
            asset_class: "equity",
            side: "buy",
            order_type: "limit",
            time_in_force: "day",
            quantity: "1.000000000000",
            notional: null,
            limit_price: "250.00000000",
            stop_price: null,
            status: "reconciled",
            identity_matches: true
          }]
        } as unknown as QueryResult;
      }
      if (text.includes("FROM broker_events WHERE event_id")) {
        return { rows: [] } as unknown as QueryResult;
      }
      if (text.includes("FROM orders") && text.includes("FOR UPDATE")) {
        return {
          rows: [{
            id: "order-1",
            broker_order_id: "broker-order-1",
            client_order_id: "client-order-1",
            status: "filled",
            filled_quantity: "1.000000000000"
          }]
        } as unknown as QueryResult;
      }
      throw new Error(`UNEXPECTED_QUERY:${text}`);
    }
  } as unknown as PoolClient;

  await assert.rejects(
    new PostgresExecutionStateRepository().recordBrokerResult(
      brokerResultInput,
      contextFor(client)
    ),
    /POSTGRES_BROKER_RESULT_STATUS_REGRESSION/
  );
  assert.equal(queries.some((query) => query.startsWith("INSERT INTO")), false);
});

test("a broker replacement advances the existing intent to a linked current order", async () => {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes("FROM scheduler_leases") && text.includes("FOR UPDATE")) {
        return { rows: [currentFence] } as unknown as QueryResult;
      }
      if (text.includes("FROM order_intents") && text.includes("FOR UPDATE")) {
        return {
          rows: [{
            id: "intent-1",
            account_id: "account-1",
            reservation_id: null,
            candidate_id: null,
            status: "submitted",
            identity_matches: true
          }]
        } as unknown as QueryResult;
      }
      if (text.includes("FROM broker_events WHERE event_id")) {
        return { rows: [] } as unknown as QueryResult;
      }
      if (text.includes("FROM orders") && text.includes("FOR UPDATE")) {
        return {
          rows: [{
            id: "order-1",
            broker_order_id: "broker-order-1",
            client_order_id: "client-order-1",
            status: "accepted",
            filled_quantity: "0"
          }]
        } as unknown as QueryResult;
      }
      if (text.startsWith("UPDATE orders") && text.includes("replacement_order_id")) {
        return { rows: [], rowCount: 1 } as unknown as QueryResult;
      }
      if (text.startsWith("INSERT INTO orders")) {
        return { rows: [{ id: "order-2" }], rowCount: 1 } as unknown as QueryResult;
      }
      if (text.startsWith("INSERT INTO broker_events")) {
        return { rows: [{ event_id: "broker-event-2" }], rowCount: 1 } as unknown as QueryResult;
      }
      if (text.startsWith("UPDATE order_intents")) {
        return { rows: [], rowCount: 1 } as unknown as QueryResult;
      }
      if (text.startsWith("INSERT INTO lifecycle_fingerprints")) {
        return { rows: [], rowCount: 1 } as unknown as QueryResult;
      }
      throw new Error(`UNEXPECTED_QUERY:${text}`);
    }
  } as unknown as PoolClient;

  const result = await new PostgresExecutionStateRepository().recordBrokerResult(
    {
      ...brokerResultInput,
      eventId: "broker-event-2",
      orderId: "order-2",
      brokerOrderId: "broker-order-2",
      brokerClientOrderId: "client-order-2",
      replacesBrokerOrderId: "broker-order-1",
      brokerLimitPrice: "249.50000000",
      responseFingerprint: "response-fingerprint-2",
      responsePayload: {
        status: "accepted",
        replacesBrokerOrderId: "broker-order-1"
      }
    },
    contextFor(client)
  );

  assert.deepEqual(result, { status: "recorded", orderId: "order-2" });
  assert.equal(
    queries.some((query) =>
      query.startsWith("UPDATE orders") && query.includes("replacement_order_id")
    ),
    true
  );
  const insert = queries.find((query) => query.startsWith("INSERT INTO orders")) ?? "";
  assert.match(insert, /parent_order_id/);
});

test("an ambiguous broker result keeps its reservation active for reconciliation", async () => {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes("FROM scheduler_leases") && text.includes("FOR UPDATE")) {
        return { rows: [currentFence] } as unknown as QueryResult;
      }
      if (text.includes("FROM order_intents") && text.includes("FOR UPDATE")) {
        return {
          rows: [{
            id: "intent-1",
            account_id: "account-1",
            reservation_id: "reservation-1",
            candidate_id: null
          }]
        } as unknown as QueryResult;
      }
      if (text.includes("FROM broker_events WHERE event_id")) {
        return { rows: [] } as unknown as QueryResult;
      }
      if (text.includes("FROM orders") && text.includes("FOR UPDATE")) {
        return { rows: [] } as unknown as QueryResult;
      }
      if (text.startsWith("INSERT INTO orders")) {
        return { rows: [{ id: "order-1" }], rowCount: 1 } as unknown as QueryResult;
      }
      if (text.startsWith("INSERT INTO broker_events")) {
        return { rows: [{ event_id: "broker-event-ambiguous" }], rowCount: 1 } as unknown as QueryResult;
      }
      if (text.startsWith("UPDATE order_intents")) {
        return { rows: [], rowCount: 1 } as unknown as QueryResult;
      }
      if (text.startsWith("INSERT INTO lifecycle_fingerprints")) {
        return { rows: [], rowCount: 1 } as unknown as QueryResult;
      }
      throw new Error(`UNEXPECTED_QUERY:${text}`);
    }
  } as unknown as PoolClient;

  const result = await new PostgresExecutionStateRepository().recordBrokerResult(
    {
      eventId: "broker-event-ambiguous",
      orderId: "order-1",
      orderIntentId: "intent-1",
      brokerOrderId: null,
      clientOrderId: "client-order-1",
      symbol: "SPY",
      assetClass: "equity",
      side: "buy",
      orderType: "market",
      timeInForce: "day",
      status: "ambiguous",
      quantity: "1",
      notional: "250.00000000",
      limitPrice: null,
      stopPrice: null,
      filledQuantity: "0",
      filledAveragePrice: null,
      requestId: "request-ambiguous",
      httpStatus: null,
      errorClassification: "ambiguous_broker_result",
      retryable: false,
      responsePayload: { status: "ambiguous" },
      responseFingerprint: "response-fingerprint-ambiguous",
      occurredAt: "2026-07-16T16:00:01.000Z",
      receivedAt: "2026-07-16T16:00:01.000Z"
    },
    contextFor(client)
  );

  assert.deepEqual(result, { status: "recorded", orderId: "order-1" });
  assert.equal(
    queries.some((query) => query.startsWith("UPDATE buying_power_reservations")),
    false
  );
  assert.equal(
    queries.some((query) => query.startsWith("UPDATE strategy_allocations")),
    false
  );
});

test("consumed execution evidence remains an exact idempotent replay", async () => {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes("FROM scheduler_leases") && text.includes("FOR UPDATE")) {
        return { rows: [currentFence] } as unknown as QueryResult;
      }
      if (text.startsWith("INSERT INTO execution_reviews")) {
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      }
      if (text.includes("FROM execution_reviews WHERE id")) {
        return { rows: [{ matches: true }] } as unknown as QueryResult;
      }
      if (text.startsWith("INSERT INTO confirmation_evidence")) {
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      }
      if (text.includes("FROM confirmation_evidence WHERE id")) {
        return { rows: [{ matches: true }] } as unknown as QueryResult;
      }
      if (text.startsWith("INSERT INTO lifecycle_fingerprints")) {
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      }
      if (text.includes("FROM lifecycle_fingerprints WHERE id")) {
        return { rows: [{ matches: true }] } as unknown as QueryResult;
      }
      throw new Error(`UNEXPECTED_QUERY:${text}`);
    }
  } as unknown as PoolClient;
  const input: ExecutionEvidenceInput = {
    accountId: "account-1",
    candidateId: null,
    review: {
      id: "review-1",
      reviewType: "entry",
      status: "valid",
      clientOrderId: "client-order-1",
      accountFingerprint: "account-fingerprint-1",
      sourceRecommendationId: "recommendation-1",
      sourceSnapshotId: "snapshot-1",
      configurationFingerprint: "configuration-1",
      payloadFingerprint: "payload-1",
      signatureAlgorithm: "sha256",
      signature: "signature-1",
      orderIntent: { symbol: "SPY" },
      marketEvidence: {},
      portfolioEvidence: {},
      warnings: [],
      blockers: [],
      requestId: "request-1",
      correlationId: "correlation-1",
      expiresAt: "2026-07-16T17:00:00.000Z",
      createdAt: "2026-07-16T16:00:00.000Z"
    },
    confirmation: {
      id: "confirmation-1",
      evidenceType: "paper_execution_confirmation",
      confirmationMethod: "confirm_paper",
      status: "valid",
      payloadFingerprint: "confirmation-payload-1",
      signatureAlgorithm: "sha256",
      signature: "confirmation-signature-1",
      evidence: { confirmPaper: true },
      confirmedAt: "2026-07-16T16:00:00.000Z",
      expiresAt: "2026-07-16T17:00:00.000Z"
    },
    lifecycleFingerprint: {
      id: "fingerprint-1",
      entityType: "execution_review",
      entityId: "review-1",
      lifecycleStage: "confirmed",
      fingerprint: "fingerprint-value-1",
      payloadVersion: 1,
      evidence: { confirmationMethod: "confirm_paper" },
      requestId: "request-1",
      correlationId: "correlation-1",
      capturedAt: "2026-07-16T16:00:00.000Z"
    }
  };

  const result = await new PostgresExecutionStateRepository().upsertExecutionEvidence(
    input,
    contextFor(client)
  );

  assert.deepEqual(result, { status: "stored" });
  const reviewReplay = queries.find((query) =>
    query.includes("FROM execution_reviews WHERE id")) ?? "";
  const confirmationReplay = queries.find((query) =>
    query.includes("FROM confirmation_evidence WHERE id")) ?? "";
  const lifecycleReplay = queries.find((query) =>
    query.includes("FROM lifecycle_fingerprints WHERE id")) ?? "";
  assert.match(reviewReplay, /status = \$5 OR\s+\(status = 'consumed'/);
  assert.match(confirmationReplay, /status = \$7 OR\s+\(status = 'consumed'/);
  assert.doesNotMatch(confirmationReplay, /confirmed_at =/);
  assert.doesNotMatch(confirmationReplay, /created_at =/);
  assert.doesNotMatch(lifecycleReplay, /captured_at =/);
  assert.doesNotMatch(lifecycleReplay, /created_at =/);
});
