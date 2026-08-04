import assert from "node:assert/strict";
import test from "node:test";

import { readPostgresDashboardRisk } from "../src/services/postgresDashboardRiskService.js";

test("projects paid OPRA portfolio Greeks and open LEAPS reviews without internal evidence", async () => {
  const sql: string[] = [];
  const result = await readPostgresDashboardRisk({
    query: {
      query: async (statement, values) => {
        sql.push(statement);
        if (statement.includes("FROM accounts account")) {
          return {
            rows: [{
              account_id: "account-paper",
              account_snapshot_id: "snapshot-paper",
              observed_at: "2026-08-04T14:00:00.000Z",
              equity: "100000",
              portfolio_value: "100000",
              snapshot_fingerprint: "portfolio-fingerprint",
              account_record_status: "ACTIVE",
              account_status: "ACTIVE",
              account_source: "alpaca"
            }],
            rowCount: 1
          };
        }
        if (statement.includes("FROM positions position")) {
          assert.deepEqual(values, ["account-paper"]);
          return {
            rows: [{
              position_id: "position-leaps",
              symbol: "SPY",
              underlying_symbol: "SPY",
              option_symbol: "SPY280121C00550000",
              side: "long",
              quantity: "1",
              market_value: "1200",
              expiration_date: "2028-01-21",
              multiplier: "100",
              option_type: "call",
              last_reconciled_at: "2026-08-04T14:00:00.000Z",
              option_observed_at: "2026-08-04T14:00:00.000Z",
              quote_timestamp: "2026-08-04T14:00:00.000Z",
              requested_feed: "opra",
              effective_feed: "opra",
              option_source: "alpaca",
              option_underlying_price: "500",
              implied_volatility: "0.35",
              delta: "0.60",
              gamma: "0.004",
              theta: "-0.08",
              vega: "1.80",
              rho: "0.90"
            }],
            rowCount: 1
          };
        }
        if (statement.includes("FROM position_review_signals signal")) {
          assert.deepEqual(values, ["account-paper", 25]);
          return {
            rows: [{
              signal_id: "position-review-signal-1",
              position_id: "position-leaps",
              option_symbol: "SPY280121C00550000",
              action: "review",
              suggested_quantity: null,
              reasons: ["LEAPS_DELTA_DETERIORATION"],
              first_observed_at: "2026-08-04T13:30:00.000Z",
              last_observed_at: "2026-08-04T14:00:00.000Z",
              occurrences: "2",
              total_open_count: "31",
              evidence: {
                marketTimestamp: "2026-08-04T14:00:00.000Z",
                directionalReturnPct: -20,
                currentDte: 535,
                observedPrice: 12,
                delta: 0.4,
                gamma: 0.004,
                theta: -0.08,
                vega: 1.8,
                rho: 0.9,
                scheduler: { ownerId: "must-not-render", fencingToken: "99" },
                rawHeaders: { authorization: "Bearer must-not-render" },
                password: "must-not-render"
              }
            }],
            rowCount: 1
          };
        }
        throw new Error(`UNEXPECTED_DASHBOARD_RISK_SQL:${statement.slice(0, 80)}`);
      }
    },
    now: new Date("2026-08-04T14:00:00.000Z"),
    limit: Number.NaN
  });

  assert.equal(result.effectiveStatus, "monitoring");
  assert.equal(result.paperOnly, true);
  assert.equal(result.liveTradingEnabled, false);
  assert.equal(result.brokerMutationPerformed, false);
  assert.equal(result.portfolioGreeks.quality, "complete");
  assert.equal(result.portfolioGreeks.totals.deltaShares, 60);
  assert.equal(result.portfolioGreeks.totals.deltaDollars, 30_000);
  assert.equal(result.portfolioGreeks.totals.thetaDollarsPerDay, -8);
  assert.equal(result.portfolioGreeks.byLane.options_leaps?.quality, "complete");
  assert.equal(result.openLeapsReviewCount, 31);
  assert.equal(result.returnedLeapsReviewCount, 1);
  assert.equal(result.openLeapsReviewTruncated, true);
  assert.deepEqual(result.openLeapsReviewSignals, [{
    signalId: "position-review-signal-1",
    positionId: "position-leaps",
    optionSymbol: "SPY280121C00550000",
    action: "review",
    suggestedQuantity: null,
    reasons: ["LEAPS_DELTA_DETERIORATION"],
    firstObservedAt: "2026-08-04T13:30:00.000Z",
    lastObservedAt: "2026-08-04T14:00:00.000Z",
    occurrences: 2,
    marketTimestamp: "2026-08-04T14:00:00.000Z",
    directionalReturnPct: -20,
    currentDte: 535,
    observedPrice: 12,
    greeks: {
      delta: 0.4,
      gamma: 0.004,
      theta: -0.08,
      vega: 1.8,
      rho: 0.9
    }
  }]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /must-not-render|scheduler|fencingToken|rawHeaders|authorization|password/i
  );
  const signalSql = sql.find((statement) =>
    statement.includes("FROM position_review_signals signal")
  ) ?? "";
  assert.match(signalSql, /signal\.status = 'open'/);
  assert.match(signalSql, /signal\.account_id = \$1/);
  assert.match(signalSql, /COUNT\(\*\) OVER\(\)/);
  assert.match(signalSql, /ORDER BY signal\.last_observed_at DESC, signal\.id/);
  assert.match(signalSql, /LIMIT \$2/);
});

test("incomplete portfolio authority stays blocked while retaining open review evidence", async () => {
  const result = await readPostgresDashboardRisk({
    query: {
      query: async (statement) => {
        if (statement.includes("FROM accounts account")) {
          return {
            rows: [{
              account_id: "account-paper",
              account_snapshot_id: "snapshot-stale",
              observed_at: "2026-08-04T12:00:00.000Z",
              equity: "100000",
              portfolio_value: "100000",
              snapshot_fingerprint: "portfolio-fingerprint",
              account_record_status: "ACTIVE",
              account_status: "ACTIVE",
              account_source: "alpaca"
            }],
            rowCount: 1
          };
        }
        if (statement.includes("FROM positions position")) {
          return { rows: [], rowCount: 0 };
        }
        if (statement.includes("FROM position_review_signals signal")) {
          return {
            rows: [{
              signal_id: "position-review-signal-stale",
              position_id: "position-leaps",
              option_symbol: "SPY280121C00550000",
              action: "review",
              suggested_quantity: null,
              reasons: ["LEAPS_DELTA_DETERIORATION"],
              first_observed_at: "2026-08-04T13:30:00.000Z",
              last_observed_at: "2026-08-04T14:00:00.000Z",
              occurrences: "1",
              total_open_count: "1",
              evidence: {}
            }],
            rowCount: 1
          };
        }
        throw new Error("UNEXPECTED_DASHBOARD_RISK_SQL");
      }
    },
    now: new Date("2026-08-04T14:00:00.000Z")
  });

  assert.equal(result.portfolioGreeks.quality, "incomplete");
  assert.equal(result.effectiveStatus, "blocked");
  assert.equal(result.decision, "review_required");
  assert.equal(result.openLeapsReviewCount, 1);
  assert.equal(result.openLeapsReviewSignals[0]?.signalId, "position-review-signal-stale");
});
