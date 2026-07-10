import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJsonHash } from "../src/lib/canonicalJson.js";
import {
  optionDaysToExpiration,
  parseOptionSymbol
} from "../src/services/optionSymbolService.js";

test("parses a canonical OCC put symbol", () => {
  assert.deepEqual(parseOptionSymbol("SPY260116P00500000"), {
    ok: true,
    input: "SPY260116P00500000",
    normalizedSymbol: "SPY260116P00500000",
    occRoot: "SPY",
    underlying: "SPY",
    expirationDate: "2026-01-16",
    optionType: "put",
    strikeMilliunits: 500000,
    strikePrice: 500
  });
});

test("normalizes broker display spacing and lowercase", () => {
  const result = parseOptionSymbol("  spy  260116c00525000 ");

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.normalizedSymbol, "SPY260116C00525000");
    assert.equal(result.underlying, "SPY");
    assert.equal(result.optionType, "call");
    assert.equal(result.strikePrice, 525);
  }
});

test("returns a typed failure for an empty option symbol", () => {
  assert.deepEqual(parseOptionSymbol("  "), {
    ok: false,
    input: "  ",
    code: "OPTION_SYMBOL_EMPTY",
    message: "Option symbol is empty."
  });
});

test("rejects invalid OCC shape without throwing", () => {
  const result = parseOptionSymbol("SPY-CALL-500");

  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.code, "OPTION_SYMBOL_FORMAT_INVALID");
});

test("rejects invalid calendar dates without throwing", () => {
  const result = parseOptionSymbol("SPY260231C00500000");

  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.code, "OPTION_EXPIRATION_INVALID");
});

test("computes DTE from UTC calendar dates", () => {
  assert.equal(
    optionDaysToExpiration("2026-01-16", "2026-01-15T00:00:00.000Z"),
    1
  );
  assert.equal(
    optionDaysToExpiration("2026-01-16", "2026-01-15T23:59:59-05:00"),
    0
  );
});

test("returns null DTE for invalid dates", () => {
  assert.equal(optionDaysToExpiration("not-a-date", "2026-01-15T00:00:00Z"), null);
  assert.equal(optionDaysToExpiration("2026-01-16", "not-a-date"), null);
});

test("canonical hashes ignore object key insertion order", () => {
  assert.equal(
    canonicalJsonHash({ b: 2, a: { d: 4, c: 3 } }),
    canonicalJsonHash({ a: { c: 3, d: 4 }, b: 2 })
  );
});

test("canonical hashes preserve array order", () => {
  assert.notEqual(canonicalJsonHash([1, 2]), canonicalJsonHash([2, 1]));
});
