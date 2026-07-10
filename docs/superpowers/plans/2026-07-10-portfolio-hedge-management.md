# Portfolio Risk and Hedge Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only, paper-only portfolio-risk and hedge-management framework on `paper-ops-layer` without exposing or invoking order submission.

**Architecture:** Normalize account and position evidence into a versioned risk snapshot, compute compatible cached betas and a deterministic market regime, then feed those facts into an explainable score and a modeled-loss protection recommendation. Persist recommendations and signed plans through additive SQLite state and `paper_learning_records`; expose only cached, authenticated read surfaces to the scheduler, CLI, bridge, and dashboard.

**Tech Stack:** TypeScript 5, Node.js 26, `node:sqlite`, `node:test`, Alpaca paper read APIs, Next.js 16 App Router, React 19.

## Global Constraints

- Implementation baseline is `paper-ops-layer`; do not merge into `main`.
- This phase is read-only and paper-only; no paper or live orders may be submitted.
- Do not add or run `hedge:execute`.
- `HEDGE_PAPER_EXECUTION_ENABLED=false` remains the fail-closed default.
- Do not import a broker order-submission method into any hedge service.
- Put spreads remain non-executable with `MULTI_LEG_EXECUTION_UNSUPPORTED`.
- Missing Greeks, prices, betas, sectors, or market evidence remain `null` with warnings, monitoring, or blockers.
- Preserve existing authentication, runtime preflight, payload integrity, freshness, duplicate protection, request/correlation IDs, and redaction.
- Beta cache compatibility includes symbol, benchmark, lookback, observation interval, minimum observations, calculation version, and latest aligned market-data date.
- Persisted recommendations retain generation and expiration timestamps, environment, source snapshot ID, risk/regime versions, configuration fingerprint, data-quality and recommendation status, and reviewed-payload hash after planning.
- Expired or stale dashboard records are never presented as current.
- Use additive SQLite migrations only.
- Run `npm run lint`, `npm test`, `npm run typecheck`, `npm run build`, and `npm run dashboard:build` before completion.

---

## File Structure

### New source files

- `src/lib/canonicalJson.ts`: recursive key sorting and SHA-256 canonical JSON hashes.
- `src/services/optionSymbolService.ts`: canonical OCC parse result and UTC DTE helper.
- `src/services/hedgeTypes.ts`: versioned shared types for risk, regime, score, recommendations, and plans.
- `src/services/hedgeConfigService.ts`: validated non-secret hedge configuration and fingerprint.
- `src/services/hedgePersistenceService.ts`: high-water marks, beta cache, recommendation/plan learning records, and effective freshness.
- `src/services/portfolioBetaService.ts`: aligned-return beta calculation and cache use.
- `src/services/marketRegimeService.ts`: deterministic indicator derivation and first-match classification.
- `src/services/portfolioRiskService.ts`: normalized positions, aggregate exposures, concentration, scenarios, and quality.
- `src/services/portfolioRiskScoreService.ts`: ten-component 100-point score.
- `src/services/hedgeRecommendationService.ts`: decision priority, LEAPS analysis, protection offsets, candidate ranking, and sizing.
- `src/services/hedgePlanService.ts`: signed, expiring, non-executable paper plan artifacts.
- `src/services/hedgeLearningService.ts`: recommendation/plan ledger orchestration.
- `src/services/hedgeExecutionGateService.ts`: pure fail-closed future authorization decision.

### New tests

- `tests/optionSymbolService.test.ts`
- `tests/hedgePersistenceService.test.ts`
- `tests/portfolioBetaService.test.ts`
- `tests/marketRegimeService.test.ts`
- `tests/portfolioRiskService.test.ts`
- `tests/portfolioRiskScoreService.test.ts`
- `tests/hedgeRecommendationService.test.ts`
- `tests/hedgePlanService.test.ts`
- `tests/hedgeCli.test.ts`
- `tests/hedgeDashboard.test.ts`

### Existing files to modify

- `src/lib/db.ts`: additive high-water and beta-cache tables.
- `src/config.ts`: expose validated hedge configuration.
- `src/services/paperReviewArtifactService.ts`: use the shared canonical hash without changing artifact contracts.
- `src/services/assetIdentity.ts`: use canonical option parsing.
- `src/services/leapsExitReviewService.ts`: use canonical parsing and UTC DTE.
- `src/services/paperPortfolioReviewService.ts`: use canonical parsing.
- `src/services/paperExecuteDryRunService.ts`: use canonical DTE.
- `src/services/paperLearningLedgerService.ts`: recognize `portfolio_hedge` records without promoting them.
- `src/services/paperOpsWorkflowService.ts`: persist a read-only hedge review during existing moments.
- `src/cli.ts`: add four read-only hedge commands.
- `package.json`: add four scripts and the new sequential tests; do not add `hedge:execute`.
- `server/dashboard-control/server.ts`: add authenticated GET-only cached hedge endpoints.
- `apps/dashboard/lib/data.ts`: carry the cached hedge payload through local and bridge snapshots.
- `apps/dashboard/app/page.tsx`: render status, risk, scenarios, regime, LEAPS logic, and candidates.
- `apps/dashboard/app/globals.css`: status styles for current, monitoring, stale, expired, and blocked.
- `apps/dashboard/app/api/paper/hedge/risk/route.ts`: guarded GET.
- `apps/dashboard/app/api/paper/hedge/regime/route.ts`: guarded GET.
- `apps/dashboard/app/api/paper/hedge/recommendation/route.ts`: guarded GET.
- `.env.example`, `README.md`, `RESUME_CONTEXT.md`, `server/README.md`, `server/RESUME_CONTEXT.md`: commands, safe defaults, persistence, and operational boundaries.

---

### Task 1: Canonical option parsing and hashing

**Files:**

- Create: `src/lib/canonicalJson.ts`
- Create: `src/services/optionSymbolService.ts`
- Create: `tests/optionSymbolService.test.ts`
- Modify: `src/services/paperReviewArtifactService.ts`
- Modify: `src/services/assetIdentity.ts`
- Modify: `src/services/leapsExitReviewService.ts`
- Modify: `src/services/paperPortfolioReviewService.ts`
- Modify: `src/services/paperExecuteDryRunService.ts`
- Modify: `package.json`

**Interfaces:**

- Produces: `canonicalizeJson(value: unknown): unknown`, `canonicalJsonHash(value: unknown): string`.
- Produces: `parseOptionSymbol(input: string): OptionSymbolParseResult`.
- Produces: `optionDaysToExpiration(expirationDate: string, asOf: string): number | null`.
- Existing option callers retain their current output shape and receive `null`/non-option behavior on parse failure.

- [ ] **Step 1: Write parser and canonical-hash tests**

```ts
test("parses a canonical OCC symbol", () => {
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

test("rejects invalid calendar dates without throwing", () => {
  const result = parseOptionSymbol("SPY260231C00500000");
  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.code, "OPTION_EXPIRATION_INVALID");
});

test("computes DTE at UTC date boundaries", () => {
  assert.equal(optionDaysToExpiration("2026-01-16", "2026-01-15T23:59:59-05:00"), 0);
  assert.equal(optionDaysToExpiration("2026-01-16", "2026-01-15T00:00:00Z"), 1);
});

test("canonical hashes ignore object key insertion order", () => {
  assert.equal(canonicalJsonHash({ b: 2, a: 1 }), canonicalJsonHash({ a: 1, b: 2 }));
});
```

- [ ] **Step 2: Run tests and verify the missing-module failure**

Run: `npx tsx --test tests/optionSymbolService.test.ts`

Expected: FAIL because `optionSymbolService.ts` and `canonicalJson.ts` do not exist.

- [ ] **Step 3: Implement the canonical helpers**

```ts
export const parseOptionSymbol = (input: string): OptionSymbolParseResult => {
  const normalizedSymbol = String(input || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!normalizedSymbol) return failure(input, "OPTION_SYMBOL_EMPTY", "Option symbol is empty.");
  const match = normalizedSymbol.match(/^([A-Z0-9]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!match) return failure(input, "OPTION_SYMBOL_FORMAT_INVALID", "Option symbol is not valid OCC format.");
  const [, root, yy, mm, dd, marker, strikeRaw] = match;
  const year = 2000 + Number(yy);
  const month = Number(mm);
  const day = Number(dd);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    return failure(input, "OPTION_EXPIRATION_INVALID", "Option expiration is not a real calendar date.");
  }
  const strikeMilliunits = Number(strikeRaw);
  if (!Number.isSafeInteger(strikeMilliunits)) {
    return failure(input, "OPTION_STRIKE_INVALID", "Option strike is invalid.");
  }
  return {
    ok: true,
    input,
    normalizedSymbol,
    occRoot: root,
    underlying: root,
    expirationDate: `${year}-${mm}-${dd}`,
    optionType: marker === "C" ? "call" : "put",
    strikeMilliunits,
    strikePrice: strikeMilliunits / 1000
  };
};
```

```ts
export const canonicalizeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeJson(entry)])
  );
};

export const canonicalJsonHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(canonicalizeJson(value))).digest("hex");
```

- [ ] **Step 4: Replace local option parsing and preserve regression behavior**

Import `parseOptionSymbol` and `optionDaysToExpiration` into the four option callers. Map successful results into their existing local metadata; on `ok: false`, preserve each caller's existing non-option or `null` result. Replace `reviewedPayloadSignature` internals with `canonicalJsonHash(sections)` and retain its exported name.

```ts
export const reviewedPayloadSignature = (sections: ReviewedPayloadSections) =>
  canonicalJsonHash(sections);
```

- [ ] **Step 5: Run focused parser and existing regression tests**

Run: `npx tsx --test tests/optionSymbolService.test.ts tests/leapsExitReviewService.test.ts tests/paperPortfolioReviewService.test.ts tests/paperExecuteDryRunService.test.ts tests/paperReviewedPayloadExecutionService.test.ts`

Expected: PASS with unchanged reviewed-artifact signatures for semantically identical payloads.

- [ ] **Step 6: Commit**

```bash
git add src/lib/canonicalJson.ts src/services/optionSymbolService.ts src/services/paperReviewArtifactService.ts src/services/assetIdentity.ts src/services/leapsExitReviewService.ts src/services/paperPortfolioReviewService.ts src/services/paperExecuteDryRunService.ts tests/optionSymbolService.test.ts package.json
git commit -m "Add canonical option symbol parsing"
```

### Task 2: Hedge types, validated configuration, and additive persistence

**Files:**

- Create: `src/services/hedgeTypes.ts`
- Create: `src/services/hedgeConfigService.ts`
- Create: `src/services/hedgePersistenceService.ts`
- Create: `tests/hedgePersistenceService.test.ts`
- Modify: `src/config.ts`
- Modify: `src/lib/db.ts`
- Modify: `src/services/paperLearningLedgerService.ts`
- Modify: `package.json`

**Interfaces:**

- Produces: `buildHedgeConfig(): HedgeConfig` and `hedgeConfigurationFingerprint(config?: HedgeConfig): string`.
- Produces: `readCompatibleBetaCache`, `writeBetaCache`, `observePortfolioHighWaterMark`.
- Produces: `persistHedgeRecommendation`, `latestHedgeRecommendation`, `attachReviewedPayloadHash`, `persistHedgePlanRecord`.
- Consumes: `canonicalJsonHash` from Task 1.

- [ ] **Step 1: Write persistence compatibility and freshness tests**

```ts
test("beta cache requires every identity input and latest aligned date", () => {
  writeBetaCache({ ...identity, beta: 1.2, observations: 80, computedAt: now, expiresAt: later });
  assert.equal(readCompatibleBetaCache(identity, now)?.beta, 1.2);
  assert.equal(readCompatibleBetaCache({ ...identity, benchmark: "QQQ" }, now), null);
  assert.equal(readCompatibleBetaCache({ ...identity, minimumObservations: 81 }, now), null);
  assert.equal(readCompatibleBetaCache({ ...identity, latestMarketDataDate: "2026-07-10" }, now), null);
});

test("recommendation reads derive expired and stale status", () => {
  persistHedgeRecommendation(recommendation);
  assert.equal(latestHedgeRecommendation({ asOf: recommendation.expiresAt }).effectiveStatus, "current");
  assert.equal(latestHedgeRecommendation({ asOf: "2026-07-11T00:00:00.000Z" }).effectiveStatus, "expired");
});

test("malformed or incomplete recommendation rows are not current", () => {
  insertMalformedPortfolioHedgeLearningRow(testDb);
  assert.notEqual(latestHedgeRecommendation({ asOf: now })?.effectiveStatus, "current");
});
```

- [ ] **Step 2: Run the persistence test and verify failure**

Run: `npx tsx --test tests/hedgePersistenceService.test.ts`

Expected: FAIL because the schema and service do not exist.

- [ ] **Step 3: Add additive SQLite tables with complete beta identity**

```sql
CREATE TABLE IF NOT EXISTS portfolio_high_water_marks (
  environment TEXT PRIMARY KEY,
  equity REAL NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS portfolio_beta_cache (
  symbol TEXT NOT NULL,
  benchmark TEXT NOT NULL,
  lookback_days INTEGER NOT NULL,
  observation_interval TEXT NOT NULL,
  minimum_observations INTEGER NOT NULL,
  calculation_version TEXT NOT NULL,
  latest_market_data_date TEXT NOT NULL,
  beta REAL,
  observations INTEGER NOT NULL,
  data_start_date TEXT,
  data_end_date TEXT,
  status TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (
    symbol, benchmark, lookback_days, observation_interval,
    minimum_observations, calculation_version, latest_market_data_date
  )
);
```

- [ ] **Step 4: Define shared versions, statuses, and validated configuration**

```ts
export const HEDGE_RISK_MODEL_VERSION = "portfolio-risk-v1";
export const HEDGE_REGIME_MODEL_VERSION = "market-regime-v1";
export const HEDGE_PLAN_VERSION = "hedge-plan-v1";
export type HedgeDataQualityStatus = "complete" | "partial" | "monitoring" | "blocked";
export type HedgeRecommendationStatus = "current" | "monitoring" | "blocked" | "stale" | "expired";
export type MarketRegime = "insufficient-data" | "crisis" | "risk-off" | "transition" | "risk-on" | "neutral";
```

`buildHedgeConfig` must clamp positive durations/counts, ratios to `[0,1]`, and reject invalid sector-map JSON to an empty map plus `HEDGE_SECTOR_MAP_INVALID` warning. The fingerprint hashes only normalized non-secret settings. Include exact defaults: execution disabled, 252 beta lookback days, 60 minimum observations, `1Day`, 24-hour cache TTL, 30-minute recommendation TTL, 15-minute freshness, 30-minute plan TTL, `SPY` beta benchmark, `VIXY` volatility proxy, 20% LEAPS spread cap, 365 LEAPS minimum DTE, 35% LEAPS concentration threshold, 25% profit allocation, and 1% NAV premium cap.

- [ ] **Step 5: Implement high-water, beta cache, and learning-record persistence**

Use parameterized statements. Store recommendation/plan envelopes as canonical JSON in `signal_inputs_json`, `strategy_family='portfolio_hedge'`, `promotion_eligible=0`, and `promotion_block_reason='HEDGE_EXECUTION_NOT_IMPLEMENTED'`. Validate every mandatory integrity field on read. Update the recommendation JSON when `attachReviewedPayloadHash` is called. Never expose raw account IDs; store the already-hashed portfolio snapshot ID.

```ts
const mandatory = [
  payload.generatedAt,
  payload.expiresAt,
  payload.environment,
  payload.sourceSnapshotId,
  payload.riskModelVersion,
  payload.regimeModelVersion,
  payload.configurationFingerprint,
  payload.dataQualityStatus,
  payload.recommendationStatus
];
if (mandatory.some((value) => typeof value !== "string" || value.length === 0)) {
  return { ...record, effectiveStatus: "blocked", integrityWarnings: ["HEDGE_RECOMMENDATION_INTEGRITY_INVALID"] };
}
```

- [ ] **Step 6: Extend the learning type without making hedge records promotable**

Add `portfolio_hedge` to `PaperStrategyFamily`; exclude it from promotion analytics that are explicitly limited to zero-DTE and LEAPS. Do not change existing counts or thresholds.

- [ ] **Step 7: Run focused persistence and learning tests**

Run: `npx tsx --test tests/hedgePersistenceService.test.ts tests/paperLearningLedgerService.test.ts`

Expected: PASS, including cache invalidation and stale/expired recommendation integrity.

- [ ] **Step 8: Commit**

```bash
git add src/services/hedgeTypes.ts src/services/hedgeConfigService.ts src/services/hedgePersistenceService.ts src/config.ts src/lib/db.ts src/services/paperLearningLedgerService.ts tests/hedgePersistenceService.test.ts package.json
git commit -m "Add hedge configuration and persistence"
```

### Task 3: Portfolio beta and deterministic market regime

**Files:**

- Create: `src/services/portfolioBetaService.ts`
- Create: `src/services/marketRegimeService.ts`
- Create: `tests/portfolioBetaService.test.ts`
- Create: `tests/marketRegimeService.test.ts`
- Modify: `package.json`

**Interfaces:**

- Produces: `calculateBeta(input: BetaSeriesInput): BetaCalculationResult`.
- Produces: `portfolioBetaForSymbols(input): Record<string, PositionBetaResult>`.
- Produces: `classifyMarketRegime(input?: MarketRegimeInput): MarketRegimeSnapshot`.
- Consumes: `getBars`, `buildHedgeConfig`, and beta-cache functions.

- [ ] **Step 1: Write beta math and cache-path tests**

```ts
test("calculates sample covariance beta from aligned returns", () => {
  const result = calculateBeta({ symbolCloses: [100, 102, 101, 104], benchmarkCloses: [200, 202, 201, 203] });
  assert.equal(result.status, "calculated");
  assert.ok(result.beta !== null && Number.isFinite(result.beta));
  assert.equal(result.observations, 3);
});

test("returns null when benchmark variance is zero", () => {
  assert.deepEqual(calculateBeta({ symbolCloses: [10, 11, 12], benchmarkCloses: [20, 20, 20] }).beta, null);
});
```

- [ ] **Step 2: Write regime priority tests**

```ts
test("crisis wins before risk-off", () => {
  const result = classifyMarketRegimeFromIndicators({ ...riskOffIndicators, spyBelowSma50Pct: 0.11 });
  assert.equal(result.regime, "crisis");
  assert.equal(result.selectedRule, "CRISIS_SPY_BELOW_SMA50");
});

test("missing required SPY history returns insufficient-data", () => {
  const result = classifyMarketRegimeFromBars({ SPY: [], QQQ: sufficientQqqBars, VIXY: [] }, config, now);
  assert.equal(result.regime, "insufficient-data");
  assert.ok(result.warnings.includes("REGIME_SPY_HISTORY_INSUFFICIENT"));
});
```

- [ ] **Step 3: Run both tests and verify failure**

Run: `npx tsx --test tests/portfolioBetaService.test.ts tests/marketRegimeService.test.ts`

Expected: FAIL because both services are missing.

- [ ] **Step 4: Implement aligned-return beta and exact compatible cache lookup**

Align observations by the UTC `YYYY-MM-DD` date of persisted bars, use simple close-to-close returns, sample covariance divided by sample variance, and the complete cache identity. Ignore cache results when current latest aligned date changes. Return `null` with `BETA_OBSERVATIONS_INSUFFICIENT` or `BETA_BENCHMARK_VARIANCE_ZERO`; do not substitute zero.

```ts
const covariance = products.reduce((sum, value) => sum + value, 0) / (n - 1);
const variance = benchmarkSquared.reduce((sum, value) => sum + value, 0) / (n - 1);
return variance > 0
  ? { beta: covariance / variance, observations: n, status: "calculated", warnings: [] }
  : { beta: null, observations: n, status: "unavailable", warnings: ["BETA_BENCHMARK_VARIANCE_ZERO"] };
```

- [ ] **Step 5: Implement deterministic regime derivation and first-match priority**

Calculate SMA50, SMA200, 20-day realized volatility, and 20-day maximum drawdown from persisted `1Day` bars. Treat SPY and QQQ history as required and volatility-proxy evidence as optional. Apply this priority exactly: insufficient data, crisis, risk-off, transition, risk-on, neutral. Return all measured inputs, selected rule, model version, warnings, and blockers.

- [ ] **Step 6: Run focused tests**

Run: `npx tsx --test tests/portfolioBetaService.test.ts tests/marketRegimeService.test.ts tests/research.test.ts`

Expected: PASS with no market-bar ingestion regression.

- [ ] **Step 7: Commit**

```bash
git add src/services/portfolioBetaService.ts src/services/marketRegimeService.ts tests/portfolioBetaService.test.ts tests/marketRegimeService.test.ts package.json
git commit -m "Add portfolio beta and market regime models"
```

### Task 4: Normalized portfolio risk and explainable scoring

**Files:**

- Create: `src/services/portfolioRiskService.ts`
- Create: `src/services/portfolioRiskScoreService.ts`
- Create: `tests/portfolioRiskService.test.ts`
- Create: `tests/portfolioRiskScoreService.test.ts`
- Modify: `package.json`

**Interfaces:**

- Produces: `buildPortfolioRiskSnapshot(input?, deps?): Promise<PortfolioRiskSnapshot>`.
- Produces: `normalizePortfolioEvidence(account, positions, evidence, config, asOf): PortfolioRiskSnapshot` for deterministic tests.
- Produces: `scorePortfolioRisk(snapshot, regime): PortfolioRiskScore`.
- Consumes: canonical option parsing, beta results, high-water marks, account/position read services, option snapshots/contracts, and market bars.

- [ ] **Step 1: Write normalization, missing-data, concentration, and scenario tests**

```ts
test("uses observed option delta and multiplier for signed exposure", () => {
  const result = normalizePortfolioEvidence(account, [longCall], evidenceWithDelta(0.6, 100, 500), config, now);
  assert.equal(result.positions[0]?.deltaEquivalentShares, 60);
  assert.equal(result.positions[0]?.deltaAdjustedExposure, 30_000);
});

test("does not fabricate missing option Greeks", () => {
  const result = normalizePortfolioEvidence(account, [longCall], evidenceWithoutGreeks, config, now);
  assert.equal(result.positions[0]?.deltaAdjustedExposure, null);
  assert.ok(result.positions[0]?.warnings.includes("OPTION_DELTA_UNAVAILABLE"));
});

test("long puts and inverse beta reduce scenario loss", () => {
  const result = normalizePortfolioEvidence(account, [longEquity, longPut, inverseEquity], completeEvidence, config, now);
  assert.ok(result.scenarios.find((row) => row.benchmarkDeclinePct === 10)!.existingProtection > 0);
});
```

- [ ] **Step 2: Write exact 100-point component tests**

```ts
test("caps the ten score components at 100", () => {
  const score = scorePortfolioRisk(maxRiskSnapshot, crisisRegime);
  assert.equal(score.total, 100);
  assert.deepEqual(score.components.map((row) => row.maximum), [15, 15, 15, 10, 10, 8, 7, 8, 7, 5]);
  assert.equal(score.band, "critical");
});

test("missing beta adds quality risk but not a fabricated beta score", () => {
  const score = scorePortfolioRisk({ ...baseSnapshot, portfolioBeta: null, dataQualityStatus: "partial" }, neutralRegime);
  assert.equal(score.components.find((row) => row.key === "betaAdjustedExposure")?.points, 0);
  assert.equal(score.components.find((row) => row.key === "dataQuality")?.points, 2);
});
```

- [ ] **Step 3: Run tests and verify failure**

Run: `npx tsx --test tests/portfolioRiskService.test.ts tests/portfolioRiskScoreService.test.ts`

Expected: FAIL because risk and scoring services are missing.

- [ ] **Step 4: Implement normalized positions and quality coverage**

Query the latest option snapshot and contract per held option, latest underlying close, configured sector map, and compatible betas. Parse numeric broker strings with a finite-number helper. Preserve signed quantity and market value. Group concentration by underlying. Classify SH and PSQ as inverse instruments, but use calculated beta for risk; no fixed beta enters the snapshot.

```ts
const deltaEquivalentShares =
  delta === null || multiplier === null ? null : quantity * multiplier * delta;
const deltaAdjustedExposure =
  deltaEquivalentShares === null || underlyingPrice === null
    ? null
    : deltaEquivalentShares * underlyingPrice;
```

- [ ] **Step 5: Implement scenario sensitivity and high-water drawdown**

Evaluate benchmark declines `[5, 8, 10, 15]`. Use signed beta exposure for first-order P/L and observed gamma for second-order option P/L. Track gross loss, existing measured protection from negative contributors, net modeled loss, coverage, and warnings. Update the paper high-water mark only from positive observed equity and compute drawdown against the non-decreasing mark.

- [ ] **Step 6: Implement all score thresholds and rationales**

Use these deterministic thresholds:

- gross exposure: `<=1=0`, `<=1.25=5`, `<=1.5=10`, otherwise `15`;
- absolute portfolio beta: `null=0`, `<=0.8=0`, `<=1=5`, `<=1.25=10`, otherwise `15`;
- absolute option delta exposure/equity: `<=0.1=0`, `<=0.25=5`, `<=0.5=10`, otherwise `15`;
- positive option delta/equity: `<=0.1=0`, `<=0.25=4`, `<=0.4=7`, otherwise `10`;
- largest underlying weight: `<=0.1=0`, `<=0.15=3`, `<=0.25=6`, otherwise `10`;
- top-five weight: `<=0.4=0`, `<=0.55=3`, `<=0.7=5`, otherwise `8`;
- near/clustered expiration exposure: `<=0.1=0`, `<=0.25=3`, `<=0.4=5`, otherwise `7`;
- drawdown: `<=0.03=0`, `<=0.05=2`, `<=0.1=5`, otherwise `8`;
- regime: risk-on `0`, neutral `1`, transition/insufficient `3`, risk-off `5`, crisis `7`;
- quality: complete `0`, partial `2`, monitoring `4`, blocked `5`.

Return measured value, thresholds, points, maximum, rationale, and quality for each component.

- [ ] **Step 7: Run focused tests**

Run: `npx tsx --test tests/portfolioRiskService.test.ts tests/portfolioRiskScoreService.test.ts tests/portfolioBetaService.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/services/portfolioRiskService.ts src/services/portfolioRiskScoreService.ts tests/portfolioRiskService.test.ts tests/portfolioRiskScoreService.test.ts package.json
git commit -m "Add normalized portfolio risk scoring"
```

### Task 5: Hedge decisions, LEAPS logic, and modeled-loss sizing

**Files:**

- Create: `src/services/hedgeRecommendationService.ts`
- Create: `tests/hedgeRecommendationService.test.ts`
- Modify: `package.json`

**Interfaces:**

- Produces: `buildHedgeRecommendation(input, deps?): Promise<HedgeRecommendation>`.
- Produces: `recommendHedgeFromEvidence(risk, regime, score, optionCandidates, config): HedgeRecommendation`.
- Consumes: risk, regime, score, persisted option contracts/snapshots, and config.

- [ ] **Step 1: Write decision-priority and existing-protection tests**

```ts
test("blocks before selecting an instrument when the risk snapshot is blocked", () => {
  const result = recommendHedgeFromEvidence(blockedRisk, neutralRegime, score, [], config);
  assert.equal(result.recommendationStatus, "blocked");
  assert.equal(result.candidates.length, 0);
});

test("subtracts measured puts and inverse exposure from the protection target", () => {
  const result = recommendHedgeFromEvidence(protectedRisk, riskOffRegime, highScore, optionRows, config);
  assert.equal(result.sizing.netProtectionTarget, 0);
  assert.equal(result.decision, "existing_protection_sufficient");
});
```

- [ ] **Step 2: Write LEAPS, put-spread, and tactical-alternative tests**

```ts
test("prefers a profitable concentrated LEAPS trim before paid protection", () => {
  const result = recommendHedgeFromEvidence(leapsHeavyRisk, transitionRegime, elevatedScore, putRows, config);
  assert.equal(result.decision, "trim_leaps_then_protect");
  assert.ok(result.leaps.trimRecommendations.length > 0);
  assert.equal(result.leaps.profitFundedPremiumBudget, 2_500);
});

test("put spreads are always non-executable", () => {
  const spread = recommendHedgeFromEvidence(unprotectedRisk, riskOffRegime, highScore, putRows, config)
    .candidates.find((row) => row.instrumentType === "put_spread");
  assert.ok(spread?.blockers.includes("MULTI_LEG_EXECUTION_UNSUPPORTED"));
  assert.equal(spread?.executable, false);
});
```

- [ ] **Step 3: Run the test and verify failure**

Run: `npx tsx --test tests/hedgeRecommendationService.test.ts`

Expected: FAIL because the recommendation service is missing.

- [ ] **Step 4: Implement target scenario and protection percentage selection**

Use the 5% scenario for transition, 10% for risk-off, 15% for crisis, and 8% otherwise. Use score-band protection defaults: moderate 25%, elevated 35%, high 50%, critical 65%, low 0%. Calculate gross target from modeled loss, subtract existing protection, and report residual protection.

```ts
const grossProtectionTarget = modeledLoss * targetProtectionPct;
const netProtectionTarget = Math.max(0, grossProtectionTarget - scenario.existingProtection);
```

- [ ] **Step 5: Implement deterministic LEAPS and profit-funded logic**

Use canonical call metadata and configured minimum DTE. Rank trims by positive delta exposure, concentration, and observed unrealized gain. Cap the recommendation budget by both `max(0, unrealizedGain) * profitAllocation` and `equity * premiumNavCap`. Label it an unrealized-gain proxy; do not claim realized proceeds. Cross-reference existing LEAPS exit recommendation codes when supplied in risk evidence.

- [ ] **Step 6: Implement candidate discovery and sizing**

Rank observed SPY/QQQ puts by usable quote, spread, DTE, negative delta, and payoff per premium. Calculate terminal put payoff at the selected decline and contract count from net protection, capped by premium budget. Pair puts by expiration to analyze debit spreads, but mark every spread non-executable. Add SH and PSQ secondary candidates using latest observed price and a disclosed one-day inverse relationship assumption; do not write that assumption back into portfolio beta.

- [ ] **Step 7: Run recommendation tests**

Run: `npx tsx --test tests/hedgeRecommendationService.test.ts tests/portfolioRiskService.test.ts tests/leapsExitReviewService.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/services/hedgeRecommendationService.ts tests/hedgeRecommendationService.test.ts package.json
git commit -m "Add explainable hedge recommendations"
```

### Task 6: Signed planning, learning records, and fail-closed future gate

**Files:**

- Create: `src/services/hedgePlanService.ts`
- Create: `src/services/hedgeLearningService.ts`
- Create: `src/services/hedgeExecutionGateService.ts`
- Create: `tests/hedgePlanService.test.ts`
- Modify: `src/services/hedgePersistenceService.ts`
- Modify: `package.json`

**Interfaces:**

- Produces: `createHedgePlan(input): HedgePlanArtifact` and `verifyHedgePlan(input): HedgePlanVerification`.
- Produces: `buildAndPersistHedgeReview(input?, deps?): Promise<HedgeReviewReport>`.
- Produces: `evaluateHedgeExecutionGate(input): HedgeExecutionGateResult`.
- Consumes: canonical hashes, recommendation persistence, risk/regime/score/recommendation services.

- [ ] **Step 1: Write plan-integrity and fail-closed tests**

```ts
test("creates and verifies a signed expiring paper-only plan", () => {
  const artifact = createHedgePlan({ recommendation, paperOnly: true, createdAt: now, config });
  assert.equal(verifyHedgePlan({ artifact, asOf: now, sourceSnapshotId: recommendation.sourceSnapshotId, configurationFingerprint: recommendation.configurationFingerprint }).valid, true);
  assert.equal(artifact.reviewedPayloadHash, artifact.payloadSignature);
  assert.equal("brokerOrderPayload" in artifact, false);
});

test("rejects expiry, hash mismatch, source mismatch, and config mismatch", () => {
  const artifact = createHedgePlan({ recommendation, paperOnly: true, createdAt: now, config });
  assert.ok(verifyHedgePlan({ artifact, asOf: afterExpiry, sourceSnapshotId: "other", configurationFingerprint: "other" }).blockers.length >= 3);
});

test("future execution gate remains unimplemented even when flags are true", () => {
  const result = evaluateHedgeExecutionGate(allFutureGatesSatisfied);
  assert.equal(result.allowed, false);
  assert.ok(result.blockers.includes("HEDGE_EXECUTION_NOT_IMPLEMENTED"));
});
```

- [ ] **Step 2: Run the plan test and verify failure**

Run: `npx tsx --test tests/hedgePlanService.test.ts`

Expected: FAIL because the services are missing.

- [ ] **Step 3: Implement signed, expiring planning artifacts**

Build a `reviewedPayload` containing recommendation ID, source snapshot, risk/regime versions, configuration fingerprint, quality/status, sizing, candidates, and blockers. Hash it with `canonicalJsonHash`; store the same value as `reviewedPayloadHash` and `payloadSignature`. Verify canonical hash, paper environment, timestamps, source snapshot, config, and model versions. The artifact contains no side, quantity submission payload, client order ID, or reviewed executor section.

- [ ] **Step 4: Implement review orchestration and learning writes**

`buildAndPersistHedgeReview` builds risk, regime, score, and recommendation with a shared generated time/request ID/correlation ID, persists one deterministic `hedge_recommendation` learning row, and returns the full report. `createAndPersistHedgePlan` requires explicit paper-only intent, persists a `hedge_plan` row, then updates the recommendation's reviewed-payload hash.

- [ ] **Step 5: Implement the pure gate scaffold**

Evaluate paper environment, explicit intent, execution flag, plan validity, source/config/hash matches, duplicate status, instrument support, and supplied runtime-preflight result. Always append `HEDGE_EXECUTION_NOT_IMPLEMENTED`; never import Alpaca client/order services.

- [ ] **Step 6: Run plan, persistence, and reviewed-executor regressions**

Run: `npx tsx --test tests/hedgePlanService.test.ts tests/hedgePersistenceService.test.ts tests/paperReviewedPayloadExecutionService.test.ts`

Expected: PASS; the existing reviewed executor continues to recognize only its original five section names.

- [ ] **Step 7: Commit**

```bash
git add src/services/hedgePlanService.ts src/services/hedgeLearningService.ts src/services/hedgeExecutionGateService.ts src/services/hedgePersistenceService.ts tests/hedgePlanService.test.ts package.json
git commit -m "Add signed non-executable hedge plans"
```

### Task 7: Read-only CLI commands

**Files:**

- Create: `tests/hedgeCli.test.ts`
- Modify: `src/cli.ts`
- Modify: `package.json`

**Interfaces:**

- Produces scripts: `hedge:risk`, `hedge:regime`, `hedge:review`, `hedge:plan`.
- `hedge:plan` requires `--paperOnly`; all accept `--format=json`.
- No `hedge:execute` script or dispatch branch exists.

- [ ] **Step 1: Write CLI contract tests**

```ts
test("package exposes only the four read-only hedge scripts", () => {
  assert.equal(pkg.scripts["hedge:risk"], "tsx src/cli.ts hedge:risk");
  assert.equal(pkg.scripts["hedge:plan"], "tsx src/cli.ts hedge:plan");
  assert.equal(pkg.scripts["hedge:execute"], undefined);
});

test("hedge plan requires explicit paperOnly", async () => {
  const result = await runCli(["hedge:plan", "--format=json"], safeEnv);
  assert.equal(result.json.status, "blocked");
  assert.ok(result.json.blockers.includes("HEDGE_PAPER_ONLY_CONFIRMATION_REQUIRED"));
});
```

- [ ] **Step 2: Run CLI tests and verify failure**

Run: `npx tsx --test tests/hedgeCli.test.ts`

Expected: FAIL because scripts and command dispatch do not exist.

- [ ] **Step 3: Add CLI imports and dispatch branches**

```ts
if (command === "hedge:risk") {
  print(await buildPortfolioRiskSnapshot());
  return;
}
if (command === "hedge:regime") {
  print(classifyMarketRegime());
  return;
}
if (command === "hedge:review") {
  print(await buildAndPersistHedgeReview({ triggerSource: "cli" }));
  return;
}
if (command === "hedge:plan") {
  print(await buildAndPersistHedgePlan({ paperOnly: flagArg(args.paperOnly), triggerSource: "cli" }));
  return;
}
```

Human formatters must state `Read-only analysis. No orders were submitted.` and plans must state `Planning artifact only. Execution is not implemented.` JSON output carries `paperOnly: true`, environment, model versions, quality/status, warnings, and blockers.

- [ ] **Step 4: Add scripts and tests to package sequencing**

```json
"hedge:risk": "tsx src/cli.ts hedge:risk",
"hedge:regime": "tsx src/cli.ts hedge:regime",
"hedge:review": "tsx src/cli.ts hedge:review",
"hedge:plan": "tsx src/cli.ts hedge:plan"
```

- [ ] **Step 5: Run CLI tests and typecheck**

Run: `npx tsx --test tests/hedgeCli.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts tests/hedgeCli.test.ts package.json
git commit -m "Add read-only hedge CLI commands"
```

### Task 8: Review-only scheduler integration

**Files:**

- Modify: `src/services/paperOpsWorkflowService.ts`
- Modify: `tests/paperOpsWorkflowService.test.ts`
- Modify: `tests/paperMonitoringScheduler.test.ts`

**Interfaces:**

- Consumes: `buildAndPersistHedgeReview`.
- Produces: `details.hedgeReview` and sanitized warnings/blockers in existing morning, midday, and late-day reports.
- Does not change the reviewed artifact's order sections or any systemd timer command.

- [ ] **Step 1: Add a failing dependency-injection test**

```ts
test("midday refreshes a hedge recommendation without an executor", async () => {
  let hedgeCalls = 0;
  const report = await runPaperOpsMidday({}, {
    buildPortfolioReview: fakePortfolioReview,
    buildHedgeReview: async () => { hedgeCalls += 1; return monitoringHedgeReview; }
  });
  assert.equal(hedgeCalls, 1);
  assert.equal(report.details.hedgeReview, monitoringHedgeReview);
  assert.equal("executeHedge" in report.details, false);
});
```

- [ ] **Step 2: Run scheduler tests and verify failure**

Run: `npx tsx --test tests/paperOpsWorkflowService.test.ts tests/paperMonitoringScheduler.test.ts`

Expected: FAIL because `buildHedgeReview` is not a dependency.

- [ ] **Step 3: Inject and call only read-only review orchestration**

Add `buildHedgeReview?: typeof buildAndPersistHedgeReview` to `PaperOpsDeps`. Call it after the portfolio review at each existing moment and include it in `details`. Merge only its warnings and blockers. Do not add systemd units, command-runner calls, reviewed payload sections, or executor imports.

- [ ] **Step 4: Run scheduler and existing execution regressions**

Run: `npx tsx --test tests/paperOpsWorkflowService.test.ts tests/paperMonitoringScheduler.test.ts tests/paperReviewedPayloadExecutionService.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/paperOpsWorkflowService.ts tests/paperOpsWorkflowService.test.ts tests/paperMonitoringScheduler.test.ts
git commit -m "Refresh hedge reviews in paper ops"
```

### Task 9: Authenticated GET bridge and cached dashboard data

**Files:**

- Create: `apps/dashboard/app/api/paper/hedge/risk/route.ts`
- Create: `apps/dashboard/app/api/paper/hedge/regime/route.ts`
- Create: `apps/dashboard/app/api/paper/hedge/recommendation/route.ts`
- Create: `tests/hedgeDashboard.test.ts`
- Modify: `server/dashboard-control/server.ts`
- Modify: `apps/dashboard/lib/data.ts`
- Modify: `tests/dashboardControlServer.test.ts`
- Modify: `tests/dashboardVercelBridge.test.ts`
- Modify: `package.json`

**Interfaces:**

- VPS GET routes: `/api/v1/hedge/risk`, `/api/v1/hedge/regime`, `/api/v1/hedge/recommendation`.
- Vercel GET routes: `/api/paper/hedge/risk`, `/api/paper/hedge/regime`, `/api/paper/hedge/recommendation`.
- Dashboard snapshot field: `hedge: DashboardResult<LatestHedgeDashboardPayload | null>`.
- All reads return persisted/cached data and never run broker work in the request path.

- [ ] **Step 1: Write route authentication, method, and cached-read tests**

```ts
test("hedge control routes are authenticated GET-only", async () => {
  assert.equal((await request("GET", "/api/v1/hedge/recommendation")).status, 401);
  const response = await request("GET", "/api/v1/hedge/recommendation", controlToken);
  assert.equal(response.status, 200);
  assert.equal(commandRunnerCalls, 0);
  assert.equal(orderFetcherCalls, 0);
});

test("expired recommendations remain expired through the Vercel bridge", async () => {
  const response = await hedgeRecommendationRoute.GET(requestWithBridge);
  const body = await response.json();
  assert.equal(body.data.effectiveStatus, "expired");
  assert.notEqual(body.data.effectiveStatus, "current");
});
```

- [ ] **Step 2: Run dashboard tests and verify failure**

Run: `npx tsx --test tests/hedgeDashboard.test.ts tests/dashboardControlServer.test.ts tests/dashboardVercelBridge.test.ts`

Expected: FAIL because routes and snapshot field do not exist.

- [ ] **Step 3: Add GET-only control handlers**

Register handlers that call `latestHedgeRecommendation` or read its embedded risk/regime payload. Reuse token authentication, redaction, envelopes, request/correlation IDs, and no-store behavior. Set `requireMutationPrecheck=false`; add no POST action and no command runner.

- [ ] **Step 4: Add guarded Vercel routes and dashboard snapshot data**

Each route calls `guardedGet` and uses its matching VPS path. In local mode, read `latestHedgeRecommendation`; in bridge mode, carry the VPS summary `hedge` field. In Vercel read-only fallback, return a historical-unavailable result. Re-evaluate effective status at read time.

- [ ] **Step 5: Run route, bridge, fallback, and guard tests**

Run: `npx tsx --test tests/hedgeDashboard.test.ts tests/dashboardControlServer.test.ts tests/dashboardVercelBridge.test.ts tests/dashboardVercelFallback.test.ts tests/dashboardGuard.test.ts`

Expected: PASS with no mutation route added.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/app/api/paper/hedge/risk/route.ts apps/dashboard/app/api/paper/hedge/regime/route.ts apps/dashboard/app/api/paper/hedge/recommendation/route.ts apps/dashboard/lib/data.ts server/dashboard-control/server.ts tests/hedgeDashboard.test.ts tests/dashboardControlServer.test.ts tests/dashboardVercelBridge.test.ts package.json
git commit -m "Expose cached hedge dashboard data"
```

### Task 10: Dashboard portfolio-risk presentation

**Files:**

- Modify: `apps/dashboard/app/page.tsx`
- Modify: `apps/dashboard/app/globals.css`
- Modify: `tests/hedgeDashboard.test.ts`

**Interfaces:**

- Consumes: `snapshot.hedge` from Task 9.
- Produces: a server-rendered read-only risk and hedge panel.

- [ ] **Step 1: Add failing render assertions for status integrity**

```ts
test("dashboard labels expired hedge records and omits current wording", () => {
  const html = renderHedgePanel(expiredPayload);
  assert.match(html, /EXPIRED/);
  assert.match(html, /Expired at/);
  assert.doesNotMatch(html, /Current recommendation/);
});
```

- [ ] **Step 2: Run the dashboard test and verify failure**

Run: `npx tsx --test tests/hedgeDashboard.test.ts`

Expected: FAIL because the panel does not exist.

- [ ] **Step 3: Render risk, regime, sizing, LEAPS, and candidates**

Add a full-width panel near the account/position panels. Always render the effective status badge first, then generated/expiry timestamps, source snapshot, risk/regime versions, configuration match, data quality, score/band, gross/net/beta exposure, concentration, scenario loss rows, regime rule, existing protection, LEAPS trim/profit-funded budget, candidates, warnings, and blockers. Use `-` for nulls. Stale and expired copy must say the recommendation is not current.

- [ ] **Step 4: Add accessible status styles**

Use existing colors and typography. Add class selectors for `.hedge-status-current`, `.hedge-status-monitoring`, `.hedge-status-stale`, `.hedge-status-expired`, and `.hedge-status-blocked`; include text labels so color is not the only status cue.

- [ ] **Step 5: Run dashboard test, typecheck, and dashboard build**

Run: `npx tsx --test tests/hedgeDashboard.test.ts && npm run typecheck && npm run dashboard:build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/app/page.tsx apps/dashboard/app/globals.css tests/hedgeDashboard.test.ts
git commit -m "Display portfolio hedge recommendations"
```

### Task 11: Documentation, environment contract, and complete validation

**Files:**

- Modify: `.env.example`
- Modify: `README.md`
- Modify: `RESUME_CONTEXT.md`
- Modify: `server/README.md`
- Modify: `server/RESUME_CONTEXT.md`

**Interfaces:**

- Documents the four read-only commands, configuration defaults, persistence, cached routes, scheduler behavior, and safety boundary.
- Does not document an executable hedge command or deployment authorization.

- [ ] **Step 1: Add the safe environment contract**

Document every `HEDGE_*` setting from the specification with `HEDGE_PAPER_EXECUTION_ENABLED=false`. Explain that the fingerprint excludes secrets, that stale beta rows are ignored, and that recommendation integrity fields are mandatory.

- [ ] **Step 2: Document operator commands and blocked execution**

Include exactly:

```bash
npm run hedge:risk -- --format=json
npm run hedge:regime -- --format=json
npm run hedge:review -- --format=json
npm run hedge:plan -- --paperOnly --format=json
```

State that plans are signed review artifacts only, put spreads carry `MULTI_LEG_EXECUTION_UNSUPPORTED`, and no hedge execution route/script exists.

- [ ] **Step 3: Run documentation and diff safety checks**

Run: `rg -n "HEDGE_PAPER_EXECUTION_ENABLED|hedge:risk|hedge:regime|hedge:review|hedge:plan|MULTI_LEG_EXECUTION_UNSUPPORTED" .env.example README.md RESUME_CONTEXT.md server/README.md server/RESUME_CONTEXT.md`

Expected: all five files reflect the read-only paper boundary.

Run: `git diff --check`

Expected: PASS.

- [ ] **Step 4: Run the complete repository validation suite**

```bash
npm run lint
npm test
npm run typecheck
npm run build
npm run dashboard:build
```

Expected: all commands exit 0.

- [ ] **Step 5: Run the required safe read-only commands**

```bash
ALPACA_ENV=paper TRADING_MODE=paper ALPACA_LIVE_TRADE=false LIVE_TRADING_ENABLED=false HEDGE_PAPER_EXECUTION_ENABLED=false npm run hedge:risk -- --format=json
ALPACA_ENV=paper TRADING_MODE=paper ALPACA_LIVE_TRADE=false LIVE_TRADING_ENABLED=false HEDGE_PAPER_EXECUTION_ENABLED=false npm run hedge:regime -- --format=json
ALPACA_ENV=paper TRADING_MODE=paper ALPACA_LIVE_TRADE=false LIVE_TRADING_ENABLED=false HEDGE_PAPER_EXECUTION_ENABLED=false npm run hedge:review -- --format=json
ALPACA_ENV=paper TRADING_MODE=paper ALPACA_LIVE_TRADE=false LIVE_TRADING_ENABLED=false HEDGE_PAPER_EXECUTION_ENABLED=false npm run hedge:plan -- --paperOnly --format=json
```

Expected: each exits without order submission, reports `paperOnly: true`, and returns observed data or explicit null/warning/blocker states. Do not run `npm run hedge:execute`.

- [ ] **Step 6: Verify safety and inspect the complete diff**

Run: `rg -n 'hedge:execute|submitOrder|createOrder|postAlpaca|PAPER_EXECUTION_ENABLED=true' src/services/hedge* src/cli.ts package.json apps/dashboard server/dashboard-control/server.ts`

Expected: no `hedge:execute`, no broker submission import/call in hedge services, and only fail-closed documentation/tests for execution flags.

Run: `git status --short && git diff --stat && git diff --check`

Expected: only scoped implementation/documentation files; no whitespace errors.

- [ ] **Step 7: Commit the completed integration**

```bash
git add .env.example README.md RESUME_CONTEXT.md server/README.md server/RESUME_CONTEXT.md
git commit -m "Document paper-only hedge operations"
```

- [ ] **Step 8: Record final branch state**

Run: `git branch --show-current && git log -n 12 --oneline && git status --short`

Expected: `paper-ops-layer`, the specification and implementation commits present, and a clean working tree.
