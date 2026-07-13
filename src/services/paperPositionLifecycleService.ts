import { randomUUID } from "node:crypto";
import { canonicalJsonHash, canonicalizeJson } from "../lib/canonicalJson.js";
import { getDb, queryAll, queryOne } from "../lib/db.js";
import type {
  DecisionId,
  LinkageStatus,
  OutcomeCompletenessStatus,
  PositionLifecycleId
} from "../types.js";
import { appendDecisionLifecycleEvent } from "./marketDecisionEvidenceService.js";
import { createPositionLifecycleId } from "./marketDecisionIdentityService.js";
import { linkPaperExecutionPositionLifecycle } from "./paperExecutionLedgerService.js";

const canonicalJson = (value: unknown) => JSON.stringify(canonicalizeJson(value));
const round = (value: number | null, digits = 8) =>
  value === null ? null : Number(value.toFixed(digits));
const finitePositive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const finiteOrNull = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const assertPaperOnly = () => {
  if (
    process.env.ALPACA_ENV === "live" ||
    process.env.TRADING_MODE === "live" ||
    process.env.ALPACA_LIVE_TRADE === "true" ||
    process.env.LIVE_TRADING_ENABLED === "true"
  ) {
    throw new Error("PAPER_POSITION_LIFECYCLE_REQUIRES_PAPER_MODE");
  }
};

interface PositionRow {
  position_lifecycle_id: PositionLifecycleId;
  entry_decision_id: DecisionId;
  terminal_exit_decision_id: DecisionId | null;
  symbol: string;
  option_symbol: string | null;
  asset_class: "equity" | "option";
  side: "long" | "short";
  broker_entry_order_id: string | null;
  entry_client_order_id: string;
  status: "OPEN" | "CLOSED";
  opened_at: string;
  closed_at: string | null;
  entry_quantity: number | null;
  entry_price: number | null;
  linkage_status: LinkageStatus;
  created_at: string;
  updated_at: string;
}

const mapPosition = (row: PositionRow) => ({
  positionLifecycleId: row.position_lifecycle_id,
  entryDecisionId: row.entry_decision_id,
  terminalExitDecisionId: row.terminal_exit_decision_id,
  symbol: row.symbol,
  optionSymbol: row.option_symbol,
  assetClass: row.asset_class,
  side: row.side,
  brokerEntryOrderId: row.broker_entry_order_id,
  entryClientOrderId: row.entry_client_order_id,
  status: row.status,
  openedAt: row.opened_at,
  closedAt: row.closed_at,
  entryQuantity: row.entry_quantity,
  entryPrice: row.entry_price,
  linkageStatus: row.linkage_status
});

const positionByLifecycle = (positionLifecycleId: PositionLifecycleId) => {
  const row = queryOne<PositionRow>(
    "SELECT * FROM paper_positions WHERE position_lifecycle_id = ? LIMIT 1",
    [positionLifecycleId]
  );
  return row ? mapPosition(row) : null;
};

export const reconcilePaperEntryFill = (input: {
  ledgerId: number;
  brokerOrderId: string;
  clientOrderId: string;
  status: string;
  filledQuantity: number;
  filledAveragePrice: number | null;
  observedAt: string;
  brokerRequestId?: string | null;
  underlyingPrice?: number | null;
}): ReturnType<typeof mapPosition> => {
  assertPaperOnly();
  if (
    !["filled", "partially_filled"].includes(input.status) ||
    !finitePositive(input.filledQuantity) ||
    !finitePositive(input.filledAveragePrice)
  ) {
    throw new Error("BROKER_FILL_NOT_CONFIRMED");
  }
  const ledger = queryOne<{
    id: number;
    asset_class: string;
    symbol: string;
    underlying_symbol: string | null;
    side: string | null;
    client_order_id: string;
    decision_id: DecisionId | null;
    decision_linkage_status: LinkageStatus;
    position_lifecycle_id: PositionLifecycleId | null;
    payload_json: string;
  }>("SELECT * FROM paper_execution_ledger WHERE id = ? LIMIT 1", [input.ledgerId]);
  if (!ledger) {
    throw new Error("PAPER_EXECUTION_LEDGER_NOT_FOUND");
  }
  if (ledger.client_order_id !== input.clientOrderId) {
    throw new Error("BROKER_FILL_CLIENT_ORDER_MISMATCH");
  }
  if (!ledger.decision_id || ledger.decision_linkage_status !== "EXACT") {
    throw new Error("BROKER_FILL_DECISION_LINEAGE_NOT_EXACT");
  }
  const decision = queryOne<{ decision_role: string }>(
    "SELECT decision_role FROM decision_snapshots WHERE decision_id = ? LIMIT 1",
    [ledger.decision_id]
  );
  if (decision?.decision_role !== "entry") {
    throw new Error("BROKER_FILL_ENTRY_DECISION_NOT_FOUND");
  }
  if (ledger.position_lifecycle_id) {
    const existing = positionByLifecycle(ledger.position_lifecycle_id);
    if (!existing) {
      throw new Error("PAPER_EXECUTION_LIFECYCLE_NOT_FOUND");
    }
    if (
      existing.status === "OPEN" &&
      input.filledQuantity >= (existing.entryQuantity ?? 0)
    ) {
      getDb().prepare(`
        UPDATE paper_positions
        SET entry_quantity = ?, entry_price = ?, updated_at = ?
        WHERE position_lifecycle_id = ? AND status = 'OPEN'
      `).run(
        input.filledQuantity,
        input.filledAveragePrice,
        new Date().toISOString(),
        ledger.position_lifecycle_id
      );
      capturePaperPositionObservation({
        brokerSymbolKey: existing.optionSymbol ?? existing.symbol,
        symbol: existing.symbol,
        optionSymbol: existing.optionSymbol,
        observedAt: input.observedAt,
        sourceTimestamp: input.observedAt,
        brokerRequestId: input.brokerRequestId ?? null,
        mark: input.filledAveragePrice,
        underlyingPrice:
          existing.assetClass === "option"
            ? input.underlyingPrice ?? null
            : input.underlyingPrice ?? input.filledAveragePrice,
        quantity: input.filledQuantity,
        averageEntryPrice: input.filledAveragePrice,
        dataQualityStatus:
          input.status === "partially_filled" ? "PARTIAL" : "COMPLETE"
      });
    }
    return positionByLifecycle(ledger.position_lifecycle_id)!;
  }
  const duplicate = queryOne<PositionRow>(
    "SELECT * FROM paper_positions WHERE entry_client_order_id = ? LIMIT 1",
    [input.clientOrderId]
  );
  if (duplicate) {
    linkPaperExecutionPositionLifecycle({
      ledgerId: input.ledgerId,
      positionLifecycleId: duplicate.position_lifecycle_id
    });
    return reconcilePaperEntryFill(input);
  }

  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(ledger.payload_json) as unknown;
    payload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    payload = {};
  }
  const positionLifecycleId = createPositionLifecycleId();
  const assetClass = ledger.asset_class === "option" ? "option" : "equity";
  const symbol = assetClass === "option"
    ? ledger.underlying_symbol || ledger.symbol
    : ledger.symbol;
  const optionSymbol = assetClass === "option" ? ledger.symbol : null;
  const side =
    ledger.side === "sell" || payload.position_intent === "sell_to_open"
      ? "short"
      : "long";
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO paper_positions(
      position_lifecycle_id, entry_decision_id, terminal_exit_decision_id,
      symbol, option_symbol, asset_class, side, broker_entry_order_id,
      entry_client_order_id, status, opened_at, closed_at, entry_quantity,
      entry_price, linkage_status, created_at, updated_at
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'OPEN', ?, NULL, ?, ?, 'EXACT', ?, ?)
  `).run(
    positionLifecycleId,
    ledger.decision_id,
    symbol,
    optionSymbol,
    assetClass,
    side,
    input.brokerOrderId,
    input.clientOrderId,
    input.observedAt,
    input.filledQuantity,
    input.filledAveragePrice,
    now,
    now
  );
  linkPaperExecutionPositionLifecycle({ ledgerId: input.ledgerId, positionLifecycleId });
  capturePaperPositionObservation({
    brokerSymbolKey: optionSymbol ?? symbol,
    symbol,
    optionSymbol,
    observedAt: input.observedAt,
    sourceTimestamp: input.observedAt,
    brokerRequestId: input.brokerRequestId ?? null,
    mark: input.filledAveragePrice,
    underlyingPrice:
      assetClass === "option"
        ? input.underlyingPrice ?? null
        : input.underlyingPrice ?? input.filledAveragePrice,
    quantity: input.filledQuantity,
    averageEntryPrice: input.filledAveragePrice,
    dataQualityStatus:
      input.status === "partially_filled" ? "PARTIAL" : "COMPLETE"
  });
  appendDecisionLifecycleEvent({
    decisionId: ledger.decision_id,
    status: "FILLED",
    reasonCodes: [
      input.status === "partially_filled"
        ? "BROKER_CONFIRMED_PARTIAL_FILL"
        : "BROKER_CONFIRMED_FILL"
    ],
    occurredAt: input.observedAt,
    sourceType: "paper_execution_ledger",
    sourceId: `${input.ledgerId}:fill:${input.filledQuantity}`,
    evidence: {
      brokerOrderId: input.brokerOrderId,
      brokerRequestId: input.brokerRequestId ?? null,
      filledQuantity: input.filledQuantity,
      positionLifecycleId
    }
  });
  appendDecisionLifecycleEvent({
    decisionId: ledger.decision_id,
    status: "OPEN",
    reasonCodes: ["ANALYTICAL_POSITION_OPENED"],
    occurredAt: input.observedAt,
    sourceType: "paper_position",
    sourceId: positionLifecycleId,
    evidence: { positionLifecycleId }
  });
  return positionByLifecycle(positionLifecycleId)!;
};

interface ObservationRow {
  observation_id: string;
  observed_at: string;
  underlying_price: number | null;
  midpoint: number | null;
  mark: number | null;
  quantity: number | null;
  data_quality_status: string;
}

export const capturePaperPositionObservation = (input: {
  brokerSymbolKey: string;
  symbol: string;
  optionSymbol?: string | null;
  observedAt: string;
  sourceTimestamp?: string | null;
  brokerRequestId?: string | null;
  marketDataRequestId?: string | null;
  feed?: string | null;
  underlyingPrice?: number | null;
  bid?: number | null;
  ask?: number | null;
  midpoint?: number | null;
  mark?: number | null;
  quantity?: number | null;
  averageEntryPrice?: number | null;
  marketValue?: number | null;
  unrealizedPnl?: number | null;
  unrealizedReturn?: number | null;
  realizedPnl?: number | null;
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  rho?: number | null;
  impliedVolatility?: number | null;
  quoteFreshness?: string | null;
  dataQualityStatus: string;
  portfolioState?: unknown;
  riskState?: unknown;
}) => {
  assertPaperOnly();
  const evidence = {
    ...input,
    brokerSymbolKey: input.brokerSymbolKey.toUpperCase(),
    optionSymbol: input.optionSymbol?.toUpperCase() ?? null,
    symbol: input.symbol.toUpperCase()
  };
  const evidenceHash = canonicalJsonHash(evidence);
  const existing = queryOne<{ observation_id: string }>(
    "SELECT observation_id FROM paper_position_observations WHERE evidence_hash = ? LIMIT 1",
    [evidenceHash]
  );
  const observationId = existing?.observation_id ?? randomUUID();
  if (!existing) {
    getDb().prepare(`
      INSERT INTO paper_position_observations(
        observation_id, broker_symbol_key, symbol, option_symbol, observed_at,
        source_timestamp, broker_request_id, market_data_request_id, feed,
        underlying_price, bid, ask, midpoint, mark, quantity,
        average_entry_price, market_value, unrealized_pnl, unrealized_return,
        realized_pnl, delta, gamma, theta, vega, rho, implied_volatility,
        quote_freshness, data_quality_status, portfolio_state_json,
        risk_state_json, evidence_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      observationId,
      evidence.brokerSymbolKey,
      evidence.symbol,
      evidence.optionSymbol,
      input.observedAt,
      input.sourceTimestamp ?? null,
      input.brokerRequestId ?? null,
      input.marketDataRequestId ?? null,
      input.feed ?? null,
      finiteOrNull(input.underlyingPrice),
      finiteOrNull(input.bid),
      finiteOrNull(input.ask),
      finiteOrNull(input.midpoint),
      finiteOrNull(input.mark),
      finiteOrNull(input.quantity),
      finiteOrNull(input.averageEntryPrice),
      finiteOrNull(input.marketValue),
      finiteOrNull(input.unrealizedPnl),
      finiteOrNull(input.unrealizedReturn),
      finiteOrNull(input.realizedPnl),
      finiteOrNull(input.delta),
      finiteOrNull(input.gamma),
      finiteOrNull(input.theta),
      finiteOrNull(input.vega),
      finiteOrNull(input.rho),
      finiteOrNull(input.impliedVolatility),
      input.quoteFreshness ?? null,
      input.dataQualityStatus,
      input.portfolioState === undefined ? null : canonicalJson(input.portfolioState),
      input.riskState === undefined ? null : canonicalJson(input.riskState),
      evidenceHash,
      new Date().toISOString()
    );
  }

  const possiblePositions = queryAll<PositionRow>(
    `
    SELECT * FROM paper_positions
    WHERE status = 'OPEN'
      AND UPPER(COALESCE(option_symbol, symbol)) = ?
    ORDER BY opened_at, position_lifecycle_id
    `,
    [evidence.brokerSymbolKey]
  );
  const linkageStatus: LinkageStatus =
    possiblePositions.length === 1
      ? "EXACT"
      : possiblePositions.length > 1
        ? "AMBIGUOUS_NETTED_POSITION"
        : "LEGACY_UNLINKED";
  for (const position of possiblePositions) {
    getDb().prepare(`
      INSERT OR IGNORE INTO paper_position_observation_links(
        observation_id, position_lifecycle_id, decision_id, linkage_status
      ) VALUES (?, ?, ?, ?)
    `).run(
      observationId,
      position.position_lifecycle_id,
      linkageStatus === "EXACT" ? position.entry_decision_id : null,
      linkageStatus
    );
  }
  if (linkageStatus === "AMBIGUOUS_NETTED_POSITION") {
    const now = new Date().toISOString();
    for (const position of possiblePositions) {
      getDb().prepare(`
        UPDATE paper_positions
        SET linkage_status = 'AMBIGUOUS_NETTED_POSITION', updated_at = ?
        WHERE position_lifecycle_id = ?
      `).run(now, position.position_lifecycle_id);
    }
  }
  return { observationId, linkageStatus, linkedLifecycles: possiblePositions.length };
};

export const closePaperPositionFromFill = (input: {
  positionLifecycleId: PositionLifecycleId;
  exitDecisionId: DecisionId;
  brokerOrderId: string;
  status: string;
  filledQuantity: number;
  filledAveragePrice: number | null;
  observedAt: string;
  exitReasonCode: string;
  brokerRequestId?: string | null;
  underlyingPrice?: number | null;
}) => {
  assertPaperOnly();
  if (
    input.status !== "filled" ||
    !finitePositive(input.filledQuantity) ||
    !finitePositive(input.filledAveragePrice)
  ) {
    throw new Error("BROKER_EXIT_FILL_NOT_CONFIRMED");
  }
  const position = positionByLifecycle(input.positionLifecycleId);
  if (!position) {
    throw new Error("PAPER_POSITION_NOT_FOUND");
  }
  if (position.status === "CLOSED") {
    if (position.terminalExitDecisionId !== input.exitDecisionId) {
      throw new Error("PAPER_POSITION_EXIT_DECISION_MISMATCH");
    }
    return position;
  }
  const exitDecision = queryOne<{
    decision_role: string;
    position_lifecycle_id: PositionLifecycleId | null;
  }>(
    "SELECT decision_role, position_lifecycle_id FROM decision_snapshots WHERE decision_id = ? LIMIT 1",
    [input.exitDecisionId]
  );
  if (
    exitDecision?.decision_role !== "exit" ||
    (exitDecision.position_lifecycle_id &&
      exitDecision.position_lifecycle_id !== input.positionLifecycleId)
  ) {
    throw new Error("PAPER_POSITION_EXIT_DECISION_NOT_EXACT");
  }
  capturePaperPositionObservation({
    brokerSymbolKey: position.optionSymbol ?? position.symbol,
    symbol: position.symbol,
    optionSymbol: position.optionSymbol,
    observedAt: input.observedAt,
    sourceTimestamp: input.observedAt,
    brokerRequestId: input.brokerRequestId ?? null,
    mark: input.filledAveragePrice,
    underlyingPrice:
      position.assetClass === "option"
        ? input.underlyingPrice ?? null
        : input.underlyingPrice ?? input.filledAveragePrice,
    quantity: 0,
    averageEntryPrice: position.entryPrice,
    realizedPnl:
      position.entryPrice === null || position.entryQuantity === null
        ? null
        : (position.side === "short" ? -1 : 1) *
          (input.filledAveragePrice - position.entryPrice) *
          Math.min(input.filledQuantity, position.entryQuantity) *
          (position.assetClass === "option" ? 100 : 1),
    dataQualityStatus: "COMPLETE",
    portfolioState: {
      brokerExitOrderId: input.brokerOrderId,
      exitReasonCode: input.exitReasonCode
    }
  });
  const now = new Date().toISOString();
  getDb().prepare(`
    UPDATE paper_positions
    SET terminal_exit_decision_id = ?, status = 'CLOSED', closed_at = ?, updated_at = ?
    WHERE position_lifecycle_id = ? AND status = 'OPEN'
  `).run(input.exitDecisionId, input.observedAt, now, input.positionLifecycleId);
  appendDecisionLifecycleEvent({
    decisionId: input.exitDecisionId,
    status: "FILLED",
    reasonCodes: ["BROKER_CONFIRMED_EXIT_FILL"],
    occurredAt: input.observedAt,
    sourceType: "broker_order",
    sourceId: input.brokerOrderId,
    evidence: {
      brokerRequestId: input.brokerRequestId ?? null,
      filledQuantity: input.filledQuantity,
      positionLifecycleId: input.positionLifecycleId
    }
  });
  appendDecisionLifecycleEvent({
    decisionId: input.exitDecisionId,
    status: "CLOSED",
    reasonCodes: [input.exitReasonCode],
    occurredAt: input.observedAt,
    sourceType: "paper_position",
    sourceId: input.positionLifecycleId,
    evidence: { positionLifecycleId: input.positionLifecycleId }
  });
  return positionByLifecycle(input.positionLifecycleId)!;
};

interface OutcomeRow {
  outcome_id: string;
  position_lifecycle_id: PositionLifecycleId;
  entry_decision_id: DecisionId;
  exit_decision_id: DecisionId | null;
  terminal_status: string;
  closed_at: string;
  entry_price: number | null;
  exit_price: number | null;
  quantity: number | null;
  realized_pnl: number | null;
  realized_return_pct: number | null;
  unrealized_return_pct: number | null;
  option_position_return_pct: number | null;
  underlying_return_pct: number | null;
  holding_duration_ms: number | null;
  mfe_pct: number | null;
  mae_pct: number | null;
  time_to_mfe_ms: number | null;
  time_to_mae_ms: number | null;
  time_to_first_profit_ms: number | null;
  maximum_runup_pct: number | null;
  maximum_drawdown_pct: number | null;
  exit_reason_code: string | null;
  data_quality_status: string;
  completeness_status: OutcomeCompletenessStatus;
  evaluation_reason: string | null;
  calculation_basis: string;
  created_at: string;
}

const mapOutcome = (row: OutcomeRow) => ({
  outcomeId: row.outcome_id,
  positionLifecycleId: row.position_lifecycle_id,
  entryDecisionId: row.entry_decision_id,
  exitDecisionId: row.exit_decision_id,
  terminalStatus: row.terminal_status,
  closedAt: row.closed_at,
  entryPrice: row.entry_price,
  exitPrice: row.exit_price,
  quantity: row.quantity,
  realizedPnl: row.realized_pnl,
  realizedReturnPct: row.realized_return_pct,
  unrealizedReturnPct: row.unrealized_return_pct,
  optionPositionReturnPct: row.option_position_return_pct,
  underlyingReturnPct: row.underlying_return_pct,
  holdingDurationMs: row.holding_duration_ms,
  mfePct: row.mfe_pct,
  maePct: row.mae_pct,
  timeToMfeMs: row.time_to_mfe_ms,
  timeToMaeMs: row.time_to_mae_ms,
  timeToFirstProfitMs: row.time_to_first_profit_ms,
  maximumRunupPct: row.maximum_runup_pct,
  maximumDrawdownPct: row.maximum_drawdown_pct,
  exitReasonCode: row.exit_reason_code,
  dataQualityStatus: row.data_quality_status,
  completenessStatus: row.completeness_status,
  evaluationReason: row.evaluation_reason,
  calculationBasis: row.calculation_basis,
  createdAt: row.created_at
});

const percentReturn = (entry: number, current: number, side: "long" | "short") =>
  ((side === "short" ? entry - current : current - entry) / entry) * 100;

export const persistPaperPositionOutcome = (input: {
  positionLifecycleId: PositionLifecycleId;
  exitReasonCode: string;
}) => {
  assertPaperOnly();
  const original = queryOne<OutcomeRow>(
    "SELECT * FROM paper_position_outcomes WHERE position_lifecycle_id = ? LIMIT 1",
    [input.positionLifecycleId]
  );
  if (original) {
    return mapOutcome(original);
  }
  const position = positionByLifecycle(input.positionLifecycleId);
  if (!position) {
    throw new Error("PAPER_POSITION_NOT_FOUND");
  }
  if (position.status !== "CLOSED" || !position.closedAt) {
    throw new Error("PAPER_POSITION_NOT_TERMINAL");
  }
  const observations = queryAll<ObservationRow>(
    `
    SELECT o.observation_id, o.observed_at, o.underlying_price, o.midpoint,
           o.mark, o.quantity, o.data_quality_status
    FROM paper_position_observations o
    JOIN paper_position_observation_links l ON l.observation_id = o.observation_id
    WHERE l.position_lifecycle_id = ? AND l.linkage_status = 'EXACT'
    ORDER BY o.observed_at, o.observation_id
    `,
    [input.positionLifecycleId]
  );
  const ambiguous =
    position.linkageStatus === "AMBIGUOUS_NETTED_POSITION" ||
    Boolean(
      queryOne<{ present: number }>(
        `
        SELECT 1 AS present FROM paper_position_observation_links
        WHERE position_lifecycle_id = ? AND linkage_status = 'AMBIGUOUS_NETTED_POSITION'
        LIMIT 1
        `,
        [input.positionLifecycleId]
      )
    );
  const marks = observations.map((row) => row.mark ?? row.midpoint);
  const entryPrice = marks[0] ?? null;
  const exitPrice = marks.length ? marks[marks.length - 1] ?? null : null;
  let completenessStatus: OutcomeCompletenessStatus = "COMPLETE";
  let evaluationReason: string | null = null;
  if (ambiguous) {
    completenessStatus = "AMBIGUOUS_LINEAGE";
    evaluationReason = "AMBIGUOUS_NETTED_POSITION";
  } else if (observations.length < 2 || !finitePositive(entryPrice) || !finitePositive(exitPrice)) {
    completenessStatus = "INSUFFICIENT_OBSERVATIONS";
    evaluationReason = "ENTRY_OR_EXIT_MARK_MISSING";
  }

  let realizedReturnPct: number | null = null;
  let realizedPnl: number | null = null;
  let optionPositionReturnPct: number | null = null;
  let underlyingReturnPct: number | null = null;
  let holdingDurationMs: number | null = null;
  let mfePct: number | null = null;
  let maePct: number | null = null;
  let timeToMfeMs: number | null = null;
  let timeToMaeMs: number | null = null;
  let timeToFirstProfitMs: number | null = null;
  let maximumRunupPct: number | null = null;
  let maximumDrawdownPct: number | null = null;
  const calculable = completenessStatus !== "AMBIGUOUS_LINEAGE" &&
    completenessStatus !== "INSUFFICIENT_OBSERVATIONS" &&
    finitePositive(entryPrice) && finitePositive(exitPrice);
  if (calculable) {
    const returns = marks.map((mark) =>
      finitePositive(mark) ? percentReturn(entryPrice, mark, position.side) : null
    );
    if (returns.every((value): value is number => value !== null)) {
      const maxReturn = Math.max(...returns);
      const minReturn = Math.min(...returns);
      const maxIndex = returns.indexOf(maxReturn);
      const minIndex = returns.indexOf(minReturn);
      const firstProfitIndex = returns.findIndex((value) => value > 0);
      const openedAt = new Date(observations[0].observed_at).getTime();
      const closedAt = new Date(observations[observations.length - 1].observed_at).getTime();
      realizedReturnPct = round(returns[returns.length - 1]);
      mfePct = round(maxReturn);
      maePct = round(minReturn);
      timeToMfeMs = new Date(observations[maxIndex].observed_at).getTime() - openedAt;
      timeToMaeMs = new Date(observations[minIndex].observed_at).getTime() - openedAt;
      timeToFirstProfitMs = firstProfitIndex < 0
        ? null
        : new Date(observations[firstProfitIndex].observed_at).getTime() - openedAt;
      holdingDurationMs = closedAt - openedAt;
      maximumRunupPct = round(maxReturn - minReturn);
      maximumDrawdownPct = round(minReturn - maxReturn);
      const multiplier = position.assetClass === "option" ? 100 : 1;
      realizedPnl = round(
        (position.side === "short" ? -1 : 1) *
          (exitPrice - entryPrice) *
          (position.entryQuantity ?? observations[0].quantity ?? 0) *
          multiplier
      );
      optionPositionReturnPct = position.assetClass === "option"
        ? realizedReturnPct
        : null;
      const underlyingEntry = observations[0].underlying_price;
      const underlyingExit = observations[observations.length - 1].underlying_price;
      if (finitePositive(underlyingEntry) && finitePositive(underlyingExit)) {
        underlyingReturnPct = round(
          percentReturn(underlyingEntry, underlyingExit, position.side)
        );
      } else if (position.assetClass === "option") {
        completenessStatus = "PARTIAL";
        evaluationReason = "UNDERLYING_RETURN_BASIS_MISSING";
      }
      if (observations.some((row) => row.data_quality_status !== "COMPLETE")) {
        completenessStatus = "PARTIAL";
        evaluationReason ??= "PARTIAL_OBSERVATION_QUALITY";
      }
    } else {
      completenessStatus = "INSUFFICIENT_OBSERVATIONS";
      evaluationReason = "INTERMEDIATE_MARK_MISSING";
      realizedReturnPct = null;
      realizedPnl = null;
      optionPositionReturnPct = null;
      underlyingReturnPct = null;
      holdingDurationMs = null;
      mfePct = null;
      maePct = null;
      timeToMfeMs = null;
      timeToMaeMs = null;
      timeToFirstProfitMs = null;
      maximumRunupPct = null;
      maximumDrawdownPct = null;
    }
  }

  const dataQualityStatus = observations.length &&
    observations.every((row) => row.data_quality_status === "COMPLETE")
    ? "COMPLETE"
    : observations.length
      ? "PARTIAL"
      : "MISSING";
  const outcomeId = randomUUID();
  const calculationBasis = canonicalJson({
    exactObservationIds: ambiguous
      ? []
      : observations.map((row) => row.observation_id),
    markBasis: "mark_then_midpoint",
    optionMultiplier: position.assetClass === "option" ? 100 : 1,
    returnDirection: position.side,
    underlyingBasis: "persisted_underlying_price"
  });
  const createdAt = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO paper_position_outcomes(
      outcome_id, position_lifecycle_id, entry_decision_id, exit_decision_id,
      terminal_status, closed_at, entry_price, exit_price, quantity,
      realized_pnl, realized_return_pct, unrealized_return_pct,
      option_position_return_pct, underlying_return_pct, holding_duration_ms,
      mfe_pct, mae_pct, time_to_mfe_ms, time_to_mae_ms,
      time_to_first_profit_ms, maximum_runup_pct, maximum_drawdown_pct,
      exit_reason_code, data_quality_status, completeness_status,
      evaluation_reason, calculation_basis, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    outcomeId,
    input.positionLifecycleId,
    position.entryDecisionId,
    position.terminalExitDecisionId,
    position.status,
    position.closedAt,
    ambiguous || completenessStatus === "INSUFFICIENT_OBSERVATIONS" ? null : entryPrice,
    ambiguous || completenessStatus === "INSUFFICIENT_OBSERVATIONS" ? null : exitPrice,
    position.entryQuantity,
    realizedPnl,
    realizedReturnPct,
    optionPositionReturnPct,
    underlyingReturnPct,
    holdingDurationMs,
    mfePct,
    maePct,
    timeToMfeMs,
    timeToMaeMs,
    timeToFirstProfitMs,
    maximumRunupPct,
    maximumDrawdownPct,
    input.exitReasonCode,
    dataQualityStatus,
    completenessStatus,
    evaluationReason,
    calculationBasis,
    createdAt
  );
  return mapOutcome(
    queryOne<OutcomeRow>(
      "SELECT * FROM paper_position_outcomes WHERE outcome_id = ? LIMIT 1",
      [outcomeId]
    )!
  );
};

export const appendPaperPositionOutcomeRevision = (input: {
  outcomeId: string;
  correctionReason: string;
  correctedFields: Record<string, unknown>;
}) => {
  const outcome = queryOne<{ outcome_id: string }>(
    "SELECT outcome_id FROM paper_position_outcomes WHERE outcome_id = ? LIMIT 1",
    [input.outcomeId]
  );
  if (!outcome) {
    throw new Error("PAPER_POSITION_OUTCOME_NOT_FOUND");
  }
  const previous = queryOne<{
    revision_id: string;
    revision_number: number;
  }>(
    `
    SELECT revision_id, revision_number
    FROM paper_position_outcome_revisions
    WHERE outcome_id = ?
    ORDER BY revision_number DESC
    LIMIT 1
    `,
    [input.outcomeId]
  );
  const revisionId = randomUUID();
  const revisionNumber = (previous?.revision_number ?? 0) + 1;
  getDb().prepare(`
    INSERT INTO paper_position_outcome_revisions(
      revision_id, outcome_id, revision_number, supersedes_revision_id,
      correction_reason, corrected_fields_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    revisionId,
    input.outcomeId,
    revisionNumber,
    previous?.revision_id ?? null,
    input.correctionReason,
    canonicalJson(input.correctedFields),
    new Date().toISOString()
  );
  return {
    revisionId,
    outcomeId: input.outcomeId,
    revisionNumber,
    supersedesRevisionId: previous?.revision_id ?? null,
    correctionReason: input.correctionReason,
    correctedFields: input.correctedFields
  };
};
