import type { DatabaseSync } from "node:sqlite";

import { canonicalJsonHash } from "../../lib/canonicalJson.js";
import { getDb } from "../../lib/db.js";
import { nowIso } from "../../lib/utils.js";
import { parseOptionSymbol } from "../optionSymbolService.js";
import { loadZeroDteConfig } from "./zeroDteConfigService.js";
import {
  insertZeroDteLifecycleEventRow,
  serializeZeroDteJson,
  type ZeroDteLifecycleEventType
} from "./zeroDteLifecycleService.js";
import type { ZeroDteOptionQuote } from "./zeroDteMarketDataService.js";
import type { ZeroDteQueueCandidate } from "./zeroDtePersistenceService.js";

const OPTION_MULTIPLIER = 100;
const DEFAULT_SHADOW_SLIPPAGE = 0.05;
const DEFAULT_SHADOW_FEE_PER_CONTRACT = 0.65;
const MAX_FUTURE_QUOTE_MS = 5_000;

const SHADOWABLE_STATES = new Set([
  "eligible",
  "selected",
  "skipped",
  "rejected",
  "shadowed"
]);

const HARD_SHADOW_BLOCKERS = new Set([
  "BELOW_SCORE_THRESHOLD",
  "CROSSED_QUOTE",
  "INVALID_QUOTE",
  "LOW_OPEN_INTEREST",
  "LOW_VOLUME",
  "MISSING_GREEKS",
  "MISSING_QUOTE",
  "QUOTE_MISSING",
  "STALE_QUOTE",
  "WIDE_SPREAD"
]);

export type ZeroDteShadowQuoteStatus = "valid" | "missing" | "invalid" | "stale";

export interface ZeroDteNormalizedShadowQuote {
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  quoteTimestamp: string | null;
  status: ZeroDteShadowQuoteStatus;
  reasonCode: string | null;
}

export interface ZeroDteShadowTrade {
  shadowTradeId: string;
  decisionGroupId: string;
  decisionId: string | null;
  candidateId: string;
  tradingDate: string;
  underlyingSymbol: string;
  optionSymbol: string;
  playbook: string;
  direction: string;
  alternativeType: string;
  status: string;
  quantity: number;
  entryPremium: number | null;
  exitPremium: number | null;
  fees: number;
  slippage: number;
  mfe: number | null;
  mae: number | null;
  realizedPnl: number | null;
  returnPct: number | null;
  terminalState: string | null;
  fillAssumptions: Record<string, unknown>;
  entryQuote: Record<string, unknown> | null;
  exitQuote: Record<string, unknown> | null;
  exitReasonCode: string | null;
  openedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ZeroDteShadowMark {
  markId: string;
  shadowTradeId: string;
  candidateId: string;
  markedAt: string;
  marketTimestamp: string | null;
  markPrice: number | null;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  quoteQuality: ZeroDteShadowQuoteStatus;
  quantity: number;
  unrealizedPnl: number | null;
  returnPct: number | null;
  mfe: number | null;
  mae: number | null;
  source: string;
  evidence: Record<string, unknown>;
}

export interface ZeroDteMarkResult {
  paperOnly: true;
  marked: ZeroDteShadowMark[];
  blocked: Array<{
    shadowTradeId: string;
    candidateId: string;
    reasonCode: string;
  }>;
  closed: ZeroDteShadowTrade[];
}

type ShadowQuoteInput = ZeroDteOptionQuote & Record<string, unknown>;

const finiteNumber = (value: unknown): number | null => {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};

const roundMoney = (value: number) => Math.round(value * 100) / 100;

const requiredText = (value: unknown, field: string) => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`0DTE shadow ${field} is required`);
  }
  return value.trim();
};

const isoTimestamp = (value: string, field: string) => {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new RangeError(`0DTE shadow ${field} must be a valid timestamp`);
  }
  return new Date(time).toISOString();
};

export const readZeroDteShadowAssumptions = () => {
  const config = loadZeroDteConfig();
  return {
    slippage: config.shadowSlippage,
    feePerContract: config.shadowFeePerContract,
    maxQuoteAgeMs: config.shadowMaxQuoteAgeMs
  };
};

const shadowSlippage = () => readZeroDteShadowAssumptions().slippage;

const shadowFeePerContract = () => readZeroDteShadowAssumptions().feePerContract;

const maxQuoteAgeMs = () => readZeroDteShadowAssumptions().maxQuoteAgeMs;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const parseJsonRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
};

const withTransaction = <T>(db: DatabaseSync, operation: () => T): T => {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = operation();
    db.exec("COMMIT;");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the original database error.
    }
    throw error;
  }
};

const readQuoteField = (quote: ShadowQuoteInput, key: string, alternateKey?: string) =>
  finiteNumber(quote[key] ?? (alternateKey ? quote[alternateKey] : undefined));

export const normalizeZeroDteShadowQuote = (
  input: ZeroDteOptionQuote | null | undefined,
  asOf: string
): ZeroDteNormalizedShadowQuote => {
  const quote = asRecord(input) as ShadowQuoteInput;
  const latestQuote = asRecord(quote.latestQuote);
  const quoteTimestampValue =
    quote.quoteTimestamp ?? quote.snapshotTimestamp ?? latestQuote.timestamp ?? null;
  const quoteTimestamp =
    typeof quoteTimestampValue === "string" && Number.isFinite(Date.parse(quoteTimestampValue))
      ? new Date(Date.parse(quoteTimestampValue)).toISOString()
      : null;
  if (!input) {
    return {
      bid: null,
      ask: null,
      midpoint: null,
      quoteTimestamp,
      status: "missing",
      reasonCode: "QUOTE_MISSING"
    };
  }

  const bid = readQuoteField(quote, "bid", "bidPrice") ?? finiteNumber(latestQuote.bidPrice);
  const ask = readQuoteField(quote, "ask", "askPrice") ?? finiteNumber(latestQuote.askPrice);
  const suppliedMidpoint = readQuoteField(quote, "midpoint");
  if (bid === null || ask === null) {
    return {
      bid,
      ask,
      midpoint: suppliedMidpoint,
      quoteTimestamp,
      status: "missing",
      reasonCode: "QUOTE_MISSING"
    };
  }
  if (bid <= 0 || ask <= 0 || ask < bid) {
    return {
      bid,
      ask,
      midpoint: suppliedMidpoint,
      quoteTimestamp,
      status: "invalid",
      reasonCode: ask < bid ? "CROSSED_QUOTE" : "INVALID_QUOTE"
    };
  }

  const midpoint = suppliedMidpoint ?? (bid + ask) / 2;
  if (midpoint <= 0 || midpoint < bid || midpoint > ask) {
    return {
      bid,
      ask,
      midpoint,
      quoteTimestamp,
      status: "invalid",
      reasonCode: "INVALID_QUOTE"
    };
  }

  if (quoteTimestamp) {
    const age = Date.parse(asOf) - Date.parse(quoteTimestamp);
    if (age > maxQuoteAgeMs() || age < -MAX_FUTURE_QUOTE_MS) {
      return {
        bid,
        ask,
        midpoint,
        quoteTimestamp,
        status: "stale",
        reasonCode: "STALE_QUOTE"
      };
    }
  }

  return {
    bid,
    ask,
    midpoint,
    quoteTimestamp,
    status: "valid",
    reasonCode: null
  };
};

const quoteFromCandidate = (candidate: ZeroDteQueueCandidate): ShadowQuoteInput => {
  const row = candidate as unknown as Record<string, unknown>;
  const nested = asRecord(row.quote);
  const numericOrNull = (value: unknown): number | string | null | undefined =>
    typeof value === "number" || typeof value === "string" || value === null
      ? value
      : undefined;
  const timestamp = (value: unknown): string | null | undefined =>
    typeof value === "string" || value === null ? value : undefined;
  return {
    ...nested,
    bid: numericOrNull(nested.bid ?? row.quoteBid),
    ask: numericOrNull(nested.ask ?? row.quoteAsk),
    midpoint: numericOrNull(nested.midpoint ?? row.quoteMidpoint),
    quoteTimestamp: timestamp(nested.quoteTimestamp ?? nested.marketTimestamp ?? row.marketTimestamp)
  };
};

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const candidateBlockers = (candidate: ZeroDteQueueCandidate) => {
  const row = candidate as unknown as Record<string, unknown>;
  return stringArray(row.blockers ?? row.blockerCodes).map((code) => code.trim().toUpperCase());
};

const shadowAlternativeType = (reasonCode: string) => {
  const reason = reasonCode.toUpperCase();
  if (reason.includes("RUNNER") || reason.includes("HIGHER_RANK")) return "simulated_runner_up";
  if (reason.includes("BUYING_POWER")) return "simulated_buying_power";
  if (reason.includes("CAPACITY") || reason.includes("MAX_OPEN")) return "simulated_capacity";
  if (reason.includes("PLAYBOOK")) return "simulated_alternative_playbook";
  return "simulated";
};

const buildShadowTradeId = (candidateId: string, decisionGroupId: string) =>
  `zsh_${canonicalJsonHash({ candidateId, decisionGroupId }).slice(0, 40)}`;

const buildEventId = (
  shadowTradeId: string,
  eventType: ZeroDteLifecycleEventType,
  occurredAt: string
) => `zlev_${canonicalJsonHash({ shadowTradeId, eventType, occurredAt }).slice(0, 40)}`;

const rowToShadowTrade = (row: Record<string, unknown>): ZeroDteShadowTrade => ({
  shadowTradeId: String(row.shadow_trade_id),
  decisionGroupId: String(row.decision_group_id),
  decisionId: row.decision_id === null ? null : String(row.decision_id),
  candidateId: String(row.candidate_id),
  tradingDate: String(row.trading_date),
  underlyingSymbol: String(row.underlying_symbol),
  optionSymbol: String(row.option_symbol),
  playbook: String(row.playbook),
  direction: String(row.direction),
  alternativeType: String(row.alternative_type),
  status: String(row.status),
  quantity: Number(row.quantity),
  entryPremium: row.entry_premium === null ? null : Number(row.entry_premium),
  exitPremium: row.exit_premium === null ? null : Number(row.exit_premium),
  fees: Number(row.fees ?? 0),
  slippage: Number(row.slippage ?? 0),
  mfe: row.mfe === null ? null : Number(row.mfe),
  mae: row.mae === null ? null : Number(row.mae),
  realizedPnl: row.realized_pnl === null ? null : Number(row.realized_pnl),
  returnPct: row.return_pct === null ? null : Number(row.return_pct),
  terminalState: row.terminal_state === null ? null : String(row.terminal_state),
  fillAssumptions: parseJsonRecord(row.fill_assumptions_json),
  entryQuote: row.entry_quote_json === null ? null : parseJsonRecord(row.entry_quote_json),
  exitQuote: row.exit_quote_json === null ? null : parseJsonRecord(row.exit_quote_json),
  exitReasonCode: row.exit_reason_code === null ? null : String(row.exit_reason_code),
  openedAt: row.opened_at === null ? null : String(row.opened_at),
  closedAt: row.closed_at === null ? null : String(row.closed_at),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at)
});

const readShadowTrade = (db: DatabaseSync, shadowTradeId: string) =>
  db.prepare("SELECT * FROM zero_dte_shadow_trades WHERE shadow_trade_id = ?").get(shadowTradeId) as
    | Record<string, unknown>
    | undefined;

const lifecycleMetadata = (db: DatabaseSync, tradingDate: string) =>
  db.prepare(
    `SELECT run_id, strategy_version, configuration_version_id
     FROM zero_dte_engine_runs
     WHERE trading_date = ?
     ORDER BY started_at DESC, run_id DESC
     LIMIT 1`
  ).get(tradingDate) as {
    run_id: string;
    strategy_version: string;
    configuration_version_id: string;
  } | undefined;

const appendShadowLifecycleEvent = (
  db: DatabaseSync,
  trade: ZeroDteShadowTrade,
  eventType: ZeroDteLifecycleEventType,
  reasonCode: string,
  occurredAt: string,
  details: Record<string, unknown>
) => {
  const metadata = lifecycleMetadata(db, trade.tradingDate);
  if (!metadata) return;
  const eventId = buildEventId(trade.shadowTradeId, eventType, occurredAt);
  const existing = db.prepare("SELECT event_id FROM zero_dte_lifecycle_events WHERE event_id = ?").get(eventId);
  if (existing) return;
  insertZeroDteLifecycleEventRow(db, {
    eventId,
    eventType,
    reasonCode,
    engineRunId: metadata.run_id,
    candidateId: trade.candidateId,
    shadowTradeId: trade.shadowTradeId,
    accountMode: "shadow",
    strategyVersion: metadata.strategy_version,
    configurationVersionId: metadata.configuration_version_id,
    marketTimestamp: occurredAt,
    occurredAt,
    details
  });
};

const isSessionEnd = (timestamp: string, tradingDate: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const date = `${values.year}-${values.month}-${values.day}`;
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  return date === tradingDate && (hour > 16 || (hour === 16 && minute >= 0));
};

const calculatePnl = (
  entryPremium: number | null,
  exitPremium: number | null,
  quantity: number,
  fees: number
) =>
  entryPremium === null || exitPremium === null
    ? null
    : roundMoney((exitPremium - entryPremium) * OPTION_MULTIPLIER * quantity - fees);

const calculateReturnPct = (entryPremium: number | null, exitPremium: number | null) =>
  entryPremium === null || exitPremium === null || entryPremium <= 0
    ? null
    : ((exitPremium - entryPremium) / entryPremium) * 100;

const closeTrade = (
  db: DatabaseSync,
  row: Record<string, unknown>,
  asOf: string,
  quote: ZeroDteOptionQuote | null | undefined,
  reasonCode: string
) => {
  const trade = rowToShadowTrade(row);
  if (trade.status === "closed") return trade;
  const normalized = normalizeZeroDteShadowQuote(quote, asOf);
  const exitPremium = normalized.status === "valid"
    ? roundMoney(Math.max(0, (normalized.bid ?? 0) - trade.slippage))
    : null;
  const totalFees = roundMoney(trade.fees + shadowFeePerContract() * trade.quantity);
  const realizedPnl = calculatePnl(trade.entryPremium, exitPremium, trade.quantity, totalFees);
  const returnPct = calculateReturnPct(trade.entryPremium, exitPremium);
  const terminalState = normalized.status === "valid" ? "closed" : "closed_incomplete";
  const fillAssumptions = {
    ...trade.fillAssumptions,
    exitFillMethod: "bid_minus_slippage",
    exitQuoteStatus: normalized.status,
    exitReasonCode: reasonCode
  };
  db.prepare(
    `UPDATE zero_dte_shadow_trades
     SET status = 'closed', exit_premium = ?, fees = ?, realized_pnl = ?,
         return_pct = ?, terminal_state = ?, fill_assumptions_json = ?,
         exit_quote_json = ?, exit_reason_code = ?, closed_at = ?, updated_at = ?
     WHERE shadow_trade_id = ?`
  ).run(
    exitPremium,
    totalFees,
    realizedPnl,
    returnPct,
    terminalState,
    serializeZeroDteJson({
      ...fillAssumptions,
      exitQuote: normalized
    }),
    serializeZeroDteJson(quote ?? {}, "{}"),
    reasonCode,
    asOf,
    asOf,
    trade.shadowTradeId
  );
  const updated = rowToShadowTrade(readShadowTrade(db, trade.shadowTradeId) as Record<string, unknown>);
  appendShadowLifecycleEvent(db, updated, "shadow_closed", reasonCode, asOf, {
    terminalState,
    exitPremium,
    realizedPnl,
    returnPct,
    quoteStatus: normalized.status
  });
  return updated;
};

export const createZeroDteShadowTrade = (input: {
  candidate: ZeroDteQueueCandidate;
  decisionGroupId: string;
  reasonCode: string;
  asOf: string;
}): ZeroDteShadowTrade | null => {
  const decisionGroupId = requiredText(input.decisionGroupId, "decision group ID");
  const reasonCode = requiredText(input.reasonCode, "reason code");
  const asOf = isoTimestamp(input.asOf, "timestamp");
  const candidate = input.candidate;
  const row = candidate as unknown as Record<string, unknown>;
  if (!candidate.eligible || !SHADOWABLE_STATES.has(candidate.state)) return null;
  if (candidate.direction === "neutral") return null;
  if (candidateBlockers(candidate).some((code) => HARD_SHADOW_BLOCKERS.has(code))) return null;
  const optionSymbol = requiredText(candidate.optionSymbol, "option symbol");
  if (!parseOptionSymbol(optionSymbol).ok) return null;
  const quote = quoteFromCandidate(candidate);
  const normalized = normalizeZeroDteShadowQuote(quote, asOf);
  if (normalized.status !== "valid" || normalized.ask === null) return null;
  const tradingDate = requiredText(candidate.tradingDate, "trading date");
  const candidateId = requiredText(candidate.candidateId, "candidate ID");
  const underlyingSymbol = requiredText(candidate.underlyingSymbol, "underlying symbol");
  const playbook = requiredText(candidate.playbook, "playbook");
  const quantityValue = finiteNumber(row.quantity);
  const quantity = quantityValue !== null && Number.isInteger(quantityValue) && quantityValue > 0
    ? quantityValue
    : 1;
  const slippage = shadowSlippage();
  const entryPremium = roundMoney(normalized.ask + slippage);
  const entryFees = roundMoney(shadowFeePerContract() * quantity);
  const shadowTradeId = buildShadowTradeId(candidateId, decisionGroupId);
  const db = getDb();

  return withTransaction(db, () => {
    const existing = readShadowTrade(db, shadowTradeId);
    if (existing) return rowToShadowTrade(existing);
    const decision = db.prepare(
      `SELECT decision_id
       FROM zero_dte_decisions
       WHERE candidate_id = ?
       ORDER BY decided_at DESC, decision_id DESC
       LIMIT 1`
    ).get(candidateId) as { decision_id: string } | undefined;
    const fillAssumptions = {
      simulated: true,
      alternativeType: shadowAlternativeType(reasonCode),
      reasonCode,
      entryFillMethod: "ask_plus_slippage",
      exitFillMethod: "bid_minus_slippage",
      slippagePerContract: slippage,
      feePerContract: shadowFeePerContract(),
      contractMultiplier: OPTION_MULTIPLIER,
      entryNotional: entryPremium * OPTION_MULTIPLIER * quantity
    };
    db.prepare(
      `INSERT INTO zero_dte_shadow_trades
        (shadow_trade_id, decision_group_id, decision_id, candidate_id,
         trading_date, underlying_symbol, option_symbol, playbook, direction,
         alternative_type, status, quantity, entry_premium, fees, slippage,
         fill_assumptions_json, entry_quote_json, opened_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      shadowTradeId,
      decisionGroupId,
      decision?.decision_id ?? null,
      candidateId,
      tradingDate,
      underlyingSymbol,
      optionSymbol,
      playbook,
      candidate.direction,
      shadowAlternativeType(reasonCode),
      quantity,
      entryPremium,
      entryFees,
      slippage,
      serializeZeroDteJson(fillAssumptions),
      serializeZeroDteJson(quote),
      asOf,
      asOf,
      asOf
    );
    const trade = rowToShadowTrade(readShadowTrade(db, shadowTradeId) as Record<string, unknown>);
    appendShadowLifecycleEvent(db, trade, "shadow_opened", reasonCode, asOf, {
      entryPremium,
      quantity,
      fees: entryFees,
      slippage,
      alternativeType: trade.alternativeType
    });
    return trade;
  });
};

const insertShadowMark = (
  db: DatabaseSync,
  trade: ZeroDteShadowTrade,
  asOf: string,
  quote: ZeroDteOptionQuote | null | undefined,
  normalized: ZeroDteNormalizedShadowQuote,
  markPrice: number | null,
  unrealizedPnl: number | null,
  returnPct: number | null,
  mfe: number | null,
  mae: number | null
) => {
  const markId = `zmark_${canonicalJsonHash({ shadowTradeId: trade.shadowTradeId, asOf }).slice(0, 40)}`;
  const evidence = {
    simulated: true,
    quoteStatus: normalized.status,
    reasonCode: normalized.reasonCode,
    markMethod: "bid_minus_slippage",
    slippagePerContract: trade.slippage
  };
  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_position_marks
      (mark_id, shadow_trade_id, marked_at, market_timestamp, mark_price,
       bid, ask, midpoint, quote_quality, quantity, unrealized_pnl,
       return_pct, mfe, mae, source, evidence_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    markId,
    trade.shadowTradeId,
    asOf,
    normalized.quoteTimestamp,
    markPrice,
    normalized.bid,
    normalized.ask,
    normalized.midpoint,
    normalized.status,
    trade.quantity,
    unrealizedPnl,
    returnPct,
    mfe,
    mae,
    "zero_dte_shadow",
    serializeZeroDteJson(evidence),
    asOf
  );
  return {
    markId,
    shadowTradeId: trade.shadowTradeId,
    candidateId: trade.candidateId,
    markedAt: asOf,
    marketTimestamp: normalized.quoteTimestamp,
    markPrice,
    bid: normalized.bid,
    ask: normalized.ask,
    midpoint: normalized.midpoint,
    quoteQuality: normalized.status,
    quantity: trade.quantity,
    unrealizedPnl,
    returnPct,
    mfe,
    mae,
    source: "zero_dte_shadow",
    evidence
  } satisfies ZeroDteShadowMark;
};

export const markZeroDteShadowTrades = (input: {
  asOf: string;
  quotes: Record<string, ZeroDteOptionQuote>;
}): ZeroDteMarkResult => {
  const asOf = isoTimestamp(input.asOf, "mark timestamp");
  const db = getDb();
  return withTransaction(db, () => {
    const rows = db.prepare(
      `SELECT *
       FROM zero_dte_shadow_trades
       WHERE status IN ('intended', 'open')
       ORDER BY trading_date ASC, shadow_trade_id ASC`
    ).all() as Array<Record<string, unknown>>;
    const marked: ZeroDteShadowMark[] = [];
    const blocked: ZeroDteMarkResult["blocked"] = [];
    const closed: ZeroDteShadowTrade[] = [];
    for (const row of rows) {
      const trade = rowToShadowTrade(row);
      const quote = input.quotes[trade.optionSymbol] ?? null;
      const normalized = normalizeZeroDteShadowQuote(quote, asOf);
      const markPrice = normalized.status === "valid"
        ? roundMoney(Math.max(0, (normalized.bid ?? 0) - trade.slippage))
        : null;
      const unrealizedPnl = calculatePnl(trade.entryPremium, markPrice, trade.quantity, trade.fees);
      const returnPct = calculateReturnPct(trade.entryPremium, markPrice);
      const previousMfe = finiteNumber(row.mfe);
      const previousMae = finiteNumber(row.mae);
      const mfe = unrealizedPnl === null
        ? previousMfe
        : Math.max(previousMfe ?? 0, unrealizedPnl, 0);
      const mae = unrealizedPnl === null
        ? previousMae
        : Math.min(previousMae ?? 0, unrealizedPnl, 0);
      const mark = insertShadowMark(
        db,
        trade,
        asOf,
        quote,
        normalized,
        markPrice,
        unrealizedPnl,
        returnPct,
        mfe,
        mae
      );
      if (normalized.status === "valid") {
        db.prepare(
          `UPDATE zero_dte_shadow_trades
           SET mfe = ?, mae = ?, updated_at = ?
           WHERE shadow_trade_id = ?`
        ).run(mfe, mae, asOf, trade.shadowTradeId);
        marked.push(mark);
        const updatedTrade = rowToShadowTrade(readShadowTrade(db, trade.shadowTradeId) as Record<string, unknown>);
        appendShadowLifecycleEvent(db, updatedTrade, "shadow_marked", "MARKED", asOf, {
          markPrice,
          unrealizedPnl,
          returnPct,
          mfe,
          mae
        });
      } else {
        blocked.push({
          shadowTradeId: trade.shadowTradeId,
          candidateId: trade.candidateId,
          reasonCode: normalized.reasonCode ?? "QUOTE_UNAVAILABLE"
        });
      }
      if (isSessionEnd(asOf, trade.tradingDate)) {
        closed.push(closeTrade(db, readShadowTrade(db, trade.shadowTradeId) as Record<string, unknown>, asOf, quote, "SESSION_END"));
      }
    }
    return { paperOnly: true, marked, blocked, closed };
  });
};

export const readZeroDteShadowTrades = (input: { tradingDate?: string; limit?: number } = {}) => {
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 0 || limit > 1_000) {
    throw new RangeError("0DTE shadow trade limit must be an integer from 0 through 1000");
  }
  const rows = input.tradingDate
    ? getDb().prepare(
      `SELECT * FROM zero_dte_shadow_trades
       WHERE trading_date = ?
       ORDER BY created_at DESC, shadow_trade_id DESC
       LIMIT ?`
    ).all(requiredText(input.tradingDate, "trading date"), limit)
    : getDb().prepare(
      `SELECT * FROM zero_dte_shadow_trades
       ORDER BY created_at DESC, shadow_trade_id DESC
       LIMIT ?`
    ).all(limit);
  return (rows as Array<Record<string, unknown>>).map(rowToShadowTrade);
};

export const ZERO_DTE_SHADOW_OPTION_MULTIPLIER = OPTION_MULTIPLIER;
export const ZERO_DTE_SHADOW_DEFAULT_SLIPPAGE = DEFAULT_SHADOW_SLIPPAGE;
export const ZERO_DTE_SHADOW_DEFAULT_FEE_PER_CONTRACT = DEFAULT_SHADOW_FEE_PER_CONTRACT;
