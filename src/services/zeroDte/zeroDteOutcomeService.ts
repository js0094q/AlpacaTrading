import { canonicalJsonHash } from "../../lib/canonicalJson.js";
import { getDb } from "../../lib/db.js";
import { nowIso } from "../../lib/utils.js";
import { assertScheduledWriteFenceActive } from "../controlPlaneRuntimeContext.js";
import { parseOptionSymbol } from "../optionSymbolService.js";
import {
  markZeroDteShadowTrades,
  normalizeZeroDteShadowQuote,
  readZeroDteShadowAssumptions,
  type ZeroDteShadowTrade
} from "./zeroDteShadowService.js";
import { serializeZeroDteJson } from "./zeroDteLifecycleService.js";
import type { ZeroDteOptionQuote } from "./zeroDteMarketDataService.js";
import type { ZeroDteDirection } from "./zeroDteTypes.js";

export type { ZeroDteOptionQuote } from "./zeroDteMarketDataService.js";

const OUTCOME_TYPE = "missed_opportunity";
const OPTION_MULTIPLIER = 100;

export interface ZeroDteMissedCandidate extends Record<string, unknown> {
  candidateId: string;
  tradingDate: string;
  optionSymbol: string;
  direction: ZeroDteDirection;
  entryPremium?: number | null;
  entryPrice?: number | null;
  observedAt?: string | null;
  marketTimestamp?: string | null;
  lastSeenAt?: string | null;
  quote?: ZeroDteOptionQuote | null;
  quantity?: number | null;
}

export interface ZeroDteForwardOutcome {
  outcomeId: string;
  candidateId: string;
  tradingDate: string;
  outcomeType: string;
  horizonMinutes: number;
  terminalState: string;
  terminalPrice: number | null;
  mfe: number | null;
  mae: number | null;
  realizedPnl: number | null;
  returnPct: number | null;
  holdingMinutes: number | null;
  exitReasonCode: string | null;
  completenessStatus: "complete" | "incomplete";
  evaluatedAt: string;
  directionalCorrect: boolean | null;
  evidence: Record<string, unknown>;
  createdAt: string;
}

export interface ZeroDteOutcomeResult {
  paperOnly: true;
  outcomes: ZeroDteForwardOutcome[];
  incomplete: ZeroDteForwardOutcome[];
  closedShadowTrades: ZeroDteShadowTrade[];
}

export interface ZeroDteDailyOutcomeSummary {
  paperOnly: true;
  tradingDate: string;
  generatedAt: string;
  counts: {
    outcomes: number;
    complete: number;
    incomplete: number;
    shadowTrades: number;
    closedShadowTrades: number;
  };
  realizedPnl: number;
  averageReturnPct: number | null;
  largestMissedOpportunity: ZeroDteForwardOutcome | null;
}

type ExtendedQuote = ZeroDteOptionQuote & Record<string, unknown>;

const finiteNumber = (value: unknown): number | null => {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};

const roundMoney = (value: number) => Math.round(value * 100) / 100;

const requiredText = (value: unknown, field: string) => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`0DTE outcome ${field} is required`);
  }
  return value.trim();
};

const isoTimestamp = (value: string, field: string) => {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new RangeError(`0DTE outcome ${field} must be a valid timestamp`);
  }
  return new Date(time).toISOString();
};

const shadowSlippage = () => readZeroDteShadowAssumptions().slippage;

const shadowFeePerContract = () => readZeroDteShadowAssumptions().feePerContract;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const withTransaction = <T>(db: ReturnType<typeof getDb>, operation: () => T): T => {
  assertScheduledWriteFenceActive();
  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = operation();
    assertScheduledWriteFenceActive();
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

const asQuote = (value: unknown): ZeroDteOptionQuote | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { bid: value, ask: value, midpoint: value };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as ZeroDteOptionQuote;
};

const horizonKeys = (horizonMinutes: number) => [
  String(horizonMinutes),
  `${horizonMinutes}m`,
  `horizon_${horizonMinutes}`,
  `horizon${horizonMinutes}`
];

const resolveNestedHorizonQuote = (base: ExtendedQuote, horizonMinutes: number) => {
  for (const field of ["horizonQuotes", "forwardQuotes", "marks", "outcomes"]) {
    const values = asRecord(base[field]);
    for (const key of horizonKeys(horizonMinutes)) {
      const quote = asQuote(values[key]);
      if (quote) return quote;
    }
  }
  return null;
};

const resolveHorizonQuote = (
  symbol: string,
  horizonMinutes: number,
  quotes: Record<string, ZeroDteOptionQuote>
) => {
  for (const key of [
    `${symbol}:${horizonMinutes}`,
    `${symbol}@${horizonMinutes}`,
    `${symbol}#${horizonMinutes}`,
    `${symbol}[${horizonMinutes}]`
  ]) {
    const quote = asQuote(quotes[key]);
    if (quote) return quote;
  }
  const base = asQuote(quotes[symbol]);
  if (!base) return null;
  const nested = resolveNestedHorizonQuote(base as ExtendedQuote, horizonMinutes);
  return nested ?? base;
};

const referenceTimestamp = (candidate: ZeroDteMissedCandidate, fallback: string) => {
  const row = candidate as Record<string, unknown>;
  for (const key of ["observedAt", "marketTimestamp", "lastSeenAt", "asOf"]) {
    if (typeof row[key] === "string" && Number.isFinite(Date.parse(row[key] as string))) {
      return new Date(Date.parse(row[key] as string)).toISOString();
    }
  }
  return fallback;
};

const quoteTimestamp = (quote: ZeroDteOptionQuote | null) => {
  const row = asRecord(quote);
  const value = row.quoteTimestamp ?? row.snapshotTimestamp;
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(Date.parse(value)).toISOString()
    : null;
};

const resolveEntryPremium = (candidate: ZeroDteMissedCandidate, reference: string) => {
  const row = candidate as Record<string, unknown>;
  const explicit = finiteNumber(row.entryPremium ?? row.entryPrice);
  if (explicit !== null && explicit > 0) return { premium: explicit, source: "candidate_entry" };
  const quote = asQuote(row.quote);
  const normalized = normalizeZeroDteShadowQuote(quote, reference);
  if (normalized.status !== "valid" || normalized.ask === null) {
    return { premium: null, source: normalized.reasonCode ?? "ENTRY_QUOTE_UNAVAILABLE" };
  }
  return {
    premium: roundMoney(normalized.ask + shadowSlippage()),
    source: "candidate_ask_plus_slippage"
  };
};

const calculateReturnPct = (entry: number | null, exit: number | null) =>
  entry === null || exit === null || entry <= 0 ? null : ((exit - entry) / entry) * 100;

const outcomeId = (candidateId: string, horizonMinutes: number) =>
  `zout_${canonicalJsonHash({ candidateId, outcomeType: OUTCOME_TYPE, horizonMinutes }).slice(0, 40)}`;

const rowToOutcome = (row: Record<string, unknown>): ZeroDteForwardOutcome => {
  const evidence = (() => {
    try {
      return asRecord(JSON.parse(String(row.evidence_json ?? "{}")));
    } catch {
      return {};
    }
  })();
  return {
    outcomeId: String(row.outcome_id),
    candidateId: String(row.candidate_id),
    tradingDate: String(row.trading_date),
    outcomeType: String(row.outcome_type),
    horizonMinutes: Number(row.horizon_minutes),
    terminalState: String(row.terminal_state),
    terminalPrice: row.terminal_price === null ? null : Number(row.terminal_price),
    mfe: row.mfe === null ? null : Number(row.mfe),
    mae: row.mae === null ? null : Number(row.mae),
    realizedPnl: row.realized_pnl === null ? null : Number(row.realized_pnl),
    returnPct: row.return_pct === null ? null : Number(row.return_pct),
    holdingMinutes: row.holding_minutes === null ? null : Number(row.holding_minutes),
    exitReasonCode: row.exit_reason_code === null ? null : String(row.exit_reason_code),
    completenessStatus: String(row.completeness_status) === "complete" ? "complete" : "incomplete",
    evaluatedAt: String(row.evaluated_at),
    directionalCorrect: typeof evidence.directionalCorrect === "boolean" ? evidence.directionalCorrect : null,
    evidence,
    createdAt: String(row.created_at)
  };
};

const writeOutcome = (
  candidate: ZeroDteMissedCandidate,
  horizonMinutes: number,
  evaluatedAt: string,
  targetAt: string,
  quote: ZeroDteOptionQuote | null,
  entry: { premium: number | null; source: string }
) => {
  const candidateId = requiredText(candidate.candidateId, "candidate ID");
  const tradingDate = requiredText(candidate.tradingDate, "trading date");
  const optionSymbol = requiredText(candidate.optionSymbol, "option symbol");
  const db = getDb();
  const candidateRow = db.prepare(
    "SELECT candidate_id FROM zero_dte_candidates WHERE candidate_id = ?"
  ).get(candidateId);
  if (!candidateRow) throw new Error("ZERO_DTE_OUTCOME_CANDIDATE_NOT_FOUND");

  const normalized = normalizeZeroDteShadowQuote(quote, quoteTimestamp(quote) ?? targetAt);
  const sourceTimestamp = quoteTimestamp(quote);
  const asOfMs = Date.parse(evaluatedAt);
  const targetMs = Date.parse(targetAt);
  const quoteMs = sourceTimestamp === null ? null : Date.parse(sourceTimestamp);
  let completenessStatus: "complete" | "incomplete" = "complete";
  let reasonCode: string | null = null;
  if (targetMs > asOfMs) {
    completenessStatus = "incomplete";
    reasonCode = "HORIZON_NOT_REACHED";
  } else if (quoteMs !== null && quoteMs < targetMs) {
    completenessStatus = "incomplete";
    reasonCode = "QUOTE_BEFORE_HORIZON";
  } else if (quoteMs !== null && quoteMs > asOfMs) {
    completenessStatus = "incomplete";
    reasonCode = "QUOTE_AFTER_AS_OF";
  } else if (entry.premium === null) {
    completenessStatus = "incomplete";
    reasonCode = entry.source;
  } else if (normalized.status !== "valid" || normalized.bid === null) {
    completenessStatus = "incomplete";
    reasonCode = normalized.reasonCode ?? "QUOTE_UNAVAILABLE";
  }

  const exitPremium = completenessStatus === "complete" && normalized.bid !== null
    ? roundMoney(Math.max(0, normalized.bid - shadowSlippage()))
    : null;
  const quantityValue = finiteNumber((candidate as Record<string, unknown>).quantity);
  const quantity = quantityValue !== null && Number.isInteger(quantityValue) && quantityValue > 0
    ? quantityValue
    : 1;
  const fees = roundMoney(shadowFeePerContract() * quantity);
  const realizedPnl =
    entry.premium !== null && exitPremium !== null
      ? roundMoney((exitPremium - entry.premium) * OPTION_MULTIPLIER * quantity - fees)
      : null;
  const returnPct = calculateReturnPct(entry.premium, exitPremium);
  const parsedOption = parseOptionSymbol(optionSymbol);
  const thesisAligned = parsedOption.ok && (
    (candidate.direction === "bullish" && parsedOption.optionType === "call") ||
    (candidate.direction === "bearish" && parsedOption.optionType === "put")
  );
  const directionalCorrect = returnPct === null ? null : thesisAligned && returnPct > 0;
  const evidence = {
    source: "zero_dte_forward_outcome",
    optionSymbol,
    originalDirection: candidate.direction,
    directionalCorrect,
    entryPremium: entry.premium,
    entrySource: entry.source,
    exitPremium,
    quoteStatus: normalized.status,
    quoteReasonCode: normalized.reasonCode,
    quoteTimestamp: sourceTimestamp,
    targetAt,
    slippagePerContract: shadowSlippage(),
    feePerContract: shadowFeePerContract(),
    fees,
    incompleteReasonCode: reasonCode
  };
  const id = outcomeId(candidateId, horizonMinutes);
  const dbRow = db.prepare(
    `SELECT *
     FROM zero_dte_terminal_outcomes
     WHERE outcome_id = ?`
  ).get(id) as Record<string, unknown> | undefined;
  const values = [
    candidateId,
    tradingDate,
    OUTCOME_TYPE,
    horizonMinutes,
    completenessStatus === "complete" ? "forward_mark" : "incomplete",
    exitPremium,
    realizedPnl === null ? null : Math.max(realizedPnl, 0),
    realizedPnl === null ? null : Math.min(realizedPnl, 0),
    realizedPnl,
    returnPct,
    horizonMinutes,
    reasonCode ?? "FORWARD_HORIZON",
    completenessStatus,
    evaluatedAt,
    serializeZeroDteJson(evidence),
    evaluatedAt
  ];
  if (!dbRow) {
    db.prepare(
      `INSERT INTO zero_dte_terminal_outcomes
        (outcome_id, candidate_id, trading_date, outcome_type, horizon_minutes,
         terminal_state, terminal_price, mfe, mae, realized_pnl, return_pct,
         holding_minutes, exit_reason_code, completeness_status, evaluated_at,
         evidence_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, ...values.slice(0));
  } else if (String(dbRow.completeness_status) !== "complete" && completenessStatus === "complete") {
    db.prepare(
      `UPDATE zero_dte_terminal_outcomes
       SET terminal_state = ?, terminal_price = ?, mfe = ?, mae = ?,
           realized_pnl = ?, return_pct = ?, holding_minutes = ?,
           exit_reason_code = ?, completeness_status = ?, evaluated_at = ?,
           evidence_json = ?
       WHERE outcome_id = ?`
    ).run(
      "forward_mark",
      exitPremium,
      realizedPnl === null ? null : Math.max(realizedPnl, 0),
      realizedPnl === null ? null : Math.min(realizedPnl, 0),
      realizedPnl,
      returnPct,
      horizonMinutes,
      "FORWARD_HORIZON",
      "complete",
      evaluatedAt,
      serializeZeroDteJson(evidence),
      id
    );
  }
  return rowToOutcome(
    db.prepare("SELECT * FROM zero_dte_terminal_outcomes WHERE outcome_id = ?").get(id) as Record<string, unknown>
  );
};

const isAfterSessionClose = (timestamp: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(values.hour);
  return hour >= 16;
};

export const captureZeroDteOutcomes = (input: {
  asOf: string;
  candidates: ZeroDteMissedCandidate[];
  quotes: Record<string, ZeroDteOptionQuote>;
  horizonsMinutes: number[];
}): ZeroDteOutcomeResult => {
  const asOf = isoTimestamp(input.asOf, "evaluation timestamp");
  const horizons = Array.from(new Set(input.horizonsMinutes))
    .filter((horizon) => Number.isInteger(horizon) && horizon > 0)
    .sort((left, right) => left - right);
  const db = getDb();
  const outcomes = withTransaction(db, () => {
    const result: ZeroDteForwardOutcome[] = [];
    for (const candidate of input.candidates) {
      const reference = referenceTimestamp(candidate, asOf);
      const referenceMs = Date.parse(reference);
      const entry = resolveEntryPremium(candidate, reference);
      for (const horizonMinutes of horizons) {
        const targetAt = new Date(referenceMs + horizonMinutes * 60_000).toISOString();
        const quote = resolveHorizonQuote(candidate.optionSymbol, horizonMinutes, input.quotes);
        result.push(writeOutcome(candidate, horizonMinutes, asOf, targetAt, quote, entry));
      }
    }
    return result;
  });
  const closedShadowTrades = isAfterSessionClose(asOf)
    ? markZeroDteShadowTrades({ asOf, quotes: input.quotes }).closed
    : [];
  return {
    paperOnly: true,
    outcomes,
    incomplete: outcomes.filter((outcome) => outcome.completenessStatus === "incomplete"),
    closedShadowTrades
  };
};

export const readZeroDteDailyOutcomeSummary = (tradingDate: string): ZeroDteDailyOutcomeSummary => {
  const date = requiredText(tradingDate, "trading date");
  const db = getDb();
  const outcomeRows = db.prepare(
    `SELECT *
     FROM zero_dte_terminal_outcomes
     WHERE trading_date = ?
     ORDER BY evaluated_at ASC, outcome_id ASC`
  ).all(date) as Array<Record<string, unknown>>;
  const outcomes = outcomeRows.map(rowToOutcome);
  const shadowRows = db.prepare(
    "SELECT status FROM zero_dte_shadow_trades WHERE trading_date = ?"
  ).all(date) as Array<{ status: string }>;
  const complete = outcomes.filter((outcome) => outcome.completenessStatus === "complete");
  const returns = complete
    .map((outcome) => outcome.returnPct)
    .filter((value): value is number => value !== null);
  const largestMissedOpportunity = complete
    .filter((outcome) => outcome.realizedPnl !== null)
    .sort((left, right) => (right.realizedPnl ?? -Infinity) - (left.realizedPnl ?? -Infinity))[0] ?? null;
  return {
    paperOnly: true,
    tradingDate: date,
    generatedAt: nowIso(),
    counts: {
      outcomes: outcomes.length,
      complete: complete.length,
      incomplete: outcomes.length - complete.length,
      shadowTrades: shadowRows.length,
      closedShadowTrades: shadowRows.filter((row) => row.status === "closed").length
    },
    realizedPnl: complete.reduce((total, outcome) => total + (outcome.realizedPnl ?? 0), 0),
    averageReturnPct: returns.length > 0
      ? returns.reduce((total, value) => total + value, 0) / returns.length
      : null,
    largestMissedOpportunity
  };
};

export const ZERO_DTE_OUTCOME_TYPE = OUTCOME_TYPE;
