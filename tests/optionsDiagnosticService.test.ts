import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSqliteTestDb } from "./helpers/sqliteTestDb.js";

const tempDir = mkdtempSync(join(tmpdir(), "alpaca-options-diagnostic-test-"));

process.env.RESEARCH_DB_PATH = join(tempDir, "research.db");
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_ENV = "paper";
process.env.ALPACA_PAPER_API_KEY = "paper-key";
process.env.ALPACA_PAPER_SECRET_KEY = "paper-secret";
process.env.ALPACA_PAPER_BASE_URL = "https://paper-api.alpaca.markets";
process.env.ALLOW_0DTE_OPTIONS = "true";

const [
  { closeDbForTests, getDb },
  { buildOptionsDiagnosticReport },
  { toSnapshotRow }
] = await Promise.all([
  import("../src/lib/db.js"),
  import("../src/services/optionsDiagnosticService.js"),
  import("../src/services/optionsService.js")
]);

const makeMockResponse = (payload: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => {
        if (name.toLowerCase() === "x-request-id") {
          return "mock-request-id";
        }
        return null;
      }
    },
    text: async () => JSON.stringify(payload),
    json: async () => payload
  }) as unknown as Response;

const resetDatabase = () => {
  resetSqliteTestDb(getDb(), `
    DELETE FROM option_snapshots;
    DELETE FROM option_contracts;
    DELETE FROM api_request_log;
    DELETE FROM ingestion_runs;
  `);
};

const setDiagnosticFetch = (calls: string[]) => {
  globalThis.fetch = async (input: string | Request | URL) => {
    const target = String(input);
    calls.push(target);
    const contracts = [
      {
        symbol: "SPY260706C00450000",
        underlying_symbol: "SPY",
        type: "call",
        expiration_date: "2026-07-06",
        strike_price: "450",
        multiplier: "100",
        tradable: true,
        status: "active"
      },
      {
        symbol: "SPY270115C00440000",
        underlying_symbol: "SPY",
        type: "call",
        expiration_date: "2027-01-15",
        strike_price: "440",
        multiplier: "100",
        tradable: true,
        status: "active"
      },
      {
        symbol: "QQQ270115C00370000",
        underlying_symbol: "QQQ",
        type: "call",
        expiration_date: "2027-01-15",
        strike_price: "370",
        multiplier: "100",
        tradable: true,
        status: "active"
      }
    ];

    if (target.includes("/v2/options/contracts")) {
      const url = new URL(target);
      const underlyings = (url.searchParams.get("underlying_symbols") || "")
        .split(",")
        .map((entry) => entry.trim().toUpperCase())
        .filter(Boolean);
      const expirationDate = url.searchParams.get("expiration_date");
      const expirationGte = url.searchParams.get("expiration_date_gte");
      const expirationLte = url.searchParams.get("expiration_date_lte");
      return makeMockResponse({
        option_contracts: contracts.filter((contract) => {
          if (underlyings.length && !underlyings.includes(contract.underlying_symbol)) {
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
        })
      });
    }

    if (target.includes("/v1beta1/options/snapshots")) {
      const url = new URL(target);
      const symbols = (url.searchParams.get("symbols") || "")
        .split(",")
        .filter(Boolean);
      return makeMockResponse({
        snapshots: Object.fromEntries(
          symbols.map((symbol) => [
            symbol,
            {
              symbol,
              underlying_symbol: symbol.startsWith("QQQ") ? "QQQ" : "SPY",
              latest_quote: {
                t: new Date().toISOString(),
                bp: 1,
                ap: 1.1
              },
              latest_trade: {
                t: new Date().toISOString(),
                p: 1.05
              },
              Greeks: { delta: 0.7 }
            }
          ])
        )
      });
    }

    if (target.includes("/v1beta1/options/quotes/latest")) {
      const url = new URL(target);
      const symbols = (url.searchParams.get("symbols") || "")
        .split(",")
        .filter(Boolean);
      return makeMockResponse({
        quotes: Object.fromEntries(
          symbols.map((symbol) => [
            symbol,
            {
              t: new Date().toISOString(),
              bp: 1,
              ap: 1.1
            }
          ])
        )
      });
    }

    return makeMockResponse({});
  };
};

beforeEach(() => {
  resetDatabase();
});

after(() => {
  closeDbForTests();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("options diagnostic service", () => {
  test("normalizes the current Alpaca camelCase option snapshot shape", () => {
    const row = toSnapshotRow(
      "SPY270115C00805000",
      {
        greeks: {
          delta: 0.3459,
          gamma: 0.0049,
          rho: 1.2671,
          theta: -0.0986,
          vega: 2.0038
        },
        impliedVolatility: 0.1379,
        latestQuote: {
          t: "2026-07-10T19:59:59.416029802Z",
          bp: 16.4,
          ap: 16.52
        },
        latestTrade: {
          t: "2026-07-10T18:59:21.881733892Z",
          p: 16.85
        }
      } as unknown as Parameters<typeof toSnapshotRow>[1]
    );

    assert.equal(row.underlyingSymbol, "SPY");
    assert.equal(row.delta, 0.3459);
    assert.equal(row.gamma, 0.0049);
    assert.equal(row.theta, -0.0986);
    assert.equal(row.vega, 2.0038);
    assert.equal(row.rho, 1.2671);
    assert.equal(row.impliedVolatility, 0.1379);
    assert.equal(row.bid, 16.4);
    assert.equal(row.ask, 16.52);
    assert.equal(row.last, 16.85);
  });

  test("reports provider endpoints, local cache state, contract counts, and quote samples", async () => {
    const calls: string[] = [];
    setDiagnosticFetch(calls);

    const report = await buildOptionsDiagnosticReport({
      underlyings: ["SPY", "QQQ"],
      asOfDate: "2026-07-06",
      leapsMinDte: 180,
      leapsMaxDte: 730
    });

    assert.equal(report.provider, "alpaca");
    assert.equal(report.nonMutating, true);
    assert.equal(report.localCache.table, "option_contracts");
    assert.equal(report.zeroContractsReason, "LOCAL_CACHE_EMPTY_PROVIDER_HAS_CONTRACTS");
    assert.equal(report.sameDaySpy.contractsReturned, 1);
    assert.equal(report.leaps.contractsByUnderlying.SPY, 1);
    assert.equal(report.leaps.contractsByUnderlying.QQQ, 1);
    assert.equal(report.quoteAvailability.samples.length > 0, true);
    assert.equal(report.quoteAvailability.samples.every((sample) => sample.latestQuoteAvailable), true);
    assert.equal(calls.some((target) => target.includes("/v2/options/contracts")), true);
    assert.equal(calls.some((target) => target.includes("/v1beta1/options/quotes/latest")), true);
  });

  test("invalid same-day date filter is reported instead of silently returning zero", async () => {
    const calls: string[] = [];
    setDiagnosticFetch(calls);

    const report = await buildOptionsDiagnosticReport({
      underlyings: ["SPY"],
      asOfDate: "2026-99-99"
    });

    assert.match(report.zeroContractsReason || "", /INVALID_DATE_FILTER/);
    assert.equal(report.providerChecks.length, 0);
    assert.equal(calls.length, 0);
  });

  test("invalid LEAPS DTE range is reported before provider calls", async () => {
    const calls: string[] = [];
    setDiagnosticFetch(calls);

    const report = await buildOptionsDiagnosticReport({
      underlyings: ["SPY", "QQQ"],
      asOfDate: "2026-07-06",
      leapsMinDte: 730,
      leapsMaxDte: 180
    });

    assert.match(report.zeroContractsReason || "", /INVALID_DTE_RANGE/);
    assert.equal(report.providerChecks.length, 0);
    assert.equal(calls.length, 0);
  });
});
