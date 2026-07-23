import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

process.env.TRADING_MODE = "paper";
process.env.ALPACA_ENV = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_OPTION_DATA_FEED = "opra";
const dbDir = mkdtempSync(join(tmpdir(), "option-decision-evidence-"));
process.env.RESEARCH_DB_PATH = join(dbDir, "research.db");

import { ingestOptionSnapshotsForSymbols, toSnapshotRow } from "../src/services/optionsService.js";
import {
  buildOptionDecisionSnapshot,
  formatOptionEvidenceValue
} from "../src/services/optionDecisionEvidenceService.js";
import { projectCandidateRow } from "../src/repositories/postgres/postgresCandidateRepository.js";
const { closeDbForTests, getDb } = await import("../src/lib/db.js");
const { buildFeatures } = await import("../src/services/featureService.js");
const { rankResearchCandidates } = await import("../src/services/candidateRankingService.js");
type DashboardOptionRow = {
  option_symbol: string;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  impliedVolatility: number | null;
  sourceFeed: string | null;
  greekAvailability: string;
  dataQualityStatus: string;
  decisionUse: {
    bid: { value: number | null; used: boolean; useType: string | null; reason: string | null };
    delta: { value: number | null; used: boolean; useType: string | null; reason: string | null };
  };
};
const loadLatestOptionContracts = async (limit: number) => {
  const dashboard = await import(
    pathToFileURL(`${process.cwd()}/apps/dashboard/lib/data.ts`).href
  ) as unknown as {
    normalizeDashboardBridgeSummary: (summary: {
      optionContracts: Array<Record<string, unknown>>;
    }) => {
      optionContracts?: unknown;
    };
  };
  const rows = getDb().prepare(
    `
    SELECT
      c.underlying_symbol,
      c.option_symbol,
      c.type,
      c.expiration_date,
      c.strike,
      c.multiplier,
      c.tradable,
      s.bid,
      s.ask,
      s.midpoint,
      s.last,
      s.quote_status,
      s.executable,
      s.executable_price,
      s.executable_price_source,
      s.rejection_reason,
      s.quote_timestamp,
      s.quote_age_ms,
      s.snapshot_timestamp,
      s.source,
      s.source_feed,
      s.normalization_path,
      s.days_to_expiration,
      s.volume,
      s.open_interest,
      s.implied_volatility,
      s.delta,
      s.gamma,
      s.theta,
      s.vega,
      s.rho,
      s.spread_percentage,
      s.timestamp
    FROM option_contracts c
    LEFT JOIN option_snapshots s
      ON s.option_symbol = c.option_symbol
      AND s.timestamp = (
        SELECT MAX(timestamp)
        FROM option_snapshots
        WHERE option_symbol = c.option_symbol
      )
    ORDER BY COALESCE(s.timestamp, c.expiration_date) DESC
    LIMIT ?
    `
  ).all(limit) as Array<Record<string, unknown>>;
  const normalized = dashboard.normalizeDashboardBridgeSummary({
    optionContracts: rows
  });
  return Array.isArray(normalized.optionContracts)
    ? normalized.optionContracts as DashboardOptionRow[]
    : [];
};

describe("option decision evidence", () => {
  test("retains provider Greeks and decision-time quote provenance", () => {
    const quoteTimestamp = new Date(Date.now() - 1_000).toISOString();
    const row = toSnapshotRow("SPY270115C00805000", {
      snapshotTimestamp: quoteTimestamp,
      latestQuote: {
        t: quoteTimestamp,
        bp: 16.4,
        ap: 16.52,
        bs: 5,
        as: 6
      },
      latestTrade: {
        t: quoteTimestamp,
        p: 16.48,
        s: 3
      },
      impliedVolatility: 0.1379,
      greeks: {
        delta: 0.3459,
        gamma: 0.0049,
        theta: -0.0986,
        vega: 2.0038,
        rho: 0.12
      },
      volume: 1234,
      openInterest: 5678
    });

    assert.deepEqual(
      {
        delta: row.delta,
        gamma: row.gamma,
        theta: row.theta,
        vega: row.vega,
        rho: row.rho,
        impliedVolatility: row.impliedVolatility
      },
      {
        delta: 0.3459,
        gamma: 0.0049,
        theta: -0.0986,
        vega: 2.0038,
        rho: 0.12,
        impliedVolatility: 0.1379
      }
    );
    assert.equal(row.sourceFeed, "opra");
    assert.equal(row.spreadPercentage, ((16.52 - 16.4) / ((16.4 + 16.52) / 2)) * 100);
    assert.equal(typeof row.quoteAgeMs, "number");
  });

  test("keeps complete snapshot values and records standard scorer usage", () => {
    const evidence = buildOptionDecisionSnapshot({
      contract: {
        optionSymbol: "SPY270115C00805000",
        underlyingSymbol: "SPY",
        type: "call",
        expirationDate: "2027-01-15",
        strike: 805,
        multiplier: 100
      },
      snapshot: {
        optionSymbol: "SPY270115C00805000",
        underlyingSymbol: "SPY",
        timestamp: "2026-07-18T14:00:00.000Z",
        bid: 16.4,
        ask: 16.52,
        midpoint: 16.46,
        last: 16.48,
        quoteStatus: "valid",
        executable: 1,
        executablePrice: 16.46,
        executablePriceSource: "midpoint",
        rejectionReason: null,
        quoteTimestamp: "2026-07-18T13:59:59.000Z",
        quoteAgeMs: 1_000,
        volume: 1234,
        openInterest: 5678,
        impliedVolatility: 0.1379,
        delta: 0.3459,
        gamma: 0.0049,
        theta: -0.0986,
        vega: 2.0038,
        rho: 0.12,
        snapshotTimestamp: "2026-07-18T13:59:59.000Z",
        normalizationPath: "current",
        source: "alpaca",
        sourceFeed: "opra",
        spreadPercentage: ((16.52 - 16.4) / 16.46) * 100
      },
      decisionTimestamp: "2026-07-18T14:00:00.000Z",
      underlyingPrice: 620,
      underlyingPriceSource: "stock_bar_close",
      derived: {
        liquidityScore: 0.82,
        ivPercentile: 0.61,
        candidateScore: 74.5
      },
      selectionBinding: "nearest_contract_feature_snapshot"
    });

    assert.equal(evidence.contractSymbol, "SPY270115C00805000");
    assert.equal(evidence.greeks.delta, 0.3459);
    assert.equal(evidence.greeks.gamma, 0.0049);
    assert.equal(evidence.greeks.theta, -0.0986);
    assert.equal(evidence.greeks.vega, 2.0038);
    assert.equal(evidence.greeks.rho, 0.12);
    assert.equal(evidence.derived.candidateScore, 74.5);
    assert.equal(evidence.availability.greeks, "available");
    assert.equal(evidence.strategyUse.delta, "not_used");
    assert.equal(evidence.strategyUse.impliedVolatility, "used");
    assert.equal(evidence.selectionBinding, "nearest_contract_feature_snapshot");
  });

  test("does not turn missing or stale Greeks into zeroes", () => {
    const missing = buildOptionDecisionSnapshot({
      contract: null,
      snapshot: null,
      decisionTimestamp: "2026-07-18T14:00:00.000Z"
    });
    assert.equal(missing.greeks.delta, null);
    assert.equal(missing.greeks.gamma, null);
    assert.equal(missing.availability.greeks, "provider_unavailable");
    assert.equal(formatOptionEvidenceValue(null, missing.availability.greeks), "Unavailable from provider");

    const stale = buildOptionDecisionSnapshot({
      contract: {
        optionSymbol: "SPY270115C00805000",
        underlyingSymbol: "SPY",
        type: "call",
        expirationDate: "2027-01-15",
        strike: 805,
        multiplier: 100
      },
      snapshot: {
        optionSymbol: "SPY270115C00805000",
        underlyingSymbol: "SPY",
        timestamp: "2026-07-18T14:00:00.000Z",
        bid: 16.4,
        ask: 16.52,
        midpoint: 16.46,
        last: 16.48,
        quoteStatus: "stale",
        executable: 0,
        executablePrice: null,
        executablePriceSource: null,
        rejectionReason: "quote_stale",
        quoteTimestamp: "2026-07-18T13:00:00.000Z",
        quoteAgeMs: 3_600_000,
        volume: 1234,
        openInterest: 5678,
        impliedVolatility: 0.1379,
        delta: 0.3459,
        gamma: 0.0049,
        theta: -0.0986,
        vega: 2.0038,
        rho: 0.12,
        snapshotTimestamp: "2026-07-18T13:00:00.000Z",
        normalizationPath: "current",
        source: "alpaca",
        sourceFeed: "opra",
        spreadPercentage: ((16.52 - 16.4) / 16.46) * 100
      },
      decisionTimestamp: "2026-07-18T14:00:00.000Z"
    });
    assert.equal(stale.availability.greeks, "stale");
    assert.equal(stale.decisionUse.delta.used, false);
    assert.equal(stale.decisionUse.delta.useType, null);
    assert.match(stale.decisionUse.delta.reason || "", /stale/i);
    assert.equal(formatOptionEvidenceValue(stale.greeks.delta, stale.availability.greeks), "Stale at decision");

    const invalid = buildOptionDecisionSnapshot({
      contract: {
        optionSymbol: "SPY270115C00805000",
        underlyingSymbol: "SPY",
        type: "call",
        expirationDate: "2027-01-15",
        strike: 805,
        multiplier: 100
      },
      snapshot: {
        optionSymbol: "SPY270115C00805000",
        underlyingSymbol: "SPY",
        timestamp: "2026-07-18T14:00:00.000Z",
        bid: 16.52,
        ask: 16.4,
        midpoint: null,
        last: null,
        quoteStatus: "invalid",
        executable: 0,
        executablePrice: null,
        executablePriceSource: null,
        rejectionReason: "crossed_quote",
        quoteTimestamp: "2026-07-18T14:00:00.000Z",
        quoteAgeMs: 0,
        volume: 1234,
        openInterest: 5678,
        impliedVolatility: 0.1379,
        delta: 0.3459,
        gamma: 0.0049,
        theta: -0.0986,
        vega: 2.0038,
        rho: 0.12,
        snapshotTimestamp: "2026-07-18T14:00:00.000Z",
        normalizationPath: "current",
        source: "alpaca",
        sourceFeed: "opra",
        spreadPercentage: null
      },
      decisionTimestamp: "2026-07-18T14:00:00.000Z"
    });
    assert.equal(invalid.decisionUse.bid.used, false);
    assert.match(invalid.decisionUse.bid.reason || "", /invalid/i);
  });

  test("adds provenance columns to the existing option snapshot authority", () => {
    const columns = getDb()
      .prepare("PRAGMA table_info(option_snapshots)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    assert.equal(names.has("research_run_id"), true);
    assert.equal(names.has("source_feed"), true);
    assert.equal(names.has("quote_age_ms"), true);
    assert.equal(names.has("spread_percentage"), true);
  });

  test("persists exact Greek values, feed, age, spread, and research linkage", async () => {
    const symbol = "SPY270115C00805000";
    const quoteTimestamp = new Date(Date.now() - 1_000).toISOString();
    const db = getDb();
    db.prepare("DELETE FROM option_snapshots WHERE option_symbol = ?").run(symbol);
    db.prepare("DELETE FROM option_contracts WHERE option_symbol = ?").run(symbol);
    db.prepare("DELETE FROM research_runs WHERE id = ?").run("greek-run");
    db.prepare(
      `
      INSERT INTO research_runs(
        id, started_at, status, risk_profile, options_enabled, universe_size,
        targets_generated, candidates_selected, config_json
      ) VALUES (?, ?, 'running', 'aggressive', 1, 1, 0, 0, '{}')
      `
    ).run("greek-run", quoteTimestamp);
    db.prepare(
      `
      INSERT INTO option_contracts(
        underlying_symbol, option_symbol, type, expiration_date, strike, multiplier, tradable, source
      ) VALUES (?, ?, 'call', ?, ?, ?, 1, 'alpaca')
      `
    ).run("SPY", symbol, "2027-01-15", 805, 100);

    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      const payload = url.includes("/snapshots")
        ? {
            snapshots: {
              [symbol]: {
                snapshotTimestamp: quoteTimestamp,
                latestQuote: { t: quoteTimestamp, bp: 16.4, ap: 16.52 },
                latestTrade: { t: quoteTimestamp, p: 16.48, s: 3 },
                impliedVolatility: 0.1379,
                greeks: { delta: 0.3459, gamma: 0.0049, theta: -0.0986, vega: 2.0038, rho: 0.12 },
                volume: 1234,
                openInterest: 5678
              }
            }
          }
        : { quotes: { [symbol]: { t: quoteTimestamp, b: 16.4, a: 16.52 } } };
      return {
        ok: true,
        status: 200,
        headers: { get: () => "fixture-request" },
        text: async () => JSON.stringify(payload)
      } as unknown as Response;
    };

    try {
      const result = await ingestOptionSnapshotsForSymbols([symbol], {
        researchRunId: "greek-run",
        correlationId: "greek-correlation"
      });
      assert.equal(result.rowsIngested, 1);
      const persisted = db
        .prepare(
          `
          SELECT delta, gamma, theta, vega, rho, source_feed, quote_age_ms,
                 spread_percentage, research_run_id
          FROM option_snapshots
          WHERE option_symbol = ?
          ORDER BY timestamp DESC
          LIMIT 1
          `
        )
        .get(symbol) as Record<string, number | string | null>;
      assert.equal(persisted.delta, 0.3459);
      assert.equal(persisted.gamma, 0.0049);
      assert.equal(persisted.theta, -0.0986);
      assert.equal(persisted.vega, 2.0038);
      assert.equal(persisted.rho, 0.12);
      assert.equal(persisted.source_feed, "opra");
      assert.equal(typeof persisted.quote_age_ms, "number");
      assert.equal(persisted.research_run_id, "greek-run");
      assert.equal(
        persisted.spread_percentage,
        ((16.52 - 16.4) / ((16.4 + 16.52) / 2)) * 100
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("passes the persisted Greek snapshot into feature evidence", async () => {
    const symbol = "SPY270115C00805000";
    const asOf = "2026-07-18T14:00:00.000Z";
    const db = getDb();
    db.exec(`
      DELETE FROM feature_snapshots;
      DELETE FROM market_bars;
      DELETE FROM option_snapshots;
      DELETE FROM option_contracts;
    `);
    db.prepare(
      `
      INSERT INTO market_bars(symbol, timeframe, timestamp, open, high, low, close, volume, source)
      VALUES ('SPY', '1Day', ?, 619, 622, 618, 620, 1000000, 'fixture')
      `
    ).run(asOf);
    db.prepare(
      `
      INSERT INTO option_contracts(
        underlying_symbol, option_symbol, type, expiration_date, strike, multiplier, tradable, source
      ) VALUES ('SPY', ?, 'call', '2027-01-15', 620, 100, 1, 'alpaca')
      `
    ).run(symbol);
    db.prepare(
      `
      INSERT INTO option_snapshots(
        option_symbol, underlying_symbol, timestamp, bid, ask, midpoint, last,
        quote_status, executable, executable_price, executable_price_source,
        quote_timestamp, volume, open_interest, implied_volatility,
        delta, gamma, theta, vega, rho, snapshot_timestamp, normalization_path,
        research_run_id, source_feed, quote_age_ms, spread_percentage, source
      ) VALUES (?, 'SPY', ?, 16.4, 16.52, 16.46, 16.48, 'valid', 1, 16.46,
        'midpoint', ?, 1234, 5678, 0.1379, 0.3459, 0.0049, -0.0986, 2.0038,
        0.12, ?, 'current', 'feature-run', 'opra', 1000, ?, 'alpaca')
      `
    ).run(symbol, asOf, asOf, asOf, ((16.52 - 16.4) / 16.46) * 100);

    await buildFeatures({ symbols: ["SPY"], timeframe: "1Day" });
    const stored = db
      .prepare("SELECT features FROM feature_snapshots WHERE symbol = 'SPY' LIMIT 1")
      .get() as { features: string };
    const features = JSON.parse(stored.features) as Record<string, any>;
    assert.equal(features.optionDecisionSnapshot.contractSymbol, symbol);
    assert.equal(features.optionDecisionSnapshot.greeks.delta, 0.3459);
    assert.equal(features.optionDecisionSnapshot.greeks.gamma, 0.0049);
    assert.equal(features.optionDecisionSnapshot.quoteTimestamp, asOf);
    assert.equal(features.optionDecisionSnapshot.derived.liquidityScore,
      features.preferredContractLiquidityScore);
  });

  test("carries the same option evidence into the candidate decision record", () => {
    const db = getDb();
    const asOf = "2026-07-18T14:00:00.000Z";
    const evidence = buildOptionDecisionSnapshot({
      contract: {
        optionSymbol: "SPY270115C00805000",
        underlyingSymbol: "SPY",
        type: "call",
        expirationDate: "2027-01-15",
        strike: 620,
        multiplier: 100
      },
      snapshot: {
        optionSymbol: "SPY270115C00805000",
        underlyingSymbol: "SPY",
        timestamp: asOf,
        bid: 16.4,
        ask: 16.52,
        midpoint: 16.46,
        last: 16.48,
        quoteStatus: "valid",
        executable: 1,
        executablePrice: 16.46,
        executablePriceSource: "midpoint",
        rejectionReason: null,
        quoteTimestamp: asOf,
        quoteAgeMs: 0,
        volume: 1234,
        openInterest: 5678,
        impliedVolatility: 0.1379,
        delta: 0.3459,
        gamma: 0.0049,
        theta: -0.0986,
        vega: 2.0038,
        rho: 0.12,
        snapshotTimestamp: asOf,
        normalizationPath: "current",
        source: "alpaca",
        sourceFeed: "opra",
        spreadPercentage: ((16.52 - 16.4) / 16.46) * 100
      },
      decisionTimestamp: asOf,
      underlyingPrice: 620,
      underlyingPriceSource: "stock_bar_close",
      derived: { liquidityScore: 0.82, ivPercentile: 0.61 },
      selectionBinding: "nearest_contract_feature_snapshot"
    });
    db.exec("DELETE FROM feature_snapshots; DELETE FROM learning_runs; DELETE FROM backtest_runs;");
    db.prepare(
      "INSERT INTO feature_snapshots(symbol, timestamp, features) VALUES (?, ?, ?)"
    ).run(
      "SPY",
      asOf,
      JSON.stringify({
        close: 620,
        preferredContractLiquidityScore: 0.82,
        optionDecisionSnapshot: evidence
      })
    );

    const ranked = rankResearchCandidates({
      researchRunId: "candidate-evidence-run",
      riskProfile: "aggressive",
      optionsEnabled: true,
      targets: [{
        symbol: "SPY",
        asOf,
        direction: "long",
        horizon: "1d",
        entryReference: 620,
        upsideTarget: 630,
        downsideRisk: 610,
        stopLoss: 610,
        takeProfit: 630,
        confidence: 0.8,
        expectedReturn: 0.04,
        volatilityAdjustedScore: 1.1,
        riskProfile: "aggressive",
        preferredExpression: "long_call",
        rationale: ["fixture"]
      }],
      maxCandidates: 1,
      maxPerSymbol: 1,
      maxPerDirection: 1,
      maxPerExpression: 1
    });

    const decision = ranked.decisions[0];
    const persistedEvidence = decision?.signalInputs.optionDecisionSnapshot as Record<string, any>;
    assert.equal(persistedEvidence.greeks.delta, evidence.greeks.delta);
    assert.equal(persistedEvidence.greeks.gamma, evidence.greeks.gamma);
    assert.equal(persistedEvidence.quoteTimestamp, evidence.quoteTimestamp);
    assert.equal(persistedEvidence.derived.candidateScore, decision?.score);
  });

  test("survives candidate creation, PostgreSQL JSONB projection, dashboard API projection, and rendering", async () => {
    const db = getDb();
    const asOf = "2026-07-18T14:00:00.000Z";
    const evidence = buildOptionDecisionSnapshot({
      contract: {
        optionSymbol: "SPY270115C00805000",
        underlyingSymbol: "SPY",
        type: "call",
        expirationDate: "2027-01-15",
        strike: 620,
        multiplier: 100
      },
      snapshot: {
        optionSymbol: "SPY270115C00805000",
        underlyingSymbol: "SPY",
        timestamp: asOf,
        bid: 16.4,
        ask: 16.52,
        midpoint: 16.46,
        last: 16.48,
        quoteStatus: "valid",
        executable: 1,
        executablePrice: 16.46,
        executablePriceSource: "midpoint",
        rejectionReason: null,
        quoteTimestamp: asOf,
        quoteAgeMs: 1_000,
        volume: 1234,
        openInterest: 5678,
        impliedVolatility: 0.1379,
        delta: 0.3459,
        gamma: 0.0049,
        theta: -0.0986,
        vega: 2.0038,
        rho: 0.12,
        snapshotTimestamp: asOf,
        normalizationPath: "current",
        source: "alpaca",
        sourceFeed: "opra",
        spreadPercentage: ((16.52 - 16.4) / 16.46) * 100
      },
      decisionTimestamp: asOf,
      underlyingPrice: 620,
      underlyingPriceSource: "stock_bar_close",
      derived: { liquidityScore: 0.82 },
      selectionBinding: "nearest_contract_feature_snapshot"
    });
    db.exec("DELETE FROM feature_snapshots; DELETE FROM learning_runs; DELETE FROM backtest_runs;");
    db.prepare(
      "INSERT INTO feature_snapshots(symbol, timestamp, features) VALUES (?, ?, ?)"
    ).run(
      "SPY",
      asOf,
      JSON.stringify({
        close: 620,
        preferredContractLiquidityScore: 0.82,
        optionDecisionSnapshot: evidence
      })
    );

    const ranked = rankResearchCandidates({
      researchRunId: "metadata-run",
      riskProfile: "aggressive",
      optionsEnabled: true,
      targets: [{
        symbol: "SPY",
        asOf,
        direction: "long",
        horizon: "1d",
        entryReference: 620,
        upsideTarget: 630,
        downsideRisk: 610,
        stopLoss: 610,
        takeProfit: 630,
        confidence: 0.8,
        expectedReturn: 0.04,
        volatilityAdjustedScore: 1.1,
        riskProfile: "aggressive",
        preferredExpression: "long_call",
        rationale: ["fixture"]
      }],
      maxCandidates: 1,
      maxPerSymbol: 1,
      maxPerDirection: 1,
      maxPerExpression: 1
    });
    const decision = ranked.decisions[0];
    assert.ok(decision);
    const candidateEvidence = decision.signalInputs.optionDecisionSnapshot as Record<string, any>;
    assert.deepEqual(candidateEvidence.decisionUse.bid, evidence.decisionUse.bid);
    assert.deepEqual(candidateEvidence.decisionUse.delta, evidence.decisionUse.delta);

    const postgresProjected = projectCandidateRow({
      id: decision.id,
      decision_id: null,
      research_run_id: "metadata-run",
      symbol: decision.symbol,
      as_of: decision.asOf,
      rank: decision.rank,
      direction: decision.direction,
      horizon: decision.horizon,
      risk_profile: decision.riskProfile,
      preferred_expression: decision.preferredExpression,
      score: decision.score,
      confidence: decision.confidence,
      expected_return: decision.expectedReturn,
      estimated_max_loss: decision.estimatedMaxLoss,
      estimated_max_profit: decision.estimatedMaxProfit,
      rationale: JSON.stringify(decision.rationale),
      relevant_backtest_run_id: decision.relevantBacktestRunId,
      historical_win_rate: decision.historicalWinRate,
      historical_avg_return: decision.historicalAvgReturn,
      historical_max_drawdown: decision.historicalMaxDrawdown,
      similar_setup_count: decision.similarSetupCount,
      option_liquidity_score: decision.optionLiquidityScore,
      volatility_score: decision.volatilityAdjustedScore,
      signal_freshness_days: decision.signalFreshnessDays,
      recent_learning_adjustment: decision.recentLearningAdjustment,
      directional_accuracy: decision.directionalAccuracy,
      option_outperformance_accuracy: decision.optionOutperformanceAccuracy,
      option_symbol: decision.optionSymbol,
      strike: decision.strike,
      short_strike: decision.shortStrike,
      decision: decision.decision,
      lifecycle_status: decision.decision,
      decision_reason: decision.decisionReason,
      strategy_family: decision.strategyFamily,
      signal_inputs: JSON.parse(JSON.stringify(decision.signalInputs)),
      data_quality_status: decision.dataQualityStatus,
      version: 1,
      created_at: decision.asOf,
      updated_at: decision.asOf
    } as Parameters<typeof projectCandidateRow>[0]);
    const projectedEvidence = postgresProjected.signalInputs.optionDecisionSnapshot as Record<string, any>;
    assert.deepEqual(projectedEvidence.decisionUse, candidateEvidence.decisionUse);

    const apiRows = await loadLatestOptionContracts(10);
    const apiRow = apiRows.find((entry) => entry.option_symbol === "SPY270115C00805000");
    assert.ok(apiRow);
    assert.deepEqual(apiRow.decisionUse.bid, {
      value: evidence.decisionUse.bid.value,
      used: true,
      useType: "score",
      reason: evidence.decisionUse.bid.reason
    });
    assert.equal(apiRow.decisionUse.delta.used, false);
    assert.equal(apiRow.decisionUse.delta.useType, null);
    assert.match(apiRow.decisionUse.delta.reason || "", /not used/i);

    const page = readFileSync("apps/dashboard/app/page.tsx", "utf8");
    assert.match(page, /formatOptionDecisionField/);
    assert.match(page, /Decision Use/);
    assert.match(page, /retrieved-but-unused/i);
  });

  test("returns persisted Greeks and availability through the dashboard projection", async () => {
    const rows = await loadLatestOptionContracts(10);
    const row = rows.find((entry) => entry.option_symbol === "SPY270115C00805000");
    assert.ok(row);
    assert.equal(row.delta, 0.3459);
    assert.equal(row.gamma, 0.0049);
    assert.equal(row.theta, -0.0986);
    assert.equal(row.vega, 2.0038);
    assert.equal(row.impliedVolatility, 0.1379);
    assert.equal(row.sourceFeed, "opra");
    assert.equal(row.greekAvailability, "available");
    assert.equal(row.dataQualityStatus, "complete");
  });

  test("renders the persisted option evidence fields in Options Runs", () => {
    const page = readFileSync("apps/dashboard/app/page.tsx", "utf8");
    assert.match(page, /Delta/);
    assert.match(page, /Gamma/);
    assert.match(page, /Theta/);
    assert.match(page, /Vega/);
    assert.match(page, /Implied Volatility/);
    assert.match(page, /Quote Age/);
    assert.match(page, /Data Source/);
    assert.match(page, /Decision Use/);
  });
});

process.on("exit", () => {
  closeDbForTests();
  rmSync(dbDir, { recursive: true, force: true });
});
