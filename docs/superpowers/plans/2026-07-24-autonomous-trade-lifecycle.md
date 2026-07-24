# Autonomous Trade Lifecycle Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete the paper-only, PostgreSQL-authoritative autonomous entry, exit, cancellation, and recovery lifecycle while preserving the existing qualification, freshness, risk, fence, idempotency, and reconciliation controls.

**Architecture:** Extend the maintained PostgreSQL review, execution, reconciliation, cancellation, worker, and dashboard paths. Add one durable lifecycle domain module and append-only transition schema, then persist explicit trade operation, strategy classification, entry/exit lineage, authorization snapshot, autonomous cycle, and workstream execution identity on each order intent. Broker mutations remain exactly-once through pre-mutation persistence, client-order-ID recovery, bounded broker lookup, fenced PostgreSQL transactions, and authoritative terminal reconciliation.

**Tech Stack:** TypeScript, Node.js, PostgreSQL migrations and transactional SQL, Node test runner, systemd worker, Next.js dashboard.

---

## Task 1: Add durable lifecycle domain types and PostgreSQL schema

**Files:**

- Create: `src/services/autonomousTradeLifecycleService.ts`
- Create: `src/lib/database/migrations/006_autonomous_trade_lifecycle.sql`
- Modify: `src/lib/database/postgresSchema.ts`
- Modify: `tests/postgresMigrations.test.ts`
- Create: `tests/autonomousTradeLifecycleService.test.ts`

**Step 1: Write failing tests**

Add tests that require:

- the complete `AutonomousTradeLifecycleState`, `TradeOperation`, `StrategyClassification`, `WorkerExecutionContext`, `PersistedOrderIntent`, and dashboard lifecycle contracts;
- `validateCloseOperation` to reject a generic `buy` for a short position and require `buy_to_cover`;
- `classifyOptionStrategy` to classify observed same-day calls/puts as 0DTE, observed contracts at least 365 calendar days out as LEAPS, and other calls/puts as standard;
- migration 006 to add intent lineage/lifecycle fields, an append-only lifecycle transition table, and a unique reservation terminal-transition table;
- transition validation to reject invalid state changes.

**Step 2: Run the focused tests and verify RED**

Run:

```bash
./node_modules/.bin/tsx --import ./tests/helpers/enableSqliteFixtureInitialization.mjs --test tests/autonomousTradeLifecycleService.test.ts tests/postgresMigrations.test.ts
```

Expected: failures because the lifecycle module and migration do not exist.

**Step 3: Implement the minimum domain and schema**

Implement:

- the exact requested lifecycle state union and service interface;
- explicit domain operations and strategy classifications;
- stable option classification using the repository's UTC/date-only rules;
- close-operation invariants before broker-side mapping;
- a migration that backfills legacy intents conservatively, preserves existing rows, records explicit operation/classification/state fields, and adds durable cycle/workstream/snapshot/parent/opening lineage;
- append-only transition evidence keyed by an idempotency key;
- unique reservation terminal transitions so retry/restart cannot double-release.

The lifecycle module must not import SQLite and must not submit broker orders directly.

**Step 4: Run focused tests and verify GREEN**

Run the Task 1 test command again, then `npm run typecheck`.

**Step 5: Commit**

```bash
git add src/services/autonomousTradeLifecycleService.ts src/lib/database/migrations/006_autonomous_trade_lifecycle.sql src/lib/database/postgresSchema.ts tests/autonomousTradeLifecycleService.test.ts tests/postgresMigrations.test.ts
git commit -m "Add durable autonomous trade lifecycle model"
```

## Task 2: Persist lifecycle metadata and use shared exactly-once submission recovery

**Files:**

- Modify: `src/services/autonomousTradeLifecycleService.ts`
- Modify: `src/services/autonomousPostgresExecutionService.ts`
- Modify: `src/services/postgresReconciliationService.ts`
- Modify: `src/services/autonomousPostgresCommandService.ts`
- Modify: `src/postgresOnlyCli.ts`
- Modify: `tests/autonomousPostgresExecutionService.test.ts`
- Modify: `tests/postgresReconciliationService.test.ts`
- Modify: `tests/autonomousPostgresCommandService.test.ts`

**Step 1: Write failing tests**

Add tests proving:

- entry, exit, short-cover, and option-close ambiguity all use the same client-order-ID recovery function;
- submission attempts and client order IDs are persisted before mutation;
- an initial broker 404 remains pending and never causes resubmission;
- recovery uses eight bounded attempts with 500ms exponential backoff capped at 5 seconds;
- broker absence is terminal only after the durable terminal policy;
- restart recovery advances persisted entry and exit ambiguity without a second mutation;
- lifecycle transitions persist cycle and workstream execution identity under a live fence;
- fence loss aborts before persistence or broker mutation.

**Step 2: Run focused tests and verify RED**

Run:

```bash
./node_modules/.bin/tsx --import ./tests/helpers/enableSqliteFixtureInitialization.mjs --test tests/autonomousPostgresExecutionService.test.ts tests/postgresReconciliationService.test.ts tests/autonomousPostgresCommandService.test.ts
```

**Step 3: Implement the shared submission/recovery path**

Extend the existing execution and reconciliation services rather than creating a second adapter:

- derive the domain operation before mapping to Alpaca `buy`/`sell` and valid option `position_intent`;
- persist `submission_attempt_persisted` or `exit_submission_attempt_persisted` with the immutable client ID before mutation;
- classify only genuinely ambiguous mutation errors as ambiguous; deterministic broker rejections remain terminal failures;
- recover every order mutation by exact client order ID with the required bounded policy and fence checks;
- persist discovered broker order/event evidence and advance the lifecycle atomically;
- process persisted recoverable states in `system:recover` without generating new candidates;
- report `NO_RECOVERABLE_POSTGRES_STATE` only when the recovery set is empty.

**Step 4: Run focused tests and verify GREEN**

Run the Task 2 tests, `npm run typecheck`, and `git diff --check`.

**Step 5: Commit**

```bash
git add src/services/autonomousTradeLifecycleService.ts src/services/autonomousPostgresExecutionService.ts src/services/postgresReconciliationService.ts src/services/autonomousPostgresCommandService.ts src/postgresOnlyCli.ts tests/autonomousPostgresExecutionService.test.ts tests/postgresReconciliationService.test.ts tests/autonomousPostgresCommandService.test.ts
git commit -m "Unify autonomous submission recovery"
```

## Task 3: Complete autonomous exit lineage, short cover, and option classification

**Files:**

- Modify: `src/services/postgresReviewWorkflowService.ts`
- Modify: `src/services/autonomousPostgresExecutionService.ts`
- Modify: `src/services/postgresReconciliationService.ts`
- Modify: `src/services/paperExitReviewService.ts`
- Modify: `src/services/paperExitExecutionService.ts`
- Modify: `tests/postgresReviewWorkflowService.test.ts`
- Modify: `tests/autonomousPostgresExecutionService.test.ts`
- Modify: `tests/postgresReconciliationService.test.ts`
- Modify: `tests/paperExitService.test.ts`

**Step 1: Write failing tests**

Add tests proving:

- long equity exits persist `sell_to_close`; short equities persist `buy_to_cover`;
- broker mapping occurs only after close-operation validation;
- a genuine exit trigger autonomously creates the exit review, confirmation, closing intent, and exact entry lineage;
- a no-trigger result is successful empty work and creates no closing intent;
- long call/put closes retain the exact broker contract and cannot exceed reconciled open quantity;
- option entry/exit requires observed active/tradable Alpaca OPRA evidence, non-crossed bid/ask, existing spread threshold, SIP underlying freshness, and the 15-minute quote gate;
- 0DTE and 365-day LEAPS classification use observed expiration and persist opening classification so later exits do not reclassify from current DTE;
- closed/closing positions cannot create a duplicate close.

**Step 2: Run focused tests and verify RED**

Run:

```bash
./node_modules/.bin/tsx --import ./tests/helpers/enableSqliteFixtureInitialization.mjs --test tests/postgresReviewWorkflowService.test.ts tests/autonomousPostgresExecutionService.test.ts tests/postgresReconciliationService.test.ts tests/paperExitService.test.ts
```

**Step 3: Implement maintained-path exit behavior**

Update the PostgreSQL exit review path to:

- carry current position, originating candidate, opening review/intent/order, immutable authorization snapshot, trigger, exit review, and closing confirmation;
- use explicit domain operations and strategy classifications;
- create confirmations and ready exit intents under the same fenced PostgreSQL transaction when the exit policy approves;
- retain the exact observed option contract and executable evidence;
- translate `buy_to_cover` to Alpaca side `buy` only after validating the reconciled short position;
- remove incorrect generic short-close behavior from legacy maintained adapters without adding a new production dependency.

**Step 4: Run focused tests and verify GREEN**

Run the Task 3 tests, `npm run typecheck`, and `git diff --check`.

**Step 5: Commit**

```bash
git add src/services/postgresReviewWorkflowService.ts src/services/autonomousPostgresExecutionService.ts src/services/postgresReconciliationService.ts src/services/paperExitReviewService.ts src/services/paperExitExecutionService.ts tests/postgresReviewWorkflowService.test.ts tests/autonomousPostgresExecutionService.test.ts tests/postgresReconciliationService.test.ts tests/paperExitService.test.ts
git commit -m "Complete autonomous exit and cover lifecycle"
```

## Task 4: Add bounded autonomous cancellation recovery and atomic reservation settlement

**Files:**

- Modify: `src/services/postgresOrderCancellationService.ts`
- Modify: `src/services/postgresReconciliationService.ts`
- Modify: `src/services/autonomousPostgresCommandService.ts`
- Modify: `tests/postgresOrderCancellationService.test.ts`
- Modify: `tests/postgresReconciliationService.test.ts`
- Modify: `tests/autonomousPostgresCommandService.test.ts`

**Step 1: Write failing tests**

First repair the two pre-existing cancellation fixtures so they explicitly enable paper order execution. Then add tests proving:

- stale, expired, invalidated, materially obsolete, recovery-cancellable, and cancel-before-replace orders enter the production cancellation path;
- filled/terminal orders are reconciled without DELETE;
- cancel request evidence is persisted before a single DELETE;
- ambiguous cancellation polls authoritative broker state with the bounded recovery policy;
- the reservation is not released on request or partial fill;
- terminal cancellation/rejection/expiration releases reservation and adjusts allocation atomically exactly once;
- partial fill resizes the remaining reservation;
- restart resumes pending cancellation without duplicate DELETE or double release.

**Step 2: Run focused tests and verify RED**

Run:

```bash
./node_modules/.bin/tsx --import ./tests/helpers/enableSqliteFixtureInitialization.mjs --test tests/postgresOrderCancellationService.test.ts tests/postgresReconciliationService.test.ts tests/autonomousPostgresCommandService.test.ts
```

**Step 3: Implement cancellation and reservation recovery**

Implement:

- durable `cancel_requested`/`cancel_ambiguous` transitions and request events;
- one cancellation mutation followed by bounded broker status recovery;
- authoritative terminal reconciliation before reservation release;
- unique reservation terminal transition insertion in the same transaction as reservation/allocation changes;
- remaining-quantity reservation adjustment for partial fills;
- idempotent recovery across process restart.

Keep all safety gates and option execution gates fail-closed.

**Step 4: Run focused tests and verify GREEN**

Run the Task 4 tests, `npm run typecheck`, and `git diff --check`.

**Step 5: Commit**

```bash
git add src/services/postgresOrderCancellationService.ts src/services/postgresReconciliationService.ts src/services/autonomousPostgresCommandService.ts tests/postgresOrderCancellationService.test.ts tests/postgresReconciliationService.test.ts tests/autonomousPostgresCommandService.test.ts
git commit -m "Make autonomous cancellation restart safe"
```

## Task 5: Integrate dependency-ordered worker recovery and dashboard lifecycle projection

**Files:**

- Modify: `scripts/autonomous-paper-worker.mjs`
- Modify: `src/services/autonomousWorkerStateService.ts`
- Modify: `src/services/postgresDashboardReadService.ts`
- Modify: `apps/dashboard/app/page.tsx`
- Modify: `tests/autonomousPaperWorker.test.ts`
- Modify: `tests/postgresDashboardEvidence.test.tsx`

**Step 1: Write failing tests**

Add tests proving:

- the public worker remains exactly 20 workstreams while adapting its internal order to reconcile before decisions, execute entries before exits, cancel after exit reconciliation, refresh dashboard-facing state, and recover last;
- unresolved earlier mutations prevent dependent later mutation work;
- worker restart resumes persisted pending work;
- successful empty reason codes remain successful while authority/fence/broker/database/malformed failures remain blocked;
- dashboard lifecycle rows expose lineage, operation, classification, broker IDs/status, reservation/release reason, reconciliation timestamps, cycle/workstream identity, exit trigger/reason, and whitelisted premium evidence;
- timestamps are ISO strings or `null`, missing Greeks are `null`, and secrets/raw headers are absent.

**Step 2: Run focused tests and verify RED**

Run:

```bash
./node_modules/.bin/tsx --import ./tests/helpers/enableSqliteFixtureInitialization.mjs --test tests/autonomousPaperWorker.test.ts tests/postgresDashboardEvidence.test.tsx
```

**Step 3: Implement orchestration and projection**

Adapt the existing 20 workstreams without increasing the public count:

- keep durable lease/fence/idempotency behavior;
- ensure reconciliation precedes new mutation work and each mutation is followed by reconciliation;
- make recovery the terminal workstream and include `NO_RECOVERABLE_POSTGRES_STATE` as successful empty work;
- extend the maintained PostgreSQL dashboard query and component with lifecycle projection and current/last cycle evidence;
- preserve all date normalization and redaction boundaries.

**Step 4: Run focused tests and verify GREEN**

Run the Task 5 tests, `npm run typecheck`, `npm run dashboard:build`, and `git diff --check`.

**Step 5: Commit**

```bash
git add scripts/autonomous-paper-worker.mjs src/services/autonomousWorkerStateService.ts src/services/postgresDashboardReadService.ts apps/dashboard/app/page.tsx tests/autonomousPaperWorker.test.ts tests/postgresDashboardEvidence.test.tsx
git commit -m "Project autonomous lifecycle through worker and dashboard"
```

## Task 6: Full verification, release, deployment, and runtime evidence

**Files:**

- Modify only files required by defects exposed during verification.

**Step 1: Run all focused lifecycle tests**

Run the union of Tasks 1-5 focused tests in an isolated scratch directory with all required paper-only test flags.

**Step 2: Run the complete isolated suite**

Create a fresh scratch directory and run `npm test` with the repository's fixture initializer and scratch environment. Preserve the exact pass/fail/skip counts.

**Step 3: Run static and build gates**

Run:

```bash
npm run typecheck
npm run build
npm run dashboard:build
git diff --check
git status --short --branch
```

Search for conflict markers and classify every SQLite-related production match. Any runtime SQLite import is a release blocker.

**Step 4: Independent final review**

Review the complete range from `62f4db0255d47b6ec54124345ba3eda8814757ed` to feature HEAD for correctness, safety, authority preservation, test gaps, and unintended scope. Fix all Critical, Important, and material Minor findings and rerun affected gates.

**Step 5: Merge and push the intended branch**

Verify the original main checkout still contains only the user-owned `config.toml`, merge the verified feature branch into `main`, and push `main`. Record exact local and `origin/main` SHAs.

**Step 6: Deploy exact SHA**

Perform the directive's clean-VPS, service-stop, lease-drain, exact-SHA, migration, dependency, typecheck, root build, dashboard build, environment, endpoint, PostgreSQL-only, process, SQLite-FD, and no-harness gates. Restart dashboard first and worker second. Do not alter the permanent remote.

**Step 7: Collect runtime proof**

Leave systemd to generate genuine work without manual records or threshold changes. Capture latest and current cycles, broker/PG/dashboard reconciliation, natural entry/exit/cancellation evidence, reservation state, final exposure, PIDs, restart counts, deployed/Vercel SHAs, and honest capability classifications. Leave the worker active.
