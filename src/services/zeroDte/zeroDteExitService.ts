import { canonicalJsonHash } from "../../lib/canonicalJson.js";
import { getDb } from "../../lib/db.js";
import { redactSensitiveText } from "../../lib/securityRedaction.js";
import {
  getPaperOrder,
  type AlpacaApiResponse,
  type AlpacaSubmittedOrder
} from "../alpacaClient.js";
import {
  buildPaperExitExecutionResult,
  type PaperExitExecutionInput
} from "../paperExitExecutionService.js";
import {
  findPaperExecutionByClientOrderId,
  insertPaperExecutionLedgerEntry,
  updatePaperExecutionLedgerEntry,
  type PaperExecutionLedgerStatus
} from "../paperExecutionLedgerService.js";
import {
  buildPaperExitReviewResult,
  type PaperExitReviewInput
} from "../paperExitReviewService.js";
import type {
  PaperExitExecutionResult,
  PaperExitReviewCandidate,
  PaperExitReviewResult
} from "../../types/paperExit.js";
import type { DecisionId } from "../../types.js";
import { parseOptionSymbol } from "../optionSymbolService.js";
import { getTradingSafetyState } from "../tradingSafetyService.js";
import {
  insertZeroDteLifecycleEventRow,
  serializeZeroDteJson,
  type ZeroDteLifecycleEventType
} from "./zeroDteLifecycleService.js";
import { runInZeroDtePersistenceTransaction } from "./zeroDtePersistenceService.js";
import type { ZeroDteRuntimeSnapshot } from "./zeroDteTypes.js";

export interface ZeroDteExitProvider {
  review?: (input: PaperExitReviewInput) => Promise<PaperExitReviewResult>;
  execute?: (input: PaperExitExecutionInput) => Promise<PaperExitExecutionResult>;
  runtime?: ZeroDteRuntimeSnapshot | (() => ZeroDteRuntimeSnapshot);
  getOrder?: typeof getPaperOrder;
  clock?: () => string;
}

export interface ZeroDteExitLink {
  symbol: string;
  paperTradeId: string | null;
  candidateId: string | null;
  decisionId: string | null;
  brokerOrderId: string | null;
  clientOrderId: string | null;
  status: string | null;
  reasonCode: string | null;
}

export type ZeroDteExitReviewStatus =
  | "review_only"
  | "no_op"
  | "blocked"
  | "submitted"
  | "warning"
  | "error";

export interface ZeroDteExitReviewResult {
  paperOnly: true;
  status: ZeroDteExitReviewStatus;
  generatedAt: string;
  tradingDate: string;
  review: PaperExitReviewResult;
  execution: PaperExitExecutionResult | null;
  exitCandidates: PaperExitReviewCandidate[];
  links: ZeroDteExitLink[];
  blockers: string[];
}

export interface ZeroDteExitReconciliationResult {
  paperOnly: true;
  checked: number;
  updated: number;
  filled: number;
  partial: number;
  terminal: number;
  partialTerminal: number;
  linkageUpdated: number;
  outcomesRecorded: number;
  errors: Array<{ code: string; message: string; paperTradeId?: string }>;
}

interface ZeroDteExitTradeRow {
  paper_trade_id: string;
  candidate_id: string;
  decision_id: DecisionId;
  decision_group_id: string;
  engine_run_id: string;
  strategy_version: string;
  configuration_version_id: string;
  market_timestamp: string | null;
  trading_date: string;
  underlying_symbol: string;
  option_symbol: string;
  quantity: number;
  entry_premium: number | null;
  fees: number;
  mfe: number | null;
  mae: number | null;
  filled_at: string | null;
  exit_reason_code: string | null;
}

interface ExitOrderDetails {
  brokerOrderId: string;
  clientOrderId: string;
  requestId: string | null;
  status: string | null;
  occurredAt: string;
}

type ExitBrokerState = {
  kind: "pending" | "partial" | "filled" | "terminal";
  brokerStatus: string;
  requestedQuantity: number;
  filledQuantity: number;
  fillPrice: number | null;
  filledAt: string | null;
};

const dateOnly = (value: string) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toISOString().slice(0, 10)
    : value.slice(0, 10);
};

const normalizedSymbol = (value: unknown) => String(value || "").trim().toUpperCase();

const sameSessionZeroDte = (candidate: PaperExitReviewCandidate, tradingDate: string) => {
  if (candidate.positionClass !== "option_0dte" || candidate.assetClass !== "us_option") return false;
  const parsed = parseOptionSymbol(candidate.symbol);
  return parsed.ok && parsed.expirationDate === tradingDate;
};

const reviewInput = (): PaperExitReviewInput => ({
  includeEquities: false,
  includeOptions: true,
  include0DTE: true,
  includeLEAPS: false,
  format: "json"
});

const safeString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizedStatus = (value: unknown) => String(value || "").trim().toLowerCase();

const roundMoney = (value: number) => Math.round(value * 100) / 100;

const roundRatio = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

const recordValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const runtimeValue = (
  value: ZeroDteExitProvider["runtime"]
): ZeroDteRuntimeSnapshot => {
  if (typeof value === "function") return value();
  if (value) return value;
  const state = getTradingSafetyState();
  return {
    environment: state.alpacaEnv,
    tradingMode: String(process.env.TRADING_MODE || "paper").toLowerCase(),
    paperOnly: state.paperOnly,
    liveTradingEnabled: state.liveTradingEnabled,
    engineEnabled: false,
    paperExecutionEnabled: false,
    paperOptionsExecutionEnabled: false,
    automatedPaperExecutionEnabled: false
  };
};

const initialLedgerStatus = (value: unknown): PaperExecutionLedgerStatus => {
  const status = normalizedStatus(value);
  if (status === "accepted") return "accepted";
  if (status === "rejected") return "rejected";
  return "submitted";
};

const reconciledLedgerStatus = (
  state: ExitBrokerState
): PaperExecutionLedgerStatus => {
  if (state.kind === "filled") return "filled";
  if (state.kind === "partial") return "partial";
  if (state.kind === "pending") {
    return state.brokerStatus === "accepted" ? "accepted" : "submitted";
  }
  if (state.brokerStatus === "canceled") return "canceled";
  if (state.brokerStatus === "expired") return "expired";
  if (state.brokerStatus === "rejected") return "rejected";
  return "failed";
};

const paperTradeForSymbol = (symbol: string, tradingDate: string) => getDb().prepare(
  `SELECT zero_dte_paper_trades.paper_trade_id,
          zero_dte_paper_trades.candidate_id,
          zero_dte_paper_trades.decision_id,
          zero_dte_paper_trades.trading_date,
          zero_dte_paper_trades.underlying_symbol,
          zero_dte_paper_trades.option_symbol,
          zero_dte_paper_trades.quantity,
          zero_dte_paper_trades.entry_premium,
          zero_dte_paper_trades.fees,
          zero_dte_paper_trades.mfe,
          zero_dte_paper_trades.mae,
          zero_dte_paper_trades.filled_at,
          zero_dte_paper_trades.exit_reason_code,
          zero_dte_decisions.decision_group_id,
          zero_dte_decisions.engine_run_id,
          zero_dte_decisions.strategy_version,
          zero_dte_decisions.configuration_version_id,
          zero_dte_decisions.market_timestamp
   FROM zero_dte_paper_trades
   JOIN zero_dte_decisions USING (decision_id)
   JOIN zero_dte_engine_runs
     ON zero_dte_engine_runs.run_id = zero_dte_decisions.engine_run_id
   WHERE zero_dte_paper_trades.trading_date = ?
     AND UPPER(zero_dte_paper_trades.option_symbol) = UPPER(?)
   ORDER BY zero_dte_paper_trades.updated_at DESC
   LIMIT 1`
).get(tradingDate, symbol) as ZeroDteExitTradeRow | undefined;

const appendExitEvent = (input: {
  eventType: ZeroDteLifecycleEventType;
  trade: NonNullable<ReturnType<typeof paperTradeForSymbol>>;
  occurredAt: string;
  reasonCode: string;
  details: Record<string, unknown>;
}) => {
  const eventId = `zlev_${canonicalJsonHash({
    eventType: input.eventType,
    paperTradeId: input.trade.paper_trade_id,
    brokerOrderId: input.details.brokerOrderId ?? input.details.clientOrderId ?? input.reasonCode,
    filledQuantity: input.details.filledQuantity ?? null,
    outcomeId: input.details.outcomeId ?? null
  }).slice(0, 40)}`;
  const db = getDb();
  if (db.prepare("SELECT event_id FROM zero_dte_lifecycle_events WHERE event_id = ?").get(eventId)) return;
  insertZeroDteLifecycleEventRow(db, {
    eventId,
    eventType: input.eventType,
    reasonCode: input.reasonCode,
    engineRunId: input.trade.engine_run_id,
    candidateId: input.trade.candidate_id,
    decisionId: input.trade.decision_id,
    decisionGroupId: input.trade.decision_group_id,
    paperTradeId: input.trade.paper_trade_id,
    accountMode: "paper",
    strategyVersion: input.trade.strategy_version,
    configurationVersionId: input.trade.configuration_version_id,
    marketTimestamp: input.trade.market_timestamp,
    occurredAt: input.occurredAt,
    details: input.details
  });
};

const ensureExitLedger = (input: {
  trade: ZeroDteExitTradeRow;
  details: ExitOrderDetails;
  status: PaperExecutionLedgerStatus;
  brokerStatus: string | null;
  limitPrice?: number | null;
  estimatedPremium?: number | null;
}) => {
  let entry = findPaperExecutionByClientOrderId(input.details.clientOrderId);
  let linkageChanged = false;
  if (!entry) {
    entry = insertPaperExecutionLedgerEntry({
      mode: "zero-dte-exit",
      assetClass: "option",
      symbol: normalizedSymbol(input.trade.option_symbol),
      underlyingSymbol: normalizedSymbol(input.trade.underlying_symbol),
      strategy: "zero_dte_level_2",
      side: "sell",
      orderType: "limit",
      timeInForce: "day",
      qty: String(input.trade.quantity),
      limitPrice: input.limitPrice === null || input.limitPrice === undefined
        ? null
        : String(input.limitPrice),
      estimatedPremium: input.estimatedPremium ?? null,
      maxRisk: null,
      dedupeKey: `${input.trade.trading_date}:${normalizedSymbol(input.trade.option_symbol)}:exit:${input.trade.paper_trade_id}`,
      clientOrderId: input.details.clientOrderId,
      requestId: input.details.requestId,
      sourcePlanId: input.trade.paper_trade_id,
      sourceCandidateId: input.trade.candidate_id,
      decisionId: input.trade.decision_id,
      decisionLinkageStatus: "EXACT",
      status: input.status,
      payload: {
        paperTradeId: input.trade.paper_trade_id,
        candidateId: input.trade.candidate_id,
        decisionId: input.trade.decision_id,
        symbol: normalizedSymbol(input.trade.option_symbol),
        quantity: input.trade.quantity,
        side: "sell",
        positionIntent: "sell_to_close",
        exitReasonCode: input.trade.exit_reason_code
      }
    });
    linkageChanged = true;
  } else {
    if (entry.mode !== "zero-dte-exit") throw new Error("EXIT_LEDGER_MODE_MISMATCH");
    if (entry.assetClass !== "option") throw new Error("EXIT_LEDGER_ASSET_CLASS_MISMATCH");
    if (normalizedSymbol(entry.symbol) !== normalizedSymbol(input.trade.option_symbol)) {
      throw new Error("EXIT_LEDGER_SYMBOL_MISMATCH");
    }
    if (entry.alpacaOrderId && entry.alpacaOrderId !== input.details.brokerOrderId) {
      throw new Error("EXIT_LEDGER_BROKER_ORDER_ID_MISMATCH");
    }
    const ledgerQuantity = finite(entry.qty);
    if (
      ledgerQuantity === null ||
      !Number.isInteger(ledgerQuantity) ||
      ledgerQuantity !== input.trade.quantity
    ) {
      throw new Error("EXIT_LEDGER_QUANTITY_MISMATCH");
    }
    if (normalizedStatus(entry.side) !== "sell") throw new Error("EXIT_LEDGER_SIDE_MISMATCH");
    if (entry.sourcePlanId !== input.trade.paper_trade_id) {
      throw new Error("EXIT_LEDGER_SOURCE_TRADE_MISMATCH");
    }
    if (entry.sourceCandidateId !== input.trade.candidate_id) {
      throw new Error("EXIT_LEDGER_SOURCE_CANDIDATE_MISMATCH");
    }
    if (entry.decisionId && entry.decisionId !== input.trade.decision_id) {
      throw new Error("EXIT_LEDGER_DECISION_MISMATCH");
    }
    let payload: Record<string, unknown>;
    try {
      payload = recordValue(JSON.parse(entry.payloadJson));
    } catch {
      throw new Error("EXIT_LEDGER_PAYLOAD_INVALID");
    }
    if (
      safeString(payload.paperTradeId) !== input.trade.paper_trade_id ||
      safeString(payload.candidateId) !== input.trade.candidate_id ||
      safeString(payload.decisionId) !== input.trade.decision_id ||
      normalizedSymbol(payload.symbol) !== normalizedSymbol(input.trade.option_symbol) ||
      finite(payload.quantity) !== input.trade.quantity ||
      normalizedStatus(payload.side) !== "sell" ||
      normalizedStatus(payload.positionIntent) !== "sell_to_close"
    ) {
      throw new Error("EXIT_LEDGER_PAYLOAD_MISMATCH");
    }
    if (!entry.decisionId || entry.decisionLinkageStatus !== "EXACT") {
      const result = getDb().prepare(
        `UPDATE paper_execution_ledger
         SET decision_id = ?, decision_linkage_status = 'EXACT', updated_at = ?
         WHERE id = ? AND (decision_id IS NULL OR decision_id = ?)`
      ).run(input.trade.decision_id, new Date().toISOString(), entry.id, input.trade.decision_id);
      if (Number(result.changes) !== 1) throw new Error("EXIT_LEDGER_LINKAGE_MISMATCH");
      linkageChanged = true;
    }
  }
  updatePaperExecutionLedgerEntry(entry.id, {
    status: input.status,
    alpacaOrderId: input.details.brokerOrderId,
    alpacaStatus: input.brokerStatus,
    requestId: input.details.requestId
  });
  return { ledgerId: entry.id, linkageChanged };
};

const exitOrderDetailsForTrade = (paperTradeId: string): ExitOrderDetails => {
  const row = getDb().prepare(
    `SELECT details_json, occurred_at
     FROM zero_dte_lifecycle_events
     WHERE paper_trade_id = ? AND event_type = 'exit_order_requested'
     ORDER BY occurred_at DESC, event_id DESC
     LIMIT 1`
  ).get(paperTradeId) as { details_json: string; occurred_at: string } | undefined;
  if (!row) throw new Error("EXIT_ORDER_LINKAGE_MISSING");
  let details: Record<string, unknown>;
  try {
    details = recordValue(JSON.parse(row.details_json));
  } catch {
    throw new Error("EXIT_ORDER_LINKAGE_INVALID");
  }
  const brokerOrderId = safeString(details.brokerOrderId);
  const clientOrderId = safeString(details.clientOrderId);
  if (!brokerOrderId || !clientOrderId) throw new Error("EXIT_ORDER_IDENTITY_MISSING");
  if (!Number.isFinite(Date.parse(row.occurred_at))) throw new Error("EXIT_ORDER_TIME_INVALID");
  return {
    brokerOrderId,
    clientOrderId,
    requestId: safeString(details.requestId),
    status: safeString(details.status),
    occurredAt: new Date(row.occurred_at).toISOString()
  };
};

const sameExitOrderRequest = (left: ExitOrderDetails, right: ExitOrderDetails) =>
  left.brokerOrderId === right.brokerOrderId &&
  left.clientOrderId === right.clientOrderId &&
  left.requestId === right.requestId &&
  left.occurredAt === right.occurredAt;

const PENDING_EXIT_STATUSES = new Set([
  "new",
  "accepted",
  "pending_new",
  "accepted_for_bidding",
  "pending_replace"
]);

const TERMINAL_EXIT_STATUSES = new Set([
  "canceled",
  "expired",
  "rejected",
  "replaced",
  "done_for_day",
  "stopped",
  "suspended",
  "calculated"
]);

const validatedExitBrokerState = (input: {
  trade: ZeroDteExitTradeRow;
  details: ExitOrderDetails;
  response: AlpacaApiResponse<AlpacaSubmittedOrder>;
  asOf: string;
}): ExitBrokerState => {
  const order = input.response.data;
  if (safeString(order.id) !== input.details.brokerOrderId) {
    throw new Error("EXIT_BROKER_ORDER_ID_MISMATCH");
  }
  if (safeString(order.client_order_id) !== input.details.clientOrderId) {
    throw new Error("EXIT_BROKER_CLIENT_ORDER_ID_MISMATCH");
  }
  if (normalizedSymbol(order.symbol) !== normalizedSymbol(input.trade.option_symbol)) {
    throw new Error("EXIT_BROKER_SYMBOL_MISMATCH");
  }
  if (normalizedStatus(order.side) !== "sell") throw new Error("EXIT_BROKER_SIDE_MISMATCH");
  if (normalizedStatus(order.position_intent) !== "sell_to_close") {
    throw new Error("EXIT_BROKER_POSITION_INTENT_MISMATCH");
  }
  const requestedQuantity = finite(order.qty);
  if (
    requestedQuantity === null ||
    !Number.isInteger(requestedQuantity) ||
    requestedQuantity !== input.trade.quantity ||
    requestedQuantity <= 0
  ) {
    throw new Error("EXIT_BROKER_QUANTITY_MISMATCH");
  }
  const brokerStatus = normalizedStatus(order.status);
  if (!brokerStatus) throw new Error("EXIT_BROKER_STATUS_MISSING");
  const hasFilledQuantity = order.filled_qty !== undefined && order.filled_qty !== null && order.filled_qty !== "";
  const filledQuantity = hasFilledQuantity ? finite(order.filled_qty) : 0;
  if (
    filledQuantity === null ||
    !Number.isInteger(filledQuantity) ||
    filledQuantity < 0 ||
    filledQuantity > requestedQuantity
  ) {
    throw new Error("EXIT_BROKER_FILLED_QUANTITY_INVALID");
  }

  let kind: ExitBrokerState["kind"];
  if (brokerStatus === "filled") {
    if (!hasFilledQuantity || filledQuantity !== requestedQuantity) {
      throw new Error("EXIT_BROKER_FILLED_QUANTITY_INCOMPLETE");
    }
    kind = "filled";
  } else if (brokerStatus === "partially_filled" || brokerStatus === "partial") {
    if (!hasFilledQuantity || filledQuantity <= 0 || filledQuantity >= requestedQuantity) {
      throw new Error("EXIT_BROKER_PARTIAL_QUANTITY_INVALID");
    }
    kind = "partial";
  } else if (PENDING_EXIT_STATUSES.has(brokerStatus)) {
    if (filledQuantity !== 0) throw new Error("EXIT_BROKER_PENDING_HAS_FILL");
    kind = "pending";
  } else if (TERMINAL_EXIT_STATUSES.has(brokerStatus)) {
    if (!hasFilledQuantity) throw new Error("EXIT_BROKER_TERMINAL_QUANTITY_MISSING");
    kind = filledQuantity === requestedQuantity ? "filled" : "terminal";
  } else {
    throw new Error("EXIT_BROKER_STATUS_UNSUPPORTED");
  }

  let fillPrice: number | null = null;
  let filledAt: string | null = null;
  if (filledQuantity > 0) {
    fillPrice = finite(order.filled_avg_price);
    if (fillPrice === null || fillPrice <= 0) throw new Error("EXIT_BROKER_FILL_PRICE_INVALID");
    const timestamp = safeString(order.filled_at);
    if (!timestamp || !Number.isFinite(Date.parse(timestamp))) {
      throw new Error("EXIT_BROKER_FILL_TIME_INVALID");
    }
    filledAt = new Date(timestamp).toISOString();
    const filledAtMs = Date.parse(filledAt);
    const entryFilledAtMs = input.trade.filled_at === null
      ? Number.NaN
      : Date.parse(input.trade.filled_at);
    if (Number.isFinite(entryFilledAtMs) && filledAtMs < entryFilledAtMs) {
      throw new Error("EXIT_BROKER_FILL_BEFORE_ENTRY");
    }
    if (filledAtMs < Date.parse(input.details.occurredAt)) {
      throw new Error("EXIT_BROKER_FILL_BEFORE_EXIT_REQUEST");
    }
    if (filledAtMs > Date.parse(input.asOf)) {
      throw new Error("EXIT_BROKER_FILL_AFTER_RECONCILIATION");
    }
  }
  return {
    kind,
    brokerStatus,
    requestedQuantity,
    filledQuantity,
    fillPrice,
    filledAt
  };
};

const recordPaperExitOutcome = (input: {
  trade: ZeroDteExitTradeRow;
  state: ExitBrokerState;
  details: ExitOrderDetails;
  evaluatedAt: string;
}) => {
  if (input.state.fillPrice === null || input.state.filledAt === null) {
    throw new Error("EXIT_FILL_EVIDENCE_MISSING");
  }
  const entryPremium = input.trade.entry_premium;
  const entryFilledAt = input.trade.filled_at;
  const complete =
    entryPremium !== null &&
    entryPremium > 0 &&
    entryFilledAt !== null &&
    Number.isFinite(Date.parse(entryFilledAt));
  const realizedPnl = complete
    ? roundMoney(
      (input.state.fillPrice - entryPremium) * input.trade.quantity * 100 - input.trade.fees
    )
    : null;
  const entryCost = complete ? entryPremium * input.trade.quantity * 100 : null;
  const returnPct = realizedPnl === null || entryCost === null || entryCost <= 0
    ? null
    : roundRatio((realizedPnl / entryCost) * 100);
  const holdingMinutes = complete && entryFilledAt
    ? Math.round((Date.parse(input.state.filledAt) - Date.parse(entryFilledAt)) / 60_000)
    : null;
  const outcomeType = "paper_trade";
  const outcomeId = `zout_${canonicalJsonHash({
    paperTradeId: input.trade.paper_trade_id,
    outcomeType,
    horizonMinutes: null
  }).slice(0, 40)}`;
  const evidence = {
    source: "zero_dte_paper_exit_reconciliation",
    optionSymbol: normalizedSymbol(input.trade.option_symbol),
    brokerOrderId: input.details.brokerOrderId,
    clientOrderId: input.details.clientOrderId,
    brokerStatus: input.state.brokerStatus,
    filledQuantity: input.state.filledQuantity,
    entryPremium,
    exitPremium: input.state.fillPrice,
    fees: input.trade.fees,
    incompleteReasonCode: complete ? null : "ENTRY_EVIDENCE_INCOMPLETE"
  };
  const evidenceJson = serializeZeroDteJson(evidence);
  const expected = {
    outcome_id: outcomeId,
    candidate_id: input.trade.candidate_id,
    paper_trade_id: input.trade.paper_trade_id,
    shadow_trade_id: null,
    decision_id: input.trade.decision_id,
    trading_date: input.trade.trading_date,
    outcome_type: outcomeType,
    horizon_minutes: null,
    terminal_state: "closed",
    terminal_price: input.state.fillPrice,
    mfe: input.trade.mfe,
    mae: input.trade.mae,
    realized_pnl: realizedPnl,
    return_pct: returnPct,
    holding_minutes: holdingMinutes,
    exit_reason_code: input.trade.exit_reason_code,
    completeness_status: complete ? "complete" : "incomplete",
    evidence_json: evidenceJson
  };
  const existing = getDb().prepare(
    `SELECT outcome_id, candidate_id, paper_trade_id, shadow_trade_id,
            decision_id, trading_date, outcome_type, horizon_minutes,
            terminal_state, terminal_price, mfe, mae, realized_pnl,
            return_pct, holding_minutes, exit_reason_code,
            completeness_status, evidence_json
     FROM zero_dte_terminal_outcomes
     WHERE outcome_id = ?
        OR (paper_trade_id = ? AND outcome_type = ? AND horizon_minutes IS NULL)
     LIMIT 1`
  ).get(outcomeId, input.trade.paper_trade_id, outcomeType) as Record<string, unknown> | undefined;
  if (existing) {
    const keys = Object.keys(expected) as Array<keyof typeof expected>;
    const matches = keys.every((key) => {
      if (key === "evidence_json") {
        try {
          return canonicalJsonHash(JSON.parse(String(existing[key]))) ===
            canonicalJsonHash(JSON.parse(expected[key]));
        } catch {
          return false;
        }
      }
      return existing[key] === expected[key];
    });
    if (!matches) throw new Error("EXIT_TERMINAL_OUTCOME_MISMATCH");
    return {
      inserted: false,
      realizedPnl,
      returnPct,
      holdingMinutes,
      outcomeId
    };
  }
  const result = getDb().prepare(
    `INSERT INTO zero_dte_terminal_outcomes
      (outcome_id, candidate_id, paper_trade_id, decision_id, trading_date,
       outcome_type, horizon_minutes, terminal_state, terminal_price, mfe, mae,
       realized_pnl, return_pct, holding_minutes, exit_reason_code,
       completeness_status, evaluated_at, evidence_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 'closed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    outcomeId,
    input.trade.candidate_id,
    input.trade.paper_trade_id,
    input.trade.decision_id,
    input.trade.trading_date,
    outcomeType,
    input.state.fillPrice,
    input.trade.mfe,
    input.trade.mae,
    realizedPnl,
    returnPct,
    holdingMinutes,
    input.trade.exit_reason_code,
    complete ? "complete" : "incomplete",
    input.evaluatedAt,
    evidenceJson,
    input.evaluatedAt
  );
  return {
    inserted: Number(result.changes) === 1,
    realizedPnl,
    returnPct,
    holdingMinutes,
    outcomeId
  };
};

const linkExecution = (input: {
  execution: PaperExitExecutionResult;
  candidates: PaperExitReviewCandidate[];
  tradingDate: string;
  now: string;
}): ZeroDteExitLink[] => {
  const links: ZeroDteExitLink[] = [];
  const bySymbol = new Map(input.candidates.map((candidate) => [normalizedSymbol(candidate.symbol), candidate]));
  for (const order of input.execution.submittedOrders) {
    const symbol = normalizedSymbol(order.symbol);
    const candidate = bySymbol.get(symbol);
    if (!candidate) continue;
    const trade = paperTradeForSymbol(symbol, input.tradingDate);
    const link: ZeroDteExitLink = {
      symbol,
      paperTradeId: trade?.paper_trade_id ?? null,
      candidateId: trade?.candidate_id ?? null,
      decisionId: trade?.decision_id ?? null,
      brokerOrderId: safeString(order.alpacaOrderId),
      clientOrderId: safeString(order.clientOrderId),
      status: safeString(order.status),
      reasonCode: safeString(order.reason)
    };
    links.push(link);
    if (!trade) continue;
    appendExitEvent({
      eventType: "exit_triggered",
      trade,
      occurredAt: input.now,
      reasonCode: order.reason,
      details: {
        currentPrice: candidate.currentPrice,
        positionClass: candidate.positionClass,
        brokerOrderId: order.alpacaOrderId ?? null,
        clientOrderId: order.clientOrderId ?? null
      }
    });
    getDb().prepare(
      `UPDATE zero_dte_paper_trades
       SET status = 'exit_requested', exit_requested_at = ?,
           exit_reason_code = ?, updated_at = ?
       WHERE paper_trade_id = ?`
    ).run(input.now, order.reason, input.now, trade.paper_trade_id);
    const details: ExitOrderDetails | null = link.brokerOrderId && link.clientOrderId
      ? {
        brokerOrderId: link.brokerOrderId,
        clientOrderId: link.clientOrderId,
        requestId: safeString(order.alpacaRequestId),
        status: link.status,
        occurredAt: new Date(input.now).toISOString()
      }
      : null;
    let ledgerId: number | null = null;
    if (details) {
      try {
        const ledger = ensureExitLedger({
          trade,
          details,
          status: initialLedgerStatus(order.status),
          brokerStatus: link.status,
          limitPrice: finite(candidate.orderPayload.limitPrice),
          estimatedPremium: finite(candidate.currentPrice) === null
            ? null
            : roundMoney(Number(candidate.currentPrice) * trade.quantity * 100)
        });
        ledgerId = ledger.ledgerId;
      } catch {
        // Preserve the broker-order identity in the lifecycle event so the
        // read-only reconciliation pass can retry exact ledger linkage.
      }
    }
    appendExitEvent({
      eventType: "exit_order_requested",
      trade,
      occurredAt: input.now,
      reasonCode: order.reason,
      details: {
        brokerOrderId: order.alpacaOrderId ?? null,
        clientOrderId: order.clientOrderId ?? null,
        requestId: order.alpacaRequestId ?? null,
        status: order.status ?? null,
        ledgerId,
        ledgerLinkageStatus: ledgerId === null ? "PENDING_RECONCILIATION" : "EXACT"
      }
    });
  }
  return links;
};

export const reconcileZeroDteExitOrders = async (input: {
  now?: string;
  provider?: Pick<ZeroDteExitProvider, "runtime" | "getOrder" | "clock">;
} = {}): Promise<ZeroDteExitReconciliationResult> => {
  const initialAsOf = new Date(input.now ?? new Date().toISOString()).toISOString();
  const provider = input.provider ?? {};
  const result: ZeroDteExitReconciliationResult = {
    paperOnly: true,
    checked: 0,
    updated: 0,
    filled: 0,
    partial: 0,
    terminal: 0,
    partialTerminal: 0,
    linkageUpdated: 0,
    outcomesRecorded: 0,
    errors: []
  };
  const rows = getDb().prepare(
    `SELECT t.paper_trade_id, t.candidate_id, t.decision_id, t.trading_date,
            t.underlying_symbol, t.option_symbol, t.quantity, t.entry_premium,
            t.fees, t.mfe, t.mae, t.filled_at, t.exit_reason_code,
            d.decision_group_id, d.engine_run_id, d.strategy_version,
            d.configuration_version_id, d.market_timestamp
     FROM zero_dte_paper_trades AS t
     JOIN zero_dte_decisions AS d ON d.decision_id = t.decision_id
     WHERE t.status = 'exit_requested'
     ORDER BY t.exit_requested_at, t.paper_trade_id`
  ).all() as unknown as ZeroDteExitTradeRow[];
  if (!rows.length) return result;

  const runtime = runtimeValue(provider.runtime);
  if (
    !runtime.paperOnly ||
    runtime.environment !== "paper" ||
    runtime.tradingMode !== "paper" ||
    runtime.liveTradingEnabled
  ) {
    result.errors.push({
      code: "ACCOUNT_NOT_PAPER",
      message: "0DTE exit reconciliation is disabled outside the paper-only runtime."
    });
    return result;
  }

  const getOrder = provider.getOrder?.bind(provider) ?? getPaperOrder;
  for (const trade of rows) {
    result.checked += 1;
    try {
      const details = exitOrderDetailsForTrade(trade.paper_trade_id);
      const response = await getOrder(details.brokerOrderId);
      const responseObservedAt = new Date(provider.clock?.() ?? new Date().toISOString()).toISOString();
      const observedAt = Date.parse(responseObservedAt) >= Date.parse(initialAsOf)
        ? responseObservedAt
        : initialAsOf;
      const state = validatedExitBrokerState({ trade, details, response, asOf: observedAt });
      const applied = runInZeroDtePersistenceTransaction(() => {
        const current = getDb().prepare(
          "SELECT status, exit_requested_at FROM zero_dte_paper_trades WHERE paper_trade_id = ?"
        ).get(trade.paper_trade_id) as { status: string; exit_requested_at: string | null } | undefined;
        if (!current) throw new Error("EXIT_TRADE_NOT_FOUND");
        if (current.status === "closed") return { updated: false, outcomeInserted: false, linkageChanged: false };
        if (current.status !== "exit_requested") throw new Error("EXIT_TRADE_STATE_CHANGED");
        const currentDetails = exitOrderDetailsForTrade(trade.paper_trade_id);
        const currentExitRequestedAt = current.exit_requested_at === null ||
          !Number.isFinite(Date.parse(current.exit_requested_at))
          ? null
          : new Date(current.exit_requested_at).toISOString();
        if (
          !sameExitOrderRequest(details, currentDetails) ||
          currentExitRequestedAt !== currentDetails.occurredAt
        ) {
          throw new Error("EXIT_ORDER_REQUEST_CHANGED");
        }
        const priorFill = getDb().prepare(
          `SELECT MAX(CAST(json_extract(details_json, '$.filledQuantity') AS INTEGER)) AS quantity
           FROM zero_dte_lifecycle_events
           WHERE paper_trade_id = ?
             AND event_type IN ('paper_order_partially_filled', 'paper_order_filled')
             AND json_extract(details_json, '$.action') = 'exit'`
        ).get(trade.paper_trade_id) as { quantity: number | null };
        if (priorFill.quantity !== null && state.filledQuantity < Number(priorFill.quantity)) {
          throw new Error("EXIT_BROKER_FILL_QUANTITY_REGRESSION");
        }

        const ledger = ensureExitLedger({
          trade,
          details,
          status: reconciledLedgerStatus(state),
          brokerStatus: state.brokerStatus
        });
        if (state.kind === "pending") {
          return { updated: false, outcomeInserted: false, linkageChanged: ledger.linkageChanged };
        }
        if (state.kind === "partial" || (state.kind === "terminal" && state.filledQuantity > 0)) {
          updatePaperExecutionLedgerEntry(ledger.ledgerId, {
            status: "partial",
            alpacaOrderId: details.brokerOrderId,
            alpacaStatus: state.brokerStatus,
            requestId: response.requestId ?? details.requestId
          });
          appendExitEvent({
            eventType: "paper_order_partially_filled",
            trade,
            occurredAt: state.filledAt ?? observedAt,
            reasonCode: "EXIT_ORDER_PARTIALLY_FILLED",
            details: {
              action: "exit",
              brokerOrderId: details.brokerOrderId,
              clientOrderId: details.clientOrderId,
              brokerStatus: state.brokerStatus,
              filledQuantity: state.filledQuantity,
              filledAveragePrice: state.fillPrice
            }
          });
          return { updated: true, outcomeInserted: false, linkageChanged: ledger.linkageChanged };
        }
        if (state.kind === "terminal") {
          const ledgerStatus = reconciledLedgerStatus(state);
          updatePaperExecutionLedgerEntry(ledger.ledgerId, {
            status: ledgerStatus,
            alpacaOrderId: details.brokerOrderId,
            alpacaStatus: state.brokerStatus,
            requestId: response.requestId ?? details.requestId,
            reason: `EXIT_ORDER_${state.brokerStatus.toUpperCase()}`
          });
          const update = getDb().prepare(
            `UPDATE zero_dte_paper_trades
             SET status = 'open', exit_requested_at = NULL,
                 terminal_state = NULL, updated_at = ?
             WHERE paper_trade_id = ? AND status = 'exit_requested'`
          ).run(observedAt, trade.paper_trade_id);
          if (Number(update.changes) !== 1) throw new Error("EXIT_TRADE_TERMINAL_UPDATE_FAILED");
          appendExitEvent({
            eventType: state.brokerStatus === "rejected" ? "paper_order_rejected" : "paper_order_canceled",
            trade,
            occurredAt: observedAt,
            reasonCode: `EXIT_ORDER_${state.brokerStatus.toUpperCase()}`,
            details: {
              action: "exit",
              brokerOrderId: details.brokerOrderId,
              clientOrderId: details.clientOrderId,
              brokerStatus: state.brokerStatus,
              filledQuantity: 0
            }
          });
          return { updated: true, outcomeInserted: false, linkageChanged: ledger.linkageChanged };
        }
        if (state.fillPrice === null || state.filledAt === null) {
          throw new Error("EXIT_FILL_EVIDENCE_MISSING");
        }
        const outcome = recordPaperExitOutcome({ trade, state, details, evaluatedAt: observedAt });
        const update = getDb().prepare(
          `UPDATE zero_dte_paper_trades
           SET status = 'closed', exit_premium = ?, exited_at = ?,
               realized_pnl = ?, return_pct = ?, terminal_state = 'closed',
               updated_at = ?
           WHERE paper_trade_id = ? AND status = 'exit_requested'`
        ).run(
          state.fillPrice,
          state.filledAt,
          outcome.realizedPnl,
          outcome.returnPct,
          observedAt,
          trade.paper_trade_id
        );
        if (Number(update.changes) !== 1) throw new Error("EXIT_TRADE_CLOSE_UPDATE_FAILED");
        appendExitEvent({
          eventType: "paper_order_filled",
          trade,
          occurredAt: state.filledAt,
          reasonCode: "EXIT_ORDER_FILLED",
          details: {
            action: "exit",
            brokerOrderId: details.brokerOrderId,
            clientOrderId: details.clientOrderId,
            brokerStatus: state.brokerStatus,
            filledQuantity: state.filledQuantity,
            filledAveragePrice: state.fillPrice
          }
        });
        appendExitEvent({
          eventType: "position_closed",
          trade,
          occurredAt: state.filledAt,
          reasonCode: trade.exit_reason_code ?? "EXIT_ORDER_FILLED",
          details: {
            brokerOrderId: details.brokerOrderId,
            clientOrderId: details.clientOrderId,
            exitPremium: state.fillPrice,
            filledQuantity: state.filledQuantity,
            realizedPnl: outcome.realizedPnl,
            returnPct: outcome.returnPct
          }
        });
        appendExitEvent({
          eventType: "terminal_outcome_recorded",
          trade,
          occurredAt: observedAt,
          reasonCode: trade.exit_reason_code ?? "EXIT_ORDER_FILLED",
          details: {
            brokerOrderId: details.brokerOrderId,
            outcomeId: outcome.outcomeId,
            outcomeType: "paper_trade",
            completenessStatus: outcome.realizedPnl === null ? "incomplete" : "complete"
          }
        });
        return {
          updated: true,
          outcomeInserted: outcome.inserted,
          linkageChanged: ledger.linkageChanged
        };
      });

      if (applied.linkageChanged) result.linkageUpdated += 1;
      if (applied.updated) result.updated += 1;
      if (applied.outcomeInserted) result.outcomesRecorded += 1;
      if (state.kind === "filled") result.filled += 1;
      if (state.kind === "partial") result.partial += 1;
      if (state.kind === "terminal") {
        result.terminal += 1;
        if (state.filledQuantity > 0) {
          result.partialTerminal += 1;
          result.errors.push({
            code: "EXIT_PARTIAL_TERMINAL_REQUIRES_REVIEW",
            message: "A terminal 0DTE exit order has a partial fill and remains fail-closed for manual reconciliation.",
            paperTradeId: trade.paper_trade_id
          });
        }
      }
    } catch (error) {
      result.errors.push({
        code: "EXIT_ORDER_RECONCILIATION_FAILED",
        message: redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 500),
        paperTradeId: trade.paper_trade_id
      });
    }
  }
  return result;
};

export const reviewZeroDteExits = async (input: {
  now?: string;
  confirmPaper: boolean;
  provider?: ZeroDteExitProvider;
}): Promise<ZeroDteExitReviewResult> => {
  const generatedAt = input.now ?? new Date().toISOString();
  const tradingDate = dateOnly(generatedAt);
  const provider = input.provider ?? {};
  const requested = reviewInput();
  const review = await (provider.review ?? ((value) => buildPaperExitReviewResult(value)))(requested);
  const exitCandidates = review.exitCandidates.filter((candidate) => sameSessionZeroDte(candidate, tradingDate));
  const scopedReview: PaperExitReviewResult = {
    ...review,
    exitCandidates
  };
  if (review.environment !== "paper" || review.status === "blocked") {
    return {
      paperOnly: true,
      status: "blocked",
      generatedAt,
      tradingDate,
      review: scopedReview,
      execution: null,
      exitCandidates,
      links: [],
      blockers: [review.blockReason ?? "PAPER_EXIT_REVIEW_BLOCKED"]
    };
  }
  if (!exitCandidates.length) {
    return {
      paperOnly: true,
      status: "no_op",
      generatedAt,
      tradingDate,
      review: scopedReview,
      execution: null,
      exitCandidates,
      links: [],
      blockers: []
    };
  }
  if (!input.confirmPaper) {
    return {
      paperOnly: true,
      status: "review_only",
      generatedAt,
      tradingDate,
      review: scopedReview,
      execution: null,
      exitCandidates,
      links: [],
      blockers: ["CONFIRM_PAPER_REQUIRED"]
    };
  }

  const executionInput: PaperExitExecutionInput = { ...requested, confirmPaper: true };
  const execution = await (provider.execute ?? ((value) => buildPaperExitExecutionResult(value)))(executionInput);
  const links = linkExecution({ execution, candidates: exitCandidates, tradingDate, now: generatedAt });
  const status: ZeroDteExitReviewStatus = execution.status === "ok"
    ? "submitted"
    : execution.status === "warning"
      ? "warning"
      : execution.status === "blocked"
        ? "blocked"
        : "error";
  return {
    paperOnly: true,
    status,
    generatedAt,
    tradingDate,
    review: scopedReview,
    execution,
    exitCandidates,
    links,
    blockers: execution.blockedReason ? [execution.blockedReason] : []
  };
};
