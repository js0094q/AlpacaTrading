import type { Pool, PoolClient } from "pg";

import { canonicalJsonHash } from "../lib/canonicalJson.js";
import type { DatabaseConfig } from "../lib/database/config.js";
import { canonicalizePostgresNumeric } from "../lib/database/postgresNumeric.js";
import { assertPostgresOnlyDatabaseAuthority } from "../lib/database/postgresOnlyRuntime.js";
import { withPostgresTransaction } from "../lib/database/postgresTransaction.js";
import type { ExecutionAccountProjection } from "../repositories/contracts/executionStateRepository.js";
import { PostgresExecutionStateRepository } from "../repositories/postgres/postgresExecutionStateRepository.js";
import { requireCurrentFence } from "../repositories/postgres/postgresRepositorySupport.js";
import { currentControlPlaneRuntimeContext } from "./controlPlaneRuntimeContext.js";
import {
  capturePostgresAuthorityBrokerSnapshot,
  type AuthorityBrokerOrder,
  type AuthorityBrokerPosition,
  type PostgresAuthorityBrokerSnapshot
} from "./postgresAuthorityBrokerSnapshot.js";

export const POSTGRES_AUTHORITY_BASELINE_TYPE =
  "fresh_postgresql_authority_cutover";
export const POSTGRES_AUTHORITY_WORKSTREAM = "postgres_authority_cutover";
export const POSTGRES_AUTHORITY_MAPPING_VERSION = "postgres-only-v2";

const TERMINAL_ORDER_STATUSES = [
  "canceled",
  "cancelled",
  "expired",
  "failed",
  "filled",
  "rejected",
  "replaced"
] as const;
const PROJECTION_VERSION = "paper-submit-state-v1";

type CountRow = { count: number | string };
type PostgresPositionRow = {
  broker_position_key: string;
  symbol: string;
  underlying_symbol: string | null;
  option_symbol: string | null;
  asset_class: "equity" | "option";
  side: "long" | "short";
  status: string;
  quantity: string;
  available_quantity: string | null;
  average_entry_price: string | null;
  current_price: string | null;
  market_value: string | null;
  cost_basis: string | null;
  unrealized_pnl: string | null;
};
type PostgresOrderRow = {
  broker_order_id: string | null;
  client_order_id: string;
  symbol: string;
  asset_class: "equity" | "option";
  side: string;
  order_type: string;
  time_in_force: string;
  status: string;
  quantity: string | null;
  notional: string | null;
  limit_price: string | null;
};
type ExternalBrokerOrderEventRow = {
  broker_order_id: string | null;
  client_order_id: string | null;
  event_status: string;
  response_payload: unknown;
};

export type PostgresAuthorityState = {
  accountCount: number;
  currentSnapshotCount: number;
  brokerPositionCount: number;
  postgresPositionCount: number;
  positionDiscrepancyCount: number;
  brokerOpenOrderCount: number;
  postgresOpenOrderCount: number;
  orderDiscrepancyCount: number;
  activeReservationCount: number;
  staleActiveReservationCount: number;
  activeStrategyAllocationCount: number;
  activeRiskLimitCount: number;
  currentReviewCount: number;
  staleReviewCount: number;
  currentConfirmationCount: number;
  staleConfirmationCount: number;
  reviewConfirmationLinkDiscrepancyCount: number;
  historicalReviewCount: number;
  historicalConfirmationCount: number;
  candidateCount: number;
  candidateLearningStateCount: number;
  recoveredResearchRunCount: number;
  staleResearchRunCount: number;
  retryableFailureCount: number;
  unexpectedHeldLeaseCount: number;
};

export type PostgresAuthorityCleanup = {
  expiredReservations: number;
  expiredReviews: number;
  expiredConfirmations: number;
  recoveredResearchRuns: number;
};

type CutoverTerminalState = {
  state: PostgresAuthorityState;
  cleanup: PostgresAuthorityCleanup;
  discrepancies: string[];
};

class PostgresAuthorityValidationError extends Error {
  readonly terminalState: CutoverTerminalState;

  constructor(terminalState: CutoverTerminalState) {
    super("POSTGRES_AUTHORITY_CURRENT_STATE_INVALID");
    this.name = "PostgresAuthorityValidationError";
    this.terminalState = terminalState;
  }
}

const count = (row: CountRow | undefined) => Number(row?.count ?? 0);
const money = (value: number | string | null) =>
  canonicalizePostgresNumeric(value, 28, 8);
const quantity = (value: number | string | null) =>
  canonicalizePostgresNumeric(value, 28, 12);
const ratioFromPercent = (value: number) =>
  canonicalizePostgresNumeric(String(value / 100), 12, 10);
const finite = (value: number | null) =>
  value !== null && Number.isFinite(value) ? value : 0;

const safeErrorCode = (error: unknown) => {
  const candidate = error instanceof Error ? error.message : String(error);
  const code = candidate.split(":", 1)[0]?.trim();
  return code && /^[A-Z0-9_]+$/.test(code)
    ? code.slice(0, 120)
    : "POSTGRES_AUTHORITY_CUTOVER_FAILED";
};

const assertCurrentFence = async (client: PoolClient) => {
  const runtime = currentControlPlaneRuntimeContext();
  if (!runtime) throw new Error("POSTGRES_AUTHORITY_RUNTIME_CONTEXT_REQUIRED");
  const fenced = await requireCurrentFence({
    transaction: client,
    operationId: runtime.operationId,
    requestId: runtime.requestId,
    correlationId: runtime.correlationId,
    actorId: runtime.fence.ownerId,
    schedulerFence: runtime.fence
  });
  if (!fenced.accepted) throw new Error("POSTGRES_AUTHORITY_FENCE_REJECTED");
  return runtime;
};

const postgresRepositoryContext = (runtime: ReturnType<typeof currentControlPlaneRuntimeContext>, client: PoolClient) => {
  if (!runtime) throw new Error("POSTGRES_AUTHORITY_RUNTIME_CONTEXT_REQUIRED");
  return {
    transaction: client,
    operationId: runtime.operationId,
    requestId: runtime.requestId,
    correlationId: runtime.correlationId,
    actorId: runtime.fence.ownerId,
    schedulerFence: runtime.fence
  };
};

export const evaluatePostgresAuthorityState = (state: PostgresAuthorityState) => {
  const discrepancies = [
    state.accountCount !== 1 ? "CURRENT_PAPER_ACCOUNT_STATE_INVALID" : null,
    state.currentSnapshotCount !== 1 ? "CURRENT_ACCOUNT_SNAPSHOT_MISSING" : null,
    state.positionDiscrepancyCount !== 0 ||
    state.brokerPositionCount !== state.postgresPositionCount
      ? "BROKER_POSITION_STATE_MISMATCH"
      : null,
    state.orderDiscrepancyCount !== 0 ||
    state.brokerOpenOrderCount !== state.postgresOpenOrderCount
      ? "BROKER_OPEN_ORDER_STATE_MISMATCH"
      : null,
    state.activeReservationCount !== 0
      ? "ACTIVE_BUYING_POWER_RESERVATION_REVIEW_REQUIRED"
      : null,
    state.staleActiveReservationCount !== 0
      ? "STALE_BUYING_POWER_RESERVATION_PRESENT"
      : null,
    state.activeStrategyAllocationCount !== 1
      ? "ACTIVE_STRATEGY_ALLOCATION_INVALID"
      : null,
    state.activeRiskLimitCount !== 1 ? "ACTIVE_RISK_LIMIT_INVALID" : null,
    state.staleReviewCount !== 0 ? "STALE_EXECUTION_REVIEW_PRESENT" : null,
    state.staleConfirmationCount !== 0
      ? "STALE_CONFIRMATION_EVIDENCE_PRESENT"
      : null,
    state.reviewConfirmationLinkDiscrepancyCount !== 0
      ? "CURRENT_REVIEW_CONFIRMATION_LINK_MISMATCH"
      : null,
    state.currentReviewCount !== state.currentConfirmationCount
      ? "CURRENT_REVIEW_CONFIRMATION_COUNT_MISMATCH"
      : null,
    state.historicalReviewCount === 0 ? "EXECUTION_REVIEW_HISTORY_MISSING" : null,
    state.historicalConfirmationCount === 0
      ? "CONFIRMATION_EVIDENCE_HISTORY_MISSING"
      : null,
    state.candidateCount === 0 ? "LEARNING_CANDIDATE_STATE_MISSING" : null,
    state.candidateLearningStateCount !== state.candidateCount
      ? "LEARNING_ADJUSTMENT_STATE_INCOMPLETE"
      : null,
    state.recoveredResearchRunCount === 0
      ? "REQUIRED_RECOVERY_STATE_MISSING"
      : null,
    state.staleResearchRunCount !== 0 ? "STALE_RESEARCH_RUN_PRESENT" : null,
    state.retryableFailureCount !== 0 ? "RETRYABLE_RECOVERY_STATE_PRESENT" : null,
    state.unexpectedHeldLeaseCount !== 0 ? "UNEXPECTED_SCHEDULER_LEASE_HELD" : null
  ].filter((value): value is string => value !== null);
  return {
    status: discrepancies.length === 0 ? "passed" as const : "blocked" as const,
    discrepancies
  };
};

const comparablePosition = (position: AuthorityBrokerPosition) => ({
  brokerPositionKey: position.brokerPositionKey,
  symbol: position.symbol,
  underlyingSymbol: position.underlyingSymbol,
  optionSymbol: position.optionSymbol,
  assetClass: position.assetClass,
  side: position.side,
  status: "open",
  quantity: quantity(position.quantity),
  availableQuantity: quantity(position.availableQuantity),
  averageEntryPrice: money(position.averageEntryPrice),
  currentPrice: money(position.currentPrice),
  marketValue: money(position.marketValue),
  costBasis: money(position.costBasis),
  unrealizedPnl: money(position.unrealizedPnl)
});

const comparablePostgresPosition = (position: PostgresPositionRow) => ({
  brokerPositionKey: position.broker_position_key,
  symbol: position.symbol,
  underlyingSymbol: position.underlying_symbol,
  optionSymbol: position.option_symbol,
  assetClass: position.asset_class,
  side: position.side,
  status: position.status,
  quantity: quantity(position.quantity),
  availableQuantity: position.available_quantity === null ? null : quantity(position.available_quantity),
  averageEntryPrice: position.average_entry_price === null ? null : money(position.average_entry_price),
  currentPrice: position.current_price === null ? null : money(position.current_price),
  marketValue: position.market_value === null ? null : money(position.market_value),
  costBasis: position.cost_basis === null ? null : money(position.cost_basis),
  unrealizedPnl: position.unrealized_pnl === null ? null : money(position.unrealized_pnl)
});

export const countPositionDiscrepancies = (
  broker: readonly AuthorityBrokerPosition[],
  postgres: readonly PostgresPositionRow[]
) => {
  const expected = new Map(broker.map((row) => [row.brokerPositionKey, comparablePosition(row)]));
  const actual = new Map(postgres.map((row) => [row.broker_position_key, comparablePostgresPosition(row)]));
  const keys = new Set([...expected.keys(), ...actual.keys()]);
  let discrepancies = 0;
  for (const key of keys) {
    if (JSON.stringify(expected.get(key) ?? null) !== JSON.stringify(actual.get(key) ?? null)) {
      discrepancies += 1;
    }
  }
  return discrepancies;
};

const comparableOrder = (order: AuthorityBrokerOrder) => ({
  brokerOrderId: order.brokerOrderId,
  clientOrderId: order.clientOrderId,
  symbol: order.symbol,
  assetClass: order.assetClass,
  side: order.side,
  orderType: order.orderType,
  timeInForce: order.timeInForce,
  status: order.status,
  quantity: order.quantity === null ? null : quantity(order.quantity),
  notional: order.notional === null ? null : money(order.notional),
  limitPrice: order.limitPrice === null ? null : money(order.limitPrice)
});

const comparablePostgresOrder = (order: PostgresOrderRow) => ({
  brokerOrderId: order.broker_order_id,
  clientOrderId: order.client_order_id,
  symbol: order.symbol,
  assetClass: order.asset_class,
  side: order.side,
  orderType: order.order_type,
  timeInForce: order.time_in_force,
  status: order.status.toLowerCase(),
  quantity: order.quantity === null ? null : quantity(order.quantity),
  notional: order.notional === null ? null : money(order.notional),
  limitPrice: order.limit_price === null ? null : money(order.limit_price)
});

const observationRecord = (value: unknown, code: string) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
};
const observationText = (value: unknown, code: string) => {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(code);
  return text;
};
const observationDecimal = (value: unknown, code: string) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return String(value);
};

export const mapExternalBrokerOrderObservation = (
  row: Record<string, unknown>
): PostgresOrderRow => {
  const payload = observationRecord(
    row.response_payload,
    "POSTGRES_EXTERNAL_ORDER_OBSERVATION_PAYLOAD_INVALID"
  );
  if (payload.provenance !== "external_order_without_postgres_intent") {
    throw new Error("POSTGRES_EXTERNAL_ORDER_PROVENANCE_INVALID");
  }
  const observed = observationRecord(
    payload.observedOrder,
    "POSTGRES_EXTERNAL_ORDER_OBSERVATION_STATE_INVALID"
  );
  const brokerOrderId = observationText(
    row.broker_order_id,
    "POSTGRES_EXTERNAL_ORDER_OBSERVATION_BROKER_ID_MISSING"
  );
  const clientOrderId = observationText(
    row.client_order_id,
    "POSTGRES_EXTERNAL_ORDER_OBSERVATION_CLIENT_ID_MISSING"
  );
  const status = observationText(
    row.event_status,
    "POSTGRES_EXTERNAL_ORDER_OBSERVATION_STATUS_MISSING"
  ).toLowerCase();
  if (
    observationText(observed.brokerOrderId, "POSTGRES_EXTERNAL_ORDER_OBSERVATION_BROKER_ID_MISSING") !== brokerOrderId ||
    observationText(observed.clientOrderId, "POSTGRES_EXTERNAL_ORDER_OBSERVATION_CLIENT_ID_MISSING") !== clientOrderId ||
    observationText(observed.status, "POSTGRES_EXTERNAL_ORDER_OBSERVATION_STATUS_MISSING").toLowerCase() !== status
  ) {
    throw new Error("POSTGRES_EXTERNAL_ORDER_OBSERVATION_IDENTITY_MISMATCH");
  }
  const assetClass = observationText(
    observed.assetClass,
    "POSTGRES_EXTERNAL_ORDER_OBSERVATION_ASSET_CLASS_MISSING"
  ).toLowerCase();
  if (assetClass !== "equity" && assetClass !== "option") {
    throw new Error("POSTGRES_EXTERNAL_ORDER_OBSERVATION_ASSET_CLASS_INVALID");
  }
  return {
    broker_order_id: brokerOrderId,
    client_order_id: clientOrderId,
    symbol: observationText(observed.symbol, "POSTGRES_EXTERNAL_ORDER_OBSERVATION_SYMBOL_MISSING").toUpperCase(),
    asset_class: assetClass,
    side: observationText(observed.side, "POSTGRES_EXTERNAL_ORDER_OBSERVATION_SIDE_MISSING").toLowerCase(),
    order_type: observationText(observed.orderType, "POSTGRES_EXTERNAL_ORDER_OBSERVATION_TYPE_MISSING").toLowerCase(),
    time_in_force: observationText(
      observed.timeInForce,
      "POSTGRES_EXTERNAL_ORDER_OBSERVATION_TIME_IN_FORCE_MISSING"
    ).toLowerCase(),
    status,
    quantity: observationDecimal(
      observed.quantity,
      "POSTGRES_EXTERNAL_ORDER_OBSERVATION_QUANTITY_INVALID"
    ),
    notional: observationDecimal(
      observed.notional,
      "POSTGRES_EXTERNAL_ORDER_OBSERVATION_NOTIONAL_INVALID"
    ),
    limit_price: observationDecimal(
      observed.limitPrice,
      "POSTGRES_EXTERNAL_ORDER_OBSERVATION_LIMIT_PRICE_INVALID"
    )
  };
};

export const countOrderDiscrepancies = (
  broker: readonly AuthorityBrokerOrder[],
  postgres: readonly PostgresOrderRow[]
) => {
  const expected = new Map(broker.map((row) => [row.brokerOrderId, comparableOrder(row)]));
  const actual = new Map(postgres.map((row) => [row.broker_order_id ?? `missing:${row.client_order_id}`, comparablePostgresOrder(row)]));
  const keys = new Set([...expected.keys(), ...actual.keys()]);
  let discrepancies = 0;
  for (const key of keys) {
    if (JSON.stringify(expected.get(key) ?? null) !== JSON.stringify(actual.get(key) ?? null)) {
      discrepancies += 1;
    }
  }
  return discrepancies;
};

export const mapBrokerSnapshotToExecutionProjection = (
  snapshot: PostgresAuthorityBrokerSnapshot
): ExecutionAccountProjection => {
  const accountId = `account_${snapshot.accountIdentityHash}`;
  const accountSnapshotId = `snapshot_${canonicalJsonHash({
    accountId,
    capturedAt: snapshot.capturedAt,
    portfolioFingerprint: snapshot.portfolioFingerprint
  })}`;
  const positions = snapshot.positions.map((position) => ({
    id: `position_${canonicalJsonHash({ accountId, brokerPositionKey: position.brokerPositionKey })}`,
    brokerPositionKey: position.brokerPositionKey,
    candidateId: null,
    openingOrderId: null,
    closingOrderId: null,
    symbol: position.symbol,
    underlyingSymbol: position.underlyingSymbol,
    optionSymbol: position.optionSymbol,
    assetClass: position.assetClass,
    side: position.side,
    quantity: quantity(position.quantity)!,
    availableQuantity: quantity(position.availableQuantity),
    averageEntryPrice: money(position.averageEntryPrice),
    currentPrice: money(position.currentPrice),
    marketValue: money(position.marketValue),
    costBasis: money(position.costBasis),
    unrealizedPnl: money(position.unrealizedPnl),
    realizedPnl: null,
    openedAt: snapshot.capturedAt
  }));
  const longExposure = snapshot.positions.reduce(
    (sum, position) => sum + (position.side === "long" ? Math.abs(position.marketValue) : 0),
    0
  );
  const shortExposure = snapshot.positions.reduce(
    (sum, position) => sum + (position.side === "short" ? Math.abs(position.marketValue) : 0),
    0
  );
  const openOrderExposure = snapshot.orders.reduce(
    (sum, order) => sum + Math.abs(finite(order.notional) || finite(order.quantity) * finite(order.limitPrice)),
    0
  );
  const configuration = snapshot.configuration;
  const riskLimitId = `risk_${canonicalJsonHash({
    accountId,
    scope: "portfolio",
    config: snapshot.configurationFingerprint
  })}`;
  const strategyAllocationId = `allocation_${canonicalJsonHash({
    accountId,
    strategy: "baseline-v1",
    config: snapshot.configurationFingerprint
  })}`;
  const exposureFingerprint = canonicalJsonHash({
    accountId,
    observedAt: snapshot.capturedAt,
    portfolioFingerprint: snapshot.portfolioFingerprint,
    structuralPortfolioFingerprint: snapshot.structuralPortfolioFingerprint
  });
  const cashReserveAmount = snapshot.account.equity *
    (configuration.equityMinCashReservePct / 100);

  return {
    accountId,
    brokerAccountId: snapshot.accountIdentityHash,
    accountSnapshotId,
    observedAt: snapshot.capturedAt,
    accountStatus: snapshot.account.status,
    currency: snapshot.account.currency,
    cash: money(snapshot.account.cash),
    portfolioValue: money(snapshot.account.equity),
    equity: money(snapshot.account.equity),
    buyingPower: money(snapshot.account.buyingPower),
    optionsBuyingPower: money(snapshot.account.optionsBuyingPower),
    optionsApprovedLevel: snapshot.account.optionsApprovalLevel,
    tradingBlocked: snapshot.account.tradingBlocked,
    accountBlocked: snapshot.account.accountBlocked,
    snapshotFingerprint: snapshot.portfolioFingerprint,
    evidence: {
      version: POSTGRES_AUTHORITY_MAPPING_VERSION,
      authorityBasis: "current_alpaca_paper_state",
      structuralPortfolioFingerprint: snapshot.structuralPortfolioFingerprint
    },
    positions,
    riskLimit: {
      id: riskLimitId,
      cashReserveAmount: null,
      cashReserveRatio: ratioFromPercent(configuration.equityMinCashReservePct),
      maxDeploymentAmount: money(configuration.maxTotalPlanNotional),
      maxDeploymentRatio: ratioFromPercent(configuration.equityMaxPortfolioDeployPct),
      maxGrossExposure: money(configuration.maxTotalPlanNotional),
      maxNetExposure: money(configuration.maxTotalPlanNotional),
      maxOpenOrderExposure: money(configuration.maxTotalPlanNotional),
      maxPositionNotional: money(configuration.maxPositionNotional),
      maxSymbolNotional: money(configuration.maxPositionNotional),
      maxPositionCount: null,
      maxOrderCount: null,
      configVersion: PROJECTION_VERSION,
      configFingerprint: snapshot.configurationFingerprint
    },
    strategyAllocation: {
      id: strategyAllocationId,
      strategyKey: "baseline-v1",
      allocationAmount: money(configuration.maxTotalPlanNotional),
      allocationRatio: ratioFromPercent(configuration.equityMaxPortfolioDeployPct),
      configVersion: PROJECTION_VERSION,
      configFingerprint: snapshot.configurationFingerprint
    },
    exposure: {
      id: `exposure_${exposureFingerprint}`,
      grossExposure: money(longExposure + shortExposure)!,
      netExposure: money(longExposure - shortExposure)!,
      longExposure: money(longExposure)!,
      shortExposure: money(shortExposure)!,
      openOrderExposure: money(openOrderExposure)!,
      activeReservationAmount: money(0)!,
      deployedAmount: money(longExposure + shortExposure)!,
      cashReserveAmount: money(cashReserveAmount)!,
      availableBuyingPower: money(snapshot.account.buyingPower),
      positionCount: positions.length,
      openOrderCount: snapshot.orders.length,
      fingerprint: exposureFingerprint,
      evidence: {
        portfolioFingerprint: snapshot.portfolioFingerprint,
        configurationFingerprint: snapshot.configurationFingerprint
      }
    }
  };
};

const initialCheckpointMetadata = (capturedAt: string) => ({
  baselineType: POSTGRES_AUTHORITY_BASELINE_TYPE,
  historicalSqliteReconciliation: false,
  historicalReconciliationAttempted: false,
  historicalReconciliationComplete: false,
  authorityBasis: "current_alpaca_paper_state",
  capturedAt,
  mappingVersion: POSTGRES_AUTHORITY_MAPPING_VERSION
});

const createRunningCheckpoint = async (input: {
  pool: Pool;
  config: DatabaseConfig;
  checkpointId: string;
  capturedAt: string;
}) => withPostgresTransaction(input.pool, input.config, async (client) => {
  await assertCurrentFence(client);
  const metadata = initialCheckpointMetadata(input.capturedAt);
  await client.query(
    `INSERT INTO reconciliation_checkpoints(
       id, workstream, checkpoint_key, source_name, target_name, status,
       discrepancy_count, cursor_value, source_aggregates, target_aggregates,
       discrepancy_report, started_at, created_at, updated_at
     ) VALUES (
       $1, $2, $1, 'alpaca_paper_current_state',
       'postgres_only_runtime_authority', 'running', 0, $3::jsonb,
       $4::jsonb, '{}'::jsonb, $5::jsonb, $6, $6, $6
     )`,
    [
      input.checkpointId,
      POSTGRES_AUTHORITY_WORKSTREAM,
      JSON.stringify(metadata),
      JSON.stringify({
        ...metadata,
        paperOnly: true,
        brokerMutationAttempted: false,
        ordersSubmitted: 0
      }),
      JSON.stringify({ discrepancyCodes: [] }),
      input.capturedAt
    ]
  );
});

const assertExistingPolicyMatches = async (
  client: PoolClient,
  projection: ExecutionAccountProjection
) => {
  const result = await client.query<{
    risk_fingerprint: string | null;
    allocation_fingerprint: string | null;
  }>(
    `SELECT
       (SELECT config_fingerprint FROM risk_limits
        WHERE account_id = $1 AND status = 'active' AND effective_to IS NULL
          AND scope_type = 'portfolio' AND scope_key = 'portfolio'
        ORDER BY updated_at DESC LIMIT 1) AS risk_fingerprint,
       (SELECT config_fingerprint FROM strategy_allocations
        WHERE account_id = $1 AND status = 'active' AND effective_to IS NULL
          AND strategy_key = 'baseline-v1'
        ORDER BY updated_at DESC LIMIT 1) AS allocation_fingerprint`,
    [projection.accountId]
  );
  const row = result.rows[0];
  if (!row?.risk_fingerprint || !row.allocation_fingerprint) {
    throw new Error("POSTGRES_AUTHORITY_POLICY_STATE_MISSING");
  }
  if (
    row.risk_fingerprint !== projection.riskLimit.configFingerprint ||
    row.allocation_fingerprint !== projection.strategyAllocation.configFingerprint
  ) {
    throw new Error("POSTGRES_AUTHORITY_POLICY_FINGERPRINT_MISMATCH");
  }
};

const cleanupStaleRuntimeState = async (
  client: PoolClient,
  now: string
): Promise<PostgresAuthorityCleanup> => {
  const expiredReservations = await client.query(
    `WITH expired AS (
       UPDATE buying_power_reservations
       SET status = 'expired', released_at = $1,
           release_reason = 'postgres_authority_cutover_expired',
           version = version + 1, updated_at = $1
       WHERE status = 'active' AND expires_at <= $1
       RETURNING account_id, strategy_key, amount
     ), totals AS (
       SELECT account_id, strategy_key, SUM(amount) AS amount
       FROM expired GROUP BY account_id, strategy_key
     ), adjusted AS (
       UPDATE strategy_allocations AS allocation
       SET reserved_amount = GREATEST(0, allocation.reserved_amount - totals.amount),
           version = allocation.version + 1, updated_at = $1
       FROM totals
       WHERE allocation.account_id = totals.account_id
         AND allocation.strategy_key = totals.strategy_key
         AND allocation.status = 'active' AND allocation.effective_to IS NULL
       RETURNING allocation.id
     ) SELECT COUNT(*) AS count FROM expired`,
    [now]
  );
  const expiredReviews = await client.query(
    `UPDATE execution_reviews
     SET status = 'expired', version = version + 1, updated_at = $1
     WHERE status IN ('created', 'valid') AND expires_at <= $1`,
    [now]
  );
  const expiredConfirmations = await client.query(
    `UPDATE confirmation_evidence
     SET status = 'expired', version = version + 1, updated_at = $1
     WHERE status = 'valid' AND expires_at <= $1`,
    [now]
  );
  const recoveredResearch = await client.query(
    `UPDATE research_runs
     SET status = 'recovered', error_code = 'WORKER_TERMINATED_OR_HEARTBEAT_EXPIRED',
         error_message = COALESCE(error_message, 'Stale runtime state closed by PostgreSQL authority cutover.'),
         recovered_at = $1, recovery_reason = 'WORKER_TERMINATED_OR_HEARTBEAT_EXPIRED',
         recovery_source = 'postgres_authority_cutover', completed_at = $1,
         version = version + 1, updated_at = $1
     WHERE status IN ('reserved', 'running')
       AND COALESCE(heartbeat_at, started_at) <= $1::timestamptz - interval '15 minutes'`,
    [now]
  );
  return {
    expiredReservations: count(expiredReservations.rows[0] as CountRow | undefined),
    expiredReviews: expiredReviews.rowCount ?? 0,
    expiredConfirmations: expiredConfirmations.rowCount ?? 0,
    recoveredResearchRuns: recoveredResearch.rowCount ?? 0
  };
};

const readAuthorityState = async (
  client: PoolClient,
  snapshot: PostgresAuthorityBrokerSnapshot,
  projection: ExecutionAccountProjection,
  now: string
): Promise<PostgresAuthorityState> => {
  const runtime = currentControlPlaneRuntimeContext();
  const accounts = await client.query<CountRow>(
    "SELECT COUNT(*) AS count FROM accounts WHERE environment = 'paper'"
  );
  const snapshots = await client.query<CountRow>(
    `SELECT COUNT(*) AS count FROM account_snapshots
     WHERE account_id = $1 AND snapshot_fingerprint = $2`,
    [projection.accountId, snapshot.portfolioFingerprint]
  );
  const positions = await client.query<PostgresPositionRow>(
    `SELECT broker_position_key, symbol, underlying_symbol, option_symbol,
            asset_class, side, status, quantity::text AS quantity,
            available_quantity::text AS available_quantity,
            average_entry_price::text AS average_entry_price,
            current_price::text AS current_price, market_value::text AS market_value,
            cost_basis::text AS cost_basis, unrealized_pnl::text AS unrealized_pnl
     FROM positions WHERE account_id = $1 AND status IN ('open', 'closing')
     ORDER BY broker_position_key`,
    [projection.accountId]
  );
  const orders = await client.query<PostgresOrderRow>(
    `SELECT broker_order_id, client_order_id, symbol, asset_class, side,
            order_type, time_in_force, status, quantity::text AS quantity,
            notional::text AS notional, limit_price::text AS limit_price
     FROM orders WHERE account_id = $1 AND btrim(status) <> ''
       AND NOT (lower(status) = ANY($2::text[]))
     ORDER BY broker_order_id NULLS LAST, client_order_id`,
    [projection.accountId, [...TERMINAL_ORDER_STATUSES]]
  );
  const externalOrderEvents = await client.query<ExternalBrokerOrderEventRow>(
    `SELECT DISTINCT ON (broker_order_id)
            broker_order_id, client_order_id, event_status, response_payload
     FROM broker_events
     WHERE account_id = $1 AND event_type = 'external_order_observed'
       AND broker_order_id = ANY($2::text[])
     ORDER BY broker_order_id, occurred_at DESC, event_id DESC`,
    [projection.accountId, snapshot.orders.map((order) => order.brokerOrderId)]
  );
  const currentOrders = [
    ...orders.rows,
    ...externalOrderEvents.rows.map((row) =>
      mapExternalBrokerOrderObservation(row as unknown as Record<string, unknown>)
    )
  ];
  const reservations = await client.query<CountRow>(
    "SELECT COUNT(*) AS count FROM buying_power_reservations WHERE account_id = $1 AND status = 'active' AND expires_at > $2",
    [projection.accountId, now]
  );
  const staleReservations = await client.query<CountRow>(
    "SELECT COUNT(*) AS count FROM buying_power_reservations WHERE account_id = $1 AND status = 'active' AND expires_at <= $2",
    [projection.accountId, now]
  );
  const allocations = await client.query<CountRow>(
    "SELECT COUNT(*) AS count FROM strategy_allocations WHERE account_id = $1 AND status = 'active' AND effective_to IS NULL",
    [projection.accountId]
  );
  const limits = await client.query<CountRow>(
    "SELECT COUNT(*) AS count FROM risk_limits WHERE account_id = $1 AND status = 'active' AND effective_to IS NULL AND scope_type = 'portfolio'",
    [projection.accountId]
  );
  const currentReviews = await client.query<CountRow>(
    "SELECT COUNT(*) AS count FROM execution_reviews WHERE account_id = $1 AND status IN ('created', 'valid') AND expires_at > $2",
    [projection.accountId, now]
  );
  const staleReviews = await client.query<CountRow>(
    "SELECT COUNT(*) AS count FROM execution_reviews WHERE account_id = $1 AND status IN ('created', 'valid') AND expires_at <= $2",
    [projection.accountId, now]
  );
  const currentConfirmations = await client.query<CountRow>(
    "SELECT COUNT(*) AS count FROM confirmation_evidence WHERE account_id = $1 AND status = 'valid' AND expires_at > $2",
    [projection.accountId, now]
  );
  const staleConfirmations = await client.query<CountRow>(
    "SELECT COUNT(*) AS count FROM confirmation_evidence WHERE account_id = $1 AND status = 'valid' AND expires_at <= $2",
    [projection.accountId, now]
  );
  const linkDiscrepancies = await client.query<CountRow>(
    `SELECT COUNT(*) AS count FROM (
       SELECT review.id
       FROM execution_reviews AS review
       LEFT JOIN confirmation_evidence AS confirmation
         ON confirmation.execution_review_id = review.id
        AND confirmation.account_id = review.account_id
        AND confirmation.status = 'valid' AND confirmation.expires_at > $2
       WHERE review.account_id = $1
         AND review.status IN ('created', 'valid') AND review.expires_at > $2
       GROUP BY review.id HAVING COUNT(confirmation.id) <> 1
       UNION ALL
       SELECT confirmation.id
       FROM confirmation_evidence AS confirmation
       LEFT JOIN execution_reviews AS review
         ON review.id = confirmation.execution_review_id
        AND review.account_id = confirmation.account_id
        AND review.status IN ('created', 'valid') AND review.expires_at > $2
       WHERE confirmation.account_id = $1
         AND confirmation.status = 'valid' AND confirmation.expires_at > $2
         AND review.id IS NULL
     ) AS discrepancies`,
    [projection.accountId, now]
  );
  const historicalReviews = await client.query<CountRow>(
    "SELECT COUNT(*) AS count FROM execution_reviews WHERE account_id = $1",
    [projection.accountId]
  );
  const historicalConfirmations = await client.query<CountRow>(
    "SELECT COUNT(*) AS count FROM confirmation_evidence WHERE account_id = $1",
    [projection.accountId]
  );
  const candidates = await client.query<CountRow>(
    `WITH latest_research AS (
       SELECT id FROM research_runs WHERE status = 'completed'
       ORDER BY completed_at DESC, id DESC LIMIT 1
     )
     SELECT COUNT(*) AS count
     FROM candidates candidate
     JOIN latest_research research ON research.id = candidate.research_run_id
     WHERE candidate.decision = 'selected'
       AND candidate.lifecycle_status NOT IN ('closed', 'expired', 'rejected', 'skipped', 'blocked')`
  );
  const learning = await client.query<CountRow>(
    `WITH latest_research AS (
       SELECT id FROM research_runs WHERE status = 'completed'
       ORDER BY completed_at DESC, id DESC LIMIT 1
     )
     SELECT COUNT(*) AS count
     FROM candidates candidate
     JOIN latest_research research ON research.id = candidate.research_run_id
     WHERE candidate.decision = 'selected'
       AND candidate.lifecycle_status NOT IN ('closed', 'expired', 'rejected', 'skipped', 'blocked')
       AND (
         candidate.recent_learning_adjustment IS NOT NULL OR
         (
           candidate.signal_inputs->>'learningAdjustmentStatus' =
             'not_applicable_no_postgres_learning_model'
           AND candidate.signal_inputs#>>'{learningModelCapability,authority}' = 'postgres'
           AND candidate.signal_inputs#>>'{learningModelCapability,relation}' =
             'public.learning_runs'
           AND candidate.signal_inputs#>>'{learningModelCapability,status}' = 'absent'
         )
       )`
  );
  const recoveredResearch = await client.query<CountRow>(
    "SELECT COUNT(*) AS count FROM research_runs WHERE recovered_at IS NOT NULL OR status = 'recovered'"
  );
  const staleResearch = await client.query<CountRow>(
    `SELECT COUNT(*) AS count FROM research_runs
     WHERE status IN ('reserved', 'running')
       AND COALESCE(heartbeat_at, started_at) <= $1::timestamptz - interval '15 minutes'`,
    [now]
  );
  const retryableFailures = await client.query<CountRow>(
    "SELECT COUNT(*) AS count FROM workstream_event_failures WHERE retryable AND dead_lettered_at IS NULL"
  );
  const heldLeases = await client.query<CountRow>(
    `SELECT COUNT(*) AS count FROM scheduler_leases
     WHERE status = 'held' AND expires_at > $1
       AND ($2::text IS NULL OR job_name <> $2)`,
    [now, runtime?.fence.jobName ?? null]
  );

  return {
    accountCount: count(accounts.rows[0]),
    currentSnapshotCount: count(snapshots.rows[0]),
    brokerPositionCount: snapshot.positions.length,
    postgresPositionCount: positions.rows.length,
    positionDiscrepancyCount: countPositionDiscrepancies(snapshot.positions, positions.rows),
    brokerOpenOrderCount: snapshot.orders.length,
    postgresOpenOrderCount: currentOrders.length,
    orderDiscrepancyCount: countOrderDiscrepancies(snapshot.orders, currentOrders),
    activeReservationCount: count(reservations.rows[0]),
    staleActiveReservationCount: count(staleReservations.rows[0]),
    activeStrategyAllocationCount: count(allocations.rows[0]),
    activeRiskLimitCount: count(limits.rows[0]),
    currentReviewCount: count(currentReviews.rows[0]),
    staleReviewCount: count(staleReviews.rows[0]),
    currentConfirmationCount: count(currentConfirmations.rows[0]),
    staleConfirmationCount: count(staleConfirmations.rows[0]),
    reviewConfirmationLinkDiscrepancyCount: count(linkDiscrepancies.rows[0]),
    historicalReviewCount: count(historicalReviews.rows[0]),
    historicalConfirmationCount: count(historicalConfirmations.rows[0]),
    candidateCount: count(candidates.rows[0]),
    candidateLearningStateCount: count(learning.rows[0]),
    recoveredResearchRunCount: count(recoveredResearch.rows[0]),
    staleResearchRunCount: count(staleResearch.rows[0]),
    retryableFailureCount: count(retryableFailures.rows[0]),
    unexpectedHeldLeaseCount: count(heldLeases.rows[0])
  };
};

const passedSourceAggregates = (
  snapshot: PostgresAuthorityBrokerSnapshot,
  state: PostgresAuthorityState
) => ({
  ...initialCheckpointMetadata(snapshot.capturedAt),
  accountCount: state.accountCount,
  openPositionCount: state.brokerPositionCount,
  openOrderCount: state.brokerOpenOrderCount,
  structuralPortfolioFingerprint: snapshot.structuralPortfolioFingerprint,
  portfolioFingerprint: snapshot.portfolioFingerprint,
  paperOnly: true,
  brokerMutationAttempted: false,
  ordersSubmitted: 0
});

const finalizePassedCheckpoint = async (
  client: PoolClient,
  input: {
    checkpointId: string;
    completedAt: string;
    snapshot: PostgresAuthorityBrokerSnapshot;
    state: PostgresAuthorityState;
    cleanup: PostgresAuthorityCleanup;
  }
) => {
  const result = await client.query(
    `UPDATE reconciliation_checkpoints
     SET status = 'passed', source_checksum = $2,
         source_row_count = $3, target_row_count = $4,
         discrepancy_count = 0, source_aggregates = $5::jsonb,
         target_aggregates = $6::jsonb,
         discrepancy_report = $7::jsonb, completed_at = $8,
         version = version + 1, updated_at = $8
     WHERE id = $1 AND workstream = $9 AND status = 'running'`,
    [
      input.checkpointId,
      input.snapshot.portfolioFingerprint,
      input.state.brokerPositionCount + input.state.brokerOpenOrderCount + 1,
      input.state.postgresPositionCount + input.state.postgresOpenOrderCount + 1,
      JSON.stringify(passedSourceAggregates(input.snapshot, input.state)),
      JSON.stringify({
        ...input.state,
        cleanup: input.cleanup,
        mappingVersion: POSTGRES_AUTHORITY_MAPPING_VERSION
      }),
      JSON.stringify({ discrepancyCodes: [] }),
      input.completedAt,
      POSTGRES_AUTHORITY_WORKSTREAM
    ]
  );
  if (result.rowCount !== 1) throw new Error("POSTGRES_AUTHORITY_CHECKPOINT_FINALIZE_FAILED");
};

const finalizeBlockedCheckpoint = async (input: {
  pool: Pool;
  config: DatabaseConfig;
  checkpointId: string;
  completedAt: string;
  errorCode: string;
  terminalState?: CutoverTerminalState;
}) => withPostgresTransaction(input.pool, input.config, async (client) => {
  await assertCurrentFence(client);
  const discrepancies = input.terminalState?.discrepancies ?? [input.errorCode];
  const result = await client.query(
    `UPDATE reconciliation_checkpoints
     SET status = 'blocked', discrepancy_count = $2,
         target_aggregates = $3::jsonb, discrepancy_report = $4::jsonb,
         completed_at = $5, version = version + 1, updated_at = $5
     WHERE id = $1 AND workstream = $6 AND status = 'running'`,
    [
      input.checkpointId,
      discrepancies.length,
      JSON.stringify(input.terminalState
        ? { ...input.terminalState.state, cleanup: input.terminalState.cleanup }
        : {}),
      JSON.stringify({ errorCode: input.errorCode, discrepancyCodes: discrepancies }),
      input.completedAt,
      POSTGRES_AUTHORITY_WORKSTREAM
    ]
  );
  if (result.rowCount !== 1) throw new Error("POSTGRES_AUTHORITY_CHECKPOINT_BLOCK_FAILED");
});

export const runPostgresAuthorityCutover = async () => {
  const runtime = currentControlPlaneRuntimeContext();
  if (!runtime) throw new Error("POSTGRES_AUTHORITY_RUNTIME_CONTEXT_REQUIRED");
  assertPostgresOnlyDatabaseAuthority(runtime.config);
  const capturedAt = new Date().toISOString();
  const checkpointId = `postgres-authority-cutover-${capturedAt.replace(/[-:.]/g, "")}-${canonicalJsonHash({
    capturedAt,
    operationId: runtime.operationId
  }).slice(0, 12)}`;
  await createRunningCheckpoint({
    pool: runtime.pool,
    config: runtime.config,
    checkpointId,
    capturedAt
  });

  try {
    const snapshot = await capturePostgresAuthorityBrokerSnapshot(capturedAt);
    const projection = mapBrokerSnapshotToExecutionProjection(snapshot);
    const completed = await withPostgresTransaction(
      runtime.pool,
      runtime.config,
      async (client) => {
        const fencedRuntime = await assertCurrentFence(client);
        await assertExistingPolicyMatches(client, projection);
        const cleanup = await cleanupStaleRuntimeState(client, capturedAt);
        const repository = new PostgresExecutionStateRepository();
        const projectionResult = await repository.syncAccountState(
          projection,
          postgresRepositoryContext(fencedRuntime, client)
        );
        if (projectionResult.status !== "synced") {
          throw new Error("POSTGRES_AUTHORITY_PROJECTION_FAILED");
        }
        const state = await readAuthorityState(client, snapshot, projection, capturedAt);
        const evaluated = evaluatePostgresAuthorityState(state);
        if (evaluated.status !== "passed") {
          throw new PostgresAuthorityValidationError({
            state,
            cleanup,
            discrepancies: evaluated.discrepancies
          });
        }
        const completedAt = new Date().toISOString();
        await finalizePassedCheckpoint(client, {
          checkpointId,
          completedAt,
          snapshot,
          state,
          cleanup
        });
        return { state, cleanup, completedAt };
      },
      { isolationLevel: "serializable" }
    );
    return {
      operation: "postgres_authority_cutover",
      status: "passed" as const,
      checkpointId,
      baselineType: POSTGRES_AUTHORITY_BASELINE_TYPE,
      historicalSqliteReconciliation: false,
      historicalReconciliationAttempted: false,
      historicalReconciliationComplete: false,
      capturedAt,
      completedAt: completed.completedAt,
      currentState: completed.state,
      cleanup: completed.cleanup,
      discrepancies: [],
      brokerMutationAttempted: false,
      ordersSubmitted: 0
    };
  } catch (error) {
    const terminalState = error instanceof PostgresAuthorityValidationError
      ? error.terminalState
      : undefined;
    const errorCode = safeErrorCode(error);
    await finalizeBlockedCheckpoint({
      pool: runtime.pool,
      config: runtime.config,
      checkpointId,
      completedAt: new Date().toISOString(),
      errorCode,
      ...(terminalState ? { terminalState } : {})
    });
    if (!terminalState) throw error;
    return {
      operation: "postgres_authority_cutover",
      status: "blocked" as const,
      checkpointId,
      baselineType: POSTGRES_AUTHORITY_BASELINE_TYPE,
      historicalSqliteReconciliation: false,
      historicalReconciliationAttempted: false,
      historicalReconciliationComplete: false,
      capturedAt,
      currentState: terminalState.state,
      cleanup: terminalState.cleanup,
      discrepancies: terminalState.discrepancies,
      brokerMutationAttempted: false,
      ordersSubmitted: 0
    };
  }
};

export const readPostgresAuthorityStatus = async (pool: Pool) => {
  const [checkpoint, activeLeases] = await Promise.all([
    pool.query<{
      id: string;
      status: string;
      discrepancy_count: number | string;
      cursor_value: Record<string, unknown>;
      source_aggregates: Record<string, unknown>;
      target_aggregates: Record<string, unknown>;
      discrepancy_report: Record<string, unknown> | null;
      completed_at: Date | string | null;
    }>(
      `SELECT id, status, discrepancy_count, cursor_value,
              source_aggregates, target_aggregates, discrepancy_report, completed_at
       FROM reconciliation_checkpoints
       WHERE workstream = $1
       ORDER BY created_at DESC LIMIT 1`,
      [POSTGRES_AUTHORITY_WORKSTREAM]
    ),
    pool.query<CountRow>(
      "SELECT COUNT(*) AS count FROM scheduler_leases WHERE status = 'held' AND expires_at > now()"
    )
  ]);
  const latest = checkpoint.rows[0] ?? null;
  return {
    authority: "postgres",
    sqliteRuntimeRole: "none",
    latestCheckpoint: latest
      ? {
          id: latest.id,
          status: latest.status,
          discrepancyCount: Number(latest.discrepancy_count),
          baselineType: latest.cursor_value?.baselineType ?? null,
          historicalSqliteReconciliation:
            latest.cursor_value?.historicalSqliteReconciliation ?? null,
          historicalReconciliationAttempted:
            latest.cursor_value?.historicalReconciliationAttempted ?? null,
          historicalReconciliationComplete:
            latest.cursor_value?.historicalReconciliationComplete ?? null,
          authorityBasis: latest.cursor_value?.authorityBasis ?? null,
          completedAt: latest.completed_at
            ? new Date(latest.completed_at).toISOString()
            : null,
          sourceAggregates: latest.source_aggregates,
          targetAggregates: latest.target_aggregates,
          discrepancyReport: latest.discrepancy_report
        }
      : null,
    activeSchedulerLeaseCount: count(activeLeases.rows[0])
  };
};
