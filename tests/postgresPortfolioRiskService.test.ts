import assert from "node:assert/strict";
import test from "node:test";

import {
  isPostgresPortfolioGreekReviewCommand,
  runPostgresPortfolioGreekReview
} from "../src/services/postgresPortfolioRiskService.js";

const account = {
  account_id: "account-paper",
  account_snapshot_id: "snapshot-paper",
  observed_at: "2026-08-04T15:00:00.000Z",
  equity: "100000",
  portfolio_value: "100000",
  snapshot_fingerprint: "snapshot-fingerprint",
  account_record_status: "ACTIVE",
  account_status: "ACTIVE",
  account_source: "alpaca"
};

const optionPosition = (overrides: Record<string, unknown> = {}) => ({
  position_id: "position-leaps",
  symbol: "SPY271217C00800000",
  underlying_symbol: "SPY",
  option_symbol: "SPY271217C00800000",
  side: "long",
  quantity: "2",
  market_value: "10000",
  expiration_date: "2027-12-17",
  multiplier: "100",
  option_type: "call",
  last_reconciled_at: "2026-08-04T15:03:58.000Z",
  option_observed_at: "2026-08-04T15:04:00.000Z",
  quote_timestamp: "2026-08-04T15:03:59.000Z",
  requested_feed: "opra",
  effective_feed: "opra",
  option_source: "alpaca",
  option_underlying_price: "500",
  stock_underlying_price: null,
  stock_observed_at: null,
  stock_source_timestamp: null,
  stock_requested_feed: null,
  stock_effective_feed: null,
  stock_source: null,
  stock_snapshot_id: null,
  implied_volatility: "0.25",
  delta: "0.6",
  gamma: "0.02",
  theta: "-0.1",
  vega: "0.2",
  rho: "0.1",
  ...overrides
});

const queryFor = (
  positions: Record<string, unknown>[],
  accountOverrides: Record<string, unknown> = {}
) => ({
  query: async (statement: string) => {
    if (statement.includes("FROM account_snapshots")) {
      return { rows: [{ ...account, ...accountOverrides }], rowCount: 1 };
    }
    if (statement.includes("FROM positions position")) {
      return { rows: positions, rowCount: positions.length };
    }
    throw new Error(`UNEXPECTED_QUERY:${statement}`);
  }
});

test("routes only portfolio and hedge review commands to PostgreSQL Greek aggregation", () => {
  assert.equal(isPostgresPortfolioGreekReviewCommand("paper:portfolio:review"), true);
  assert.equal(isPostgresPortfolioGreekReviewCommand("hedge:review"), true);
  assert.equal(isPostgresPortfolioGreekReviewCommand("paper:review"), false);
  assert.equal(isPostgresPortfolioGreekReviewCommand("hedge:exit:review"), false);
});

test("aggregates current paid OPRA Greeks across a managed LEAPS position", async () => {
  const result = await runPostgresPortfolioGreekReview({
    command: "hedge:review",
    cycleId: "cycle-greeks",
    now: new Date("2026-08-04T15:04:11.000Z"),
    query: queryFor([optionPosition()])
  });

  assert.equal(result.status, "completed");
  assert.equal(result.paperOnly, true);
  assert.equal(result.brokerMutationPerformed, false);
  assert.equal(result.portfolioGreeks.quality, "complete");
  assert.deepEqual(result.portfolioGreeks.totals, {
    deltaShares: 120,
    deltaDollars: 60_000,
    gammaSharesPerDollar: 4,
    thetaDollarsPerDay: -20,
    vegaDollarsPerVolPoint: 40,
    rhoDollarsPerRatePoint: 20,
    weightedImpliedVolatility: 0.25
  });
  assert.deepEqual(result.portfolioGreeks.coverage.contracts, {
    total: 2,
    deltaShares: 2,
    deltaDollars: 2,
    gamma: 2,
    theta: 2,
    vega: 2,
    rho: 2,
    impliedVolatility: 2
  });
  assert.deepEqual(result.portfolioGreeks.coverage.marketValue, {
    total: 10_000,
    deltaShares: 10_000,
    deltaDollars: 10_000,
    gamma: 10_000,
    theta: 10_000,
    vega: 10_000,
    rho: 10_000,
    impliedVolatility: 10_000
  });
  assert.equal(result.portfolioGreeks.byLane.options_leaps.quality, "complete");
  assert.equal(result.workstreamResults[0]?.lane, "options_leaps");
  assert.deepEqual(
    result.workstreamResults[0]?.portfolio_greeks,
    result.portfolioGreeks.byLane.options_leaps
  );
  assert.ok(result.workstreamResults[0]?.evidence_references.includes(
    "postgres:option_snapshot:SPY271217C00800000:2026-08-04T15:04:00.000Z"
  ));
});

test("uses signed quantities for short option Greek exposure", async () => {
  const result = await runPostgresPortfolioGreekReview({
    command: "paper:portfolio:review",
    cycleId: "cycle-short-greeks",
    now: new Date("2026-08-04T15:04:11.000Z"),
    query: queryFor([optionPosition({ side: "short", quantity: "3" })])
  });

  assert.equal(result.portfolioGreeks.totals.deltaShares, -180);
  assert.equal(result.portfolioGreeks.totals.deltaDollars, -90_000);
  assert.equal(result.portfolioGreeks.totals.thetaDollarsPerDay, 30);
});

test("missing paid Greeks stay null and make portfolio risk incomplete", async () => {
  const result = await runPostgresPortfolioGreekReview({
    command: "hedge:review",
    cycleId: "cycle-missing-greeks",
    now: new Date("2026-08-04T15:04:11.000Z"),
    query: queryFor([optionPosition({ gamma: null })])
  });

  assert.equal(result.portfolioGreeks.quality, "incomplete");
  assert.equal(result.portfolioGreeks.totals.gammaSharesPerDollar, null);
  assert.equal(result.portfolioGreeks.totals.deltaShares, 120);
  assert.equal(result.portfolioGreeks.coverage.contracts.gamma, 0);
  assert.equal(result.portfolioGreeks.coverage.marketValue.gamma, 0);
  assert.ok(result.portfolioGreeks.blockers.includes("PORTFOLIO_GREEKS_INCOMPLETE"));
});

test("stale position reconciliation fails closed even with current OPRA Greeks", async () => {
  const result = await runPostgresPortfolioGreekReview({
    command: "hedge:review",
    cycleId: "cycle-stale-position",
    now: new Date("2026-08-04T15:04:11.000Z"),
    query: queryFor([optionPosition({
      last_reconciled_at: "2026-08-04T14:00:00.000Z"
    })])
  });

  assert.equal(result.portfolioGreeks.quality, "incomplete");
  assert.equal(result.portfolioGreeks.totals.deltaShares, null);
  assert.ok(result.portfolioGreeks.blockers.includes("PORTFOLIO_POSITION_EVIDENCE_STALE"));
});

test("stale account evidence nulls aggregate exposure and coverage", async () => {
  const result = await runPostgresPortfolioGreekReview({
    command: "paper:portfolio:review",
    cycleId: "cycle-stale-account",
    now: new Date("2026-08-04T15:40:00.000Z"),
    query: queryFor([optionPosition({
      last_reconciled_at: "2026-08-04T15:39:59.000Z",
      option_observed_at: "2026-08-04T15:39:59.000Z",
      quote_timestamp: "2026-08-04T15:39:59.000Z"
    })], {
      observed_at: "2026-08-04T15:00:00.000Z"
    })
  });

  assert.equal(result.portfolioGreeks.quality, "incomplete");
  assert.equal(result.portfolioGreeks.totals.deltaShares, null);
  assert.equal(result.portfolioGreeks.coverage.contracts.deltaShares, null);
  assert.ok(result.portfolioGreeks.blockers.includes("PORTFOLIO_ACCOUNT_EVIDENCE_STALE"));
});

test("stale Greek observations cannot contribute numeric portfolio exposure", async () => {
  const result = await runPostgresPortfolioGreekReview({
    command: "hedge:review",
    cycleId: "cycle-stale-greeks",
    now: new Date("2026-08-04T16:00:00.000Z"),
    query: queryFor([optionPosition()])
  });

  assert.equal(result.portfolioGreeks.quality, "incomplete");
  assert.deepEqual(result.portfolioGreeks.totals, {
    deltaShares: null,
    deltaDollars: null,
    gammaSharesPerDollar: null,
    thetaDollarsPerDay: null,
    vegaDollarsPerVolPoint: null,
    rhoDollarsPerRatePoint: null,
    weightedImpliedVolatility: null
  });
  assert.ok(result.portfolioGreeks.blockers.includes("PORTFOLIO_GREEK_EVIDENCE_STALE"));
});

test("same-day positions are isolated in the 0DTE portfolio Greek lane", async () => {
  const optionSymbol = "SPY260804C00770000";
  const result = await runPostgresPortfolioGreekReview({
    command: "paper:portfolio:review",
    cycleId: "cycle-zero-dte-greeks",
    now: new Date("2026-08-04T15:04:11.000Z"),
    query: queryFor([optionPosition({
      position_id: "position-zero-dte",
      symbol: optionSymbol,
      option_symbol: optionSymbol,
      expiration_date: "2026-08-04"
    })])
  });

  assert.equal(result.portfolioGreeks.byLane.options_0dte.positionCount, 1);
  assert.equal(result.workstreamResults[0]?.lane, "options_0dte");
});

test("an unvalidated feed cannot contribute paid Greek exposure", async () => {
  const result = await runPostgresPortfolioGreekReview({
    command: "hedge:review",
    cycleId: "cycle-invalid-feed",
    now: new Date("2026-08-04T15:04:11.000Z"),
    query: queryFor([optionPosition({ effective_feed: "indicative" })])
  });

  assert.equal(result.portfolioGreeks.totals.deltaShares, null);
  assert.equal(result.portfolioGreeks.coverage.contracts.deltaShares, 0);
  assert.ok(result.portfolioGreeks.blockers.includes("PORTFOLIO_OPRA_FEED_INVALID"));
});

test("an open option position without contract authority remains visible and fails closed", async () => {
  const result = await runPostgresPortfolioGreekReview({
    command: "hedge:review",
    cycleId: "cycle-missing-contract",
    now: new Date("2026-08-04T15:04:11.000Z"),
    query: queryFor([optionPosition({
      expiration_date: null,
      multiplier: null,
      option_type: null
    })])
  });

  assert.equal(result.portfolioGreeks.positionCount, 1);
  assert.equal(result.portfolioGreeks.quality, "incomplete");
  assert.equal(result.portfolioGreeks.totals.deltaShares, null);
  assert.ok(result.portfolioGreeks.blockers.includes("PORTFOLIO_OPTION_CONTRACT_MISSING"));
});

test("an invalid persisted option side cannot become positive exposure", async () => {
  const result = await runPostgresPortfolioGreekReview({
    command: "paper:portfolio:review",
    cycleId: "cycle-invalid-side",
    now: new Date("2026-08-04T15:04:11.000Z"),
    query: queryFor([optionPosition({ side: "unknown" })])
  });

  assert.equal(result.portfolioGreeks.totals.deltaShares, null);
  assert.equal(result.portfolioGreeks.coverage.contracts.deltaShares, 0);
  assert.equal(result.portfolioGreeks.coverage.contracts.gamma, 0);
  assert.ok(result.portfolioGreeks.blockers.includes("PORTFOLIO_POSITION_SIDE_INVALID"));
});

test("a current Alpaca SIP fallback supports delta-dollar exposure with provenance", async () => {
  const result = await runPostgresPortfolioGreekReview({
    command: "paper:portfolio:review",
    cycleId: "cycle-sip-fallback",
    now: new Date("2026-08-04T15:04:11.000Z"),
    query: queryFor([optionPosition({
      option_underlying_price: null,
      stock_underlying_price: "500",
      stock_observed_at: "2026-08-04T15:04:00.000Z",
      stock_source_timestamp: "2026-08-04T15:03:59.000Z",
      stock_requested_feed: "sip",
      stock_effective_feed: "sip",
      stock_source: "alpaca",
      stock_snapshot_id: "stock-SPY-current"
    })])
  });

  assert.equal(result.portfolioGreeks.totals.deltaDollars, 60_000);
  assert.ok(result.portfolioGreeks.evidenceReferences.includes(
    "postgres:stock_snapshot:stock-SPY-current:2026-08-04T15:04:00.000Z"
  ));
});

test("a stale SIP fallback cannot support delta-dollar exposure", async () => {
  const result = await runPostgresPortfolioGreekReview({
    command: "paper:portfolio:review",
    cycleId: "cycle-stale-sip-fallback",
    now: new Date("2026-08-04T15:40:00.000Z"),
    query: queryFor([optionPosition({
      option_underlying_price: null,
      stock_underlying_price: "500",
      stock_observed_at: "2026-08-04T15:39:59.000Z",
      stock_source_timestamp: "2026-08-04T15:00:00.000Z",
      stock_requested_feed: "sip",
      stock_effective_feed: "sip",
      stock_source: "alpaca",
      stock_snapshot_id: "stock-SPY-stale",
      last_reconciled_at: "2026-08-04T15:39:59.000Z",
      option_observed_at: "2026-08-04T15:39:59.000Z",
      quote_timestamp: "2026-08-04T15:39:59.000Z"
    })], {
      observed_at: "2026-08-04T15:39:59.000Z"
    })
  });

  assert.equal(result.portfolioGreeks.totals.deltaShares, 120);
  assert.equal(result.portfolioGreeks.totals.deltaDollars, null);
  assert.equal(result.portfolioGreeks.coverage.contracts.deltaDollars, 0);
  assert.ok(result.portfolioGreeks.blockers.includes(
    "PORTFOLIO_UNDERLYING_PRICE_EVIDENCE_INVALID"
  ));
});

test("no open option positions returns a bounded read-only observation", async () => {
  const result = await runPostgresPortfolioGreekReview({
    command: "paper:portfolio:review",
    cycleId: "cycle-no-options",
    now: new Date("2026-08-04T15:04:11.000Z"),
    query: queryFor([])
  });

  assert.equal(result.status, "completed");
  assert.equal(result.portfolioGreeks.quality, "not_applicable");
  assert.equal(result.portfolioGreeks.positionCount, 0);
  assert.deepEqual(result.workstreamResults, []);
});

test("stale account blockers remain visible when no option position is open", async () => {
  const result = await runPostgresPortfolioGreekReview({
    command: "paper:portfolio:review",
    cycleId: "cycle-no-options-stale-account",
    now: new Date("2026-08-04T16:00:00.000Z"),
    query: queryFor([])
  });

  assert.equal(result.portfolioGreeks.quality, "incomplete");
  assert.ok(result.portfolioGreeks.blockers.includes("PORTFOLIO_ACCOUNT_EVIDENCE_STALE"));
});

test("portfolio review rejects an invalid evaluation clock before PostgreSQL access", async () => {
  let queried = false;
  await assert.rejects(runPostgresPortfolioGreekReview({
    command: "hedge:review",
    cycleId: "cycle-invalid-clock",
    now: new Date("invalid"),
    query: {
      query: async () => {
        queried = true;
        return { rows: [], rowCount: 0 };
      }
    }
  }), /POSTGRES_PORTFOLIO_RISK_TIME_INVALID/);
  assert.equal(queried, false);
});

test("portfolio review fails closed when paper account authority is unavailable", async () => {
  await assert.rejects(runPostgresPortfolioGreekReview({
    command: "paper:portfolio:review",
    cycleId: "cycle-missing-account",
    now: new Date("2026-08-04T15:04:11.000Z"),
    query: {
      query: async () => ({ rows: [], rowCount: 0 })
    }
  }), /POSTGRES_PORTFOLIO_ACCOUNT_UNAVAILABLE/);
});
