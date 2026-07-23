import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "alpaca-zero-dte-provider-"));

const environmentKeys = [
  "ALPACA_ENV",
  "LIVE_TRADING_ENABLED",
  "ALPACA_LIVE_TRADE",
  "ALPACA_PAPER_API_KEY",
  "ALPACA_PAPER_SECRET_KEY",
  "ALPACA_PAPER_BASE_URL",
  "ALPACA_DATA_BASE_URL",
  "ALPACA_REQUEST_TIMEOUT_MS",
  "ALPACA_MAX_RETRIES",
  "RESEARCH_DB_PATH"
] as const;

const previousEnvironment = new Map(
  environmentKeys.map((key) => [key, process.env[key]])
);
const originalFetch = globalThis.fetch;

Object.assign(process.env, {
  ALPACA_ENV: "paper",
  LIVE_TRADING_ENABLED: "false",
  ALPACA_LIVE_TRADE: "false",
  ALPACA_PAPER_API_KEY: "paper-test-key",
  ALPACA_PAPER_SECRET_KEY: "paper-test-secret",
  ALPACA_PAPER_BASE_URL: "https://paper-test.example",
  ALPACA_DATA_BASE_URL: "https://data-test.example",
  ALPACA_REQUEST_TIMEOUT_MS: "1000",
  ALPACA_MAX_RETRIES: "0",
  RESEARCH_DB_PATH: join(dbDir, "research.db")
});

const {
  createAlpacaZeroDteMarketDataProvider
} = await import("../src/services/zeroDte/zeroDteMarketDataService.js");
const { fetchOptionContracts } = await import("../src/services/providers/alpaca.js");
const { closeDbForTests } = await import("../src/lib/db.js");

after(() => {
  closeDbForTests();
  rmSync(dbDir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
  for (const key of environmentKeys) {
    const value = previousEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const responseFor = (body: unknown, requestId: string) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId
    }
  });

const withMockedResponses = async (
  responses: Array<{ body: unknown; requestId: string }>,
  callback: (calls: Array<{ url: string; init?: RequestInit }>) => Promise<void>
) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const response = responses[calls.length - 1];
    if (!response) {
      throw new Error(`Unexpected mocked Alpaca request ${calls.length}`);
    }
    return responseFor(response.body, response.requestId);
  }) as typeof fetch;
  try {
    await callback(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const contract = (symbol: string) => ({
  symbol,
  underlying_symbol: "SPY",
  type: "call",
  expiration_date: "2026-07-13",
  strike_price: 600,
  tradable: true
});

test("concrete 0DTE provider uses paper endpoints and preserves request IDs", async () => {
  await withMockedResponses(
    [
      {
        body: {
          bars: {
            SPY: [{
              t: "2026-07-13T13:59:00.000Z",
              o: 600,
              h: 601,
              l: 599,
              c: 600.5,
              v: 1000
            }]
          }
        },
        requestId: "bars-request-1"
      },
      {
        body: { option_contracts: [contract("SPY260713C00600000")] },
        requestId: "contracts-request-1"
      }
    ],
    async (calls) => {
      const provider = createAlpacaZeroDteMarketDataProvider();
      const barsResult = await provider.getBars(
        "SPY",
        "1Min",
        "2026-07-13T13:30:00.000Z",
        "2026-07-13T14:00:00.000Z"
      );
      assert.ok(!Array.isArray(barsResult));
      assert.deepEqual(barsResult.requestIds, ["bars-request-1"]);
      assert.equal(barsResult.bars[0]?.close, 600.5);

      const contracts = await provider.listContracts({
        underlying: "SPY",
        expirationDate: "2026-07-13",
        limit: 20
      });
      assert.equal(contracts[0]?.symbol, "SPY260713C00600000");
      assert.equal(contracts[0]?.requestId, "contracts-request-1");

      assert.equal(new URL(calls[0]!.url).origin, "https://data-test.example");
      assert.equal(new URL(calls[0]!.url).searchParams.get("feed"), "sip");
      assert.equal(new URL(calls[1]!.url).origin, "https://paper-test.example");
      for (const call of calls) {
        const headers = call.init?.headers as Record<string, string>;
        assert.equal(headers["APCA-API-KEY-ID"], "paper-test-key");
        assert.equal(headers["APCA-API-SECRET-KEY"], "paper-test-secret");
      }
    }
  );
});

test("stock snapshot provider accepts Alpaca top-level symbol maps", async () => {
  await withMockedResponses(
    [
      {
        body: {
          SPY: {
            latestTrade: { p: 601.25, t: "2026-07-14T14:00:00.000Z" },
            latestQuote: { bp: 601.2, ap: 601.3, t: "2026-07-14T14:00:00.000Z" }
          }
        },
        requestId: "stock-snapshot-request-1"
      }
    ],
    async () => {
      const provider = createAlpacaZeroDteMarketDataProvider();
      const snapshots = await provider.getStockSnapshot(["SPY"]);

      assert.equal(snapshots.SPY?.symbol, "SPY");
      assert.equal(snapshots.SPY?.latestTrade?.price, 601.25);
      assert.equal(snapshots.SPY?.latestQuote?.bid, 601.2);
      assert.equal(snapshots.SPY?.requestId, "stock-snapshot-request-1");
    }
  );
});

test("option snapshot provider reads session volume from the daily bar", async () => {
  await withMockedResponses(
    [
      {
        body: {
          snapshots: {
            SPY260713C00600000: {
              latestQuote: {
                bp: 1,
                ap: 1.1,
                t: "2026-07-13T13:59:56.000Z"
              },
              dailyBar: { v: 321 },
              greeks: { delta: 0.51, gamma: 0.03 }
            }
          }
        },
        requestId: "option-snapshot-request-1"
      }
    ],
    async () => {
      const provider = createAlpacaZeroDteMarketDataProvider();
      const snapshots = await provider.getOptionSnapshots(["SPY260713C00600000"]);

      assert.equal(snapshots.SPY260713C00600000?.volume, 321);
      assert.equal(snapshots.SPY260713C00600000?.delta, 0.51);
      assert.equal(snapshots.SPY260713C00600000?.gamma, 0.03);
      assert.equal(snapshots.SPY260713C00600000?.requestId, "option-snapshot-request-1");
    }
  );
});

test("contract pagination stops at the requested limit and keeps page request IDs", async () => {
  await withMockedResponses(
    [
      {
        body: {
          option_contracts: [contract("SPY260713C00600000")],
          next_page_token: "page-2"
        },
        requestId: "contracts-page-1"
      },
      {
        body: {
          option_contracts: [
            contract("SPY260713C00601000"),
            contract("SPY260713C00602000")
          ],
          next_page_token: "page-3"
        },
        requestId: "contracts-page-2"
      }
    ],
    async (calls) => {
      const contracts = await fetchOptionContracts({
        underlyingSymbols: ["SPY"],
        expirationDate: "2026-07-13",
        limit: 2
      });

      assert.equal(calls.length, 2);
      assert.deepEqual(
        contracts.map((entry) => entry.symbol),
        ["SPY260713C00600000", "SPY260713C00601000"]
      );
      assert.deepEqual(
        contracts.map((entry) => entry.requestId),
        ["contracts-page-1", "contracts-page-2"]
      );
      assert.equal(new URL(calls[0]!.url).searchParams.get("limit"), "2");
      assert.equal(new URL(calls[1]!.url).searchParams.get("limit"), "2");
      assert.equal(new URL(calls[1]!.url).searchParams.get("page_token"), "page-2");
    }
  );
});
