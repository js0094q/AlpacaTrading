import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateBeta,
  calculateSymbolBeta
} from "../src/services/portfolioBetaService.js";
import { buildHedgeConfig } from "../src/services/hedgeConfigService.js";

test("calculates sample covariance beta from aligned close returns", () => {
  const result = calculateBeta({
    symbolCloses: [100, 102, 101, 104, 106],
    benchmarkCloses: [200, 202, 201, 203, 204],
    minimumObservations: 4
  });

  assert.equal(result.status, "calculated");
  assert.ok(result.beta !== null && Number.isFinite(result.beta));
  assert.equal(result.observations, 4);
  assert.deepEqual(result.warnings, []);
});

test("returns null when benchmark variance is zero", () => {
  const result = calculateBeta({
    symbolCloses: [10, 11, 12, 13],
    benchmarkCloses: [20, 20, 20, 20],
    minimumObservations: 3
  });

  assert.equal(result.beta, null);
  assert.equal(result.status, "unavailable");
  assert.ok(result.warnings.includes("BETA_BENCHMARK_VARIANCE_ZERO"));
});

test("returns null when aligned observations are below the minimum", () => {
  const result = calculateBeta({
    symbolCloses: [10, 11, 12],
    benchmarkCloses: [20, 21, 22],
    minimumObservations: 3
  });

  assert.equal(result.beta, null);
  assert.equal(result.observations, 2);
  assert.ok(result.warnings.includes("BETA_OBSERVATIONS_INSUFFICIENT"));
});

test("symbol beta aligns bars by UTC market date and writes calculated cache", () => {
  const defaultConfig = buildHedgeConfig();
  const config = {
    ...defaultConfig,
    beta: {
      ...defaultConfig.beta,
      minimumObservations: 5
    }
  };
  const writes: unknown[] = [];
  const bars = {
    AAPL: [100, 101, 103, 102, 105, 107],
    SPY: [200, 201, 202, 201, 203, 204]
  };
  const result = calculateSymbolBeta(
    { symbol: "AAPL", config, asOf: "2026-07-10T14:00:00Z" },
    {
      getBars: (symbol) =>
        bars[symbol as keyof typeof bars].map((close, index) => ({
          timestamp: `2026-07-${String(index + 1).padStart(2, "0")}T20:00:00Z`,
          close
        })),
      readCache: () => null,
      writeCache: (entry) => writes.push(entry)
    }
  );

  assert.equal(result.status, "calculated");
  assert.equal(result.latestMarketDataDate, "2026-07-06");
  assert.equal(writes.length, 1);
});

test("symbol beta returns a compatible cached estimate without recalculating", () => {
  const config = buildHedgeConfig();
  let writes = 0;
  const result = calculateSymbolBeta(
    { symbol: "AAPL", config, asOf: "2026-07-10T14:00:00Z" },
    {
      getBars: (symbol) => [
        { timestamp: "2026-07-08T20:00:00Z", close: symbol === "AAPL" ? 100 : 200 },
        { timestamp: "2026-07-09T20:00:00Z", close: symbol === "AAPL" ? 101 : 201 }
      ],
      readCache: (identity) => ({
        ...identity,
        beta: 1.1,
        observations: 80,
        dataStartDate: "2025-07-01",
        dataEndDate: "2026-07-09",
        status: "calculated",
        computedAt: "2026-07-09T21:00:00Z",
        expiresAt: "2026-07-10T21:00:00Z"
      }),
      writeCache: () => {
        writes += 1;
      }
    }
  );

  assert.equal(result.beta, 1.1);
  assert.equal(result.status, "cached");
  assert.equal(writes, 0);
});
