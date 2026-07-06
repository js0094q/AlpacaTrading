import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeOptionQuote,
  roundOptionLimitPrice
} from "../src/services/optionQuoteNormalizer.js";

const now = new Date("2026-07-06T15:00:00.000Z");
const freshTimestamp = "2026-07-06T14:59:00.000Z";
const maxAgeMs = 15 * 60 * 1000;

describe("option quote normalizer", () => {
  test("rejects null quote fields as unavailable", () => {
    const quote = normalizeOptionQuote({
      optionSymbol: "IWM260706C00269000",
      bid: null,
      ask: null,
      last: null,
      timestamp: freshTimestamp
    }, now, maxAgeMs);

    assert.equal(quote.quoteStatus, "missing");
    assert.equal(quote.executable, false);
    assert.equal(quote.rejectionReason, "quote_unavailable");
    assert.equal(quote.executablePrice, null);
  });

  test("uses midpoint when bid and ask are valid", () => {
    const quote = normalizeOptionQuote({
      optionSymbol: "IWM260706C00269000",
      bid: 1.2,
      ask: 1.4,
      last: 1.3,
      timestamp: freshTimestamp
    }, now, maxAgeMs);

    assert.equal(quote.quoteStatus, "valid");
    assert.equal(quote.executable, true);
    assert.equal(quote.midpoint, 1.3);
    assert.equal(quote.executablePrice, 1.3);
    assert.equal(quote.executablePriceSource, "midpoint");
  });

  test("uses ask fallback when only ask is valid", () => {
    const quote = normalizeOptionQuote({
      optionSymbol: "IWM260706C00269000",
      bid: null,
      ask: 1.5,
      last: null,
      timestamp: freshTimestamp
    }, now, maxAgeMs);

    assert.equal(quote.quoteStatus, "valid");
    assert.equal(quote.executable, true);
    assert.equal(quote.executablePrice, 1.5);
    assert.equal(quote.executablePriceSource, "askFallback");
  });

  test("rejects stale quotes", () => {
    const quote = normalizeOptionQuote({
      optionSymbol: "IWM260706C00269000",
      bid: 1.2,
      ask: 1.4,
      last: 1.3,
      timestamp: "2026-07-06T14:00:00.000Z"
    }, now, maxAgeMs);

    assert.equal(quote.quoteStatus, "stale");
    assert.equal(quote.executable, false);
    assert.equal(quote.rejectionReason, "quote_stale");
    assert.equal(quote.executablePrice, null);
  });

  test("rejects crossed quotes", () => {
    const quote = normalizeOptionQuote({
      optionSymbol: "IWM260706C00269000",
      bid: 2.0,
      ask: 1.5,
      timestamp: freshTimestamp
    }, now, maxAgeMs);

    assert.equal(quote.quoteStatus, "invalid");
    assert.equal(quote.executable, false);
    assert.equal(quote.rejectionReason, "crossed_quote");
  });

  test("uses last price only when explicitly allowed", () => {
    const blocked = normalizeOptionQuote({
      optionSymbol: "IWM260706C00269000",
      bid: null,
      ask: null,
      last: 1.1,
      timestamp: freshTimestamp
    }, now, maxAgeMs);
    const allowed = normalizeOptionQuote({
      optionSymbol: "IWM260706C00269000",
      bid: null,
      ask: null,
      last: 1.1,
      timestamp: freshTimestamp
    }, now, maxAgeMs, { allowLastPriceFallback: true });

    assert.equal(blocked.quoteStatus, "missing");
    assert.equal(blocked.executable, false);
    assert.equal(allowed.quoteStatus, "valid");
    assert.equal(allowed.executablePrice, 1.1);
    assert.equal(allowed.executablePriceSource, "last");
  });

  test("rounds option limit prices to cents", () => {
    assert.equal(roundOptionLimitPrice(1.255), 1.25);
    assert.equal(roundOptionLimitPrice(1.256), 1.26);
  });
});
