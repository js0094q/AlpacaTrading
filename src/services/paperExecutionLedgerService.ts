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

export const getLatestSuccessfulPaperExecutionCreatedAt = (): string | null => {
  const row = queryOne<{ created_at: string | null }>(
    `
    SELECT MAX(created_at) AS created_at
    FROM paper_execution_ledger
    WHERE mode = 'confirmPaper'
      AND status IN ('accepted', 'submitted')
    `
  );
  return row?.created_at ?? null;
};

export const listSuccessfulPaperExecutionLedgerEntriesSince = (
  since: string
): PaperExecutionLedgerEntry[] => {
  const rows = queryAll<LedgerRow>(
    `
    SELECT *
    FROM paper_execution_ledger
    WHERE mode = 'confirmPaper'
      AND status IN ('accepted', 'submitted')
      AND created_at >= ?
    ORDER BY created_at ASC, id ASC
    `,
    [since]
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

export const ACTIVE_NEW_RISK_RESERVATION_STATUSES = new Set<string>([
  "reserved",
  "attempted",
  "submitted",
  "accepted",
  "partial",
  "partially_filled"
]);

export const listActivePaperNewRiskReservations = (): PaperExecutionLedgerEntry[] =>
  queryAll<LedgerRow>(
    `
    SELECT *
    FROM paper_execution_ledger
    WHERE LOWER(COALESCE(side, '')) = 'buy'
      AND status IN (
        'reserved',
        'attempted',
        'submitted',
        'accepted',
        'partial',
        'partially_filled'
      )
    ORDER BY created_at, id
    `
  ).map(mapRow);

export interface ReviewedPaperExecutionReservationInput {
  assetClass: "equity" | "option";
  symbol: string;
  side: "buy";
  orderType: "market" | "limit";
  timeInForce: "day";
  qty?: string | null;
  notional?: string | null;
  limitPrice?: string | null;
  estimatedPremium?: number | null;
  maxRisk?: number | null;
  dedupeKey: string;
  clientOrderId: string;
  sourcePlanId: string;
  sourceCandidateId: string;
  decisionId: DecisionId;
  section: string;
  payloadIndex: number;
  payload: unknown;
  rawPayload: unknown;
}

export interface ReviewedPaperExecutionReservationBatch {
  inputs: ReviewedPaperExecutionReservationInput[];
  validateBeforeInsert?: () => string[];
}

const withImmediateLedgerTransaction = <T>(operation: () => T): T => {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = operation();
    db.exec("COMMIT;");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the original reservation error.
    }
    throw error;
  }
};

export const runAtomicPaperNewRiskReservation = <T>(input: {
  validateBeforeInsert: () => string[];
  insert: () => T;
}) => {
  try {
    return withImmediateLedgerTransaction(() => {
      const blockers = [...new Set(input.validateBeforeInsert())];
      if (blockers.length) {
        return {
          reserved: false as const,
          value: null,
          blockers
        };
      }
      return {
        reserved: true as const,
        value: input.insert(),
        blockers: [] as string[]
      };
    });
  } catch (error) {
    return {
      reserved: false as const,
      value: null,
      blockers: ["SUBMIT_RESERVATION_FAILED"],
      error: error instanceof Error ? error.message : "Paper reservation failed."
    };
  }
};

export const reserveReviewedPaperExecution = (
  input: ReviewedPaperExecutionReservationInput
) => {
  const result = reserveReviewedPaperExecutions({ inputs: [input] });
  return {
    reserved: result.reserved,
    entry: result.entries[0] ?? result.existing ?? null,
    blockers: result.blockers,
    ...("error" in result && result.error ? { error: result.error } : {})
  };
};

export const reserveReviewedPaperExecutions = (
  input: ReviewedPaperExecutionReservationBatch
) => {
  try {
    return withImmediateLedgerTransaction(() => {
      const seenClients = new Set<string>();
      const seenDedupeKeys = new Set<string>();
      for (const row of input.inputs) {
        const existingByClient = findPaperExecutionByClientOrderId(row.clientOrderId);
        const existingByDedupe = findPaperExecutionByDedupeKey(row.dedupeKey);
        if (
          existingByClient ||
          existingByDedupe ||
          seenClients.has(row.clientOrderId) ||
          seenDedupeKeys.has(row.dedupeKey)
        ) {
          return {
            reserved: false as const,
            entries: [] as PaperExecutionLedgerEntry[],
            existing: existingByClient ?? existingByDedupe ?? null,
            blockers: ["SUBMIT_DUPLICATE_ORDER_OR_RESERVATION"]
          };
        }
        seenClients.add(row.clientOrderId);
        seenDedupeKeys.add(row.dedupeKey);
      }
      const guardBlockers = [...new Set(input.validateBeforeInsert?.() ?? [])];
      if (guardBlockers.length) {
        return {
          reserved: false as const,
          entries: [] as PaperExecutionLedgerEntry[],
          existing: null,
          blockers: guardBlockers
        };
      }
      const entries = input.inputs.map((row) =>
        insertPaperExecutionLedgerEntry({
          mode: "reviewedConfirmPaper",
          assetClass: row.assetClass,
          symbol: row.symbol,
          side: row.side,
          orderType: row.orderType,
          timeInForce: row.timeInForce,
          qty: row.qty ?? null,
          notional: row.notional ?? null,
          limitPrice: row.limitPrice ?? null,
          estimatedPremium: row.estimatedPremium ?? null,
          maxRisk: row.maxRisk ?? null,
          dedupeKey: row.dedupeKey,
          clientOrderId: row.clientOrderId,
          status: "reserved",
          sourcePlanId: row.sourcePlanId,
          sourceCandidateId: row.sourceCandidateId,
          decisionId: row.decisionId,
          decisionLinkageStatus: "EXACT",
          payload: {
            artifactId: row.sourcePlanId,
            section: row.section,
            payloadIndex: row.payloadIndex,
            reviewedPayload: row.payload
          },
          rawPayload: row.rawPayload
        })
      );
      return {
        reserved: true as const,
        entries,
        existing: null,
        blockers: [] as string[]
      };
    });
  } catch (error) {
    let existing: PaperExecutionLedgerEntry | null = null;
    try {
      existing = input.inputs[0]
        ? findPaperExecutionByClientOrderId(input.inputs[0].clientOrderId)
        : null;
    } catch {
      // The reservation failure remains authoritative when the ledger is unavailable.
    }
    return {
      reserved: false as const,
      entries: [] as PaperExecutionLedgerEntry[],
      existing,
      blockers: ["SUBMIT_RESERVATION_FAILED"],
      error: error instanceof Error ? error.message : "Paper reservation failed."
    };
  }
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
  validateBeforeInsert?: () => string[];
  consumeReview?: boolean;
}) => {
  const mode = input.mode ?? "hedge-entry";
  const side = input.side ?? "buy";
  const positionIntent = input.positionIntent ?? "buy_to_open";
  try {
    return withImmediateLedgerTransaction(() => {
      const existing = findPaperExecutionByClientOrderId(input.clientOrderId);
      if (existing) {
        return {
          reserved: false as const,
          entry: existing,
          blockers: ["HEDGE_DUPLICATE_ORDER"]
        };
      }
      const guardBlockers = [...new Set(input.validateBeforeInsert?.() ?? [])];
      if (guardBlockers.length) {
        return {
          reserved: false as const,
          entry: null,
          blockers: guardBlockers
        };
      }
      if (input.consumeReview) {
        const consumed = getDb()
          .prepare(
            `UPDATE hedge_execution_reviews
             SET status = 'consumed'
             WHERE review_id = ? AND status = 'reviewed'`
          )
          .run(input.reviewId);
        if (Number(consumed.changes) !== 1) {
          return {
            reserved: false as const,
            entry: null,
            blockers: ["HEDGE_REVIEW_ALREADY_CONSUMED"]
          };
        }
      }
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
    });
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
