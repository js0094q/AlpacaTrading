import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSqliteTestDb } from "./helpers/sqliteTestDb.js";

process.env.RESEARCH_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "alpaca-paper-plan-test-")),
  "research.db"
);
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_ENV = "paper";
process.env.ENABLE_AGGRESSIVE_PAPER_STRATEGIES = "true";
process.env.ALPACA_PAPER_API_KEY = "paper-key";
process.env.ALPACA_PAPER_SECRET_KEY = "paper-secret";
process.env.ALPACA_PAPER_BASE_URL = "https://paper-api.alpaca.markets";

import { closeDbForTests, getDb } from "../src/lib/db.js";
import {
  buildPaperPlanReport,
  formatPaperPlanReportAsTable
} from "../src/services/paperPlanService.js";

const resetDatabase = () => {
  resetSqliteTestDb(getDb(), `
    DELETE FROM paper_trade_candidates;
    DELETE FROM paper_trade_plans;
    DELETE FROM paper_trade_evaluations;
	    DELETE FROM paper_learning_records;
	    DELETE FROM option_snapshots;
	    DELETE FROM option_contracts;
	    DELETE FROM target_snapshots;
	    DELETE FROM market_bars;
	    DELETE FROM research_runs;
	  `);
};

const makeMockResponse = (payload: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: {
    get: (name: string) => {
      if (name.toLowerCase() === "x-request-id") {
        return "mock-request-id";
      }
      if (name.toLowerCase() === "content-type") {
        return "application/json";
      }
      return null;
    }
  },
  text: async () => JSON.stringify(payload),
  json: async () => payload
}) as unknown as Response;

interface AssetFixture {
  class?: string;
  tradable?: boolean;
  status?: string;
  fractionable?: boolean;
}

type FetcherFn = (input: string, init?: RequestInit) => Promise<Response>;

const createMockFetcher = ({
  account = { status: "ACTIVE", equity: "100000", cash: "100000", buying_power: "80000" },
  positions = [] as Array<{ symbol: string; qty: string; asset_class?: string }>,
  orders = [] as Array<{ symbol: string; id?: string; asset_class?: string }>,
  assets = {
	    AAPL: { class: "us_equity", status: "active", tradable: true, fractionable: true },
	    NVDA: { class: "us_equity", status: "active", tradable: true, fractionable: true },
	    MSFT: { class: "us_equity", status: "active", tradable: true, fractionable: true },
	    TSLA: { class: "us_equity", status: "active", tradable: true, fractionable: true },
	    GOOGL: { class: "us_equity", status: "active", tradable: true, fractionable: true },
	    SPY: { class: "us_equity", status: "active", tradable: true, fractionable: true },
	    QQQ: { class: "us_equity", status: "active", tradable: true, fractionable: true }
  } as Record<string, AssetFixture>
} = {}): FetcherFn => {
  return async (input, init) => {
    const method = String(init?.method || "GET").toUpperCase();
    if (method !== "GET") {
      throw new Error(`Unexpected non-GET request in paper plan path: ${method}`);
    }

    if (input.includes("/v2/account")) {
      return makeMockResponse(account);
    }
    if (input.includes("/v2/positions")) {
      return makeMockResponse(positions);
    }
    if (input.includes("/v2/orders?status=open")) {
      return makeMockResponse(orders);
    }
    if (input.includes("/v2/assets/")) {
      const symbol = decodeURIComponent(input.split("/v2/assets/").pop()?.split("?")[0] || "").toUpperCase();
      const asset = assets[symbol];
      if (!asset) {
        return makeMockResponse({}, 404);
      }
      return makeMockResponse({
        symbol,
        class: asset.class || "us_equity",
        status: asset.status || "active",
        tradable: asset.tradable ?? true,
        fractionable: asset.fractionable ?? true
      });
    }

    return makeMockResponse({});
  };
};

const setMockFetch = (fetcher: FetcherFn) => {
  globalThis.fetch = (input, init) => fetcher(String(input), init as RequestInit | undefined);
};

type MockOptionContract = {
  symbol: string;
  underlying_symbol: string;
  type: "call" | "put";
  expiration_date: string;
  strike_price: number | string;
  multiplier?: number | string;
  tradable?: boolean;
  status?: string;
};

const createOptionDiscoveryFetcher = ({
  contracts,
  calls
}: {
  contracts: MockOptionContract[];
  calls?: string[];
}): FetcherFn => {
  const base = createMockFetcher();
  return async (input, init) => {
    const target = String(input);
    calls?.push(target);
    if (target.includes("/v2/options/contracts")) {
      const url = new URL(target);
      const underlyings = (url.searchParams.get("underlying_symbols") || "")
        .split(",")
        .map((entry) => entry.trim().toUpperCase())
        .filter(Boolean);
      const expirationDate = url.searchParams.get("expiration_date");
      const expirationGte = url.searchParams.get("expiration_date_gte");
      const expirationLte = url.searchParams.get("expiration_date_lte");
      const filtered = contracts.filter((contract) => {
        if (underlyings.length && !underlyings.includes(contract.underlying_symbol.toUpperCase())) {
          return false;
        }
        if (expirationDate && contract.expiration_date !== expirationDate) {
          return false;
        }
        if (expirationGte && contract.expiration_date < expirationGte) {
          return false;
        }
        if (expirationLte && contract.expiration_date > expirationLte) {
          return false;
        }
        return true;
      });
      return makeMockResponse({ option_contracts: filtered });
    }
    if (target.includes("/v1beta1/options/snapshots")) {
      const url = new URL(target);
      const symbols = (url.searchParams.get("symbols") || "")
        .split(",")
        .map((entry) => entry.trim().toUpperCase())
        .filter(Boolean);
      return makeMockResponse({
        snapshots: Object.fromEntries(
          symbols.map((symbol) => {
            const contract = contracts.find((row) => row.symbol.toUpperCase() === symbol);
            return [
              symbol,
              {
                symbol,
                underlying_symbol: contract?.underlying_symbol || symbol.slice(0, 3),
                Greeks: {
                  delta: contract?.type === "put" ? -0.55 : 0.7
                },
                latest_quote: {
                  t: new Date().toISOString(),
                  bp: contract?.type === "put" ? 1.2 : 1,
                  ap: contract?.type === "put" ? 1.3 : 1.1
                },
                latest_trade: {
                  t: new Date().toISOString(),
                  p: contract?.type === "put" ? 1.25 : 1.05
                },
                implied_volatility: 0.3,
                volume: 100,
                open_interest: 1000
              }
            ];
          })
        )
      });
    }
    if (target.includes("/v1beta1/options/quotes/latest")) {
      const url = new URL(target);
      const symbols = (url.searchParams.get("symbols") || "")
        .split(",")
        .map((entry) => entry.trim().toUpperCase())
        .filter(Boolean);
      return makeMockResponse({
        quotes: Object.fromEntries(
          symbols.map((symbol) => {
            const contract = contracts.find((row) => row.symbol.toUpperCase() === symbol);
            return [
              symbol,
              {
                t: new Date().toISOString(),
                bp: contract?.type === "put" ? 1.2 : 1,
                ap: contract?.type === "put" ? 1.3 : 1.1
              }
            ];
          })
        )
      });
    }
    return base(input, init);
  };
};

const insertResearchRun = ({
  runId,
  riskProfile = "moderate",
  optionsEnabled = false
}: {
  runId: string;
  riskProfile?: "moderate" | "aggressive" | "conservative";
  optionsEnabled?: boolean;
}) => {
  getDb().prepare(`
    INSERT INTO research_runs(
      id,
      started_at,
      completed_at,
      status,
      risk_profile,
      options_enabled,
      universe_size,
      targets_generated,
      candidates_selected,
      error_message,
      config_json,
      summary_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    "2026-01-01T12:00:00.000Z",
    "2026-01-01T12:00:00.000Z",
    "completed",
    riskProfile,
    optionsEnabled ? 1 : 0,
    5,
    5,
    5,
    null,
    JSON.stringify({ riskProfile, optionsEnabled }),
    null
  );
};

const insertCandidate = ({
  runId,
  symbol,
  rank,
  direction = "long",
  preferredExpression = "shares",
  asOf = "2026-01-01T12:00:00.000Z",
  estimatedMaxLoss = 100,
  estimatedMaxProfit = null,
  riskProfile = "moderate",
  optionSymbol = null,
  strike = null,
  shortStrike = null
}: {
  runId: string;
  symbol: string;
  rank: number;
  direction?: string;
  preferredExpression?: string;
  asOf?: string;
  estimatedMaxLoss?: number | null;
  estimatedMaxProfit?: number | null;
  riskProfile?: "moderate" | "aggressive" | "conservative";
  optionSymbol?: string | null;
  strike?: number | null;
  shortStrike?: number | null;
}) => {
  getDb().prepare(`
    INSERT INTO paper_trade_candidates(
      id,
      research_run_id,
      symbol,
      as_of,
      rank,
      direction,
      horizon,
      risk_profile,
      preferred_expression,
      score,
      confidence,
      expected_return,
      estimated_max_loss,
      estimated_max_profit,
      rationale,
      relevant_backtest_run_id,
      historical_win_rate,
      historical_avg_return,
      historical_max_drawdown,
      similar_setup_count,
      option_liquidity_score,
      volatility_score,
      signal_freshness_days,
      recent_learning_adjustment,
      directional_accuracy,
      option_outperformance_accuracy,
      option_symbol,
      strike,
      short_strike
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `cand-${runId}-${rank}`,
    runId,
    symbol,
    asOf,
    rank,
    direction,
    "5d",
    riskProfile,
    preferredExpression,
    1.5,
    0.8,
    0.2,
    estimatedMaxLoss,
    estimatedMaxProfit,
    "[]",
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    optionSymbol,
    strike,
    shortStrike
  );
};

const futureDate = (daysFromNow: number) => {
  const date = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
};

const insertOptionContract = ({
  optionSymbol,
  underlying = "AAPL",
  type = "call",
  expirationDate = futureDate(30),
	  strike = 100,
	  tradable = 1
	}: {
  optionSymbol: string;
  underlying?: string;
  type?: "call" | "put";
  expirationDate?: string;
  strike?: number;
  tradable?: 0 | 1;
}) => {
  getDb().prepare(`
    INSERT INTO option_contracts(
      underlying_symbol,
      option_symbol,
      type,
      expiration_date,
      strike,
      multiplier,
      tradable,
      source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(underlying, optionSymbol, type, expirationDate, strike, 100, tradable, "alpaca");
};

const insertOptionSnapshot = ({
  optionSymbol,
  underlying = "AAPL",
  bid = 0.7,
  ask = 0.8,
  midpoint = 0.75,
  last = 0.75,
  timestamp = new Date().toISOString(),
  quoteStatus = "valid",
  executable = 1,
  executablePrice = midpoint,
  executablePriceSource = "midpoint",
	  rejectionReason = null,
	  quoteTimestamp = timestamp,
	  delta = 0.5
	}: {
  optionSymbol: string;
  underlying?: string;
  bid?: number | null;
  ask?: number | null;
  midpoint?: number | null;
  last?: number | null;
  timestamp?: string;
  quoteStatus?: string;
  executable?: number;
  executablePrice?: number | null;
	  executablePriceSource?: string | null;
	  rejectionReason?: string | null;
	  quoteTimestamp?: string | null;
	  delta?: number | null;
	}) => {
  getDb().prepare(`
    INSERT INTO option_snapshots(
      option_symbol,
      underlying_symbol,
      timestamp,
      bid,
      ask,
      midpoint,
      last,
      volume,
      open_interest,
      implied_volatility,
      delta,
      gamma,
      theta,
      vega,
      rho,
      source,
      quote_status,
      executable,
      executable_price,
      executable_price_source,
      rejection_reason,
      quote_timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    optionSymbol,
    underlying,
    timestamp,
    bid,
    ask,
    midpoint,
    last,
    100,
    100,
    0.4,
	    delta,
    null,
    null,
    null,
    null,
    "alpaca",
    quoteStatus,
    executable,
    executablePrice,
    executablePriceSource,
    rejectionReason,
    quoteTimestamp
	  );
	};

const insertTargetSignal = ({
  symbol,
  direction = "long",
  confidence = 0.8,
  asOf = new Date().toISOString()
}: {
  symbol: string;
  direction?: "long" | "short" | "neutral";
  confidence?: number | null;
  asOf?: string;
}) => {
  getDb().prepare(`
    INSERT INTO target_snapshots(
      symbol,
      as_of,
      direction,
      horizon,
      entry_reference,
      upside_target,
      downside_risk,
      stop_loss,
      take_profit,
      confidence,
      expected_return,
      volatility_adjusted_score,
      risk_profile,
      preferred_expression,
      rationale
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    symbol,
    asOf,
    direction,
    "1d",
    100,
    105,
    95,
    94,
    106,
    confidence,
    direction === "short" ? -0.01 : 0.01,
    confidence ?? 0,
    "moderate",
    direction === "short" ? "long_put" : "long_call",
    JSON.stringify(["test signal"])
  );
};

const insertMarketBar = ({
  symbol,
  close,
  timestamp = "2026-01-01T12:00:00.000Z"
}: {
  symbol: string;
  close: number;
  timestamp?: string;
}) => {
  getDb().prepare(`
    INSERT INTO market_bars(
      symbol,
      timeframe,
      timestamp,
      open,
      high,
      low,
      close,
      volume,
      source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    symbol,
    "1Day",
    timestamp,
    close,
    close,
    close,
    close,
    1000,
    "alpaca"
  );
};

beforeEach(() => {
  resetDatabase();
  delete process.env.PAPER_EQUITY_NOTIONAL_PER_ORDER;
  delete process.env.PAPER_EQUITY_MAX_NOTIONAL_PER_ORDER;
  delete process.env.PAPER_EQUITY_MAX_PORTFOLIO_DEPLOY_PCT;
  delete process.env.PAPER_EQUITY_MAX_POSITION_PCT;
  delete process.env.PAPER_EQUITY_MIN_CASH_RESERVE_PCT;
  delete process.env.PAPER_PLAN_MAX_POSITION_NOTIONAL;
  delete process.env.PAPER_PLAN_MAX_TOTAL_PLAN_NOTIONAL;
  delete process.env.PAPER_OPTIONS_ALLOW_0DTE;
  delete process.env.ALLOW_0DTE_OPTIONS;
  delete process.env.OPTIONS_QUOTE_MAX_AGE_MS;
  delete process.env.ALLOW_OPTIONS_LAST_PRICE_FALLBACK;
	  delete process.env.PAPER_OPTIONS_MAX_SPREAD_PCT;
	  delete process.env.PAPER_OPTIONS_HARD_SPREAD_CAP_ENABLED;
	  delete process.env.PAPER_OPTIONS_MAX_CONTRACTS;
  delete process.env.PAPER_OPTIONS_MAX_PREMIUM_PER_ORDER;
	  delete process.env.PAPER_0DTE_SPY_ENABLED;
	  delete process.env.PAPER_0DTE_SPY_UNDERLYINGS;
	  delete process.env.PAPER_0DTE_SPY_MAX_PREMIUM_PER_TRADE;
  delete process.env.PAPER_0DTE_SPY_MAX_CONTRACTS;
  delete process.env.PAPER_0DTE_SPY_MAX_DAILY_TRADES;
	  delete process.env.PAPER_0DTE_SPY_MAX_QUOTE_AGE_SECONDS;
	  delete process.env.PAPER_0DTE_SPY_MAX_SPREAD_PCT;
	  delete process.env.PAPER_0DTE_SPY_HARD_SPREAD_CAP_ENABLED;
		  delete process.env.PAPER_LEAPS_ENABLED;
		  delete process.env.PAPER_LEAPS_UNDERLYINGS;
  delete process.env.PAPER_LEAPS_MAX_PREMIUM_PER_TRADE;
  delete process.env.PAPER_LEAPS_MAX_CONTRACTS;
	  delete process.env.PAPER_LEAPS_MIN_DTE;
	  delete process.env.PAPER_LEAPS_MAX_DTE;
	  delete process.env.PAPER_LEAPS_MAX_SPREAD_PCT;
	  delete process.env.PAPER_LEAPS_HARD_SPREAD_CAP_ENABLED;
  delete process.env.PAPER_OPTION_LEARNING_LEDGER_ENABLED;
  setMockFetch(createMockFetcher());
});

after(() => {
  closeDbForTests();
  rmSync(process.env.RESEARCH_DB_PATH!.substring(0, process.env.RESEARCH_DB_PATH!.lastIndexOf("/")), {
    recursive: true,
    force: true
  });
});

const planResultFor = (params: {
  riskProfile?: "moderate" | "aggressive" | "conservative";
  optionsEnabled?: boolean;
  maxCandidates?: number;
  maxNewPositions?: number;
  maxPositionNotional?: number;
  maxTotalPlanNotional?: number;
  minBuyingPowerReservePct?: number;
}) => buildPaperPlanReport({
  riskProfile: params.riskProfile,
  optionsEnabled: params.optionsEnabled,
  maxCandidates: params.maxCandidates,
  maxNewPositions: params.maxNewPositions,
  maxPositionNotional: params.maxPositionNotional,
  maxTotalPlanNotional: params.maxTotalPlanNotional,
  minBuyingPowerReservePct: params.minBuyingPowerReservePct
});

describe("paper plan service", () => {
  test("returns planned candidate when safe conditions pass", async () => {
    insertResearchRun({ runId: "run-planned", riskProfile: "moderate", optionsEnabled: false });
    insertCandidate({
      runId: "run-planned",
      symbol: "AAPL",
      rank: 1,
      asOf: "2026-01-01T12:00:00.000Z",
      estimatedMaxLoss: 100
    });
    insertMarketBar({ symbol: "AAPL", close: 100 });

    const report = await planResultFor({});
    assert.equal(report.summary.plannedOrders, 1);
    assert.equal(report.plan[0]?.decision, "planned");
    assert.equal(report.plan[0]?.assetClass, "us_equity");
    assert.equal(report.plan[0]?.estimatedQty, 10);
    assert.equal(report.plan[0]?.estimatedNotional, 1000);
    assert.equal(report.plan[0]?.sizingBasis?.basis, "account_relative");
  });

  test("uses PAPER_EQUITY_NOTIONAL_PER_ORDER env override", async () => {
    process.env.PAPER_EQUITY_NOTIONAL_PER_ORDER = "2500";
    insertResearchRun({ runId: "run-env-sizing", riskProfile: "moderate", optionsEnabled: false });
    insertCandidate({
      runId: "run-env-sizing",
      symbol: "AAPL",
      rank: 1,
      estimatedMaxLoss: 100
    });
    insertMarketBar({ symbol: "AAPL", close: 100 });

    const report = await planResultFor({});
    assert.equal(report.config.equityNotionalPerOrder, 2500);
    assert.equal(report.plan[0]?.estimatedNotional, 2500);
    assert.equal(report.plan[0]?.estimatedQty, 25);
  });

  test("falls back to configured notional when account sizing values are unavailable", async () => {
    insertResearchRun({ runId: "run-fallback-sizing", riskProfile: "moderate", optionsEnabled: false });
    insertCandidate({
      runId: "run-fallback-sizing",
      symbol: "AAPL",
      rank: 1,
      estimatedMaxLoss: 100
    });
    insertMarketBar({ symbol: "AAPL", close: 100 });
    setMockFetch(createMockFetcher({
      account: { status: "ACTIVE", equity: "", cash: "", buying_power: "" }
    }));

    const report = await planResultFor({});
    assert.equal(report.plan[0]?.decision, "planned");
    assert.equal(report.plan[0]?.estimatedNotional, 1000);
    assert.equal(report.plan[0]?.sizingBasis?.basis, "fallback");
    assert.equal(report.plan[0]?.sizingBasis?.usedFallback, true);
  });

  test("marks equity candidates as watch when the same equity is already held", async () => {
    insertResearchRun({ runId: "run-held", riskProfile: "moderate", optionsEnabled: false });
    insertCandidate({
      runId: "run-held",
      symbol: "AAPL",
      rank: 1,
      estimatedMaxLoss: 80
    });
    insertMarketBar({ symbol: "AAPL", close: 100 });
    setMockFetch(createMockFetcher({
      positions: [{ symbol: "AAPL", qty: "2" }]
    }));

    const report = await planResultFor({});
    const entry = report.plan[0];
    assert.equal(entry?.decision, "watch");
    assert.equal(entry?.reasonCodes.includes("ALREADY_HELD_EQUITY"), true);
  });

  test("skips candidates when open order already exists", async () => {
    insertResearchRun({ runId: "run-open-order", riskProfile: "moderate", optionsEnabled: false });
    insertCandidate({
      runId: "run-open-order",
      symbol: "AAPL",
      rank: 1,
      estimatedMaxLoss: 80
    });
    insertMarketBar({ symbol: "AAPL", close: 100 });
    setMockFetch(createMockFetcher({
      orders: [{ symbol: "AAPL", id: "ord-1" }]
    }));

    const report = await planResultFor({});
    assert.equal(report.plan[0]?.decision, "skip");
    assert.equal(report.plan[0]?.reasonCodes.includes("DUPLICATE_OPEN_EQUITY_ORDER"), true);
  });

  test("skips candidates when symbol is not tradable", async () => {
    insertResearchRun({ runId: "run-not-tradable", riskProfile: "moderate", optionsEnabled: false });
    insertCandidate({
      runId: "run-not-tradable",
      symbol: "AAPL",
      rank: 1,
      estimatedMaxLoss: 80
    });
    setMockFetch(createMockFetcher({
      assets: {
        AAPL: {
          class: "us_equity",
          status: "active",
          tradable: false,
          fractionable: true
        }
      }
    }));

    const report = await planResultFor({});
    assert.equal(report.plan[0]?.decision, "skip");
    assert.equal(report.plan[0]?.reasonCodes.includes("NOT_TRADABLE"), true);
  });

  test("reduces paper sizing when buying power is limited", async () => {
    insertResearchRun({ runId: "run-buys", riskProfile: "moderate", optionsEnabled: false });
    insertCandidate({
      runId: "run-buys",
      symbol: "AAPL",
      rank: 1,
      estimatedMaxLoss: 90
    });
    insertMarketBar({ symbol: "AAPL", close: 100 });
    setMockFetch(createMockFetcher({
      account: { status: "ACTIVE", equity: "100", cash: "100", buying_power: "10" }
    }));

    const report = await planResultFor({});
    assert.equal(report.plan[0]?.decision, "planned");
    assert.equal(report.plan[0]?.estimatedNotional, 8);
    assert.equal(report.plan[0]?.sizingBasis?.basis, "account_relative");
    assert.equal(report.plan[0]?.sizingBasis?.cashAfterOrder, 92);
  });

  test("watches candidates when estimated price is unavailable", async () => {
    insertResearchRun({ runId: "run-no-price", riskProfile: "moderate", optionsEnabled: false });
    insertCandidate({
      runId: "run-no-price",
      symbol: "AAPL",
      rank: 1,
      estimatedMaxLoss: 80
    });

    const report = await planResultFor({});
    assert.equal(report.plan[0]?.decision, "watch");
    assert.equal(report.plan[0]?.reasonCodes.includes("PRICE_UNKNOWN"), true);
  });

  test("enforces max new positions cap", async () => {
    insertResearchRun({ runId: "run-max-new", riskProfile: "moderate", optionsEnabled: false });
    insertCandidate({
      runId: "run-max-new",
      symbol: "AAPL",
      rank: 1,
      estimatedMaxLoss: 20
    });
    insertCandidate({
      runId: "run-max-new",
      symbol: "NVDA",
      rank: 2,
      estimatedMaxLoss: 20
    });
    insertMarketBar({ symbol: "AAPL", close: 100 });
    insertMarketBar({ symbol: "NVDA", close: 100 });

    const report = await planResultFor({ maxNewPositions: 1 });
    assert.equal(report.summary.plannedOrders, 1);
    assert.equal(report.summary.skipped, 1);
    assert.equal(report.plan[1]?.decision, "skip");
    assert.equal(report.plan[1]?.reasonCodes.includes("MAX_NEW_POSITIONS_REACHED"), true);
  });

  test("caps sizing at explicit max single-position notional", async () => {
    insertResearchRun({ runId: "run-pos-cap", riskProfile: "moderate", optionsEnabled: false });
    insertCandidate({
      runId: "run-pos-cap",
      symbol: "AAPL",
      rank: 1,
      estimatedMaxLoss: 200
    });
    insertMarketBar({ symbol: "AAPL", close: 100 });

    const report = await planResultFor({ maxPositionNotional: 100 });
    assert.equal(report.plan[0]?.decision, "planned");
    assert.equal(report.plan[0]?.estimatedNotional, 100);
    assert.equal(report.plan[0]?.sizingBasis?.targetNotional, 100);
  });

  test("enforces max total plan notional cap", async () => {
    insertResearchRun({ runId: "run-total-cap", riskProfile: "moderate", optionsEnabled: false });
    insertCandidate({
      runId: "run-total-cap",
      symbol: "AAPL",
      rank: 1,
      estimatedMaxLoss: 60
    });
    insertCandidate({
      runId: "run-total-cap",
      symbol: "NVDA",
      rank: 2,
      estimatedMaxLoss: 60
    });
    insertMarketBar({ symbol: "AAPL", close: 100 });
    insertMarketBar({ symbol: "NVDA", close: 100 });

    const report = await planResultFor({ maxTotalPlanNotional: 100, maxNewPositions: 2 });
    assert.equal(report.plan[0]?.decision, "planned");
    assert.equal(report.plan[1]?.decision, "skip");
    assert.equal(report.plan[1]?.reasonCodes.includes("MAX_TOTAL_PLAN_NOTIONAL_EXCEEDED"), true);
  });

  test("respects cash reserve by reducing target notional", async () => {
    insertResearchRun({ runId: "run-reserve", riskProfile: "moderate", optionsEnabled: false });
    insertCandidate({
      runId: "run-reserve",
      symbol: "AAPL",
      rank: 1,
      estimatedMaxLoss: 700
    });
    insertMarketBar({ symbol: "AAPL", close: 100 });
    setMockFetch(createMockFetcher({
      account: { status: "ACTIVE", equity: "1000", cash: "600", buying_power: "600" }
    }));

    const report = await planResultFor({
      maxPositionNotional: 1000,
      maxTotalPlanNotional: 1000,
      minBuyingPowerReservePct: 50
    });
    assert.equal(report.plan[0]?.decision, "planned");
    assert.equal(report.plan[0]?.estimatedNotional, 100);
    assert.equal(report.plan[0]?.sizingBasis?.cashReserveRequired, 500);
    assert.equal((report.plan[0]?.sizingBasis?.cashAfterOrder ?? 0) >= 500, true);
  });

  test("returns empty plan when no completed research run exists", async () => {
    const report = await planResultFor({});
    assert.equal(report.summary.candidatesEvaluated, 0);
    assert.equal(report.summary.plannedOrders, 0);
    assert.equal(report.summary.skipped, 0);
    assert.equal(report.summary.watched, 0);
    assert.equal(report.plan.length, 0);
    assert.equal(report.diagnostics.emptyReason, "NO_RESEARCH_SNAPSHOTS");
    assert.equal(report.diagnostics.latestSnapshotAvailable, false);
  });

  test("diagnoses filters that do not match completed snapshots", async () => {
    insertResearchRun({ runId: "run-filter-mismatch", riskProfile: "moderate", optionsEnabled: false });

    const report = await planResultFor({ riskProfile: "aggressive", optionsEnabled: true });
    assert.equal(report.summary.candidatesEvaluated, 0);
    assert.equal(report.diagnostics.emptyReason, "NO_MATCHING_SNAPSHOTS_FOR_FILTERS");
    assert.equal(report.diagnostics.latestSnapshotRunId, "run-filter-mismatch");
    assert.equal(report.diagnostics.filtersMatchedSnapshots, false);
  });

  test("diagnoses matched research run with no runtime candidates", async () => {
    insertResearchRun({ runId: "run-no-candidates", riskProfile: "moderate", optionsEnabled: false });

    const report = await planResultFor({});
    assert.equal(report.summary.candidatesEvaluated, 0);
    assert.equal(report.diagnostics.emptyReason, "NO_RUNTIME_CANDIDATES");
    assert.equal(report.diagnostics.filtersMatchedSnapshots, true);
    assert.equal(report.diagnostics.runtimeCandidatesAvailable, false);
  });

  test("diagnoses skipped-only plans", async () => {
    insertResearchRun({ runId: "run-skipped-only", riskProfile: "moderate", optionsEnabled: false });
    insertCandidate({
      runId: "run-skipped-only",
      symbol: "AAPL",
      rank: 1,
      estimatedMaxLoss: 80
    });
    setMockFetch(createMockFetcher({
      orders: [{ symbol: "AAPL", id: "ord-1" }]
    }));

    const report = await planResultFor({});
    assert.equal(report.summary.candidatesEvaluated, 1);
    assert.equal(report.summary.skipped, 1);
    assert.equal(report.diagnostics.emptyReason, "ALL_CANDIDATES_SKIPPED");
  });

  test("marks option-expression candidates as watch when options execution is not implemented", async () => {
    insertResearchRun({ runId: "run-options", riskProfile: "moderate", optionsEnabled: false });
    insertCandidate({
      runId: "run-options",
      symbol: "AAPL",
      rank: 1,
      preferredExpression: "call",
      estimatedMaxLoss: 80
    });
    insertMarketBar({ symbol: "AAPL", close: 100 });

    const report = await planResultFor({ optionsEnabled: false });
    assert.equal(report.plan[0]?.decision, "watch");
    assert.equal(report.plan[0]?.reasonCodes.includes("OPTIONS_PLANNING_NOT_IMPLEMENTED"), true);
  });

  test("plans eligible long call options when options are enabled", async () => {
    const optionSymbol = "AAPL260814C00100000";
    insertResearchRun({ runId: "run-long-call", riskProfile: "moderate", optionsEnabled: true });
    insertCandidate({
      runId: "run-long-call",
      symbol: "AAPL",
      rank: 1,
      preferredExpression: "long_call",
      optionSymbol,
      strike: 100,
      estimatedMaxLoss: 75
    });
    insertOptionContract({ optionSymbol, type: "call" });
    insertOptionSnapshot({ optionSymbol });

    const report = await planResultFor({ optionsEnabled: true });
    const entry = report.plan[0];
    assert.equal(entry?.decision, "planned");
    assert.equal(entry?.assetClass, "option");
    assert.equal(entry?.strategy, "long_call");
    assert.equal(entry?.contracts, 5);
    assert.equal(entry?.estimatedPremium, 375);
    assert.equal(entry?.quoteStatus, "valid");
    assert.equal(entry?.executable, true);
    assert.equal(entry?.executablePrice, 0.75);
    assert.equal(entry?.executablePriceSource, "midpoint");
    assert.equal(entry?.rejectionReason, null);
    assert.equal(entry?.reasonCodes.includes("SPECULATIVE_OPTION_PAPER_WARNING"), true);
  });

  test("does not block an option contract solely because the underlying equity is held", async () => {
    const optionSymbol = "AAPL260814C00100000";
    insertResearchRun({ runId: "run-option-held-underlying", riskProfile: "moderate", optionsEnabled: true });
    insertCandidate({
      runId: "run-option-held-underlying",
      symbol: "AAPL",
      rank: 1,
      preferredExpression: "long_call",
      optionSymbol,
      strike: 100,
      estimatedMaxLoss: 75
    });
    insertOptionContract({ optionSymbol, type: "call" });
    insertOptionSnapshot({ optionSymbol });
    setMockFetch(createMockFetcher({
      positions: [{ symbol: "AAPL", qty: "10", asset_class: "us_equity" }]
    }));

    const report = await planResultFor({ optionsEnabled: true });
    const entry = report.plan[0];
    assert.equal(entry?.decision, "planned");
    assert.equal(entry?.reasonCodes.includes("ALREADY_HELD_EQUITY"), false);
    assert.equal(entry?.reasonCodes.includes("ALREADY_HELD_OPTION_CONTRACT"), false);
  });

  test("blocks an option contract when the same option contract is already held", async () => {
    const optionSymbol = "AAPL260814C00100000";
    insertResearchRun({ runId: "run-held-option-contract", riskProfile: "moderate", optionsEnabled: true });
    insertCandidate({
      runId: "run-held-option-contract",
      symbol: "AAPL",
      rank: 1,
      preferredExpression: "long_call",
      optionSymbol,
      strike: 100,
      estimatedMaxLoss: 75
    });
    insertOptionContract({ optionSymbol, type: "call" });
    insertOptionSnapshot({ optionSymbol });
    setMockFetch(createMockFetcher({
      positions: [{ symbol: optionSymbol, qty: "1", asset_class: "option" }]
    }));

    const report = await planResultFor({ optionsEnabled: true });
    const entry = report.plan[0];
    assert.equal(entry?.decision, "watch");
    assert.equal(entry?.reasonCodes.includes("ALREADY_HELD_OPTION_CONTRACT"), true);
  });

  test("does not block an option contract because an equity order exists for the underlying", async () => {
    const optionSymbol = "AAPL260814C00100000";
    insertResearchRun({ runId: "run-option-open-equity-order", riskProfile: "moderate", optionsEnabled: true });
    insertCandidate({
      runId: "run-option-open-equity-order",
      symbol: "AAPL",
      rank: 1,
      preferredExpression: "long_call",
      optionSymbol,
      strike: 100,
      estimatedMaxLoss: 75
    });
    insertOptionContract({ optionSymbol, type: "call" });
    insertOptionSnapshot({ optionSymbol });
    setMockFetch(createMockFetcher({
      orders: [{ symbol: "AAPL", id: "ord-equity-1", asset_class: "us_equity" }]
    }));

    const report = await planResultFor({ optionsEnabled: true });
    const entry = report.plan[0];
    assert.equal(entry?.decision, "planned");
    assert.equal(entry?.reasonCodes.includes("DUPLICATE_OPEN_EQUITY_ORDER"), false);
    assert.equal(entry?.reasonCodes.includes("DUPLICATE_OPEN_OPTION_ORDER"), false);
  });

  test("blocks an option contract when the same option contract has an open order", async () => {
    const optionSymbol = "AAPL260814C00100000";
    insertResearchRun({ runId: "run-option-open-option-order", riskProfile: "moderate", optionsEnabled: true });
    insertCandidate({
      runId: "run-option-open-option-order",
      symbol: "AAPL",
      rank: 1,
      preferredExpression: "long_call",
      optionSymbol,
      strike: 100,
      estimatedMaxLoss: 75
    });
    insertOptionContract({ optionSymbol, type: "call" });
    insertOptionSnapshot({ optionSymbol });
    setMockFetch(createMockFetcher({
      orders: [{ symbol: optionSymbol, id: "ord-option-1", asset_class: "option" }]
    }));

    const report = await planResultFor({ optionsEnabled: true });
    const entry = report.plan[0];
    assert.equal(entry?.decision, "skip");
    assert.equal(entry?.reasonCodes.includes("DUPLICATE_OPEN_OPTION_ORDER"), true);
  });

  test("plans complete stale option quotes with a warning", async () => {
    const optionSymbol = "AAPL260814C00100000";
    const staleTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    insertResearchRun({ runId: "run-stale-option", riskProfile: "moderate", optionsEnabled: true });
    insertCandidate({
      runId: "run-stale-option",
      symbol: "AAPL",
      rank: 1,
      preferredExpression: "long_call",
      optionSymbol,
      strike: 100,
      estimatedMaxLoss: 75
    });
    insertOptionContract({ optionSymbol, type: "call" });
    insertOptionSnapshot({
      optionSymbol,
      timestamp: staleTimestamp,
      quoteTimestamp: staleTimestamp,
      quoteStatus: "stale",
      executable: 0,
      executablePrice: null,
      executablePriceSource: null,
      rejectionReason: "quote_stale"
    });

    const report = await planResultFor({ optionsEnabled: true });
    const entry = report.plan[0];
    assert.equal(entry?.decision, "planned");
    assert.equal(entry?.quoteStatus, "stale");
    assert.equal(entry?.executable, true);
    assert.equal(entry?.limitPrice, 0.75);
    assert.equal(entry?.rejectionReason, "quote_stale");
    assert.equal(entry?.reasonCodes.includes("QUOTE_STALE"), true);
    assert.equal(entry?.reasonCodes.includes("OPTION_LIMIT_PRICE_UNAVAILABLE"), false);
  });

  test("rejects crossed option quotes before planning", async () => {
    const optionSymbol = "AAPL260814C00100000";
    insertResearchRun({ runId: "run-crossed-option", riskProfile: "moderate", optionsEnabled: true });
    insertCandidate({
      runId: "run-crossed-option",
      symbol: "AAPL",
      rank: 1,
      preferredExpression: "long_call",
      optionSymbol,
      strike: 100,
      estimatedMaxLoss: 75
    });
    insertOptionContract({ optionSymbol, type: "call" });
    insertOptionSnapshot({
      optionSymbol,
      bid: 2,
      ask: 1.5,
      midpoint: null,
      quoteStatus: "invalid",
      executable: 0,
      executablePrice: null,
      executablePriceSource: null,
      rejectionReason: "crossed_quote"
    });

    const report = await planResultFor({ optionsEnabled: true });
    const entry = report.plan[0];
    assert.equal(entry?.decision, "watch");
    assert.equal(entry?.quoteStatus, "invalid");
    assert.equal(entry?.executable, false);
    assert.equal(entry?.rejectionReason, "crossed_quote");
    assert.equal(entry?.reasonCodes.includes("OPTION_LIMIT_PRICE_UNAVAILABLE"), true);
  });

  test("rejects null option quotes before planning", async () => {
    const optionSymbol = "AAPL260814C00100000";
    insertResearchRun({ runId: "run-null-option", riskProfile: "moderate", optionsEnabled: true });
    insertCandidate({
      runId: "run-null-option",
      symbol: "AAPL",
      rank: 1,
      preferredExpression: "long_call",
      optionSymbol,
      strike: 100,
      estimatedMaxLoss: 75
    });
    insertOptionContract({ optionSymbol, type: "call" });
    insertOptionSnapshot({
      optionSymbol,
      bid: null,
      ask: null,
      midpoint: null,
      last: null,
      quoteStatus: "missing",
      executable: 0,
      executablePrice: null,
      executablePriceSource: null,
      rejectionReason: "quote_unavailable"
    });

    const report = await planResultFor({ optionsEnabled: true });
    const entry = report.plan[0];
    assert.equal(entry?.decision, "watch");
    assert.equal(entry?.quoteStatus, "missing");
    assert.equal(entry?.executable, false);
    assert.equal(entry?.executablePrice, null);
    assert.equal(entry?.rejectionReason, "quote_unavailable");
    assert.equal(entry?.reasonCodes.includes("OPTION_LIMIT_PRICE_UNAVAILABLE"), true);
  });

  test("blocks 0DTE SPY option planning by default and allows it only when enabled", async () => {
    const optionSymbol = "SPY260703C00100000";
    insertResearchRun({ runId: "run-0dte", riskProfile: "moderate", optionsEnabled: true });
    insertCandidate({
      runId: "run-0dte",
      symbol: "SPY",
      rank: 1,
      preferredExpression: "long_call",
      optionSymbol,
      strike: 100,
      estimatedMaxLoss: 75
    });
    insertOptionContract({
      optionSymbol,
      underlying: "SPY",
      type: "call",
      expirationDate: new Date().toISOString().slice(0, 10)
    });
    insertOptionSnapshot({ optionSymbol });
    setMockFetch(createMockFetcher({
      assets: {
        SPY: { class: "us_equity", status: "active", tradable: true, fractionable: true }
      }
    }));

    const blocked = await planResultFor({ optionsEnabled: true });
    assert.equal(blocked.plan[0]?.decision, "watch");
    assert.equal(blocked.plan[0]?.reasonCodes.includes("ZERO_DTE_SPY_DISABLED"), true);
    assert.equal(blocked.plan[0]?.strategyFamily, "zero_dte_spy");

    process.env.PAPER_0DTE_SPY_ENABLED = "true";
    const allowed = await planResultFor({ optionsEnabled: true });
    assert.equal(allowed.plan[0]?.decision, "planned");
    assert.equal(allowed.plan[0]?.reasonCodes.includes("OPTION_0DTE_ALLOWED"), true);
    assert.equal(allowed.plan[0]?.strategyFamily, "zero_dte_spy");
  });

  test("rejects non-SPY same-day options under the 0DTE SPY family", async () => {
    const optionSymbol = "AAPL260703C00100000";
    process.env.PAPER_0DTE_SPY_ENABLED = "true";
    insertResearchRun({ runId: "run-non-spy-0dte", riskProfile: "moderate", optionsEnabled: true });
    insertCandidate({
      runId: "run-non-spy-0dte",
      symbol: "AAPL",
      rank: 1,
      preferredExpression: "long_call",
      optionSymbol,
      strike: 100,
      estimatedMaxLoss: 75
    });
    insertOptionContract({
      optionSymbol,
      underlying: "AAPL",
      type: "call",
      expirationDate: new Date().toISOString().slice(0, 10)
    });
    insertOptionSnapshot({ optionSymbol });

    const report = await planResultFor({ optionsEnabled: true });
    assert.equal(report.plan[0]?.decision, "watch");
    assert.equal(report.plan[0]?.strategyFamily, "zero_dte_spy");
    assert.equal(report.plan[0]?.reasonCodes.includes("NOT_ZERO_DTE"), true);
  });

  test("blocks LEAPS by default and plans eligible long-dated calls when enabled", async () => {
    const optionSymbol = "AAPL270115C00100000";
    insertResearchRun({ runId: "run-leaps", riskProfile: "moderate", optionsEnabled: true });
    insertCandidate({
      runId: "run-leaps",
      symbol: "AAPL",
      rank: 1,
      preferredExpression: "long_call",
      optionSymbol,
      strike: 100,
      estimatedMaxLoss: 75
    });
    insertOptionContract({
      optionSymbol,
      type: "call",
      expirationDate: futureDate(365)
    });
    insertOptionSnapshot({ optionSymbol });

    const blocked = await planResultFor({ optionsEnabled: true });
    assert.equal(blocked.plan[0]?.decision, "watch");
    assert.equal(blocked.plan[0]?.strategyFamily, "leaps");
    assert.equal(blocked.plan[0]?.reasonCodes.includes("LEAPS_DISABLED"), true);

    process.env.PAPER_LEAPS_ENABLED = "true";
    const allowed = await planResultFor({ optionsEnabled: true });
    assert.equal(allowed.plan[0]?.decision, "planned");
    assert.equal(allowed.plan[0]?.strategyFamily, "leaps");
    assert.equal(allowed.plan[0]?.riskModel?.expectedHoldPeriod, "long_horizon");
  });

  test("rejects LEAPS candidates below the configured DTE window", async () => {
    const optionSymbol = "AAPL260501C00100000";
    process.env.PAPER_LEAPS_ENABLED = "true";
    insertResearchRun({ runId: "run-leaps-dte-low", riskProfile: "moderate", optionsEnabled: true });
    insertCandidate({
      runId: "run-leaps-dte-low",
      symbol: "AAPL",
      rank: 1,
      preferredExpression: "long_call",
      optionSymbol,
      strike: 100,
      estimatedMaxLoss: 75
    });
    insertOptionContract({
      optionSymbol,
      type: "call",
      expirationDate: futureDate(120)
    });
    insertOptionSnapshot({ optionSymbol });

    const report = await planResultFor({ optionsEnabled: true });
    assert.equal(report.plan[0]?.decision, "watch");
    assert.equal(report.plan[0]?.strategyFamily, "leaps");
    assert.equal(report.plan[0]?.reasonCodes.includes("DTE_OUT_OF_RANGE"), true);
  });

  test("empty local cache triggers provider fetch and discovers same-day SPY contracts", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const occDate = today.slice(2).replace(/-/g, "");
    const callSymbol = `SPY${occDate}C00450000`;
    const putSymbol = `SPY${occDate}P00450000`;
    const calls: string[] = [];
    process.env.PAPER_0DTE_SPY_ENABLED = "true";
    process.env.ALLOW_0DTE_OPTIONS = "true";
    insertResearchRun({ runId: "run-zero-provider", riskProfile: "moderate", optionsEnabled: true });
    insertMarketBar({ symbol: "SPY", close: 450, timestamp: new Date().toISOString() });
    setMockFetch(createOptionDiscoveryFetcher({
      calls,
      contracts: [
        {
          symbol: callSymbol.toLowerCase(),
          underlying_symbol: "SPY",
          type: "call",
          expiration_date: today,
          strike_price: "450",
          multiplier: "100",
          tradable: true,
          status: "active"
        },
        {
          symbol: putSymbol,
          underlying_symbol: "SPY",
          type: "put",
          expiration_date: today,
          strike_price: 450,
          multiplier: 100,
          tradable: true,
          status: "active"
        }
      ]
    }));

    const report = await planResultFor({ optionsEnabled: true });
    const discovered = report.plan.filter((entry) =>
      entry.sourceCandidateId?.startsWith("discovery:zero_dte_spy:")
    );
    assert.equal(report.diagnostics.zeroDteSpyDiscovery?.cacheRefresh?.providerUsed, true);
    assert.equal(report.diagnostics.zeroDteSpyDiscovery?.cacheRefresh?.reason, "local_cache_empty");
    assert.equal(calls.some((target) => {
      if (!target.includes("/v2/options/contracts")) {
        return false;
      }
      const params = new URL(target).searchParams;
      return (
        params.get("expiration_date") === today ||
        (
          params.get("expiration_date_gte") === today &&
          params.get("expiration_date_lte") === today
        )
      );
    }), true);
    assert.equal(calls.some((target) => target.includes("/v1beta1/options/snapshots")), true);
    assert.equal(discovered.length, 2);
    assert.deepEqual(discovered.map((entry) => entry.optionSymbol).sort(), [callSymbol, putSymbol]);
    assert.equal(discovered.every((entry) => entry.decision === "planned"), true);
    assert.equal(discovered.every((entry) => entry.assetClass === "option"), true);
    assert.equal(discovered.every((entry) => entry.reasonCodes.includes("OPTION_CONTRACT_FOUND")), true);
  });

  test("empty local cache triggers provider fetch and discovers SPY and QQQ LEAPS", async () => {
    const calls: string[] = [];
    process.env.PAPER_LEAPS_ENABLED = "true";
    process.env.PAPER_LEAPS_UNDERLYINGS = "SPY,QQQ";
    insertResearchRun({ runId: "run-leaps-provider", riskProfile: "moderate", optionsEnabled: true });
    insertMarketBar({ symbol: "SPY", close: 450, timestamp: new Date().toISOString() });
    insertMarketBar({ symbol: "QQQ", close: 380, timestamp: new Date().toISOString() });
    setMockFetch(createOptionDiscoveryFetcher({
      calls,
      contracts: [
        {
          symbol: "SPY270115C00440000",
          underlying_symbol: "SPY",
          type: "call",
          expiration_date: futureDate(365),
          strike_price: "440",
          multiplier: "100",
          tradable: true,
          status: "active"
        },
        {
          symbol: "QQQ270115C00370000",
          underlying_symbol: "QQQ",
          type: "call",
          expiration_date: futureDate(365),
          strike_price: "370",
          multiplier: "100",
          tradable: true,
          status: "active"
        }
      ]
    }));

    const report = await planResultFor({ optionsEnabled: true });
    const discovered = report.plan.filter((entry) =>
      entry.sourceCandidateId?.startsWith("discovery:leaps:")
    );
    assert.equal(report.diagnostics.leapsDiscovery?.cacheRefresh?.providerUsed, true);
    assert.equal(calls.some((target) =>
      target.includes("/v2/options/contracts") &&
      target.includes("expiration_date_gte=") &&
      target.includes("expiration_date_lte=")
    ), true);
    assert.equal(discovered.length, 2);
    assert.deepEqual(discovered.map((entry) => entry.optionSymbol).sort(), [
      "QQQ270115C00370000",
      "SPY270115C00440000"
    ]);
    assert.equal(discovered.every((entry) => entry.decision === "planned"), true);
    assert.equal(discovered.every((entry) => entry.strategyFamily === "leaps"), true);
  });

  test("partial LEAPS cache triggers provider fetch for missing underlyings", async () => {
    const calls: string[] = [];
    const expirationDate = futureDate(365);
    process.env.PAPER_LEAPS_ENABLED = "true";
    process.env.PAPER_LEAPS_UNDERLYINGS = "SPY,QQQ";
    insertResearchRun({ runId: "run-leaps-provider-partial", riskProfile: "moderate", optionsEnabled: true });
    insertMarketBar({ symbol: "SPY", close: 450, timestamp: new Date().toISOString() });
    insertMarketBar({ symbol: "QQQ", close: 380, timestamp: new Date().toISOString() });
    insertOptionContract({
      optionSymbol: "QQQ270115C00370000",
      underlying: "QQQ",
      type: "call",
      expirationDate,
      strike: 370
    });
    setMockFetch(createOptionDiscoveryFetcher({
      calls,
      contracts: [
        {
          symbol: "SPY270115C00440000",
          underlying_symbol: "SPY",
          type: "call",
          expiration_date: expirationDate,
          strike_price: "440",
          multiplier: "100",
          tradable: true,
          status: "active"
        },
        {
          symbol: "QQQ270115C00370000",
          underlying_symbol: "QQQ",
          type: "call",
          expiration_date: expirationDate,
          strike_price: "370",
          multiplier: "100",
          tradable: true,
          status: "active"
        }
      ]
    }));

    const report = await planResultFor({ optionsEnabled: true });
    const discovered = report.plan.filter((entry) =>
      entry.sourceCandidateId?.startsWith("discovery:leaps:")
    );

    assert.equal(report.diagnostics.leapsDiscovery?.cacheRefresh?.providerUsed, true);
    assert.equal(report.diagnostics.leapsDiscovery?.cacheRefresh?.reason, "local_cache_partial");
    assert.deepEqual(report.diagnostics.leapsDiscovery?.cacheRefresh?.missingUnderlyings, ["SPY"]);
    assert.equal(calls.some((target) => target.includes("/v2/options/contracts")), true);
    assert.deepEqual(discovered.map((entry) => entry.optionSymbol).sort(), [
      "QQQ270115C00370000",
      "SPY270115C00440000"
    ]);
  });

  test("missing provider contract response keeps OPTION_CONTRACT_NOT_FOUND blocker", async () => {
    process.env.PAPER_0DTE_SPY_ENABLED = "true";
    process.env.ALLOW_0DTE_OPTIONS = "true";
    insertResearchRun({ runId: "run-zero-provider-empty", riskProfile: "moderate", optionsEnabled: true });
    setMockFetch(createOptionDiscoveryFetcher({ contracts: [] }));

    const report = await planResultFor({ optionsEnabled: true });
    assert.equal(report.plan.length, 0);
    assert.equal(report.diagnostics.zeroDteSpyDiscovery?.contractsFound, 0);
    assert.equal(report.diagnostics.zeroDteSpyDiscovery?.cacheRefresh?.providerUsed, true);
    assert.equal(report.diagnostics.zeroDteSpyDiscovery?.hardBlockers.includes("OPTION_CONTRACT_NOT_FOUND"), true);
    assert.equal(report.diagnostics.discoveryTopBlockers?.includes("OPTION_CONTRACT_NOT_FOUND"), true);
  });

  test("discovers executable 0DTE SPY call and put without normal equity candidates", async () => {
    const asOf = new Date().toISOString();
    const today = new Date().toISOString().slice(0, 10);
    const callSymbol = "SPY0DTECALL";
    const putSymbol = "SPY0DTEPUT";
    process.env.PAPER_0DTE_SPY_ENABLED = "true";
    process.env.ALLOW_0DTE_OPTIONS = "true";
    insertResearchRun({ runId: "run-zero-dte-discovery", riskProfile: "moderate", optionsEnabled: true });
    insertTargetSignal({ symbol: "SPY", asOf, direction: "neutral", confidence: 0.8 });
    insertMarketBar({ symbol: "SPY", close: 450, timestamp: asOf });
    insertOptionContract({ optionSymbol: callSymbol, underlying: "SPY", type: "call", expirationDate: today, strike: 450 });
    insertOptionContract({ optionSymbol: putSymbol, underlying: "SPY", type: "put", expirationDate: today, strike: 450 });
    insertOptionSnapshot({ optionSymbol: callSymbol, underlying: "SPY", bid: 1, ask: 1.1, midpoint: 1.05 });
    insertOptionSnapshot({ optionSymbol: putSymbol, underlying: "SPY", bid: 1.2, ask: 1.3, midpoint: 1.25 });

    const report = await planResultFor({ optionsEnabled: true });
    const discovered = report.plan.filter((candidate) =>
      candidate.sourceCandidateId?.startsWith("discovery:zero_dte_spy:")
    );
    assert.equal(discovered.length, 2);
    assert.deepEqual(discovered.map((entry) => entry.optionSymbol).sort(), [callSymbol, putSymbol].sort());
    assert.equal(discovered.every((entry) => entry.decision === "planned"), true);
    assert.deepEqual(discovered.map((entry) => entry.strategy).sort(), ["long_call", "long_put"].sort());
    assert.equal(report.summary.zeroDteSpyDiscoveryEligible, 2);
    assert.deepEqual(report.diagnostics.zeroDteSpyDiscovery?.selectedOptionSymbols.sort(), [callSymbol, putSymbol].sort());

    const records = getDb()
      .prepare("SELECT strategy_family, decision, signal_inputs_json FROM paper_learning_records ORDER BY option_symbol ASC")
      .all() as Array<{ strategy_family: string; decision: string; signal_inputs_json: string }>;
    assert.equal(records.length, 2);
    assert.equal(records.every((record) => record.strategy_family === "zero_dte_spy"), true);
    assert.equal(records.every((record) => record.decision === "submitted"), true);
    assert.equal(records.every((record) => JSON.parse(record.signal_inputs_json).discoverySource === "explicit_zero_dte_spy"), true);
  });

  test("does not run 0DTE SPY discovery when disabled", async () => {
    const today = new Date().toISOString().slice(0, 10);
    insertResearchRun({ runId: "run-zero-disabled", riskProfile: "moderate", optionsEnabled: true });
    insertOptionContract({
      optionSymbol: "SPY0DTEDISABLED",
      underlying: "SPY",
      type: "call",
      expirationDate: today,
      strike: 450
    });

    const report = await planResultFor({ optionsEnabled: true });
    assert.equal(report.summary.zeroDteSpyDiscoveryCandidates, 0);
    assert.equal(report.diagnostics.zeroDteSpyDiscovery?.enabled, false);
  });

  test("does not run option discovery when paper options planning is disabled", async () => {
    const today = new Date().toISOString().slice(0, 10);
    process.env.PAPER_0DTE_SPY_ENABLED = "true";
    process.env.ALLOW_0DTE_OPTIONS = "true";
    insertResearchRun({ runId: "run-zero-options-disabled", riskProfile: "moderate", optionsEnabled: false });
    insertOptionContract({
      optionSymbol: "SPY0DTEOPTIONSDISABLED",
      underlying: "SPY",
      type: "call",
      expirationDate: today,
      strike: 450
    });
    insertOptionSnapshot({ optionSymbol: "SPY0DTEOPTIONSDISABLED", underlying: "SPY" });

    const report = await planResultFor({ optionsEnabled: false });
    assert.equal(report.summary.zeroDteSpyDiscoveryCandidates, 0);
    assert.equal(report.diagnostics.zeroDteSpyDiscovery?.enabled, false);
    assert.equal(report.diagnostics.discoveryTopBlockers?.includes("OPTIONS_PLANNING_NOT_IMPLEMENTED"), true);
  });

  test("blocks discovery outside the paper environment", async () => {
    const originalEnv = process.env.ALPACA_ENV;
    try {
      process.env.ALPACA_ENV = "live";
      await assert.rejects(
        () => planResultFor({ optionsEnabled: true }),
        /paper:plan requires ALPACA_ENV=paper/
      );
    } finally {
      process.env.ALPACA_ENV = originalEnv;
    }
  });

  test("0DTE SPY discovery ignores underlying equity duplicates and blocks same option duplicates", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const callSymbol = "SPY0DTEDUPECALL";
    const putSymbol = "SPY0DTEDUPEPUT";
    process.env.PAPER_0DTE_SPY_ENABLED = "true";
    process.env.ALLOW_0DTE_OPTIONS = "true";
    insertResearchRun({ runId: "run-zero-duplicates", riskProfile: "moderate", optionsEnabled: true });
    insertOptionContract({ optionSymbol: callSymbol, underlying: "SPY", type: "call", expirationDate: today, strike: 450 });
    insertOptionContract({ optionSymbol: putSymbol, underlying: "SPY", type: "put", expirationDate: today, strike: 450 });
    insertOptionSnapshot({ optionSymbol: callSymbol, underlying: "SPY" });
    insertOptionSnapshot({ optionSymbol: putSymbol, underlying: "SPY" });
    insertMarketBar({ symbol: "SPY", close: 450, timestamp: new Date().toISOString() });
    setMockFetch(createMockFetcher({
      positions: [{ symbol: "SPY", qty: "10", asset_class: "us_equity" }],
      orders: [{ symbol: "SPY", id: "ord-equity", asset_class: "us_equity" }]
    }));

    const underlyingDuplicate = await planResultFor({ optionsEnabled: true });
    assert.equal(underlyingDuplicate.plan.every((entry) => entry.decision === "planned"), true);
    assert.equal(underlyingDuplicate.plan.some((entry) => entry.reasonCodes.includes("ALREADY_HELD_EQUITY")), false);
    assert.equal(underlyingDuplicate.plan.some((entry) => entry.reasonCodes.includes("DUPLICATE_OPEN_EQUITY_ORDER")), false);

    resetDatabase();
    setMockFetch(createMockFetcher({
      positions: [{ symbol: callSymbol, qty: "1", asset_class: "option" }]
    }));
    process.env.PAPER_0DTE_SPY_ENABLED = "true";
    process.env.ALLOW_0DTE_OPTIONS = "true";
    insertResearchRun({ runId: "run-zero-held-contract", riskProfile: "moderate", optionsEnabled: true });
    insertOptionContract({ optionSymbol: callSymbol, underlying: "SPY", type: "call", expirationDate: today, strike: 450 });
    insertOptionContract({ optionSymbol: putSymbol, underlying: "SPY", type: "put", expirationDate: today, strike: 450 });
    insertOptionSnapshot({ optionSymbol: callSymbol, underlying: "SPY" });
    insertOptionSnapshot({ optionSymbol: putSymbol, underlying: "SPY" });

    const heldContract = await planResultFor({ optionsEnabled: true });
    const heldCall = heldContract.plan.find((entry) => entry.optionSymbol === callSymbol);
    const unheldPut = heldContract.plan.find((entry) => entry.optionSymbol === putSymbol);
    assert.equal(heldCall?.decision, "watch");
    assert.equal(heldCall?.reasonCodes.includes("ALREADY_HELD_OPTION_CONTRACT"), true);
    assert.equal(unheldPut?.decision, "planned");

    resetDatabase();
    setMockFetch(createMockFetcher({
      orders: [{ symbol: callSymbol, id: "ord-option", asset_class: "option" }]
    }));
    process.env.PAPER_0DTE_SPY_ENABLED = "true";
    process.env.ALLOW_0DTE_OPTIONS = "true";
    insertResearchRun({ runId: "run-zero-open-contract", riskProfile: "moderate", optionsEnabled: true });
    insertOptionContract({ optionSymbol: callSymbol, underlying: "SPY", type: "call", expirationDate: today, strike: 450 });
    insertOptionContract({ optionSymbol: putSymbol, underlying: "SPY", type: "put", expirationDate: today, strike: 450 });
    insertOptionSnapshot({ optionSymbol: callSymbol, underlying: "SPY" });
    insertOptionSnapshot({ optionSymbol: putSymbol, underlying: "SPY" });

    const openContract = await planResultFor({ optionsEnabled: true });
    const openCall = openContract.plan.find((entry) => entry.optionSymbol === callSymbol);
    assert.equal(openCall?.decision, "skip");
    assert.equal(openCall?.reasonCodes.includes("DUPLICATE_OPEN_OPTION_ORDER"), true);
  });

  test("discovers executable SPY and QQQ LEAPS calls without normal equity candidates", async () => {
    const spySymbol = "SPYLEAPSCALL";
    const qqqSymbol = "QQQLEAPSCALL";
    process.env.PAPER_LEAPS_ENABLED = "true";
    process.env.PAPER_LEAPS_UNDERLYINGS = "SPY,QQQ";
    insertResearchRun({ runId: "run-leaps-discovery", riskProfile: "moderate", optionsEnabled: true });
    insertMarketBar({ symbol: "SPY", close: 450, timestamp: new Date().toISOString() });
    insertMarketBar({ symbol: "QQQ", close: 380, timestamp: new Date().toISOString() });
    insertOptionContract({ optionSymbol: spySymbol, underlying: "SPY", type: "call", expirationDate: futureDate(365), strike: 440 });
    insertOptionContract({ optionSymbol: qqqSymbol, underlying: "QQQ", type: "call", expirationDate: futureDate(365), strike: 370 });
    insertOptionSnapshot({ optionSymbol: spySymbol, underlying: "SPY", bid: 4, ask: 4.2, midpoint: 4.1, delta: 0.7 });
    insertOptionSnapshot({ optionSymbol: qqqSymbol, underlying: "QQQ", bid: 3, ask: 3.2, midpoint: 3.1, delta: 0.65 });

    const report = await planResultFor({ optionsEnabled: true });
    const discovered = report.plan.filter((candidate) =>
      candidate.sourceCandidateId?.startsWith("discovery:leaps:")
    );
    assert.equal(discovered.length, 2);
    assert.deepEqual(discovered.map((entry) => entry.optionSymbol).sort(), [qqqSymbol, spySymbol].sort());
    assert.equal(discovered.every((entry) => entry.decision === "planned"), true);
    assert.equal(discovered.every((entry) => entry.strategy === "long_call"), true);
    assert.equal(report.summary.leapsDiscoveryEligible, 2);

    const records = getDb()
      .prepare("SELECT strategy_family, decision, signal_inputs_json FROM paper_learning_records ORDER BY option_symbol ASC")
      .all() as Array<{ strategy_family: string; decision: string; signal_inputs_json: string }>;
    assert.equal(records.length, 2);
    assert.equal(records.every((record) => record.strategy_family === "leaps"), true);
    assert.equal(records.every((record) => record.decision === "submitted"), true);
    assert.equal(records.every((record) => JSON.parse(record.signal_inputs_json).discoverySource === "explicit_leaps"), true);
  });

  test("LEAPS discovery ignores underlying equity duplicates and blocks same option duplicates", async () => {
    const optionSymbol = "SPYLEAPSDUPE";
    process.env.PAPER_LEAPS_ENABLED = "true";
    process.env.PAPER_LEAPS_UNDERLYINGS = "SPY";
    insertResearchRun({ runId: "run-leaps-duplicates", riskProfile: "moderate", optionsEnabled: true });
    insertOptionContract({ optionSymbol, underlying: "SPY", type: "call", expirationDate: futureDate(365), strike: 440 });
    insertOptionSnapshot({ optionSymbol, underlying: "SPY", delta: 0.7 });
    setMockFetch(createMockFetcher({
      positions: [{ symbol: "SPY", qty: "10", asset_class: "us_equity" }],
      orders: [{ symbol: "SPY", id: "ord-equity", asset_class: "us_equity" }]
    }));

    const underlyingDuplicate = await planResultFor({ optionsEnabled: true });
    assert.equal(underlyingDuplicate.plan[0]?.decision, "planned");
    assert.equal(underlyingDuplicate.plan[0]?.reasonCodes.includes("ALREADY_HELD_EQUITY"), false);
    assert.equal(underlyingDuplicate.plan[0]?.reasonCodes.includes("DUPLICATE_OPEN_EQUITY_ORDER"), false);

    resetDatabase();
    setMockFetch(createMockFetcher({
      positions: [{ symbol: optionSymbol, qty: "1", asset_class: "option" }]
    }));
    process.env.PAPER_LEAPS_ENABLED = "true";
    process.env.PAPER_LEAPS_UNDERLYINGS = "SPY";
    insertResearchRun({ runId: "run-leaps-held-contract", riskProfile: "moderate", optionsEnabled: true });
    insertOptionContract({ optionSymbol, underlying: "SPY", type: "call", expirationDate: futureDate(365), strike: 440 });
    insertOptionSnapshot({ optionSymbol, underlying: "SPY", delta: 0.7 });

    const heldContract = await planResultFor({ optionsEnabled: true });
    assert.equal(heldContract.plan[0]?.decision, "watch");
    assert.equal(heldContract.plan[0]?.reasonCodes.includes("ALREADY_HELD_OPTION_CONTRACT"), true);

    resetDatabase();
    setMockFetch(createMockFetcher({
      orders: [{ symbol: optionSymbol, id: "ord-option", asset_class: "option" }]
    }));
    process.env.PAPER_LEAPS_ENABLED = "true";
    process.env.PAPER_LEAPS_UNDERLYINGS = "SPY";
    insertResearchRun({ runId: "run-leaps-open-contract", riskProfile: "moderate", optionsEnabled: true });
    insertOptionContract({ optionSymbol, underlying: "SPY", type: "call", expirationDate: futureDate(365), strike: 440 });
    insertOptionSnapshot({ optionSymbol, underlying: "SPY", delta: 0.7 });

    const openContract = await planResultFor({ optionsEnabled: true });
    assert.equal(openContract.plan[0]?.decision, "skip");
    assert.equal(openContract.plan[0]?.reasonCodes.includes("DUPLICATE_OPEN_OPTION_ORDER"), true);
  });

  test("wide spread and weak signal are warnings, not discovery buy blockers", async () => {
    const asOf = new Date().toISOString();
    const today = new Date().toISOString().slice(0, 10);
    const callSymbol = "SPY0DTEWIDECALL";
    const putSymbol = "SPY0DTEWIDEPUT";
    process.env.PAPER_0DTE_SPY_ENABLED = "true";
    process.env.ALLOW_0DTE_OPTIONS = "true";
    process.env.PAPER_0DTE_SPY_MAX_SPREAD_PCT = "10";
    insertResearchRun({ runId: "run-zero-warnings", riskProfile: "moderate", optionsEnabled: true });
    insertTargetSignal({ symbol: "SPY", asOf, direction: "neutral", confidence: 0.2 });
    insertMarketBar({ symbol: "SPY", close: 450, timestamp: asOf });
    insertOptionContract({ optionSymbol: callSymbol, underlying: "SPY", type: "call", expirationDate: today, strike: 450 });
    insertOptionContract({ optionSymbol: putSymbol, underlying: "SPY", type: "put", expirationDate: today, strike: 450 });
    insertOptionSnapshot({ optionSymbol: callSymbol, underlying: "SPY", bid: 0.5, ask: 1, midpoint: 0.75 });
    insertOptionSnapshot({ optionSymbol: putSymbol, underlying: "SPY", bid: 0.5, ask: 1, midpoint: 0.75 });

    const report = await planResultFor({ optionsEnabled: true });
    assert.equal(report.plan.every((entry) => entry.decision === "planned"), true);
    assert.equal(report.plan.every((entry) => entry.reasonCodes.includes("OPTION_WIDE_SPREAD_WARNING")), true);
    assert.equal(report.diagnostics.zeroDteSpyDiscovery?.warnings.includes("weak_signal_confidence"), true);
    assert.equal(report.diagnostics.zeroDteSpyDiscovery?.warnings.includes("neutral_signal_direction"), true);

    const record = getDb()
      .prepare("SELECT signal_inputs_json FROM paper_learning_records LIMIT 1")
      .get() as { signal_inputs_json: string };
    const signalInputs = JSON.parse(record.signal_inputs_json) as { warnings?: string[] };
    assert.equal(signalInputs.warnings?.includes("weak_signal_confidence"), true);
  });

  test("writes learning records for submitted and rejected option candidates", async () => {
    const submittedSymbol = "AAPL270115C00100000";
    const rejectedSymbol = "SPY260703C00100000";
    process.env.PAPER_LEAPS_ENABLED = "true";
    insertResearchRun({ runId: "run-learning-ledger", riskProfile: "moderate", optionsEnabled: true });
    insertCandidate({
      runId: "run-learning-ledger",
      symbol: "AAPL",
      rank: 1,
      preferredExpression: "long_call",
      optionSymbol: submittedSymbol,
      strike: 100,
      estimatedMaxLoss: 75
    });
    insertCandidate({
      runId: "run-learning-ledger",
      symbol: "SPY",
      rank: 2,
      preferredExpression: "long_call",
      optionSymbol: rejectedSymbol,
      strike: 100,
      estimatedMaxLoss: 75
    });
    insertOptionContract({
      optionSymbol: submittedSymbol,
      type: "call",
      expirationDate: futureDate(365)
    });
    insertOptionSnapshot({ optionSymbol: submittedSymbol });
    insertOptionContract({
      optionSymbol: rejectedSymbol,
      underlying: "SPY",
      type: "call",
      expirationDate: new Date().toISOString().slice(0, 10)
    });
    insertOptionSnapshot({ optionSymbol: rejectedSymbol, underlying: "SPY" });
    setMockFetch(createMockFetcher({
      assets: {
        AAPL: { class: "us_equity", status: "active", tradable: true, fractionable: true },
        SPY: { class: "us_equity", status: "active", tradable: true, fractionable: true }
      }
    }));

    const report = await planResultFor({ optionsEnabled: true, maxCandidates: 2 });
    assert.equal(report.summary.learningRecordsWritten, 2);
    const records = getDb()
      .prepare("SELECT strategy_family, decision, hypothesis, paper_fill_model_json, live_like_fill_model_json FROM paper_learning_records ORDER BY source_candidate_id ASC")
      .all() as Array<{
        strategy_family: string;
        decision: string;
        hypothesis: string;
        paper_fill_model_json: string | null;
        live_like_fill_model_json: string | null;
      }>;
    assert.equal(records.length, 2);
    assert.equal(records[0]?.strategy_family, "leaps");
    assert.equal(records[0]?.decision, "submitted");
    assert.equal(Boolean(records[0]?.paper_fill_model_json), true);
    assert.equal(Boolean(records[0]?.live_like_fill_model_json), true);
    assert.equal(records[1]?.strategy_family, "zero_dte_spy");
    assert.equal(records[1]?.decision, "skipped");
    assert.match(records[1]?.hypothesis || "", /SPY intraday/);
  });

  test("wide option spread is a warning unless hard spread cap is enabled", async () => {
    const optionSymbol = "AAPL260814C00100000";
    insertResearchRun({ runId: "run-wide-spread", riskProfile: "moderate", optionsEnabled: true });
    insertCandidate({
      runId: "run-wide-spread",
      symbol: "AAPL",
      rank: 1,
      preferredExpression: "long_call",
      optionSymbol,
      strike: 100,
      estimatedMaxLoss: 75
    });
    insertOptionContract({ optionSymbol, type: "call" });
    insertOptionSnapshot({ optionSymbol, bid: 0.6, ask: 0.9, midpoint: 0.75 });

    const warning = await planResultFor({ optionsEnabled: true });
    assert.equal(warning.plan[0]?.decision, "planned");
    assert.equal(warning.plan[0]?.reasonCodes.includes("OPTION_WIDE_SPREAD_WARNING"), true);

    process.env.PAPER_OPTIONS_MAX_SPREAD_PCT = "20";
    process.env.PAPER_OPTIONS_HARD_SPREAD_CAP_ENABLED = "true";
    const blocked = await planResultFor({ optionsEnabled: true });
    assert.equal(blocked.plan[0]?.decision, "watch");
    assert.equal(blocked.plan[0]?.reasonCodes.includes("OPTION_SPREAD_TOO_WIDE"), true);
  });

  test("plan report is stable and marks dry-run non-mutating flags", async () => {
    insertResearchRun({ runId: "run-shape", riskProfile: "moderate", optionsEnabled: false });
    insertCandidate({
      runId: "run-shape",
      symbol: "AAPL",
      rank: 1,
      estimatedMaxLoss: 60
    });
    insertMarketBar({ symbol: "AAPL", close: 100 });

    const report = await planResultFor({});
    assert.equal(report.dryRun, true);
    assert.equal(report.nonMutating, true);
    assert.equal(report.paperOnly, true);
    assert.equal(report.diagnostics.emptyReason, null);
    assert.equal(typeof report.generatedAt, "string");
    assert.equal(typeof report.summary.estimatedTotalNotional, "number");
    assert.equal(typeof report.account.deployableBuyingPower, "number");
  });

  test("table output renders without throwing", async () => {
    insertResearchRun({ runId: "run-table", riskProfile: "moderate", optionsEnabled: false });
    insertCandidate({
      runId: "run-table",
      symbol: "AAPL",
      rank: 1,
      estimatedMaxLoss: 60
    });
    insertMarketBar({ symbol: "AAPL", close: 100 });

    const report = await planResultFor({});
    const output = formatPaperPlanReportAsTable(report);
    assert.equal(typeof output, "string");
    assert.equal(output.includes("Paper Plan (dry-run)"), true);
    assert.equal(output.includes("Dry-run only. No orders were submitted."), true);
  });

  test("fails for live environment and disabled aggressive mode", async () => {
    insertResearchRun({ runId: "run-guard", riskProfile: "aggressive", optionsEnabled: true });
    insertCandidate({
      runId: "run-guard",
      symbol: "AAPL",
      rank: 1,
      estimatedMaxLoss: 40,
      riskProfile: "aggressive"
    });
    insertMarketBar({ symbol: "AAPL", close: 100 });

    const originalEnv = process.env.ALPACA_ENV;
    const originalLive = process.env.LIVE_TRADING_ENABLED;
    const originalAggressive = process.env.ENABLE_AGGRESSIVE_PAPER_STRATEGIES;
    try {
      process.env.ALPACA_ENV = "live";
      await assert.rejects(
        () => planResultFor({ riskProfile: "aggressive", optionsEnabled: true }),
        /paper:plan requires ALPACA_ENV=paper/
      );

      process.env.ALPACA_ENV = originalEnv;
      process.env.LIVE_TRADING_ENABLED = "true";
      await assert.rejects(
        () => planResultFor({ riskProfile: "moderate" }),
        /paper:plan requires LIVE_TRADING_ENABLED=false/
      );

      process.env.LIVE_TRADING_ENABLED = originalLive;
      process.env.ENABLE_AGGRESSIVE_PAPER_STRATEGIES = "false";
      await assert.rejects(
        () => planResultFor({ riskProfile: "aggressive" }),
        /AGGRESSIVE mode requires ENABLE_AGGRESSIVE_PAPER_STRATEGIES=true/
      );
    } finally {
      process.env.ALPACA_ENV = originalEnv;
      process.env.LIVE_TRADING_ENABLED = originalLive;
      process.env.ENABLE_AGGRESSIVE_PAPER_STRATEGIES = originalAggressive;
    }
  });

  test("does not call mutation methods", async () => {
    let nonGetRequested = false;
    const originalFetch = globalThis.fetch;
    try {
      setMockFetch(async (input, init) => {
        const method = String(init?.method || "GET").toUpperCase();
        if (method !== "GET") {
          nonGetRequested = true;
        }
        const fetcher = createMockFetcher();
        return fetcher(input, init);
      });

      insertResearchRun({ runId: "run-mutation", riskProfile: "moderate", optionsEnabled: false });
      insertCandidate({
        runId: "run-mutation",
        symbol: "AAPL",
        rank: 1,
        estimatedMaxLoss: 60
      });
      insertMarketBar({ symbol: "AAPL", close: 100 });

      await planResultFor({});
      assert.equal(nonGetRequested, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
