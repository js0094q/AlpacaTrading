# Market Observatory Phase 1A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the approved 51-symbol traceable universe and automated, rich Alpaca stock observations to the existing research lifecycle without adding any order path.

**Architecture:** Keep `src/config/universe.seed.ts` as the only static universe and enrich the existing SQLite/provider/research boundaries. Add one normalized append-only stock-snapshot store, merge only the latest observation into the latest feature row, persist every scored candidate decision in the existing candidate table, and schedule collection through the existing non-overlapping monitor runner.

**Tech Stack:** TypeScript, Node.js 22, `node:sqlite`, Node test runner, Alpaca REST APIs, systemd timers.

## Global Constraints

- Branch is `feat/market-observatory` from `main@1d274301fab8739702d0105bcf8e6b7ff504761a`.
- Preserve the user-owned modification to `docs/superpowers/plans/2026-07-10-guarded-paper-hedge-execution.md`.
- Preserve all existing universe symbols; the 20 requested names yield 19 net-new rows because `TSLA` already exists.
- Use Alpaca read-only asset and market-data endpoints only.
- Keep `ALPACA_LIVE_TRADE=false` and `LIVE_TRADING_ENABLED=false`; do not submit any order.
- Do not add external macro data, counterfactual analytics, MFE/MAE, dashboard expansion, or deployment.
- Use additive, idempotent SQLite migrations and the existing scheduler framework.
- Write a failing test before each production behavior and observe the expected failure.

---

### Task 1: Canonical traceable universe and asset metadata

**Files:**
- Modify: `src/config/universe.seed.ts`
- Modify: `src/types.ts`
- Modify: `src/lib/db.ts`
- Modify: `src/services/alpacaAssetService.ts`
- Modify: `src/services/universeService.ts`
- Test: `tests/marketObservatory.test.ts`

**Interfaces:**
- Consumes: `seedUniverse`, `getAlpacaAsset(symbol)`.
- Produces: `UniverseSymbolRow` with nullable Alpaca metadata and `refreshUniverseAssetMetadata({ symbols, maxAgeMs })`.

- [ ] **Step 1: Write failing universe and migration tests**

```ts
test("canonical universe retains existing symbols and includes the requested set once", async () => {
  const first = await seedInitialUniverse();
  const second = await seedInitialUniverse();
  assert.equal(first.symbols.length, 51);
  assert.deepEqual(second.symbols, first.symbols);
  assert.equal(new Set(second.symbols).size, 51);
  requestedSymbols.forEach((symbol) => assert.equal(second.symbols.includes(symbol), true));
  originalSymbols.forEach((symbol) => assert.equal(second.symbols.includes(symbol), true));
});

test("inactive or non-tradable Alpaca assets are retained but disabled", async () => {
  await refreshUniverseAssetMetadata({
    symbols: ["AAPL"],
    getAsset: async () => ({ symbol: "AAPL", status: "inactive", tradable: false })
  });
  const row = getUniverseSymbol("AAPL");
  assert.equal(row?.enabled, 0);
  assert.equal(row?.tradable, 0);
  assert.equal(row?.assetStatus, "inactive");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx tsx --test tests/marketObservatory.test.ts --test-name-pattern='canonical universe|inactive or non-tradable|asset metadata migration'`

Expected: FAIL because the test file, metadata columns, or refresh function does not exist.

- [ ] **Step 3: Add the 20-name set and additive universe columns**

Add the requested symbols to the existing seed without duplicating `TSLA`. Extend
`universe_symbols` and `runMigrations()` with nullable:

```sql
asset_id TEXT,
asset_status TEXT,
exchange TEXT,
fractionable INTEGER,
shortable INTEGER,
marginable INTEGER,
options_enabled INTEGER,
asset_attributes_json TEXT,
asset_validated_at TEXT,
asset_request_id TEXT
```

- [ ] **Step 4: Normalize and persist complete asset metadata**

```ts
export const refreshUniverseAssetMetadata = async (input: {
  symbols?: string[];
  maxAgeMs?: number;
  getAsset?: typeof getAlpacaAsset;
}) => Promise<{
  checked: number;
  active: number;
  disabled: number;
  failed: Array<{ symbol: string; reason: string }>;
}>;
```

`has_options` sets `optionsEnabled=1`; missing availability remains `null`. An
inactive or explicitly non-tradable asset sets both `enabled` and `tradable` to
zero. API errors retain prior state and return a failed entry.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npx tsx --test tests/marketObservatory.test.ts --test-name-pattern='canonical universe|inactive or non-tradable|asset metadata migration'`

Expected: PASS.

- [ ] **Step 6: Commit the universe slice**

```bash
git add -- src/config/universe.seed.ts src/types.ts src/lib/db.ts src/services/alpacaAssetService.ts src/services/universeService.ts tests/marketObservatory.test.ts docs/superpowers/plans/2026-07-13-market-observatory-phase-1a.md
git commit -m "Add traceable universe expansion"
```

### Task 2: Stock snapshot normalization and persistence

**Files:**
- Create: `src/services/stockSnapshotNormalizer.ts`
- Create: `src/services/stockObservationService.ts`
- Modify: `src/services/providers/alpaca.ts`
- Modify: `src/types.ts`
- Modify: `src/lib/db.ts`
- Test: `tests/marketObservatory.test.ts`

**Interfaces:**
- Consumes: Alpaca `/v2/stocks/snapshots` payloads and explicit requested feed.
- Produces: `fetchStockSnapshots()`, `normalizeStockSnapshot()`, `persistStockSnapshot()`, and `getLatestStockSnapshotFeatures()`.

- [ ] **Step 1: Write failing normalization and schema tests**

```ts
test("normalizes a complete multi-symbol snapshot without replacing source time", () => {
  const row = normalizeStockSnapshot({
    symbol: "AAPL",
    raw: completeSnapshot,
    observedAt: "2026-07-13T16:45:00.000Z",
    requestedFeed: "iex",
    effectiveFeed: "iex",
    requestId: "request-1",
    now: new Date("2026-07-13T16:45:00.000Z")
  });
  assert.equal(row.quoteTimestamp, "2026-07-13T16:44:50.000Z");
  assert.equal(row.observedAt, "2026-07-13T16:45:00.000Z");
  assert.equal(row.spread, 0.2);
  assert.equal(row.dataQualityStatus, "COMPLETE");
  assert.equal(row.freshnessStatus, "FRESH");
});

test("deduplicates repeated source evidence", () => {
  assert.equal(persistStockSnapshot(row, 1), 1);
  assert.equal(persistStockSnapshot(row, 2), 0);
});
```

Also add one test each for missing quote, missing trade, missing minute bar, partial
response, stale evidence, feed preservation, zero preservation, and additive
idempotent migration.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx tsx --test tests/marketObservatory.test.ts --test-name-pattern='snapshot|feed|freshness|deduplicates'`

Expected: FAIL because the normalizer, provider, table, and persistence functions do not exist.

- [ ] **Step 3: Add the append-only stock snapshot schema**

Create `stock_snapshots` with all trade, quote, minute, daily, previous-daily,
freshness, quality, source, request, ingestion-run, and derived-value columns from
the approved spec. Add:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_snapshots_dedupe
  ON stock_snapshots(symbol, requested_feed, source_timestamp);
CREATE INDEX IF NOT EXISTS idx_stock_snapshots_symbol_observed
  ON stock_snapshots(symbol, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_snapshots_freshness
  ON stock_snapshots(freshness_status);
CREATE INDEX IF NOT EXISTS idx_stock_snapshots_ingestion_run
  ON stock_snapshots(ingestion_run_id);
```

- [ ] **Step 4: Implement bounded provider collection**

```ts
export const fetchStockSnapshots = async (input: {
  symbols: string[];
  feed: string;
  currency?: string;
}): Promise<Array<{
  symbol: string;
  raw: StockSnapshotRaw | null;
  requestedFeed: string;
  effectiveFeed: string;
  requestId: string | null;
  error?: string;
}>>;
```

Use chunks of at most 100 symbols and the existing bounded `requestJson()` retry
policy. Return an explicit error row for requested symbols absent from a successful
response.

- [ ] **Step 5: Implement normalization, derived values, and persistence**

Calculate values only when required inputs are finite and valid:

```ts
midpoint = bid !== null && ask !== null ? (bid + ask) / 2 : null;
spread = bid !== null && ask !== null ? ask - bid : null;
spreadPct = spread !== null && midpoint && midpoint > 0 ? (spread / midpoint) * 100 : null;
dailyReturn = dailyClose !== null && previousClose ? dailyClose / previousClose - 1 : null;
gapFromPreviousClose = dailyOpen !== null && previousClose ? dailyOpen / previousClose - 1 : null;
returnFromOpen = dailyClose !== null && dailyOpen ? dailyClose / dailyOpen - 1 : null;
distanceFromVwap = dailyClose !== null && dailyVwap ? dailyClose / dailyVwap - 1 : null;
intradayRange = dailyHigh !== null && dailyLow !== null ? dailyHigh - dailyLow : null;
relativeCurrentDayVolume = dailyVolume !== null && previousVolume ? dailyVolume / previousVolume : null;
```

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `npx tsx --test tests/marketObservatory.test.ts --test-name-pattern='snapshot|feed|freshness|deduplicates'`

Expected: PASS.

- [ ] **Step 7: Commit the observation slice**

```bash
git add -- src/services/stockSnapshotNormalizer.ts src/services/stockObservationService.ts src/services/providers/alpaca.ts src/types.ts src/lib/db.ts tests/marketObservatory.test.ts
git commit -m "Add automated Alpaca stock observations"
```

### Task 3: Observation orchestration, run status, and CLI

**Files:**
- Modify: `src/services/stockObservationService.ts`
- Modify: `src/types.ts`
- Modify: `src/lib/db.ts`
- Modify: `src/cli.ts`
- Modify: `package.json`
- Test: `tests/marketObservatory.test.ts`

**Interfaces:**
- Consumes: active universe, asset refresh, Alpaca market clock, snapshot provider.
- Produces: `runStockObservation()` and `npm run observatory:collect`.

- [ ] **Step 1: Write failing orchestration tests**

```ts
test("market-open collection records a completed ingestion run", async () => {
  const result = await runStockObservation({
    getClock: async () => ({ isOpen: true }),
    getSnapshots: async () => completeRows
  });
  assert.equal(result.status, "completed");
  assert.equal(result.requestedSymbols, 51);
  assert.equal(result.failedSymbols, 0);
});

test("market-closed collection records a skip and never requests snapshots", async () => {
  let calls = 0;
  const result = await runStockObservation({
    getClock: async () => ({ isOpen: false }),
    getSnapshots: async () => { calls += 1; return []; }
  });
  assert.equal(result.status, "skipped_market_closed");
  assert.equal(calls, 0);
});
```

Add partial-symbol, failed persistence, sanitized error, and no order dependency
tests.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx tsx --test tests/marketObservatory.test.ts --test-name-pattern='market-open|market-closed|partial-symbol|order dependency'`

Expected: FAIL because orchestration and run metadata are incomplete.

- [ ] **Step 3: Extend ingestion run metadata additively**

Add nullable/defaulted columns through `runMigrations()`:

```sql
requested_symbols INTEGER NOT NULL DEFAULT 0,
successful_symbols INTEGER NOT NULL DEFAULT 0,
failed_symbols INTEGER NOT NULL DEFAULT 0,
error_summary TEXT
```

Extend the run-type/status unions for `stock_snapshots`, `partial`, and
`skipped_market_closed`.

- [ ] **Step 4: Implement `runStockObservation()` and CLI routing**

The orchestrator seeds the universe, refreshes missing/stale assets, creates a
running ingestion row, checks the clock, collects the active universe, persists
each normalized row, and finalizes `completed`, `partial`, `failed`, or
`skipped_market_closed`. Add package script:

```json
"observatory:collect": "tsx src/cli.ts observatory collect"
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npx tsx --test tests/marketObservatory.test.ts --test-name-pattern='market-open|market-closed|partial-symbol|order dependency'`

Expected: PASS.

### Task 4: Research, candidate, and learning integration

**Files:**
- Modify: `src/services/featureService.ts`
- Modify: `src/services/candidateRankingService.ts`
- Modify: `src/services/researchOrchestrator.ts`
- Modify: `src/types.ts`
- Modify: `src/lib/db.ts`
- Test: `tests/marketObservatory.test.ts`
- Test: `tests/research.test.ts`

**Interfaces:**
- Consumes: latest persisted stock observation and existing ranked candidates.
- Produces: observatory-enriched latest features and `CandidateDecisionRecord[]` for all scored targets.

- [ ] **Step 1: Write failing integration tests**

```ts
test("latest observatory values enrich only the latest feature row", async () => {
  await buildFeatures({ symbols: ["AAPL"] });
  const rows = getLatestFeatures().filter((row) => row.symbol === "AAPL");
  assert.equal(rows[0]?.features.observatorySpread, 0.2);
  assert.equal(rows[0]?.features.observatoryDataQualityStatus, "COMPLETE");
});

test("selected rejected skipped and blocked scored decisions persist", () => {
  persistCandidateDecisions({ researchRunId, decisions });
  const stored = queryAll<{ decision: string; decision_reason: string }>(
    "SELECT decision, decision_reason FROM paper_trade_candidates WHERE research_run_id = ?",
    [researchRunId]
  );
  assert.deepEqual(new Set(stored.map((row) => row.decision)), new Set(["selected", "rejected", "skipped", "blocked"]));
});
```

Add tests proving selected-only plan creation, new-symbol research entry, signal
inputs/data quality persistence, and learning service acceptance.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx tsx --test tests/marketObservatory.test.ts tests/research.test.ts --test-name-pattern='observatory values|scored decisions|selected-only|new-symbol|learning service'`

Expected: FAIL because observatory feature fields and candidate decision columns do not exist.

- [ ] **Step 3: Add candidate decision columns additively**

```sql
decision TEXT NOT NULL DEFAULT 'selected',
decision_reason TEXT,
strategy_family TEXT,
signal_inputs_json TEXT,
data_quality_status TEXT
```

- [ ] **Step 4: Enrich latest features and persist all scored decisions**

Merge the latest stock observation only into the final calculated feature row per
symbol. Extend ranking output with `decisions`; selected candidates preserve their
current order and plan behavior. Non-selected scored rows receive `skipped` plus a
deterministic cap/diversity reason. `persistCandidateDecisions()` writes every
decision to `paper_trade_candidates`; `buildPaperTradePlans()` still receives only
`ranked.candidates`.

- [ ] **Step 5: Run research integration tests and verify GREEN**

Run: `npx tsx --test tests/marketObservatory.test.ts tests/research.test.ts --test-name-pattern='observatory values|scored decisions|selected-only|new-symbol|learning service'`

Expected: PASS.

- [ ] **Step 6: Commit the lifecycle slice**

```bash
git add -- src/services/featureService.ts src/services/candidateRankingService.ts src/services/researchOrchestrator.ts src/types.ts src/lib/db.ts src/services/stockObservationService.ts src/cli.ts package.json tests/marketObservatory.test.ts tests/research.test.ts
git commit -m "Connect observatory data to research lifecycle"
```

### Task 5: Fifteen-minute scheduler and documentation

**Files:**
- Modify: `scripts/paper-monitor-runner.mjs`
- Create: `server/systemd/alpaca-market-observatory.service`
- Create: `server/systemd/alpaca-market-observatory.timer`
- Modify: `tests/paperMonitoringScheduler.test.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `RESUME_CONTEXT.md`

**Interfaces:**
- Consumes: `npm run observatory:collect`.
- Produces: monitor task `observatory` and two non-deployed systemd unit templates.

- [ ] **Step 1: Write failing scheduler tests**

```ts
test("observatory uses the existing lock and never references an order command", () => {
  const body = parseStdout(runMonitor("observatory"));
  assert.match(body.command, /observatory:collect/);
  assert.doesNotMatch(body.command, /execute|confirmPaper|order/);
});

test("observatory timer registers a 15-minute regular-session cadence", () => {
  const timer = readFileSync(join(repoRoot, "server/systemd/alpaca-market-observatory.timer"), "utf8");
  assert.match(timer, /09\.\.15:0\/15:00/);
});
```

- [ ] **Step 2: Run scheduler tests and verify RED**

Run: `npx tsx --test tests/paperMonitoringScheduler.test.ts --test-name-pattern='observatory'`

Expected: FAIL because the task and units do not exist.

- [ ] **Step 3: Register the observation task and units**

```js
observatory: {
  command: ["npm", ["run", "observatory:collect", "--", "--format=json"]],
  lockFile: "/tmp/alpaca-market-observatory.lock",
  requireExecution: false
}
```

The timer uses `OnCalendar=Mon..Fri *-*-* 09..15:0/15:00`,
`Persistent=false`, and bounded randomized delay. The service is a oneshot using
the existing environment file and `paper:monitor -- --task=observatory`.

- [ ] **Step 4: Document configuration and non-deployment boundary**

Add:

```text
MARKET_OBSERVATORY_FEED=iex
MARKET_OBSERVATORY_CURRENCY=USD
MARKET_OBSERVATORY_MAX_AGE_SECONDS=1200
MARKET_OBSERVATORY_ASSET_REFRESH_HOURS=24
```

Document the command, 15-minute regular-session cadence, data-quality/freshness
semantics, 51-symbol unique universe, and the fact that the units are templates
only and were not deployed.

- [ ] **Step 5: Run scheduler tests and verify GREEN**

Run: `npx tsx --test tests/paperMonitoringScheduler.test.ts --test-name-pattern='observatory|market-hours gate|locking'`

Expected: PASS.

- [ ] **Step 6: Commit the automation/docs slice**

```bash
git add -- scripts/paper-monitor-runner.mjs server/systemd/alpaca-market-observatory.service server/systemd/alpaca-market-observatory.timer tests/paperMonitoringScheduler.test.ts .env.example README.md RESUME_CONTEXT.md
git commit -m "Schedule market observatory collection"
```

### Task 6: Focused validation, full verification, push, and memory handoff

**Files:**
- Verify: all changed files
- Update externally: Basic Memory `js-workspace/alpaca-trading`

**Interfaces:**
- Consumes: committed Phase 1A branch.
- Produces: pushed branch and read-back continuity record.

- [ ] **Step 1: Run the focused suites**

```bash
npx tsx --test tests/marketObservatory.test.ts
npx tsx --test tests/research.test.ts
npx tsx --test tests/alpacaReadOnlyIntegration.test.ts
npx tsx --test tests/paperMonitoringScheduler.test.ts
```

Expected: all pass with zero failures.

- [ ] **Step 2: Run required static checks**

```bash
npm run lint
npm run typecheck
```

Expected: both exit zero.

- [ ] **Step 3: Run the final canonical suite once**

Run: `npm test`

Expected: exit zero with no failed test file.

- [ ] **Step 4: Run repository checks**

```bash
git diff --check
git status --short
git diff --stat main...HEAD
```

Expected: only the preserved user-owned plan remains unstaged; Phase 1A files are committed.

- [ ] **Step 5: Run read-only Alpaca proof**

Use Alpaca asset reference for all requested names and one IEX multi-symbol stock
snapshot request. Record only active/tradable/fractionable/shortable/options and
market-data field/record counts; never record credentials or account identifiers.

- [ ] **Step 6: Push the branch**

```bash
git push -u origin feat/market-observatory
```

Expected: branch is created or fast-forwarded on origin with upstream configured.

- [ ] **Step 7: Update and read back Basic Memory**

Replace the current checkpoint section with the ending branch/SHA/commits and
append Phase 1A implementation facts to the direction note. Create a dated
implementation checkpoint containing universe counts, validation result, schema,
cadence, tests, limitations, and paper/live posture. Read all updated notes back and
confirm no secrets, tokens, account IDs, or private environment values appear.
