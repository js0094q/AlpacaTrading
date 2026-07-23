import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchOptionChainSnapshots,
  fetchOptionContracts
} from "../src/services/providers/alpaca.js";

const withMockedFetch = async (
  responses: Array<{ body: unknown; requestId: string }>,
  operation: (calls: string[]) => Promise<void>
) => {
  const previous = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const response = responses.shift();
    assert.ok(response, "unexpected Alpaca request");
    return new Response(JSON.stringify(response.body), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": response.requestId }
    });
  }) as typeof fetch;
  try {
    await operation(calls);
    assert.equal(responses.length, 0, "all mocked Alpaca pages must be consumed");
  } finally {
    globalThis.fetch = previous;
  }
};

test("option contract pagination consumes every Alpaca page when no result cap is requested", async () => {
  await withMockedFetch([
    {
      body: {
        option_contracts: [{ symbol: "SPY260724C00744000", expiration_date: "2026-07-24" }],
        next_page_token: "contracts-page-2"
      },
      requestId: "contracts-request-1"
    },
    {
      body: {
        option_contracts: [{ symbol: "SPY260724P00744000", expiration_date: "2026-07-24" }],
        next_page_token: null
      },
      requestId: "contracts-request-2"
    }
  ], async (calls) => {
    const contracts = await fetchOptionContracts({
      underlyingSymbols: ["SPY"],
      expirationDate: "2026-07-24",
      status: "active",
      limit: null
    });

    assert.deepEqual(contracts.map((row) => row.symbol), [
      "SPY260724C00744000",
      "SPY260724P00744000"
    ]);
    assert.deepEqual(contracts.map((row) => row.requestId), [
      "contracts-request-1",
      "contracts-request-2"
    ]);
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[0]!).searchParams.get("limit"), "1000");
    assert.equal(new URL(calls[1]!).searchParams.get("page_token"), "contracts-page-2");
  });
});

test("OPRA option-chain pagination consumes all pages, retains provenance, and deduplicates contracts", async () => {
  await withMockedFetch([
    {
      body: {
        snapshots: {
          SPY260724C00744000: {
            latestQuote: { bp: 3.1, ap: 3.2, bs: 10, as: 12, t: "2026-07-21T13:41:58.000Z" },
            impliedVolatility: 0.1663,
            greeks: { delta: 0.5276, gamma: 0.0355, theta: -0.7831, vega: 0.2686, rho: 0.0319 }
          }
        },
        next_page_token: "chain-page-2"
      },
      requestId: "chain-request-1"
    },
    {
      body: {
        snapshots: {
          SPY260724C00744000: {
            latestQuote: { bp: 3.1, ap: 3.2, bs: 10, as: 12, t: "2026-07-21T13:41:58.000Z" },
            impliedVolatility: 0.1663,
            greeks: { delta: 0.5276, gamma: 0.0355, theta: -0.7831, vega: 0.2686, rho: 0.0319 }
          },
          SPY260724P00744000: {
            latestQuote: { bp: 2.9, ap: 3, t: "2026-07-21T13:41:59.000Z" }
          }
        },
        next_page_token: null
      },
      requestId: "chain-request-2"
    }
  ], async (calls) => {
    const result = await fetchOptionChainSnapshots("spy", { feed: "opra" });

    assert.equal(result.underlyingSymbol, "SPY");
    assert.equal(result.pagesConsumed, 2);
    assert.equal(result.snapshots.length, 2);
    assert.deepEqual(result.snapshots.map((row) => row.symbol).sort(), [
      "SPY260724C00744000",
      "SPY260724P00744000"
    ]);
    const call = result.snapshots.find((row) => row.symbol === "SPY260724C00744000")!;
    assert.equal(call.requestedFeed, "opra");
    assert.equal(call.effectiveFeed, "opra");
    assert.equal(call.requestId, "chain-request-2");
    assert.equal(call.pageToken, "chain-page-2");
    assert.match(call.endpoint, /^\/v1beta1\/options\/snapshots\/SPY\?/);
    assert.ok(Number.isFinite(Date.parse(call.retrievedAt)));
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[0]!).searchParams.get("feed"), "opra");
    assert.equal(new URL(calls[0]!).searchParams.get("limit"), "1000");
    assert.equal(new URL(calls[1]!).searchParams.get("page_token"), "chain-page-2");
  });
});

test("OPRA option-chain pagination rejects conflicting material evidence for one contract", async () => {
  await withMockedFetch([
    {
      body: {
        snapshots: {
          SPY260724C00744000: {
            latestQuote: { bp: 3.1, ap: 3.2, t: "2026-07-21T13:41:58.000Z" },
            impliedVolatility: 0.1663
          }
        },
        next_page_token: "chain-page-2"
      },
      requestId: "chain-request-1"
    },
    {
      body: {
        snapshots: {
          SPY260724C00744000: {
            latestQuote: { bp: 3.1, ap: 3.2, t: "2026-07-21T13:41:58.000Z" },
            impliedVolatility: 0.2663
          }
        },
        next_page_token: null
      },
      requestId: "chain-request-2"
    }
  ], async () => {
    await assert.rejects(
      fetchOptionChainSnapshots("SPY", { feed: "opra" }),
      /ALPACA_OPTION_CHAIN_DUPLICATE_CONFLICT:SPY260724C00744000/
    );
  });
});
