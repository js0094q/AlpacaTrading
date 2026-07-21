import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("market-data availability command is PostgreSQL-only, read-only, and registered", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["trace:market-data-availability"], "tsx scripts/traceMarketDataAvailability.ts");
  assert.equal(packageJson.scripts["build:dashboard"], "next build apps/dashboard --webpack");
  const source = readFileSync(new URL("../scripts/traceMarketDataAvailability.ts", import.meta.url), "utf8");
  assert.match(source, /fetchStockSnapshots/);
  assert.match(source, /fetchOptionSnapshots/);
  assert.match(source, /AlpacaStockStreamService/);
  assert.match(source, /getAlpacaMarketClock/);
  assert.match(source, /authenticated/);
  assert.match(source, /BEGIN READ ONLY/);
  assert.doesNotMatch(source, /submit|createOrder|paper:execute|src\/lib\/db/);
});
