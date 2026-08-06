import { createHmac } from "node:crypto";

import { canonicalJsonHash } from "../lib/canonicalJson.js";
import type { SchedulerFence } from "../repositories/contracts/common.js";
import { AUTONOMOUS_MARKET_DATA_FRESHNESS_SECONDS } from "./autonomousFreshnessPolicy.js";
import { paperLeapsExitConfig } from "./leapsExitPolicy.js";
import {
  evaluateManagedLeapsEntryRisk,
  evaluateManagedLeapsPositionReview,
  type ManagedLeapsRiskConfig
} from "./leapsRiskPolicy.js";
import { evaluateZeroDteDecision } from "./zeroDteDecisionPolicy.js";
import {
  LEAPS_CONTRACT_MULTIPLIER,
  resolveLeapsEntryAllocation,
  sizeLeapsEntry,
  type LeapsEntrySizingResult
} from "./leapsEntryAllocationService.js";
import {
  optionDaysToExpiration,
  parseOptionSymbol
} from "./optionSymbolService.js";
import { classifyManagedOptionLane } from "./optionLanePolicy.js";
import {
  type StrategyClassification,
  type TradeOperation
} from "./autonomousTradeLifecycleService.js";
import {
  paperExplorationProfile,
  paperExplorationThresholds,
  type PaperExplorationThresholds
} from "./paperExplorationConfig.js";
import { optionsQuoteConfig } from "./optionQuoteNormalizer.js";
import {
  arbitratePortfolioResources,
  type PortfolioArbitrationProposal,
  type PortfolioOrderExposure,
  type PortfolioPendingCommitment,
  type PortfolioPositionExposure,
  type PortfolioResourceContext
} from "./portfolioResourceArbitrator.js";
import {
  persistPortfolioArbitrationDecisions
} from "./postgresPortfolioArbitrationService.js";
import {
  scopePostgresPortfolioStatePacket,
  validatePostgresPortfolioStatePacket,
  type PortfolioStatePacket
} from "./postgresPortfolioStatePacketService.js";

export type PostgresReviewQuery = {
  query: (sql: string, values?: readonly unknown[]) => Promise<{
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }>;
};

export type LeapsMonitoringSignal = {
  positionId: string;
  optionSymbol: string;
  action: "review" | "partial_exit_review";
  executable: false;
  suggestedQuantity: number | null;
  reasons: string[];
};

export type PostgresReviewWorkflowResult = {
  status: "no_op" | "completed";
  code?: string;
  command?: string;
  reviewsCreated: number;
  pendingIntentsCreated: number;
  capacityBlocked: number;
  skipped?: number;
  arbitrationDecisions?: number;
  arbitrationApproved?: number;
  arbitrationResized?: number;
  arbitrationSkipped?: number;
  confirmationCreated?: boolean;
  paperOnly?: boolean;
  leapsMonitoringSignals?: LeapsMonitoringSignal[];
  leapsMonitoringSignalsPersisted?: number;
  leapsMonitoringSignalsResolved?: number;
};

type PersistableLeapsMonitoringSignal = LeapsMonitoringSignal & {
  accountId: string;
  candidateId: string | null;
  accountSnapshotId: string;
  accountFingerprint: string;
  marketTimestamp: string;
  marketRequestId: string | null;
  evidence: Record<string, unknown>;
};

type ReviewSourceRow = Record<string, unknown> & {
  candidate_id: string;
  research_run_id: string;
  candidate_rank: string | number;
  candidate_score: string | number | null;
  symbol: string;
  asset_class: "equity" | "option";
  option_symbol: string | null;
  preferred_expression: string;
  direction: "long" | "short";
  confidence: string | number;
  candidate_as_of: Date | string;
  account_id: string;
  account_snapshot_id: string;
  account_snapshot_as_of: Date | string;
  snapshot_fingerprint: string;
  structural_fingerprint: string;
  portfolio_state_packet?: unknown;
  buying_power: string | number;
  options_buying_power?: string | number | null;
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
  max_deployment_ratio?: string | number | null;
  cash_reserve_amount: string | number | null;
  cash_reserve_ratio: string | number | null;
  max_gross_exposure?: string | number | null;
  max_open_order_exposure?: string | number | null;
  portfolio_gross_exposure?: string | number | null;
  portfolio_open_order_exposure?: string | number | null;
  portfolio_deployed_amount?: string | number | null;
  portfolio_exposure_fingerprint?: string | null;
  risk_config_fingerprint?: string | null;
  allocation_config_fingerprint?: string | null;
  current_positions?: unknown;
  current_open_orders?: unknown;
  pending_commitments?: unknown;
  position_snapshot_as_of?: Date | string | null;
  open_order_snapshot_as_of?: Date | string | null;
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

const persistLeapsMonitoringSignals = async (input: {
  query: PostgresReviewQuery;
  fence: SchedulerFence;
  now: Date;
  signals: readonly PersistableLeapsMonitoringSignal[];
}) => {
  let persisted = 0;
  for (const signal of input.signals) {
    const signalFingerprint = canonicalJsonHash({
      positionId: signal.positionId,
      action: signal.action,
      suggestedQuantity: signal.suggestedQuantity,
      reasons: signal.reasons
    });
    const observationId = canonicalJsonHash({
      runId: input.fence.runId,
      positionId: signal.positionId,
      action: signal.action,
      marketTimestamp: signal.marketTimestamp
    });
    const id = `position_review_signal_${signalFingerprint}`;
    const nowIso = input.now.toISOString();
    const result = await input.query.query(
      `WITH fence_state AS (
         SELECT ${fenceSql(13)} AS held
       ), resolved_previous AS (
         UPDATE position_review_signals
         SET status = 'resolved', resolved_at = $12, updated_at = $12
         FROM fence_state
         WHERE fence_state.held
           AND position_review_signals.position_id = $3
           AND position_review_signals.signal_fingerprint <> $10
           AND position_review_signals.status = 'open'
         RETURNING position_review_signals.id
       ), upserted_signal AS (
         INSERT INTO position_review_signals(
           id, account_id, position_id, candidate_id, option_symbol, lane,
           action, executable, suggested_quantity, reasons, evidence,
           signal_fingerprint, last_observation_id, status,
           first_observed_at, last_observed_at,
           occurrences, created_at, updated_at
         )
         SELECT $1, $2, $3, $4, $5, 'options_leaps', $6, false, $7,
                $8::jsonb, $9::jsonb, $10, $11, 'open',
                $12, $12, 1, $12, $12
         FROM fence_state WHERE held
         ON CONFLICT (position_id, signal_fingerprint) DO UPDATE
         SET last_observed_at = EXCLUDED.last_observed_at,
             occurrences = position_review_signals.occurrences + CASE
               WHEN position_review_signals.last_observation_id =
                    EXCLUDED.last_observation_id THEN 0
               ELSE 1
             END,
             last_observation_id = EXCLUDED.last_observation_id,
             evidence = EXCLUDED.evidence,
             status = CASE
               WHEN position_review_signals.status = 'acknowledged'
                 THEN 'acknowledged'
               ELSE 'open'
             END,
             acknowledged_at = CASE
               WHEN position_review_signals.status = 'acknowledged'
                 THEN position_review_signals.acknowledged_at
               ELSE NULL
             END,
             resolved_at = CASE
               WHEN position_review_signals.status = 'acknowledged'
                 THEN position_review_signals.resolved_at
               ELSE NULL
             END,
             updated_at = EXCLUDED.updated_at
         RETURNING id
       )
       SELECT fence_state.held AS fence_held,
              (SELECT COUNT(*)::integer FROM upserted_signal) AS signal_count
       FROM fence_state`,
      [
        id,
        signal.accountId,
        signal.positionId,
        signal.candidateId,
        signal.optionSymbol,
        signal.action,
        signal.suggestedQuantity,
        JSON.stringify(signal.reasons),
        JSON.stringify({
          accountSnapshotId: signal.accountSnapshotId,
          accountFingerprint: signal.accountFingerprint,
          marketTimestamp: signal.marketTimestamp,
          marketRequestId: signal.marketRequestId,
          ...signal.evidence,
          scheduler: {
            jobName: input.fence.jobName,
            workstream: input.fence.workstream,
            ownerId: input.fence.ownerId,
            runId: input.fence.runId,
            fencingToken: input.fence.fencingToken
          },
          paperOnly: true,
          brokerMutationPerformed: false
        }),
        signalFingerprint,
        observationId,
        nowIso,
        ...fenceValues(input.fence)
      ]
    );
    const outcome = result.rowCount === 1 ? result.rows[0] : undefined;
    if (!outcome) throw new Error("POSTGRES_LEAPS_REVIEW_SIGNAL_PERSISTENCE_FAILED");
    if (outcome.fence_held !== true) throw new Error("SCHEDULER_FENCE_LOST");
    const count = Number(outcome.signal_count);
    if (!Number.isInteger(count) || count !== 1) {
      throw new Error("POSTGRES_LEAPS_REVIEW_SIGNAL_PERSISTENCE_FAILED");
    }
    persisted += count;
  }
  return persisted;
};

const resolveCurrentLeapsMonitoringSignals = async (input: {
  query: PostgresReviewQuery;
  fence: SchedulerFence;
  now: Date;
  positionIds: readonly string[];
}) => {
  let resolved = 0;
  for (const positionId of input.positionIds) {
    const result = await input.query.query(
      `WITH fence_state AS (
         SELECT ${fenceSql(3)} AS held
       ), resolved_signals AS (
         UPDATE position_review_signals
         SET status = 'resolved', resolved_at = $2, updated_at = $2
         FROM fence_state
         WHERE fence_state.held
           AND position_review_signals.position_id = $1
           AND position_review_signals.status = 'open'
         RETURNING position_review_signals.id
       )
       SELECT fence_state.held AS fence_held,
              (SELECT COUNT(*)::integer FROM resolved_signals) AS resolved_count
       FROM fence_state`,
      [positionId, input.now.toISOString(), ...fenceValues(input.fence)]
    );
    const outcome = result.rowCount === 1 ? result.rows[0] : undefined;
    if (!outcome) throw new Error("POSTGRES_LEAPS_REVIEW_SIGNAL_RESOLUTION_FAILED");
    if (outcome.fence_held !== true) throw new Error("SCHEDULER_FENCE_LOST");
    const count = Number(outcome.resolved_count);
    if (!Number.isInteger(count) || count < 0) {
      throw new Error("POSTGRES_LEAPS_REVIEW_SIGNAL_RESOLUTION_FAILED");
    }
    resolved += count;
  }
  return resolved;
};
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
const authoritativeOptionEvidence = (row: ReviewSourceRow) => {
  const candidate = optionDecisionInputs(row);
  const snapshot = jsonRecord(row.market_evidence);
  const merged = { ...candidate, ...snapshot };
  for (const field of [
    "bid", "ask", "midpoint", "last", "volume", "openInterest",
    "impliedVolatility", "delta", "gamma", "theta", "vega", "rho",
    "spread", "spreadPct", "underlyingPrice", "requestedFeed",
    "effectiveFeed", "provider", "transport", "bidSize", "askSize",
    "lastTrade", "lastTradeTimestamp", "spreadDollars", "quoteTimestamp",
    "quoteAgeSeconds", "quoteFreshnessStatus", "providerTimestamp",
    "receiptTimestamp", "persistenceTimestamp", "requestId", "endpoint",
    "pageToken", "retrievedAt", "feed", "environment"
  ]) {
    merged[field] = Object.prototype.hasOwnProperty.call(snapshot, field)
      ? snapshot[field]
      : null;
  }
  return merged;
};
const managedLeapsRiskConfig = (): ManagedLeapsRiskConfig => {
  const config = paperLeapsExitConfig();
  return {
    minimumEntryDelta: config.minDeltaEntry,
    maximumEntryDelta: config.maxDeltaEntry,
    minimumReviewDelta: config.minDeltaReview,
    maximumThetaPctOfPremium: config.maxThetaPctOfPremium,
    maximumImpliedVolatility: config.maxImpliedVolatility,
    reviewLossPct: config.reviewLossPct,
    hardStopLossPct: config.hardStopLossPct,
    partialProfitTakePct: config.partialProfitTakePct,
    fullProfitTakePct: config.fullProfitTakePct,
    dteExitThreshold: config.dteExitThreshold,
    severeTrendExitSma: config.severeTrendExitSma,
    reviewIntervalDays: config.reviewIntervalDays
  };
};
type OptionLaneDecision =
  | ReturnType<typeof evaluateZeroDteDecision>
  | ReturnType<typeof evaluateManagedLeapsEntryRisk>
  | {
      eligible: false;
      action: "blocked";
      score: 0;
      blockers: string[];
      inputsUsed: Record<string, unknown>;
    };
type CanonicalOptionLane = "options_0dte" | "options_standard" | "options_leaps";
type OptionLaneResolution = {
  canonicalLane: CanonicalOptionLane;
  laneDecision: OptionLaneDecision | null;
};
const evaluateOptionLaneEntry = (input: {
  row: ReviewSourceRow;
  executablePremium: number;
  now: Date;
}): OptionLaneResolution | null => {
  if (input.row.asset_class !== "option") return null;
  const family = String(input.row.candidate_strategy_family ?? "")
    .trim()
    .toLowerCase();
  const optionType = String(input.row.contract_type ?? "") as "call" | "put";
  const evidence = authoritativeOptionEvidence(input.row);
  const classifiedLane = classifyManagedOptionLane({
    expirationDate: isoDateOnly(input.row.contract_expiration_date),
    observedAt: input.now,
    managedLeapsMinDte: paperLeapsExitConfig().minDteAtEntry
  });
  if (classifiedLane === "expired") {
    return {
      canonicalLane: "options_standard",
      laneDecision: {
        eligible: false,
        action: "blocked",
        score: 0,
        blockers: ["OPTION_CONTRACT_EXPIRED"],
        inputsUsed: {
          family,
          expirationDate: isoDateOnly(input.row.contract_expiration_date)
        }
      }
    };
  }
  const canonicalLane = classifiedLane;
  const expectedFamily = canonicalLane === "options_0dte"
    ? "zero_dte_spy"
    : canonicalLane === "options_leaps"
      ? "leaps"
      : "standard_option";
  if (family && family !== expectedFamily) {
    return {
      canonicalLane,
      laneDecision: {
        eligible: false,
        action: "blocked",
        score: 0,
        blockers: ["OPTION_LANE_FAMILY_DTE_MISMATCH"],
        inputsUsed: {
          actualFamily: family || null,
          expectedFamily,
          canonicalLane,
          expirationDate: isoDateOnly(input.row.contract_expiration_date)
        }
      }
    };
  }
  if (canonicalLane === "options_0dte") {
    return { canonicalLane, laneDecision: evaluateZeroDteDecision({
      underlyingSymbol: input.row.symbol,
      expirationDate: isoDateOnly(input.row.contract_expiration_date),
      optionType,
      direction: input.row.direction,
      observedAt: input.now.toISOString(),
      bid: finite(evidence.bid),
      ask: finite(evidence.ask),
      volume: finite(evidence.volume),
      openInterest: finite(evidence.openInterest),
      moneyness: finite(evidence.moneyness),
      liquidityScore: finite(evidence.liquidityScore)
    }) };
  }
  if (canonicalLane === "options_leaps") {
    return { canonicalLane, laneDecision: evaluateManagedLeapsEntryRisk({
      optionType,
      premium: input.executablePremium,
      impliedVolatility: finite(evidence.impliedVolatility),
      delta: finite(evidence.delta),
      gamma: finite(evidence.gamma),
      theta: finite(evidence.theta),
      vega: finite(evidence.vega),
      rho: finite(evidence.rho)
    }, managedLeapsRiskConfig()) };
  }
  return { canonicalLane, laneDecision: null };
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
    evidence: authoritativeOptionEvidence(row),
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
    finite(row.contract_multiplier) !== LEAPS_CONTRACT_MULTIPLIER ||
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
  const managedLeapsResearchEvidence =
    input.row.asset_class === "option" &&
    String(input.row.candidate_strategy_family ?? "").trim().toLowerCase() ===
      "leaps" &&
    classifyManagedOptionLane({
      expirationDate: isoDateOnly(input.row.contract_expiration_date),
      observedAt: input.now,
      managedLeapsMinDte: paperLeapsExitConfig().minDteAtEntry
    }) === "options_leaps";
  // The observed LEAPS research-to-review path takes about 34 minutes. Keep
  // persisted research evidence valid for one hour; submission still uses the
  // unchanged exact-contract execution freshness gate.
  const maxAgeSeconds = managedLeapsResearchEvidence
    ? 60 * 60
    : Math.min(
        input.maxMarketAgeSeconds,
        input.row.asset_class === "option"
          ? optionsQuoteConfig().maxAgeMs / 1_000
          : Number.POSITIVE_INFINITY
      );
  const maxAge = maxAgeSeconds * 1_000;
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
  "POSTGRES_REVIEW_OPTION_CONTRACT_INVALID:",
  "POSTGRES_REVIEW_OPTION_QUOTE_INVALID:"
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
  SELECT id FROM research_runs
  WHERE status = 'completed'
    AND ($1::text IS NULL OR id = $1)
  ORDER BY completed_at DESC, id DESC LIMIT 1
), current_account AS (
  SELECT * FROM accounts WHERE environment = 'paper'
  ORDER BY updated_at DESC, id LIMIT 1
), shared_positions AS (
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', position.id,
          'symbol', COALESCE(position.option_symbol, position.symbol),
          'underlyingSymbol', COALESCE(
            position.underlying_symbol,
            position.symbol
          ),
          'direction', position.side,
          'resourceExposure', ABS(
            COALESCE(position.market_value, position.cost_basis)
          )
        )
        ORDER BY position.id
      ) FILTER (WHERE position.id IS NOT NULL),
      '[]'::jsonb
    ) AS current_positions,
    MAX(
      COALESCE(position.last_reconciled_at, position.updated_at)
    ) AS position_snapshot_as_of
  FROM current_account account
  LEFT JOIN positions position
    ON position.account_id = account.id
   AND position.status IN ('open', 'closing')
), shared_open_orders AS (
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', broker_order.id,
          'symbol', broker_order.symbol,
          'underlyingSymbol', COALESCE(
            intent.underlying_symbol,
            broker_order.symbol
          ),
          'direction', CASE
            WHEN broker_order.side IN ('buy', 'buy_to_open') THEN 'long'
            ELSE 'short'
          END,
          'status', broker_order.status,
          'resourceExposure', ABS(
            CASE
              WHEN broker_order.asset_class = 'option'
                THEN COALESCE(
                  intent.max_risk,
                  intent.estimated_premium
                )
              ELSE COALESCE(
                broker_order.notional,
                broker_order.quantity * COALESCE(
                  broker_order.limit_price,
                  intent.limit_price
                ),
                intent.max_risk,
                intent.estimated_premium
              )
            END
          )
        )
        ORDER BY broker_order.id
      ) FILTER (WHERE broker_order.id IS NOT NULL),
      '[]'::jsonb
    ) AS current_open_orders,
    MAX(
      COALESCE(
        broker_order.last_broker_update_at,
        broker_order.updated_at
      )
    ) AS open_order_snapshot_as_of
  FROM current_account account
  LEFT JOIN orders broker_order
    ON broker_order.account_id = account.id
   AND lower(btrim(broker_order.status)) NOT IN (
     'canceled', 'cancelled', 'expired', 'filled', 'rejected', 'replaced'
   )
  LEFT JOIN order_intents intent
    ON intent.id = broker_order.order_intent_id
), shared_pending_commitments AS (
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', intent.id,
        'symbol', intent.symbol,
        'underlyingSymbol', COALESCE(
          intent.underlying_symbol,
          intent.symbol
        ),
        'direction', CASE
          WHEN intent.side IN ('buy', 'buy_to_open') THEN 'long'
          ELSE 'short'
        END,
        'resourceExposure', ABS(
          COALESCE(
            intent.max_risk,
            intent.notional,
            intent.estimated_premium
          )
        )
      )
      ORDER BY intent.id
    ) FILTER (WHERE intent.id IS NOT NULL),
    '[]'::jsonb
  ) AS pending_commitments
  FROM current_account account
  LEFT JOIN order_intents intent
    ON intent.account_id = account.id
   AND intent.reservation_id IS NULL
   AND intent.status IN (
     'created', 'ready_for_submission', 'submission_pending',
     'submitted', 'ambiguous'
   )
   AND NOT EXISTS (
     SELECT 1
     FROM orders mapped_order
     WHERE mapped_order.order_intent_id = intent.id
   )
)
SELECT candidate.id AS candidate_id,
       candidate.research_run_id,
       candidate.rank AS candidate_rank,
       candidate.score::text AS candidate_score,
       candidate.symbol, candidate.asset_class,
       candidate.option_symbol, candidate.preferred_expression,
       candidate.direction, candidate.confidence,
       candidate.strategy_family AS candidate_strategy_family,
       candidate.as_of AS candidate_as_of,
       candidate.signal_inputs,
       account.id AS account_id,
       account.broker_account_id AS broker_account_id,
       snapshot.id AS account_snapshot_id,
       snapshot.observed_at AS account_snapshot_as_of,
       snapshot.snapshot_fingerprint,
       snapshot.evidence->>'structuralPortfolioFingerprint' AS structural_fingerprint,
       snapshot.evidence->'portfolioStatePacket' AS portfolio_state_packet,
       snapshot.buying_power::text, snapshot.options_buying_power::text,
       snapshot.cash::text, snapshot.equity::text,
       allocation.strategy_key, allocation.allocation_amount::text,
       allocation.allocation_ratio::text, allocation.reserved_amount::text,
       allocation.deployed_amount::text,
       allocation.config_fingerprint AS allocation_config_fingerprint,
       limits.config_fingerprint AS risk_config_fingerprint,
       limits.max_position_notional::text,
       limits.max_symbol_notional::text, limits.max_deployment_amount::text,
       limits.max_deployment_ratio::text,
       limits.cash_reserve_amount::text, limits.cash_reserve_ratio::text,
       limits.max_gross_exposure::text,
       limits.max_open_order_exposure::text,
       portfolio.gross_exposure::text AS portfolio_gross_exposure,
       portfolio.open_order_exposure::text
         AS portfolio_open_order_exposure,
       portfolio.deployed_amount::text AS portfolio_deployed_amount,
       portfolio.exposure_fingerprint AS portfolio_exposure_fingerprint,
       shared_positions.current_positions,
       shared_open_orders.current_open_orders,
       shared_pending_commitments.pending_commitments,
       COALESCE(
         shared_positions.position_snapshot_as_of,
         snapshot.observed_at
       ) AS position_snapshot_as_of,
       COALESCE(
         shared_open_orders.open_order_snapshot_as_of,
         snapshot.observed_at
       ) AS open_order_snapshot_as_of,
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
CROSS JOIN shared_positions
CROSS JOIN shared_open_orders
CROSS JOIN shared_pending_commitments
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
LEFT JOIN LATERAL (
  SELECT exposure.gross_exposure, exposure.open_order_exposure,
         exposure.deployed_amount,
         exposure.exposure_fingerprint
  FROM portfolio_exposure exposure
  WHERE exposure.account_id = account.id
    AND exposure.scope_type = 'portfolio'
    AND exposure.scope_key = 'portfolio'
  ORDER BY exposure.observed_at DESC, exposure.id DESC
  LIMIT 1
) portfolio ON true
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
  AND (
    candidate.lifecycle_status NOT IN ('closed','expired','rejected','skipped','blocked')
    OR (
      $1::text IS NOT NULL
      AND candidate.lifecycle_status = 'blocked'
      AND candidate.decision_reason LIKE 'POSTGRES_REVIEW_MARKET_EVIDENCE_STALE:%'
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM execution_reviews existing_review
    WHERE existing_review.account_id = account.id
      AND existing_review.candidate_id = candidate.id
      AND existing_review.source_snapshot_id = snapshot.id
      AND existing_review.review_type = 'entry'
      AND existing_review.client_order_id IS NOT NULL
  )
  ${command === "paper:options:discover" ? `AND candidate.option_symbol IS NOT NULL
    AND candidate.symbol = $2
    AND contract.expiration_date = (($3::timestamptz AT TIME ZONE 'America/New_York')::date + $4::integer)` : ""}
  ${command === "hedge:review" ? "AND candidate.strategy_family ILIKE '%hedge%'" : ""}
ORDER BY candidate.rank, candidate.id
LIMIT ${maxCandidates}`;

const exitSourceSql = (command: string) => {
  const severeTrendBars = Math.min(
    1_000,
    paperLeapsExitConfig().severeTrendExitSma
  );
  return `WITH current_account AS (
  SELECT * FROM accounts
  WHERE broker = 'alpaca' AND environment = 'paper'
    AND lower(status) = 'active'
  ORDER BY updated_at DESC, id LIMIT 1
), latest_account_snapshot AS (
  SELECT snapshot.*
  FROM account_snapshots snapshot
  CROSS JOIN current_account account
  WHERE snapshot.account_id = account.id
  ORDER BY snapshot.observed_at DESC, snapshot.id DESC
  LIMIT 1
), current_snapshot AS (
  SELECT snapshot.*
  FROM latest_account_snapshot snapshot
  WHERE lower(snapshot.account_status) = 'active'
    AND lower(snapshot.source) = 'alpaca'
    AND snapshot.observed_at >= $1::timestamptz - make_interval(secs => $2::integer)
    AND snapshot.observed_at <= $1::timestamptz + interval '1 minute'
), resolved_terminal_signals AS (
  UPDATE position_review_signals signal
  SET status = 'resolved', resolved_at = $1::timestamptz,
      updated_at = $1::timestamptz
  FROM positions terminal_position, current_account account,
       current_snapshot snapshot
  WHERE ${fenceSql(3)}
    AND signal.account_id = account.id
    AND signal.position_id = terminal_position.id
    AND terminal_position.account_id = account.id
    AND terminal_position.last_reconciled_at >=
        $1::timestamptz - make_interval(secs => $2::integer)
    AND terminal_position.last_reconciled_at <=
        $1::timestamptz + interval '1 minute'
    AND signal.status = 'open'
    AND (
      terminal_position.status NOT IN ('open', 'closing')
      OR COALESCE(terminal_position.available_quantity, 0) <= 0
    )
  RETURNING signal.id
)
SELECT position.id AS position_id,
       COALESCE(position.candidate_id, opening_intent.candidate_id) AS candidate_id,
       position.opening_order_id,
       opening_intent.id AS opening_intent_id,
       COALESCE(opening_intent.review_id, opening_intent.execution_review_id)
         AS opening_review_id,
       opening_review.created_at AS last_reviewed_at,
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
       account.broker AS account_broker,
       account.status AS account_record_status,
       snapshot.account_status AS account_snapshot_status,
       snapshot.source AS account_snapshot_source,
       snapshot.observed_at AS account_snapshot_observed_at,
       position.last_reconciled_at AS position_last_reconciled_at,
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
CROSS JOIN current_snapshot snapshot
LEFT JOIN candidates candidate ON candidate.id = position.candidate_id
LEFT JOIN orders opening_order ON opening_order.id = position.opening_order_id
LEFT JOIN order_intents opening_intent
  ON opening_intent.id = opening_order.order_intent_id
LEFT JOIN execution_reviews opening_review
  ON opening_review.id = COALESCE(
    opening_intent.review_id,
    opening_intent.execution_review_id
  )
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
  AND position.last_reconciled_at >=
      $1::timestamptz - make_interval(secs => $2::integer)
  AND position.last_reconciled_at <= $1::timestamptz + interval '1 minute'
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

const assertCurrentLeapsReviewAuthority = (input: {
  row: Record<string, unknown>;
  now: Date;
  maxAgeSeconds: number;
  positionId: string;
}) => {
  if (
    String(input.row.account_broker ?? "").trim().toLowerCase() !== "alpaca" ||
    String(input.row.account_record_status ?? "").trim().toLowerCase() !== "active" ||
    String(input.row.account_snapshot_status ?? "").trim().toLowerCase() !== "active" ||
    String(input.row.account_snapshot_source ?? "").trim().toLowerCase() !== "alpaca"
  ) {
    throw new Error(
      `POSTGRES_LEAPS_REVIEW_ACCOUNT_AUTHORITY_INVALID:${input.positionId}`
    );
  }
  for (const [scope, value] of [
    ["ACCOUNT", input.row.account_snapshot_observed_at],
    ["POSITION", input.row.position_last_reconciled_at]
  ] as const) {
    const timestamp = Date.parse(String(value ?? ""));
    const age = input.now.getTime() - timestamp;
    if (
      !Number.isFinite(timestamp) ||
      age < -60_000 ||
      age > input.maxAgeSeconds * 1_000
    ) {
      throw new Error(
        `POSTGRES_LEAPS_REVIEW_${scope}_AUTHORITY_STALE:${input.positionId}`
      );
    }
  }
};

const runExitReview = async (input: {
  command: string;
  query: PostgresReviewQuery;
  fence: SchedulerFence;
  signingKey: string;
  now: Date;
  maxMarketAgeSeconds: number;
}) => {
  const rows = (await input.query.query(
    exitSourceSql(input.command),
    [
      input.now.toISOString(),
      input.maxMarketAgeSeconds,
      ...fenceValues(input.fence)
    ]
  )).rows as Array<Record<string, unknown>>;
  const leapsMonitoringSignals: LeapsMonitoringSignal[] = [];
  const persistableLeapsMonitoringSignals: PersistableLeapsMonitoringSignal[] = [];
  const resolvedLeapsPositionIds: string[] = [];
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
    const leaps = strategyClassification === "leaps_long_call" ||
      strategyClassification === "leaps_long_put";
    if (leaps) {
      assertCurrentLeapsReviewAuthority({
        row,
        now: input.now,
        maxAgeSeconds: input.maxMarketAgeSeconds,
        positionId
      });
    }
    const directionalReturnPct = Number((directionalReturn * 100).toFixed(8));
    const severeTrendBarCount = finite(row.severe_trend_bar_count);
    const underlyingClose = finite(row.underlying_close);
    const severeTrendSma = finite(row.severe_trend_sma);
    const optionEvidence = jsonRecord(row.market_evidence);
    const leapsReview = leaps && parsedOption?.ok === true
      ? evaluateManagedLeapsPositionReview({
          optionType: parsedOption.optionType,
          premium: price,
          quantity,
          directionalReturnPct,
          currentDte,
          underlyingClose,
          severeTrendSma,
          severeTrendBarCount,
          impliedVolatility: finite(optionEvidence.impliedVolatility),
          delta: finite(optionEvidence.delta),
          gamma: finite(optionEvidence.gamma),
          theta: finite(optionEvidence.theta),
          vega: finite(optionEvidence.vega),
          rho: finite(optionEvidence.rho),
          lastReviewedAt: row.last_reviewed_at
            ? String(row.last_reviewed_at)
            : null,
          now: input.now.toISOString()
        }, managedLeapsRiskConfig())
      : null;
    if (leapsReview?.action === "hold") {
      resolvedLeapsPositionIds.push(positionId);
    }
    if (
      leapsReview?.action === "review" ||
      leapsReview?.action === "partial_exit_review"
    ) {
      const accountId = String(row.account_id ?? "").trim();
      const accountSnapshotId = String(row.account_snapshot_id ?? "").trim();
      const accountFingerprint = String(row.structural_fingerprint ?? "").trim();
      if (!accountId || !accountSnapshotId || !accountFingerprint) {
        throw new Error(
          `POSTGRES_LEAPS_REVIEW_ACCOUNT_EVIDENCE_MISSING:${positionId}`
        );
      }
      const signal: LeapsMonitoringSignal = {
        positionId,
        optionSymbol: String(row.order_symbol),
        action: leapsReview.action,
        executable: false,
        suggestedQuantity: leapsReview.suggestedQuantity,
        reasons: leapsReview.reasons
      };
      leapsMonitoringSignals.push(signal);
      persistableLeapsMonitoringSignals.push({
        ...signal,
        accountId,
        candidateId: row.candidate_id ? String(row.candidate_id) : null,
        accountSnapshotId,
        accountFingerprint,
        marketTimestamp: timestamp,
        marketRequestId: row.market_request_id
          ? String(row.market_request_id)
          : null,
        evidence: {
          source: "postgres.option_snapshots",
          impliedVolatility: finite(optionEvidence.impliedVolatility),
          delta: finite(optionEvidence.delta),
          gamma: finite(optionEvidence.gamma),
          theta: finite(optionEvidence.theta),
          vega: finite(optionEvidence.vega),
          rho: finite(optionEvidence.rho),
          directionalReturnPct,
          currentDte,
          observedPrice: price,
          quantity
        }
      });
    }
    const reason = option
      ? leaps
        ? leapsReview?.action === "full_exit"
          ? leapsReview.reasons[0] ?? null
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
  const leapsMonitoringSignalsPersisted = await persistLeapsMonitoringSignals({
    query: input.query,
    fence: input.fence,
    now: input.now,
    signals: persistableLeapsMonitoringSignals
  });
  const leapsMonitoringSignalsResolved = await resolveCurrentLeapsMonitoringSignals({
    query: input.query,
    fence: input.fence,
    now: input.now,
    positionIds: resolvedLeapsPositionIds
  });
  if (!eligible.length) {
    return {
      status: "no_op" as const,
      code: "NO_POSTGRES_EXIT_TRIGGER",
      reviewsCreated: 0,
      pendingIntentsCreated: 0,
      capacityBlocked: 0,
      leapsMonitoringSignals,
      ...(leapsMonitoringSignals.length > 0
        ? { leapsMonitoringSignalsPersisted }
        : {}),
      ...(leapsMonitoringSignalsResolved > 0
        ? { leapsMonitoringSignalsResolved }
        : {})
    };
  }
  let created = 0;
  let skipped = 0;
  let fullExitSignalsResolved = 0;
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
    if (
      item.strategyClassification === "leaps_long_call" ||
      item.strategyClassification === "leaps_long_put"
    ) {
      fullExitSignalsResolved += await resolveCurrentLeapsMonitoringSignals({
        query: input.query,
        fence: input.fence,
        now: input.now,
        positionIds: [positionId]
      });
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
    confirmationCreated: created > 0, paperOnly: true,
    leapsMonitoringSignals,
    ...(leapsMonitoringSignals.length > 0
      ? { leapsMonitoringSignalsPersisted }
      : {}),
    ...(leapsMonitoringSignalsResolved + fullExitSignalsResolved > 0
      ? {
          leapsMonitoringSignalsResolved:
            leapsMonitoringSignalsResolved + fullExitSignalsResolved
        }
      : {})
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

const jsonRecords = (value: unknown): Record<string, unknown>[] => {
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
    );
  }
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    return jsonRecords(JSON.parse(value));
  } catch {
    return [];
  }
};

const timestamp = (value: unknown): string | null => {
  const parsed = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};

const arbitrationLane = (
  row: ReviewSourceRow,
  canonicalLane: CanonicalOptionLane | null
): PortfolioArbitrationProposal["lane"] => {
  return row.asset_class === "option"
    ? canonicalLane ?? "options_standard"
    : "equity";
};

const arbitrationPriority = (
  lane: PortfolioArbitrationProposal["lane"]
) => lane === "equity" ? 0 : lane === "options_0dte" ? 1 : 2;

const positionExposure = (
  value: Record<string, unknown>
): PortfolioPositionExposure | null => {
  const id = String(value.id ?? "").trim();
  const symbol = String(value.symbol ?? "").trim().toUpperCase();
  const underlyingSymbol = String(
    value.underlyingSymbol ?? value.underlying_symbol ?? ""
  ).trim().toUpperCase();
  const direction = String(value.direction ?? "").trim().toLowerCase();
  const resourceExposure = finite(
    value.resourceExposure ?? value.resource_exposure
  );
  return id && symbol && underlyingSymbol &&
    (direction === "long" || direction === "short")
    ? {
        id,
        symbol,
        underlyingSymbol,
        direction,
        resourceExposure:
          resourceExposure !== null && resourceExposure >= 0
            ? resourceExposure
            : null
      }
    : null;
};

const orderExposure = (
  value: Record<string, unknown>
): PortfolioOrderExposure | null => {
  const base = positionExposure(value);
  const status = String(value.status ?? "").trim();
  return base && status ? { ...base, status } : null;
};

const portfolioResourceContext = (
  rows: readonly ReviewSourceRow[]
): PortfolioResourceContext => {
  const shared = rows[0]!;
  if (rows.some((row) =>
    row.account_id !== shared.account_id ||
    row.account_snapshot_id !== shared.account_snapshot_id ||
    row.snapshot_fingerprint !== shared.snapshot_fingerprint
  )) {
    throw new Error("POSTGRES_PORTFOLIO_ARBITRATION_CONTEXT_MISMATCH");
  }
  const buyingPower = finite(shared.buying_power);
  const cash = finite(shared.cash);
  const equity = finite(shared.equity);
  if (buyingPower === null || cash === null || equity === null) {
    throw new Error("POSTGRES_REVIEW_ACCOUNT_SIZING_EVIDENCE_MISSING");
  }
  // Match the existing paper submit-state convention: use the dedicated
  // options balance when the account snapshot supplies one, otherwise the
  // verified general buying-power balance remains the conservative fallback.
  const optionsBuyingPower =
    finite(shared.options_buying_power) ?? buyingPower;
  const cashReserve = shared.cash_reserve_amount !== null
    ? finite(shared.cash_reserve_amount) ?? 0
    : equity * (finite(shared.cash_reserve_ratio) ?? 0);
  const allocationLimit = shared.allocation_amount !== null
    ? finite(shared.allocation_amount)
    : finite(shared.allocation_ratio) !== null
      ? buyingPower * finite(shared.allocation_ratio)!
      : buyingPower;
  const reserved = finite(shared.reserved_amount) ?? 0;
  const allocationDeployed = finite(shared.deployed_amount) ?? 0;
  const portfolioDeployed = finite(shared.portfolio_deployed_amount) ??
    allocationDeployed;
  const grossExposure = finite(shared.portfolio_gross_exposure) ??
    portfolioDeployed;
  const deploymentAmountLimit = finite(shared.max_deployment_amount);
  const deploymentRatio = finite(shared.max_deployment_ratio);
  const grossLimit = finite(shared.max_gross_exposure);
  const openOrderLimit = finite(shared.max_open_order_exposure);
  const openOrderExposure = finite(
    shared.portfolio_open_order_exposure
  ) ?? 0;
  const allocationRemaining = allocationLimit === null
    ? 0
    : Math.max(0, allocationLimit - reserved - allocationDeployed);
  const deploymentAmountRemaining = deploymentAmountLimit === null
    ? buyingPower
    : Math.max(0, deploymentAmountLimit - portfolioDeployed);
  const deploymentRatioRemaining = deploymentRatio === null
    ? buyingPower
    : Math.max(0, equity * deploymentRatio - portfolioDeployed);
  const deploymentRemaining = Math.min(
    deploymentAmountRemaining,
    deploymentRatioRemaining
  );
  const grossRemaining = grossLimit === null
    ? buyingPower
    : Math.max(0, grossLimit - grossExposure);
  const openOrderRemaining = openOrderLimit === null
    ? buyingPower
    : Math.max(0, openOrderLimit - openOrderExposure);
  const accountSnapshotAsOf = timestamp(shared.account_snapshot_as_of);
  if (!accountSnapshotAsOf) {
    throw new Error("POSTGRES_PORTFOLIO_ARBITRATION_SNAPSHOT_TIME_MISSING");
  }
  const currentPositions = jsonRecords(shared.current_positions)
    .map(positionExposure)
    .filter((value): value is PortfolioPositionExposure => Boolean(value));
  const aggregatePositionsAvailable = shared.current_positions !== undefined &&
    shared.current_positions !== null;
  const currentOpenOrders = jsonRecords(shared.current_open_orders)
    .map(orderExposure)
    .filter((value): value is PortfolioOrderExposure => Boolean(value));
  const pendingCommitments = jsonRecords(shared.pending_commitments)
    .map(positionExposure)
    .filter((value): value is PortfolioPendingCommitment => Boolean(value));
  // An unknown unreserved commitment is unavailable shared buying-power
  // context, not a proposal-local gap. Do not treat it as zero: the prompt
  // permits the current pass to fail closed while unrelated cycles continue.
  const pendingResource = pendingCommitments.every(
    ({ resourceExposure }) => resourceExposure !== null
  )
    ? pendingCommitments.reduce(
        (sum, commitment) => sum + commitment.resourceExposure!,
        0
      )
    : null;

  // Legacy count columns remain fail-closed compatibility evidence only when
  // an older caller does not supply the authoritative aggregate JSON.
  for (const row of rows) {
    const orderSymbol = String(row.option_symbol ?? row.symbol)
      .trim()
      .toUpperCase();
    const underlyingSymbol = String(row.symbol).trim().toUpperCase();
    if (
      !aggregatePositionsAvailable &&
      Number(row.open_position_count) > 0 &&
      !currentPositions.some(({ symbol }) => symbol === orderSymbol)
    ) {
      currentPositions.push({
        id: `postgres-position:${row.candidate_id}`,
        symbol: orderSymbol,
        underlyingSymbol,
        direction: row.direction,
        resourceExposure: null
      });
    }
    if (
      Number(row.open_order_count) > 0 &&
      !currentOpenOrders.some(({ symbol }) => symbol === orderSymbol)
    ) {
      currentOpenOrders.push({
        id: `postgres-order:${row.candidate_id}`,
        symbol: orderSymbol,
        underlyingSymbol,
        direction: row.direction,
        status: "active_postgres_count",
        resourceExposure: null
      });
    }
  }
  const compareExposureId = (
    left: PortfolioPositionExposure,
    right: PortfolioPositionExposure
  ) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  currentPositions.sort(compareExposureId);
  currentOpenOrders.sort(compareExposureId);
  pendingCommitments.sort(compareExposureId);
  const buyingPowerAvailable = pendingResource === null
    ? null
    : Math.max(0, buyingPower - pendingResource);
  const optionsBuyingPowerAvailable = pendingResource === null
    ? null
    : Math.max(0, optionsBuyingPower - pendingResource);
  const cashAvailable = pendingResource === null
    ? null
    : Math.max(0, cash - cashReserve - pendingResource);
  const portfolioCapacityAvailable = pendingResource === null
    ? null
    : Math.floor(Math.min(
        buyingPowerAvailable!,
        cashAvailable!,
        Math.max(0, allocationRemaining - pendingResource),
        Math.max(0, deploymentRemaining - pendingResource),
        Math.max(0, grossRemaining - pendingResource),
        Math.max(0, openOrderRemaining - pendingResource)
      ) * 100) / 100;
  // The operational max_symbol_notional rule is keyed by the exact order
  // symbol downstream. It is not an underlying-wide limit, so do not invent a
  // cross-contract equity/options cap from it. The pure arbitrator retains a
  // distinct field for an authoritative underlying cap if one is added later.
  const maxUnderlyingExposure = null;
  const positionSnapshotAsOf =
    timestamp(shared.position_snapshot_as_of) ?? accountSnapshotAsOf;
  const openOrderSnapshotAsOf =
    timestamp(shared.open_order_snapshot_as_of) ?? accountSnapshotAsOf;
  const contextVersion = canonicalJsonHash({
    accountSnapshotId: shared.account_snapshot_id,
    accountFingerprint: shared.snapshot_fingerprint,
    structuralFingerprint: shared.structural_fingerprint,
    riskConfigFingerprint: shared.risk_config_fingerprint ?? null,
    allocationConfigFingerprint:
      shared.allocation_config_fingerprint ?? null,
    exposureFingerprint:
      shared.portfolio_exposure_fingerprint ?? null,
    buyingPowerAvailable,
    optionsBuyingPowerAvailable,
    cashAvailable,
    portfolioCapacityAvailable,
    maxUnderlyingExposure,
    currentPositions,
    currentOpenOrders,
    pendingCommitments,
    accountSnapshotAsOf,
    positionSnapshotAsOf,
    openOrderSnapshotAsOf
  });
  return {
    contextId: shared.account_snapshot_id,
    contextVersion,
    buyingPowerAvailable,
    optionsBuyingPowerAvailable,
    cashAvailable,
    portfolioCapacityAvailable,
    maxUnderlyingExposure,
    existingPositions: currentPositions,
    openOrders: currentOpenOrders,
    pendingCommitments,
    laneCapacityAvailable: {},
    accountSnapshotAsOf,
    positionSnapshotAsOf,
    openOrderSnapshotAsOf
  };
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
  researchRunId?: string;
  maxCandidates?: number;
  explorationThresholds?: PaperExplorationThresholds;
  leapsEntryAllocationEnv?: NodeJS.ProcessEnv;
}): Promise<PostgresReviewWorkflowResult> => {
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
  const researchRunId = String(input.researchRunId ?? "").trim() || null;
  if (researchRunId && researchRunId.length > 200) {
    throw new Error("POSTGRES_REVIEW_RESEARCH_RUN_ID_INVALID");
  }
  let sourceValues: readonly unknown[] = [researchRunId];
  if (input.command === "paper:options:discover") {
    const underlying = String(input.underlying ?? "").trim().toUpperCase();
    if (!/^[A-Z][A-Z.]{0,14}$/.test(underlying)) {
      throw new Error("POSTGRES_OPTION_DISCOVERY_UNDERLYING_REQUIRED");
    }
    if (!Number.isSafeInteger(input.dte) || input.dte! < 0 || input.dte! > 730) {
      throw new Error("POSTGRES_OPTION_DISCOVERY_DTE_INVALID");
    }
    sourceValues = [researchRunId, underlying, now.toISOString(), input.dte!];
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
    laneDecision: OptionLaneDecision | null;
    canonicalLane: CanonicalOptionLane | null;
    clientOrderId: string;
    reviewId: string;
    intentId: string;
    portfolioStatePacket: PortfolioStatePacket;
  }> = [];
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
    const laneResolution = evaluateOptionLaneEntry({
      row,
      executablePremium: price,
      now
    });
    const laneDecision = laneResolution?.laneDecision ?? null;
    const canonicalLane = laneResolution?.canonicalLane ?? null;
    if (laneDecision && !laneDecision.eligible) {
      blockedRows.push({
        row,
        reason: laneDecision.blockers[0] ?? "POSTGRES_OPTION_LANE_POLICY_BLOCKED"
      });
      continue;
    }
    const isLeaps = canonicalLane === "options_leaps";
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
      !Math.floor(
        amount / (price * (finite(row.contract_multiplier) ?? Number.NaN))
      )
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
    const orderSymbol = String(row.option_symbol ?? row.symbol).toUpperCase();
    const clientOrderPrefix = canonicalLane === "options_leaps"
      ? "pg-leaps-"
      : canonicalLane === "options_0dte"
        ? "pg-0dte-"
        : "pg-";
    const clientOrderId = `${clientOrderPrefix}${canonicalJsonHash({
      account: row.account_id,
      candidate: row.candidate_id,
      snapshot: row.account_snapshot_id
    }).slice(0, 32)}`;
    const basePacket = row.portfolio_state_packet as PortfolioStatePacket | null;
    if (!basePacket || typeof basePacket !== "object") {
      blockedRows.push({
        row,
        reason: "PORTFOLIO_STATE_PACKET_MISSING"
      });
      continue;
    }
    const reviewId = `review_${canonicalJsonHash({
      accountId: row.account_id,
      candidateId: row.candidate_id,
      accountSnapshotId: row.account_snapshot_id,
      clientOrderId,
      basePacketFingerprint: basePacket.packetFingerprint
    })}`;
    const intentId = `intent_${canonicalJsonHash({
      reviewId,
      clientOrderId,
      candidateId: row.candidate_id
    })}`;
    let portfolioStatePacket: PortfolioStatePacket;
    try {
      portfolioStatePacket = scopePostgresPortfolioStatePacket({
        basePacket,
        proposedContractIdentifier: row.asset_class === "option"
          ? orderSymbol
          : null,
        marketEvidenceId: `market_evidence_${canonicalJsonHash({
          candidateId: row.candidate_id,
          symbol: orderSymbol,
          timestamp: evidence.marketTimestamp,
          requestId: row.market_request_id,
          evidence: row.market_evidence
        })}`,
        candidateId: row.candidate_id,
        strategyReviewId: reviewId,
        executionIntentId: intentId
      });
    } catch (error) {
      blockedRows.push({
        row,
        reason: error instanceof Error
          ? error.message.split(":", 1)[0]!
          : "PORTFOLIO_STATE_PACKET_INVALID"
      });
      continue;
    }
    const packetValidation = validatePostgresPortfolioStatePacket({
      packet: portfolioStatePacket,
      now: now.toISOString(),
      expectedAccountId: String(row.broker_account_id),
      expectedCandidateId: row.candidate_id,
      expectedContractIdentifier: row.asset_class === "option"
        ? orderSymbol
        : null,
      expectedStructuralPortfolioFingerprint: row.structural_fingerprint,
      requiredCapital: amount,
      requireMarketOpen: true,
      requireOpra: row.asset_class === "option"
    });
    if (!packetValidation.valid) {
      blockedRows.push({
        row,
        reason: packetValidation.blockers[0] ?? "PORTFOLIO_STATE_PACKET_INVALID"
      });
      continue;
    }
    eligibleRows.push({
      row,
      amount,
      evidence,
      leapsSizing,
      laneDecision,
      canonicalLane,
      clientOrderId,
      reviewId,
      intentId,
      portfolioStatePacket
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
  const sharedContext = portfolioResourceContext(rows);
  const firstRow = eligibleRows[0]!.row;
  const cycleId = process.env.AUTONOMOUS_CYCLE_ID?.trim() ||
    String(firstRow.research_run_id || input.fence.runId);
  const arbitrationId = `portfolio_arbitration_${canonicalJsonHash({
    cycleId,
    accountId: firstRow.account_id,
    accountSnapshotId: firstRow.account_snapshot_id,
    contextVersion: sharedContext.contextVersion
  })}`;
  const proposals: PortfolioArbitrationProposal[] = eligibleRows.map(
    ({ row, amount, evidence, leapsSizing, canonicalLane }) => {
      const option = row.asset_class === "option";
      const shortEquity = !option && row.direction === "short";
      const unitResource = option
        ? evidence.price * (
            finite(row.contract_multiplier) ?? Number.NaN
          )
        : shortEquity
          ? evidence.price
          : 0.01;
      const requestedQuantity = option
        ? leapsSizing?.quantity ?? Math.floor(amount / unitResource)
        : shortEquity
          ? Math.floor(amount / unitResource)
          : null;
      const resourceRequirement = option || shortEquity
        ? unitResource * (requestedQuantity ?? 0)
        : amount;
      const lane = arbitrationLane(row, canonicalLane);
      return {
        proposalId: row.candidate_id,
        cycleId,
        lane,
        strategyPriority: arbitrationPriority(lane),
        score: finite(row.candidate_score),
        confidence: finite(row.confidence),
        symbol: String(row.option_symbol ?? row.symbol).toUpperCase(),
        underlyingSymbol: String(row.symbol).toUpperCase(),
        contractId: option
          ? String(row.contract_id ?? row.option_symbol ?? "")
          : null,
        direction: row.direction,
        assetClass: row.asset_class,
        requestedQuantity,
        requestedNotional: resourceRequirement,
        resourceRequirement,
        unitResource,
        resizeMode: option
          ? "whole_contracts"
          : shortEquity
            ? "whole_shares"
            : "notional"
      };
    }
  );
  const arbitration = arbitratePortfolioResources({
    arbitrationId,
    cycleId,
    proposals,
    context: sharedContext
  });
  await persistPortfolioArbitrationDecisions({
    query: input.query,
    fence: input.fence,
    accountId: firstRow.account_id,
    accountSnapshotId: firstRow.account_snapshot_id,
    contextId: sharedContext.contextId,
    decisions: arbitration.decisions,
    createdAt: now.toISOString()
  });
  const decisionsByProposal = new Map(
    arbitration.decisions.map((decision) => [decision.proposalId, decision])
  );
  const downstreamRows: Array<{
    row: ReviewSourceRow;
    amount: number;
    evidence: ReturnType<typeof validateEntryReviewEvidence>;
    leapsSizing: LeapsEntrySizingResult | null;
    laneDecision: OptionLaneDecision | null;
    canonicalLane: CanonicalOptionLane | null;
    clientOrderId: string;
    reviewId: string;
    intentId: string;
    portfolioStatePacket: PortfolioStatePacket;
    arbitrationDecision: (typeof arbitration.decisions)[number];
  }> = [];
  for (const eligible of eligibleRows) {
    const decision = decisionsByProposal.get(eligible.row.candidate_id);
    if (!decision) {
      throw new Error("POSTGRES_PORTFOLIO_ARBITRATION_DECISION_MISSING");
    }
    if (decision.action === "skip") {
      skipped += 1;
      await persistCandidateStage({
        query: input.query,
        fence: input.fence,
        candidateId: eligible.row.candidate_id,
        status: "skipped",
        reason: decision.reasonCodes[0] ??
          "ARBITRATION_SKIPPED_NO_VALID_RESIZE",
        now: now.toISOString()
      });
      continue;
    }
    const approvedAmount = decision.approvedResourceRequirement;
    if (approvedAmount === null || approvedAmount <= 0) {
      throw new Error("POSTGRES_PORTFOLIO_ARBITRATION_APPROVED_SIZE_MISSING");
    }
    const resizedLeaps = eligible.leapsSizing
      ? {
          ...eligible.leapsSizing,
          quantity: decision.approvedQuantity ??
            eligible.leapsSizing.quantity,
          positionCostUsd: approvedAmount
        }
      : null;
    downstreamRows.push({
      ...eligible,
      amount: approvedAmount,
      leapsSizing: resizedLeaps,
      arbitrationDecision: decision
    });
  }
  const arbitrationApproved = arbitration.decisions.filter(
    ({ action }) => action === "approve"
  ).length;
  const arbitrationResized = arbitration.decisions.filter(
    ({ action }) => action === "resize"
  ).length;
  const arbitrationSkipped = arbitration.decisions.filter(
    ({ action }) => action === "skip"
  ).length;
  if (!downstreamRows.length) {
    return {
      status: "completed" as const,
      command: input.command,
      reviewsCreated: 0,
      pendingIntentsCreated: 0,
      skipped,
      capacityBlocked,
      arbitrationDecisions: arbitration.decisions.length,
      arbitrationApproved,
      arbitrationResized,
      arbitrationSkipped,
      confirmationCreated: false,
      paperOnly: true
    };
  }
  let created = 0;
  for (const {
    row,
    amount,
    evidence,
    leapsSizing,
    laneDecision,
    canonicalLane,
    arbitrationDecision,
    clientOrderId,
    reviewId,
    intentId,
    portfolioStatePacket
  } of downstreamRows) {
    const { marketTimestamp, price, underlyingSip } = evidence;
    const option = row.asset_class === "option";
    const shortEquity = !option && row.direction === "short";
    const operation: TradeOperation = option
      ? "buy_to_open"
      : shortEquity
        ? "sell_to_open"
        : "buy_to_open";
    const optionType = option
      ? String(row.contract_type) as "call" | "put"
      : null;
    const strategyClassification: StrategyClassification = option
      ? canonicalLane === "options_leaps"
        ? optionType === "call"
          ? "leaps_long_call"
          : "leaps_long_put"
        : canonicalLane === "options_0dte"
          ? optionType === "call"
            ? "zero_dte_long_call"
            : "zero_dte_long_put"
          : optionType === "call"
            ? "standard_long_call"
            : "standard_long_put"
      : shortEquity
        ? "equity_short"
        : "equity_long";
    const quantity = option
      ? arbitrationDecision.approvedQuantity ??
        leapsSizing?.quantity ?? Math.floor(
          amount / (
            price * (finite(row.contract_multiplier) ?? Number.NaN)
          )
        )
      : shortEquity
        ? arbitrationDecision.approvedQuantity ?? Math.floor(amount / price)
        : null;
    const optionPositionCost = option
      ? leapsSizing?.positionCostUsd ??
        price *
          (finite(row.contract_multiplier) ?? Number.NaN) *
          (quantity ?? 0)
      : null;
    const effectiveRisk = shortEquity
      ? price * (quantity ?? 0)
      : optionPositionCost ?? amount;
    const orderSymbol = row.option_symbol ?? row.symbol;
    const marketEvidence = [{
      ...(option ? authoritativeOptionEvidence(row) : jsonRecord(row.market_evidence)),
      symbol: orderSymbol,
      underlyingSymbol: row.symbol,
      referencePrice: price,
      timestamp: marketTimestamp,
      requestId: row.market_request_id,
      source: option ? "postgres.option_snapshots" : "postgres.stock_snapshots",
      ...(option ? {
        underlyingPrice: underlyingSip?.referencePrice,
        underlyingSip,
        maximumSpreadPct: exploration.maximumOptionSpreadPct,
        ...(laneDecision ? { optionLaneDecision: laneDecision } : {}),
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
    const portfolioArbitration = {
      arbitrationId: arbitrationDecision.arbitrationId,
      action: arbitrationDecision.action,
      rank: arbitrationDecision.rank,
      reasonCodes: arbitrationDecision.reasonCodes,
      sharedContextVersion: arbitrationDecision.sharedContextVersion
    };
    const payload = {
      candidateId: row.candidate_id, accountSnapshotId: row.account_snapshot_id,
      accountFingerprint: row.structural_fingerprint, orderIntent, marketEvidence,
      portfolioArbitration,
      portfolioStatePacket,
      paperOnly: true
    };
    const payloadFingerprint = canonicalJsonHash(payload);
    const configFingerprint = canonicalJsonHash(configuration);
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
          structuralPortfolioFingerprint: row.structural_fingerprint,
          portfolioArbitration,
          portfolioStatePacket
        }), expiresAt, now.toISOString(), ...fenceValues(input.fence)]
    );
    if (review.rowCount !== 1 && review.rowCount !== 0) throw new Error("POSTGRES_REVIEW_PERSISTENCE_FAILED");
    const intentFingerprint = canonicalJsonHash({
      reviewId,
      orderIntent,
      portfolioStatePacketFingerprint: portfolioStatePacket.packetFingerprint
    });
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
        JSON.stringify({ orderIntent, portfolioStatePacket }), now.toISOString(), operation,
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
    arbitrationDecisions: arbitration.decisions.length,
    arbitrationApproved,
    arbitrationResized,
    arbitrationSkipped,
    confirmationCreated: false,
    paperOnly: true
  };
};
