import { canonicalJsonHash } from "../lib/canonicalJson.js";
import { optionDaysToExpiration, parseOptionSymbol } from "./optionSymbolService.js";
import type {
  AuthorityBrokerOrder,
  PostgresAuthorityBrokerSnapshot
} from "./postgresAuthorityBrokerSnapshot.js";

export const PORTFOLIO_STATE_PACKET_VALIDITY_MS = 120_000;

export type PortfolioStateStrategyFamily =
  | "leaps"
  | "zero_dte"
  | "equity"
  | "external_or_unattributed";

export type PortfolioStatePosition = {
  symbol: string;
  assetClass: "equity" | "option";
  strategyFamily: PortfolioStateStrategyFamily;
  direction: "long" | "short";
  quantity: number;
  averageEntryPrice: number;
  currentMark: number;
  marketValue: number;
  unrealizedPnl: number;
  contractIdentifier: string | null;
  expiration: string | null;
  strike: number | null;
  optionType: "call" | "put" | null;
  daysToExpiration: number | null;
  sourceTimestamp: string;
};

export type PortfolioStateOrder = {
  brokerOrderId: string;
  clientOrderId: string;
  strategyClientOrderPrefix: "pg-leaps-" | "pg-0dte-" | null;
  symbol: string;
  assetClass: "equity" | "option";
  side: string;
  quantity: number | null;
  orderType: string;
  limitPrice: number | null;
  status: string;
  submittedAt: string | null;
  filledQuantity: number | null;
  sourceTimestamp: string;
};

export type PortfolioStateRisk = {
  grossExposure: number;
  netExposure: number;
  directEquityExposure: number;
  directOptionPremiumExposure: number;
  etfLookThroughExposure: number | null;
  etfLookThroughStatus: "available" | "unavailable";
  strategyCapitalAllocation: Record<string, number>;
  existingLeapsExposure: number;
  existingZeroDteExposure: number;
  concentrationLimitStatus: "pass" | "blocked" | "unavailable";
  concentrationLimitPct: number | null;
  observedConcentrationPct: number | null;
  capitalAvailableForProposedTrade: number;
  eventRestrictionStatus: "pass" | "blocked" | "unavailable";
  eventRestrictionReasons: string[];
  marketOpen: boolean;
  marketClockTimestamp: string;
};

export type PortfolioStatePacket = {
  schemaVersion: "portfolio-state-v1";
  packetId: string;
  packetFingerprint: string;
  generatedAt: string;
  validUntil: string;
  authority: {
    environment: string;
    paperOnly: boolean;
    postgresOnly: boolean;
    sqliteRuntimeRole: string;
    authenticatedBrokerReads: boolean;
    opraRequired: true;
    opraAvailable: boolean;
  };
  account: {
    accountId: string;
    equity: number;
    cash: number;
    buyingPower: number;
    optionsBuyingPower: number | null;
    reservedCapital: number;
    availableValidatedCapital: number;
    observedAt: string;
    reconciledAt: string;
  };
  positions: PortfolioStatePosition[];
  orders: {
    open: PortfolioStateOrder[];
    recent: PortfolioStateOrder[];
    duplicateHeldContract: boolean;
    duplicateOpenOrder: boolean;
  };
  risk: PortfolioStateRisk;
  proposedTrade: {
    contractIdentifier: string | null;
  };
  reconciliation: {
    status: "matched" | "mismatched";
    positionsMatched: boolean;
    openOrdersMatched: boolean;
    recentStrategyOrdersMatched: boolean;
    brokerStructuralPortfolioFingerprint: string;
    reconciledStructuralPortfolioFingerprint: string;
  };
  lineage: {
    marketEvidenceId: string | null;
    candidateId: string | null;
    strategyReviewId: string | null;
    executionIntentId: string | null;
    accountSnapshotId: string;
    structuralPortfolioFingerprint: string;
  };
};

export type BuildPostgresPortfolioStatePacketInput = {
  now: string;
  accountId: string;
  brokerSnapshot: PostgresAuthorityBrokerSnapshot;
  recentOrders: Array<AuthorityBrokerOrder & {
    filledQuantity: number | null;
    submittedAt: string | null;
  }>;
  authority: {
    authenticatedBrokerReads: boolean;
    postgresOnly: boolean;
    sqliteRuntimeRole: string;
    opraAvailable: boolean;
  };
  marketClock: {
    observedAt: string;
    isOpen: boolean;
  };
  reconciledAt: string;
  reconciledStructuralPortfolioFingerprint: string;
  reservedCapital: number;
  proposedContractIdentifier: string | null;
  positionLineage: Record<string, PortfolioStateStrategyFamily>;
  strategyCapitalAllocation: Record<string, number>;
  concentrationLimit: {
    status: "pass" | "blocked" | "unavailable";
    limitPct: number | null;
    observedPct: number | null;
  };
  eventRestrictions: {
    status: "pass" | "blocked" | "unavailable";
    reasons: string[];
  };
  positionsReconciled?: boolean;
  openOrdersReconciled?: boolean;
  recentStrategyOrdersReconciled?: boolean;
  lineage: {
    marketEvidenceId: string | null;
    candidateId: string | null;
    strategyReviewId: string | null;
    executionIntentId: string | null;
    accountSnapshotId: string;
  };
};

export type PortfolioStatePacketValidationInput = {
  packet: PortfolioStatePacket;
  now?: string;
  expectedAccountId?: string;
  expectedCandidateId?: string | null;
  expectedContractIdentifier?: string | null;
  expectedStructuralPortfolioFingerprint?: string;
  requiredCapital?: number;
  requireMarketOpen?: boolean;
  requireOpra?: boolean;
};

export type PortfolioStatePacketValidation = {
  valid: boolean;
  blockers: string[];
};

export type ScopePostgresPortfolioStatePacketInput = {
  basePacket: PortfolioStatePacket;
  proposedContractIdentifier: string | null;
  marketEvidenceId: string;
  candidateId: string;
  strategyReviewId: string;
  executionIntentId: string;
};

const strategyPrefix = (
  clientOrderId: string
): PortfolioStateOrder["strategyClientOrderPrefix"] => {
  if (clientOrderId.startsWith("pg-leaps-")) return "pg-leaps-";
  if (clientOrderId.startsWith("pg-0dte-")) return "pg-0dte-";
  return null;
};

const normalizeContractIdentifier = (value: string | null | undefined) => {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized || null;
};

const normalizeOpenOrder = (
  order: AuthorityBrokerOrder,
  sourceTimestamp: string
): PortfolioStateOrder => ({
  brokerOrderId: order.brokerOrderId,
  clientOrderId: order.clientOrderId,
  strategyClientOrderPrefix: strategyPrefix(order.clientOrderId),
  symbol: order.symbol,
  assetClass: order.assetClass,
  side: order.side,
  quantity: order.quantity,
  orderType: order.orderType,
  limitPrice: order.limitPrice,
  status: order.status,
  submittedAt: null,
  filledQuantity: null,
  sourceTimestamp
});

const normalizeRecentOrder = (
  order: BuildPostgresPortfolioStatePacketInput["recentOrders"][number],
  sourceTimestamp: string
): PortfolioStateOrder => ({
  ...normalizeOpenOrder(order, sourceTimestamp),
  submittedAt: order.submittedAt,
  filledQuantity: order.filledQuantity
});

const finiteMinimum = (values: Array<number | null>) => {
  const available = values.filter((value): value is number => value !== null);
  if (!available.length) return Number.NaN;
  return Math.min(...available);
};

export const portfolioStatePacketFingerprint = (packet: PortfolioStatePacket) => {
  const { packetFingerprint: _packetFingerprint, ...fingerprintPayload } = packet;
  return canonicalJsonHash(fingerprintPayload);
};

export const buildPostgresPortfolioStatePacket = (
  input: BuildPostgresPortfolioStatePacketInput
): PortfolioStatePacket => {
  const generatedAt = new Date(input.now);
  const proposedContractIdentifier = normalizeContractIdentifier(
    input.proposedContractIdentifier
  );
  const positions: PortfolioStatePosition[] = input.brokerSnapshot.positions.map((position) => {
    const strategyFamily =
      input.positionLineage[position.brokerPositionKey] ?? "external_or_unattributed";
    if (position.assetClass === "equity") {
      return {
        symbol: position.symbol,
        assetClass: "equity",
        strategyFamily,
        direction: position.side,
        quantity: position.quantity,
        averageEntryPrice: position.averageEntryPrice,
        currentMark: position.currentPrice,
        marketValue: position.marketValue,
        unrealizedPnl: position.unrealizedPnl,
        contractIdentifier: null,
        expiration: null,
        strike: null,
        optionType: null,
        daysToExpiration: null,
        sourceTimestamp: input.brokerSnapshot.capturedAt
      };
    }

    const parsed = parseOptionSymbol(position.optionSymbol ?? "");
    if (!parsed.ok) {
      throw new Error(`PORTFOLIO_STATE_OPTION_IDENTITY_INVALID:${parsed.code}`);
    }
    return {
      symbol: position.symbol,
      assetClass: "option",
      strategyFamily,
      direction: position.side,
      quantity: position.quantity,
      averageEntryPrice: position.averageEntryPrice,
      currentMark: position.currentPrice,
      marketValue: position.marketValue,
      unrealizedPnl: position.unrealizedPnl,
      contractIdentifier: parsed.normalizedSymbol,
      expiration: parsed.expirationDate,
      strike: parsed.strikePrice,
      optionType: parsed.optionType,
      daysToExpiration: optionDaysToExpiration(parsed.expirationDate, input.now),
      sourceTimestamp: input.brokerSnapshot.capturedAt
    };
  });
  const openOrders = input.brokerSnapshot.orders.map((order) =>
    normalizeOpenOrder(order, input.brokerSnapshot.capturedAt)
  );
  const recentOrders = input.recentOrders.map((order) =>
    normalizeRecentOrder(order, input.brokerSnapshot.capturedAt)
  );
  const capitalBase = finiteMinimum([
    input.brokerSnapshot.account.cash,
    input.brokerSnapshot.account.buyingPower,
    input.brokerSnapshot.account.optionsBuyingPower
  ]);
  const availableValidatedCapital = Math.max(0, capitalBase - input.reservedCapital);
  const grossExposure = positions.reduce(
    (total, position) => total + Math.abs(position.marketValue),
    0
  );
  const netExposure = positions.reduce(
    (total, position) => total + position.marketValue,
    0
  );
  const directEquityExposure = positions
    .filter((position) => position.assetClass === "equity")
    .reduce((total, position) => total + Math.abs(position.marketValue), 0);
  const directOptionPremiumExposure = positions
    .filter((position) => position.assetClass === "option")
    .reduce((total, position) => total + Math.abs(position.marketValue), 0);
  const strategyExposure = (strategyFamily: PortfolioStateStrategyFamily) =>
    positions
      .filter((position) => position.strategyFamily === strategyFamily)
      .reduce((total, position) => total + Math.abs(position.marketValue), 0);
  const duplicateHeldContract = proposedContractIdentifier !== null && positions.some(
    (position) => position.contractIdentifier === proposedContractIdentifier
  );
  const duplicateOpenOrder = proposedContractIdentifier !== null && openOrders.some(
    (order) => normalizeContractIdentifier(order.symbol) === proposedContractIdentifier
  );
  const paperOnly =
    input.brokerSnapshot.configuration.environment === "paper" &&
    input.brokerSnapshot.configuration.tradingMode === "paper" &&
    input.brokerSnapshot.configuration.liveTradingEnabled === false;
  const reconciled =
    input.brokerSnapshot.structuralPortfolioFingerprint ===
      input.reconciledStructuralPortfolioFingerprint &&
    input.positionsReconciled !== false &&
    input.openOrdersReconciled !== false &&
    input.recentStrategyOrdersReconciled !== false;
  const packetId = `psp-${canonicalJsonHash({
    accountIdentityHash: input.brokerSnapshot.accountIdentityHash,
    capturedAt: input.brokerSnapshot.capturedAt,
    generatedAt: input.now,
    lineage: input.lineage,
    proposedContractIdentifier
  }).slice(0, 32)}`;

  const packetWithoutFingerprint: Omit<PortfolioStatePacket, "packetFingerprint"> = {
    schemaVersion: "portfolio-state-v1",
    packetId,
    generatedAt: input.now,
    validUntil: new Date(generatedAt.getTime() + PORTFOLIO_STATE_PACKET_VALIDITY_MS).toISOString(),
    authority: {
      environment: input.brokerSnapshot.configuration.environment,
      paperOnly,
      postgresOnly: input.authority.postgresOnly,
      sqliteRuntimeRole: input.authority.sqliteRuntimeRole,
      authenticatedBrokerReads: input.authority.authenticatedBrokerReads,
      opraRequired: true,
      opraAvailable: input.authority.opraAvailable
    },
    account: {
      accountId: input.accountId,
      equity: input.brokerSnapshot.account.equity,
      cash: input.brokerSnapshot.account.cash,
      buyingPower: input.brokerSnapshot.account.buyingPower,
      optionsBuyingPower: input.brokerSnapshot.account.optionsBuyingPower,
      reservedCapital: input.reservedCapital,
      availableValidatedCapital,
      observedAt: input.brokerSnapshot.capturedAt,
      reconciledAt: input.reconciledAt
    },
    positions,
    orders: {
      open: openOrders,
      recent: recentOrders,
      duplicateHeldContract,
      duplicateOpenOrder
    },
    risk: {
      grossExposure,
      netExposure,
      directEquityExposure,
      directOptionPremiumExposure,
      etfLookThroughExposure: null,
      etfLookThroughStatus: "unavailable",
      strategyCapitalAllocation: { ...input.strategyCapitalAllocation },
      existingLeapsExposure: strategyExposure("leaps"),
      existingZeroDteExposure: strategyExposure("zero_dte"),
      concentrationLimitStatus: input.concentrationLimit.status,
      concentrationLimitPct: input.concentrationLimit.limitPct,
      observedConcentrationPct: input.concentrationLimit.observedPct,
      capitalAvailableForProposedTrade: availableValidatedCapital,
      eventRestrictionStatus: input.eventRestrictions.status,
      eventRestrictionReasons: [...input.eventRestrictions.reasons],
      marketOpen: input.marketClock.isOpen,
      marketClockTimestamp: input.marketClock.observedAt
    },
    proposedTrade: { contractIdentifier: proposedContractIdentifier },
    reconciliation: {
      status: reconciled ? "matched" : "mismatched",
      positionsMatched: input.positionsReconciled !== false,
      openOrdersMatched: input.openOrdersReconciled !== false,
      recentStrategyOrdersMatched: input.recentStrategyOrdersReconciled !== false,
      brokerStructuralPortfolioFingerprint:
        input.brokerSnapshot.structuralPortfolioFingerprint,
      reconciledStructuralPortfolioFingerprint:
        input.reconciledStructuralPortfolioFingerprint
    },
    lineage: {
      ...input.lineage,
      structuralPortfolioFingerprint:
        input.brokerSnapshot.structuralPortfolioFingerprint
    }
  };
  const packet = {
    ...packetWithoutFingerprint,
    packetFingerprint: ""
  } satisfies PortfolioStatePacket;
  packet.packetFingerprint = portfolioStatePacketFingerprint(packet);
  return packet;
};

export const scopePostgresPortfolioStatePacket = (
  input: ScopePostgresPortfolioStatePacketInput
): PortfolioStatePacket => {
  if (
    input.basePacket.packetFingerprint !==
    portfolioStatePacketFingerprint(input.basePacket)
  ) {
    throw new Error("PORTFOLIO_STATE_BASE_PACKET_FINGERPRINT_INVALID");
  }
  const proposedContractIdentifier = normalizeContractIdentifier(
    input.proposedContractIdentifier
  );
  const packet = structuredClone(input.basePacket);
  packet.packetId = `psp-${canonicalJsonHash({
    basePacketFingerprint: input.basePacket.packetFingerprint,
    proposedContractIdentifier,
    marketEvidenceId: input.marketEvidenceId,
    candidateId: input.candidateId,
    strategyReviewId: input.strategyReviewId,
    executionIntentId: input.executionIntentId
  }).slice(0, 32)}`;
  packet.proposedTrade.contractIdentifier = proposedContractIdentifier;
  packet.orders.duplicateHeldContract = proposedContractIdentifier !== null &&
    packet.positions.some((position) =>
      position.contractIdentifier === proposedContractIdentifier
    );
  packet.orders.duplicateOpenOrder = proposedContractIdentifier !== null &&
    packet.orders.open.some((order) =>
      normalizeContractIdentifier(order.symbol) === proposedContractIdentifier
    );
  packet.risk.capitalAvailableForProposedTrade =
    packet.account.availableValidatedCapital;
  packet.lineage = {
    ...packet.lineage,
    marketEvidenceId: input.marketEvidenceId,
    candidateId: input.candidateId,
    strategyReviewId: input.strategyReviewId,
    executionIntentId: input.executionIntentId
  };
  packet.packetFingerprint = portfolioStatePacketFingerprint(packet);
  return packet;
};

const invalidTimestamp = (value: string) => !Number.isFinite(new Date(value).getTime());
const invalidNonNegativeNumber = (value: number | null) =>
  value !== null && (!Number.isFinite(value) || value < 0);

export const validatePostgresPortfolioStatePacket = (
  input: PortfolioStatePacketValidationInput
): PortfolioStatePacketValidation => {
  const { packet } = input;
  const blockers = new Set<string>();
  const now = new Date(input.now ?? new Date().toISOString()).getTime();
  const generatedAt = new Date(packet.generatedAt).getTime();
  const validUntil = new Date(packet.validUntil).getTime();

  if (packet.packetFingerprint !== portfolioStatePacketFingerprint(packet)) {
    blockers.add("PORTFOLIO_STATE_FINGERPRINT_INVALID");
  }
  if (!packet.authority.authenticatedBrokerReads) {
    blockers.add("PORTFOLIO_STATE_AUTHENTICATION_REQUIRED");
  }
  if (
    packet.authority.environment !== "paper" ||
    packet.authority.paperOnly !== true
  ) {
    blockers.add("PORTFOLIO_STATE_PAPER_ONLY_REQUIRED");
  }
  if (!packet.authority.postgresOnly) {
    blockers.add("PORTFOLIO_STATE_POSTGRES_AUTHORITY_REQUIRED");
  }
  if (packet.authority.sqliteRuntimeRole !== "none") {
    blockers.add("PORTFOLIO_STATE_SQLITE_AUTHORITY_FORBIDDEN");
  }
  const requireOpra = input.requireOpra ??
    packet.proposedTrade.contractIdentifier !== null;
  if (requireOpra && packet.authority.opraRequired && !packet.authority.opraAvailable) {
    blockers.add("PORTFOLIO_STATE_OPRA_UNAVAILABLE");
  }
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(generatedAt) ||
    !Number.isFinite(validUntil) ||
    invalidTimestamp(packet.account.observedAt) ||
    invalidTimestamp(packet.account.reconciledAt) ||
    invalidTimestamp(packet.risk.marketClockTimestamp)
  ) {
    blockers.add("PORTFOLIO_STATE_TIMESTAMP_INVALID");
  } else {
    if (now > validUntil) blockers.add("PORTFOLIO_STATE_STALE");
    if (
      generatedAt > now ||
      new Date(packet.account.observedAt).getTime() > now ||
      new Date(packet.account.reconciledAt).getTime() > now ||
      new Date(packet.risk.marketClockTimestamp).getTime() > now
    ) {
      blockers.add("PORTFOLIO_STATE_FUTURE_TIMESTAMP");
    }
  }
  if (
    !packet.account.accountId.trim() ||
    invalidNonNegativeNumber(packet.account.equity) ||
    invalidNonNegativeNumber(packet.account.cash) ||
    invalidNonNegativeNumber(packet.account.buyingPower) ||
    invalidNonNegativeNumber(packet.account.optionsBuyingPower) ||
    invalidNonNegativeNumber(packet.account.reservedCapital) ||
    invalidNonNegativeNumber(packet.account.availableValidatedCapital)
  ) {
    blockers.add("PORTFOLIO_STATE_ACCOUNT_INVALID");
  }
  if (
    input.expectedAccountId !== undefined &&
    packet.account.accountId !== input.expectedAccountId
  ) {
    blockers.add("PORTFOLIO_STATE_ACCOUNT_MISMATCH");
  }
  if (packet.positions.some((position) =>
    !Number.isFinite(position.quantity) ||
    position.quantity <= 0 ||
    (position.assetClass === "option" && !Number.isInteger(position.quantity))
  )) {
    blockers.add("PORTFOLIO_STATE_POSITION_QUANTITY_INVALID");
  }
  if (packet.reconciliation.status !== "matched") {
    blockers.add("PORTFOLIO_STATE_RECONCILIATION_MISMATCH");
  }
  if (packet.orders.duplicateHeldContract) {
    blockers.add("PORTFOLIO_STATE_DUPLICATE_HELD_CONTRACT");
  }
  if (packet.orders.duplicateOpenOrder) {
    blockers.add("PORTFOLIO_STATE_DUPLICATE_OPEN_ORDER");
  }
  if (
    input.requiredCapital !== undefined &&
    (!Number.isFinite(input.requiredCapital) ||
      input.requiredCapital <= 0 ||
      packet.account.availableValidatedCapital < input.requiredCapital)
  ) {
    blockers.add("PORTFOLIO_STATE_CAPITAL_UNAVAILABLE");
  }
  if (
    input.expectedCandidateId !== undefined &&
    packet.lineage.candidateId !== input.expectedCandidateId
  ) {
    blockers.add("PORTFOLIO_STATE_LINEAGE_MISMATCH");
  }
  if (
    input.expectedContractIdentifier !== undefined &&
    packet.proposedTrade.contractIdentifier !==
      normalizeContractIdentifier(input.expectedContractIdentifier)
  ) {
    blockers.add("PORTFOLIO_STATE_CONTRACT_MISMATCH");
  }
  if (
    input.expectedStructuralPortfolioFingerprint !== undefined &&
    packet.lineage.structuralPortfolioFingerprint !==
      input.expectedStructuralPortfolioFingerprint
  ) {
    blockers.add("PORTFOLIO_STATE_RECONCILIATION_MISMATCH");
  }
  if (input.requireMarketOpen && !packet.risk.marketOpen) {
    blockers.add("PORTFOLIO_STATE_MARKET_CLOSED");
  }
  if (packet.risk.concentrationLimitStatus === "blocked") {
    blockers.add("PORTFOLIO_STATE_CONCENTRATION_BLOCKED");
  }
  if (packet.risk.eventRestrictionStatus === "blocked") {
    blockers.add("PORTFOLIO_STATE_EVENT_RESTRICTED");
  }

  return { valid: blockers.size === 0, blockers: [...blockers] };
};
