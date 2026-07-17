import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const repoRoot = "/Users/josephstewart/Documents/Alpaca Trading";

const runConfigProbe = (values: Record<string, string>) => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      [
        'import { config } from "./src/config.ts";',
        "console.log(JSON.stringify({",
        "  stockDataFeed: config.alpaca.stockDataFeed,",
        "  stockStreamUrl: config.alpaca.stockStreamUrl,",
        "  optionDataFeed: config.alpaca.optionDataFeed,",
        "  paperBaseUrl: config.alpaca.paperBaseUrl,",
        "  dataBaseUrl: config.alpaca.dataBaseUrl",
        "}));"
      ].join("\n")
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        TRADING_MODE: "paper",
        ALPACA_ENV: "paper",
        ALPACA_LIVE_TRADE: "false",
        LIVE_TRADING_ENABLED: "false",
        ALPACA_PAPER_API_KEY: "test-paper-key",
        ALPACA_PAPER_SECRET_KEY: "test-paper-secret",
        ALPACA_PAPER_BASE_URL: "https://paper-api.alpaca.markets",
        ALPACA_DATA_BASE_URL: "https://data.alpaca.markets",
        ...values
      },
      encoding: "utf8"
    }
  );

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim()) as Record<string, string>;
};

const makeResponse = (payload: unknown) => ({
  ok: true,
  status: 200,
  headers: {
    get: (name: string) =>
      name.toLowerCase() === "x-request-id" ? "market-data-test-request" : null
  },
  text: async () => JSON.stringify(payload)
}) as unknown as Response;

describe("Alpaca market-data feed configuration", () => {
  test("defaults stock REST and stream data to SIP and options to OPRA", () => {
    const resolved = runConfigProbe({
      ALPACA_STOCK_DATA_FEED: "",
      ALPACA_STOCK_STREAM_URL: "",
      ALPACA_OPTION_DATA_FEED: ""
    });

    assert.equal(resolved.stockDataFeed, "sip");
    assert.equal(resolved.stockStreamUrl, "wss://stream.data.alpaca.markets/v2/sip");
    assert.equal(resolved.optionDataFeed, "opra");
    assert.equal(resolved.paperBaseUrl, "https://paper-api.alpaca.markets");
    assert.equal(resolved.dataBaseUrl, "https://data.alpaca.markets");
  });

  test("preserves explicit feed and stream URL overrides", () => {
    const resolved = runConfigProbe({
      ALPACA_STOCK_DATA_FEED: "iex",
      ALPACA_STOCK_STREAM_URL: "wss://example.test/v2/custom",
      ALPACA_OPTION_DATA_FEED: "opra-custom"
    });

    assert.equal(resolved.stockDataFeed, "iex");
    assert.equal(resolved.stockStreamUrl, "wss://example.test/v2/custom");
    assert.equal(resolved.optionDataFeed, "opra-custom");
  });

  test("passes the centralized feeds to existing stock and option data requests", async () => {
    process.env.TRADING_MODE = "paper";
    process.env.ALPACA_ENV = "paper";
    process.env.ALPACA_LIVE_TRADE = "false";
    process.env.LIVE_TRADING_ENABLED = "false";
    process.env.ALPACA_PAPER_API_KEY = "test-paper-key";
    process.env.ALPACA_PAPER_SECRET_KEY = "test-paper-secret";
    process.env.ALPACA_PAPER_BASE_URL = "https://paper-api.alpaca.markets";
    process.env.ALPACA_DATA_BASE_URL = "https://data.alpaca.markets";
    process.env.ALPACA_STOCK_DATA_FEED = "";
    process.env.ALPACA_OPTION_DATA_FEED = "";

    const [provider, client] = await Promise.all([
      import("../src/services/providers/alpaca.js"),
      import("../src/services/alpacaClient.js")
    ]);
    const calls: string[] = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/v2/stocks/bars")) {
        return makeResponse({
          bars: {
            AAPL: [{ t: "2026-01-01T00:00:00Z", o: 1, h: 2, l: 1, c: 2, v: 10 }]
          }
        });
      }
      if (url.includes("/v1beta1/options/quotes/latest")) {
        return makeResponse({ quotes: { AAPL260101C00100000: { bp: 1, ap: 1.1 } } });
      }
      if (url.includes("/v1beta1/options/snapshots")) {
        return makeResponse({ snapshots: { AAPL260101C00100000: {} } });
      }
      if (url.includes("/v2/stocks/snapshots")) {
        return makeResponse({ snapshots: { AAPL: {} } });
      }
      return makeResponse({});
    };

    try {
      await provider.fetchAllBars({ symbols: ["AAPL"] });
      await provider.fetchOptionSnapshots(["AAPL260101C00100000"]);
      await provider.fetchOptionQuotes(["AAPL260101C00100000"]);
      await client.getLatestStockSnapshots(["AAPL"]);
      await client.getLatestOptionSnapshots(["AAPL260101C00100000"]);
      await client.getAlpacaPaperEndpoint("/v2/account");
    } finally {
      globalThis.fetch = previousFetch;
    }

    const stockUrls = calls.filter((url) =>
      url.includes("/v2/stocks/bars") || url.includes("/v2/stocks/snapshots")
    );
    const optionUrls = calls.filter((url) => url.includes("/v1beta1/options/"));
    assert.equal(stockUrls.length, 2);
    assert.equal(optionUrls.length, 3);
    assert.equal(stockUrls.every((url) => new URL(url).searchParams.get("feed") === "sip"), true);
    assert.equal(optionUrls.every((url) => new URL(url).searchParams.get("feed") === "opra"), true);
    assert.equal(calls.some((url) => url === "https://paper-api.alpaca.markets/v2/account"), true);
  });
});
