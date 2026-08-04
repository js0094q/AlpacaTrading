import type { WorkstreamLane } from "./canonicalWorkstreamResult.js";
import { isActiveBrokerOrderStatus } from "./brokerOrderStatusService.js";

export type PortfolioArbitrationLane = WorkstreamLane | "options_standard";
export type PortfolioArbitrationAction = "approve" | "resize" | "skip";
export type PortfolioArbitrationResizeMode =
  | "notional"
  | "whole_shares"
  | "whole_contracts";
export type PortfolioExposureDirection = "long" | "short";

export interface PortfolioArbitrationProposal {
  readonly proposalId: string;
  readonly cycleId: string;
  readonly lane: PortfolioArbitrationLane;
  /**
   * Lower values have higher priority. The caller must derive this from an
   * existing configured or explicit lane order.
   */
  readonly strategyPriority: number;
  readonly score: number | null;
  readonly confidence: number | null;
  readonly symbol: string;
  readonly underlyingSymbol: string;
  readonly contractId: string | null;
  readonly direction: PortfolioExposureDirection;
  readonly assetClass: "equity" | "option";
  readonly requestedQuantity: number | null;
  readonly requestedNotional: number | null;
  /**
   * Existing, independently validated capital requirement. Arbitration does
   * not estimate margin or re-price a proposal.
   */
  readonly resourceRequirement: number | null;
  /**
   * Smallest valid capital increment under the existing sizing rule.
   * Options use premium * contract multiplier; short equities use share price.
   */
  readonly unitResource: number | null;
  readonly resizeMode: PortfolioArbitrationResizeMode;
}

export interface PortfolioPositionExposure {
  readonly id: string;
  readonly symbol: string;
  readonly underlyingSymbol: string;
  readonly direction: PortfolioExposureDirection;
  readonly resourceExposure: number | null;
}

export interface PortfolioOrderExposure extends PortfolioPositionExposure {
  readonly status: string;
}

export interface PortfolioPendingCommitment
  extends PortfolioPositionExposure {}

export interface PortfolioResourceContext {
  readonly contextId: string;
  readonly contextVersion: string;
  readonly buyingPowerAvailable: number | null;
  readonly optionsBuyingPowerAvailable: number | null;
  readonly cashAvailable: number | null;
  readonly portfolioCapacityAvailable: number | null;
  readonly maxUnderlyingExposure: number | null;
  readonly existingPositions: readonly PortfolioPositionExposure[];
  readonly openOrders: readonly PortfolioOrderExposure[];
  readonly pendingCommitments: readonly PortfolioPendingCommitment[];
  readonly laneCapacityAvailable: Readonly<
    Partial<Record<PortfolioArbitrationLane, number | null>>
  >;
  readonly accountSnapshotAsOf: string | null;
  readonly positionSnapshotAsOf: string | null;
  readonly openOrderSnapshotAsOf: string | null;
}

export interface PortfolioArbitrationDecision {
  readonly arbitrationId: string;
  readonly cycleId: string;
  readonly proposalId: string;
  readonly lane: PortfolioArbitrationLane;
  readonly rank: number;
  readonly action: PortfolioArbitrationAction;
  readonly originalQuantity: number | null;
  readonly approvedQuantity: number | null;
  readonly originalNotional: number | null;
  readonly approvedNotional: number | null;
  readonly originalResourceRequirement: number | null;
  readonly approvedResourceRequirement: number | null;
  readonly score: number | null;
  readonly confidence: number | null;
  readonly strategyPriority: number;
  readonly deterministicTiebreak: string;
  readonly conflictTypes: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly relatedProposalIds: readonly string[];
  readonly relatedPositionIds: readonly string[];
  readonly relatedOpenOrderIds: readonly string[];
  readonly sharedContextVersion: string;
  readonly accountSnapshotAsOf: string | null;
  readonly positionSnapshotAsOf: string | null;
  readonly openOrderSnapshotAsOf: string | null;
}

export interface PortfolioArbitrationResult {
  readonly arbitrationId: string;
  readonly cycleId: string;
  readonly contextId: string;
  readonly contextVersion: string;
  readonly decisions: readonly PortfolioArbitrationDecision[];
  readonly approvedResourceTotal: number;
}

const normalized = (value: string) => value.trim().toUpperCase();
const finiteNonnegative = (value: number | null) =>
  value !== null && Number.isFinite(value) && value >= 0 ? value : null;
const finitePositive = (value: number | null) =>
  value !== null && Number.isFinite(value) && value > 0 ? value : null;
const normalizedScore = (value: number | null) =>
  value !== null && Number.isFinite(value)
    ? value
    : Number.NEGATIVE_INFINITY;
const exposureKey = (
  value: Pick<PortfolioArbitrationProposal, "symbol">
) => normalized(value.symbol);
const contextExposureKey = (
  value: Pick<PortfolioPositionExposure, "symbol">
) => normalized(value.symbol);
const activeOrder = (order: PortfolioOrderExposure) =>
  isActiveBrokerOrderStatus(order.status);
const money = (value: number) => Math.floor((value + Number.EPSILON) * 100) / 100;
const resourcePrecision = (value: number) =>
  Math.round((value + Number.EPSILON) * 100_000_000) / 100_000_000;
const stableNumber = (value: number | null) =>
  value === null || !Number.isFinite(value) ? "" : String(value);
const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;
const tiebreak = (proposal: PortfolioArbitrationProposal) => [
  String(proposal.strategyPriority),
  stableNumber(proposal.score),
  stableNumber(proposal.confidence),
  normalized(proposal.symbol),
  normalized(proposal.contractId ?? ""),
  proposal.proposalId
].join("|");

const ranked = (
  proposals: readonly PortfolioArbitrationProposal[]
): PortfolioArbitrationProposal[] => [...proposals].sort((left, right) =>
  left.strategyPriority - right.strategyPriority ||
  normalizedScore(right.score) - normalizedScore(left.score) ||
  normalizedScore(right.confidence) - normalizedScore(left.confidence) ||
  compareText(normalized(left.symbol), normalized(right.symbol)) ||
  compareText(
    normalized(left.contractId ?? ""),
    normalized(right.contractId ?? "")
  ) ||
  compareText(left.proposalId, right.proposalId)
);

const decisionBase = (
  input: {
    arbitrationId: string;
    cycleId: string;
    context: PortfolioResourceContext;
  },
  proposal: PortfolioArbitrationProposal,
  rank: number
) => ({
  arbitrationId: input.arbitrationId,
  cycleId: input.cycleId,
  proposalId: proposal.proposalId,
  lane: proposal.lane,
  rank,
  originalQuantity: proposal.requestedQuantity,
  originalNotional: proposal.requestedNotional,
  originalResourceRequirement: proposal.resourceRequirement,
  score: proposal.score,
  confidence: proposal.confidence,
  strategyPriority: proposal.strategyPriority,
  deterministicTiebreak: tiebreak(proposal),
  sharedContextVersion: input.context.contextVersion,
  accountSnapshotAsOf: input.context.accountSnapshotAsOf,
  positionSnapshotAsOf: input.context.positionSnapshotAsOf,
  openOrderSnapshotAsOf: input.context.openOrderSnapshotAsOf
});

const skippedDecision = (
  input: {
    arbitrationId: string;
    cycleId: string;
    context: PortfolioResourceContext;
  },
  proposal: PortfolioArbitrationProposal,
  rank: number,
  details: {
    conflictTypes?: readonly string[];
    reasonCodes: readonly string[];
    relatedProposalIds?: readonly string[];
    relatedPositionIds?: readonly string[];
    relatedOpenOrderIds?: readonly string[];
  }
): PortfolioArbitrationDecision => ({
  ...decisionBase(input, proposal, rank),
  action: "skip",
  approvedQuantity: null,
  approvedNotional: null,
  approvedResourceRequirement: null,
  conflictTypes: details.conflictTypes ?? [],
  reasonCodes: details.reasonCodes,
  relatedProposalIds: details.relatedProposalIds ?? [],
  relatedPositionIds: details.relatedPositionIds ?? [],
  relatedOpenOrderIds: details.relatedOpenOrderIds ?? []
});

const validSizing = (proposal: PortfolioArbitrationProposal) => {
  const requirement = finitePositive(proposal.resourceRequirement);
  const unit = finitePositive(proposal.unitResource);
  if (requirement === null || unit === null) return null;
  if (
    proposal.resizeMode !== "notional" &&
    (
      proposal.requestedQuantity === null ||
      !Number.isSafeInteger(proposal.requestedQuantity) ||
      proposal.requestedQuantity < 1 ||
      resourcePrecision(proposal.requestedQuantity * unit) !==
        resourcePrecision(requirement)
    )
  ) {
    return null;
  }
  return { requirement, unit };
};

const sizedResource = (
  proposal: PortfolioArbitrationProposal,
  requested: number,
  unit: number,
  available: number
) => {
  const bounded = Math.min(requested, Math.max(0, available));
  if (proposal.resizeMode === "notional") {
    const amount = money(bounded);
    return {
      resource: amount >= unit ? amount : 0,
      units: null
    };
  }
  const units = Math.floor((bounded + Number.EPSILON) / unit);
  return {
    resource: units >= 1 ? resourcePrecision(units * unit) : 0,
    units
  };
};

const reasonForUnavailableCapacity = (dimensions: {
  buyingPower: boolean;
  cash: boolean;
  portfolio: boolean;
  lane: boolean;
  underlying: boolean;
}) => {
  const reasons: string[] = [];
  if (dimensions.buyingPower) {
    reasons.push("ARBITRATION_SKIPPED_INSUFFICIENT_BUYING_POWER");
  }
  if (dimensions.cash) {
    reasons.push("ARBITRATION_SKIPPED_INSUFFICIENT_CASH");
  }
  if (dimensions.portfolio) {
    reasons.push("ARBITRATION_SKIPPED_PORTFOLIO_LIMIT");
  }
  if (dimensions.lane) {
    reasons.push("ARBITRATION_SKIPPED_PORTFOLIO_LIMIT");
  }
  if (dimensions.underlying) {
    reasons.push("ARBITRATION_SKIPPED_UNDERLYING_EXPOSURE");
  }
  return [...new Set(reasons)];
};

const resizeReasons = (dimensions: {
  buyingPower: boolean;
  cash: boolean;
  portfolio: boolean;
  lane: boolean;
  underlying: boolean;
}) => {
  const reasons: string[] = [];
  if (dimensions.buyingPower) {
    reasons.push("ARBITRATION_RESIZED_BUYING_POWER");
  }
  if (dimensions.cash) reasons.push("ARBITRATION_RESIZED_CASH_LIMIT");
  if (dimensions.portfolio) {
    reasons.push("ARBITRATION_RESIZED_PORTFOLIO_LIMIT");
  }
  if (dimensions.lane) reasons.push("ARBITRATION_RESIZED_LANE_LIMIT");
  if (dimensions.underlying) {
    reasons.push("ARBITRATION_RESIZED_UNDERLYING_EXPOSURE");
  }
  return reasons.length ? reasons : ["ARBITRATION_RESIZED_PORTFOLIO_LIMIT"];
};

export const arbitratePortfolioResources = (input: {
  readonly arbitrationId: string;
  readonly cycleId: string;
  readonly proposals: readonly PortfolioArbitrationProposal[];
  readonly context: PortfolioResourceContext;
}): PortfolioArbitrationResult => {
  if (input.proposals.some(({ cycleId }) => cycleId !== input.cycleId)) {
    throw new Error("PORTFOLIO_ARBITRATION_CYCLE_MISMATCH");
  }
  const buyingPower = finiteNonnegative(input.context.buyingPowerAvailable);
  const optionsBuyingPower = finiteNonnegative(
    input.context.optionsBuyingPowerAvailable
  );
  const cash = finiteNonnegative(input.context.cashAvailable);
  const portfolio = finiteNonnegative(
    input.context.portfolioCapacityAvailable
  );
  let buyingPowerRemaining = buyingPower;
  let optionsBuyingPowerRemaining = optionsBuyingPower;
  let cashRemaining = cash;
  let portfolioRemaining = portfolio;
  const laneRemaining = new Map<PortfolioArbitrationLane, number | null>(
    Object.entries(input.context.laneCapacityAvailable).map(
      ([lane, value]) => [
        lane as PortfolioArbitrationLane,
        finiteNonnegative(value ?? null)
      ]
    )
  );
  const maxUnderlyingExposure = finiteNonnegative(
    input.context.maxUnderlyingExposure
  );
  const underlyingExposure = new Map<string, number>();
  const unknownUnderlyingExposure = new Set<string>();
  const addUnderlyingExposure = (
    underlyingSymbol: string,
    value: number | null
  ) => {
    const key = normalized(underlyingSymbol);
    const exposure = finiteNonnegative(value);
    if (exposure === null) {
      unknownUnderlyingExposure.add(key);
      return;
    }
    underlyingExposure.set(
      key,
      resourcePrecision((underlyingExposure.get(key) ?? 0) + exposure)
    );
  };
  for (const position of input.context.existingPositions) {
    addUnderlyingExposure(position.underlyingSymbol, position.resourceExposure);
  }
  const currentOrders = input.context.openOrders.filter(activeOrder);
  for (const order of currentOrders) {
    addUnderlyingExposure(order.underlyingSymbol, order.resourceExposure);
  }
  for (const commitment of input.context.pendingCommitments) {
    addUnderlyingExposure(
      commitment.underlyingSymbol,
      commitment.resourceExposure
    );
  }

  const approvals: Array<{
    proposal: PortfolioArbitrationProposal;
    approvedResource: number;
  }> = [];
  const decisions: PortfolioArbitrationDecision[] = [];

  for (const [index, proposal] of ranked(input.proposals).entries()) {
    const rank = index + 1;
    const baseInput = {
      arbitrationId: input.arbitrationId,
      cycleId: input.cycleId,
      context: input.context
    };
    const sizing = validSizing(proposal);
    if (!sizing) {
      decisions.push(skippedDecision(baseInput, proposal, rank, {
        reasonCodes: [
          "ARBITRATION_SKIPPED_RESOURCE_REQUIREMENT_UNAVAILABLE"
        ]
      }));
      continue;
    }

    const key = exposureKey(proposal);
    const positions = input.context.existingPositions.filter(
      (position) => contextExposureKey(position) === key
    );
    if (positions.length) {
      const opposing = positions.some(
        ({ direction }) => direction !== proposal.direction
      );
      decisions.push(skippedDecision(baseInput, proposal, rank, {
        conflictTypes: [
          "EXISTING_POSITION",
          opposing
            ? "OPPOSING_EXISTING_POSITION"
            : "DUPLICATE_EXISTING_POSITION"
        ],
        reasonCodes: ["ARBITRATION_SKIPPED_SYMBOL_EXPOSURE"],
        relatedPositionIds: positions.map(({ id }) => id).sort()
      }));
      continue;
    }
    const conflictingOrders = currentOrders.filter(
      (order) => contextExposureKey(order) === key
    );
    if (conflictingOrders.length) {
      const opposing = conflictingOrders.some(
        ({ direction }) => direction !== proposal.direction
      );
      decisions.push(skippedDecision(baseInput, proposal, rank, {
        conflictTypes: [
          "EXISTING_OPEN_ORDER",
          opposing
            ? "OPPOSING_EXISTING_OPEN_ORDER"
            : "DUPLICATE_EXISTING_OPEN_ORDER"
        ],
        reasonCodes: ["ARBITRATION_SKIPPED_EXISTING_OPEN_ORDER"],
        relatedOpenOrderIds: conflictingOrders.map(({ id }) => id).sort()
      }));
      continue;
    }
    const commitments = input.context.pendingCommitments.filter(
      (commitment) => contextExposureKey(commitment) === key
    );
    if (commitments.length) {
      const opposing = commitments.some(
        ({ direction }) => direction !== proposal.direction
      );
      decisions.push(skippedDecision(baseInput, proposal, rank, {
        conflictTypes: [
          "EXISTING_PENDING_COMMITMENT",
          opposing
            ? "OPPOSING_PENDING_COMMITMENT"
            : "DUPLICATE_PENDING_COMMITMENT"
        ],
        reasonCodes: ["ARBITRATION_SKIPPED_SYMBOL_EXPOSURE"]
      }));
      continue;
    }

    const priorExact = approvals.find(
      ({ proposal: approved }) => exposureKey(approved) === key
    );
    if (priorExact) {
      const opposing = priorExact.proposal.direction !== proposal.direction;
      decisions.push(skippedDecision(baseInput, proposal, rank, {
        conflictTypes: [
          opposing ? "OPPOSING_PROPOSAL" : "DUPLICATE_PROPOSAL"
        ],
        reasonCodes: [
          opposing
            ? "ARBITRATION_SKIPPED_OPPOSING_PROPOSAL"
            : "ARBITRATION_SKIPPED_DUPLICATE_PROPOSAL"
        ],
        relatedProposalIds: [priorExact.proposal.proposalId]
      }));
      continue;
    }

    if (
      buyingPowerRemaining === null ||
      cashRemaining === null ||
      portfolioRemaining === null
    ) {
      decisions.push(skippedDecision(baseInput, proposal, rank, {
        reasonCodes: [
          "ARBITRATION_SKIPPED_RESOURCE_REQUIREMENT_UNAVAILABLE"
        ]
      }));
      continue;
    }
    if (
      proposal.assetClass === "option" &&
      optionsBuyingPowerRemaining === null
    ) {
      decisions.push(skippedDecision(baseInput, proposal, rank, {
        reasonCodes: [
          "ARBITRATION_SKIPPED_RESOURCE_REQUIREMENT_UNAVAILABLE"
        ]
      }));
      continue;
    }

    const laneCapacity = laneRemaining.has(proposal.lane)
      ? laneRemaining.get(proposal.lane)!
      : Number.POSITIVE_INFINITY;
    if (laneCapacity === null) {
      decisions.push(skippedDecision(baseInput, proposal, rank, {
        reasonCodes: [
          "ARBITRATION_SKIPPED_RESOURCE_REQUIREMENT_UNAVAILABLE"
        ]
      }));
      continue;
    }
    const underlyingKey = normalized(proposal.underlyingSymbol);
    if (
      maxUnderlyingExposure !== null &&
      unknownUnderlyingExposure.has(underlyingKey)
    ) {
      const unknownPositions = input.context.existingPositions.filter(
        ({ underlyingSymbol, resourceExposure }) =>
          normalized(underlyingSymbol) === underlyingKey &&
          finiteNonnegative(resourceExposure) === null
      );
      const unknownOrders = currentOrders.filter(
        ({ underlyingSymbol, resourceExposure }) =>
          normalized(underlyingSymbol) === underlyingKey &&
          finiteNonnegative(resourceExposure) === null
      );
      decisions.push(skippedDecision(baseInput, proposal, rank, {
        conflictTypes: ["UNDERLYING_EXPOSURE_UNAVAILABLE"],
        reasonCodes: [
          "ARBITRATION_SKIPPED_RESOURCE_REQUIREMENT_UNAVAILABLE"
        ],
        relatedPositionIds: unknownPositions.map(({ id }) => id).sort(),
        relatedOpenOrderIds: unknownOrders.map(({ id }) => id).sort()
      }));
      continue;
    }
    const existingUnderlying = underlyingExposure.get(
      underlyingKey
    ) ?? 0;
    const underlyingRemaining = maxUnderlyingExposure === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, maxUnderlyingExposure - existingUnderlying);
    const available = Math.min(
      buyingPowerRemaining,
      cashRemaining,
      portfolioRemaining,
      laneCapacity,
      underlyingRemaining,
      proposal.assetClass === "option"
        ? optionsBuyingPowerRemaining!
        : Number.POSITIVE_INFINITY
    );
    const limited = {
      buyingPower:
        buyingPowerRemaining < sizing.requirement ||
        (
          proposal.assetClass === "option" &&
          optionsBuyingPowerRemaining! < sizing.requirement
        ),
      cash: cashRemaining < sizing.requirement,
      portfolio: portfolioRemaining < sizing.requirement,
      lane: laneCapacity < sizing.requirement,
      underlying: underlyingRemaining < sizing.requirement
    };
    const approvedSizing = sizedResource(
      proposal,
      sizing.requirement,
      sizing.unit,
      available
    );
    const approvedResource = approvedSizing.resource;
    if (approvedResource <= 0) {
      decisions.push(skippedDecision(baseInput, proposal, rank, {
        conflictTypes: limited.underlying
          ? ["UNDERLYING_EXPOSURE_LIMIT"]
          : ["SHARED_RESOURCE_CAPACITY"],
        reasonCodes: [
          ...reasonForUnavailableCapacity(limited),
          "ARBITRATION_SKIPPED_NO_VALID_RESIZE"
        ]
      }));
      continue;
    }

    const resized =
      resourcePrecision(approvedResource) <
      resourcePrecision(sizing.requirement);
    const approvedQuantity = proposal.resizeMode === "notional"
      ? proposal.requestedQuantity
      : approvedSizing.units;
    const reasonCodes = resized
      ? resizeReasons(limited)
      : [
          "ARBITRATION_APPROVED",
          "ARBITRATION_APPROVED_WITHIN_BUYING_POWER",
          ...(maxUnderlyingExposure === null
            ? []
            : ["ARBITRATION_APPROVED_WITHIN_EXPOSURE_LIMIT"])
        ];
    decisions.push({
      ...decisionBase(baseInput, proposal, rank),
      action: resized ? "resize" : "approve",
      approvedQuantity,
      approvedNotional: approvedResource,
      approvedResourceRequirement: approvedResource,
      conflictTypes: resized
        ? Object.entries(limited)
            .filter(([, constrained]) => constrained)
            .map(([dimension]) => dimension.toUpperCase())
        : [],
      reasonCodes,
      relatedProposalIds: [],
      relatedPositionIds: [],
      relatedOpenOrderIds: []
    });
    approvals.push({ proposal, approvedResource });
    buyingPowerRemaining = money(buyingPowerRemaining - approvedResource);
    if (proposal.assetClass === "option") {
      optionsBuyingPowerRemaining = money(
        optionsBuyingPowerRemaining! - approvedResource
      );
    }
    cashRemaining = money(cashRemaining - approvedResource);
    portfolioRemaining = money(portfolioRemaining - approvedResource);
    if (laneRemaining.has(proposal.lane)) {
      laneRemaining.set(
        proposal.lane,
        money(laneCapacity - approvedResource)
      );
    }
    addUnderlyingExposure(proposal.underlyingSymbol, approvedResource);
  }

  return {
    arbitrationId: input.arbitrationId,
    cycleId: input.cycleId,
    contextId: input.context.contextId,
    contextVersion: input.context.contextVersion,
    decisions,
    approvedResourceTotal: resourcePrecision(
      decisions.reduce(
        (sum, decision) =>
          sum + (decision.approvedResourceRequirement ?? 0),
        0
      )
    )
  };
};
