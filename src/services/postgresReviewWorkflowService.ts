import { createHmac } from "node:crypto";

import { canonicalJsonHash } from "../lib/canonicalJson.js";
import type { SchedulerFence } from "../repositories/contracts/common.js";
import { AUTONOMOUS_MARKET_DATA_FRESHNESS_SECONDS } from "./autonomousFreshnessPolicy.js";
import { paperLeapsExitConfig } from "./leapsExitPolicy.js";
import {
  resolveLeapsEntryAllocation,
  sizeLeapsEntry,
  type LeapsEntrySizingResult
} from "./leapsEntryAllocationService.js";
import {
  optionDaysToExpiration,
  parseOptionSymbol
} from "./optionSymbolService.js";
import {
  classifyOptionStrategy,
  type StrategyClassification,
  type TradeOperation
} from "./autonomousTradeLifecycleService.js";
import {
  paperExplorationProfile,
  paperExplorationThresholds,
  type PaperExplorationThresholds
} from "./paperExplorationConfig.js";
import { optionsQuoteConfig } from "./optionQuoteNormalizer.js";

export type PostgresReviewQuery = {
  query: (sql: string, values?: readonly unknown[]) => Promise<{
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }>;
};

type ReviewSourceRow = Record<string, unknown> & {
  candidate_id: string;
  symbol: string;
  asset_class: "equity" | "option";
  option_symbol: string | null;
  preferred_expression: string;
  direction: "long" | "short";
  confidence: string | number;
  candidate_as_of: Date | string;
  account_id: string;
  account_snapshot_id: string;
  snapshot_fingerprint: string;
  structural_fingerprint: string;
  buying_power: string | number;
  cash: string | number;
  equity: string | number;
  strategy_key: string;
  candidate_strategy_family?: string | null;
  allocation_amount: string | number | null;
  allocation_ratio: string | number | null;
  reserved_amount: string | number;
  deployed_amount: string | number;
  max_position_notional: string | number | null;
  max_symbol_notional: string | number | null;
  max_deployment_amount: string | number | null;
  cash_reserve_amount: string | number | null;
  cash_reserve_ratio: string | number | null;
  market_price: string | number;
  market_timestamp: Date | string;
  market_request_id: string | null;
  signal_inputs?: unknown;
  market_evidence?: unknown;
  contract_option_symbol?: string | null;
  contract_id?: string | null;
  contract_underlying_symbol?: string | null;
  contract_type?: "call" | "put" | null;
  contract_expiration_date?: Date | string | null;
  contract_tradable?: boolean | null;
  contract_status?: string | null;
  contract_source?: string | null;
  contract_observed_at?: Date | string | null;
  contract_multiplier?: string | number | null;
  sip_underlying_symbol?: string | null;
  sip_market_price?: string | number | null;
  sip_market_timestamp?: Date | string | null;
  sip_bid_price?: string | number | null;
  sip_ask_price?: string | number | null;
  sip_requested_feed?: string | null;
  sip_effective_feed?: string | null;
  sip_provider?: string | null;
  sip_request_id?: string | null;
  open_position_count: string | number;
  open_order_count: string | number;
};

const ENTRY_REVIEW_COMMANDS = new Set([
  "paper:review",
  "paper:portfolio:review",
  "paper:options:discover",
  "paper:ops:review",
  "hedge:review"
]);
const EXIT_REVIEW_COMMANDS = new Set([
  "paper:exit:review",
  "hedge:exit:review",
  "zero-dte:exit:review"
]);

const fenceSql = (start: number) => `EXISTS (
  SELECT 1 FROM scheduler_leases lease
  WHERE lease.job_name = $${start} AND lease.workstream = $${start + 1}
    AND lease.owner_id = $${start + 2} AND lease.run_id = $${start + 3}
    AND lease.fencing_token = $${start + 4} AND lease.status = 'held'
    AND lease.expires_at > now()
)`;
const fenceValues = (fence: SchedulerFence) => [
  fence.jobName, fence.workstream, fence.ownerId, fence.runId, fence.fencingToken
];
const finite = (value: unknown) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const positiveOrInfinity = (value: unknown) => {
  const parsed = finite(value);
  return parsed !== null && parsed >= 0 ? parsed : Number.POSITIVE_INFINITY;
};
const isoDateOnly = (value: Date | string | null | undefined) =>
  value instanceof Date && Number.isFinite(value.getTime())
    ? value.toISOString().slice(0, 10)
    : String(value ?? "").slice(0, 10);
const jsonRecord = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return {};
};
const optionDecisionInputs = (row: ReviewSourceRow) => {
  const signalInputs = jsonRecord(row.signal_inputs);
  const marketDecisionInputs = jsonRecord(signalInputs.marketDecisionInputs);
  return jsonRecord(marketDecisionInputs.option);
};
const executableOptionEvidence = (input: {
  evidence: Record<string, unknown>;
  maximumSpreadPct: number;
  underlyingPrice: unknown;
}) => {
  const evidence = input.evidence;
  const bid = finite(evidence.bid);
  const ask = finite(evidence.ask);
  const spreadPct = finite(evidence.spreadPct);
  const volume = finite(evidence.volume);
  const openInterest = finite(evidence.openInterest);
  const underlyingPrice = finite(input.underlyingPrice);
  const requestedFeed = String(evidence.requestedFeed ?? "").trim().toLowerCase();
  const effectiveFeed = String(evidence.effectiveFeed ?? evidence.feed ?? "")
    .trim()
    .toLowerCase();
  const provider = String(evidence.provider ?? "").trim().toLowerCase();
  return !(
    bid === null || bid <= 0 ||
    ask === null || ask <= 0 ||
    ask < bid ||
    spreadPct === null ||
    spreadPct < 0 ||
    spreadPct > input.maximumSpreadPct ||
    underlyingPrice === null || underlyingPrice <= 0 ||
    volume === null || volume < 0 ||
    openInterest === null || openInterest < 0 ||
    volume + openInterest <= 0 ||
    requestedFeed !== "opra" ||
    effectiveFeed !== "opra" ||
    provider !== "alpaca"
  );
};
const assertExecutableOptionReviewEvidence = (
  row: ReviewSourceRow,
  maximumSpreadPct: number
) => {
  if (row.asset_class !== "option") return;
  if (!executableOptionEvidence({
    evidence: {
      ...jsonRecord(row.market_evidence),
      ...optionDecisionInputs(row)
    },
    maximumSpreadPct,
    underlyingPrice: row.sip_market_price
  })) {
    throw new Error(
      `POSTGRES_REVIEW_OPTION_QUOTE_INVALID:${row.option_symbol ?? row.symbol}`
    );
  }
};
const assertFreshAlpacaSipUnderlying = (input: {
  row: ReviewSourceRow;
  now: Date;
  maxAgeSeconds: number;
  errorScope: "REVIEW" | "EXIT_REVIEW";
}) => {
  const row = input.row;
  if (row.asset_class !== "option") return null;
  const optionSymbol = String(row.option_symbol ?? row.order_symbol ?? "")
    .trim()
    .toUpperCase();
  const underlying = String(row.symbol ?? "").trim().toUpperCase();
  const contractUnderlying = String(row.contract_underlying_symbol ?? "")
    .trim()
    .toUpperCase();
  const sipUnderlying = String(row.sip_underlying_symbol ?? "")
    .trim()
    .toUpperCase();
  const price = finite(row.sip_market_price);
  const bid = finite(row.sip_bid_price);
  const ask = finite(row.sip_ask_price);
  const timestampText = String(row.sip_market_timestamp ?? "").trim();
  const timestampMs = Date.parse(timestampText);
  const requestedFeed = String(row.sip_requested_feed ?? "")
    .trim()
    .toLowerCase();
  const effectiveFeed = String(row.sip_effective_feed ?? "")
    .trim()
    .toLowerCase();
  const provider = String(row.sip_provider ?? "").trim().toLowerCase();
  if (
    !underlying ||
    !optionSymbol ||
    contractUnderlying !== underlying ||
    sipUnderlying !== underlying ||
    price === null ||
    price <= 0 ||
    requestedFeed !== "sip" ||
    effectiveFeed !== "sip" ||
    provider !== "alpaca" ||
    !Number.isFinite(timestampMs)
  ) {
    throw new Error(
      `POSTGRES_${input.errorScope}_OPTION_UNDERLYING_SIP_INVALID:${optionSymbol || underlying}`
    );
  }
  const maxAgeSeconds = Math.min(
    input.maxAgeSeconds,
    AUTONOMOUS_MARKET_DATA_FRESHNESS_SECONDS
  );
  const age = input.now.getTime() - timestampMs;
  if (age < -60_000 || age > maxAgeSeconds * 1_000) {
    throw new Error(
      `POSTGRES_${input.errorScope}_OPTION_UNDERLYING_SIP_STALE:${optionSymbol}`
    );
  }
  return {
    symbol: sipUnderlying,
    referencePrice: price,
    timestamp: new Date(timestampMs).toISOString(),
    requestId: row.sip_request_id ?? null,
    bid,
    ask,
    requestedFeed,
    effectiveFeed,
    provider,
    source: "postgres.stock_snapshots"
  };
};
const assertObservedOptionContract = (row: ReviewSourceRow) => {
  if (row.asset_class !== "option") return;
  const optionSymbol = String(row.option_symbol ?? row.order_symbol ?? "")
    .trim()
    .toUpperCase();
  const parsed = parseOptionSymbol(optionSymbol);
  const observedAt = Date.parse(String(row.contract_observed_at ?? ""));
  const expirationDate = isoDateOnly(row.contract_expiration_date);
  const contractType = String(row.contract_type ?? "").trim().toLowerCase();
  if (
    !parsed.ok ||
    !String(row.contract_id ?? "").trim() ||
    String(row.contract_option_symbol ?? "").trim().toUpperCase() !==
      optionSymbol ||
    String(row.contract_underlying_symbol ?? "").trim().toUpperCase() !==
      String(row.symbol ?? "").trim().toUpperCase() ||
    expirationDate !== parsed.expirationDate ||
    contractType !== parsed.optionType ||
    row.contract_tradable !== true ||
    String(row.contract_status ?? "").trim().toLowerCase() !== "active" ||
    String(row.contract_source ?? "").trim().toLowerCase() !== "alpaca" ||
    !Number.isFinite(observedAt)
  ) {
    throw new Error(
      `POSTGRES_REVIEW_OPTION_CONTRACT_INVALID:${optionSymbol || row.symbol}`
    );
  }
};
const validateEntryReviewEvidence = (input: {
  row: ReviewSourceRow;
  now: Date;
  maxMarketAgeSeconds: number;
  maximumOptionSpreadPct: number;
}) => {
  const marketTimestamp = new Date(input.row.market_timestamp).toISOString();
  const age = input.now.getTime() - Date.parse(marketTimestamp);
  const maxAge = Math.min(
    input.maxMarketAgeSeconds,
    input.row.asset_class === "option"
      ? optionsQuoteConfig().maxAgeMs / 1_000
      : Number.POSITIVE_INFINITY
  ) * 1_000;
  if (!Number.isFinite(age) || age < -60_000 || age > maxAge) {
    throw new Error(
      `POSTGRES_REVIEW_MARKET_EVIDENCE_STALE:${input.row.symbol}`
    );
  }
  const price = finite(input.row.market_price);
  if (price === null || price <= 0) {
    throw new Error(
      `POSTGRES_REVIEW_MARKET_PRICE_MISSING:${input.row.symbol}`
    );
  }
  assertObservedOptionContract(input.row);
  const underlyingSip = assertFreshAlpacaSipUnderlying({
    row: input.row,
    now: input.now,
    maxAgeSeconds: input.maxMarketAgeSeconds,
    errorScope: "REVIEW"
  });
  assertExecutableOptionReviewEvidence(
    input.row,
    input.maximumOptionSpreadPct
  );
  return { marketTimestamp, price, underlyingSip };
};
const REVIEW_PROPOSAL_ERROR_PREFIXES = [
  "POSTGRES_REVIEW_MARKET_EVIDENCE_STALE:",
  "POSTGRES_REVIEW_OPTION_CONTRACT_INVALID:"
] as const;
const scopedReviewProposalReason = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return REVIEW_PROPOSAL_ERROR_PREFIXES.some((prefix) =>
    message.startsWith(prefix)
  )
    ? message
    : null;
};
const optionSizingScale = (row: ReviewSourceRow) => {
  if (row.asset_class !== "option") return 1;
  const decisionInputs = optionDecisionInputs(row);
  const selectionScore = finite(decisionInputs.selectionScore);
  return selectionScore === null
    ? 1
    : Math.max(0.25, Math.min(1, selectionScore));
};

const newYorkParts = (date: Date) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
};

const newYorkTradingDate = (date: Date) => {
  const parts = newYorkParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const isFinalThirtyMinutesForZeroDte = (optionSymbol: string, now: Date) => {
  const parsed = parseOptionSymbol(optionSymbol);
  if (!parsed.ok) return false;
  const parts = newYorkParts(now);
  const tradingDate = newYorkTradingDate(now);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return parsed.expirationDate === tradingDate && minutes >= 15 * 60 + 30 && minutes <= 16 * 60;
};

const persistCandidateStage = async (input: {
  query: PostgresReviewQuery;
  fence: SchedulerFence;
  candidateId: string;
  status: "skipped" | "blocked" | "sized";
  reason: string;
  now: string;
  leapsSizing?: LeapsEntrySizingResult | null;
}) => {
  const result = await input.query.query(
    `UPDATE candidates
     SET lifecycle_status = $2, decision_reason = $3, updated_at = $4,
         signal_inputs = CASE
           WHEN $5::jsonb IS NULL THEN signal_inputs
           ELSE jsonb_set(
             COALESCE(signal_inputs, '{}'::jsonb),
             '{leapsSizing}',
             $5::jsonb,
             true
           )
         END,
         version = version + 1
     WHERE id = $1 AND decision = 'selected' AND ${fenceSql(6)}`,
    [
      input.candidateId,
      input.status,
      input.reason,
      input.now,
      input.leapsSizing ? JSON.stringify(input.leapsSizing) : null,
      ...fenceValues(input.fence)
    ]
  );
  if (result.rowCount !== 1) throw new Error("POSTGRES_CANDIDATE_STAGE_PERSISTENCE_FAILED");
};

const entrySourceSql = (command: string, maxCandidates: number) => `WITH latest_research AS (
  SELECT id FROM research_runs WHERE status = 'completed'
  ORDER BY completed_at DESC, id DESC LIMIT 1
), current_account AS (
  SELECT * FROM accounts WHERE environment = 'paper'
  ORDER BY updated_at DESC, id LIMIT 1
)
SELECT candidate.id AS candidate_id, candidate.symbol, candidate.asset_class,
       candidate.option_symbol, candidate.preferred_expression,
       candidate.direction, candidate.confidence,
       candidate.strategy_family AS candidate_strategy_family,
       candidate.as_of AS candidate_as_of,
       candidate.signal_inputs,
       account.id AS account_id, snapshot.id AS account_snapshot_id,
       snapshot.snapshot_fingerprint,
       snapshot.evidence->>'structuralPortfolioFingerprint' AS structural_fingerprint,
       snapshot.buying_power::text, snapshot.cash::text, snapshot.equity::text,
       allocation.strategy_key, allocation.allocation_amount::text,
       allocation.allocation_ratio::text, allocation.reserved_amount::text,
       allocation.deployed_amount::text, limits.max_position_notional::text,
       limits.max_symbol_notional::text, limits.max_deployment_amount::text,
       limits.cash_reserve_amount::text, limits.cash_reserve_ratio::text,
       market.market_price::text, market.market_timestamp,
       market.market_request_id, market.market_evidence,
       contract.option_symbol AS contract_option_symbol,
       contract.contract_id AS contract_id,
       contract.underlying_symbol AS contract_underlying_symbol,
       contract.type AS contract_type,
       contract.expiration_date AS contract_expiration_date,
       contract.tradable AS contract_tradable,
       contract.status AS contract_status,
       contract.source AS contract_source,
       contract.observed_at AS contract_observed_at,
       contract.multiplier::text AS contract_multiplier,
       sip.sip_underlying_symbol, sip.sip_market_price,
       sip.sip_market_timestamp, sip.sip_bid_price, sip.sip_ask_price,
       sip.sip_requested_feed, sip.sip_effective_feed, sip.sip_provider,
       sip.sip_request_id,
       (SELECT COUNT(*) FROM positions position
         WHERE position.account_id = account.id AND position.status IN ('open', 'closing')
           AND (position.symbol = candidate.symbol OR position.option_symbol = candidate.option_symbol)
       ) AS open_position_count,
       (SELECT COUNT(*) FROM orders broker_order
         WHERE broker_order.account_id = account.id
           AND broker_order.status IN ('new','accepted','pending_new','partially_filled','held','pending_cancel')
           AND broker_order.symbol = COALESCE(candidate.option_symbol, candidate.symbol)
       ) AS open_order_count
FROM candidates candidate
JOIN latest_research research ON research.id = candidate.research_run_id
LEFT JOIN option_contracts contract
  ON contract.option_symbol = candidate.option_symbol
LEFT JOIN LATERAL (
  SELECT stock.symbol AS sip_underlying_symbol,
         COALESCE(
           (stock.evidence->>'midpoint')::numeric,
           (stock.evidence->>'latestTradePrice')::numeric,
           (stock.evidence->>'currentTradablePrice')::numeric,
           (stock.evidence->>'marketReferencePrice')::numeric,
           (stock.evidence->>'minuteClose')::numeric,
           (stock.evidence->>'dailyClose')::numeric
         ) AS sip_market_price,
         stock.source_timestamp AS sip_market_timestamp,
         (stock.evidence->>'bidPrice')::numeric AS sip_bid_price,
         (stock.evidence->>'askPrice')::numeric AS sip_ask_price,
         stock.requested_feed AS sip_requested_feed,
         stock.effective_feed AS sip_effective_feed,
         stock.source AS sip_provider,
         stock.request_id AS sip_request_id
  FROM stock_snapshots stock
  WHERE stock.symbol = candidate.symbol
  ORDER BY stock.observed_at DESC, stock.id DESC
  LIMIT 1
) sip ON candidate.option_symbol IS NOT NULL
CROSS JOIN current_account account
JOIN LATERAL (
  SELECT * FROM account_snapshots WHERE account_id = account.id
  ORDER BY observed_at DESC, id DESC LIMIT 1
) snapshot ON true
JOIN LATERAL (
  SELECT * FROM strategy_allocations WHERE account_id = account.id
    AND status = 'active' AND effective_to IS NULL
  ORDER BY updated_at DESC, id LIMIT 1
) allocation ON true
JOIN LATERAL (
  SELECT * FROM risk_limits WHERE account_id = account.id
    AND status = 'active' AND effective_to IS NULL
  ORDER BY CASE WHEN scope_type = 'portfolio' THEN 0 ELSE 1 END, updated_at DESC, id LIMIT 1
) limits ON true
JOIN LATERAL (
  SELECT option_market.market_price, option_market.market_timestamp,
         option_market.market_request_id, option_market.market_evidence
  FROM (
    SELECT COALESCE(option_snapshot.midpoint, option_snapshot.ask, option_snapshot.last) AS market_price,
           COALESCE(option_snapshot.quote_timestamp, option_snapshot.snapshot_timestamp,
                    option_snapshot.trade_timestamp, option_snapshot.observed_at) AS market_timestamp,
           option_snapshot.request_id AS market_request_id,
	           jsonb_build_object(
             'bid', option_snapshot.bid,
             'ask', option_snapshot.ask,
             'midpoint', option_snapshot.midpoint,
             'last', option_snapshot.last,
             'volume', option_snapshot.volume,
             'openInterest', option_snapshot.open_interest,
             'impliedVolatility', option_snapshot.implied_volatility,
             'delta', option_snapshot.delta,
             'gamma', option_snapshot.gamma,
             'theta', option_snapshot.theta,
             'vega', option_snapshot.vega,
	             'rho', option_snapshot.rho,
	             'underlyingPrice', option_snapshot.evidence->'underlyingPrice',
	             'requestedFeed', option_snapshot.evidence->>'requestedFeed',
	             'effectiveFeed', option_snapshot.evidence->>'effectiveFeed',
	             'provider', CASE
	               WHEN option_snapshot.source IN ('alpaca', 'alpaca_opra_stream')
	                 THEN 'alpaca'
	               ELSE option_snapshot.source
	             END,
	             'transport', option_snapshot.evidence->>'transport',
	             'spread', option_snapshot.evidence->'spread',
	             'spreadPct', option_snapshot.evidence->'spreadPct'
           ) AS market_evidence
    FROM option_snapshots option_snapshot
    WHERE candidate.option_symbol IS NOT NULL
      AND option_snapshot.option_symbol = candidate.option_symbol
    ORDER BY option_snapshot.observed_at DESC LIMIT 1
  ) option_market
  UNION ALL
  SELECT stock_market.market_price, stock_market.market_timestamp,
         stock_market.market_request_id, stock_market.market_evidence
  FROM (
    SELECT COALESCE(
             (stock.evidence->>'midpoint')::numeric,
             (stock.evidence->>'latestTradePrice')::numeric,
             (stock.evidence->>'minuteClose')::numeric,
             (stock.evidence->>'dailyClose')::numeric,
             bar.close
           ) AS market_price,
           COALESCE(stock.source_timestamp, bar.observed_at) AS market_timestamp,
           COALESCE(stock.request_id, bar.request_id) AS market_request_id,
           COALESCE(stock.evidence, '{}'::jsonb) AS market_evidence
    FROM market_bars bar
    LEFT JOIN LATERAL (
      SELECT * FROM stock_snapshots WHERE symbol = candidate.symbol
      ORDER BY observed_at DESC, id DESC LIMIT 1
    ) stock ON true
    WHERE candidate.option_symbol IS NULL AND bar.symbol = candidate.symbol
      AND bar.timeframe = '1Day'
    ORDER BY bar.observed_at DESC LIMIT 1
  ) stock_market
  LIMIT 1
) market ON market.market_price > 0 AND market.market_timestamp IS NOT NULL
WHERE candidate.decision = 'selected'
  AND candidate.lifecycle_status NOT IN ('closed','expired','rejected','skipped','blocked')
  AND NOT EXISTS (
    SELECT 1 FROM execution_reviews existing_review
    WHERE existing_review.account_id = account.id
      AND existing_review.candidate_id = candidate.id
      AND existing_review.source_snapshot_id = snapshot.id
      AND existing_review.review_type = 'entry'
      AND existing_review.client_order_id IS NOT NULL
  )
  ${command === "paper:options:discover" ? `AND candidate.option_symbol IS NOT NULL
    AND candidate.symbol = $1
    AND contract.expiration_date = (($2::timestamptz AT TIME ZONE 'America/New_York')::date + $3::integer)` : ""}
  ${command === "hedge:review" ? "AND candidate.strategy_family ILIKE '%hedge%'" : ""}
ORDER BY candidate.rank, candidate.id
LIMIT ${maxCandidates}`;

const exitSourceSql = (command: string) => {
  const severeTrendBars = Math.min(
    1_000,
    paperLeapsExitConfig().severeTrendExitSma
  );
  return `WITH current_account AS (
  SELECT * FROM accounts WHERE environment = 'paper'
  ORDER BY updated_at DESC, id LIMIT 1
)
SELECT position.id AS position_id,
       COALESCE(position.candidate_id, opening_intent.candidate_id) AS candidate_id,
       position.opening_order_id,
       opening_intent.id AS opening_intent_id,
       COALESCE(opening_intent.review_id, opening_intent.execution_review_id)
         AS opening_review_id,
       opening_intent.strategy_classification AS opening_strategy_classification,
       opening_intent.contract_id AS opening_contract_id,
       opening_intent.authorization_snapshot_id
         AS opening_authorization_snapshot_id,
       position.symbol,
       COALESCE(position.option_symbol, position.symbol) AS order_symbol,
       position.asset_class, position.side, position.available_quantity::text,
       position.average_entry_price::text,
       opening_intent.strategy_key AS strategy_key,
       allocation.id AS allocation_id,
       allocation.status AS allocation_status,
       allocation.effective_to AS allocation_effective_to,
       account.id AS account_id, snapshot.id AS account_snapshot_id,
       snapshot.snapshot_fingerprint,
       snapshot.evidence->>'structuralPortfolioFingerprint' AS structural_fingerprint,
       market.market_price::text, market.market_timestamp, market.market_request_id,
       market.market_evidence, leaps_trend.underlying_close::text,
       leaps_trend.severe_trend_sma::text,
       leaps_trend.severe_trend_bar_count::text,
       contract.option_symbol AS contract_option_symbol,
       contract.contract_id AS contract_id,
       contract.underlying_symbol AS contract_underlying_symbol,
       contract.type AS contract_type,
       contract.expiration_date AS contract_expiration_date,
       contract.tradable AS contract_tradable,
       contract.status AS contract_status,
       contract.source AS contract_source,
       contract.observed_at AS contract_observed_at,
       sip.sip_underlying_symbol, sip.sip_market_price,
       sip.sip_market_timestamp, sip.sip_bid_price, sip.sip_ask_price,
       sip.sip_requested_feed, sip.sip_effective_feed, sip.sip_provider,
       sip.sip_request_id
FROM positions position
CROSS JOIN current_account account
LEFT JOIN candidates candidate ON candidate.id = position.candidate_id
LEFT JOIN orders opening_order ON opening_order.id = position.opening_order_id
LEFT JOIN order_intents opening_intent
  ON opening_intent.id = opening_order.order_intent_id
LEFT JOIN option_contracts contract
  ON contract.option_symbol = position.option_symbol
LEFT JOIN LATERAL (
  SELECT stock.symbol AS sip_underlying_symbol,
         COALESCE(
           (stock.evidence->>'midpoint')::numeric,
           (stock.evidence->>'latestTradePrice')::numeric,
           (stock.evidence->>'currentTradablePrice')::numeric,
           (stock.evidence->>'marketReferencePrice')::numeric,
           (stock.evidence->>'minuteClose')::numeric,
           (stock.evidence->>'dailyClose')::numeric
         ) AS sip_market_price,
         stock.source_timestamp AS sip_market_timestamp,
         (stock.evidence->>'bidPrice')::numeric AS sip_bid_price,
         (stock.evidence->>'askPrice')::numeric AS sip_ask_price,
         stock.requested_feed AS sip_requested_feed,
         stock.effective_feed AS sip_effective_feed,
         stock.source AS sip_provider,
         stock.request_id AS sip_request_id
  FROM stock_snapshots stock
  WHERE stock.symbol = position.symbol
  ORDER BY stock.observed_at DESC, stock.id DESC
  LIMIT 1
) sip ON position.option_symbol IS NOT NULL
JOIN LATERAL (
  SELECT * FROM account_snapshots WHERE account_id = account.id
  ORDER BY observed_at DESC, id DESC LIMIT 1
) snapshot ON true
LEFT JOIN LATERAL (
  SELECT strategy_allocation.id, strategy_allocation.status,
         strategy_allocation.effective_to
  FROM strategy_allocations strategy_allocation
  WHERE strategy_allocation.account_id = account.id
    AND strategy_allocation.strategy_key = opening_intent.strategy_key
  ORDER BY (
    strategy_allocation.status = 'active' AND
    strategy_allocation.effective_to IS NULL
  ) DESC, strategy_allocation.updated_at DESC, strategy_allocation.id
  LIMIT 1
) allocation ON true
JOIN LATERAL (
  SELECT option_market.market_price, option_market.market_timestamp,
         option_market.market_request_id, option_market.market_evidence
  FROM (
    SELECT COALESCE(option_snapshot.bid, option_snapshot.midpoint, option_snapshot.last) AS market_price,
           COALESCE(option_snapshot.quote_timestamp, option_snapshot.snapshot_timestamp,
                    option_snapshot.trade_timestamp, option_snapshot.observed_at) AS market_timestamp,
           option_snapshot.request_id AS market_request_id,
           jsonb_build_object(
             'bid', option_snapshot.bid,
             'ask', option_snapshot.ask,
             'midpoint', option_snapshot.midpoint,
             'last', option_snapshot.last,
             'volume', option_snapshot.volume,
             'openInterest', option_snapshot.open_interest,
             'underlyingPrice', option_snapshot.evidence->'underlyingPrice',
             'requestedFeed', option_snapshot.evidence->>'requestedFeed',
             'effectiveFeed', option_snapshot.evidence->>'effectiveFeed',
             'provider', CASE
               WHEN option_snapshot.source IN ('alpaca', 'alpaca_opra_stream')
                 THEN 'alpaca'
               ELSE option_snapshot.source
             END,
             'transport', option_snapshot.evidence->>'transport',
             'spread', option_snapshot.evidence->'spread',
             'spreadPct', option_snapshot.evidence->'spreadPct'
           ) AS market_evidence
    FROM option_snapshots option_snapshot
    WHERE position.option_symbol IS NOT NULL
      AND option_snapshot.option_symbol = position.option_symbol
    ORDER BY option_snapshot.observed_at DESC LIMIT 1
  ) option_market
  UNION ALL
  SELECT stock_market.market_price, stock_market.market_timestamp,
         stock_market.market_request_id, stock_market.market_evidence
  FROM (
    SELECT COALESCE(
             (stock.evidence->>'midpoint')::numeric,
             (stock.evidence->>'latestTradePrice')::numeric,
             (stock.evidence->>'minuteClose')::numeric,
             (stock.evidence->>'dailyClose')::numeric,
             bar.close
           ) AS market_price,
           COALESCE(stock.source_timestamp, bar.observed_at) AS market_timestamp,
           COALESCE(stock.request_id, bar.request_id) AS market_request_id,
           COALESCE(stock.evidence, '{}'::jsonb) AS market_evidence
    FROM market_bars bar
    LEFT JOIN LATERAL (
      SELECT * FROM stock_snapshots WHERE symbol = position.symbol
      ORDER BY observed_at DESC, id DESC LIMIT 1
    ) stock ON true
    WHERE position.option_symbol IS NULL AND bar.symbol = position.symbol
      AND bar.timeframe = '1Day'
    ORDER BY bar.observed_at DESC LIMIT 1
  ) stock_market
  LIMIT 1
) market ON market.market_price > 0 AND market.market_timestamp IS NOT NULL
LEFT JOIN LATERAL (
  SELECT
    (array_agg(trend.close ORDER BY trend.observed_at DESC))[1]
      AS underlying_close,
    AVG(trend.close) AS severe_trend_sma,
    COUNT(*) AS severe_trend_bar_count
  FROM (
    SELECT bar.close, bar.observed_at
    FROM market_bars bar
    WHERE bar.symbol = position.symbol AND bar.timeframe = '1Day'
    ORDER BY bar.observed_at DESC
    LIMIT ${severeTrendBars}
  ) trend
) leaps_trend ON position.asset_class = 'option'
WHERE position.account_id = account.id AND position.status = 'open'
  AND position.available_quantity > 0
  AND NOT EXISTS (
    SELECT 1
    FROM order_intents close_intent
    WHERE close_intent.parent_position_id = position.id
      AND close_intent.lifecycle_state NOT IN (
        'closed','cancelled','rejected','expired','failed_terminal'
      )
  )
  ${command === "hedge:exit:review" ? "AND (opening_intent.strategy_key ILIKE '%hedge%' OR opening_intent.strategy_key IS NULL)" : ""}
  ${command === "zero-dte:exit:review" ? "AND position.asset_class = 'option' AND substring(position.option_symbol from '[0-9]{6}') = to_char(now() AT TIME ZONE 'America/New_York', 'YYMMDD')" : ""}
ORDER BY position.opened_at, position.id`;
};

const runExitReview = async (input: {
  command: string;
  query: PostgresReviewQuery;
  fence: SchedulerFence;
  signingKey: string;
  now: Date;
  maxMarketAgeSeconds: number;
}) => {
  const rows = (await input.query.query(exitSourceSql(input.command))).rows as Array<Record<string, unknown>>;
  const eligible = rows.flatMap((row) => {
    const positionId = String(row.position_id ?? "").trim();
    const strategyKey = String(row.strategy_key ?? "").trim();
    if (
      !strategyKey ||
      !String(row.allocation_id ?? "").trim() ||
      String(row.allocation_status ?? "").trim().toLowerCase() !== "active" ||
      row.allocation_effective_to !== null
    ) {
      throw new Error(
        `POSTGRES_EXIT_ALLOCATION_AUTHORITY_MISSING:${positionId || "unknown"}:${strategyKey || "unknown"}`
      );
    }
    const price = finite(row.market_price);
    const entry = finite(row.average_entry_price);
    const quantity = finite(row.available_quantity);
    if (price === null || price <= 0 || entry === null || entry <= 0 || quantity === null || quantity <= 0) {
      throw new Error(`POSTGRES_EXIT_REVIEW_EVIDENCE_INCOMPLETE:${String(row.symbol)}`);
    }
    const timestamp = new Date(String(row.market_timestamp)).toISOString();
    const age = input.now.getTime() - Date.parse(timestamp);
    const effectiveMaxMarketAgeSeconds = row.asset_class === "option"
      ? Math.min(
          input.maxMarketAgeSeconds,
          optionsQuoteConfig().maxAgeMs / 1_000
        )
      : input.maxMarketAgeSeconds;
    if (
      !Number.isFinite(age) ||
      age < -60_000 ||
      age > effectiveMaxMarketAgeSeconds * 1_000
    ) {
      throw new Error(`POSTGRES_REVIEW_MARKET_EVIDENCE_STALE:${String(row.symbol)}`);
    }
    const directionalReturn = (price / entry - 1) * (row.side === "short" ? -1 : 1);
    const option = row.asset_class === "option";
    const underlyingSip = option
      ? assertFreshAlpacaSipUnderlying({
          row: row as ReviewSourceRow,
          now: input.now,
          maxAgeSeconds: input.maxMarketAgeSeconds,
          errorScope: "EXIT_REVIEW"
        })
      : null;
    if (
      option &&
      !executableOptionEvidence({
        evidence: jsonRecord(row.market_evidence),
        maximumSpreadPct:
          paperExplorationThresholds().maximumOptionSpreadPct,
        underlyingPrice: underlyingSip?.referencePrice
      })
    ) {
      throw new Error(
        `POSTGRES_EXIT_REVIEW_OPTION_QUOTE_INVALID:${String(row.order_symbol)}`
      );
    }
    if (option) assertObservedOptionContract(row as ReviewSourceRow);
    const openingStrategyClassification = String(
      row.opening_strategy_classification ?? ""
    ) as StrategyClassification;
    const strategyClassification: StrategyClassification = option
      ? openingStrategyClassification
      : row.side === "short"
        ? "equity_short"
        : "equity_long";
    if (
      option &&
      ![
        "standard_long_call",
        "standard_long_put",
        "zero_dte_long_call",
        "zero_dte_long_put",
        "leaps_long_call",
        "leaps_long_put",
        "hedge"
      ].includes(strategyClassification)
    ) {
      throw new Error(
        `POSTGRES_EXIT_OPENING_CLASSIFICATION_MISSING:${String(row.order_symbol)}`
      );
    }
    const zeroDte = strategyClassification === "zero_dte_long_call" ||
      strategyClassification === "zero_dte_long_put";
    const forceZeroDteExit = zeroDte &&
      isFinalThirtyMinutesForZeroDte(String(row.order_symbol), input.now);
    const parsedOption = option
      ? parseOptionSymbol(String(row.order_symbol))
      : null;
    const currentDte = parsedOption?.ok
      ? optionDaysToExpiration(parsedOption.expirationDate, input.now.toISOString())
      : null;
    const leapsConfig = paperLeapsExitConfig();
    const leaps = strategyClassification === "leaps_long_call" ||
      strategyClassification === "leaps_long_put";
    const directionalReturnPct = directionalReturn * 100;
    const severeTrendBarCount = finite(row.severe_trend_bar_count);
    const underlyingClose = finite(row.underlying_close);
    const severeTrendSma = finite(row.severe_trend_sma);
    const severeTrendBreak = leaps &&
      parsedOption?.ok === true &&
      severeTrendBarCount !== null &&
      severeTrendBarCount >= leapsConfig.severeTrendExitSma &&
      underlyingClose !== null &&
      severeTrendSma !== null &&
      (
        (parsedOption.optionType === "call" &&
          underlyingClose < severeTrendSma) ||
        (parsedOption.optionType === "put" &&
          underlyingClose > severeTrendSma)
      );
    const reason = option
      ? leaps
        ? directionalReturnPct <= leapsConfig.hardStopLossPct
          ? "LEAPS_HARD_STOP_LOSS"
          : directionalReturnPct >= leapsConfig.fullProfitTakePct
            ? "LEAPS_FULL_PROFIT_TAKE"
            : currentDte !== null && currentDte <= leapsConfig.dteExitThreshold
              ? "LEAPS_DTE_EXIT_WINDOW"
              : severeTrendBreak
                ? "LEAPS_SEVERE_TREND_BREAK"
                : null
        : forceZeroDteExit
          ? "ODTE_FORCE_EXIT_BEFORE_CLOSE"
          : directionalReturn <= -0.5
            ? "ODTE_STOP_LOSS_50"
            : directionalReturn >= 0.5
              ? "ODTE_TAKE_PROFIT_50"
              : null
      : directionalReturn <= -0.05 ? "EQUITY_STOP_LOSS_5" : directionalReturn >= 0.08 ? "EQUITY_TAKE_PROFIT_8" : null;
    return reason ? [{
      row,
      price,
      quantity,
      timestamp,
      option,
      reason,
      directionalReturn,
      strategyClassification,
      underlyingSip
    }] : [];
  });
  if (!eligible.length) {
    return { status: "no_op" as const, code: "NO_POSTGRES_EXIT_TRIGGER", reviewsCreated: 0, pendingIntentsCreated: 0, capacityBlocked: 0 };
  }
  let created = 0;
  let skipped = 0;
  for (const item of eligible) {
    const row = item.row;
    const accountId = String(row.account_id);
    const positionId = String(row.position_id);
    const orderSymbol = String(row.order_symbol);
    const candidateId = row.candidate_id ? String(row.candidate_id) : null;
    const structural = String(row.structural_fingerprint || "");
    const portfolio = String(row.snapshot_fingerprint || "");
    const snapshotId = String(row.account_snapshot_id || "");
    if (!structural || !portfolio || !snapshotId) throw new Error("POSTGRES_REVIEW_ACCOUNT_FINGERPRINT_MISSING");
    const clientOrderId = `pg-exit-${canonicalJsonHash({ accountId, positionId, snapshotId }).slice(0, 28)}`;
    const marketEvidence = [{
      symbol: orderSymbol,
      underlyingSymbol: String(row.symbol),
      referencePrice: item.price,
      timestamp: item.timestamp,
      requestId: row.market_request_id ?? null,
      ...(item.option ? {
        ...jsonRecord(row.market_evidence),
        underlyingPrice: item.underlyingSip?.referencePrice,
        underlyingSip: item.underlyingSip,
        maximumSpreadPct: paperExplorationThresholds().maximumOptionSpreadPct
      } : {}),
      source: item.option
        ? "postgres.option_snapshots"
        : "postgres.stock_snapshots"
    }];
    if (item.option && row.side !== "long") {
      throw new Error(`POSTGRES_OPTION_CLOSE_SIDE_UNSUPPORTED:${orderSymbol}`);
    }
    const operation: TradeOperation = item.option
      ? "sell_to_close"
      : row.side === "short"
        ? "buy_to_cover"
        : "sell_to_close";
    const exitSide = operation === "buy_to_cover" ? "buy" : item.option
      ? "sell_to_close"
      : "sell";
    const orderIntent = {
      symbol: orderSymbol, underlyingSymbol: item.option ? String(row.symbol) : null,
      assetClass: String(row.asset_class), side: exitSide, operation,
      orderType: item.option ? "limit" : "market", timeInForce: "day",
      quantity: item.quantity, notional: null, limitPrice: item.option ? item.price : null,
      clientOrderId, strategyKey: String(row.strategy_key), reason: item.reason,
      strategyClassification: item.strategyClassification
    };
    const payload = {
      positionId, candidateId, accountSnapshotId: snapshotId,
      accountFingerprint: structural, orderIntent, marketEvidence,
      trigger: { reason: item.reason, return: item.directionalReturn }, paperOnly: true
    };
    const payloadFingerprint = canonicalJsonHash(payload);
    const reviewId = `review_${payloadFingerprint}`;
    const signature = createHmac("sha256", input.signingKey).update(payloadFingerprint).digest("hex");
    const nowIso = input.now.toISOString();
    const expiresAt = new Date(input.now.getTime() + 15 * 60_000).toISOString();
    const openingIntentId = String(row.opening_intent_id ?? "").trim();
    const openingOrderId = String(row.opening_order_id ?? "").trim();
    const openingReviewId = String(row.opening_review_id ?? "").trim();
    const openingAuthorizationSnapshotId = String(
      row.opening_authorization_snapshot_id ?? ""
    ).trim();
    if (!openingIntentId || !openingOrderId || !openingReviewId) {
      throw new Error(`POSTGRES_EXIT_OPENING_LINEAGE_MISSING:${orderSymbol}`);
    }
    const observedContractId = item.option
      ? String(row.contract_id ?? "").trim()
      : null;
    const openingContractId = item.option
      ? String(row.opening_contract_id ?? "").trim()
      : null;
    if (
      item.option &&
      (!observedContractId || !openingContractId ||
        observedContractId !== openingContractId)
    ) {
      throw new Error(`POSTGRES_EXIT_OPTION_CONTRACT_LINEAGE_MISMATCH:${orderSymbol}`);
    }
    const confirmationEvidence = {
      command: input.command,
      confirmPaper: true,
      autonomous: true,
      parentPositionId: positionId,
      openingIntentId,
      scheduler: {
        jobName: input.fence.jobName,
        workstream: input.fence.workstream,
        ownerId: input.fence.ownerId,
        runId: input.fence.runId,
        fencingToken: input.fence.fencingToken
      }
    };
    const confirmationFingerprint = canonicalJsonHash({
      executionReviewId: reviewId,
      reviewPayloadFingerprint: payloadFingerprint,
      evidence: confirmationEvidence
    });
    const confirmationId = `confirmation_${confirmationFingerprint}`;
    const confirmationSignature = createHmac("sha256", input.signingKey)
      .update(confirmationFingerprint)
      .digest("hex");
    const intentFingerprint = canonicalJsonHash({ reviewId, orderIntent });
    const intentId = `intent_${intentFingerprint}`;
    const lifecycleFingerprint = canonicalJsonHash({
      orderIntentId: intentId,
      confirmationId,
      state: "exit_ready_for_submission",
      at: nowIso
    });
    const cycleId = process.env.AUTONOMOUS_CYCLE_ID?.trim() ||
      input.fence.runId;
    const persistence = await input.query.query(
      `WITH fence_state AS (
         SELECT ${fenceSql(42)} AS held
       ), inserted_review AS (
         INSERT INTO execution_reviews(
           id, account_id, candidate_id, review_type, environment, paper_only,
           live_trading_enabled, status, client_order_id, account_fingerprint,
           source_snapshot_id, configuration_fingerprint, payload_fingerprint,
           signature_algorithm, signature, order_intent, market_evidence,
           portfolio_evidence, warnings, blockers, expires_at, created_at, updated_at
         ) SELECT $1, $2, $3, 'exit', 'paper', true, false, 'valid', $4, $5,
                  $6, $7, $8, 'hmac-sha256', $9, $10::jsonb, $11::jsonb,
                  $12::jsonb, '[]'::jsonb, '[]'::jsonb, $13, $14, $14
           FROM fence_state WHERE held
         ON CONFLICT (account_id, client_order_id)
           WHERE client_order_id IS NOT NULL
         DO NOTHING
         RETURNING id
       ), inserted_confirmation AS (
         INSERT INTO confirmation_evidence(
           id, execution_review_id, account_id, candidate_id, evidence_type,
           confirmation_method, status, paper_only, payload_fingerprint,
           signature_algorithm, signature, evidence, confirmed_at, expires_at,
           created_at, updated_at
         )
         SELECT $15, inserted_review.id, $2, $3,
                'paper_execution_confirmation',
                'autonomous_worker_confirm_paper', 'valid', true, $16,
                'hmac-sha256', $17, $18::jsonb, $14, $13, $14, $14
         FROM inserted_review
         RETURNING id
       ), inserted_intent AS (
         INSERT INTO order_intents(
           id, account_id, candidate_id, execution_review_id,
           confirmation_evidence_id, environment, client_order_id,
           idempotency_key, strategy_key, symbol, underlying_symbol,
           asset_class, side, order_type, time_in_force, quantity, limit_price,
           estimated_premium, max_risk, status, intent_fingerprint,
           lifecycle_fingerprint, request_payload, ready_at, created_at,
           updated_at, operation, strategy_classification, lifecycle_state,
           review_id, confirmation_id, parent_position_id, opening_intent_id,
           contract_id, authorization_snapshot_id, autonomous_cycle_id,
           workstream_execution_id, fence_token
         )
         SELECT $19, $2, $3, inserted_review.id, inserted_confirmation.id,
                'paper', $4, $20, $21, $22, $23, $24, $25, $26, 'day',
                $27, $28, $29, $30, 'ready_for_submission', $31, $32,
                $10::jsonb, $14, $14, $14, $33, $34,
                'exit_ready_for_submission', inserted_review.id,
                inserted_confirmation.id, $35, $36, $37, $38, $39, $40,
                $41
         FROM inserted_review
         JOIN inserted_confirmation ON true
         ON CONFLICT (account_id, intent_fingerprint) DO NOTHING
         RETURNING id
       )
       SELECT fence_state.held AS fence_held,
              (SELECT COUNT(*)::integer FROM inserted_review) AS review_count,
              (SELECT COUNT(*)::integer FROM inserted_confirmation)
                AS confirmation_count,
              (SELECT COUNT(*)::integer FROM inserted_intent) AS intent_count
       FROM fence_state`,
      [reviewId, accountId, candidateId, clientOrderId, structural, snapshotId,
        canonicalJsonHash({ reason: item.reason }), payloadFingerprint, signature,
        JSON.stringify(orderIntent), JSON.stringify(marketEvidence),
        JSON.stringify({
          snapshotId,
          portfolioFingerprint: portfolio,
          structuralPortfolioFingerprint: structural,
          trigger: payload.trigger,
          openingLineage: {
            candidateId,
            openingReviewId,
            openingIntentId,
            openingOrderId,
            openingAuthorizationSnapshotId: openingAuthorizationSnapshotId || null,
            strategyClassification: item.strategyClassification,
            contractId: observedContractId
          }
        }),
        expiresAt, nowIso, confirmationId, confirmationFingerprint,
        confirmationSignature, JSON.stringify(confirmationEvidence),
        intentId, `review:${payloadFingerprint}`, String(row.strategy_key),
        orderSymbol, item.option ? String(row.symbol) : null,
        String(row.asset_class), exitSide,
        item.option ? "limit" : "market", item.quantity,
        item.option ? item.price : null,
        item.option ? item.price * 100 * item.quantity : null,
        item.option ? item.price * 100 * item.quantity : item.price * item.quantity,
        intentFingerprint, lifecycleFingerprint, operation,
        item.strategyClassification, positionId, openingIntentId,
        observedContractId, snapshotId, cycleId, input.fence.runId,
        input.fence.fencingToken, ...fenceValues(input.fence)]
    );
    const persistenceOutcome = persistence.rowCount === 1
      ? persistence.rows[0]
      : undefined;
    if (!persistenceOutcome) {
      throw new Error("POSTGRES_EXIT_REVIEW_PERSISTENCE_FAILED");
    }
    if (persistenceOutcome.fence_held !== true) {
      throw new Error("SCHEDULER_FENCE_LOST");
    }
    const reviewCount = Number(
      persistenceOutcome.review_count ?? persistenceOutcome.inserted_count
    );
    const confirmationCount = Number(
      persistenceOutcome.confirmation_count ?? reviewCount
    );
    const intentCount = Number(
      persistenceOutcome.intent_count ?? reviewCount
    );
    if (
      ![reviewCount, confirmationCount, intentCount].every((count) =>
        Number.isInteger(count) && [0, 1].includes(count)
      ) ||
      confirmationCount !== reviewCount ||
      intentCount !== reviewCount
    ) {
      throw new Error("POSTGRES_EXIT_REVIEW_PERSISTENCE_FAILED");
    }
    if (reviewCount === 0) {
      skipped += 1;
      continue;
    }
    created += 1;
  }
  return {
    status: "completed" as const, command: input.command, reviewsCreated: created,
    pendingIntentsCreated: created, skipped, capacityBlocked: 0,
    confirmationCreated: created > 0, paperOnly: true
  };
};

const independentlyValidatedAvailableCapital = (
  row: ReviewSourceRow
): number => {
  const buyingPower = finite(row.buying_power);
  const cash = finite(row.cash);
  const equity = finite(row.equity);
  if (buyingPower === null || cash === null || equity === null) {
    throw new Error("POSTGRES_REVIEW_ACCOUNT_SIZING_EVIDENCE_MISSING");
  }
  const allocation = row.allocation_amount !== null
    ? positiveOrInfinity(row.allocation_amount)
    : finite(row.allocation_ratio) !== null
      ? buyingPower * finite(row.allocation_ratio)!
      : Number.POSITIVE_INFINITY;
  const allocationRemaining = Math.max(0, allocation - (finite(row.reserved_amount) ?? 0) - (finite(row.deployed_amount) ?? 0));
  const cashReserve = row.cash_reserve_amount !== null
    ? finite(row.cash_reserve_amount) ?? 0
    : equity * (finite(row.cash_reserve_ratio) ?? 0);
  const amount = Math.floor(Math.min(
    buyingPower,
    Math.max(0, cash - cashReserve),
    allocationRemaining,
    positiveOrInfinity(row.max_position_notional),
    positiveOrInfinity(row.max_symbol_notional),
    positiveOrInfinity(row.max_deployment_amount)
  ) * 100) / 100;
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
};

const sizing = (
  row: ReviewSourceRow,
  maxOrderNotional: number
): number | null => {
  const amount = Math.floor(Math.min(
    maxOrderNotional * optionSizingScale(row),
    independentlyValidatedAvailableCapital(row)
  ) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount;
};

export const runPostgresReviewWorkflow = async (input: {
  command: string;
  query: PostgresReviewQuery;
  fence: SchedulerFence;
  signingKey?: string;
  now?: Date;
  maxMarketAgeSeconds?: number;
  underlying?: string;
  dte?: number;
  maxCandidates?: number;
  explorationThresholds?: PaperExplorationThresholds;
  leapsEntryAllocationEnv?: NodeJS.ProcessEnv;
}) => {
  if (!ENTRY_REVIEW_COMMANDS.has(input.command) && !EXIT_REVIEW_COMMANDS.has(input.command)) {
    return { status: "no_op" as const, code: "NO_POSTGRES_REVIEW_SCOPE", reviewsCreated: 0, pendingIntentsCreated: 0, capacityBlocked: 0 };
  }
  const signingKey = input.signingKey ?? process.env.PAPER_REVIEW_SIGNING_KEY?.trim();
  if (!signingKey || signingKey.length < 16) throw new Error("PAPER_REVIEW_SIGNING_KEY_REQUIRED");
  const now = input.now ?? new Date();
  const exploration = input.explorationThresholds ?? paperExplorationThresholds();
  const explorationProfile = paperExplorationProfile(exploration);
  const maxCandidates = Math.max(
    1,
    Math.min(
      exploration.maxCandidates,
      Number.isSafeInteger(input.maxCandidates) ? input.maxCandidates! : exploration.maxCandidates
    )
  );
  if (EXIT_REVIEW_COMMANDS.has(input.command)) {
    return runExitReview({
      command: input.command,
      query: input.query,
      fence: input.fence,
      signingKey,
      now,
      maxMarketAgeSeconds:
        input.maxMarketAgeSeconds ??
        AUTONOMOUS_MARKET_DATA_FRESHNESS_SECONDS
    });
  }
  let sourceValues: readonly unknown[] = [];
  if (input.command === "paper:options:discover") {
    const underlying = String(input.underlying ?? "").trim().toUpperCase();
    if (!/^[A-Z][A-Z.]{0,14}$/.test(underlying)) {
      throw new Error("POSTGRES_OPTION_DISCOVERY_UNDERLYING_REQUIRED");
    }
    if (!Number.isSafeInteger(input.dte) || input.dte! < 0 || input.dte! > 730) {
      throw new Error("POSTGRES_OPTION_DISCOVERY_DTE_INVALID");
    }
    sourceValues = [underlying, now.toISOString(), input.dte!];
  }
  const rows = (await input.query.query(
    entrySourceSql(input.command, maxCandidates),
    sourceValues
  )).rows as ReviewSourceRow[];
  if (!rows.length) {
    return { status: "no_op" as const, code: "NO_ELIGIBLE_POSTGRES_CANDIDATES", reviewsCreated: 0, pendingIntentsCreated: 0, capacityBlocked: 0 };
  }
  // Classify candidate-scoped duplicate and selected evidence failures without
  // weakening shared account, scheduler-fence, or submission-time safety.
  let skipped = 0;
  let capacityBlocked = 0;
  const eligibleRows: Array<{
    row: ReviewSourceRow;
    amount: number;
    evidence: ReturnType<typeof validateEntryReviewEvidence>;
    leapsSizing: LeapsEntrySizingResult | null;
  }> = [];
  const skippedRows: ReviewSourceRow[] = [];
  const blockedRows: Array<{ row: ReviewSourceRow; reason: string }> = [];
  const capacityRows: Array<{
    row: ReviewSourceRow;
    reason: string;
    leapsSizing?: LeapsEntrySizingResult | null;
  }> = [];
  for (const row of rows) {
    if (!row.structural_fingerprint || !row.snapshot_fingerprint) {
      throw new Error("POSTGRES_REVIEW_ACCOUNT_FINGERPRINT_MISSING");
    }
    if (Number(row.open_position_count) > 0 || Number(row.open_order_count) > 0) {
      skipped += 1;
      skippedRows.push(row);
      continue;
    }
    let evidence: ReturnType<typeof validateEntryReviewEvidence>;
    try {
      evidence = validateEntryReviewEvidence({
        row,
        now,
        maxMarketAgeSeconds:
          input.maxMarketAgeSeconds ??
          AUTONOMOUS_MARKET_DATA_FRESHNESS_SECONDS,
        maximumOptionSpreadPct: exploration.maximumOptionSpreadPct
      });
    } catch (error) {
      const reason = scopedReviewProposalReason(error);
      if (!reason) throw error;
      blockedRows.push({ row, reason });
      continue;
    }
    const price = evidence.price;
    const isLeaps = row.asset_class === "option" &&
      String(row.candidate_strategy_family ?? "").trim().toLowerCase() ===
        "leaps";
    let leapsSizing: LeapsEntrySizingResult | null = null;
    let amount: number | null;
    if (isLeaps) {
      const allocation = resolveLeapsEntryAllocation(
        input.leapsEntryAllocationEnv ?? process.env
      );
      if (!allocation.ok) throw new Error(allocation.reason);
      const multiplier = finite(row.contract_multiplier);
      leapsSizing = sizeLeapsEntry({
        executablePremium: price,
        contractMultiplier: multiplier ?? Number.NaN,
        maxEntryCapitalUsd: allocation.maxEntryCapitalUsd,
        independentlyValidatedAvailableCapitalUsd:
          independentlyValidatedAvailableCapital(row)
      });
      amount = leapsSizing.positionCostUsd;
      if (leapsSizing.quantity === 0 || amount === null) {
        capacityBlocked += 1;
        capacityRows.push({
          row,
          reason: leapsSizing.reason ?? "POSTGRES_REVIEW_CAPACITY_UNAVAILABLE",
          leapsSizing
        });
        continue;
      }
    } else {
      amount = sizing(row, exploration.maxOrderNotional);
    }
    if (amount === null) {
      capacityBlocked += 1;
      capacityRows.push({
        row,
        reason: "POSTGRES_REVIEW_CAPACITY_UNAVAILABLE"
      });
      continue;
    }
    if (
      row.asset_class === "option" &&
      !leapsSizing &&
      !Math.floor(amount / (price * 100))
    ) {
      capacityBlocked += 1;
      capacityRows.push({ row, reason: "POSTGRES_REVIEW_OPTION_CAPACITY_INSUFFICIENT" });
      continue;
    }
    if (
      row.asset_class === "equity" &&
      row.direction === "short" &&
      !Math.floor(amount / price)
    ) {
      capacityBlocked += 1;
      capacityRows.push({ row, reason: "POSTGRES_REVIEW_SHORT_CAPACITY_INSUFFICIENT" });
      continue;
    }
    eligibleRows.push({ row, amount, evidence, leapsSizing });
  }
  for (const row of skippedRows) {
    await persistCandidateStage({
      query: input.query,
      fence: input.fence,
      candidateId: row.candidate_id,
      status: "skipped",
      reason: "POSTGRES_REVIEW_POSITION_OR_ORDER_EXISTS",
      now: now.toISOString()
    });
  }
  for (const { row, reason } of blockedRows) {
    await persistCandidateStage({
      query: input.query,
      fence: input.fence,
      candidateId: row.candidate_id,
      status: "blocked",
      reason,
      now: now.toISOString()
    });
  }
  for (const { row, reason, leapsSizing } of capacityRows) {
    await persistCandidateStage({
      query: input.query,
      fence: input.fence,
      candidateId: row.candidate_id,
      status: "blocked",
      reason,
      leapsSizing,
      now: now.toISOString()
    });
  }
  if (!eligibleRows.length) {
    if (blockedRows.length > 0) {
      return {
        status: "no_op" as const,
        code: "NO_ELIGIBLE_POSTGRES_CANDIDATES",
        command: input.command,
        reviewsCreated: 0,
        pendingIntentsCreated: 0,
        skipped,
        capacityBlocked,
        confirmationCreated: false,
        paperOnly: true
      };
    }
    return {
      status: "completed" as const, command: input.command, reviewsCreated: 0,
      pendingIntentsCreated: 0, skipped, capacityBlocked,
      ...(capacityBlocked > 0 ? {
        code: capacityRows.find((row) =>
          row.reason === "LEAPS_CONTRACT_COST_EXCEEDS_ALLOCATION"
        )?.reason ?? "POSTGRES_REVIEW_CAPACITY_UNAVAILABLE"
      } : {}),
      confirmationCreated: false, paperOnly: true
    };
  }
  let created = 0;
  for (const { row, amount, evidence, leapsSizing } of eligibleRows) {
    const { marketTimestamp, price, underlyingSip } = evidence;
    const option = row.asset_class === "option";
    const shortEquity = !option && row.direction === "short";
    const operation: TradeOperation = option
      ? "buy_to_open"
      : shortEquity
        ? "sell_to_open"
        : "buy_to_open";
    const strategyClassification: StrategyClassification = option
      ? classifyOptionStrategy(
          {
            expirationDate: isoDateOnly(row.contract_expiration_date),
            optionType: String(row.contract_type) as "call" | "put"
          },
          newYorkTradingDate(now)
        )
      : shortEquity
        ? "equity_short"
        : "equity_long";
    const quantity = option
      ? leapsSizing?.quantity ?? Math.floor(amount / (price * 100))
      : shortEquity
        ? Math.floor(amount / price)
        : null;
    const optionPositionCost = option
      ? leapsSizing?.positionCostUsd ?? price * 100 * (quantity ?? 0)
      : null;
    const effectiveRisk = shortEquity
      ? price * (quantity ?? 0)
      : optionPositionCost ?? amount;
    const orderSymbol = row.option_symbol ?? row.symbol;
    const clientOrderId = `pg-${canonicalJsonHash({ account: row.account_id, candidate: row.candidate_id, snapshot: row.account_snapshot_id }).slice(0, 32)}`;
    const marketEvidence = [{
      symbol: orderSymbol,
      underlyingSymbol: row.symbol,
      referencePrice: price,
      timestamp: marketTimestamp,
      requestId: row.market_request_id,
      source: option ? "postgres.option_snapshots" : "postgres.stock_snapshots",
      ...jsonRecord(row.market_evidence),
      ...(option ? optionDecisionInputs(row) : {}),
      ...(option ? {
        underlyingPrice: underlyingSip?.referencePrice,
        underlyingSip,
        maximumSpreadPct: exploration.maximumOptionSpreadPct,
        ...(leapsSizing ? { leapsSizing } : {})
      } : {})
    }];
    const entrySide = option ? "buy_to_open" : row.direction === "short" ? "sell" : "buy";
    const orderIntent = {
      symbol: orderSymbol,
      underlyingSymbol: option ? row.symbol : null,
      assetClass: row.asset_class,
      side: entrySide,
      orderType: option ? "limit" : "market",
      timeInForce: "day",
      operation,
      strategyClassification,
      quantity,
      notional: option || shortEquity ? null : amount,
      limitPrice: option ? price : null,
      clientOrderId,
      strategyKey: row.strategy_key
    };
    const configuration = {
      environment: "paper", liveTradingEnabled: false,
      explorationProfile,
      allocationAmount: row.allocation_amount, allocationRatio: row.allocation_ratio,
      maxPositionNotional: row.max_position_notional,
      maxSymbolNotional: row.max_symbol_notional,
      maxDeploymentAmount: row.max_deployment_amount,
      cashReserveAmount: row.cash_reserve_amount,
      cashReserveRatio: row.cash_reserve_ratio,
      ...(leapsSizing ? {
        leapsMaxEntryCapitalUsd: leapsSizing.configuredPerEntryAllocationUsd
      } : {})
    };
    const payload = {
      candidateId: row.candidate_id, accountSnapshotId: row.account_snapshot_id,
      accountFingerprint: row.structural_fingerprint, orderIntent, marketEvidence,
      paperOnly: true
    };
    const payloadFingerprint = canonicalJsonHash(payload);
    const configFingerprint = canonicalJsonHash(configuration);
    const reviewId = `review_${payloadFingerprint}`;
    const signature = createHmac("sha256", signingKey).update(payloadFingerprint).digest("hex");
    const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
    const review = await input.query.query(
      `INSERT INTO execution_reviews(
         id, account_id, candidate_id, review_type, environment, paper_only,
         live_trading_enabled, status, client_order_id, account_fingerprint,
         source_snapshot_id, configuration_fingerprint, payload_fingerprint,
         signature_algorithm, signature, order_intent, market_evidence,
         portfolio_evidence, warnings, blockers, expires_at, created_at, updated_at
       ) SELECT $1, $2, $3, 'entry', 'paper', true, false, 'valid', $4, $5,
                $6, $7, $8, 'hmac-sha256', $9, $10::jsonb, $11::jsonb,
                $12::jsonb, '[]'::jsonb, '[]'::jsonb, $13, $14, $14
         WHERE ${fenceSql(15)}
       ON CONFLICT (account_id, payload_fingerprint) DO NOTHING`,
      [reviewId, row.account_id, row.candidate_id, clientOrderId,
        row.structural_fingerprint, row.account_snapshot_id, configFingerprint,
        payloadFingerprint, signature, JSON.stringify(orderIntent),
        JSON.stringify(marketEvidence), JSON.stringify({
          snapshotId: row.account_snapshot_id,
          portfolioFingerprint: row.snapshot_fingerprint,
          structuralPortfolioFingerprint: row.structural_fingerprint
        }), expiresAt, now.toISOString(), ...fenceValues(input.fence)]
    );
    if (review.rowCount !== 1 && review.rowCount !== 0) throw new Error("POSTGRES_REVIEW_PERSISTENCE_FAILED");
    const intentFingerprint = canonicalJsonHash({ reviewId, orderIntent });
    const intentId = `intent_${intentFingerprint}`;
    const intentResult = await input.query.query(
      `INSERT INTO order_intents(
         id, account_id, candidate_id, execution_review_id, environment,
         client_order_id, idempotency_key, strategy_key, symbol,
         underlying_symbol, asset_class, side, order_type, time_in_force,
       quantity, notional, limit_price, estimated_premium, max_risk, status,
       intent_fingerprint, lifecycle_fingerprint, request_payload,
         created_at, updated_at, operation, strategy_classification,
         lifecycle_state, review_id, contract_id, authorization_snapshot_id,
         autonomous_cycle_id, workstream_execution_id, fence_token
       ) SELECT $1, $2, $3, $4, 'paper', $5, $6, $7, $8, $9, $10, $11,
                $12, 'day', $13, $14, $15, $16, $17, 'created', $18, $19,
                $20::jsonb, $21, $21, $22, $23, 'review_created', $4, $24,
                $25, $26, $27, $28
         WHERE ${fenceSql(29)}
       ON CONFLICT (account_id, intent_fingerprint) DO NOTHING`,
      [intentId, row.account_id, row.candidate_id, reviewId, clientOrderId,
        `review:${payloadFingerprint}`, row.strategy_key, orderSymbol,
        option ? row.symbol : null, row.asset_class, entrySide,
        option ? "limit" : "market", quantity,
        option || shortEquity ? null : amount,
        option ? price : null, optionPositionCost,
        effectiveRisk, intentFingerprint, canonicalJsonHash({ status: "created", at: now.toISOString() }),
        JSON.stringify(orderIntent), now.toISOString(), operation,
        strategyClassification, option ? String(row.contract_id) : null,
        row.account_snapshot_id,
        process.env.AUTONOMOUS_CYCLE_ID?.trim() || input.fence.runId,
        input.fence.runId, input.fence.fencingToken,
        ...fenceValues(input.fence)]
    );
    if (intentResult.rowCount !== 1 && intentResult.rowCount !== 0) throw new Error("POSTGRES_ORDER_INTENT_PERSISTENCE_FAILED");
    await persistCandidateStage({
      query: input.query,
      fence: input.fence,
      candidateId: row.candidate_id,
      status: "sized",
      reason: "PAPER_ORDER_INTENT_CREATED",
      leapsSizing,
      now: now.toISOString()
    });
    created += review.rowCount === 1 ? 1 : 0;
  }
  return {
    status: "completed" as const,
    command: input.command,
    reviewsCreated: created,
    pendingIntentsCreated: created,
    skipped,
    capacityBlocked,
    confirmationCreated: false,
    paperOnly: true
  };
};
