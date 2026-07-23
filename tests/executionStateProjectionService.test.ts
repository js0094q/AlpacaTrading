import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient } from "pg";

import type { DatabaseConfig } from "../src/lib/database/config.js";
import type { ExecutionStateRepository } from "../src/repositories/contracts/executionStateRepository.js";
import {
  createExecutionStateProjectionService,
  mapPaperExecutionLedgerToBrokerResult,
  mapPaperExecutionLedgerToReservationIntent,
  mapPaperSubmitStateToExecutionProjection
} from "../src/services/executionStateProjectionService.js";
import type { PaperSubmitStateAttestation } from "../src/services/paperSubmitStateService.js";
import type { PaperExecutionLedgerEntry } from "../src/services/paperExecutionLedgerService.js";

const state = {
  version: "paper-submit-state-v1",
  capturedAt: "2026-07-16T16:00:00.000Z",
  accountIdentityHash: "account-hash-1",
  accountState: {
    status: "ACTIVE",
    cash: 4000,
    equity: 10000,
    buyingPower: 8000,
    optionsBuyingPower: 5000,
    optionsApprovalLevel: 2,
    tradingBlocked: false,
    accountBlocked: false
  },
  configuration: {
    environment: "paper",
    tradingMode: "paper",
    liveTradingEnabled: false,
    paperOrderExecutionEnabled: true,
    paperOptionsExecutionEnabled: true,
    maxPositionNotional: 2500,
    maxTotalPlanNotional: 5000,
    equityMaxNotionalPerOrder: 1000,
    equityMaxPortfolioDeployPct: 50,
    equityMaxPositionPct: 20,
    equityMinCashReservePct: 20,
    optionMaxOrderNotional: 500,
    optionMaxContracts: 2,
    optionMaxPortfolioRiskPct: 5,
    optionMaxPositionRiskPct: 2,
    quoteMaxAgeSeconds: 30,
    maxPriceDriftPct: 2
  },
  configurationFingerprint: "configuration-fingerprint-1",
  positions: [{
    symbol: "SPY",
    assetClass: "equity",
    quantity: 2,
    marketValue: 1000,
    currentPrice: 500
  }],
  openOrders: [{
    symbol: "QQQ",
    assetClass: "equity",
    side: "buy",
    status: "accepted",
    quantity: 1,
    notional: null,
    limitPrice: 450,
    clientOrderIdHash: "order-hash-1"
  }],
  reservations: [{
    symbol: "IWM",
    assetClass: "equity",
    side: "buy",
    status: "reserved",
    quantity: 1,
    notional: null,
    estimatedPremium: 200,
    limitPrice: 200,
    clientOrderIdHash: "reservation-hash-1"
  }],
  marketEvidence: [],
  payloadIntents: [],
  structuralPortfolioFingerprint: "structural-fingerprint-1",
  portfolioFingerprint: "portfolio-fingerprint-1",
  marketEvidenceFingerprint: "market-fingerprint-1",
  allocationAttestation: {
    mode: "baseline",
    identity: "baseline-v1",
    allocatorControlled: false
  },
  complete: true,
  blockers: [],
  warnings: []
} satisfies PaperSubmitStateAttestation;

const config = (input: {
  shadow?: boolean;
  authority?: boolean;
} = {}): DatabaseConfig => ({
  backend: "postgres",
  runtime: "test",
  purpose: "application",
  sslRequired: true,
  applicationName: "execution-projection-test",
  maxConnections: 1,
  minConnections: 0,
  idleTimeoutMs: 1_000,
  connectionTimeoutMs: 1_000,
  statementTimeoutMs: 1_000,
  lockTimeoutMs: 500,
  idleInTransactionTimeoutMs: 1_000,
  transactionTimeoutMs: 2_000,
  features: {
    postgresReads: true,
    postgresWrites: true,
    shadowComparison: false,
    controlPlaneAuthority: true,
    schedulerAuthority: true,
    executionStateShadow: input.shadow ?? false,
    executionStateAuthority: input.authority ?? false,
    sqliteAuditMirror: true
  }
});

test("maps paper submit state into deterministic PostgreSQL execution domains", () => {
  const projection = mapPaperSubmitStateToExecutionProjection(state);
  assert.equal(projection.accountId, "account_account-hash-1");
  assert.equal(projection.brokerAccountId, "account-hash-1");
  assert.equal(projection.cash, "4000.00000000");
  assert.equal(projection.riskLimit.cashReserveRatio, "0.2000000000");
  assert.equal(projection.riskLimit.maxDeploymentRatio, "0.5000000000");
  assert.equal(projection.strategyAllocation.strategyKey, "baseline-v1");
  assert.equal(projection.strategyAllocation.allocationAmount, "5000.00000000");
  assert.equal(projection.positions.length, 1);
  assert.equal(projection.positions[0]?.quantity, "2.000000000000");
  assert.equal(projection.exposure.openOrderExposure, "450.00000000");
  assert.equal(projection.exposure.activeReservationAmount, "200.00000000");
});

test("refreshes positions from the current broker snapshot before PostgreSQL projection", async () => {
  const projected: { value: ReturnType<typeof mapPaperSubmitStateToExecutionProjection> | null } = { value: null };
  const repository = {
    async syncAccountState(input: ReturnType<typeof mapPaperSubmitStateToExecutionProjection>) {
      projected.value = input;
      return {
        status: "synced" as const,
        accountId: input.accountId,
        snapshotId: input.accountSnapshotId
      };
    }
  } as unknown as ExecutionStateRepository<PoolClient>;
  const service = createExecutionStateProjectionService({
    currentRuntime: () => ({
      config: config({ authority: true }),
      pool: {} as Pool,
      fence: {
        jobName: "paper-execution",
        workstream: "paper_execution",
        ownerId: "worker-1",
        runId: "run-1",
        fencingToken: "1"
      },
      signal: new AbortController().signal,
      operationId: "operation-1",
      requestId: null,
      correlationId: null,
      researchRunVersions: new Map()
    }),
    repository,
    listCurrentPositions: async () => ({ positions: [], requestId: "fresh-position-read" }),
    transaction: async (_pool, _config, operation) => operation({} as PoolClient),
    reportDiscrepancy: () => undefined
  });

  const result = await service.syncAccountState(state);

  assert.equal(result.status, "authority_synced");
  assert.ok(projected.value);
  const resultProjection = projected.value;
  assert.equal(resultProjection.positions.length, 0);
  assert.equal(resultProjection.exposure.grossExposure, "0.00000000");
  assert.equal(resultProjection.exposure.netExposure, "0.00000000");
  assert.equal(resultProjection.exposure.longExposure, "0.00000000");
  assert.equal(resultProjection.exposure.shortExposure, "0.00000000");
  assert.equal(resultProjection.exposure.deployedAmount, "0.00000000");
  assert.equal(resultProjection.exposure.positionCount, 0);
  assert.equal(resultProjection.exposure.openOrderExposure, "450.00000000");
  assert.equal(resultProjection.exposure.activeReservationAmount, "200.00000000");
});

test("newer broker positions override stale attestation positions", async () => {
  const projected: { value: ReturnType<typeof mapPaperSubmitStateToExecutionProjection> | null } = { value: null };
  const repository = {
    async syncAccountState(input: ReturnType<typeof mapPaperSubmitStateToExecutionProjection>) {
      projected.value = input;
      return {
        status: "synced" as const,
        accountId: input.accountId,
        snapshotId: input.accountSnapshotId
      };
    }
  } as unknown as ExecutionStateRepository<PoolClient>;
  const service = createExecutionStateProjectionService({
    currentRuntime: () => ({
      config: config({ authority: true }),
      pool: {} as Pool,
      fence: {
        jobName: "paper-execution",
        workstream: "paper_execution",
        ownerId: "worker-1",
        runId: "run-1",
        fencingToken: "1"
      },
      signal: new AbortController().signal,
      operationId: "operation-1",
      requestId: null,
      correlationId: null,
      researchRunVersions: new Map()
    }),
    repository,
    listCurrentPositions: async () => ({
      positions: [{
        symbol: "AAPL",
        assetClass: "us_equity",
        qty: "3",
        marketValue: "600",
        currentPrice: "200"
      }],
      requestId: "newer-position-read"
    }),
    transaction: async (_pool, _config, operation) => operation({} as PoolClient),
    reportDiscrepancy: () => undefined
  });

  await service.syncAccountState(state);

  assert.ok(projected.value);
  const resultProjection = projected.value;
  assert.deepEqual(resultProjection.positions.map((position) => position.symbol), ["AAPL"]);
  assert.equal(resultProjection.positions[0]?.quantity, "3.000000000000");
  assert.equal(resultProjection.exposure.deployedAmount, "600.00000000");
  assert.equal(resultProjection.exposure.positionCount, 1);
});

test("fails closed when the current broker position read fails", async () => {
  let repositoryCalls = 0;
  const repository = {
    async syncAccountState() {
      repositoryCalls += 1;
      return { status: "synced" as const, accountId: "account-1", snapshotId: "snapshot-1" };
    }
  } as unknown as ExecutionStateRepository<PoolClient>;
  const service = createExecutionStateProjectionService({
    currentRuntime: () => ({
      config: config({ authority: true }),
      pool: {} as Pool,
      fence: {
        jobName: "paper-execution",
        workstream: "paper_execution",
        ownerId: "worker-1",
        runId: "run-1",
        fencingToken: "1"
      },
      signal: new AbortController().signal,
      operationId: "operation-1",
      requestId: null,
      correlationId: null,
      researchRunVersions: new Map()
    }),
    repository,
    listCurrentPositions: async () => {
      throw new Error("broker position request failed");
    },
    transaction: async (_pool, _config, operation) => operation({} as PoolClient),
    reportDiscrepancy: () => undefined
  });

  await assert.rejects(
    service.syncAccountState(state),
    (error: unknown) => error instanceof Error && error.message === "EXECUTION_BROKER_POSITION_EVIDENCE_UNAVAILABLE"
  );
  assert.equal(repositoryCalls, 0);
});

test("execution-state shadow reports a discrepancy without changing the caller result", async () => {
  const reports: string[] = [];
  const repository = {
    async syncAccountState() {
      throw new Error("synthetic shadow failure");
    }
  } as unknown as ExecutionStateRepository<PoolClient>;
  const service = createExecutionStateProjectionService({
    currentRuntime: () => ({
      config: config({ shadow: true }),
      pool: {} as Pool,
      fence: {
        jobName: "paper-execution",
        workstream: "paper_execution",
        ownerId: "worker-1",
        runId: "run-1",
        fencingToken: "1"
      },
      signal: new AbortController().signal,
      operationId: "operation-1",
      requestId: null,
      correlationId: null,
      researchRunVersions: new Map()
    }),
    repository,
    transaction: async (_pool, _config, operation) => operation({} as PoolClient),
    reportDiscrepancy: (code) => reports.push(code)
  });

  assert.deepEqual(await service.syncAccountState(state), { status: "shadow_failed" });
  assert.deepEqual(reports, ["EXECUTION_ACCOUNT_SHADOW_WRITE_FAILED"]);
});

test("execution-state authority fails closed when PostgreSQL persistence fails", async () => {
  const repository = {
    async syncAccountState() {
      throw new Error("synthetic authority failure");
    }
  } as unknown as ExecutionStateRepository<PoolClient>;
  const service = createExecutionStateProjectionService({
    currentRuntime: () => ({
      config: config({ authority: true }),
      pool: {} as Pool,
      fence: {
        jobName: "paper-execution",
        workstream: "paper_execution",
        ownerId: "worker-1",
        runId: "run-1",
        fencingToken: "1"
      },
      signal: new AbortController().signal,
      operationId: "operation-1",
      requestId: null,
      correlationId: null,
      researchRunVersions: new Map()
    }),
    repository,
    transaction: async (_pool, _config, operation) => operation({} as PoolClient),
    reportDiscrepancy: () => undefined
  });

  await assert.rejects(service.syncAccountState(state), /synthetic authority failure/);
});

test("execution-state authority builds 0DTE activity evidence from PostgreSQL only", async () => {
  const repository = {
    async listZeroDteActivityState() {
      return {
        status: "listed" as const,
        ledger: [{
          id: "order-1",
          createdAt: "2026-07-16T15:00:00.000Z",
          assetClass: "option",
          symbol: "SPY260716C00600000",
          side: "buy_to_open",
          status: "filled",
          quantity: "1.000000000000",
          limitPrice: "1.25000000",
          estimatedPremium: "125.00000000",
          clientOrderId: "client-order-1",
          brokerOrderId: "broker-order-1",
          rawResponse: {
            status: "filled",
            filled_qty: "1.000000000000",
            filled_avg_price: "1.20000000"
          }
        }],
        positions: []
      };
    }
  } as unknown as ExecutionStateRepository<PoolClient>;
  const service = createExecutionStateProjectionService({
    currentRuntime: () => ({
      config: config({ authority: true }),
      pool: {} as Pool,
      fence: {
        jobName: "zero-dte",
        workstream: "zero_dte",
        ownerId: "worker-1",
        runId: "run-1",
        fencingToken: "1"
      },
      signal: new AbortController().signal,
      operationId: "operation-1",
      requestId: null,
      correlationId: null,
      researchRunVersions: new Map()
    }),
    repository,
    transaction: async (_pool, _config, operation) => operation({} as PoolClient),
    reportDiscrepancy: () => undefined
  });

  const evidence = await service.resolveZeroDteActivityEvidence({
    tradingDate: "2026-07-16",
    asOf: "2026-07-16T16:00:00.000Z",
    positions: [],
    orders: []
  });

  assert.equal(evidence.complete, true);
  assert.equal(evidence.dailyTradeCount, 1);
  assert.equal(evidence.dailyPremium, 120);
});

test("execution-state shadow compares PostgreSQL 0DTE activity but keeps SQLite authoritative", async () => {
  const reports: string[] = [];
  const repository = {
    async listZeroDteActivityState() {
      return { status: "listed" as const, ledger: [], positions: [] };
    }
  } as unknown as ExecutionStateRepository<PoolClient>;
  const service = createExecutionStateProjectionService({
    currentRuntime: () => ({
      config: config({ shadow: true }),
      pool: {} as Pool,
      fence: {
        jobName: "zero-dte",
        workstream: "zero_dte",
        ownerId: "worker-1",
        runId: "run-1",
        fencingToken: "1"
      },
      signal: new AbortController().signal,
      operationId: "operation-1",
      requestId: null,
      correlationId: null,
      researchRunVersions: new Map()
    }),
    repository,
    transaction: async (_pool, _config, operation) => operation({} as PoolClient),
    reportDiscrepancy: (code) => reports.push(code)
  });
  const sqliteEvidence = {
    tradingDate: "2026-07-16",
    asOf: "2026-07-16T16:00:00.000Z",
    complete: true,
    dailyTradeCount: 1,
    dailyPremium: 125,
    dailyRealizedLoss: 0,
    openPositionCount: 0,
    openOrderCount: 0,
    openExposureCount: 0,
    blockers: [],
    warnings: [],
    evidenceFingerprint: "sqlite-fingerprint"
  };

  const evidence = await service.resolveZeroDteActivityEvidence({
    tradingDate: "2026-07-16",
    asOf: "2026-07-16T16:00:00.000Z",
    positions: [],
    orders: []
  }, sqliteEvidence);

  assert.equal(evidence, sqliteEvidence);
  assert.deepEqual(reports, ["EXECUTION_ZERO_DTE_ACTIVITY_SHADOW_MISMATCH"]);
});

const ledger = {
  id: 17,
  createdAt: "2026-07-16T16:00:00.000Z",
  updatedAt: "2026-07-16T16:00:01.000Z",
  mode: "confirmPaper",
  assetClass: "equity",
  symbol: "SPY",
  underlyingSymbol: null,
  strategy: "reviewed-paper",
  side: "buy",
  orderType: "limit",
  timeInForce: "day",
  qty: "2",
  notional: null,
  limitPrice: "500",
  estimatedPremium: null,
  maxRisk: 1000,
  dedupeKey: "dedupe-17",
  clientOrderId: "client-order-17",
  alpacaOrderId: "broker-order-17",
  alpacaStatus: "accepted",
  requestId: "request-17",
  sourcePlanId: "review-17",
  sourceCandidateId: "candidate-17",
  decisionId: null,
  positionLifecycleId: null,
  decisionLinkageStatus: "LEGACY_UNLINKED",
  status: "accepted",
  reason: null,
  blockedReason: null,
  errorMessage: null,
  payloadJson: JSON.stringify({ symbol: "SPY", qty: "2", limit_price: "500" }),
  rawPayloadJson: null,
  rawResponseJson: JSON.stringify({
    id: "broker-order-17",
    client_order_id: "client-order-17",
    status: "accepted",
    filled_qty: "0"
  })
} satisfies PaperExecutionLedgerEntry;

test("maps one execution-ledger identity to an exact reservation, intent, order, and event", () => {
  const account = {
    accountId: "account-1",
    accountSnapshotId: "snapshot-1",
    strategyKey: "baseline-v1"
  };
  const reservation = mapPaperExecutionLedgerToReservationIntent(ledger, account);
  const broker = mapPaperExecutionLedgerToBrokerResult(ledger, account.accountId);

  assert.equal(reservation.amount, "1000.00000000");
  assert.equal(reservation.quantity, "2.000000000000");
  assert.equal(reservation.limitPrice, "500.00000000");
  assert.equal(reservation.clientOrderId, ledger.clientOrderId);
  assert.equal(reservation.strategyKey, "baseline-v1");
  assert.equal(broker.orderIntentId, reservation.orderIntentId);
  assert.equal(broker.clientOrderId, ledger.clientOrderId);
  assert.equal(broker.brokerOrderId, ledger.alpacaOrderId);
  assert.deepEqual(Object.keys(broker.responsePayload as Record<string, unknown>), [
    "brokerOrderId",
    "clientOrderId",
    "filledAveragePrice",
    "filledQuantity",
    "replacesBrokerOrderId",
    "requestId",
    "status"
  ]);
});

test("maps a broker replacement to the existing intent and a distinct current order", () => {
  const accountId = "account-1";
  const originalIntent = mapPaperExecutionLedgerToReservationIntent(ledger, {
    accountId,
    accountSnapshotId: "snapshot-1",
    strategyKey: "baseline-v1"
  });
  const replacement = mapPaperExecutionLedgerToBrokerResult({
    ...ledger,
    alpacaOrderId: "broker-order-18",
    alpacaStatus: "accepted",
    rawResponseJson: JSON.stringify({
      id: "broker-order-18",
      client_order_id: "client-order-18",
      replaces: "broker-order-17",
      status: "accepted",
      qty: "2",
      limit_price: "499.50",
      filled_qty: "0"
    })
  }, accountId);

  assert.equal(replacement.orderIntentId, originalIntent.orderIntentId);
  assert.notEqual(replacement.orderId, `order_${originalIntent.orderIntentId.slice("intent_".length)}`);
  assert.equal(replacement.clientOrderId, ledger.clientOrderId);
  assert.equal(replacement.brokerClientOrderId, "client-order-18");
  assert.equal(replacement.replacesBrokerOrderId, "broker-order-17");
  assert.equal(replacement.brokerLimitPrice, "499.50000000");
});

test("maps sell-to-close to an intent without a cash reservation", () => {
  const source = {
    ...ledger,
    side: "sell",
    maxRisk: null,
    estimatedPremium: null,
    rawPayloadJson: JSON.stringify({ position_intent: "sell_to_close" })
  } satisfies PaperExecutionLedgerEntry;
  const intent = mapPaperExecutionLedgerToReservationIntent(source, {
    accountId: "account-1",
    accountSnapshotId: "snapshot-1",
    strategyKey: "baseline-v1"
  });
  assert.equal(intent.side, "sell_to_close");
  assert.equal(intent.reservationRequired, false);
  assert.equal(intent.reservationId, null);
});

test("a missing broker order identity remains ambiguous and non-retryable", () => {
  const broker = mapPaperExecutionLedgerToBrokerResult({
    ...ledger,
    status: "failed",
    alpacaOrderId: null,
    alpacaStatus: "accepted",
    reason: "HEDGE_BROKER_ORDER_ID_MISSING",
    blockedReason: "HEDGE_BROKER_ORDER_ID_MISSING",
    errorMessage: "Broker order identity was absent."
  }, "account-1");

  assert.equal(broker.status, "ambiguous");
  assert.equal(broker.errorClassification, "ambiguous_broker_result");
  assert.equal(broker.retryable, false);
});

test("shadow reservation reads compare PostgreSQL but preserve SQLite authority", async () => {
  const reports: string[] = [];
  const sqliteReservations = [{
    symbol: "SPY",
    assetClass: "equity" as const,
    side: "buy",
    status: "reserved",
    quantity: 1,
    notional: null,
    estimatedPremium: 100,
    limitPrice: 100,
    clientOrderIdHash: "sqlite-hash"
  }];
  const repository = {
    async listActiveReservations() {
      return [{
        symbol: "QQQ",
        assetClass: "equity" as const,
        side: "buy" as const,
        status: "active",
        quantity: "1",
        notional: null,
        estimatedPremium: "200",
        limitPrice: "200",
        clientOrderId: "postgres-order"
      }];
    }
  } as unknown as ExecutionStateRepository<PoolClient>;
  const service = createExecutionStateProjectionService({
    currentRuntime: () => ({
      config: config({ shadow: true }),
      pool: {} as Pool,
      fence: {
        jobName: "paper-execution",
        workstream: "paper_execution",
        ownerId: "worker-1",
        runId: "run-1",
        fencingToken: "1"
      },
      signal: new AbortController().signal,
      operationId: "operation-1",
      requestId: null,
      correlationId: null,
      researchRunVersions: new Map()
    }),
    repository,
    transaction: async (_pool, _config, operation) => operation({} as PoolClient),
    reportDiscrepancy: (code) => reports.push(code)
  });

  assert.deepEqual(await service.resolveReservations(sqliteReservations), sqliteReservations);
  assert.deepEqual(reports, ["EXECUTION_RESERVATION_SHADOW_MISMATCH"]);
});

test("shadow reservation denial cannot control the SQLite-authoritative broker path", async () => {
  const reports: string[] = [];
  const repository = {
    async findCurrentAccount() {
      return {
        accountId: "account-1",
        accountSnapshotId: "snapshot-1",
        strategyKey: "baseline-v1"
      };
    },
    async reserveAndCreateOrderIntent() {
      return { status: "blocked", blockers: ["BUYING_POWER_LIMIT_EXCEEDED"] } as const;
    }
  } as unknown as ExecutionStateRepository<PoolClient>;
  const service = createExecutionStateProjectionService({
    currentRuntime: () => ({
      config: config({ shadow: true }),
      pool: {} as Pool,
      fence: {
        jobName: "paper-execution",
        workstream: "paper_execution",
        ownerId: "worker-1",
        runId: "run-1",
        fencingToken: "1"
      },
      signal: new AbortController().signal,
      operationId: "operation-1",
      requestId: null,
      correlationId: null,
      researchRunVersions: new Map()
    }),
    repository,
    transaction: async (_pool, _config, operation) => operation({} as PoolClient),
    reportDiscrepancy: (code) => reports.push(code)
  });

  assert.deepEqual(await service.reserveOrderIntent(ledger), {
    status: "shadow_blocked",
    brokerAllowed: true,
    blockers: ["BUYING_POWER_LIMIT_EXCEEDED"]
  });
  assert.deepEqual(reports, ["EXECUTION_RESERVATION_SHADOW_MISMATCH"]);
});

test("an existing PostgreSQL intent requires reconciliation instead of broker resubmission", async () => {
  const repository = {
    async findCurrentAccount() {
      return {
        accountId: "account-1",
        accountSnapshotId: "snapshot-1",
        strategyKey: "baseline-v1"
      };
    },
    async reserveAndCreateOrderIntent() {
      return {
        status: "duplicate",
        reservationId: "reservation-1",
        orderIntentId: "intent-1"
      } as const;
    }
  } as unknown as ExecutionStateRepository<PoolClient>;
  const service = createExecutionStateProjectionService({
    currentRuntime: () => ({
      config: config({ authority: true }),
      pool: {} as Pool,
      fence: {
        jobName: "paper-execution",
        workstream: "paper_execution",
        ownerId: "worker-1",
        runId: "run-1",
        fencingToken: "1"
      },
      signal: new AbortController().signal,
      operationId: "operation-1",
      requestId: null,
      correlationId: null,
      researchRunVersions: new Map()
    }),
    repository,
    transaction: async (_pool, _config, operation) => operation({} as PoolClient),
    reportDiscrepancy: () => undefined
  });

  assert.deepEqual(await service.reserveOrderIntent(ledger), {
    status: "authority_duplicate",
    brokerAllowed: false,
    blockers: ["EXECUTION_INTENT_RECONCILIATION_REQUIRED"],
    reservationId: "reservation-1",
    orderIntentId: "intent-1"
  });
});

test("authority reconciliation performs the broker lookup outside PostgreSQL transactions", async () => {
  const sequence: string[] = [];
  let transactionOpen = false;
  const repository = {
    async listBrokerReconciliationTargets() {
      sequence.push("list");
      return {
        status: "listed",
        targets: [{
          orderIntentId: "intent-17",
          orderId: "order-17",
          accountId: "account-1",
          clientOrderId: "client-order-17",
          symbol: "SPY",
          underlyingSymbol: null,
          assetClass: "equity",
          side: "buy",
          orderType: "limit",
          timeInForce: "day",
          quantity: "2.000000000000",
          notional: null,
          limitPrice: "500.00000000",
          stopPrice: null,
          intentStatus: "ambiguous",
          createdAt: "2026-07-16T16:00:00.000Z"
        }]
      } as const;
    },
    async recordBrokerResult(input: { clientOrderId: string }) {
      assert.equal(transactionOpen, true);
      assert.equal(input.clientOrderId, "client-order-17");
      sequence.push("record");
      return { status: "recorded", orderId: "order-17" } as const;
    }
  } as unknown as ExecutionStateRepository<PoolClient>;
  const service = createExecutionStateProjectionService({
    currentRuntime: () => ({
      config: config({ authority: true }),
      pool: {} as Pool,
      fence: {
        jobName: "reconciliation",
        workstream: "reconciliation",
        ownerId: "worker-1",
        runId: "run-1",
        fencingToken: "4"
      },
      signal: new AbortController().signal,
      operationId: "operation-1",
      requestId: null,
      correlationId: null,
      researchRunVersions: new Map()
    }),
    repository,
    transaction: async (_pool, _config, operation) => {
      assert.equal(transactionOpen, false);
      transactionOpen = true;
      try {
        return await operation({} as PoolClient);
      } finally {
        transactionOpen = false;
      }
    },
    reportDiscrepancy: () => undefined
  });

  const result = await service.reconcileBrokerOrders({
    now: "2026-07-16T16:01:00.000Z",
    getOrderByClientOrderId: async (clientOrderId) => {
      assert.equal(transactionOpen, false);
      assert.equal(clientOrderId, "client-order-17");
      sequence.push("broker");
      return {
        data: {
          id: "broker-order-17",
          client_order_id: clientOrderId,
          symbol: "SPY",
          side: "buy",
          type: "limit",
          time_in_force: "day",
          qty: "2",
          limit_price: "500.00000000",
          status: "filled",
          filled_qty: "2",
          filled_avg_price: "499.50",
          updated_at: "2026-07-16T16:00:30.000Z"
        },
        requestId: "reconcile-request-17",
        status: 200,
        url: "paper"
      };
    }
  });

  assert.deepEqual(sequence, ["list", "broker", "record"]);
  assert.deepEqual(result, {
    status: "reconciled",
    checked: 1,
    recorded: 1,
    replayed: 0,
    filled: 1,
    partial: 0,
    terminal: 0,
    errors: []
  });
});

test("authority reconciliation follows a broker replacement chain without reopening a transaction", async () => {
  const sequence: string[] = [];
  let transactionOpen = false;
  const repository = {
    async listBrokerReconciliationTargets() {
      sequence.push("list");
      return {
        status: "listed",
        targets: [{
          orderIntentId: "intent-17",
          orderId: "order-17",
          accountId: "account-1",
          clientOrderId: "client-order-17",
          brokerOrderId: "broker-order-17",
          brokerClientOrderId: "client-order-17",
          symbol: "SPY",
          underlyingSymbol: null,
          assetClass: "equity",
          side: "buy",
          orderType: "limit",
          timeInForce: "day",
          quantity: "2.000000000000",
          notional: null,
          limitPrice: "500.00000000",
          stopPrice: null,
          brokerQuantity: "2.000000000000",
          brokerNotional: null,
          brokerLimitPrice: "500.00000000",
          brokerStopPrice: null,
          intentStatus: "submitted",
          createdAt: "2026-07-16T16:00:00.000Z"
        }]
      } as const;
    },
    async recordBrokerResult(input: {
      clientOrderId: string;
      brokerClientOrderId?: string;
      replacesBrokerOrderId?: string | null;
      orderId: string;
    }) {
      assert.equal(transactionOpen, true);
      assert.equal(input.clientOrderId, "client-order-17");
      assert.equal(input.brokerClientOrderId, "replacement-client-order-18");
      assert.equal(input.replacesBrokerOrderId, "broker-order-17");
      assert.notEqual(input.orderId, "order-17");
      sequence.push("record");
      return { status: "recorded", orderId: input.orderId } as const;
    }
  } as unknown as ExecutionStateRepository<PoolClient>;
  const service = createExecutionStateProjectionService({
    currentRuntime: () => ({
      config: config({ authority: true }),
      pool: {} as Pool,
      fence: {
        jobName: "reconciliation",
        workstream: "reconciliation",
        ownerId: "worker-1",
        runId: "run-1",
        fencingToken: "4"
      },
      signal: new AbortController().signal,
      operationId: "operation-1",
      requestId: null,
      correlationId: null,
      researchRunVersions: new Map()
    }),
    repository,
    transaction: async (_pool, _config, operation) => {
      assert.equal(transactionOpen, false);
      transactionOpen = true;
      try {
        return await operation({} as PoolClient);
      } finally {
        transactionOpen = false;
      }
    },
    reportDiscrepancy: () => undefined
  });

  const result = await service.reconcileBrokerOrders({
    now: "2026-07-16T16:01:00.000Z",
    getOrderByClientOrderId: async () => {
      assert.equal(transactionOpen, false);
      sequence.push("broker-client");
      return {
        data: {
          id: "broker-order-17",
          client_order_id: "client-order-17",
          replaced_by: "broker-order-18",
          symbol: "SPY",
          side: "buy",
          type: "limit",
          time_in_force: "day",
          qty: "2",
          limit_price: "500",
          status: "replaced",
          filled_qty: "0"
        },
        status: 200,
        url: "paper"
      };
    },
    getOrderById: async (orderId) => {
      assert.equal(transactionOpen, false);
      assert.equal(orderId, "broker-order-18");
      sequence.push("broker-id");
      return {
        data: {
          id: orderId,
          client_order_id: "replacement-client-order-18",
          replaces: "broker-order-17",
          symbol: "SPY",
          side: "buy",
          type: "limit",
          time_in_force: "day",
          qty: "2",
          limit_price: "499.50",
          status: "filled",
          filled_qty: "2",
          filled_avg_price: "499.25"
        },
        status: 200,
        url: "paper"
      };
    }
  });

  assert.deepEqual(sequence, ["list", "broker-client", "broker-id", "record"]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.filled, 1);
});

test("authority reconciliation fails closed on broker identity drift", async () => {
  let persisted = 0;
  const repository = {
    async listBrokerReconciliationTargets() {
      return {
        status: "listed",
        targets: [{
          orderIntentId: "intent-17",
          orderId: null,
          accountId: "account-1",
          clientOrderId: "client-order-17",
          symbol: "SPY",
          underlyingSymbol: null,
          assetClass: "equity",
          side: "buy",
          orderType: "market",
          timeInForce: "day",
          quantity: "2.000000000000",
          notional: null,
          limitPrice: null,
          stopPrice: null,
          intentStatus: "ready_for_submission",
          createdAt: "2026-07-16T16:00:00.000Z"
        }]
      } as const;
    },
    async recordBrokerResult() {
      persisted += 1;
      return { status: "recorded", orderId: "order-17" } as const;
    }
  } as unknown as ExecutionStateRepository<PoolClient>;
  const service = createExecutionStateProjectionService({
    currentRuntime: () => ({
      config: config({ authority: true }),
      pool: {} as Pool,
      fence: {
        jobName: "reconciliation",
        workstream: "reconciliation",
        ownerId: "worker-1",
        runId: "run-1",
        fencingToken: "4"
      },
      signal: new AbortController().signal,
      operationId: "operation-1",
      requestId: null,
      correlationId: null,
      researchRunVersions: new Map()
    }),
    repository,
    transaction: async (_pool, _config, operation) => operation({} as PoolClient),
    reportDiscrepancy: () => undefined
  });

  const result = await service.reconcileBrokerOrders({
    now: "2026-07-16T16:01:00.000Z",
    getOrderByClientOrderId: async () => ({
      data: {
        id: "broker-order-17",
        client_order_id: "different-client-order",
        symbol: "SPY",
        side: "buy",
        type: "market",
        time_in_force: "day",
        qty: "2",
        status: "accepted",
        filled_qty: "0"
      },
      status: 200,
      url: "paper"
    })
  });

  assert.equal(persisted, 0);
  assert.deepEqual(result.errors, [{ code: "BROKER_ORDER_IDENTITY_MISMATCH" }]);
});
