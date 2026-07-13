import { getDb, queryAll, queryOne } from "../lib/db.js";
import type {
  DecisionId,
  LinkageStatus,
  PositionLifecycleId
} from "../types.js";

export type PaperExecutionLedgerStatus =
  | "built"
  | "blocked"
  | "submitted"
  | "accepted"
  | "rejected"
  | "failed"
  | "duplicate_blocked"
  | "attempted"
  | "reserved"
  | "released"
  | "filled"
  | "canceled"
  | "expired"
  | "partial";

export interface PaperExecutionLedgerEntry {
  id: number;
  createdAt: string;
  updatedAt: string;
  mode: string;
  assetClass: string;
  symbol: string;
  underlyingSymbol: string | null;
  strategy: string | null;
  side: string | null;
  orderType: string | null;
  timeInForce: string | null;
  qty: string | null;
  notional: string | null;
  limitPrice: string | null;
  estimatedPremium: number | null;
  maxRisk: number | null;
  dedupeKey: string;
  clientOrderId: string;
  alpacaOrderId: string | null;
  alpacaStatus: string | null;
  requestId: string | null;
  sourcePlanId: string | null;
  sourceCandidateId: string | null;
  decisionId: DecisionId | null;
  positionLifecycleId: PositionLifecycleId | null;
  decisionLinkageStatus: LinkageStatus;
  status: PaperExecutionLedgerStatus;
  reason: string | null;
  blockedReason: string | null;
  errorMessage: string | null;
  payloadJson: string;
  rawPayloadJson: string | null;
  rawResponseJson: string | null;
}

interface LedgerRow {
  id: number;
  created_at: string;
  updated_at: string;
  mode: string;
  asset_class: string;
  symbol: string;
  underlying_symbol: string | null;
  strategy: string | null;
  side: string | null;
  order_type: string | null;
  time_in_force: string | null;
  qty: string | null;
  notional: string | null;
  limit_price: string | null;
  estimated_premium: number | null;
  max_risk: number | null;
  dedupe_key: string;
  client_order_id: string;
  alpaca_order_id: string | null;
  alpaca_status: string | null;
  request_id: string | null;
  source_plan_id: string | null;
  source_candidate_id: string | null;
  decision_id: DecisionId | null;
  position_lifecycle_id: PositionLifecycleId | null;
  decision_linkage_status: LinkageStatus;
  status: PaperExecutionLedgerStatus;
  reason: string | null;
  blocked_reason: string | null;
  error_message: string | null;
  payload_json: string;
  raw_payload_json: string | null;
  raw_response_json: string | null;
}

const mapRow = (row: LedgerRow): PaperExecutionLedgerEntry => ({
  id: row.id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  mode: row.mode,
  assetClass: row.asset_class,
  symbol: row.symbol,
  underlyingSymbol: row.underlying_symbol,
  strategy: row.strategy,
  side: row.side,
  orderType: row.order_type,
  timeInForce: row.time_in_force,
  qty: row.qty,
  notional: row.notional,
  limitPrice: row.limit_price,
  estimatedPremium: row.estimated_premium,
  maxRisk: row.max_risk,
  dedupeKey: row.dedupe_key,
  clientOrderId: row.client_order_id,
  alpacaOrderId: row.alpaca_order_id,
  alpacaStatus: row.alpaca_status,
  requestId: row.request_id,
  sourcePlanId: row.source_plan_id,
  sourceCandidateId: row.source_candidate_id,
  decisionId: row.decision_id,
  positionLifecycleId: row.position_lifecycle_id,
  decisionLinkageStatus: row.decision_linkage_status,
  status: row.status,
  reason: row.reason,
  blockedReason: row.blocked_reason,
  errorMessage: row.error_message,
  payloadJson: row.payload_json,
  rawPayloadJson: row.raw_payload_json,
  rawResponseJson: row.raw_response_json
});

export const findPaperExecutionByDedupeKey = (
  dedupeKey: string
): PaperExecutionLedgerEntry | null => {
  const row = queryOne<LedgerRow>(
    `
    SELECT *
    FROM paper_execution_ledger
    WHERE dedupe_key = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    `,
    [dedupeKey]
  );
  return row ? mapRow(row) : null;
};

export const findPaperExecutionByClientOrderId = (
  clientOrderId: string
): PaperExecutionLedgerEntry | null => {
  const row = queryOne<LedgerRow>(
    `SELECT * FROM paper_execution_ledger WHERE client_order_id = ? LIMIT 1`,
    [clientOrderId]
  );
  return row ? mapRow(row) : null;
};

export const listPaperExecutionLedgerEntries = (
  limit = 50
): PaperExecutionLedgerEntry[] => {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(500, Math.floor(limit)) : 50;
  const rows = queryAll<LedgerRow>(
    `
    SELECT *
    FROM paper_execution_ledger
    ORDER BY created_at DESC, id DESC
    LIMIT ?
    `,
    [safeLimit]
  );
  return rows.map(mapRow);
};

export const insertPaperExecutionLedgerEntry = (input: {
  mode: string;
  assetClass: string;
  symbol: string;
  underlyingSymbol?: string | null;
  strategy?: string | null;
  side?: string | null;
  orderType?: string | null;
  timeInForce?: string | null;
  qty?: string | null;
  notional?: string | null;
  limitPrice?: string | null;
  estimatedPremium?: number | null;
  maxRisk?: number | null;
  dedupeKey: string;
  clientOrderId: string;
  requestId?: string | null;
  status: PaperExecutionLedgerStatus;
  reason?: string | null;
  blockedReason?: string | null;
  errorMessage?: string | null;
  sourcePlanId?: string | null;
  sourceCandidateId?: string | null;
  decisionId?: DecisionId | null;
  positionLifecycleId?: PositionLifecycleId | null;
  decisionLinkageStatus?: LinkageStatus;
  payload: unknown;
  rawPayload?: unknown;
  rawResponse?: unknown;
}): PaperExecutionLedgerEntry => {
  const now = new Date().toISOString();
  const payloadJson = JSON.stringify(input.payload);
  const rawPayloadJson = JSON.stringify(input.rawPayload ?? input.payload);
  const rawResponseJson =
    input.rawResponse === undefined ? null : JSON.stringify(input.rawResponse);
  const exactCandidate =
    !input.decisionId && input.sourceCandidateId
      ? queryOne<{ decision_id: DecisionId | null }>(
          "SELECT decision_id FROM paper_trade_candidates WHERE id = ? LIMIT 1",
          [input.sourceCandidateId]
        )
      : null;
  const decisionId = input.decisionId ?? exactCandidate?.decision_id ?? null;
  const decisionLinkageStatus =
    input.decisionLinkageStatus ?? (decisionId ? "EXACT" : "LEGACY_UNLINKED");
  const result = getDb()
    .prepare(
      `
      INSERT INTO paper_execution_ledger(
        created_at,
        updated_at,
        mode,
        asset_class,
        symbol,
        underlying_symbol,
        strategy,
        side,
        order_type,
        time_in_force,
        qty,
        notional,
        limit_price,
        estimated_premium,
        max_risk,
        dedupe_key,
        client_order_id,
        request_id,
        status,
        reason,
        blocked_reason,
        error_message,
        source_plan_id,
        source_candidate_id,
        decision_id,
        position_lifecycle_id,
        decision_linkage_status,
        payload_json,
        raw_payload_json,
        raw_response_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      now,
      now,
      input.mode,
      input.assetClass,
      input.symbol,
      input.underlyingSymbol ?? null,
      input.strategy ?? null,
      input.side ?? null,
      input.orderType ?? null,
      input.timeInForce ?? null,
      input.qty ?? null,
      input.notional ?? null,
      input.limitPrice ?? null,
      input.estimatedPremium ?? null,
      input.maxRisk ?? null,
      input.dedupeKey,
      input.clientOrderId,
      input.requestId ?? null,
      input.status,
      input.reason ?? null,
      input.blockedReason ?? input.reason ?? null,
      input.errorMessage ?? null,
      input.sourcePlanId ?? null,
      input.sourceCandidateId ?? null,
      decisionId,
      input.positionLifecycleId ?? null,
      decisionLinkageStatus,
      payloadJson,
      rawPayloadJson,
      rawResponseJson
    );

  return {
    id: Number(result.lastInsertRowid),
    createdAt: now,
    updatedAt: now,
    mode: input.mode,
    assetClass: input.assetClass,
    symbol: input.symbol,
    underlyingSymbol: input.underlyingSymbol ?? null,
    strategy: input.strategy ?? null,
    side: input.side ?? null,
    orderType: input.orderType ?? null,
    timeInForce: input.timeInForce ?? null,
    qty: input.qty ?? null,
    notional: input.notional ?? null,
    limitPrice: input.limitPrice ?? null,
    estimatedPremium: input.estimatedPremium ?? null,
    maxRisk: input.maxRisk ?? null,
    dedupeKey: input.dedupeKey,
    clientOrderId: input.clientOrderId,
    alpacaOrderId: null,
    alpacaStatus: null,
    requestId: input.requestId ?? null,
    sourcePlanId: input.sourcePlanId ?? null,
    sourceCandidateId: input.sourceCandidateId ?? null,
    decisionId,
    positionLifecycleId: input.positionLifecycleId ?? null,
    decisionLinkageStatus,
    status: input.status,
    reason: input.reason ?? null,
    blockedReason: input.blockedReason ?? input.reason ?? null,
    errorMessage: input.errorMessage ?? null,
    payloadJson,
    rawPayloadJson,
    rawResponseJson
  };
};

export const updatePaperExecutionLedgerEntry = (
  id: number,
  input: {
    status: PaperExecutionLedgerStatus;
    alpacaOrderId?: string | null;
    alpacaStatus?: string | null;
    requestId?: string | null;
    reason?: string | null;
    blockedReason?: string | null;
    errorMessage?: string | null;
    rawResponse?: unknown;
  }
) => {
  const now = new Date().toISOString();
  const rawResponseJson =
    input.rawResponse === undefined ? null : JSON.stringify(input.rawResponse);
  getDb()
    .prepare(
      `
      UPDATE paper_execution_ledger
      SET updated_at = ?,
          status = ?,
          alpaca_order_id = COALESCE(?, alpaca_order_id),
          alpaca_status = COALESCE(?, alpaca_status),
          request_id = COALESCE(?, request_id),
          reason = ?,
          blocked_reason = ?,
          error_message = ?,
          raw_response_json = COALESCE(?, raw_response_json)
      WHERE id = ?
      `
    )
    .run(
      now,
      input.status,
      input.alpacaOrderId ?? null,
      input.alpacaStatus ?? null,
      input.requestId ?? null,
      input.reason ?? null,
      input.blockedReason ?? input.reason ?? null,
      input.errorMessage ?? null,
      rawResponseJson,
      id
    );
};

export const linkPaperExecutionPositionLifecycle = (input: {
  ledgerId: number;
  positionLifecycleId: PositionLifecycleId;
}) => {
  const existing = queryOne<{ position_lifecycle_id: PositionLifecycleId | null }>(
    "SELECT position_lifecycle_id FROM paper_execution_ledger WHERE id = ? LIMIT 1",
    [input.ledgerId]
  );
  if (!existing) {
    throw new Error("PAPER_EXECUTION_LEDGER_NOT_FOUND");
  }
  if (
    existing.position_lifecycle_id &&
    existing.position_lifecycle_id !== input.positionLifecycleId
  ) {
    throw new Error("PAPER_EXECUTION_LIFECYCLE_MISMATCH");
  }
  getDb().prepare(`
    UPDATE paper_execution_ledger
    SET position_lifecycle_id = ?, updated_at = ?
    WHERE id = ? AND (position_lifecycle_id IS NULL OR position_lifecycle_id = ?)
  `).run(
    input.positionLifecycleId,
    new Date().toISOString(),
    input.ledgerId,
    input.positionLifecycleId
  );
};

export const reservePaperExecutionAttempt = (input: {
  reviewId: string;
  clientOrderId: string;
  symbol: string;
  underlyingSymbol?: string | null;
  quantity: number;
  limitPrice: number;
  estimatedPremium: number;
  expiresAt: string;
  requestId?: string | null;
  mode?: "hedge-entry" | "hedge-exit";
  side?: "buy" | "sell";
  positionIntent?: "buy_to_open" | "sell_to_close";
}) => {
  const mode = input.mode ?? "hedge-entry";
  const side = input.side ?? "buy";
  const positionIntent = input.positionIntent ?? "buy_to_open";
  try {
    const entry = insertPaperExecutionLedgerEntry({
      mode,
      assetClass: "option",
      symbol: input.symbol,
      underlyingSymbol: input.underlyingSymbol ?? null,
      strategy: "portfolio_hedge",
      side,
      orderType: "limit",
      timeInForce: "day",
      qty: String(input.quantity),
      limitPrice: String(input.limitPrice),
      estimatedPremium: input.estimatedPremium,
      maxRisk: input.estimatedPremium,
      dedupeKey: `${mode === "hedge-exit" ? "hedge-exit" : "hedge-review"}:${input.reviewId}`,
      clientOrderId: input.clientOrderId,
      status: "reserved",
      requestId: input.requestId ?? null,
      sourcePlanId: input.reviewId,
      payload: {
        reviewId: input.reviewId,
        clientOrderId: input.clientOrderId,
        symbol: input.symbol,
        quantity: input.quantity,
        limitPrice: input.limitPrice,
        estimatedPremium: input.estimatedPremium,
        expiresAt: input.expiresAt,
        mode,
        side,
        positionIntent
      }
    });
    return { reserved: true as const, entry, blockers: [] as string[] };
  } catch (error) {
    const existing = findPaperExecutionByClientOrderId(input.clientOrderId);
    return {
      reserved: false as const,
      entry: existing,
      blockers: ["HEDGE_DUPLICATE_ORDER"],
      error: error instanceof Error ? error.message : "HEDGE_RESERVATION_FAILED"
    };
  }
};

export const releaseExpiredHedgeReservations = (
  asOf = new Date().toISOString()
) => {
  const rows = queryAll<{ id: number }>(
    `
    SELECT id
    FROM paper_execution_ledger
    WHERE mode IN ('hedge-entry', 'hedge-exit')
      AND status = 'reserved'
      AND json_extract(payload_json, '$.expiresAt') < ?
    `,
    [asOf]
  );
  for (const row of rows) {
    updatePaperExecutionLedgerEntry(row.id, {
      status: "released",
      reason: "HEDGE_RESERVATION_EXPIRED",
      blockedReason: "HEDGE_RESERVATION_EXPIRED"
    });
  }
  return rows.length;
};
