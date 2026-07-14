# 0DTE Level 2 Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and paper-deploy an independent 0DTE Level 2 engine with a persistent ranked queue, five attributable playbooks, signal history, shadow trades, lifecycle/outcome capture, guarded paper execution, exits, timers, and dashboard visibility.

**Architecture:** Add a focused `src/services/zeroDte/` domain with pure scoring/ranking functions, injected market-data and mutation ports, SQLite persistence behind additive migrations, and one orchestration service. Reuse the resolved paper-exit framework, paper-only Alpaca client, runtime preflight, execution ledger, and VPS bridge; do not make the Market Observatory a prerequisite.

**Tech Stack:** TypeScript, Node.js `node:test`, Node SQLite, existing Alpaca REST adapters, existing systemd monitor runner, Next.js dashboard, VPS-owned SQLite runtime.

## Global Constraints

- Paper only: `ALPACA_ENV=paper`, `TRADING_MODE=paper`, `ALPACA_LIVE_TRADE=false`, `LIVE_TRADING_ENABLED=false`.
- A paper order requires the new Level 2 gate plus existing `PAPER_ORDER_EXECUTION_ENABLED`, `PAPER_OPTIONS_EXECUTION_ENABLED`, and explicit paper confirmation/automated-runner authorization.
- Never print or persist API keys, secrets, authorization headers, or unnecessary raw broker payloads.
- Preserve the existing Market Observatory, equity, hedge, LEAPS, legacy paper-option, and paper-exit behavior.
- Do not modify `docs/superpowers/plans/2026-07-10-guarded-paper-hedge-execution.md`.
- Use additive, idempotent, non-destructive SQLite migrations.
- Use test-first development: every production behavior change starts with a failing focused test.
- Do not create a synthetic or forced low-quality trade solely to prove an execution route.
- The Vercel dashboard remains read-only; the VPS owns the engine, timers, SQLite database, and broker mutations.
- Deployment and paper order submission are allowed by the attached objective; live execution remains forbidden.

## File Map

### New domain and tests

- Create `src/services/zeroDte/zeroDteTypes.ts` — shared types, enums, provider ports, and result contracts.
- Create `src/services/zeroDte/zeroDteConfigService.ts` — normalized configuration and configuration hash.
- Create `src/services/zeroDte/zeroDteIdentityService.ts` — candidate, decision, run, group, and client-order identities.
- Create `src/services/zeroDte/zeroDteSignalService.ts` — score deltas, slopes, peak/drawdown, and state classification.
- Create `src/services/zeroDte/zeroDteRankingService.ts` — deterministic queue ranking and top-N selection.
- Create `src/services/zeroDte/zeroDteRegimeService.ts` — data-backed regime classification.
- Create `src/services/zeroDte/zeroDtePlaybookService.ts` — five pure playbook evaluators.
- Create `src/services/zeroDte/zeroDteMarketDataService.ts` — direct market clock, bars, contracts, and quotes.
- Create `src/services/zeroDte/zeroDtePersistenceService.ts` — typed SQLite reads/writes and dashboard read models.
- Create `src/services/zeroDte/zeroDteLifecycleService.ts` — immutable decisions and append-only events.
- Create `src/services/zeroDte/zeroDteShadowService.ts` — isolated simulated trades and marks.
- Create `src/services/zeroDte/zeroDteOutcomeService.ts` — forward horizons, terminal outcomes, and daily summary.
- Create `src/services/zeroDte/zeroDteExecutionService.ts` — eligibility, reservations, payloads, and guarded paper submission.
- Create `src/services/zeroDte/zeroDteExitService.ts` — Level 2 exit linkage and per-minute review.
- Create `src/services/zeroDte/zeroDteEngineService.ts` — cycle orchestration, non-overlap, and health output.
- Create `src/lib/zeroDteSchema.ts` — isolated additive SQLite schema/migration function.
- Create `tests/zeroDteConfig.test.ts`.
- Create `tests/zeroDteIdentity.test.ts`.
- Create `tests/zeroDteSignal.test.ts`.
- Create `tests/zeroDteRanking.test.ts`.
- Create `tests/zeroDtePlaybook.test.ts`.
- Create `tests/zeroDteMarketData.test.ts`.
- Create `tests/zeroDtePersistence.test.ts`.
- Create `tests/zeroDteLifecycle.test.ts`.
- Create `tests/zeroDteShadow.test.ts`.
- Create `tests/zeroDteOutcome.test.ts`.
- Create `tests/zeroDteExecution.test.ts`.
- Create `tests/zeroDteExit.test.ts`.
- Create `tests/zeroDteEngine.test.ts`.

### Existing integration surfaces

- Modify `src/lib/db.ts` — invoke the Level 2 migration after existing migrations.
- Modify `src/config.ts` — expose new flags and caps without changing existing defaults.
- Modify `src/cli.ts` — add Level 2 commands and sanitized output.
- Modify `package.json` — add Level 2 scripts and focused test entries.
- Modify `.env.example` — document Level 2 flags and caps without secrets.
- Modify `README.md`, `RESUME_CONTEXT.md`, `server/README.md` — document commands, timers, paper gates, and operational boundaries.
- Modify `scripts/paper-monitor-runner.mjs` — add guarded Level 2 task names and locks.
- Create `server/systemd/alpaca-zero-dte-engine.service` and `.timer`.
- Create `server/systemd/alpaca-zero-dte-exit-review.service` and `.timer`.
- Create `server/systemd/alpaca-zero-dte-reconcile.service` and `.timer`.
- Create `server/systemd/alpaca-zero-dte-eod.service` and `.timer`.
- Modify `server/dashboard-control/server.ts` — add a sanitized Level 2 summary action/read route.
- Create `apps/dashboard/app/api/paper/zero-dte/summary/route.ts` — read-only bridge route.
- Modify `apps/dashboard/lib/data.ts` — load and normalize Level 2 summary data.
- Create `apps/dashboard/app/components/ZeroDtePanel.tsx` — read-only queue/health/shadow/lifecycle view.
- Modify `apps/dashboard/app/page.tsx` and `apps/dashboard/app/globals.css` — render the panel consistently.
- Modify `tests/paperMonitoringScheduler.test.ts` and dashboard tests for the new integration surfaces.

## Task 1: Add configuration contracts and the additive database migration

**Files:**
- Test: `tests/zeroDteConfig.test.ts`, `tests/zeroDtePersistence.test.ts`
- Create: `src/services/zeroDte/zeroDteTypes.ts`, `src/services/zeroDte/zeroDteConfigService.ts`, `src/lib/zeroDteSchema.ts`
- Modify: `src/lib/db.ts`, `src/config.ts`, `.env.example`

**Interfaces:**

```ts
export type ZeroDtePlaybook =
  | "trend_continuation"
  | "reversal"
  | "breakout"
  | "gamma_proxy"
  | "volatility_expansion";

export type ZeroDteDirection = "bullish" | "bearish" | "neutral";
export type ZeroDteCandidateState =
  | "discovered" | "watching" | "strengthening" | "stable" | "weakening"
  | "eligible" | "selected" | "executed" | "shadowed" | "skipped"
  | "rejected" | "expired" | "invalidated" | "closed";

export interface ZeroDteConfig {
  enabled: boolean;
  paperExecutionEnabled: boolean;
  shadowEnabled: boolean;
  underlyings: string[];
  discoveryStartEt: string;
  newEntryCutoffEt: string;
  forceExitEt: string;
  engineIntervalSeconds: number;
  queueMaxActive: number;
  queueTopN: number;
  executionTopN: number;
  maxStrikesEachSide: number;
  minOptionVolume: number;
  minOpenInterest: number;
  maxSpreadPct: number;
  minPremium: number;
  maxPremium: number;
  signalShortWindow: number;
  signalMediumWindow: number;
  minConfirmationObservations: number;
  maxContractsPerTrade: number;
  maxOpenPositions: number;
  maxTradesPerDay: number;
  maxPremiumPerTrade: number;
  maxDailyPremium: number;
  maxDailyRealizedLoss: number;
  outcomeHorizonsMinutes: number[];
  strategyVersion: string;
  configurationVersionId: string;
}

export const loadZeroDteConfig = (env?: NodeJS.ProcessEnv): ZeroDteConfig;
```

- [ ] **Step 1: Write failing config tests.** Assert that defaults match the specification, comma-separated underlyings are trimmed/deduplicated/uppercased, invalid non-negative numbers fall back to defaults, horizon lists are sorted/deduplicated, and the configuration hash is stable when environment key order changes.

- [ ] **Step 2: Run the config tests to verify RED.**

Run: `npx tsx --test tests/zeroDteConfig.test.ts`

Expected: FAIL because `zeroDteConfigService.ts` and its exported types do not exist.

- [ ] **Step 3: Write failing migration tests.** Use `tests/helpers/sqliteTestDb.ts` to initialize a clean temporary database, assert all Level 2 tables/indexes exist, run initialization twice, and assert `schema_migrations` contains one `2026-07-13-zero-dte-level-2` row.

- [ ] **Step 4: Run the migration tests to verify RED.**

Run: `npx tsx --test tests/zeroDtePersistence.test.ts`

Expected: FAIL because the Level 2 schema is absent.

- [ ] **Step 5: Implement types, config, and migration.** Add `loadZeroDteConfig`, `configurationVersionId`, nullable market/evidence columns, foreign keys, append-only event tables, unique candidate identity, and indexes for date/state/group/open-trade queries. Import `runZeroDteMigrations` into `initializeDatabaseHandle` after the existing migration functions.

The migration must create these tables with typed core columns: `zero_dte_engine_runs`, `zero_dte_candidates`, `zero_dte_candidate_observations`, `zero_dte_playbook_evaluations`, `zero_dte_decisions`, `zero_dte_lifecycle_events`, `zero_dte_paper_trades`, `zero_dte_shadow_trades`, `zero_dte_position_marks`, `zero_dte_terminal_outcomes`, and `zero_dte_configuration_versions`.

- [ ] **Step 6: Run focused tests and database verification.**

Run: `npx tsx --test tests/zeroDteConfig.test.ts tests/zeroDtePersistence.test.ts`

Expected: PASS with idempotent migration assertions.

Run: `npm run db:verify`

Expected: PASS without modifying existing non-Level-2 tables.

- [ ] **Step 7: Document new environment names.** Add the exact `ZERO_DTE_*` names from the spec to `.env.example` with paper-safe comments; do not add credentials or change existing legacy 0DTE defaults.

- [ ] **Step 8: Commit the foundational slice.**

```bash
git add -- src/lib/zeroDteSchema.ts src/lib/db.ts src/config.ts src/services/zeroDte/zeroDteTypes.ts src/services/zeroDte/zeroDteConfigService.ts tests/zeroDteConfig.test.ts tests/zeroDtePersistence.test.ts .env.example
git commit -m "Add 0DTE Level 2 schema and configuration"
```

## Task 2: Implement candidate identity, signal state, and deterministic ranking

**Files:**
- Test: `tests/zeroDteIdentity.test.ts`, `tests/zeroDteSignal.test.ts`, `tests/zeroDteRanking.test.ts`
- Create: `src/services/zeroDte/zeroDteIdentityService.ts`, `src/services/zeroDte/zeroDteSignalService.ts`, `src/services/zeroDte/zeroDteRankingService.ts`

**Interfaces:**

```ts
export interface ZeroDteCandidateIdentityInput {
  tradingDate: string;
  underlying: string;
  optionSymbol: string;
  playbook: ZeroDtePlaybook;
  direction: ZeroDteDirection;
  expirationDate: string;
  strike: number;
}

export const buildZeroDteCandidateId = (input: ZeroDteCandidateIdentityInput): string;
export const buildZeroDteDecisionId = (runId: string, candidateId: string): string;
export const buildZeroDteClientOrderId = (input: {
  tradingDate: string; candidateId: string; action: "entry" | "exit"; attempt: number;
}): string;

export interface ZeroDteSignalSummary {
  scoreChange: number | null;
  shortSlope: number | null;
  mediumSlope: number | null;
  peakScore: number;
  drawdownFromPeak: number;
  strengtheningDurationMs: number;
  weakeningDurationMs: number;
  observationCount: number;
  setupAgeMs: number;
  state: ZeroDteCandidateState;
  reappeared: boolean;
}

export const summarizeZeroDteSignal = (input: {
  scores: Array<{ observedAt: string; score: number }>;
  previousState: ZeroDteCandidateState | null;
  minimumMovement: number;
  minimumConfirmationObservations: number;
}): ZeroDteSignalSummary;

export const rankZeroDteQueue = (candidates: ZeroDteQueueCandidate[]): ZeroDteQueueCandidate[];
```

- [ ] **Step 1: Write failing identity tests.** Prove equivalent canonical inputs produce the same candidate ID, any changed identity field produces a different ID, and client order IDs are stable and bounded to broker-safe characters.

- [ ] **Step 2: Run identity tests to verify RED.**

Run: `npx tsx --test tests/zeroDteIdentity.test.ts`

Expected: FAIL because the identity service is absent.

- [ ] **Step 3: Implement identity helpers.** Use canonical JSON plus SHA-256; uppercase symbols and normalize numeric strike text before hashing. Prefix IDs with `zdt_`, `zdec_`, and `zord_` respectively.

- [ ] **Step 4: Run identity tests to verify GREEN.**

Run: `npx tsx --test tests/zeroDteIdentity.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing signal tests.** Cover strengthening only after the configured movement and confirmation count, weakening after a meaningful decline, stable for insignificant movement, drawdown from peak, expired-to-strengthening reappearance, and nullable slope values with insufficient observations.

- [ ] **Step 6: Run signal tests to verify RED.**

Run: `npx tsx --test tests/zeroDteSignal.test.ts`

Expected: FAIL because the signal service is absent.

- [ ] **Step 7: Implement signal summaries.** Use chronological observations, linear slope over the configured windows, peak score, state duration, and explicit `reappeared` detection. Never classify on floating-point noise below `minimumMovement`.

- [ ] **Step 8: Run signal tests to verify GREEN.**

Run: `npx tsx --test tests/zeroDteSignal.test.ts`

Expected: PASS.

- [ ] **Step 9: Write failing ranking tests.** Assert eligibility precedes score, then total score, slope, liquidity, freshness, spread, and candidate ID tie-breakers; assert queue top-N and execution top-N are separate slices.

- [ ] **Step 10: Run ranking tests to verify RED.**

Run: `npx tsx --test tests/zeroDteRanking.test.ts`

Expected: FAIL because the ranking service is absent.

- [ ] **Step 11: Implement deterministic ranking.** Keep component scores and blocker arrays unchanged; only calculate `rank` and queue slices in the ranking service.

- [ ] **Step 12: Run focused tests and commit.**

Run: `npx tsx --test tests/zeroDteIdentity.test.ts tests/zeroDteSignal.test.ts tests/zeroDteRanking.test.ts`

Expected: PASS.

```bash
git add -- src/services/zeroDte/zeroDteIdentityService.ts src/services/zeroDte/zeroDteSignalService.ts src/services/zeroDte/zeroDteRankingService.ts tests/zeroDteIdentity.test.ts tests/zeroDteSignal.test.ts tests/zeroDteRanking.test.ts
git commit -m "Add 0DTE candidate identity and queue ranking"
```

## Task 3: Implement regime detection and the five pure playbooks

**Files:**
- Test: `tests/zeroDtePlaybook.test.ts`
- Create: `src/services/zeroDte/zeroDteRegimeService.ts`, `src/services/zeroDte/zeroDtePlaybookService.ts`
- Read/reuse: `src/services/indicators.ts`, `src/services/marketRegimeService.ts`

**Interfaces:**

```ts
export type ZeroDteRegime =
  | "trend" | "range" | "high-volatility" | "low-volatility" | "event-risk" | "uncertain";

export interface ZeroDtePlaybookContext {
  underlying: string;
  price: number;
  barsByTimeframe: Record<string, ZeroDteBar[]>;
  option: ZeroDteOptionQuote;
  indicators: ZeroDteIndicators;
  regime: ZeroDteRegime;
  asOf: string;
  eventCalendarEvidence: string[];
}

export const classifyZeroDteRegime = (input: {
  indicators: ZeroDteIndicators;
  verifiedEventRisk: boolean;
}): { regime: ZeroDteRegime; evidence: SignalEvidence[]; blockers: string[] };

export const evaluateZeroDtePlaybooks = (
  context: ZeroDtePlaybookContext
): PlaybookEvaluation[];
```

- [ ] **Step 1: Write failing regime/playbook tests.** Use deterministic bars and option quotes to assert: trend continuation scores bullish and bearish directions symmetrically; reversal requires stronger confirmation; breakout requires opening-range evidence; gamma returns insufficient data when gamma/open interest are absent; volatility expansion exposes its component contributions; and event-risk is never inferred without verified evidence.

- [ ] **Step 2: Run playbook tests to verify RED.**

Run: `npx tsx --test tests/zeroDtePlaybook.test.ts`

Expected: FAIL because the regime and playbook services are absent.

- [ ] **Step 3: Implement shared scoring helpers and regime classification.** Use clamped 0–100 scores, explicit `SignalEvidence` objects, nullable indicators, and separate missing-input/blocker arrays. Keep each playbook evaluator pure and non-mutating.

- [ ] **Step 4: Implement trend continuation and reversal.** Use VWAP distance, EMA alignment, multi-timeframe direction, relative volume, ATR-normalized displacement, exhaustion, failed break, reversal candle, and liquidity. Do not map calls to bullish or puts to bearish without checking the evaluated direction.

- [ ] **Step 5: Run the targeted tests to verify the first playbooks.**

Run: `npx tsx --test tests/zeroDtePlaybook.test.ts --test-name-pattern='trend|reversal'`

Expected: PASS for those tests.

- [ ] **Step 6: Implement breakout, gamma proxy, and volatility expansion.** Make opening-range minutes configurable; label gamma inputs as proxy metrics; return `eligible: false` with `missingInputs` when required gamma/open-interest data is absent; and retain each component contribution in the returned evaluation.

- [ ] **Step 7: Run the complete playbook test file.**

Run: `npx tsx --test tests/zeroDtePlaybook.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit the pure evaluation slice.**

```bash
git add -- src/services/zeroDte/zeroDteRegimeService.ts src/services/zeroDte/zeroDtePlaybookService.ts tests/zeroDtePlaybook.test.ts
git commit -m "Add 0DTE Level 2 playbooks"
```

## Task 4: Build direct market-data and contract discovery adapters

**Files:**
- Test: `tests/zeroDteMarketData.test.ts`
- Create: `src/services/zeroDte/zeroDteMarketDataService.ts`
- Read/reuse: `src/services/alpacaClient.ts`, `src/services/alpacaMarketClockService.ts`, `src/services/optionsService.ts`, `src/services/optionSnapshotNormalizer.ts`, `src/services/optionSymbolService.ts`

**Interfaces:**

```ts
export interface ZeroDteMarketDataProvider {
  getClock(): Promise<{ timestamp: string; isOpen: boolean; nextClose: string; requestId?: string }>;
  getStockSnapshot(symbols: string[]): Promise<Record<string, ZeroDteStockSnapshot>>;
  getBars(symbol: string, timeframe: "1Min" | "5Min" | "15Min", start: string, end: string): Promise<ZeroDteBar[]>;
  listContracts(input: { underlying: string; expirationDate: string; limit: number }): Promise<ZeroDteContract[]>;
  getOptionSnapshots(symbols: string[]): Promise<Record<string, ZeroDteOptionQuote>>;
}

export const createAlpacaZeroDteMarketDataProvider = (): ZeroDteMarketDataProvider;
export const collectZeroDteMarketContexts = (input: {
  now: string;
  config: ZeroDteConfig;
  provider: ZeroDteMarketDataProvider;
}): Promise<ZeroDteMarketContext[]>;
```

- [ ] **Step 1: Write failing market-data tests.** Inject a fake provider and assert the adapter refuses closed sessions, uses the explicit session date for same-day expiration, narrows strikes around the underlying, preserves source/ingestion timestamps, and marks missing/crossed/stale quotes without inventing values.

- [ ] **Step 2: Run market-data tests to verify RED.**

Run: `npx tsx --test tests/zeroDteMarketData.test.ts`

Expected: FAIL because the market-data service is absent.

- [ ] **Step 3: Implement the injected provider and Alpaca adapter.** Use `getAlpacaMarketClock`, paper-only/data endpoints, existing option snapshot normalization, and explicit `requestId` capture. Do not call Observatory persistence or require `stock_snapshots`.

- [ ] **Step 4: Implement staged discovery.** Load underlying context first, select plausible directions/playbooks, retrieve same-session contracts only, select the configured strike band, apply volume/open-interest/spread/premium filters, and return a bounded list of quote-bearing contracts.

- [ ] **Step 5: Run the market-data tests to verify GREEN.**

Run: `npx tsx --test tests/zeroDteMarketData.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the direct-data slice.**

```bash
git add -- src/services/zeroDte/zeroDteMarketDataService.ts tests/zeroDteMarketData.test.ts
git commit -m "Add independent 0DTE market data discovery"
```

## Task 5: Add typed persistence, candidate upserts, decisions, and lifecycle events

**Files:**
- Test: `tests/zeroDtePersistence.test.ts`, `tests/zeroDteLifecycle.test.ts`
- Create: `src/services/zeroDte/zeroDtePersistenceService.ts`, `src/services/zeroDte/zeroDteLifecycleService.ts`

**Interfaces:**

```ts
export const upsertZeroDteCandidate = (input: ZeroDteCandidateUpsert): ZeroDteCandidate;
export const appendZeroDteCandidateObservation = (input: ZeroDteObservationInput): void;
export const insertZeroDtePlaybookEvaluation = (input: PlaybookEvaluationInput): void;
export const listZeroDteQueue = (input: { tradingDate: string; limit: number }): ZeroDteQueueCandidate[];
export const insertZeroDteDecision = (input: ZeroDteDecisionInput): ZeroDteDecision;
export const appendZeroDteLifecycleEvent = (input: ZeroDteLifecycleEventInput): ZeroDteLifecycleEvent;
export const readZeroDteSummary = (input: { tradingDate?: string; limit?: number }): ZeroDteSummary;
```

- [ ] **Step 1: Write failing persistence tests.** Assert same candidate identity updates one row; each engine pass appends one observation and one evaluation per playbook; state changes create events; lifecycle rows are append-only; JSON evidence is redacted/sanitized; and queue read models expose typed component fields.

- [ ] **Step 2: Run persistence tests to verify RED.**

Run: `npx tsx --test tests/zeroDtePersistence.test.ts tests/zeroDteLifecycle.test.ts`

Expected: FAIL because the persistence/lifecycle functions are absent.

- [ ] **Step 3: Implement transaction-safe persistence.** Use `getDb()` and existing query helpers, parameterized SQL, the candidate unique key, and explicit `created_at`/`updated_at` timestamps. Keep lifecycle event inserts append-only; corrections become new events.

- [ ] **Step 4: Implement state-transition and reappearance persistence.** Compare the prior candidate state/signal summary, store `reappearance_count`, persist exact reason codes, and link candidate/decision/run/group IDs.

- [ ] **Step 5: Run persistence/lifecycle tests to verify GREEN.**

Run: `npx tsx --test tests/zeroDtePersistence.test.ts tests/zeroDteLifecycle.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the persistence slice.**

```bash
git add -- src/services/zeroDte/zeroDtePersistenceService.ts src/services/zeroDte/zeroDteLifecycleService.ts tests/zeroDtePersistence.test.ts tests/zeroDteLifecycle.test.ts
git commit -m "Persist 0DTE candidates and lifecycle evidence"
```

## Task 6: Implement isolated shadow trades and forward outcomes

**Files:**
- Test: `tests/zeroDteShadow.test.ts`, `tests/zeroDteOutcome.test.ts`
- Create: `src/services/zeroDte/zeroDteShadowService.ts`, `src/services/zeroDte/zeroDteOutcomeService.ts`

**Interfaces:**

```ts
export const createZeroDteShadowTrade = (input: {
  candidate: ZeroDteQueueCandidate;
  decisionGroupId: string;
  reasonCode: string;
  asOf: string;
}): ZeroDteShadowTrade | null;

export const markZeroDteShadowTrades = (input: {
  asOf: string;
  quotes: Record<string, ZeroDteOptionQuote>;
}): ZeroDteMarkResult;

export const captureZeroDteOutcomes = (input: {
  asOf: string;
  candidates: ZeroDteMissedCandidate[];
  quotes: Record<string, ZeroDteOptionQuote>;
  horizonsMinutes: number[];
}): ZeroDteOutcomeResult;
```

- [ ] **Step 1: Write failing shadow tests.** Assert qualifying skipped/runner-up candidates create shadow rows, entry uses ask plus slippage, exit uses bid minus slippage, fees are included, invalid spread prevents fill, and no provider order method is called.

- [ ] **Step 2: Run shadow tests to verify RED.**

Run: `npx tsx --test tests/zeroDteShadow.test.ts`

Expected: FAIL because the shadow service is absent.

- [ ] **Step 3: Implement shadow creation and marking.** Persist a `simulated` discriminator, decision group, fill method, quantity, notional, fees, current mark, MFE, MAE, and terminal reason in the shadow tables only.

- [ ] **Step 4: Run shadow tests to verify GREEN.**

Run: `npx tsx --test tests/zeroDteShadow.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing outcome tests.** Assert eligible missed candidates receive 5/15/30/60-minute marks when available, incomplete data is labeled, directional correctness uses the original thesis direction, and terminal marks close open records at session end.

- [ ] **Step 6: Run outcome tests to verify RED.**

Run: `npx tsx --test tests/zeroDteOutcome.test.ts`

Expected: FAIL because the outcome service is absent.

- [ ] **Step 7: Implement outcome capture and daily summary aggregation.** Aggregate counts by state/playbook/score band/time-of-day, paper/shadow P&L, MFE/MAE, blocking reasons, largest missed opportunity, and retrospective recommendations without modifying configuration.

- [ ] **Step 8: Run outcome tests and commit.**

Run: `npx tsx --test tests/zeroDteShadow.test.ts tests/zeroDteOutcome.test.ts`

Expected: PASS.

```bash
git add -- src/services/zeroDte/zeroDteShadowService.ts src/services/zeroDte/zeroDteOutcomeService.ts tests/zeroDteShadow.test.ts tests/zeroDteOutcome.test.ts
git commit -m "Add isolated 0DTE shadow and outcome tracking"
```

## Task 7: Add guarded paper execution and Level 2 exit linkage

**Files:**
- Test: `tests/zeroDteExecution.test.ts`, `tests/zeroDteExit.test.ts`
- Create: `src/services/zeroDte/zeroDteExecutionService.ts`, `src/services/zeroDte/zeroDteExitService.ts`
- Read/reuse: `src/services/runtimeMutationPreflight.ts`, `src/services/tradingSafetyService.ts`, `src/services/alpacaClient.ts`, `src/services/paperExecutionLedgerService.ts`, `src/services/paperOptionOrderValidationService.ts`, `src/services/paperExitReviewService.ts`, `src/services/paperExitExecutionService.ts`

**Interfaces:**

```ts
export const evaluateZeroDteExecutionEligibility = (input: {
  candidate: ZeroDteQueueCandidate;
  config: ZeroDteConfig;
  runtime: ZeroDteRuntimeSnapshot;
  account: ZeroDteAccountSnapshot;
  now: string;
}): ZeroDteEligibilityResult;

export const executeZeroDteCandidate = (input: {
  candidate: ZeroDteQueueCandidate;
  decisionId: string;
  confirmPaper: boolean;
  provider?: ZeroDtePaperMutationProvider;
}): Promise<ZeroDteExecutionResult>;

export const reviewZeroDteExits = (input: {
  now?: string;
  confirmPaper: boolean;
  provider?: ZeroDteExitProvider;
}): Promise<ZeroDteExitReviewResult>;
```

- [ ] **Step 1: Write failing execution tests.** Cover non-paper environment, live flag enabled, missing paper execution flags, missing confirmation, stale/crossed quotes, missing buying power, daily caps, duplicate positions/orders, and disabled playbooks. Assert every case persists a structured blocker and invokes no order method.

- [ ] **Step 2: Run execution tests to verify RED.**

Run: `npx tsx --test tests/zeroDteExecution.test.ts`

Expected: FAIL because the execution service is absent.

- [ ] **Step 3: Implement paper eligibility and reservation.** Call existing runtime preflight and paper-only safety checks; use the canonical `tradingDate:optionSymbol:action` reservation key; reuse the execution ledger; and derive the broker-safe client order ID from `zeroDteIdentityService.ts`.

- [ ] **Step 4: Implement the paper mutation adapter.** Build only `limit`, `day`, `buy_to_open`, or `sell_to_close` payloads; call `submitPaperOrder` only after all gates pass; record request ID/order ID/status; and persist `paper_order_requested`, accepted/rejected, and fill lifecycle events.

- [ ] **Step 5: Run execution tests to verify GREEN.**

Run: `npx tsx --test tests/zeroDteExecution.test.ts`

Expected: PASS, including an assertion that the mutation provider is never called in blocked cases.

- [ ] **Step 6: Write failing exit-linkage tests.** Assert the Level 2 exit service recognizes only same-session 0DTE positions, delegates thresholds to `DEFAULT_0DTE_EXIT_RULES`/`buildPaperExitReviewResult`, preserves `ODTE_BELOW_MIN_SELLABLE_VALUE`, and records per-minute exit/lifecycle evidence.

- [ ] **Step 7: Run exit tests to verify RED.**

Run: `npx tsx --test tests/zeroDteExit.test.ts`

Expected: FAIL because the Level 2 exit service is absent.

- [ ] **Step 8: Implement exit review and optional confirmed paper exit.** Reuse `paperExitReviewService.ts` and `paperExitExecutionService.ts`; do not duplicate exit thresholds or create synthetic sells; link resulting candidates to Level 2 trade/decision IDs.

- [ ] **Step 9: Run focused exit tests and commit.**

Run: `npx tsx --test tests/zeroDteExecution.test.ts tests/zeroDteExit.test.ts`

Expected: PASS.

```bash
git add -- src/services/zeroDte/zeroDteExecutionService.ts src/services/zeroDte/zeroDteExitService.ts tests/zeroDteExecution.test.ts tests/zeroDteExit.test.ts
git commit -m "Add guarded 0DTE paper execution and exits"
```

## Task 8: Orchestrate the engine and expose CLI commands

**Files:**
- Test: `tests/zeroDteEngine.test.ts`
- Create: `src/services/zeroDte/zeroDteEngineService.ts`
- Modify: `src/cli.ts`, `package.json`

**Interfaces:**

```ts
export const runZeroDteEngine = (input: {
  now?: string;
  dryRun?: boolean;
  confirmPaper?: boolean;
  provider?: ZeroDteMarketDataProvider;
}): Promise<ZeroDteEngineRunResult>;

export const runZeroDteReconciliation = (input: { now?: string }): Promise<ZeroDteReconciliationResult>;
export const runZeroDteEodSummary = (input: { now?: string }): Promise<ZeroDteDailySummary>;
export const buildZeroDteSummary = (input: { tradingDate?: string; limit?: number }): ZeroDteSummary;
```

- [ ] **Step 1: Write failing orchestration tests.** Use injected market-data and mutation providers to prove one run creates one run ID/configuration version, evaluates all configured underlyings and playbooks, upserts candidates, ranks the queue, creates decisions/events, produces shadow alternatives, and never requires an Observatory row.

- [ ] **Step 2: Run engine tests to verify RED.**

Run: `npx tsx --test tests/zeroDteEngine.test.ts`

Expected: FAIL because the engine service is absent.

- [ ] **Step 3: Implement the engine cycle.** Sequence session validation, context collection, evaluation, candidate persistence, ranking, selection, lifecycle, execution/shadow, and run finalization. Catch provider failures per underlying, persist redacted errors, and continue other configured underlyings.

- [ ] **Step 4: Implement reconciliation and end-of-day orchestration.** Mark paper/shadow trades, resolve fills, capture forward outcomes, force terminal marks at the configured cutoff, and persist daily summary rows.

- [ ] **Step 5: Run engine tests to verify GREEN.**

Run: `npx tsx --test tests/zeroDteEngine.test.ts`

Expected: PASS.

- [ ] **Step 6: Add CLI routing.** Import the engine functions into `src/cli.ts` and add these exact commands: `zero-dte:engine`, `zero-dte:exit:review`, `zero-dte:reconcile`, `zero-dte:eod`, and `zero-dte:summary`. Support `--format=json`, `--dryRun`, and `--confirmPaper`; use the existing `print` redaction wrapper.

- [ ] **Step 7: Add package scripts.** Add `zero-dte:engine`, `zero-dte:exit:review`, `zero-dte:reconcile`, `zero-dte:eod`, and `zero-dte:summary` scripts without changing existing command names.

- [ ] **Step 8: Run CLI/type validation and commit.**

Run: `npx tsx --test tests/zeroDteEngine.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

```bash
git add -- src/services/zeroDte/zeroDteEngineService.ts src/cli.ts package.json tests/zeroDteEngine.test.ts
git commit -m "Add 0DTE Level 2 engine commands"
```

## Task 9: Add guarded 1-minute scheduling and systemd services

**Files:**
- Test: `tests/paperMonitoringScheduler.test.ts`
- Modify: `scripts/paper-monitor-runner.mjs`
- Create: `server/systemd/alpaca-zero-dte-engine.service`, `server/systemd/alpaca-zero-dte-engine.timer`, `server/systemd/alpaca-zero-dte-exit-review.service`, `server/systemd/alpaca-zero-dte-exit-review.timer`, `server/systemd/alpaca-zero-dte-reconcile.service`, `server/systemd/alpaca-zero-dte-reconcile.timer`, `server/systemd/alpaca-zero-dte-eod.service`, `server/systemd/alpaca-zero-dte-eod.timer`

- [ ] **Step 1: Write failing scheduler tests.** Assert all four task names exist, use dedicated lock files, call only Level 2 paper scripts, fail closed on live/non-paper environments, no-op when the session is closed, and never include a live command or secret.

- [ ] **Step 2: Run scheduler tests to verify RED.**

Run: `npx tsx --test tests/paperMonitoringScheduler.test.ts --test-name-pattern='zero-dte'`

Expected: FAIL because the tasks and units are absent.

- [ ] **Step 3: Add task definitions.** Use `zero-dte-engine`, `zero-dte-exit-review`, `zero-dte-reconcile`, and `zero-dte-eod` with locks under `/tmp/alpaca-zero-dte-*.lock`. Entry/exit execution flags must be checked only for tasks that can mutate; dry-run/read tasks remain non-mutating.

- [ ] **Step 4: Add timer/service units.** Use `User=alpaca`, the existing `EnvironmentFile`, the existing working directory, `npm run paper:monitor`, `Persistent=false`, and America/New_York-compatible weekday schedules. The runner remains the final session/lock/paper gate.

- [ ] **Step 5: Run scheduler tests and syntax checks.**

Run: `npx tsx --test tests/paperMonitoringScheduler.test.ts --test-name-pattern='zero-dte'`

Expected: PASS.

Run: `node --check scripts/paper-monitor-runner.mjs`

Expected: exit 0.

- [ ] **Step 6: Commit the scheduler slice.**

```bash
git add -- scripts/paper-monitor-runner.mjs server/systemd/alpaca-zero-dte-*.service server/systemd/alpaca-zero-dte-*.timer tests/paperMonitoringScheduler.test.ts
git commit -m "Schedule guarded 0DTE Level 2 operations"
```

## Task 10: Add the read-only dashboard surface

**Files:**
- Test: existing dashboard bridge/guard tests plus a new `tests/zeroDteDashboard.test.ts`
- Modify: `server/dashboard-control/server.ts`, `apps/dashboard/lib/data.ts`, `apps/dashboard/app/page.tsx`, `apps/dashboard/app/globals.css`
- Create: `apps/dashboard/app/api/paper/zero-dte/summary/route.ts`, `apps/dashboard/app/components/ZeroDtePanel.tsx`

**Interfaces:**

```ts
export interface ZeroDteDashboardSummary {
  paperOnly: true;
  generatedAt: string;
  engine: { enabled: boolean; lastRunAt: string | null; status: string; queueSize: number; staleDataCount: number };
  queue: ZeroDteQueueCandidate[];
  paperPositions: ZeroDtePaperPosition[];
  shadowTrades: ZeroDteShadowTrade[];
  lifecycle: { counts: Record<string, number>; recent: ZeroDteLifecycleEvent[] };
  learning: ZeroDteDailySummary | null;
  blockers: string[];
}
```

- [ ] **Step 1: Write failing dashboard-data tests.** Assert the bridge returns `paperOnly: true`, limits queue/shadow/lifecycle rows, labels shadow rows simulated, and strips secrets/raw payloads.

- [ ] **Step 2: Run dashboard tests to verify RED.**

Run: `npx tsx --test tests/zeroDteDashboard.test.ts`

Expected: FAIL because the route/data/panel are absent.

- [ ] **Step 3: Add the VPS summary action/read route.** Return only `readZeroDteSummary` plus sanitized engine health; keep the route read-only and use existing bridge authentication/timeout conventions.

- [ ] **Step 4: Add the Vercel route and data loader.** Follow existing `apps/dashboard/app/api/paper/*` and `apps/dashboard/lib/data.ts` bridge patterns; return a bounded error envelope on unavailable VPS data.

- [ ] **Step 5: Add `ZeroDtePanel`.** Render queue rank/score/slope/spread/block reason, paper positions and exits, simulated shadow trades, lifecycle counts, learning summary, and engine health with the existing panel styles. Do not add mutation controls.

- [ ] **Step 6: Run dashboard tests/build.**

Run: `npx tsx --test tests/zeroDteDashboard.test.ts tests/dashboardVercelBridge.test.ts tests/dashboardGuard.test.ts`

Expected: PASS.

Run: `npm run dashboard:build`

Expected: exit 0.

- [ ] **Step 7: Commit the dashboard slice.**

```bash
git add -- server/dashboard-control/server.ts apps/dashboard/app/api/paper/zero-dte/summary/route.ts apps/dashboard/lib/data.ts apps/dashboard/app/components/ZeroDtePanel.tsx apps/dashboard/app/page.tsx apps/dashboard/app/globals.css tests/zeroDteDashboard.test.ts
git commit -m "Expose 0DTE Level 2 dashboard state"
```

## Task 11: Add operational documentation and regression coverage

**Files:**
- Modify: `README.md`, `RESUME_CONTEXT.md`, `server/README.md`, `package.json`
- Test: existing focused suites affected by CLI/config/db/scheduler changes

- [ ] **Step 1: Add documented commands and flags.** Document dry-run, read-only summary, paper confirmation, timer names, database ownership, exact paper/live gates, shadow isolation, and closed-market behavior. Keep credentials and token values out of examples.

- [ ] **Step 2: Add regression test entries.** Add the focused Level 2 tests to the repository's test workflow without removing `pretest`, paper-exit, observatory, hedge, or dashboard suites.

- [ ] **Step 3: Run documentation/config checks.**

Run: `git diff --check`

Expected: exit 0.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 4: Commit documentation and test wiring.**

```bash
git add -- README.md RESUME_CONTEXT.md server/README.md package.json
git commit -m "Document 0DTE Level 2 paper operations"
```

## Task 12: Run bounded validation and prepare paper deployment

**Files:**
- Modify only if validation finds a concrete defect; otherwise no new files.

- [ ] **Step 1: Run the complete focused Level 2 suite.**

Run: `npx tsx --test tests/zeroDteConfig.test.ts tests/zeroDteIdentity.test.ts tests/zeroDteSignal.test.ts tests/zeroDteRanking.test.ts tests/zeroDtePlaybook.test.ts tests/zeroDteMarketData.test.ts tests/zeroDtePersistence.test.ts tests/zeroDteLifecycle.test.ts tests/zeroDteShadow.test.ts tests/zeroDteOutcome.test.ts tests/zeroDteExecution.test.ts tests/zeroDteExit.test.ts tests/zeroDteEngine.test.ts tests/zeroDteDashboard.test.ts`

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run shared regression suites.**

Run: `npx tsx --test tests/paperExitService.test.ts tests/paperExecuteDryRunService.test.ts tests/paperMonitoringScheduler.test.ts tests/marketObservatory.test.ts tests/marketDecisionTraceability.test.ts tests/dashboardGuard.test.ts tests/dashboardVercelBridge.test.ts`

Expected: all tests pass; any failure must be traced to the Level 2 diff before changing code.

- [ ] **Step 3: Run repository checks.**

Run: `npm run typecheck`

Expected: exit 0.

Run: `npm run build`

Expected: exit 0.

Run: `npm run dashboard:build`

Expected: exit 0.

Run: `node --check scripts/paper-monitor-runner.mjs`

Expected: exit 0.

- [ ] **Step 4: Run the dry engine cycle.**

Run: `ALPACA_ENV=paper TRADING_MODE=paper ALPACA_LIVE_TRADE=false LIVE_TRADING_ENABLED=false ZERO_DTE_PAPER_EXECUTION_ENABLED=false npm run zero-dte:engine -- --dryRun --format=json`

Expected: sanitized JSON with `paperOnly: true`, no broker mutation, a persisted run outcome, and explicit data/session blockers if credentials or market data are unavailable.

- [ ] **Step 5: Verify migration and working-tree scope.**

Run: `npm run db:verify`

Expected: exit 0.

Run: `git diff --check && git status --short`

Expected: no conflict markers and only intended feature files plus the pre-existing hedge-plan modification.

- [ ] **Step 6: Commit only after fresh verification.** Inspect `git diff --cached --stat`, `git diff --cached --check`, and the full staged file list before the implementation commit. Do not stage the pre-existing hedge plan.

- [ ] **Step 7: Push, create/update the explicitly authorized PR, merge, and deploy.** Use the merged SHA as the VPS/Vercel deployment source. Apply the additive migration, verify redacted paper flags and paper account identity, install/enable the four Level 2 timers, and run one read-only cycle.

- [ ] **Step 8: Run one paper-enabled cycle only when naturally eligible.** If the market is closed or no candidate passes all gates, record that evidence and leave the scheduler enabled without manufacturing a trade.

- [ ] **Step 9: Validate runtime surfaces.** Confirm candidates/observations/rankings/playbooks/lifecycle/shadow state in SQLite, paper execution reachability through the existing paper-only path, no live route, timer status, dashboard rendering, and redacted logs.

- [ ] **Step 10: Update Basic Memory Cloud.** Record branch, merged/deployed SHA, services/timers, migration version, enabled flags, universe, last run, paper-account verification, dashboard status, validation commands, known limitations, and concrete next work without secrets.

## Plan self-review checklist

- Spec coverage: Tasks 1–3 cover configuration, identity, signals, ranking, regimes, and all five playbooks; Tasks 4–7 cover independent data, persistence, lifecycle, shadow, outcomes, execution, and exits; Tasks 8–10 cover orchestration, timers, and dashboard; Tasks 11–12 cover documentation, validation, deployment, and durable handoff.
- Safety coverage: paper identity, live-off flags, existing execution gates, confirmation, deterministic reservations, no synthetic orders, Vercel read-only behavior, and secret redaction are explicit in the global constraints and Tasks 7–12.
- Persistence coverage: all eleven logical Level 2 entities, typed core fields, append-only events, indexes, configuration hashes, and migration idempotency are explicit in Tasks 1 and 5.
- Signal coverage: score movement threshold, short/medium slopes, peak/drawdown, state transitions, and reappearance are explicit in Task 2.
- Playbook coverage: all five playbooks, data-backed gamma behavior, regime evidence, and structured missing-input handling are explicit in Task 3.
- Operational coverage: 1-minute engine/exit cadence, 5-minute reconciliation, end-of-day summary, locking, session gates, timer units, dashboard health, and deployment checks are explicit in Tasks 8–12.
- Placeholder scan: the plan contains no unresolved placeholders or conflict markers.
