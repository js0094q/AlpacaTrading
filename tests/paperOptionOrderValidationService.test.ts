import assert from "node:assert/strict";
import test from "node:test";

import { validatePaperHedgeOptionOrder } from "../src/services/paperOptionOrderValidationService.js";

const validInput = () => ({
  environment: "paper" as const,
  liveTradingEnabled: false,
  optionsExecutionEnabled: true,
  symbol: "SPY260918P00500000",
  underlying: "SPY",
  quantity: 1,
  limitPrice: 5,
  bid: 4.9,
  ask: 5.1,
  delta: -0.32,
  dte: 67,
  quoteTimestamp: "2026-07-13T13:59:45.000Z",
  asOf: "2026-07-13T14:00:00.000Z",
  maxQuoteAgeSeconds: 60,
  maxSpreadPct: 0.2,
  maxQuantity: 2,
  maxPremium: 500,
  maxPortfolioAllocation: 0.02,
  portfolioEquity: 100_000,
  buyingPower: 10_000,
  optionApprovalLevel: 3,
  structure: "long_put" as const
});

test("accepts a fresh bounded paper long put", () => {
  const result = validatePaperHedgeOptionOrder(validInput());
  assert.equal(result.valid, true);
  assert.deepEqual(result.blockers, []);
});

test("fails closed for stale, wide, over-cap, unsupported, and live inputs", () => {
  const cases = [
    ["HEDGE_QUOTE_STALE", { quoteTimestamp: "2026-07-13T13:50:00.000Z" }],
    ["HEDGE_SPREAD_TOO_WIDE", { bid: 3, ask: 7 }],
    ["HEDGE_QUANTITY_CAP_EXCEEDED", { quantity: 3 }],
    ["HEDGE_PREMIUM_CAP_EXCEEDED", { limitPrice: 6 }],
    ["HEDGE_ENVIRONMENT_NOT_PAPER", { environment: "live" }],
    ["HEDGE_LIVE_TRADING_ENABLED", { liveTradingEnabled: true }],
    ["MULTI_LEG_EXECUTION_UNSUPPORTED", { structure: "put_spread" }],
    ["HEDGE_OPTIONS_EXECUTION_DISABLED", { optionsExecutionEnabled: false }]
  ] as const;

  for (const [blocker, overrides] of cases) {
    const result = validatePaperHedgeOptionOrder({ ...validInput(), ...overrides } as never);
    assert.equal(result.valid, false, blocker);
    assert.ok(result.blockers.includes(blocker), blocker);
  }
});
