# PostgreSQL Market Data and Worker Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the existing autonomous paper worker's required market-data, research, review, reconciliation, and execution-evidence paths to PostgreSQL-only runtime authority and deploy one verified paper-only cycle.

**Architecture:** Add an append-only PostgreSQL market-data schema and a narrow repository used by a PostgreSQL-native research pipeline. Keep Alpaca SIP/OPRA clients and existing indicator, expression-selection, risk, allocation, sizing, review, and execution contracts; replace only their SQLite persistence reads/writes with async PostgreSQL operations. Worker commands remain scheduler-fenced and fail closed on missing, conflicting, or stale evidence.

**Tech Stack:** TypeScript, Node.js 22, `pg`, Neon PostgreSQL, Alpaca paper/SIP/OPRA APIs, systemd, Node test runner.

## Global Constraints

- `ALPACA_ENV=paper`, `TRADING_MODE=paper`, `ALPACA_LIVE_TRADE=false`, and `LIVE_TRADING_ENABLED=false` are mandatory.
- PostgreSQL is the sole production authority; production import graphs must not reach `src/lib/db.ts`, `node:sqlite`, SQLite migrations, mirrors, fallbacks, backfills, or dual writes.
- Preserve the existing 16 workstreams, their order, strategy logic, evidence rules, sizing, allocations, risk limits, thresholds, and exit rules.
- Do not submit a live order. Do not manually force a paper order.
- Every behavior change follows red-green-refactor and every deployment claim requires fresh evidence.

---

### Task 1: PostgreSQL market-data schema and repository

**Files:**
- Create: `src/lib/database/migrations/003_market_data_authority.sql`
- Create: `src/repositories/postgres/postgresMarketDataRepository.ts`
- Modify: `src/lib/database/postgresSchema.ts`
- Test: `tests/postgresMarketDataRepository.test.ts`
- Test: `tests/postgresMigrations.test.ts`

**Interfaces:**
- Produces: `PostgresMarketDataRepository` methods `upsertUniverseSymbols`, `upsertBars`, `upsertStockSnapshots`, `upsertOptionContracts`, `upsertOptionSnapshots`, `upsertFeatureSnapshots`, `upsertTargetSnapshots`, and matching bounded reads.
- Produces tables: `universe_symbols`, `market_bars`, `stock_snapshots`, `option_contracts`, `option_snapshots`, `feature_snapshots`, `target_snapshots`, `options_strategy_snapshots`, and `market_data_ingestion_runs`.

- [ ] Write repository and schema-verification tests that require idempotent upserts, source/request provenance, freshness timestamps, bounded reads, and paper-only evidence.
- [ ] Run `node --import tsx --test tests/postgresMarketDataRepository.test.ts tests/postgresMigrations.test.ts` and verify RED for missing migration/repository.
- [ ] Add migration 003 without altering migrations 001 or 002; implement parameterized repository SQL under the caller's PostgreSQL transaction and scheduler fence.
- [ ] Re-run the focused tests and verify GREEN.

### Task 2: PostgreSQL-native ingestion and feature/target calculation

**Files:**
- Create: `src/services/postgresMarketDataService.ts`
- Create: `src/services/postgresFeatureTargetService.ts`
- Test: `tests/postgresMarketDataService.test.ts`
- Test: `tests/postgresFeatureTargetService.test.ts`

**Interfaces:**
- Consumes: `fetchBars`, `fetchStockSnapshots`, `fetchOptionContracts`, and `fetchOptionSnapshots` from `src/services/providers/alpaca.ts`.
- Produces: `refreshPostgresMarketData(input, context)` and `buildPostgresFeaturesAndTargets(input, context)`.
- Preserves: indicator functions from `src/services/indicators.ts` and expression selection from `src/services/strategySelector.ts`.

- [ ] Write tests for SIP bar/snapshot and OPRA contract/snapshot normalization, exact PostgreSQL writes, request provenance, and fail-closed empty/stale responses.
- [ ] Run the two focused files and verify RED for missing services.
- [ ] Implement bounded provider calls and repository writes with no SQLite import.
- [ ] Write feature/target parity tests using fixed bars and option snapshots, including insufficient-history neutral output and current timestamp propagation.
- [ ] Implement the existing indicator and target formulas against repository rows, preserving existing selector inputs and thresholds.
- [ ] Re-run both focused files and verify GREEN.

### Task 3: PostgreSQL research and candidate evidence

**Files:**
- Create: `src/services/postgresResearchWorkflowService.ts`
- Create: `src/services/postgresCandidateRankingService.ts`
- Modify: `src/postgresOnlyCli.ts`
- Test: `tests/postgresResearchWorkflowService.test.ts`
- Test: `tests/postgresCandidateRankingService.test.ts`

**Interfaces:**
- Produces: `runPostgresResearchDaily({ query, transaction, fence, ...args })` returning a completed, already-running, or failed result.
- Persists: `research_runs`, `candidates`, lifecycle events, market-data provenance, feature fingerprints, and target fingerprints.
- Consumes: current PostgreSQL learning/candidate outcome evidence; absence is explicit and does not synthesize metrics.

- [ ] Write RED tests proving fresh provider data becomes a completed research run and candidates, stale/missing data becomes a failed run, and no placeholder success is possible.
- [ ] Port the existing candidate score/cap logic into a pure dependency-injected module, preserving limits and rationale.
- [ ] Wire `research:daily` to the real PostgreSQL workflow and verify GREEN.

### Task 4: PostgreSQL reviews, reservations, and intents

**Files:**
- Create: `src/services/postgresAutonomousReviewService.ts`
- Modify: `src/services/autonomousPostgresCommandService.ts`
- Modify: `src/postgresOnlyCli.ts`
- Test: `tests/postgresAutonomousReviewService.test.ts`

**Interfaces:**
- Produces command-specific review handlers for portfolio, options discovery, operations, entries, exits, hedges, and 0DTE exits.
- Persists signed/fingerprinted `execution_reviews`, `confirmation_evidence`, `buying_power_reservations`, and `order_intents` only when complete current evidence passes existing policy.
- Consumes a fresh `PostgresAuthorityBrokerSnapshot`, PostgreSQL market evidence, active risk limits, allocations, exposure, candidates, positions, and open/pending orders.

- [ ] Write RED tests for held/open-order exclusions, stale quote rejection, unchanged sizing/risk limits, exit thresholds, option liquidity, and atomic reservation/review/intent persistence.
- [ ] Implement command-specific PostgreSQL review operations using current broker evidence and existing configuration defaults; genuine no-action results must include evaluated row counts and reason codes.
- [ ] Wire the review commands and verify GREEN.

### Task 5: PostgreSQL reconciliation, learning, and recovery

**Files:**
- Create: `src/services/postgresAutonomousReconciliationService.ts`
- Modify: `src/services/autonomousPostgresExecutionService.ts`
- Modify: `src/postgresOnlyCli.ts`
- Test: `tests/postgresAutonomousReconciliationService.test.ts`
- Test: `tests/autonomousPostgresExecutionService.test.ts`

**Interfaces:**
- Produces: `reconcilePostgresBrokerOrders(context)` with client-order identity, replacement-chain, size/terms, and ambiguous-result checks.
- Preserves: ambiguous submissions until verified by broker lookup; never resubmits an ambiguous intent.

- [ ] Write RED tests proving reconciliation has no SQLite import, resolves verified ambiguous results, retains unresolved ambiguity, and rejects broker identity/term drift.
- [ ] Implement reconciliation directly over `PostgresExecutionStateRepository` and Alpaca read-only order lookups.
- [ ] Persist learning/recovery results from PostgreSQL candidate/order lifecycle evidence and verify GREEN.

### Task 6: Production isolation and full local validation

**Files:**
- Modify: `tests/postgresOnlyAuthority.test.ts`
- Modify: `scripts/autonomous-worker-command-contract.json`
- Modify: `README.md`
- Modify: `RESUME_CONTEXT.md`
- Modify: `server/README.md`
- Modify: `server/RESUME_CONTEXT.md`

**Interfaces:**
- Produces: recursive production import-isolation proof for the worker, research, review, reconciliation, execution, and market-data entries.

- [ ] Expand the import-isolation entries and run them RED before removing the final prohibited path.
- [ ] Remove all enabled SQLite imports/fallbacks and make the isolation test GREEN.
- [ ] Run focused PostgreSQL market-data, worker, authority, live-isolation, execution-gate, reconciliation, and relevant regression tests.
- [ ] Run `npm run typecheck`, `npm run build`, `npm run dashboard:build`, and `git diff --check`.
- [ ] Synchronize runtime documentation only after behavior is verified.

### Task 7: Exact-SHA deployment and natural cycle

**Files:**
- Modify only if required: `server/systemd/alpaca-autonomous-paper.service`

**Interfaces:**
- Produces: one committed and pushed SHA running on `/home/alpaca/Alpaca-Trading`.

- [ ] Review the complete diff, stage only scoped files, commit, and push the validated branch.
- [ ] Stop worker/timers, preserve dashboard availability where schema safety permits, deploy the exact SHA, run direct PostgreSQL migration 003, and verify schema/connectivity.
- [ ] Run fresh paper account/position/open-order synchronization with zero submitted orders and verify current market evidence persistence.
- [ ] Install the exact worker unit, daemon-reload, enable/start it, and observe one naturally initiated complete cycle in systemd and PostgreSQL.
- [ ] Verify dashboard-control healthy, legacy timers disabled, no overlap, paper/live flags exact, autonomous paper order count reported, and live order count zero.
