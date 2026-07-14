import { canonicalJsonHash } from "../../lib/canonicalJson.js";
import { getDb } from "../../lib/db.js";
import {
  buildPaperExitExecutionResult,
  type PaperExitExecutionInput
} from "../paperExitExecutionService.js";
import {
  buildPaperExitReviewResult,
  type PaperExitReviewInput
} from "../paperExitReviewService.js";
import type {
  PaperExitExecutionResult,
  PaperExitReviewCandidate,
  PaperExitReviewResult
} from "../../types/paperExit.js";
import { parseOptionSymbol } from "../optionSymbolService.js";
import { insertZeroDteLifecycleEventRow } from "./zeroDteLifecycleService.js";

export interface ZeroDteExitProvider {
  review?: (input: PaperExitReviewInput) => Promise<PaperExitReviewResult>;
  execute?: (input: PaperExitExecutionInput) => Promise<PaperExitExecutionResult>;
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

const paperTradeForSymbol = (symbol: string, tradingDate: string) => getDb().prepare(
  `SELECT zero_dte_paper_trades.paper_trade_id,
          zero_dte_paper_trades.candidate_id,
          zero_dte_paper_trades.decision_id,
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
).get(tradingDate, symbol) as {
  paper_trade_id: string;
  candidate_id: string;
  decision_id: string;
  decision_group_id: string;
  engine_run_id: string;
  strategy_version: string;
  configuration_version_id: string;
  market_timestamp: string | null;
} | undefined;

const appendExitEvent = (input: {
  eventType: "exit_triggered" | "exit_order_requested" | "position_closed";
  trade: NonNullable<ReturnType<typeof paperTradeForSymbol>>;
  occurredAt: string;
  reasonCode: string;
  details: Record<string, unknown>;
}) => {
  const eventId = `zlev_${canonicalJsonHash({
    eventType: input.eventType,
    paperTradeId: input.trade.paper_trade_id,
    brokerOrderId: input.details.brokerOrderId ?? input.details.clientOrderId ?? input.reasonCode
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
      details: { currentPrice: candidate.currentPrice, positionClass: candidate.positionClass }
    });
    getDb().prepare(
      `UPDATE zero_dte_paper_trades
       SET status = 'exit_requested', exit_requested_at = ?,
           exit_reason_code = ?, updated_at = ?
       WHERE paper_trade_id = ?`
    ).run(input.now, order.reason, input.now, trade.paper_trade_id);
    appendExitEvent({
      eventType: "exit_order_requested",
      trade,
      occurredAt: input.now,
      reasonCode: order.reason,
      details: {
        brokerOrderId: order.alpacaOrderId ?? null,
        clientOrderId: order.clientOrderId ?? null,
        requestId: order.alpacaRequestId ?? null,
        status: order.status ?? null
      }
    });
    if (String(order.status || "").toLowerCase() === "filled") {
      getDb().prepare(
        `UPDATE zero_dte_paper_trades
         SET status = 'closed', exit_premium = ?, exited_at = ?,
             terminal_state = 'closed', updated_at = ?
         WHERE paper_trade_id = ?`
      ).run(candidate.currentPrice, input.now, input.now, trade.paper_trade_id);
      appendExitEvent({
        eventType: "position_closed",
        trade,
        occurredAt: input.now,
        reasonCode: order.reason,
        details: { exitPremium: candidate.currentPrice, brokerOrderId: order.alpacaOrderId ?? null }
      });
    }
  }
  return links;
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
