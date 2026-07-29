import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  arbitratePortfolioResources,
  type PortfolioArbitrationProposal,
  type PortfolioResourceContext
} from "../src/services/portfolioResourceArbitrator.js";

const context = (
  overrides: Partial<PortfolioResourceContext> = {}
): PortfolioResourceContext => ({
  contextId: "snapshot-portfolio-1",
  contextVersion: "portfolio-fingerprint-1",
  buyingPowerAvailable: 10_000,
  optionsBuyingPowerAvailable: 10_000,
  cashAvailable: 10_000,
  portfolioCapacityAvailable: 10_000,
  maxUnderlyingExposure: null,
  existingPositions: [],
  openOrders: [],
  pendingCommitments: [],
  laneCapacityAvailable: {},
  accountSnapshotAsOf: "2026-07-29T14:00:00.000Z",
  positionSnapshotAsOf: "2026-07-29T14:00:00.000Z",
  openOrderSnapshotAsOf: "2026-07-29T14:00:00.000Z",
  ...overrides
});

const proposal = (
  proposalId: string,
  overrides: Partial<PortfolioArbitrationProposal> = {}
): PortfolioArbitrationProposal => ({
  proposalId,
  cycleId: "cycle-9",
  lane: "equity",
  strategyPriority: 0,
  score: 80,
  confidence: 0.8,
  symbol: proposalId.toUpperCase(),
  underlyingSymbol: proposalId.toUpperCase(),
  contractId: null,
  direction: "long",
  assetClass: "equity",
  requestedQuantity: null,
  requestedNotional: 100,
  resourceRequirement: 100,
  unitResource: 0.01,
  resizeMode: "notional",
  ...overrides
});

const run = (
  proposals: readonly PortfolioArbitrationProposal[],
  sharedContext = context()
) => arbitratePortfolioResources({
  arbitrationId: "arbitration-cycle-9",
  cycleId: "cycle-9",
  proposals,
  context: sharedContext
});

test("ranking is deterministic, honors strategy priority, and ignores input order", () => {
  const proposals = [
    proposal("z-last", {
      lane: "options_leaps",
      strategyPriority: 2,
      score: 99,
      assetClass: "option",
      requestedQuantity: 1,
      requestedNotional: 100,
      resourceRequirement: 100,
      unitResource: 100,
      resizeMode: "whole_contracts"
    }),
    proposal("b-tie", { score: 90, confidence: 0.9, symbol: "MSFT" }),
    proposal("a-tie", { score: 90, confidence: 0.9, symbol: "AAPL" }),
    proposal("priority-first", {
      lane: "options_0dte",
      strategyPriority: -1,
      score: 1,
      assetClass: "option",
      requestedQuantity: 1,
      requestedNotional: 100,
      resourceRequirement: 100,
      unitResource: 100,
      resizeMode: "whole_contracts"
    })
  ];

  const first = run(proposals);
  const second = run([...proposals].reverse());

  assert.deepEqual(
    first.decisions.map(({ proposalId }) => proposalId),
    ["priority-first", "a-tie", "b-tie", "z-last"]
  );
  assert.deepEqual(first, second);
});

test("a proposal from a different cycle fails the arbitration pass closed", () => {
  assert.throws(
    () => run([
      proposal("current-cycle"),
      proposal("stale-cycle", { cycleId: "cycle-8" })
    ]),
    /PORTFOLIO_ARBITRATION_CYCLE_MISMATCH/
  );
});

test("higher-ranked proposals reserve shared resources before resize and skip decisions", () => {
  const result = run([
    proposal("option-first", {
      lane: "options_0dte",
      strategyPriority: 0,
      score: 95,
      symbol: "SPY260729C00600000",
      underlyingSymbol: "SPY",
      contractId: "SPY260729C00600000",
      assetClass: "option",
      requestedQuantity: 2,
      requestedNotional: 200,
      resourceRequirement: 200,
      unitResource: 100,
      resizeMode: "whole_contracts"
    }),
    proposal("equity-second", {
      strategyPriority: 1,
      score: 90,
      requestedNotional: 150,
      resourceRequirement: 150
    }),
    proposal("option-last", {
      lane: "options_leaps",
      strategyPriority: 2,
      score: 85,
      symbol: "QQQ270115C00500000",
      underlyingSymbol: "QQQ",
      contractId: "QQQ270115C00500000",
      assetClass: "option",
      requestedQuantity: 1,
      requestedNotional: 100,
      resourceRequirement: 100,
      unitResource: 100,
      resizeMode: "whole_contracts"
    })
  ], context({
    buyingPowerAvailable: 300,
    cashAvailable: 300,
    portfolioCapacityAvailable: 300
  }));

  assert.deepEqual(
    result.decisions.map(({ action, approvedNotional }) => ({
      action,
      approvedNotional
    })),
    [
      { action: "approve", approvedNotional: 200 },
      { action: "resize", approvedNotional: 100 },
      { action: "skip", approvedNotional: null }
    ]
  );
  assert.equal(result.approvedResourceTotal, 300);
  assert.equal(
    result.decisions[1]?.reasonCodes.includes(
      "ARBITRATION_RESIZED_BUYING_POWER"
    ),
    true
  );
  assert.equal(
    result.decisions[2]?.reasonCodes.includes(
      "ARBITRATION_SKIPPED_NO_VALID_RESIZE"
    ),
    true
  );
});

test("option resizing preserves whole contracts and skips below one contract", () => {
  const option = proposal("whole-contract", {
    lane: "options_0dte",
    symbol: "SPY260729C00600000",
    underlyingSymbol: "SPY",
    contractId: "SPY260729C00600000",
    assetClass: "option",
    requestedQuantity: 3,
    requestedNotional: 300,
    resourceRequirement: 300,
    unitResource: 100,
    resizeMode: "whole_contracts"
  });

  const resized = run([option], context({
    buyingPowerAvailable: 250,
    cashAvailable: 250,
    portfolioCapacityAvailable: 250
  })).decisions[0]!;
  assert.equal(resized.action, "resize");
  assert.equal(resized.approvedQuantity, 2);
  assert.equal(resized.approvedNotional, 200);

  const skipped = run([option], context({
    buyingPowerAvailable: 50,
    cashAvailable: 50,
    portfolioCapacityAvailable: 50
  })).decisions[0]!;
  assert.equal(skipped.action, "skip");
  assert.equal(skipped.approvedQuantity, null);
});

test("whole-share sizing preserves sub-cent unit precision", () => {
  const result = run([
    proposal("short-precision", {
      direction: "short",
      requestedQuantity: 2,
      requestedNotional: 200.2468,
      resourceRequirement: 200.2468,
      unitResource: 100.1234,
      resizeMode: "whole_shares"
    })
  ], context({
    buyingPowerAvailable: 150,
    cashAvailable: 150,
    portfolioCapacityAvailable: 150
  }));

  assert.equal(result.decisions[0]?.action, "resize");
  assert.equal(result.decisions[0]?.approvedQuantity, 1);
  assert.equal(result.decisions[0]?.approvedResourceRequirement, 100.1234);

  const unchanged = run([
    proposal("short-floating-point", {
      direction: "short",
      requestedQuantity: 3,
      requestedNotional: 0.1 * 3,
      resourceRequirement: 0.1 * 3,
      unitResource: 0.1,
      resizeMode: "whole_shares"
    })
  ]).decisions[0]!;
  assert.equal(unchanged.action, "approve");
  assert.equal(unchanged.approvedQuantity, 3);
  assert.equal(unchanged.approvedResourceRequirement, 0.3);
});

test("cash is enforced as a distinct shared constraint", () => {
  const result = run([
    proposal("cash-resized", {
      requestedNotional: 200,
      resourceRequirement: 200,
      score: 90
    }),
    proposal("cash-skipped-option", {
      lane: "options_0dte",
      strategyPriority: 1,
      symbol: "SPY260729C00600000",
      underlyingSymbol: "SPY",
      contractId: "SPY260729C00600000",
      assetClass: "option",
      requestedQuantity: 1,
      requestedNotional: 100,
      resourceRequirement: 100,
      unitResource: 100,
      resizeMode: "whole_contracts",
      score: 80
    })
  ], context({
    buyingPowerAvailable: 1_000,
    cashAvailable: 150,
    portfolioCapacityAvailable: 1_000
  }));

  assert.equal(result.decisions[0]?.action, "resize");
  assert.deepEqual(
    result.decisions[0]?.reasonCodes,
    ["ARBITRATION_RESIZED_CASH_LIMIT"]
  );
  assert.equal(result.decisions[1]?.action, "skip");
  assert.equal(
    result.decisions[1]?.reasonCodes.includes(
      "ARBITRATION_SKIPPED_INSUFFICIENT_CASH"
    ),
    true
  );
});

test("option lanes share options buying power without blocking unrelated equity", () => {
  const result = run([
    proposal("zero-dte-first", {
      lane: "options_0dte",
      strategyPriority: 0,
      symbol: "SPY260729C00600000",
      underlyingSymbol: "SPY",
      contractId: "SPY260729C00600000",
      assetClass: "option",
      requestedQuantity: 2,
      requestedNotional: 200,
      resourceRequirement: 200,
      unitResource: 100,
      resizeMode: "whole_contracts",
      score: 95
    }),
    proposal("leaps-second", {
      lane: "options_leaps",
      strategyPriority: 1,
      symbol: "QQQ270115C00500000",
      underlyingSymbol: "QQQ",
      contractId: "QQQ270115C00500000",
      assetClass: "option",
      requestedQuantity: 1,
      requestedNotional: 100,
      resourceRequirement: 100,
      unitResource: 100,
      resizeMode: "whole_contracts",
      score: 90
    }),
    proposal("equity-unrelated", {
      strategyPriority: 2,
      symbol: "AAPL",
      underlyingSymbol: "AAPL",
      requestedNotional: 100,
      resourceRequirement: 100,
      score: 85
    })
  ], context({
    buyingPowerAvailable: 500,
    optionsBuyingPowerAvailable: 250,
    cashAvailable: 500,
    portfolioCapacityAvailable: 500
  }));

  const byId = new Map(
    result.decisions.map((decision) => [decision.proposalId, decision])
  );
  assert.equal(byId.get("zero-dte-first")?.action, "approve");
  assert.equal(byId.get("leaps-second")?.action, "skip");
  assert.equal(
    byId.get("leaps-second")?.reasonCodes.includes(
      "ARBITRATION_SKIPPED_INSUFFICIENT_BUYING_POWER"
    ),
    true
  );
  assert.equal(byId.get("equity-unrelated")?.action, "approve");
});

test("duplicate and opposing proposals affect only the competing exposure", () => {
  const result = run([
    proposal("aapl-long-high", {
      symbol: "AAPL",
      underlyingSymbol: "AAPL",
      score: 95
    }),
    proposal("aapl-long-low", {
      symbol: "AAPL",
      underlyingSymbol: "AAPL",
      score: 90
    }),
    proposal("aapl-short", {
      symbol: "AAPL",
      underlyingSymbol: "AAPL",
      direction: "short",
      requestedQuantity: 1,
      requestedNotional: 100,
      resourceRequirement: 100,
      unitResource: 100,
      resizeMode: "whole_shares",
      score: 85
    }),
    proposal("msft-unrelated", {
      symbol: "MSFT",
      underlyingSymbol: "MSFT",
      score: 80
    })
  ]);

  const byId = new Map(
    result.decisions.map((decision) => [decision.proposalId, decision])
  );
  assert.equal(byId.get("aapl-long-high")?.action, "approve");
  assert.deepEqual(
    byId.get("aapl-long-low")?.reasonCodes,
    ["ARBITRATION_SKIPPED_DUPLICATE_PROPOSAL"]
  );
  assert.deepEqual(
    byId.get("aapl-short")?.reasonCodes,
    ["ARBITRATION_SKIPPED_OPPOSING_PROPOSAL"]
  );
  assert.equal(byId.get("msft-unrelated")?.action, "approve");
});

test("configured underlying exposure limits span equity and options without blocking unrelated symbols", () => {
  const result = run([
    proposal("aapl-equity", {
      symbol: "AAPL",
      underlyingSymbol: "AAPL",
      requestedNotional: 200,
      resourceRequirement: 200,
      score: 90
    }),
    proposal("aapl-option", {
      lane: "options_leaps",
      strategyPriority: 1,
      symbol: "AAPL270115C00200000",
      underlyingSymbol: "AAPL",
      contractId: "AAPL270115C00200000",
      assetClass: "option",
      requestedQuantity: 1,
      requestedNotional: 100,
      resourceRequirement: 100,
      unitResource: 100,
      resizeMode: "whole_contracts",
      score: 85
    }),
    proposal("msft-equity", {
      symbol: "MSFT",
      underlyingSymbol: "MSFT",
      requestedNotional: 100,
      resourceRequirement: 100,
      score: 80
    })
  ], context({ maxUnderlyingExposure: 250 }));

  const byId = new Map(
    result.decisions.map((decision) => [decision.proposalId, decision])
  );
  assert.equal(byId.get("aapl-equity")?.action, "approve");
  assert.equal(byId.get("aapl-option")?.action, "skip");
  assert.equal(
    byId.get("aapl-option")?.reasonCodes.includes(
      "ARBITRATION_SKIPPED_UNDERLYING_EXPOSURE"
    ),
    true
  );
  assert.equal(byId.get("msft-equity")?.action, "approve");
});

test("unknown existing exposure stays unknown and affects only its configured underlying", () => {
  const result = run([
    proposal("aapl-equity", {
      symbol: "AAPL",
      underlyingSymbol: "AAPL"
    }),
    proposal("msft-equity", {
      symbol: "MSFT",
      underlyingSymbol: "MSFT"
    })
  ], context({
    maxUnderlyingExposure: 1_000,
    existingPositions: [{
      id: "aapl-option-position",
      symbol: "AAPL270115C00200000",
      underlyingSymbol: "AAPL",
      direction: "long",
      resourceExposure: null
    }]
  }));

  const byId = new Map(
    result.decisions.map((decision) => [decision.proposalId, decision])
  );
  assert.equal(byId.get("aapl-equity")?.action, "skip");
  assert.deepEqual(byId.get("aapl-equity")?.reasonCodes, [
    "ARBITRATION_SKIPPED_RESOURCE_REQUIREMENT_UNAVAILABLE"
  ]);
  assert.equal(byId.get("msft-equity")?.action, "approve");
});

test("existing positions and active orders conflict while terminal orders do not", () => {
  const result = run([
    proposal("aapl-proposal", {
      symbol: "AAPL",
      underlyingSymbol: "AAPL"
    }),
    proposal("spy-option-proposal", {
      lane: "options_0dte",
      symbol: "SPY260729C00600000",
      underlyingSymbol: "SPY",
      contractId: "option-contract-SPY260729C00600000",
      assetClass: "option",
      requestedQuantity: 1,
      requestedNotional: 100,
      resourceRequirement: 100,
      unitResource: 100,
      resizeMode: "whole_contracts"
    }),
    proposal("qqq-proposal", {
      symbol: "QQQ",
      underlyingSymbol: "QQQ"
    })
  ], context({
    existingPositions: [{
      id: "position-aapl",
      symbol: "AAPL",
      underlyingSymbol: "AAPL",
      direction: "long",
      resourceExposure: 500
    }],
    openOrders: [
      {
        id: "order-spy",
        symbol: "SPY260729C00600000",
        underlyingSymbol: "SPY",
        direction: "long",
        status: "accepted",
        resourceExposure: 100
      },
      {
        id: "order-qqq-terminal",
        symbol: "QQQ",
        underlyingSymbol: "QQQ",
        direction: "long",
        status: "filled",
        resourceExposure: 100
      }
    ]
  }));

  const byId = new Map(
    result.decisions.map((decision) => [decision.proposalId, decision])
  );
  assert.equal(byId.get("aapl-proposal")?.action, "skip");
  assert.equal(
    byId.get("aapl-proposal")?.reasonCodes.includes(
      "ARBITRATION_SKIPPED_SYMBOL_EXPOSURE"
    ),
    true
  );
  assert.equal(
    byId.get("aapl-proposal")?.conflictTypes.includes(
      "DUPLICATE_EXISTING_POSITION"
    ),
    true
  );
  assert.equal(byId.get("spy-option-proposal")?.action, "skip");
  assert.equal(
    byId.get("spy-option-proposal")?.conflictTypes.includes(
      "DUPLICATE_EXISTING_OPEN_ORDER"
    ),
    true
  );
  assert.deepEqual(
    byId.get("spy-option-proposal")?.relatedOpenOrderIds,
    ["order-spy"]
  );
  assert.equal(byId.get("qqq-proposal")?.action, "approve");
});

test("lane ceilings and unavailable resource calculations remain proposal-scoped", () => {
  const result = run([
    proposal("equity-resized", {
      requestedNotional: 150,
      resourceRequirement: 150
    }),
    proposal("zero-dte-approved", {
      lane: "options_0dte",
      strategyPriority: 1,
      symbol: "SPY260729C00600000",
      underlyingSymbol: "SPY",
      contractId: "SPY260729C00600000",
      assetClass: "option",
      requestedQuantity: 1,
      requestedNotional: 100,
      resourceRequirement: 100,
      unitResource: 100,
      resizeMode: "whole_contracts"
    }),
    proposal("leaps-unknown", {
      lane: "options_leaps",
      strategyPriority: 2,
      symbol: "QQQ270115C00500000",
      underlyingSymbol: "QQQ",
      contractId: "QQQ270115C00500000",
      assetClass: "option",
      requestedQuantity: null,
      requestedNotional: null,
      resourceRequirement: null,
      unitResource: null,
      resizeMode: "whole_contracts"
    })
  ], context({
    laneCapacityAvailable: {
      equity: 100,
      options_0dte: 200,
      options_leaps: 200
    }
  }));

  const byId = new Map(
    result.decisions.map((decision) => [decision.proposalId, decision])
  );
  assert.equal(byId.get("equity-resized")?.action, "resize");
  assert.equal(byId.get("equity-resized")?.approvedNotional, 100);
  assert.equal(byId.get("zero-dte-approved")?.action, "approve");
  assert.deepEqual(
    byId.get("leaps-unknown")?.reasonCodes,
    ["ARBITRATION_SKIPPED_RESOURCE_REQUIREMENT_UNAVAILABLE"]
  );
});

test("arbitration is pure and has no broker submission dependency", async () => {
  const source = await readFile(
    new URL("../src/services/portfolioResourceArbitrator.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /alpacaClient|submitOrder|cancelOrder|replaceOrder/);
  assert.doesNotMatch(source, /client_order_id|time_in_force|order_type/);
});
