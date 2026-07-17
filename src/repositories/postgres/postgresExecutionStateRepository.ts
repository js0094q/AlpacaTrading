import type { PoolClient } from "pg";

import type {
  BrokerReconciliationTarget,
  BrokerResultInput,
  ExecutionAccountProjection,
  ExecutionEvidenceInput,
  ExecutionReservationIntentInput,
  ExecutionStateRepository
} from "../contracts/executionStateRepository.js";
import { canonicalJson, requireCurrentFence, type FencedPostgresRepositoryContext } from "./postgresRepositorySupport.js";

const reservationBlockers = (row: Record<string, unknown>) => [
  !row.buying_power_allowed ? "BUYING_POWER_LIMIT_EXCEEDED" : null,
  !row.deployment_allowed ? "DEPLOYMENT_LIMIT_EXCEEDED" : null,
  !row.strategy_allowed ? "STRATEGY_ALLOCATION_LIMIT_EXCEEDED" : null,
  !row.symbol_allowed ? "SYMBOL_EXPOSURE_LIMIT_EXCEEDED" : null,
  !row.position_count_allowed ? "POSITION_COUNT_LIMIT_EXCEEDED" : null,
  !row.order_count_allowed ? "ORDER_COUNT_LIMIT_EXCEEDED" : null
].filter((value): value is string => value !== null);

const orderIntentStatus = (status: string) => {
  const normalized = status.trim().toLowerCase();
  if (normalized === "filled") return "reconciled";
  if (["new", "accepted", "pending_new", "partially_filled"].includes(normalized)) {
    return "submitted";
  }
  if (["ambiguous", "timeout", "unknown"].includes(normalized)) return "ambiguous";
  if (["cancelled", "canceled", "expired"].includes(normalized)) return "cancelled";
  return "failed";
};

export class PostgresExecutionStateRepository
implements ExecutionStateRepository<PoolClient> {
  async findCurrentAccount(context: { transaction: PoolClient }) {
    const result = await context.transaction.query<{
      account_id: string;
      account_snapshot_id: string;
      strategy_key: string;
    }>(
      `SELECT accounts.id AS account_id,
              latest.id AS account_snapshot_id
       FROM accounts
       JOIN LATERAL (
         SELECT id FROM account_snapshots
         WHERE account_id = accounts.id
         ORDER BY observed_at DESC, id DESC
         LIMIT 1
       ) latest ON true
       JOIN LATERAL (
         SELECT strategy_key
         FROM strategy_allocations
         WHERE account_id = accounts.id
           AND status = 'active' AND effective_to IS NULL
         ORDER BY updated_at DESC, id DESC
         LIMIT 1
       ) allocation ON true
       WHERE accounts.environment = 'paper'
       ORDER BY accounts.updated_at DESC, accounts.id
       LIMIT 1`
    );
    return result.rows[0]
      ? {
          accountId: result.rows[0].account_id,
          accountSnapshotId: result.rows[0].account_snapshot_id,
          strategyKey: result.rows[0].strategy_key
        }
      : null;
  }

  async listActiveReservations(context: { transaction: PoolClient }) {
    const result = await context.transaction.query<{
      symbol: string;
      asset_class: "equity" | "option";
      side: "buy" | "sell" | "buy_to_open" | "sell_to_close";
      status: string;
      quantity: string | null;
      notional: string | null;
      estimated_premium: string | null;
      limit_price: string | null;
      client_order_id: string;
    }>(
      `SELECT reservation.symbol,
              reservation.asset_class,
              intent.side,
              reservation.status,
              intent.quantity::text AS quantity,
              intent.notional::text AS notional,
              intent.estimated_premium::text AS estimated_premium,
              intent.limit_price::text AS limit_price,
              intent.client_order_id
       FROM buying_power_reservations reservation
       JOIN order_intents intent ON intent.reservation_id = reservation.id
       WHERE reservation.status = 'active'
         AND reservation.expires_at > now()
       ORDER BY reservation.symbol, intent.client_order_id`
    );
    return result.rows.map((row) => ({
      symbol: row.symbol,
      assetClass: row.asset_class,
      side: row.side,
      status: row.status,
      quantity: row.quantity,
      notional: row.notional,
      estimatedPremium: row.estimated_premium,
      limitPrice: row.limit_price,
      clientOrderId: row.client_order_id
    }));
  }

  async listZeroDteActivityState(
    input: { readonly tradingDate: string },
    context: FencedPostgresRepositoryContext
  ) {
    const fence = await requireCurrentFence(context);
    if (!fence.accepted) {
      return {
        status: "fence_rejected" as const,
        currentFencingToken: fence.currentFencingToken
      };
    }
    const orders = await context.transaction.query<{
      id: string;
      created_at: Date | string;
      asset_class: string;
      symbol: string;
      side: string | null;
      status: string;
      quantity: string | null;
      limit_price: string | null;
      estimated_premium: string | null;
      client_order_id: string | null;
      broker_order_id: string | null;
      filled_quantity: string;
      filled_average_price: string | null;
    }>(
      `SELECT order_state.id, order_state.created_at, order_state.asset_class,
              order_state.symbol, order_state.side, order_state.status,
              order_state.quantity::text AS quantity,
              order_state.limit_price::text AS limit_price,
              intent.estimated_premium::text AS estimated_premium,
              order_state.client_order_id, order_state.broker_order_id,
              order_state.filled_quantity::text AS filled_quantity,
              order_state.filled_average_price::text AS filled_average_price
       FROM orders order_state
       JOIN order_intents intent ON intent.id = order_state.order_intent_id
       WHERE order_state.asset_class = 'option'
         AND (
           order_state.created_at >= ($1::date - interval '1 day')
           OR order_state.status IN (
             'new', 'accepted', 'pending_new', 'partially_filled', 'held'
           )
         )
       ORDER BY order_state.created_at, order_state.id`,
      [input.tradingDate]
    );
    const positions = await context.transaction.query<{
      id: string;
      option_symbol: string;
      status: string;
      broker_entry_order_id: string | null;
      entry_client_order_id: string | null;
      opened_at: Date | string;
      closed_at: Date | string | null;
      entry_quantity: string | null;
      entry_price: string | null;
      realized_pnl: string | null;
    }>(
      `SELECT position_state.id,
              COALESCE(position_state.option_symbol, position_state.symbol) AS option_symbol,
              position_state.status,
              opening_order.broker_order_id AS broker_entry_order_id,
              opening_order.client_order_id AS entry_client_order_id,
              position_state.opened_at,
              position_state.closed_at,
              position_state.quantity::text AS entry_quantity,
              position_state.average_entry_price::text AS entry_price,
              position_state.realized_pnl::text AS realized_pnl
       FROM positions position_state
       LEFT JOIN orders opening_order ON opening_order.id = position_state.opening_order_id
       WHERE position_state.asset_class = 'option'
         AND (
           position_state.status IN ('open', 'closing')
           OR position_state.opened_at >= ($1::date - interval '1 day')
           OR position_state.closed_at >= ($1::date - interval '1 day')
         )
       ORDER BY position_state.opened_at, position_state.id`,
      [input.tradingDate]
    );
    return {
      status: "listed" as const,
      ledger: orders.rows.map((row) => ({
        id: row.id,
        createdAt: new Date(row.created_at).toISOString(),
        assetClass: row.asset_class,
        symbol: row.symbol,
        side: row.side,
        status: row.status,
        quantity: row.quantity,
        limitPrice: row.limit_price,
        estimatedPremium: row.estimated_premium,
        clientOrderId: row.client_order_id,
        brokerOrderId: row.broker_order_id,
        rawResponse: {
          status: row.status,
          filled_qty: row.filled_quantity,
          filled_avg_price: row.filled_average_price
        }
      })),
      positions: positions.rows.map((row) => ({
        positionLifecycleId: row.id,
        optionSymbol: row.option_symbol,
        status: row.status,
        brokerEntryOrderId: row.broker_entry_order_id,
        entryClientOrderId: row.entry_client_order_id,
        openedAt: new Date(row.opened_at).toISOString(),
        closedAt: row.closed_at === null ? null : new Date(row.closed_at).toISOString(),
        entryQuantity: row.entry_quantity,
        entryPrice: row.entry_price,
        realizedPnl: row.realized_pnl,
        outcomeCompletenessStatus: row.realized_pnl === null ? null : "complete",
        latestOutcomeRevisionJson: null
      }))
    };
  }

  async listBrokerReconciliationTargets(
    context: FencedPostgresRepositoryContext
  ) {
    const fence = await requireCurrentFence(context);
    if (!fence.accepted) {
      return {
        status: "fence_rejected" as const,
        currentFencingToken: fence.currentFencingToken
      };
    }
    const result = await context.transaction.query<{
      order_intent_id: string;
      order_id: string | null;
      account_id: string;
      client_order_id: string;
      broker_order_id: string | null;
      broker_client_order_id: string | null;
      symbol: string;
      underlying_symbol: string | null;
      asset_class: BrokerReconciliationTarget["assetClass"];
      side: BrokerReconciliationTarget["side"];
      order_type: BrokerReconciliationTarget["orderType"];
      time_in_force: BrokerReconciliationTarget["timeInForce"];
      quantity: string | null;
      notional: string | null;
      limit_price: string | null;
      stop_price: string | null;
      broker_quantity: string | null;
      broker_notional: string | null;
      broker_limit_price: string | null;
      broker_stop_price: string | null;
      intent_status: string;
      created_at: Date | string;
    }>(
      `SELECT intent.id AS order_intent_id,
              broker_order.id AS order_id,
              intent.account_id,
              intent.client_order_id,
              broker_order.broker_order_id,
              broker_order.client_order_id AS broker_client_order_id,
              intent.symbol,
              intent.underlying_symbol,
              intent.asset_class,
              intent.side,
              intent.order_type,
              intent.time_in_force,
              intent.quantity::text AS quantity,
              intent.notional::text AS notional,
              intent.limit_price::text AS limit_price,
              intent.stop_price::text AS stop_price,
              broker_order.quantity::text AS broker_quantity,
              broker_order.notional::text AS broker_notional,
              broker_order.limit_price::text AS broker_limit_price,
              broker_order.stop_price::text AS broker_stop_price,
              intent.status AS intent_status,
              intent.created_at
       FROM order_intents intent
       LEFT JOIN LATERAL (
         SELECT * FROM orders
         WHERE order_intent_id = intent.id AND replacement_order_id IS NULL
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) broker_order ON true
       WHERE intent.status IN ('ready_for_submission', 'submission_pending', 'submitted', 'ambiguous')
       ORDER BY intent.created_at, intent.id
       FOR UPDATE OF intent`
    );
    return {
      status: "listed" as const,
      targets: result.rows.map((row) => ({
        orderIntentId: row.order_intent_id,
        orderId: row.order_id,
        accountId: row.account_id,
        clientOrderId: row.client_order_id,
        brokerOrderId: row.broker_order_id,
        brokerClientOrderId: row.broker_client_order_id ?? row.client_order_id,
        symbol: row.symbol,
        underlyingSymbol: row.underlying_symbol,
        assetClass: row.asset_class,
        side: row.side,
        orderType: row.order_type,
        timeInForce: row.time_in_force,
        quantity: row.quantity,
        notional: row.notional,
        limitPrice: row.limit_price,
        stopPrice: row.stop_price,
        brokerQuantity: row.broker_quantity ?? row.quantity,
        brokerNotional: row.broker_notional ?? row.notional,
        brokerLimitPrice: row.broker_limit_price ?? row.limit_price,
        brokerStopPrice: row.broker_stop_price ?? row.stop_price,
        intentStatus: row.intent_status,
        createdAt: new Date(row.created_at).toISOString()
      }))
    };
  }

  async authorizeBrokerMutation(
    input: {
      readonly accountId: string;
      readonly orderIntentId: string;
      readonly clientOrderId: string;
      readonly brokerOrderId: string;
      readonly mutation: "replace" | "cancel";
    },
    context: FencedPostgresRepositoryContext
  ) {
    const fence = await requireCurrentFence(context);
    if (!fence.accepted) {
      return {
        status: "fence_rejected" as const,
        currentFencingToken: fence.currentFencingToken
      };
    }
    const intent = await context.transaction.query<{ status: string }>(
      `SELECT status
       FROM order_intents
       WHERE id = $1 AND account_id = $2 AND client_order_id = $3
       FOR UPDATE`,
      [input.orderIntentId, input.accountId, input.clientOrderId]
    );
    if (!intent.rows[0]) throw new Error("POSTGRES_EXECUTION_ORDER_INTENT_NOT_FOUND");
    if (intent.rows[0].status !== "submitted") {
      return {
        status: "blocked" as const,
        blockers: ["EXECUTION_BROKER_MUTATION_INTENT_NOT_ACTIVE"]
      };
    }
    const order = await context.transaction.query<{
      broker_order_id: string | null;
      status: string;
    }>(
      `SELECT broker_order_id, status
       FROM orders
       WHERE order_intent_id = $1 AND replacement_order_id IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT 1
       FOR UPDATE`,
      [input.orderIntentId]
    );
    const current = order.rows[0];
    if (!current || current.broker_order_id !== input.brokerOrderId) {
      throw new Error("POSTGRES_EXECUTION_BROKER_MUTATION_IDENTITY_MISMATCH");
    }
    const activeStatuses = new Set(["new", "accepted", "partially_filled", "held"]);
    if (!activeStatuses.has(current.status.trim().toLowerCase())) {
      return {
        status: "blocked" as const,
        blockers: ["EXECUTION_BROKER_MUTATION_ORDER_NOT_ACTIVE"]
      };
    }
    return { status: "authorized" as const };
  }

  async syncAccountState(
    input: ExecutionAccountProjection,
    context: FencedPostgresRepositoryContext
  ) {
    const fence = await requireCurrentFence(context);
    if (!fence.accepted) {
      return {
        status: "fence_rejected" as const,
        currentFencingToken: fence.currentFencingToken
      };
    }
    await context.transaction.query(
      `INSERT INTO accounts(
         id, broker_account_id, environment, status, currency, created_at, updated_at
       ) VALUES ($1, $2, 'paper', $3, $4, $5, $5)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         currency = EXCLUDED.currency,
         version = accounts.version + 1,
         updated_at = EXCLUDED.updated_at`,
      [
        input.accountId,
        input.brokerAccountId,
        input.accountStatus,
        input.currency,
        input.observedAt
      ]
    );
    const snapshotInsert = await context.transaction.query<{ id: string }>(
      `INSERT INTO account_snapshots(
         id, account_id, observed_at, account_status, currency, cash,
         portfolio_value, equity, buying_power, options_buying_power,
         options_approved_level, trading_blocked, account_blocked,
         snapshot_fingerprint, evidence, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15::jsonb, $3
       ) ON CONFLICT (account_id, snapshot_fingerprint) DO NOTHING
       RETURNING id`,
      [
        input.accountSnapshotId,
        input.accountId,
        input.observedAt,
        input.accountStatus,
        input.currency,
        input.cash,
        input.portfolioValue,
        input.equity,
        input.buyingPower,
        input.optionsBuyingPower,
        input.optionsApprovedLevel,
        input.tradingBlocked,
        input.accountBlocked,
        input.snapshotFingerprint,
        canonicalJson(input.evidence)
      ]
    );
    const accountSnapshotId = snapshotInsert.rows[0]?.id ?? (
      await context.transaction.query<{ id: string }>(
        `SELECT id
         FROM account_snapshots
         WHERE account_id = $1 AND snapshot_fingerprint = $2
         LIMIT 1`,
        [input.accountId, input.snapshotFingerprint]
      )
    ).rows[0]?.id;
    if (!accountSnapshotId) {
      throw new Error("POSTGRES_EXECUTION_ACCOUNT_SNAPSHOT_NOT_FOUND");
    }
    const activeKeys = input.positions.map((position) => position.brokerPositionKey);
    await context.transaction.query(
      `UPDATE positions
       SET status = 'closed', quantity = 0, available_quantity = 0,
           closed_at = $2, last_reconciled_at = $2,
           version = version + 1, updated_at = $2
       WHERE account_id = $1
         AND status IN ('open', 'closing')
         AND NOT (broker_position_key = ANY($3::text[]))`,
      [input.accountId, input.observedAt, activeKeys]
    );
    for (const position of input.positions) {
      await context.transaction.query(
        `INSERT INTO positions(
           id, account_id, candidate_id, opening_order_id, closing_order_id,
           broker_position_key, symbol, underlying_symbol, option_symbol,
           asset_class, side, status, quantity, available_quantity,
           average_entry_price, current_price, market_value, cost_basis,
           unrealized_pnl, realized_pnl, source_account_snapshot_id,
           opened_at, last_reconciled_at, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'open', $12,
           $13, $14, $15, $16, $17, $18, $19, $20, $21, $21, $21, $21
         ) ON CONFLICT (account_id, broker_position_key) DO UPDATE SET
           candidate_id = COALESCE(EXCLUDED.candidate_id, positions.candidate_id),
           opening_order_id = COALESCE(EXCLUDED.opening_order_id, positions.opening_order_id),
           closing_order_id = EXCLUDED.closing_order_id,
           symbol = EXCLUDED.symbol,
           underlying_symbol = EXCLUDED.underlying_symbol,
           option_symbol = EXCLUDED.option_symbol,
           asset_class = EXCLUDED.asset_class,
           side = EXCLUDED.side,
           status = 'open',
           quantity = EXCLUDED.quantity,
           available_quantity = EXCLUDED.available_quantity,
           average_entry_price = COALESCE(EXCLUDED.average_entry_price, positions.average_entry_price),
           current_price = EXCLUDED.current_price,
           market_value = EXCLUDED.market_value,
           cost_basis = EXCLUDED.cost_basis,
           unrealized_pnl = EXCLUDED.unrealized_pnl,
           realized_pnl = EXCLUDED.realized_pnl,
           source_account_snapshot_id = EXCLUDED.source_account_snapshot_id,
           closed_at = NULL,
           last_reconciled_at = EXCLUDED.last_reconciled_at,
           version = positions.version + 1,
           updated_at = EXCLUDED.updated_at`,
        [
          position.id,
          input.accountId,
          position.candidateId,
          position.openingOrderId,
          position.closingOrderId,
          position.brokerPositionKey,
          position.symbol,
          position.underlyingSymbol,
          position.optionSymbol,
          position.assetClass,
          position.side,
          position.quantity,
          position.availableQuantity,
          position.averageEntryPrice,
          position.currentPrice,
          position.marketValue,
          position.costBasis,
          position.unrealizedPnl,
          position.realizedPnl,
          accountSnapshotId,
          position.openedAt
        ]
      );
    }
    await context.transaction.query(
      `UPDATE risk_limits
       SET status = 'superseded', effective_to = $2,
           version = version + 1, updated_at = $2
       WHERE account_id = $1 AND scope_type = 'portfolio'
         AND scope_key = 'portfolio' AND status = 'active'
         AND effective_to IS NULL AND config_fingerprint <> $3`,
      [input.accountId, input.observedAt, input.riskLimit.configFingerprint]
    );
    await context.transaction.query(
      `INSERT INTO risk_limits(
         id, account_id, scope_type, scope_key, status, currency,
         cash_reserve_amount, cash_reserve_ratio, max_deployment_amount,
         max_deployment_ratio, max_gross_exposure, max_net_exposure,
         max_open_order_exposure, max_position_notional, max_symbol_notional,
         max_position_count, max_order_count, config_version,
         config_fingerprint, effective_from, created_at, updated_at
       ) VALUES (
         $1, $2, 'portfolio', 'portfolio', 'active', $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17, $17
       ) ON CONFLICT (id) DO NOTHING`,
      [
        input.riskLimit.id,
        input.accountId,
        input.currency,
        input.riskLimit.cashReserveAmount,
        input.riskLimit.cashReserveRatio,
        input.riskLimit.maxDeploymentAmount,
        input.riskLimit.maxDeploymentRatio,
        input.riskLimit.maxGrossExposure,
        input.riskLimit.maxNetExposure,
        input.riskLimit.maxOpenOrderExposure,
        input.riskLimit.maxPositionNotional,
        input.riskLimit.maxSymbolNotional,
        input.riskLimit.maxPositionCount,
        input.riskLimit.maxOrderCount,
        input.riskLimit.configVersion,
        input.riskLimit.configFingerprint,
        input.observedAt
      ]
    );
    await context.transaction.query(
      `UPDATE strategy_allocations
       SET status = 'superseded', effective_to = $3,
           version = version + 1, updated_at = $3
       WHERE account_id = $1 AND strategy_key = $2
         AND status = 'active' AND effective_to IS NULL
         AND config_fingerprint <> $4`,
      [
        input.accountId,
        input.strategyAllocation.strategyKey,
        input.observedAt,
        input.strategyAllocation.configFingerprint
      ]
    );
    await context.transaction.query(
      `INSERT INTO strategy_allocations(
         id, account_id, strategy_key, status, currency, allocation_amount,
         allocation_ratio, reserved_amount, deployed_amount,
         config_version, config_fingerprint, effective_from,
         created_at, updated_at
       ) VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8, $9, $10, $11, $11, $11)
       ON CONFLICT (id) DO UPDATE SET
         reserved_amount = EXCLUDED.reserved_amount,
         deployed_amount = EXCLUDED.deployed_amount,
         version = strategy_allocations.version + 1,
         updated_at = EXCLUDED.updated_at`,
      [
        input.strategyAllocation.id,
        input.accountId,
        input.strategyAllocation.strategyKey,
        input.currency,
        input.strategyAllocation.allocationAmount,
        input.strategyAllocation.allocationRatio,
        input.exposure.activeReservationAmount,
        input.exposure.deployedAmount,
        input.strategyAllocation.configVersion,
        input.strategyAllocation.configFingerprint,
        input.observedAt
      ]
    );
    await context.transaction.query(
      `INSERT INTO portfolio_exposure(
         id, account_id, account_snapshot_id, scope_type, scope_key, currency,
         gross_exposure, net_exposure, long_exposure, short_exposure,
         open_order_exposure, active_reservation_amount, deployed_amount,
         cash_reserve_amount, available_buying_power, position_count,
         open_order_count, exposure_fingerprint, evidence, observed_at, created_at
       ) VALUES (
         $1, $2, $3, 'portfolio', 'portfolio', $4, $5, $6, $7, $8, $9,
         $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $18
       ) ON CONFLICT (account_id, exposure_fingerprint) DO NOTHING`,
      [
        input.exposure.id,
        input.accountId,
        accountSnapshotId,
        input.currency,
        input.exposure.grossExposure,
        input.exposure.netExposure,
        input.exposure.longExposure,
        input.exposure.shortExposure,
        input.exposure.openOrderExposure,
        input.exposure.activeReservationAmount,
        input.exposure.deployedAmount,
        input.exposure.cashReserveAmount,
        input.exposure.availableBuyingPower,
        input.exposure.positionCount,
        input.exposure.openOrderCount,
        input.exposure.fingerprint,
        canonicalJson(input.exposure.evidence),
        input.observedAt
      ]
    );
    return {
      status: "synced" as const,
      accountId: input.accountId,
      snapshotId: accountSnapshotId
    };
  }

  async reserveAndCreateOrderIntent(
    input: ExecutionReservationIntentInput,
    context: FencedPostgresRepositoryContext
  ) {
    const fence = await requireCurrentFence(context);
    if (!fence.accepted) {
      return {
        status: "fence_rejected" as const,
        currentFencingToken: fence.currentFencingToken
      };
    }
    const account = await context.transaction.query<{ id: string }>(
      "SELECT id FROM accounts WHERE id = $1 FOR UPDATE",
      [input.accountId]
    );
    if (!account.rows[0]) throw new Error("POSTGRES_EXECUTION_ACCOUNT_NOT_FOUND");
    const duplicateIntent = await context.transaction.query<{
      id: string;
      reservation_id: string | null;
      intent_fingerprint: string;
    }>(
      `SELECT id, reservation_id, intent_fingerprint
       FROM order_intents
       WHERE account_id = $1 AND idempotency_key = $2`,
      [input.accountId, input.idempotencyKey]
    );
    if (duplicateIntent.rows[0]) {
      if (
        duplicateIntent.rows[0].id !== input.orderIntentId ||
        duplicateIntent.rows[0].reservation_id !== input.reservationId ||
        duplicateIntent.rows[0].intent_fingerprint !== input.intentFingerprint
      ) {
        throw new Error("POSTGRES_EXECUTION_INTENT_REPLAY_CONFLICT");
      }
      return {
        status: "duplicate" as const,
        reservationId: input.reservationId,
        orderIntentId: input.orderIntentId
      };
    }
    let candidateId = input.candidateId;
    if (candidateId) {
      const candidate = await context.transaction.query<{ id: string }>(
        "SELECT id FROM candidates WHERE id = $1",
        [candidateId]
      );
      candidateId = candidate.rows[0]?.id ?? null;
    }
    if (input.reservationRequired && !input.reservationId) {
      throw new Error("POSTGRES_EXECUTION_RESERVATION_ID_REQUIRED");
    }
    if (!input.executionReviewId || !input.confirmationEvidenceId) {
      return {
        status: "blocked" as const,
        blockers: ["EXECUTION_CONFIRMATION_EVIDENCE_REQUIRED"]
      };
    }
    {
      const evidence = await context.transaction.query<{
        review_status: string;
        confirmation_status: string;
        review_expires_at: Date | string;
        confirmation_expires_at: Date | string;
      }>(
        `SELECT review.status AS review_status,
                confirmation.status AS confirmation_status,
                review.expires_at AS review_expires_at,
                confirmation.expires_at AS confirmation_expires_at
         FROM execution_reviews review
         JOIN confirmation_evidence confirmation
           ON confirmation.execution_review_id = review.id
          AND confirmation.id = $3
         WHERE review.id = $2 AND review.account_id = $1
           AND confirmation.account_id = $1
         FOR UPDATE OF review, confirmation`,
        [input.accountId, input.executionReviewId, input.confirmationEvidenceId]
      );
      const row = evidence.rows[0];
      if (
        !row ||
        !["created", "valid"].includes(row.review_status) ||
        row.confirmation_status !== "valid" ||
        Date.parse(String(row.review_expires_at)) <= Date.parse(input.createdAt) ||
        Date.parse(String(row.confirmation_expires_at)) <= Date.parse(input.createdAt)
      ) {
        return {
          status: "blocked" as const,
          blockers: ["EXECUTION_CONFIRMATION_EVIDENCE_INVALID"]
        };
      }
    }
    if (input.reservationRequired) {
      const limits = await context.transaction.query<Record<string, unknown>>(
      `WITH snapshot AS (
         SELECT buying_power, equity
         FROM account_snapshots
         WHERE id = $2 AND account_id = $1
       ), reservations AS (
         SELECT COALESCE(SUM(amount), 0) AS total,
                COALESCE(SUM(amount) FILTER (WHERE symbol = $4), 0) AS symbol_total
         FROM buying_power_reservations
         WHERE account_id = $1 AND status = 'active' AND expires_at > $5
       ), open_orders AS (
         SELECT COALESCE(SUM(COALESCE(notional, quantity * limit_price)), 0) AS total,
                COALESCE(SUM(COALESCE(notional, quantity * limit_price))
                  FILTER (WHERE symbol = $4), 0) AS symbol_total,
                COUNT(*) AS count
         FROM orders
         WHERE account_id = $1
           AND status IN ('new', 'accepted', 'pending_new', 'partially_filled', 'held', 'replaced')
       ), position_state AS (
         SELECT COALESCE(SUM(ABS(COALESCE(market_value, cost_basis, 0))), 0) AS total,
                COALESCE(SUM(ABS(COALESCE(market_value, cost_basis, 0)))
                  FILTER (WHERE symbol = $4), 0) AS symbol_total,
                COUNT(*) AS count
         FROM positions WHERE account_id = $1 AND status IN ('open', 'closing')
       ), limits AS (
         SELECT * FROM risk_limits
         WHERE account_id = $1 AND scope_type = 'portfolio'
           AND scope_key = 'portfolio' AND status = 'active' AND effective_to IS NULL
       ), allocation AS (
         SELECT * FROM strategy_allocations
         WHERE account_id = $1 AND strategy_key = $3
           AND status = 'active' AND effective_to IS NULL
         FOR UPDATE
       )
       SELECT
         COALESCE(snapshot.buying_power, 0) - reservations.total - open_orders.total
           - GREATEST(COALESCE(limits.cash_reserve_amount, 0),
                      COALESCE(snapshot.equity, 0) * COALESCE(limits.cash_reserve_ratio, 0))
           >= $6::numeric AS buying_power_allowed,
         (limits.max_deployment_amount IS NULL OR
            position_state.total + open_orders.total + reservations.total + $6::numeric
              <= limits.max_deployment_amount)
           AND (limits.max_deployment_ratio IS NULL OR
            position_state.total + open_orders.total + reservations.total + $6::numeric
              <= COALESCE(snapshot.equity, 0) * limits.max_deployment_ratio)
           AS deployment_allowed,
         (allocation.allocation_amount IS NULL OR
            allocation.deployed_amount + allocation.reserved_amount + $6::numeric
              <= allocation.allocation_amount)
           AND (allocation.allocation_ratio IS NULL OR
            allocation.deployed_amount + allocation.reserved_amount + $6::numeric
              <= COALESCE(snapshot.equity, 0) * allocation.allocation_ratio)
           AS strategy_allowed,
         limits.max_symbol_notional IS NULL OR
           position_state.symbol_total + open_orders.symbol_total +
             reservations.symbol_total + $6::numeric <= limits.max_symbol_notional
           AS symbol_allowed,
         limits.max_position_count IS NULL OR position_state.count < limits.max_position_count
           AS position_count_allowed,
         limits.max_order_count IS NULL OR open_orders.count < limits.max_order_count
           AS order_count_allowed
       FROM snapshot, reservations, open_orders, position_state, limits, allocation`,
      [
        input.accountId,
        input.accountSnapshotId,
        input.strategyKey,
        input.symbol,
        input.createdAt,
        input.amount
      ]
    );
      if (!limits.rows[0]) {
        return { status: "blocked" as const, blockers: ["EXECUTION_LIMIT_STATE_MISSING"] };
      }
      const blockers = reservationBlockers(limits.rows[0]);
      if (blockers.length) return { status: "blocked" as const, blockers };
    }

    {
      await context.transaction.query(
        `UPDATE execution_reviews
         SET status = 'consumed', consumed_at = $2,
             version = version + 1, updated_at = $2
         WHERE id = $1`,
        [input.executionReviewId, input.createdAt]
      );
      await context.transaction.query(
        `UPDATE confirmation_evidence
         SET status = 'consumed', consumed_at = $2,
             version = version + 1, updated_at = $2
         WHERE id = $1`,
        [input.confirmationEvidenceId, input.createdAt]
      );
    }
    if (input.reservationRequired) {
      await context.transaction.query(
      `INSERT INTO buying_power_reservations(
         id, account_id, candidate_id, strategy_key, symbol, asset_class,
         amount, status, idempotency_key, reservation_fingerprint,
         account_snapshot_id, scheduler_job_name, scheduler_fencing_token,
         expires_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10, $11, $12,
         $13, $14, $14
       ) RETURNING id`,
      [
        input.reservationId,
        input.accountId,
        candidateId,
        input.strategyKey,
        input.symbol,
        input.assetClass,
        input.amount,
        input.idempotencyKey,
        input.reservationFingerprint,
        input.accountSnapshotId,
        context.schedulerFence.jobName,
        context.schedulerFence.fencingToken,
        input.expiresAt,
        input.createdAt
      ]
    );
      await context.transaction.query(
      `UPDATE strategy_allocations
       SET reserved_amount = reserved_amount + $3::numeric,
           version = version + 1, updated_at = $4
       WHERE account_id = $1 AND strategy_key = $2
         AND status = 'active' AND effective_to IS NULL`,
      [input.accountId, input.strategyKey, input.amount, input.createdAt]
      );
    }
    await context.transaction.query(
      `INSERT INTO order_intents(
         id, account_id, candidate_id, reservation_id, execution_review_id,
         confirmation_evidence_id, environment, client_order_id,
         idempotency_key, strategy_key, symbol, underlying_symbol, asset_class,
         side, order_type, time_in_force, quantity, notional, limit_price,
         stop_price, estimated_premium, max_risk, status, intent_fingerprint,
         lifecycle_fingerprint, request_payload, request_id, correlation_id,
         ready_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'paper', $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17, $18, $19, $20, $21,
         'ready_for_submission', $22, $23, $24::jsonb, $25, $26, $27, $27, $27
       ) RETURNING id`,
      [
        input.orderIntentId,
        input.accountId,
        candidateId,
        input.reservationId,
        input.executionReviewId ?? null,
        input.confirmationEvidenceId ?? null,
        input.clientOrderId,
        input.idempotencyKey,
        input.strategyKey,
        input.symbol,
        input.underlyingSymbol ?? null,
        input.assetClass,
        input.side,
        input.orderType,
        input.timeInForce,
        input.quantity,
        input.notional,
        input.limitPrice,
        input.stopPrice,
        input.estimatedPremium,
        input.maxRisk,
        input.intentFingerprint,
        input.lifecycleFingerprint,
        canonicalJson(input.requestPayload),
        input.requestId,
        input.correlationId,
        input.createdAt
      ]
    );
    await context.transaction.query(
      `INSERT INTO lifecycle_fingerprints(
         id, account_id, candidate_id, order_intent_id, entity_type, entity_id,
         lifecycle_stage, fingerprint, payload_version, evidence, request_id,
         correlation_id, captured_at, created_at
       ) VALUES (
         $1, $2, $3, $4, 'order_intent', $4, 'ready_for_submission', $5, 1,
         $6::jsonb, $7, $8, $9, $9
       ) ON CONFLICT (entity_type, entity_id, lifecycle_stage, fingerprint) DO NOTHING`,
      [
        `${input.orderIntentId}:ready`,
        input.accountId,
        candidateId,
        input.orderIntentId,
        input.lifecycleFingerprint,
        canonicalJson({ intentFingerprint: input.intentFingerprint }),
        input.requestId,
        input.correlationId,
        input.createdAt
      ]
    );
    return {
      status: "authorized" as const,
      reservationId: input.reservationId,
      orderIntentId: input.orderIntentId
    };
  }

  async recordBrokerResult(
    input: BrokerResultInput,
    context: FencedPostgresRepositoryContext
  ) {
    const fence = await requireCurrentFence(context);
    if (!fence.accepted) {
      return {
        status: "fence_rejected" as const,
        currentFencingToken: fence.currentFencingToken
      };
    }
    const intent = await context.transaction.query<{
      id: string;
      account_id: string;
      reservation_id: string | null;
      candidate_id: string | null;
      status: string;
      identity_matches: boolean;
    }>(
      `SELECT id, account_id, reservation_id, candidate_id, status,
              client_order_id = $2
                AND symbol = $3
                AND asset_class = $4
                AND side = $5
                AND order_type = $6
                AND time_in_force = $7
                AND quantity IS NOT DISTINCT FROM $8::numeric
                AND notional IS NOT DISTINCT FROM $9::numeric
                AND limit_price IS NOT DISTINCT FROM $10::numeric
                AND stop_price IS NOT DISTINCT FROM $11::numeric
                AS identity_matches
       FROM order_intents WHERE id = $1 FOR UPDATE`,
      [
        input.orderIntentId,
        input.clientOrderId,
        input.symbol,
        input.assetClass,
        input.side,
        input.orderType,
        input.timeInForce,
        input.quantity,
        input.notional,
        input.limitPrice,
        input.stopPrice
      ]
    );
    const row = intent.rows[0];
    if (!row) throw new Error("POSTGRES_EXECUTION_ORDER_INTENT_NOT_FOUND");
    if (row.identity_matches === false) {
      throw new Error("POSTGRES_BROKER_RESULT_INTENT_MISMATCH");
    }
    const brokerClientOrderId = input.brokerClientOrderId ?? input.clientOrderId;
    const brokerQuantity = input.brokerQuantity ?? input.quantity;
    const brokerNotional = input.brokerNotional ?? input.notional;
    const brokerLimitPrice = input.brokerLimitPrice ?? input.limitPrice;
    const brokerStopPrice = input.brokerStopPrice ?? input.stopPrice;
    const recordLifecycleFingerprint = () => context.transaction.query(
      `INSERT INTO lifecycle_fingerprints(
         id, account_id, candidate_id, order_intent_id, entity_type, entity_id,
         lifecycle_stage, fingerprint, payload_version, evidence, request_id,
         captured_at, created_at
       ) VALUES (
         $1, $2, $3, $4, 'order', $5, 'broker_result', $6, 1, $7::jsonb,
         $8, $9, $9
       ) ON CONFLICT (entity_type, entity_id, lifecycle_stage, fingerprint) DO NOTHING`,
      [
        `${input.eventId}:broker-result`,
        row.account_id,
        row.candidate_id,
        input.orderIntentId,
        input.orderId,
        input.responseFingerprint,
        canonicalJson({
          brokerEventId: input.eventId,
          brokerOrderId: input.brokerOrderId,
          clientOrderId: brokerClientOrderId,
          intentClientOrderId: input.clientOrderId,
          replacesBrokerOrderId: input.replacesBrokerOrderId ?? null,
          status: input.status
        }),
        input.requestId,
        input.receivedAt
      ]
    );
    const existingEvent = await context.transaction.query<{
      response_fingerprint: string;
      order_id: string | null;
      order_intent_id: string | null;
    }>(
      `SELECT response_fingerprint, order_id, order_intent_id
       FROM broker_events WHERE event_id = $1`,
      [input.eventId]
    );
    if (existingEvent.rows[0]) {
      if (
        existingEvent.rows[0].response_fingerprint !== input.responseFingerprint ||
        existingEvent.rows[0].order_id !== input.orderId ||
        existingEvent.rows[0].order_intent_id !== input.orderIntentId
      ) {
        throw new Error("POSTGRES_BROKER_EVENT_REPLAY_CONFLICT");
      }
      await recordLifecycleFingerprint();
      return { status: "duplicate" as const, orderId: input.orderId };
    }
    const existingOrder = await context.transaction.query<{
      id: string;
      broker_order_id: string | null;
      client_order_id: string;
      status: string;
      fill_regression: boolean;
    }>(
      `SELECT id, broker_order_id, client_order_id, status,
              filled_quantity > $2::numeric AS fill_regression
       FROM orders
       WHERE order_intent_id = $1 AND replacement_order_id IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT 1
       FOR UPDATE`,
      [input.orderIntentId, input.filledQuantity]
    );
    const storedOrder = existingOrder.rows[0];
    const replacement = Boolean(
      storedOrder &&
      storedOrder.id !== input.orderId &&
      storedOrder.broker_order_id !== null &&
      input.replacesBrokerOrderId === storedOrder.broker_order_id
    );
    if (
      storedOrder &&
      !replacement &&
      (
        storedOrder.id !== input.orderId ||
        storedOrder.client_order_id !== brokerClientOrderId ||
        (storedOrder.broker_order_id !== null &&
          input.brokerOrderId !== null &&
          storedOrder.broker_order_id !== input.brokerOrderId)
      )
    ) {
      throw new Error("POSTGRES_BROKER_RESULT_ORDER_MISMATCH");
    }
    const terminalIntent = ["reconciled", "failed", "cancelled"].includes(row.status);
    const terminalOrder = storedOrder
      ? ["filled", "rejected", "cancelled", "canceled", "expired"].includes(
          storedOrder.status.toLowerCase()
        )
      : false;
    const incomingIntentStatus = orderIntentStatus(input.status);
    if (
      (!replacement && storedOrder?.fill_regression === true) ||
      (terminalIntent && incomingIntentStatus !== row.status) ||
      (!replacement && terminalOrder && storedOrder?.status.toLowerCase() !== input.status.toLowerCase())
    ) {
      throw new Error("POSTGRES_BROKER_RESULT_STATUS_REGRESSION");
    }
    await context.transaction.query(
      `INSERT INTO orders(
         id, account_id, order_intent_id, broker_order_id, client_order_id,
         parent_order_id, environment, symbol, asset_class, side, order_type, time_in_force,
         status, quantity, notional, limit_price, stop_price, filled_quantity,
         filled_average_price, broker_request_id, submitted_at,
         last_broker_update_at, raw_status, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'paper', $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18, $19, $20, $21, $22::jsonb, $20, $21
       ) ON CONFLICT (account_id, client_order_id) DO UPDATE SET
         broker_order_id = COALESCE(EXCLUDED.broker_order_id, orders.broker_order_id),
         status = EXCLUDED.status,
         filled_quantity = GREATEST(orders.filled_quantity, EXCLUDED.filled_quantity),
         filled_average_price = COALESCE(EXCLUDED.filled_average_price, orders.filled_average_price),
         broker_request_id = COALESCE(EXCLUDED.broker_request_id, orders.broker_request_id),
         last_broker_update_at = EXCLUDED.last_broker_update_at,
         raw_status = EXCLUDED.raw_status,
         version = orders.version + 1,
         updated_at = EXCLUDED.updated_at
       RETURNING id`,
      [
        input.orderId,
        row.account_id,
        input.orderIntentId,
        input.brokerOrderId,
        brokerClientOrderId,
        replacement ? storedOrder?.id ?? null : null,
        input.symbol,
        input.assetClass,
        input.side,
        input.orderType,
        input.timeInForce,
        input.status,
        brokerQuantity,
        brokerNotional,
        brokerLimitPrice,
        brokerStopPrice,
        input.filledQuantity,
        input.filledAveragePrice,
        input.requestId,
        input.occurredAt,
        input.receivedAt,
        canonicalJson(input.responsePayload)
      ]
    );
    if (replacement) {
      const linked = await context.transaction.query(
        `UPDATE orders
         SET replacement_order_id = $2, status = 'replaced',
             version = version + 1, updated_at = $3
         WHERE id = $1 AND replacement_order_id IS NULL`,
        [storedOrder!.id, input.orderId, input.receivedAt]
      );
      if (linked.rowCount !== 1) {
        throw new Error("POSTGRES_BROKER_REPLACEMENT_CHAIN_CONFLICT");
      }
    }
    const event = await context.transaction.query(
      `INSERT INTO broker_events(
         event_id, account_id, order_id, order_intent_id, broker_order_id,
         client_order_id, event_type, event_status, request_id, http_status,
         error_classification, retryable, response_payload,
         response_fingerprint, occurred_at, received_at, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'order_response', $7, $8, $9, $10, $11,
         $12::jsonb, $13, $14, $15, $15
       ) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [
        input.eventId,
        row.account_id,
        input.orderId,
        input.orderIntentId,
        input.brokerOrderId,
        brokerClientOrderId,
        input.status,
        input.requestId,
        input.httpStatus,
        input.errorClassification,
        input.retryable,
        canonicalJson(input.responsePayload),
        input.responseFingerprint,
        input.occurredAt,
        input.receivedAt
      ]
    );
    if (!event.rowCount) {
      const replay = await context.transaction.query<{ response_fingerprint: string }>(
        "SELECT response_fingerprint FROM broker_events WHERE event_id = $1",
        [input.eventId]
      );
      if (replay.rows[0]?.response_fingerprint !== input.responseFingerprint) {
        throw new Error("POSTGRES_BROKER_EVENT_REPLAY_CONFLICT");
      }
      return { status: "duplicate" as const, orderId: input.orderId };
    }
    const intentStatus = incomingIntentStatus;
    await context.transaction.query(
      `UPDATE order_intents
       SET status = $2,
           submitted_at = CASE WHEN $2 IN ('submitted', 'reconciled') THEN COALESCE(submitted_at, $3::timestamptz) ELSE submitted_at END,
           terminal_at = CASE WHEN $2 IN ('reconciled', 'failed', 'cancelled') THEN $3::timestamptz ELSE terminal_at END,
           version = version + 1, updated_at = $3
       WHERE id = $1`,
      [input.orderIntentId, intentStatus, input.receivedAt]
    );
    if (row.reservation_id && intentStatus !== "ambiguous") {
      const committed = intentStatus === "submitted" || intentStatus === "reconciled";
      const reservation = await context.transaction.query<{
        strategy_key: string;
        amount: string;
      }>(
        `UPDATE buying_power_reservations
         SET status = $2,
             committed_at = CASE WHEN $2 = 'committed' THEN $3::timestamptz ELSE committed_at END,
             released_at = CASE WHEN $2 = 'released' THEN $3::timestamptz ELSE released_at END,
             release_reason = CASE WHEN $2 = 'released' THEN 'BROKER_SUBMISSION_FAILED' ELSE release_reason END,
             version = version + 1, updated_at = $3
         WHERE id = $1 AND status = 'active'
         RETURNING strategy_key, amount::text AS amount`,
        [row.reservation_id, committed ? "committed" : "released", input.receivedAt]
      );
      if (reservation.rows[0]) {
        await context.transaction.query(
          `UPDATE strategy_allocations
           SET reserved_amount = GREATEST(0, reserved_amount - $3::numeric),
               deployed_amount = deployed_amount + CASE WHEN $4 THEN $3::numeric ELSE 0 END,
               version = version + 1, updated_at = $5
           WHERE account_id = $1 AND strategy_key = $2
             AND status = 'active' AND effective_to IS NULL`,
          [
            row.account_id,
            reservation.rows[0].strategy_key,
            reservation.rows[0].amount,
            committed,
            input.receivedAt
          ]
        );
      }
    }
    await recordLifecycleFingerprint();
    return { status: "recorded" as const, orderId: input.orderId };
  }

  async upsertExecutionEvidence(
    input: ExecutionEvidenceInput,
    context: FencedPostgresRepositoryContext
  ) {
    const fence = await requireCurrentFence(context);
    if (!fence.accepted) {
      return {
        status: "fence_rejected" as const,
        currentFencingToken: fence.currentFencingToken
      };
    }
    let candidateId = input.candidateId;
    if (candidateId) {
      const candidate = await context.transaction.query<{ id: string }>(
        "SELECT id FROM candidates WHERE id = $1",
        [candidateId]
      );
      candidateId = candidate.rows[0]?.id ?? null;
    }
    const review = input.review;
    const reviewWrite = await context.transaction.query(
      `INSERT INTO execution_reviews(
         id, account_id, candidate_id, review_type, status, client_order_id,
         account_fingerprint, source_recommendation_id, source_snapshot_id,
         configuration_fingerprint, payload_fingerprint, signature_algorithm,
         signature, order_intent, market_evidence, portfolio_evidence,
         warnings, blockers, request_id, correlation_id, expires_at,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18::jsonb,
         $19, $20, $21, $22, $22
       ) ON CONFLICT (id) DO NOTHING`,
      [
        review.id,
        input.accountId,
        candidateId,
        review.reviewType,
        review.status,
        review.clientOrderId,
        review.accountFingerprint,
        review.sourceRecommendationId,
        review.sourceSnapshotId,
        review.configurationFingerprint,
        review.payloadFingerprint,
        review.signatureAlgorithm,
        review.signature,
        canonicalJson(review.orderIntent),
        canonicalJson(review.marketEvidence),
        canonicalJson(review.portfolioEvidence),
        canonicalJson(review.warnings),
        canonicalJson(review.blockers),
        review.requestId,
        review.correlationId,
        review.expiresAt,
        review.createdAt
      ]
    );
    if ((reviewWrite.rowCount ?? 0) === 0) {
      const replay = await context.transaction.query<{ matches: boolean }>(
        `SELECT (
           account_id = $2 AND candidate_id IS NOT DISTINCT FROM $3 AND
           review_type = $4 AND
           (status = $5 OR (status = 'consumed' AND $5 IN ('created', 'valid'))) AND
           client_order_id IS NOT DISTINCT FROM $6 AND
           account_fingerprint = $7 AND source_recommendation_id IS NOT DISTINCT FROM $8 AND
           source_snapshot_id IS NOT DISTINCT FROM $9 AND configuration_fingerprint = $10 AND
           payload_fingerprint = $11 AND signature_algorithm = $12 AND signature = $13 AND
           order_intent = $14::jsonb AND market_evidence = $15::jsonb AND
           portfolio_evidence = $16::jsonb AND warnings = $17::jsonb AND blockers = $18::jsonb AND
           request_id IS NOT DISTINCT FROM $19 AND correlation_id IS NOT DISTINCT FROM $20 AND
           expires_at = $21::timestamptz AND created_at = $22::timestamptz
         ) AS matches
         FROM execution_reviews WHERE id = $1`,
        [
          review.id,
          input.accountId,
          candidateId,
          review.reviewType,
          review.status,
          review.clientOrderId,
          review.accountFingerprint,
          review.sourceRecommendationId,
          review.sourceSnapshotId,
          review.configurationFingerprint,
          review.payloadFingerprint,
          review.signatureAlgorithm,
          review.signature,
          canonicalJson(review.orderIntent),
          canonicalJson(review.marketEvidence),
          canonicalJson(review.portfolioEvidence),
          canonicalJson(review.warnings),
          canonicalJson(review.blockers),
          review.requestId,
          review.correlationId,
          review.expiresAt,
          review.createdAt
        ]
      );
      if (replay.rows[0]?.matches !== true) {
        throw new Error("POSTGRES_EXECUTION_REVIEW_REPLAY_CONFLICT");
      }
    }
    const confirmation = input.confirmation;
    const confirmationWrite = await context.transaction.query(
      `INSERT INTO confirmation_evidence(
         id, execution_review_id, account_id, candidate_id, evidence_type,
         confirmation_method, status, payload_fingerprint,
         signature_algorithm, signature, evidence, confirmed_at, expires_at,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13,
         $12, $12
       ) ON CONFLICT (execution_review_id, payload_fingerprint) DO NOTHING`,
      [
        confirmation.id,
        review.id,
        input.accountId,
        candidateId,
        confirmation.evidenceType,
        confirmation.confirmationMethod,
        confirmation.status,
        confirmation.payloadFingerprint,
        confirmation.signatureAlgorithm,
        confirmation.signature,
        canonicalJson(confirmation.evidence),
        confirmation.confirmedAt,
        confirmation.expiresAt
      ]
    );
    if ((confirmationWrite.rowCount ?? 0) === 0) {
      const replay = await context.transaction.query<{ matches: boolean }>(
        `SELECT (
           execution_review_id = $2 AND account_id = $3 AND
           candidate_id IS NOT DISTINCT FROM $4 AND evidence_type = $5 AND
           confirmation_method = $6 AND
           (status = $7 OR (status = 'consumed' AND $7 = 'valid')) AND
           payload_fingerprint = $8 AND
           signature_algorithm IS NOT DISTINCT FROM $9 AND signature IS NOT DISTINCT FROM $10 AND
           evidence = $11::jsonb AND confirmed_at = $12::timestamptz AND
           expires_at = $13::timestamptz AND created_at = $12::timestamptz
         ) AS matches
         FROM confirmation_evidence WHERE id = $1`,
        [
          confirmation.id,
          review.id,
          input.accountId,
          candidateId,
          confirmation.evidenceType,
          confirmation.confirmationMethod,
          confirmation.status,
          confirmation.payloadFingerprint,
          confirmation.signatureAlgorithm,
          confirmation.signature,
          canonicalJson(confirmation.evidence),
          confirmation.confirmedAt,
          confirmation.expiresAt
        ]
      );
      if (replay.rows[0]?.matches !== true) {
        throw new Error("POSTGRES_CONFIRMATION_EVIDENCE_REPLAY_CONFLICT");
      }
    }
    const lifecycle = input.lifecycleFingerprint;
    const lifecycleWrite = await context.transaction.query(
      `INSERT INTO lifecycle_fingerprints(
         id, account_id, candidate_id, entity_type, entity_id, lifecycle_stage,
         fingerprint, payload_version, evidence, request_id, correlation_id,
         captured_at, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $12
       ) ON CONFLICT (entity_type, entity_id, lifecycle_stage, fingerprint) DO NOTHING`,
      [
        lifecycle.id,
        input.accountId,
        candidateId,
        lifecycle.entityType,
        lifecycle.entityId,
        lifecycle.lifecycleStage,
        lifecycle.fingerprint,
        lifecycle.payloadVersion,
        canonicalJson(lifecycle.evidence),
        lifecycle.requestId,
        lifecycle.correlationId,
        lifecycle.capturedAt
      ]
    );
    if ((lifecycleWrite.rowCount ?? 0) === 0) {
      const replay = await context.transaction.query<{ matches: boolean }>(
        `SELECT (
           account_id = $2 AND candidate_id IS NOT DISTINCT FROM $3 AND
           entity_type = $4 AND entity_id = $5 AND lifecycle_stage = $6 AND
           fingerprint = $7 AND payload_version = $8 AND evidence = $9::jsonb AND
           request_id IS NOT DISTINCT FROM $10 AND correlation_id IS NOT DISTINCT FROM $11 AND
           captured_at = $12::timestamptz AND created_at = $12::timestamptz
         ) AS matches
         FROM lifecycle_fingerprints WHERE id = $1`,
        [
          lifecycle.id,
          input.accountId,
          candidateId,
          lifecycle.entityType,
          lifecycle.entityId,
          lifecycle.lifecycleStage,
          lifecycle.fingerprint,
          lifecycle.payloadVersion,
          canonicalJson(lifecycle.evidence),
          lifecycle.requestId,
          lifecycle.correlationId,
          lifecycle.capturedAt
        ]
      );
      if (replay.rows[0]?.matches !== true) {
        throw new Error("POSTGRES_LIFECYCLE_FINGERPRINT_REPLAY_CONFLICT");
      }
    }
    return { status: "stored" as const };
  }
}
