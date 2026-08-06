import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPostgresPortfolioStatePacket,
  portfolioStatePacketFingerprint,
  validatePostgresPortfolioStatePacket,
  type BuildPostgresPortfolioStatePacketInput
} from "../src/services/postgresPortfolioStatePacketService.js";

const now = "2026-08-05T14:00:00.000Z";

const baseInput = (): BuildPostgresPortfolioStatePacketInput => ({
  now,
  accountId: "paper-account-1",
  brokerSnapshot: {
    capturedAt: "2026-08-05T13:59:30.000Z",
    accountId: "paper-account-1",
    accountIdentityHash: "account-hash-1",
    sourceRequestIds: {
      account: "request-account",
      positions: "request-positions",
      openOrders: "request-open-orders",
      recentOrders: "request-recent-orders",
      marketClock: "request-clock"
    },
    account: {
      status: "ACTIVE",
      currency: "USD",
      cash: 20_000,
      equity: 100_000,
      buyingPower: 40_000,
      optionsBuyingPower: 15_000,
      optionsApprovalLevel: 3,
      tradingBlocked: false,
      accountBlocked: false
    },
    configuration: {
      environment: "paper",
      tradingMode: "paper",
      liveTradingEnabled: false,
      paperOrderExecutionEnabled: true,
      paperOptionsExecutionEnabled: true,
      maxPositionNotional: 5_000,
      maxTotalPlanNotional: 50_000,
      equityMaxNotionalPerOrder: 5_000,
      equityMaxPortfolioDeployPct: 50,
      equityMaxPositionPct: 10,
      equityMinCashReservePct: 20,
      optionMaxOrderNotional: 5_000,
      optionMaxContracts: 10,
      optionMaxPortfolioRiskPct: 20,
      optionMaxPositionRiskPct: 5,
      quoteMaxAgeSeconds: 45,
      maxPriceDriftPct: 10,
      zeroDteMaxTradesPerDay: 3,
      zeroDteMaxDailyPremium: 750,
      zeroDteMaxDailyRealizedLoss: 250,
      zeroDteMaxOpenPositions: 3
    },
    configurationFingerprint: "configuration-hash-1",
    positions: [
      {
        brokerPositionKey: "equity:AAPL",
        symbol: "AAPL",
        underlyingSymbol: null,
        optionSymbol: null,
        assetClass: "equity",
        side: "long",
        quantity: 10,
        availableQuantity: 10,
        averageEntryPrice: 180,
        currentPrice: 200,
        marketValue: 2_000,
        costBasis: 1_800,
        unrealizedPnl: 200
      },
      {
        brokerPositionKey: "option:AAPL270115C00200000",
        symbol: "AAPL",
        underlyingSymbol: "AAPL",
        optionSymbol: "AAPL270115C00200000",
        assetClass: "option",
        side: "long",
        quantity: 2,
        availableQuantity: 2,
        averageEntryPrice: 7,
        currentPrice: 8,
        marketValue: 1_600,
        costBasis: 1_400,
        unrealizedPnl: 200
      },
      {
        brokerPositionKey: "option:SPY260805P00450000",
        symbol: "SPY",
        underlyingSymbol: "SPY",
        optionSymbol: "SPY260805P00450000",
        assetClass: "option",
        side: "short",
        quantity: 1,
        availableQuantity: 1,
        averageEntryPrice: 1.5,
        currentPrice: 1.25,
        marketValue: -125,
        costBasis: -150,
        unrealizedPnl: 25
      }
    ],
    orders: [
      {
        brokerOrderId: "broker-open-1",
        clientOrderId: "pg-0dte-abc123",
        symbol: "SPY260805P00450000",
        assetClass: "option",
        side: "buy_to_close",
        orderType: "limit",
        timeInForce: "day",
        status: "accepted",
        quantity: 1,
        notional: null,
        limitPrice: 1.2
      }
    ],
    recentOrders: [],
    marketClock: {
      observedAt: "2026-08-05T13:59:45.000Z",
      isOpen: true
    },
    structuralPortfolioFingerprint: "structural-hash-1",
    portfolioFingerprint: "portfolio-hash-1"
  },
  recentOrders: [
    {
      brokerOrderId: "broker-recent-1",
      clientOrderId: "pg-leaps-def456",
      symbol: "MSFT270115C00500000",
      assetClass: "option",
      side: "buy_to_open",
      orderType: "limit",
      timeInForce: "day",
      status: "filled",
      quantity: 1,
      notional: null,
      filledQuantity: 1,
      limitPrice: 10,
      submittedAt: "2026-08-05T13:30:00.000Z"
    }
  ],
  authority: {
    authenticatedBrokerReads: true,
    postgresOnly: true,
    sqliteRuntimeRole: "none",
    opraAvailable: true
  },
  marketClock: {
    observedAt: "2026-08-05T13:59:45.000Z",
    isOpen: true
  },
  reconciledAt: "2026-08-05T13:59:40.000Z",
  reconciledStructuralPortfolioFingerprint: "structural-hash-1",
  reservedCapital: 2_500,
  proposedContractIdentifier: "MSFT270115C00510000",
  positionLineage: {
    "option:AAPL270115C00200000": "leaps",
    "option:SPY260805P00450000": "zero_dte"
  },
  strategyCapitalAllocation: {
    leaps: 5_000,
    zero_dte: 750,
    external_or_unattributed: 2_000
  },
  concentrationLimit: {
    status: "pass",
    limitPct: 10,
    observedPct: 2
  },
  eventRestrictions: {
    status: "unavailable",
    reasons: []
  },
  lineage: {
    marketEvidenceId: "market-evidence-1",
    candidateId: "candidate-1",
    strategyReviewId: null,
    executionIntentId: null,
    accountSnapshotId: "account-snapshot-1"
  }
});

test("builds an authoritative packet with literal capital, exposure, option identity, and lineage", () => {
  const packet = buildPostgresPortfolioStatePacket(baseInput());

  assert.equal(packet.schemaVersion, "portfolio-state-v1");
  assert.match(packet.packetId, /^psp-[a-f0-9]{32}$/);
  assert.equal(packet.packetFingerprint, portfolioStatePacketFingerprint(packet));
  assert.equal(packet.generatedAt, now);
  assert.equal(packet.validUntil, "2026-08-05T14:03:00.000Z");
  assert.deepEqual(packet.authority, {
    environment: "paper",
    paperOnly: true,
    postgresOnly: true,
    sqliteRuntimeRole: "none",
    authenticatedBrokerReads: true,
    opraRequired: true,
    opraAvailable: true
  });
  assert.deepEqual(packet.account, {
    accountId: "paper-account-1",
    equity: 100_000,
    cash: 20_000,
    buyingPower: 40_000,
    optionsBuyingPower: 15_000,
    reservedCapital: 2_500,
    availableValidatedCapital: 12_500,
    observedAt: "2026-08-05T13:59:30.000Z",
    reconciledAt: "2026-08-05T13:59:40.000Z"
  });

  assert.equal(packet.positions[0]?.strategyFamily, "external_or_unattributed");
  assert.deepEqual(
    packet.positions.find((position) => position.contractIdentifier === "AAPL270115C00200000"),
    {
      symbol: "AAPL",
      assetClass: "option",
      strategyFamily: "leaps",
      direction: "long",
      quantity: 2,
      averageEntryPrice: 7,
      currentMark: 8,
      marketValue: 1_600,
      unrealizedPnl: 200,
      contractIdentifier: "AAPL270115C00200000",
      expiration: "2027-01-15",
      strike: 200,
      optionType: "call",
      daysToExpiration: 163,
      sourceTimestamp: "2026-08-05T13:59:30.000Z"
    }
  );
  assert.equal(
    packet.positions.find((position) => position.contractIdentifier === "SPY260805P00450000")
      ?.daysToExpiration,
    0
  );

  assert.deepEqual(packet.risk, {
    grossExposure: 3_725,
    netExposure: 3_475,
    directEquityExposure: 2_000,
    directOptionPremiumExposure: 1_725,
    etfLookThroughExposure: null,
    etfLookThroughStatus: "unavailable",
    strategyCapitalAllocation: {
      leaps: 5_000,
      zero_dte: 750,
      external_or_unattributed: 2_000
    },
    existingLeapsExposure: 1_600,
    existingZeroDteExposure: 125,
    concentrationLimitStatus: "pass",
    concentrationLimitPct: 10,
    observedConcentrationPct: 2,
    capitalAvailableForProposedTrade: 12_500,
    eventRestrictionStatus: "unavailable",
    eventRestrictionReasons: [],
    marketOpen: true,
    marketClockTimestamp: "2026-08-05T13:59:45.000Z"
  });
  assert.equal(packet.orders.open[0]?.strategyClientOrderPrefix, "pg-0dte-");
  assert.equal(packet.orders.recent[0]?.strategyClientOrderPrefix, "pg-leaps-");
  assert.equal(packet.orders.duplicateHeldContract, false);
  assert.equal(packet.orders.duplicateOpenOrder, false);
  assert.deepEqual(packet.lineage, {
    marketEvidenceId: "market-evidence-1",
    candidateId: "candidate-1",
    strategyReviewId: null,
    executionIntentId: null,
    accountSnapshotId: "account-snapshot-1",
    structuralPortfolioFingerprint: "structural-hash-1"
  });
});

test("packet validation binds the authenticated broker account identity", () => {
  const packet = buildPostgresPortfolioStatePacket(baseInput());
  assert.deepEqual(
    validatePostgresPortfolioStatePacket({
      packet,
      now,
      expectedAccountId: "different-account"
    }).blockers,
    ["PORTFOLIO_STATE_ACCOUNT_MISMATCH"]
  );
});

test("detects duplicate held contracts and duplicate open orders without fuzzy symbol matching", () => {
  const heldInput = baseInput();
  heldInput.proposedContractIdentifier = "AAPL270115C00200000";
  const heldPacket = buildPostgresPortfolioStatePacket(heldInput);
  assert.equal(heldPacket.orders.duplicateHeldContract, true);
  assert.equal(heldPacket.orders.duplicateOpenOrder, false);

  const openInput = baseInput();
  openInput.proposedContractIdentifier = "SPY260805P00450000";
  const openPacket = buildPostgresPortfolioStatePacket(openInput);
  assert.equal(openPacket.orders.duplicateHeldContract, true);
  assert.equal(openPacket.orders.duplicateOpenOrder, true);
});

test("rejects malformed broker option identities instead of fabricating contract fields", () => {
  const input = baseInput();
  input.brokerSnapshot.positions[1] = {
    ...input.brokerSnapshot.positions[1]!,
    optionSymbol: "AAPL-NOT-OCC"
  };
  assert.throws(
    () => buildPostgresPortfolioStatePacket(input),
    /PORTFOLIO_STATE_OPTION_IDENTITY_INVALID/
  );
});

test("validation is fail closed for authority, freshness, reconciliation, duplicates, capital, and lineage", () => {
  const validPacket = buildPostgresPortfolioStatePacket(baseInput());
  assert.deepEqual(
    validatePostgresPortfolioStatePacket({
      packet: validPacket,
      now: "2026-08-05T14:00:30.000Z",
      expectedCandidateId: "candidate-1",
      expectedContractIdentifier: "MSFT270115C00510000",
      expectedStructuralPortfolioFingerprint: "structural-hash-1",
      requiredCapital: 5_000,
      requireMarketOpen: true
    }),
    { valid: true, blockers: [] }
  );

  const cases: Array<{
    name: string;
    mutate: (input: BuildPostgresPortfolioStatePacketInput) => void;
    code: string;
    validation?: Record<string, unknown>;
  }> = [
    {
      name: "authentication",
      mutate: (input) => { input.authority.authenticatedBrokerReads = false; },
      code: "PORTFOLIO_STATE_AUTHENTICATION_REQUIRED"
    },
    {
      name: "paper posture",
      mutate: (input) => { input.brokerSnapshot.configuration.environment = "live"; },
      code: "PORTFOLIO_STATE_PAPER_ONLY_REQUIRED"
    },
    {
      name: "PostgreSQL authority",
      mutate: (input) => { input.authority.postgresOnly = false; },
      code: "PORTFOLIO_STATE_POSTGRES_AUTHORITY_REQUIRED"
    },
    {
      name: "SQLite authority",
      mutate: (input) => { input.authority.sqliteRuntimeRole = "shadow"; },
      code: "PORTFOLIO_STATE_SQLITE_AUTHORITY_FORBIDDEN"
    },
    {
      name: "broker reconciliation",
      mutate: (input) => { input.reconciledStructuralPortfolioFingerprint = "other"; },
      code: "PORTFOLIO_STATE_RECONCILIATION_MISMATCH"
    }
  ];

  for (const entry of cases) {
    const input = baseInput();
    entry.mutate(input);
    const result = validatePostgresPortfolioStatePacket({
      packet: buildPostgresPortfolioStatePacket(input),
      now: "2026-08-05T14:00:30.000Z"
    });
    assert.equal(result.valid, false, entry.name);
    assert.equal(result.blockers.includes(entry.code), true, entry.name);
  }

  const withinExtendedWindow = validatePostgresPortfolioStatePacket({
    packet: validPacket,
    now: "2026-08-05T14:02:08.000Z"
  });
  assert.equal(withinExtendedWindow.blockers.includes("PORTFOLIO_STATE_STALE"), false);

  const stale = validatePostgresPortfolioStatePacket({
    packet: validPacket,
    now: "2026-08-05T14:03:01.000Z"
  });
  assert.equal(stale.blockers.includes("PORTFOLIO_STATE_STALE"), true);

  const future = validatePostgresPortfolioStatePacket({
    packet: validPacket,
    now: "2026-08-05T13:59:00.000Z"
  });
  assert.equal(future.blockers.includes("PORTFOLIO_STATE_FUTURE_TIMESTAMP"), true);

  const wrongLineage = validatePostgresPortfolioStatePacket({
    packet: validPacket,
    now: "2026-08-05T14:00:30.000Z",
    expectedCandidateId: "candidate-other",
    expectedContractIdentifier: "AAPL270115C00200000",
    expectedStructuralPortfolioFingerprint: "structural-other",
    requiredCapital: 20_000,
    requireMarketOpen: true
  });
  assert.equal(wrongLineage.valid, false);
  assert.deepEqual(
    new Set(wrongLineage.blockers),
    new Set([
      "PORTFOLIO_STATE_LINEAGE_MISMATCH",
      "PORTFOLIO_STATE_CONTRACT_MISMATCH",
      "PORTFOLIO_STATE_RECONCILIATION_MISMATCH",
      "PORTFOLIO_STATE_CAPITAL_UNAVAILABLE"
    ])
  );

  const duplicateInput = baseInput();
  duplicateInput.proposedContractIdentifier = "SPY260805P00450000";
  const duplicate = validatePostgresPortfolioStatePacket({
    packet: buildPostgresPortfolioStatePacket(duplicateInput),
    now: "2026-08-05T14:00:30.000Z"
  });
  assert.equal(duplicate.blockers.includes("PORTFOLIO_STATE_DUPLICATE_HELD_CONTRACT"), true);
  assert.equal(duplicate.blockers.includes("PORTFOLIO_STATE_DUPLICATE_OPEN_ORDER"), true);
});

test("validation rejects invalid numbers, closed markets, and unavailable OPRA authority", () => {
  const input = baseInput();
  input.brokerSnapshot.account.cash = Number.NaN;
  input.brokerSnapshot.positions[0] = {
    ...input.brokerSnapshot.positions[0]!,
    quantity: 0
  };
  input.marketClock.isOpen = false;
  input.authority.opraAvailable = false;
  const packet = buildPostgresPortfolioStatePacket(input);
  const result = validatePostgresPortfolioStatePacket({
    packet,
    now: "2026-08-05T14:00:30.000Z",
    requireMarketOpen: true
  });

  assert.equal(result.valid, false);
  assert.equal(result.blockers.includes("PORTFOLIO_STATE_ACCOUNT_INVALID"), true);
  assert.equal(result.blockers.includes("PORTFOLIO_STATE_POSITION_QUANTITY_INVALID"), true);
  assert.equal(result.blockers.includes("PORTFOLIO_STATE_MARKET_CLOSED"), true);
  assert.equal(result.blockers.includes("PORTFOLIO_STATE_OPRA_UNAVAILABLE"), true);
});
