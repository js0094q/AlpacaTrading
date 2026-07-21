import assert from "node:assert/strict";
import test from "node:test";
import type {
  AlpacaAssetSnapshot,
  AlpacaAssetTradabilityResult
} from "../src/services/alpacaAssetService.js";

process.env.ALPACA_ENV = "paper";
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_PAPER_API_KEY = "paper-key";
process.env.ALPACA_PAPER_SECRET_KEY = "paper-secret";

const { checkAlpacaSymbolTradability, getAlpacaAsset, listAlpacaAssets } =
  await import("../src/services/alpacaAssetService.js");

const originalFetch = globalThis.fetch;

const makeResponse = (
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {}
) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: {
    get: (name: string) => {
      const key = Object.keys(headers).find((entry) => entry.toLowerCase() === name.toLowerCase());
      if (key) return headers[key];
      if (name.toLowerCase() === "x-request-id") return "alpaca-request-1";
      return null;
    }
  },
  text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload))
}) as unknown as Response;

const setMockFetch = (fetcher: (input: string, init?: RequestInit) => Promise<Response>) => {
  globalThis.fetch = async (input, init) => fetcher(String(input), init as RequestInit | undefined);
};

const assetPayload = (
  symbol: string,
  status = "active",
  tradable = true
) => ({
  id: `asset-${symbol}`,
  symbol,
  class: "us_equity",
  exchange: "NASDAQ",
  status,
  tradable,
  marginable: true,
  shortable: true,
  easy_to_borrow: true,
  fractionable: true
});

const expectedAsset = (symbol: string): AlpacaAssetSnapshot => ({
  id: `asset-${symbol}`,
  class: "us_equity",
  exchange: "NASDAQ",
  symbol,
  name: undefined,
  status: "active",
  tradable: true,
  marginable: true,
  shortable: true,
  easyToBorrow: true,
  fractionable: true,
  maintenanceMarginRequirement: undefined,
  attributes: undefined
});

const assertRejected = (
  result: AlpacaAssetTradabilityResult,
  symbol: string,
  reason: "asset_not_found" | "inactive" | "not_tradable" | "api_error"
) => {
  assert.equal(result.symbol, symbol);
  assert.equal(result.tradable, false);
  assert.equal(result.reason, reason);
};

test("maps a valid asset through the current public API", async () => {
  setMockFetch(async (input) => {
    assert.equal(input, "https://paper-api.alpaca.markets/v2/assets/AAPL");
    return makeResponse(assetPayload("AAPL"), 200, { "x-request-id": "request-valid" });
  });

  const asset = await getAlpacaAsset(" aapl ");

  assert.deepEqual(asset, { ...expectedAsset("AAPL"), requestId: "request-valid" });
  const result = await checkAlpacaSymbolTradability("AAPL");
  assert.equal(result.tradable, true);
  assert.equal(result.reason, undefined);
  assert.equal(result.asset?.symbol, "AAPL");
});

test("rejects missing, inactive, non-tradable, and API-error assets", async () => {
  setMockFetch(async (input) => {
    const symbol = input.split("/v2/assets/").pop();
    if (symbol === "MISSING") return makeResponse({ code: 40410000 }, 404);
    if (symbol === "INACTIVE") return makeResponse(assetPayload("INACTIVE", "inactive"));
    if (symbol === "NOTRADE") return makeResponse(assetPayload("NOTRADE", "active", false));
    return makeResponse({ message: "unauthorized" }, 401);
  });

  assertRejected(
    await checkAlpacaSymbolTradability("MISSING"),
    "MISSING",
    "asset_not_found"
  );
  assertRejected(
    await checkAlpacaSymbolTradability("INACTIVE"),
    "INACTIVE",
    "inactive"
  );
  assertRejected(
    await checkAlpacaSymbolTradability("NOTRADE"),
    "NOTRADE",
    "not_tradable"
  );
  assertRejected(
    await checkAlpacaSymbolTradability("BROKEN"),
    "BROKEN",
    "api_error"
  );
  assertRejected(await checkAlpacaSymbolTradability(" "), "", "asset_not_found");
});

test("maps multiple listed assets and filters entries without a symbol", async () => {
  setMockFetch(async (input) => {
    const url = new URL(input);
    assert.equal(url.pathname, "/v2/assets");
    assert.equal(url.searchParams.get("status"), "all");
    assert.equal(url.searchParams.get("asset_class"), "crypto");
    return makeResponse([
      assetPayload("AAPL"),
      assetPayload("TSLA"),
      assetPayload("")
    ], 200, { "x-request-id": "request-list" });
  });

  const assets = await listAlpacaAssets({ status: "all", assetClass: "crypto" });

  assert.deepEqual(assets.map((asset) => asset.symbol), ["AAPL", "TSLA"]);
  assert.ok(assets.every((asset) => asset.requestId === "request-list"));
  assert.equal(assets.every((asset) => asset.symbol.length > 0), true);
});

test.after(() => {
  globalThis.fetch = originalFetch;
});
