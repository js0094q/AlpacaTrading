import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDashboardBridgeSummary } from "../apps/dashboard/lib/data.ts";

test("normalizes PostgreSQL bridge rows to the dashboard render contract", () => {
  const normalized = normalizeDashboardBridgeSummary({
    latestPaperPlans: [{
      symbol: "AMD",
      decision: "selected",
      direction: "long",
      preferred_expression: "shares",
      strategy_family: "equity"
    }],
    plan: {
      ok: true,
      label: "plan",
      data: {
        plan: [{
          symbol: "AMD",
          decision: "selected",
          direction: "long",
          preferred_expression: "shares",
          strategy_family: "equity"
        }]
      }
    },
    optionContracts: [{
      underlying_symbol: "AMD",
      option_symbol: "AMD260821C00200000",
      type: "call",
      expiration_date: "2026-08-21",
      strike: "200",
      tradable: true,
      bid: "2.00",
      ask: "2.20",
      midpoint: "2.10",
      last: "2.05",
      quote_timestamp: "2026-07-23T14:59:00.000Z",
      observed_at: "2026-07-23T14:59:00.000Z"
    }],
    hedge: {
      ok: true,
      label: "hedge",
      data: {
        paperOnly: true,
        environment: "paper",
        liveTradingEnabled: false,
        status: "blocked",
        blockers: ["NO_POSTGRES_HEDGE_STATE"]
      }
    }
  });

  const plan = normalized.plan.data.plan[0];
  assert.equal(plan.symbol, "AMD");
  assert.equal(plan.decision, "selected");
  assert.equal(plan.latestRank, 1);
  assert.equal(plan.strategy, "long / shares / equity");

  const option = normalized.optionContracts[0];
  assert.equal(option.underlying_symbol, "AMD");
  assert.equal(option.quoteStatus, "valid");
  assert.equal(option.displayCategory, "Quoted");
  assert.equal(option.executable, false);
  assert.equal(option.rejectionReason, null);

  const hedge = normalized.hedge.data;
  assert.equal(hedge.effectiveStatus, "blocked");
});

test("normalizes a PostgreSQL option row without quote evidence as unavailable", () => {
  const normalized = normalizeDashboardBridgeSummary({
    optionContracts: [{
      underlying_symbol: "AMD",
      option_symbol: "AMD260821C00200000",
      type: "call",
      expiration_date: "2026-08-21",
      strike: "200",
      tradable: true
    }]
  });

  const option = normalized.optionContracts[0];
  assert.equal(option.quoteStatus, "missing");
  assert.equal(option.displayCategory, "Discovered");
  assert.equal(option.executable, false);
  assert.equal(option.executablePrice, null);
});
