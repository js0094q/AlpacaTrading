import { canonicalJsonHash } from "../lib/canonicalJson.js";
import { queryAll, queryOne } from "../lib/db.js";
import {
  buildHedgeConfig,
  type HedgeConfig
} from "./hedgeConfigService.js";
import type { HedgeCandidate, HedgeDecision, HedgeRecommendationRecord } from "./hedgeTypes.js";
import {
  classifyMarketRegime,
  type MarketRegimeSnapshot
} from "./marketRegimeService.js";
import { optionDaysToExpiration } from "./optionSymbolService.js";
import {
  scorePortfolioRisk,
  type PortfolioRiskScore
} from "./portfolioRiskScoreService.js";
import {
  buildPortfolioRiskSnapshot,
  type NormalizedRiskPosition,
  type PortfolioRiskSnapshot
} from "./portfolioRiskService.js";
import {
  buildHedgeCapitalEvidence,
  type HedgeCapitalEvidence
} from "./hedgeCapitalEvidenceService.js";
import { listRecentPaperOrders } from "./alpacaClient.js";
import { listPaperExecutionLedgerEntries } from "./paperExecutionLedgerService.js";
import { executionStateProjectionService } from "./executionStateProjectionService.js";

export interface OptionHedgeCandidateEvidence {
  optionSymbol: string;
  underlying: string;
  expirationDate: string;
  daysToExpiration: number;
  strikePrice: number;
  underlyingPrice: number;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  delta: number | null;
  openInterest: number | null;
  volume: number | null;
  theta?: number | null;
  quoteTimestamp?: string | null;
  snapshotTimestamp?: string | null;
  contractDeltaCoveragePct?: number | null;
  marketValueDeltaCoveragePct?: number | null;
  multiplier?: number | null;
}

export interface HedgeRecommendationEvidence {
  optionCandidates: OptionHedgeCandidateEvidence[];
  inversePrices: Record<"SH" | "PSQ", number | null>;
  existingLeapsExitRecommendations: Array<{
    symbol: string;
    recommendation: string;
    reasons: string[];
  }>;
  capitalEvidence: HedgeCapitalEvidence;
}

export type HedgeMarketRecommendationEvidence = Omit<
  HedgeRecommendationEvidence,
  "capitalEvidence"
>;

export interface HedgeSizingSummary {
  targetScenarioDeclinePct: 5 | 8 | 10 | 15;
  targetProtectionPct: number;
  grossModeledLoss: number;
  grossProtectionTarget: number;
  existingMeasuredProtection: number;
  netProtectionTarget: number;
  premiumBudget: number;
  residualUnprotectedLoss: number;
}

export interface LeapsTrimRecommendation {
  symbol: string;
  underlying: string;
  quantityHeld: number;
  quantityToTrim: number;
  deltaAdjustedExposure: number;
  positiveDeltaConcentration: number;
  observedUnrealizedGain: number;
  reasons: string[];
}

export interface HedgeLeapsSummary {
  trimRecommendations: LeapsTrimRecommendation[];
  observedUnrealizedGain: number;
  profitFundedPremiumBudget: number;
  unrealizedGainFundingProxy: true;
  existingExitRecommendations: HedgeRecommendationEvidence["existingLeapsExitRecommendations"];
  warnings: string[];
}

export interface HedgeRecommendation
  extends Omit<
    HedgeRecommendationRecord,
    "risk" | "regime" | "score" | "sizing" | "leaps"
  > {
  risk: PortfolioRiskSnapshot;
  regime: MarketRegimeSnapshot;
  score: PortfolioRiskScore;
  sizing: HedgeSizingSummary;
  leaps: HedgeLeapsSummary;
}

const roundMoney = (value: number) => Math.round(value * 100) / 100;
const unique = (values: string[]) => [...new Set(values)];

const targetScenarioDecline = (
  regime: MarketRegimeSnapshot["regime"]
): 5 | 8 | 10 | 15 => {
  if (regime === "crisis") return 15;
  if (regime === "risk-off") return 10;
  if (regime === "transition") return 5;
  return 8;
};

const protectionPctForScore = (score: PortfolioRiskScore, config: HedgeConfig) =>
  config.targetProtection[score.band];

const leapsAnalysis = (
  risk: PortfolioRiskSnapshot,
  score: PortfolioRiskScore,
  netProtectionTarget: number,
  scenarioDeclinePct: number,
  evidence: HedgeRecommendationEvidence,
  config: HedgeConfig
): HedgeLeapsSummary => {
  const positiveDelta = Math.max(0, risk.options.positiveDeltaExposure ?? 0);
  const candidates = risk.positions.filter(
    (position) =>
      position.assetClass === "option" &&
      position.optionType === "call" &&
      (position.daysToExpiration ?? -1) >= config.leaps.minimumDte &&
      (position.deltaAdjustedExposure ?? 0) > 0
  );
  const trimRecommendations = candidates
    .map((position): LeapsTrimRecommendation | null => {
      const exposure = Math.max(0, position.deltaAdjustedExposure ?? 0);
      const concentration = positiveDelta > 0 ? exposure / positiveDelta : 0;
      if (concentration < config.leaps.concentrationThreshold || score.total < 45) {
        return null;
      }
      const quantityHeld = Math.max(0, Math.floor(Math.abs(position.quantity ?? 0)));
      const protectionPerContract =
        quantityHeld > 0 ? (exposure / quantityHeld) * (scenarioDeclinePct / 100) : 0;
      const quantityToTrim = Math.min(
        quantityHeld,
        Math.max(1, protectionPerContract > 0 ? Math.ceil(netProtectionTarget / protectionPerContract) : 1)
      );
      return {
        symbol: position.symbol,
        underlying: position.underlying,
        quantityHeld,
        quantityToTrim,
        deltaAdjustedExposure: exposure,
        positiveDeltaConcentration: concentration,
        observedUnrealizedGain: Math.max(0, position.unrealizedPl ?? 0),
        reasons: [
          "LEAPS_POSITIVE_DELTA_CONCENTRATION",
          "LEAPS_TRIM_PREFERRED_BEFORE_PAID_PROTECTION"
        ]
      };
    })
    .filter((entry): entry is LeapsTrimRecommendation => entry !== null)
    .sort((left, right) => right.positiveDeltaConcentration - left.positiveDeltaConcentration);
  const observedUnrealizedGain = candidates.reduce(
    (sum, position) => sum + Math.max(0, position.unrealizedPl ?? 0),
    0
  );
  const navCap = Math.max(0, risk.account.equity ?? 0) * config.premiumNavCap;
  const profitFundedPremiumBudget = Math.min(
    observedUnrealizedGain * config.leaps.profitAllocation,
    navCap
  );
  return {
    trimRecommendations,
    observedUnrealizedGain,
    profitFundedPremiumBudget: roundMoney(profitFundedPremiumBudget),
    unrealizedGainFundingProxy: true,
    existingExitRecommendations: evidence.existingLeapsExitRecommendations,
    warnings: observedUnrealizedGain > 0
      ? ["LEAPS_PROFIT_FUNDING_IS_UNREALIZED_GAIN_PROXY"]
      : []
  };
};

const protectivePutCandidate = (
  option: OptionHedgeCandidateEvidence,
  netProtectionTarget: number,
  premiumBudget: number,
  scenarioDeclinePct: number,
  config: HedgeConfig
): HedgeCandidate => {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const spreadPct =
    option.bid !== null &&
    option.ask !== null &&
    option.midpoint !== null &&
    option.midpoint > 0 &&
    option.ask >= option.bid
      ? (option.ask - option.bid) / option.midpoint
      : null;
  if (option.midpoint === null || option.midpoint <= 0) {
    blockers.push("HEDGE_OPTION_PRICE_UNAVAILABLE");
  }
  if (spreadPct === null) {
    blockers.push("HEDGE_OPTION_SPREAD_UNAVAILABLE");
  } else if (spreadPct > config.executionPolicy.maxBidAskSpreadPct) {
    blockers.push("HEDGE_OPTION_SPREAD_TOO_WIDE");
  }
  if (option.delta === null) {
    blockers.push("HEDGE_OPTION_DELTA_UNAVAILABLE");
  } else if (
    Math.abs(option.delta) < config.executionPolicy.targetAbsDeltaMin ||
    Math.abs(option.delta) > config.executionPolicy.targetAbsDeltaMax
  ) {
    blockers.push("HEDGE_DELTA_OUT_OF_RANGE");
  }
  const terminalUnderlying = option.underlyingPrice * (1 - scenarioDeclinePct / 100);
  const premiumPerContract = option.midpoint === null ? null : option.midpoint * 100;
  const terminalPayoffPerContract = Math.max(0, option.strikePrice - terminalUnderlying) * 100;
  const protectionPerContract =
    premiumPerContract === null
      ? null
      : Math.max(0, terminalPayoffPerContract - premiumPerContract);
  if (protectionPerContract === null || protectionPerContract <= 0) {
    blockers.push("HEDGE_MODELED_PAYOFF_INSUFFICIENT");
  }
  const desiredUnits =
    protectionPerContract !== null && protectionPerContract > 0
      ? Math.ceil(netProtectionTarget / protectionPerContract)
      : null;
  const budgetUnits =
    premiumPerContract !== null && premiumPerContract > 0
      ? Math.floor(premiumBudget / premiumPerContract)
      : 0;
  const units = desiredUnits === null
    ? null
    : Math.max(
        0,
        Math.min(
          desiredUnits,
          budgetUnits,
          config.executionPolicy.maxNewContractsPerRun
        )
      );
  if (units === 0) blockers.push("HEDGE_PREMIUM_BUDGET_INSUFFICIENT");
  const estimatedCost =
    premiumPerContract === null || units === null
      ? null
      : roundMoney(premiumPerContract * units);
  if (estimatedCost !== null && estimatedCost < config.executionPolicy.minOrderNotionalDollars) {
    blockers.push("HEDGE_MIN_ORDER_NOTIONAL_NOT_MET");
  }
  const finalBlockers = unique(blockers);
  return {
    candidateId: `hedge_put_${canonicalJsonHash({ option: option.optionSymbol, scenarioDeclinePct }).slice(0, 20)}`,
    rank: 0,
    instrumentType: "protective_put",
    symbol: option.optionSymbol,
    underlying: option.underlying,
    executable: finalBlockers.length === 0 && units !== null && units > 0,
    expectedProtection:
      protectionPerContract === null || units === null
        ? null
        : roundMoney(protectionPerContract * units),
    estimatedCost,
    units,
    rationale: [
      `Modeled at a ${scenarioDeclinePct}% ${option.underlying} decline.`,
      "Sized against modeled portfolio loss protection, not NAV allocation."
    ],
    warnings,
    blockers: finalBlockers,
    details: {
      expirationDate: option.expirationDate,
      daysToExpiration: option.daysToExpiration,
      strikePrice: option.strikePrice,
      underlyingPrice: option.underlyingPrice,
      midpoint: option.midpoint,
      bid: option.bid,
      ask: option.ask,
      spreadPct,
      delta: option.delta,
      theta: option.theta ?? null,
      quoteTimestamp: option.quoteTimestamp ?? null,
      snapshotTimestamp: option.snapshotTimestamp ?? null,
      multiplier: option.multiplier ?? 100,
      contractDeltaCoveragePct: option.contractDeltaCoveragePct ?? null,
      marketValueDeltaCoveragePct: option.marketValueDeltaCoveragePct ?? null,
      premiumPerContract,
      terminalPayoffPerContract,
      protectionPerContract,
      desiredUnits,
      budgetUnits
    }
  };
};

const putSpreadCandidates = (
  options: OptionHedgeCandidateEvidence[],
  netProtectionTarget: number,
  premiumBudget: number,
  scenarioDeclinePct: number,
  config: HedgeConfig
): HedgeCandidate[] => {
  const grouped = new Map<string, OptionHedgeCandidateEvidence[]>();
  for (const option of options) {
    const key = `${option.underlying}:${option.expirationDate}`;
    grouped.set(key, [...(grouped.get(key) ?? []), option]);
  }
  const results: HedgeCandidate[] = [];
  for (const entries of grouped.values()) {
    const ordered = [...entries].sort((left, right) => right.strikePrice - left.strikePrice);
    if (ordered.length < 2) continue;
    const longPut = ordered[0]!;
    const shortPut = ordered.at(-1)!;
    if (longPut.midpoint === null || shortPut.midpoint === null) continue;
    const debitPerSpread = Math.max(0, longPut.midpoint - shortPut.midpoint) * 100;
    const terminalUnderlying = longPut.underlyingPrice * (1 - scenarioDeclinePct / 100);
    const longPayoff = Math.max(0, longPut.strikePrice - terminalUnderlying) * 100;
    const shortPayoff = Math.max(0, shortPut.strikePrice - terminalUnderlying) * 100;
    const protectionPerSpread = Math.max(0, longPayoff - shortPayoff - debitPerSpread);
    const desiredUnits = protectionPerSpread > 0
      ? Math.ceil(netProtectionTarget / protectionPerSpread)
      : 0;
    const budgetUnits = debitPerSpread > 0 ? Math.floor(premiumBudget / debitPerSpread) : 0;
    const units = Math.max(
      0,
      Math.min(desiredUnits, budgetUnits, config.optionHedge.maximumContracts)
    );
    results.push({
      candidateId: `hedge_spread_${canonicalJsonHash({ long: longPut.optionSymbol, short: shortPut.optionSymbol }).slice(0, 20)}`,
      rank: 0,
      instrumentType: "put_spread",
      symbol: `${longPut.optionSymbol}/${shortPut.optionSymbol}`,
      underlying: longPut.underlying,
      executable: false,
      expectedProtection: roundMoney(protectionPerSpread * units),
      estimatedCost: roundMoney(debitPerSpread * units),
      units,
      rationale: ["Defined-risk debit spread analyzed as a cost-bounded alternative."],
      warnings: [],
      blockers: ["MULTI_LEG_EXECUTION_UNSUPPORTED"],
      details: {
        longOptionSymbol: longPut.optionSymbol,
        shortOptionSymbol: shortPut.optionSymbol,
        expirationDate: longPut.expirationDate,
        debitPerSpread,
        protectionPerSpread
      }
    });
  }
  return results;
};

const inverseCandidates = (
  evidence: HedgeRecommendationEvidence,
  netProtectionTarget: number,
  scenarioDeclinePct: number
): HedgeCandidate[] =>
  (["SH", "PSQ"] as const).flatMap((symbol) => {
    const price = evidence.inversePrices[symbol];
    if (price === null || !(price > 0)) return [];
    const protectionPerShare = price * (scenarioDeclinePct / 100);
    const units = protectionPerShare > 0
      ? Math.ceil(netProtectionTarget / protectionPerShare)
      : null;
    return [{
      candidateId: `hedge_inverse_${symbol.toLowerCase()}`,
      rank: 0,
      instrumentType: "inverse_etf" as const,
      symbol,
      underlying: symbol === "SH" ? "SPY" : "QQQ",
      executable: false as const,
      expectedProtection:
        units === null ? null : roundMoney(protectionPerShare * units),
      estimatedCost: units === null ? null : roundMoney(price * units),
      units,
      rationale: ["Secondary tactical alternative to option premium."],
      warnings: [
        "INVERSE_ETF_DAILY_RESET_TRACKING_RISK",
        "INVERSE_ETF_SCENARIO_RELATIONSHIP_ASSUMPTION"
      ],
      blockers: [],
      details: { observedPrice: price, protectionPerShare, scenarioDeclinePct }
    }];
  });

const emptySizing = (scenario: 5 | 8 | 10 | 15): HedgeSizingSummary => ({
  targetScenarioDeclinePct: scenario,
  targetProtectionPct: 0,
  grossModeledLoss: 0,
  grossProtectionTarget: 0,
  existingMeasuredProtection: 0,
  netProtectionTarget: 0,
  premiumBudget: 0,
  residualUnprotectedLoss: 0
});

export interface HedgeCandidateRankingInput {
  options: OptionHedgeCandidateEvidence[];
  netProtectionTarget: number;
  premiumBudget: number;
  accountEquity: number;
  scenarioDeclinePct: number;
  config: HedgeConfig;
  asOf?: string;
}

const candidateRankingScore = (candidate: HedgeCandidate, config: HedgeConfig) => {
  const details = candidate.details ?? {};
  const protectionPerDollar =
    (candidate.expectedProtection ?? 0) / Math.max(1, candidate.estimatedCost ?? 0);
  const spreadPct = Number(details.spreadPct);
  const spreadQuality = Number.isFinite(spreadPct)
    ? Math.max(0, 1 - spreadPct / Math.max(0.01, config.executionPolicy.maxBidAskSpreadPct))
    : 0;
  const dte = Number(details.daysToExpiration);
  const dteQuality = Number.isFinite(dte)
    ? Math.max(
        0,
        1 - Math.abs(dte - config.executionPolicy.targetDte) /
          Math.max(1, config.executionPolicy.maxDte - config.executionPolicy.minDte)
      )
    : 0;
  const delta = Math.abs(Number(details.delta));
  const targetDelta =
    (config.executionPolicy.targetAbsDeltaMin + config.executionPolicy.targetAbsDeltaMax) / 2;
  const deltaQuality = Number.isFinite(delta)
    ? Math.max(0, 1 - Math.abs(delta - targetDelta) / Math.max(0.01, targetDelta))
    : 0;
  const thetaBurden = Math.abs(Number(details.theta) || 0);
  return protectionPerDollar * 0.55 + spreadQuality * 0.2 + dteQuality * 0.15 +
    deltaQuality * 0.08 - Math.min(1, thetaBurden) * 0.02;
};

export const rankHedgeCandidates = (
  input: HedgeCandidateRankingInput
): HedgeCandidate[] => {
  const asOf = input.asOf ?? new Date().toISOString();
  const eligibleOptions = input.options.filter((option) =>
    input.config.executionPolicy.allowedUnderlyings.includes(option.underlying.toUpperCase()) &&
    option.daysToExpiration >= input.config.executionPolicy.minDte &&
    option.daysToExpiration <= input.config.executionPolicy.maxDte
  );
  const puts = eligibleOptions.map((option) => {
    const candidate = protectivePutCandidate(
      option,
      input.netProtectionTarget,
      Math.min(
        input.premiumBudget,
        Math.max(0, input.accountEquity * input.config.executionPolicy.maxNewHedgePremiumPctEquity)
      ),
      input.scenarioDeclinePct,
      input.config
    );
    const timestamp = option.quoteTimestamp ?? option.snapshotTimestamp;
    if (timestamp) {
      const ageSeconds = (Date.parse(asOf) - Date.parse(timestamp)) / 1000;
      if (!Number.isFinite(ageSeconds) || ageSeconds < 0 || ageSeconds > input.config.executionPolicy.limitPriceMaxAgeSeconds) {
        return {
          ...candidate,
          executable: false,
          blockers: unique([...candidate.blockers, "HEDGE_QUOTE_STALE"])
        };
      }
    }
    return candidate;
  });
  return puts
    .sort((left, right) => candidateRankingScore(right, input.config) - candidateRankingScore(left, input.config))
    .slice(0, input.config.executionPolicy.maxOrdersPerRun)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
};

export const recommendHedgeFromEvidence = (
  risk: PortfolioRiskSnapshot,
  regime: MarketRegimeSnapshot,
  score: PortfolioRiskScore,
  evidence: HedgeRecommendationEvidence,
  config: HedgeConfig,
  metadata: {
    generatedAt?: string;
    requestId?: string;
    correlationId?: string | null;
  } = {}
): HedgeRecommendation => {
  const generatedAt = metadata.generatedAt ?? new Date().toISOString();
  const scenarioDeclinePct = targetScenarioDecline(regime.regime);
  const base = {
    recordType: "hedge_recommendation" as const,
    generatedAt,
    expiresAt: new Date(
      Date.parse(generatedAt) + config.recommendationTtlMinutes * 60_000
    ).toISOString(),
    environment: "paper" as const,
    sourceSnapshotId: risk.snapshotId,
    riskModelVersion: risk.riskModelVersion,
    regimeModelVersion: regime.modelVersion,
    configurationFingerprint: risk.configurationFingerprint,
    dataQualityStatus: risk.dataQualityStatus,
    reviewedPayloadHash: null,
    benchmark: config.beta.benchmark,
    risk,
    regime,
    score,
    capitalEvidence: evidence.capitalEvidence,
    requestId: metadata.requestId ?? `hedge_req_${canonicalJsonHash({ generatedAt, snapshot: risk.snapshotId }).slice(0, 20)}`,
    correlationId: metadata.correlationId ?? null
  };
  const recommendationId = `hedge_rec_${canonicalJsonHash({
    snapshotId: risk.snapshotId,
    regime: regime.regime,
    score: score.total,
    configurationFingerprint: risk.configurationFingerprint
  }).slice(0, 24)}`;
  if (risk.dataQualityStatus === "blocked" || risk.blockers.length) {
    return {
      ...base,
      recommendationId,
      recommendationStatus: "blocked",
      decision: "blocked",
      sizing: emptySizing(scenarioDeclinePct),
      leaps: {
        trimRecommendations: [],
        observedUnrealizedGain: 0,
        profitFundedPremiumBudget: 0,
        unrealizedGainFundingProxy: true,
        existingExitRecommendations: evidence.existingLeapsExitRecommendations,
        warnings: []
      },
      candidates: [],
      warnings: unique([...risk.warnings, ...regime.warnings]),
      blockers: unique([...risk.blockers, ...regime.blockers])
    };
  }
  const materialOptionCoverageMissing =
    risk.optionDataCoverage.materialCoverageMissing ||
    score.measurementStatus === "indeterminate";
  if (!evidence.capitalEvidence.complete) {
    return {
      ...base,
      recommendationId,
      recommendationStatus: "monitoring",
      decision: "monitor",
      sizing: emptySizing(scenarioDeclinePct),
      leaps: {
        trimRecommendations: [],
        observedUnrealizedGain: 0,
        profitFundedPremiumBudget: 0,
        unrealizedGainFundingProxy: true,
        existingExitRecommendations: evidence.existingLeapsExitRecommendations,
        warnings: []
      },
      candidates: [],
      warnings: unique([
        ...risk.warnings,
        ...regime.warnings,
        ...evidence.capitalEvidence.blockers,
        "HEDGE_CAPITAL_EVIDENCE_INCOMPLETE"
      ]),
      blockers: unique([
        ...risk.blockers,
        ...regime.blockers,
        ...evidence.capitalEvidence.blockers
      ])
    };
  }
  const scenario = risk.scenarios.find(
    (entry) => entry.benchmarkDeclinePct === scenarioDeclinePct
  );
  if (
    materialOptionCoverageMissing ||
    risk.dataQualityStatus === "monitoring" ||
    !scenario ||
    scenario.netModeledLoss === null
  ) {
    return {
      ...base,
      recommendationId,
      recommendationStatus: "monitoring",
      decision: "monitor",
      sizing: emptySizing(scenarioDeclinePct),
      leaps: {
        trimRecommendations: [],
        observedUnrealizedGain: 0,
        profitFundedPremiumBudget: 0,
        unrealizedGainFundingProxy: true,
        existingExitRecommendations: evidence.existingLeapsExitRecommendations,
        warnings: []
      },
      candidates: [],
      warnings: unique([
        ...risk.warnings,
        ...regime.warnings,
        ...(materialOptionCoverageMissing
          ? ["MATERIAL_OPTION_GREEKS_COVERAGE_INSUFFICIENT"]
          : []),
        "HEDGE_SIZING_EVIDENCE_INSUFFICIENT"
      ]),
      blockers: unique([...risk.blockers, ...regime.blockers])
    };
  }

  const targetProtectionPct = protectionPctForScore(score, config);
  const grossProtectionTarget = roundMoney(
    scenario.grossModeledLoss * targetProtectionPct
  );
  const netProtectionTarget = roundMoney(
    Math.max(0, grossProtectionTarget - scenario.existingProtection)
  );
  const leaps = leapsAnalysis(
    risk,
    score,
    netProtectionTarget,
    scenarioDeclinePct,
    evidence,
    config
  );
  const navBudget = Math.max(0, risk.account.equity ?? 0) * config.premiumNavCap;
  const configuredPremiumBudget = roundMoney(
    leaps.profitFundedPremiumBudget > 0
      ? Math.min(leaps.profitFundedPremiumBudget, navBudget)
      : navBudget
  );
  const equity = Math.max(0, risk.account.equity ?? 0);
  const premiumBudget = roundMoney(
    Math.min(
      configuredPremiumBudget,
      equity * config.executionPolicy.maxNewHedgePremiumPctEquity,
      Math.max(
        0,
        equity * config.executionPolicy.maxTotalHedgePremiumPctEquity -
          Math.max(0, evidence.capitalEvidence.existingHedgePremium ?? 0) -
          Math.max(0, evidence.capitalEvidence.reservedHedgePremium ?? 0)
      ),
      Math.max(
        0,
        equity * config.executionPolicy.maxDailyHedgePremiumPctEquity -
          Math.max(0, evidence.capitalEvidence.dailyHedgePremiumUsed ?? 0)
      )
    )
  );
  let candidates: HedgeCandidate[] = [];
  const hedgeOrderCapacityAvailable =
    (evidence.capitalEvidence.openHedgeOrderCount ?? 0) <
      config.executionPolicy.maxOrdersPerRun;
  if (netProtectionTarget > 0 && score.total >= 45 && hedgeOrderCapacityAvailable) {
    const puts = rankHedgeCandidates({
      options: evidence.optionCandidates,
      netProtectionTarget,
      premiumBudget,
      accountEquity: equity,
      scenarioDeclinePct,
      config,
      asOf: generatedAt
    });
    candidates = [
      ...puts,
      ...putSpreadCandidates(
        evidence.optionCandidates,
        netProtectionTarget,
        premiumBudget,
        scenarioDeclinePct,
        config
      ),
      ...inverseCandidates(evidence, netProtectionTarget, scenarioDeclinePct)
    ].map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  }

  const expectedProtection = candidates
    .filter((candidate) => candidate.instrumentType === "protective_put")
    .reduce((maximum, candidate) => Math.max(maximum, candidate.expectedProtection ?? 0), 0);
  let decision: HedgeDecision = "monitor";
  if (netProtectionTarget === 0 && targetProtectionPct > 0) {
    decision = "existing_protection_sufficient";
  } else if (leaps.trimRecommendations.length && netProtectionTarget > 0) {
    decision = "trim_leaps_then_protect";
  } else if (leaps.trimRecommendations.length) {
    decision = "trim_leaps";
  } else if (candidates.length) {
    decision = "buy_protection";
  }
  const recommendationStatus =
    decision === "monitor" ? "monitoring" as const : "current" as const;
  return {
    ...base,
    recommendationId,
    recommendationStatus,
    decision,
    sizing: {
      targetScenarioDeclinePct: scenarioDeclinePct,
      targetProtectionPct,
      grossModeledLoss: scenario.grossModeledLoss,
      grossProtectionTarget,
      existingMeasuredProtection: scenario.existingProtection,
      netProtectionTarget,
      premiumBudget,
      residualUnprotectedLoss: roundMoney(
        Math.max(0, netProtectionTarget - expectedProtection)
      )
    },
    leaps,
    candidates,
    warnings: unique([
      ...risk.warnings,
      ...regime.warnings,
      ...leaps.warnings,
      ...(decision === "monitor" && netProtectionTarget > 0
        ? ["NO_SUPPORTED_HEDGE_CANDIDATE"]
        : []),
      ...(!hedgeOrderCapacityAvailable ? ["HEDGE_OPEN_ORDER_CAP_REACHED"] : [])
    ]),
    blockers: unique([...risk.blockers, ...regime.blockers])
  };
};

interface CandidateRow {
  option_symbol: string;
  underlying_symbol: string;
  expiration_date: string;
  strike: number;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  delta: number | null;
  open_interest: number | null;
  volume: number | null;
  theta: number | null;
  quote_timestamp: string | null;
  snapshot_timestamp: string | null;
  multiplier: number | null;
}

const latestPrice = (symbol: string) =>
  queryOne<{ close: number }>(
    `SELECT close FROM market_bars
     WHERE symbol = ? AND timeframe = '1Day'
     ORDER BY timestamp DESC LIMIT 1`,
    [symbol]
  )?.close ?? null;

export const discoverHedgeRecommendationEvidence = (
  config: HedgeConfig,
  asOf = new Date().toISOString()
): HedgeMarketRecommendationEvidence => {
  const rows = queryAll<CandidateRow>(
    `
    SELECT c.option_symbol, c.underlying_symbol, c.expiration_date, c.strike,
           s.bid, s.ask, s.midpoint, s.delta, s.open_interest, s.volume,
           s.theta, s.quote_timestamp, s.snapshot_timestamp, c.multiplier
    FROM option_contracts c
    LEFT JOIN option_snapshots s
      ON s.option_symbol = c.option_symbol
     AND s.timestamp = (
       SELECT MAX(latest.timestamp)
       FROM option_snapshots latest
       WHERE latest.option_symbol = c.option_symbol
     )
    WHERE c.type = 'put'
      AND c.underlying_symbol IN ('SPY', 'QQQ')
      AND c.tradable = 1
    ORDER BY c.expiration_date ASC, c.strike DESC
    LIMIT 200
    `
  );
  const optionCandidates = rows.flatMap((row) => {
    const dte = optionDaysToExpiration(row.expiration_date, asOf);
    const underlyingPrice = latestPrice(row.underlying_symbol);
    if (dte === null || underlyingPrice === null) return [];
    return [{
      optionSymbol: row.option_symbol,
      underlying: row.underlying_symbol,
      expirationDate: row.expiration_date,
      daysToExpiration: dte,
      strikePrice: row.strike,
      underlyingPrice,
      bid: row.bid,
      ask: row.ask,
      midpoint: row.midpoint,
      delta: row.delta,
      openInterest: row.open_interest,
      volume: row.volume,
      theta: row.theta,
      quoteTimestamp: row.quote_timestamp,
      snapshotTimestamp: row.snapshot_timestamp,
      multiplier: row.multiplier
    }];
  });
  return {
    optionCandidates,
    inversePrices: {
      SH: latestPrice("SH"),
      PSQ: latestPrice("PSQ")
    },
    existingLeapsExitRecommendations: []
  };
};

export interface HedgeRecommendationDeps {
  buildRisk?: typeof buildPortfolioRiskSnapshot;
  classifyRegime?: typeof classifyMarketRegime;
  discoverEvidence?: typeof discoverHedgeRecommendationEvidence;
  buildCapitalEvidence?: (
    risk: PortfolioRiskSnapshot,
    config: HedgeConfig,
    asOf: string
  ) => Promise<HedgeCapitalEvidence> | HedgeCapitalEvidence;
}

const buildRecommendationCapitalEvidence = async (
  risk: PortfolioRiskSnapshot,
  config: HedgeConfig,
  asOf: string
) => {
  try {
    const orders = await listRecentPaperOrders({ limit: 500 });
    return buildHedgeCapitalEvidence({
      asOf,
      allowedUnderlyings: config.executionPolicy.allowedUnderlyings,
      positions: risk.positions,
      orders: Array.isArray(orders.data) ? orders.data : [],
      ledger: (executionStateProjectionService.isAuthorityActive()
        ? []
        : listPaperExecutionLedgerEntries(500)).map((entry) => ({
        ledgerId: entry.id,
        mode: entry.mode,
        strategy: entry.strategy,
        symbol: entry.symbol,
        side: entry.side,
        status: entry.status,
        quantity: entry.qty,
        limitPrice: entry.limitPrice,
        estimatedPremium: entry.estimatedPremium,
        clientOrderId: entry.clientOrderId,
        brokerOrderId: entry.alpacaOrderId,
        createdAt: entry.createdAt,
        rawResponseJson: entry.rawResponseJson
      }))
    });
  } catch {
    return buildHedgeCapitalEvidence({
      asOf,
      allowedUnderlyings: config.executionPolicy.allowedUnderlyings,
      positions: [],
      orders: [],
      ledger: [],
      sourcesAvailable: false
    });
  }
};

export const buildHedgeRecommendation = async (
  input: {
    config?: HedgeConfig;
    asOf?: string;
    requestId?: string;
    correlationId?: string | null;
  } = {},
  deps: HedgeRecommendationDeps = {}
) => {
  const config = input.config ?? buildHedgeConfig();
  const generatedAt = input.asOf ?? new Date().toISOString();
  const risk = await (deps.buildRisk ?? buildPortfolioRiskSnapshot)(
    { config, asOf: generatedAt }
  );
  const regime = (deps.classifyRegime ?? classifyMarketRegime)({
    config,
    asOf: generatedAt
  });
  const score = scorePortfolioRisk(risk, regime);
  const marketEvidence = (deps.discoverEvidence ?? discoverHedgeRecommendationEvidence)(
    config,
    generatedAt
  );
  const capitalEvidence = await (
    deps.buildCapitalEvidence ?? buildRecommendationCapitalEvidence
  )(risk, config, generatedAt);
  const evidence: HedgeRecommendationEvidence = {
    ...marketEvidence,
    capitalEvidence
  };
  return recommendHedgeFromEvidence(risk, regime, score, evidence, config, {
    generatedAt,
    requestId: input.requestId,
    correlationId: input.correlationId
  });
};
