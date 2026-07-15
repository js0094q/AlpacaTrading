# Research Steady-State SQLite Concurrency Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make guarded paper research complete under the unchanged staggered timer schedule by batching the evidenced heavy writers, coordinating only those writers, and retrying only safe SQLite busy failures.

**Architecture:** Add one additive migration for a short-lived named `sqlite_write_leases` row. A synchronous retry/telemetry helper wraps only explicitly idempotent lifecycle and rollback-safe batch writes. Research options normalize outside the lease and commit in bounded chunks; the 0DTE engine wraps its existing deterministic persistence batch in the same lease. Runtime startup remains read-only for current databases and SQLite remains in DELETE rollback-journal mode.

**Tech Stack:** Node.js `node:sqlite` `DatabaseSync`, TypeScript/NodeNext, `tsx --test`, SQLite DELETE journal, systemd timers, GitHub PR, VPS SSH deployment, Vercel production deployment.

## Global Constraints

- Keep the explicit `db:migrate` runtime schema boundary unchanged.
- Keep SQLite `journal_mode=delete` unless a production-copy experiment proves a change necessary; no WAL change in this repair.
- Keep all 14 normal timers enabled.
- Do not run paper review, paper execution, exit execution, or any order-producing command during implementation or validation.
- Do not weaken any reservation, review, freshness, cap, confirmation, or paper/live safety control.
- Retry only operations proven idempotent; never retry broker calls, orders, reservations, or non-idempotent audit inserts blindly.
- Preserve the unrelated `docs/superpowers/plans/2026-07-10-guarded-paper-hedge-execution.md` `+56/-6` edit in the original checkout; do not copy it into this branch.
- Do not claim the historical lock-holder PID is known; call the 0DTE engine batch the closest proven competing write scope.

---

### Task 1: Commit the approved repair specification and establish a clean baseline

**Files:**
- Create: `docs/specs/2026-07-15-research-steady-state-sqlite-concurrency.md`
- Create: `docs/superpowers/plans/2026-07-15-research-steady-state-sqlite-concurrency.md`
- Test: `tests/databaseRuntimeMigrations.test.ts` (baseline only)

**Interfaces:**
- Consumes: deployed `origin/main` at `910a1c60f14bc0e2292a5abefc3e1e897dd987ee`.
- Produces: reviewed task contract and a clean branch baseline for the RED test.

- [x] **Step 1: Write the verified spec and implementation plan.**

  Record the exact heartbeat SQL, the options-ingestion/0DTE overlap evidence,
  the telemetry limitation, lease scope, retry boundary, safety boundaries,
  acceptance criteria, and deployment checks.

- [ ] **Step 2: Run the baseline checks before editing behavior.**

  Run:

  ```bash
  git status --short
  git rev-parse HEAD
  npm run typecheck
  ```

  Expected: clean worktree, `910a1c6...`, and a passing baseline typecheck.

- [ ] **Step 3: Commit only the approved spec and plan.**

  ```bash
  git add docs/specs/2026-07-15-research-steady-state-sqlite-concurrency.md docs/superpowers/plans/2026-07-15-research-steady-state-sqlite-concurrency.md
  git commit -m "docs: specify steady-state sqlite concurrency repair"
  ```

### Task 2: Add RED multi-process contention and retry tests

**Files:**
- Create: `tests/sqliteConcurrency.test.ts`
- Create: `tests/helpers/sqliteConcurrencyWorker.ts`
- Modify: `tests/researchRunLifecycleService.test.ts`
- Test: `tests/sqliteConcurrency.test.ts`

**Interfaces:**
- Consumes: current `heartbeatResearchRun`, `finishResearchRun`, and current
  `initializeDatabaseHandle` behavior.
- Produces: deterministic two-process DELETE-journal tests that fail before the
  repair and become green after Tasks 3–5.

- [ ] **Step 1: Write the failing heartbeat race.**

  Create a temporary on-disk database using the production migration helper,
  insert one `research_runs` row, spawn a worker that opens a second
  `DatabaseSync` connection, executes `BEGIN IMMEDIATE`, writes one harmless
  `api_request_log` row, prints a ready marker, waits 100 ms, and commits.
  Set the test connection busy timeout to 25 ms. Call
  `heartbeatResearchRun` while the scheduled-writer worker holds the lock and
  assert the current implementation raises `database is locked`.

- [ ] **Step 2: Add the terminal-state and duplicate assertions.**

  After the repaired heartbeat succeeds, call `finishResearchRun` and assert
  the row is `completed`. Repeat the idempotent persistence fixture and assert
  one research run, one candidate, one plan, one reservation, and zero order
  rows. Add a lost-lease case that proves the supplied persistence callback is
  not called after the research row changes to `failed`.

- [ ] **Step 3: Add retry contract tests.**

  Use an injected sleep and telemetry collector to prove a busy operation stops
  after its configured attempt bound, a successful retry reports its retry
  count, a non-idempotent operation is attempted once, and non-busy errors are
  propagated without retry.

- [ ] **Step 4: Add connection PRAGMA assertions.**

  Assert `PRAGMA busy_timeout` and `PRAGMA foreign_keys` on the normal runtime
  handle, a second writer handle, and the read-only verification handle. Keep
  the test database in DELETE journal mode; do not use the existing in-memory
  test helper for this concurrency test.

- [ ] **Step 5: Run the focused RED tests.**

  ```bash
  npx tsx --test tests/sqliteConcurrency.test.ts
  ```

  Expected before production changes: the heartbeat race test fails because
  the current heartbeat has no bounded retry; the non-contention tests may pass.

### Task 3: Implement bounded SQLite busy classification, retry, and telemetry

**Files:**
- Create: `src/lib/sqliteConcurrency.ts`
- Modify: `src/services/researchRunLifecycleService.ts`
- Modify: `src/services/optionsService.ts`
- Modify: `src/services/zeroDte/zeroDtePersistenceService.ts`
- Test: `tests/sqliteConcurrency.test.ts`

**Interfaces:**
- Consumes: `DatabaseSync` operations and the RED tests.
- Produces:

  ```ts
  export interface SqliteContentionContext {
    operation: string;
    transaction?: string;
    runId?: string | null;
    correlationId?: string | null;
  }

  export interface SqliteBusyRetryOptions extends SqliteContentionContext {
    idempotent: boolean;
    maxAttempts?: number;
    retryDelayMs?: number;
    sleep?: (delayMs: number) => void;
    emit?: (event: Record<string, unknown>) => void;
  }

  export const isSqliteBusyError: (error: unknown) => boolean;
  export const runWithSqliteBusyRetry: <T>(
    operation: () => T,
    options: SqliteBusyRetryOptions
  ) => T;
  ```

- [ ] **Step 1: Implement busy classification and bounded synchronous retry.**

  Recognize SQLite primary/extended `SQLITE_BUSY` codes and the deployed
  `database is locked` representation, reject explicit `SQLITE_LOCKED`, cap
  attempts and delay, and use `Atomics.wait` only for the short injected delay.
  Rollback must be completed by transaction callers before the helper retries.

- [ ] **Step 2: Emit bounded structured contention events.**

  Emit JSON with `event`, `operation`, `transaction`, `outcome`,
  `transactionDurationMs`, `retryCount`, `processIdentity`, `runId`,
  `correlationId`, and a redacted SQLite error code/message. Emit no SQL values,
  credentials, request bodies, or secrets.

- [ ] **Step 3: Wrap only idempotent research lifecycle writes.**

  Apply the helper to heartbeat, universe progress, and terminal research-row
  updates. Leave reservation/recovery transactions and final candidate/plan
  persistence non-retried unless their entire operation is proven idempotent.

- [ ] **Step 4: Wrap rollback-safe batch transactions.**

  Add an explicit `idempotent` transaction option to the 0DTE persistence
  transaction and option batch transaction. Ensure every retry rolls back the
  failed attempt first. Keep existing standalone 0DTE callers non-retried by
  default.

- [ ] **Step 5: Run the focused tests.**

  ```bash
  npx tsx --test tests/sqliteConcurrency.test.ts tests/researchRunLifecycleService.test.ts
  ```

  Expected: retry-bound, non-idempotent, terminal, and heartbeat tests pass;
  lease-specific tests remain pending until Task 4.

### Task 4: Add the narrow heavy-persistence lease migration and service

**Files:**
- Create: `src/lib/sqliteConcurrencySchema.ts`
- Create: `src/services/sqliteWriteLeaseService.ts`
- Modify: `src/lib/db.ts`
- Modify: `tests/databaseRuntimeMigrations.test.ts`
- Modify: `tests/sqliteConcurrency.test.ts`
- Create: `docs/decisions/ADR-009-steady-state-sqlite-concurrency.md`

**Interfaces:**
- Consumes: `runMigrationGroup`, `runWithSqliteBusyRetry`, and current
  connection initialization.
- Produces:

  ```ts
  export const SQLITE_CONCURRENCY_MIGRATION_VERSION =
    "2026-07-15-steady-state-sqlite-concurrency";
  export const HEAVY_PERSISTENCE_LEASE =
    "research-options-and-zero-dte-engine";
  export const withHeavyPersistenceLease: <T>(
    input: {
      operation: string;
      runId?: string | null;
      correlationId?: string | null;
      maxWaitMs?: number;
    },
    operation: (lease: {
      assertOwnership: () => void;
      renew: () => void;
    }) => T
  ) => T;
  ```

- [ ] **Step 1: Write the additive schema migration.**

  Add only `sqlite_write_leases(lease_name PRIMARY KEY, owner_id,
  acquired_at, expires_at)`. Register its migration version in the required
  runtime list, but run it only through `initializeDatabaseHandle`'s existing
  explicit migration path. Do not alter `RUNTIME_SCHEMA_MIGRATION_VERSION` or
  the runtime read-only branch.

- [ ] **Step 2: Write lease acquisition, renewal, ownership, and release.**

  Acquire with a short compare-and-set `BEGIN IMMEDIATE` transaction, reclaim
  only expired rows, poll for a bounded maximum wait, renew after each batch,
  assert ownership before each batch, and release only the matching owner token.
  Use a finite expiry so a crashed process cannot hold the lease forever.

- [ ] **Step 3: Add migration and lease-loss tests.**

  Assert current runtime startup does not write the new migration, explicit
  migration creates it exactly once, a second migration is a no-op, a held lease
  makes another participant wait then proceed after release, expiry is
  reclaimable, and ownership loss prevents the next durable write.

- [ ] **Step 4: Record ADR-009.**

  Document the evidence, the exact two participating persistence scopes, why a
  global lock/WAL/timer change was rejected, lease expiry/recovery, retry
  boundaries, consequences, and production-copy validation.

- [ ] **Step 5: Run migration and lease tests.**

  ```bash
  npx tsx --test tests/databaseRuntimeMigrations.test.ts tests/sqliteConcurrency.test.ts
  ```

### Task 5: Batch research option persistence and integrate the lease

**Files:**
- Modify: `src/services/optionsService.ts`
- Modify: `src/services/researchOrchestrator.ts`
- Modify: `tests/research.test.ts`
- Modify: `tests/sqliteConcurrency.test.ts`

**Interfaces:**
- Consumes: `withHeavyPersistenceLease`, `runWithSqliteBusyRetry`, and current
  option normalizers/providers.
- Produces: bounded, replay-safe option contract/snapshot persistence with no
  network or row normalization inside a write transaction.

- [ ] **Step 1: Add RED batch/replay tests.**

  Seed deterministic contract/snapshot rows, force a first batch transaction to
  raise a busy error, replay the same input, and assert counts are unchanged
  except for the intended new rows. Assert no duplicate option symbols or
  timestamps and that the ingestion run reaches a terminal status.

- [ ] **Step 2: Normalize all fetched rows before acquiring the lease.**

  Preserve the existing provider calls and filters, but materialize normalized
  contract/snapshot row objects before any `BEGIN IMMEDIATE` transaction.

- [ ] **Step 3: Persist bounded chunks under the lease.**

  Use a fixed bounded batch size of 250 rows, `BEGIN IMMEDIATE` per chunk,
  existing `ON CONFLICT` semantics, explicit transaction telemetry, retry only
  after rollback, lease ownership assertion before each chunk, and lease renewal
  after each successful chunk.

- [ ] **Step 4: Keep ingestion status writes idempotent and short.**

  Leave the initial run-row insert non-retried. Apply the bounded idempotent
  helper to `finishRun`, preserving the existing failure path and warning
  behavior when an option batch cannot complete.

- [ ] **Step 5: Run focused option/research tests.**

  ```bash
  npx tsx --test tests/research.test.ts tests/optionSnapshotNormalizer.test.ts tests/sqliteConcurrency.test.ts
  ```

### Task 6: Integrate the lease and retry only around the 0DTE engine batch

**Files:**
- Modify: `src/services/zeroDte/zeroDtePersistenceService.ts`
- Modify: `src/services/zeroDte/zeroDteEngineService.ts`
- Modify: `tests/zeroDtePersistence.test.ts`
- Modify: `tests/zeroDteEngine.test.ts`
- Modify: `tests/sqliteConcurrency.test.ts`

**Interfaces:**
- Consumes: deterministic 0DTE IDs, `withHeavyPersistenceLease`, and the
  rollback-safe retry helper.
- Produces: the existing engine persistence batch coordinated only against
  research option persistence; broker execution code remains untouched.

- [ ] **Step 1: Add RED engine-scope lease tests.**

  Spawn two processes against a DELETE-journal test database. Hold the heavy
  lease in one representative persistence scope and assert the other waits,
  then completes once released. Assert one candidate/observation/evaluation/
  decision/lifecycle row per deterministic identity.

- [ ] **Step 2: Add explicit transaction context options.**

  Keep `runInZeroDtePersistenceTransaction(operation)` behavior unchanged for
  existing callers. Add opt-in context for `operation`, `runId`,
  `correlationId`, `idempotent`, and `useHeavyPersistenceLease`.

- [ ] **Step 3: Wrap only `runZeroDteEngine`'s existing persistence closure.**

  Pass the engine run ID and `useHeavyPersistenceLease: true` from the engine.
  Do not wrap broker calls, order reservations, shadow writes, exit review, or
  reconciliation in the heavy lease.

- [ ] **Step 4: Run focused 0DTE tests.**

  ```bash
  npm run test:zero-dte
  ```

  Expected: all existing 0DTE safety and identity tests remain green, with no
  order-producing command invoked.

### Task 7: Synchronize architecture, README, operations, and resume docs

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `README.md`
- Modify: `docs/paper-monitoring-operations.md`
- Modify: `RESUME_CONTEXT.md`
- Modify: `docs/vps-paper-research-deployment.md`
- Test: documentation line/command checks and `git diff --check`

**Interfaces:**
- Consumes: final code contracts and deployment procedure.
- Produces: implementation-accurate documentation that preserves the
  migration boundary, timer schedule, paper-only gates, and no-order rule.

- [ ] **Step 1: Document the lease and telemetry boundary.**

  State the two participating heavy scopes, finite lease expiry, bounded retry,
  structured journal telemetry, and the fact that the historical PID is unknown.

- [ ] **Step 2: Document deployment-copy validation.**

  Add exact commands for copied-database migration twice, integrity,
  foreign-key, journal-mode, busy-timeout, timer-health, exact-SHA alignment,
  and guarded research validation. Explicitly omit paper review/execution from
  implementation validation until successful research.

- [ ] **Step 3: Run documentation checks.**

  ```bash
  git diff --check
  rg -n "sqlite_write_leases|SQLITE_BUSY|journal_mode|paper execution" docs README.md RESUME_CONTEXT.md
  ```

### Task 8: Run complete local verification and review the diff

**Files:**
- Test: all repository test files selected by package scripts

**Interfaces:**
- Consumes: Tasks 2–7.
- Produces: green local evidence ready for review and publication.

- [ ] **Step 1: Run focused validation.**

  ```bash
  npx tsx --test tests/sqliteConcurrency.test.ts tests/databaseRuntimeMigrations.test.ts tests/researchRunLifecycleService.test.ts tests/research.test.ts
  npm run test:zero-dte
  ```

- [ ] **Step 2: Run full validation.**

  ```bash
  npm test
  npm run lint
  npm run typecheck
  npm run build
  git diff --check
  ```

- [ ] **Step 3: Inspect the diff and safety surface.**

  ```bash
  git diff --stat
  git diff -- src/services src/lib tests docs
  rg -n "paper:execute|paper:exit:execute|submitOrder|createOrder" src tests
  ```

  Confirm no order-producing command ran, no safety blocker changed, no timer
  unit was edited, and no secret-bearing file is staged.

- [ ] **Step 4: Commit implementation in reviewable commits.**

  Use focused messages for the helper/lease, option batching, 0DTE integration,
  and documentation. Stage only files belonging to this repair.

### Task 9: Create, review, merge, and deploy the exact SHA

**Files:**
- No additional source files; GitHub/VPS/Vercel state only.

**Interfaces:**
- Consumes: green local validation and focused commits.
- Produces: one reviewed PR, one merge SHA, exact VPS/Vercel SHA alignment.

- [ ] **Step 1: Push the branch and open one focused PR.**

  Use the GitHub skill and `gh`, include the exact evidence summary, safety
  boundaries, migration-copy plan, and test results. Do not open additional PRs.

- [ ] **Step 2: Obtain review and merge.**

  Resolve only actionable review comments. Record the merge commit SHA and
  confirm `origin/main` points to it.

- [ ] **Step 3: Validate a copied production database twice.**

  On the VPS, stop only the required writer services for the copy, run
  `db:migrate` twice against the copy, then `db:verify`. Confirm integrity,
  foreign keys, migration rows, unchanged DELETE journal mode, busy timeout,
  and legacy row counts. Do not change production timers.

- [ ] **Step 4: Migrate/deploy exact merge SHA.**

  Run the explicit production `db:migrate` once, verify, deploy/build the
  exact merge SHA to the VPS, and deploy the same commit to Vercel. Restart only
  affected services and confirm all 14 timers remain enabled and active.

- [ ] **Step 5: Run read-only safety and timer checks.**

  Confirm paper/live flags by name only, exact SHA alignment across GitHub/VPS/
  running service/Vercel, database integrity/foreign keys, journal mode, timer
  health, no overlapping research run, and zero order delta. Do not run paper
  execution or exit execution.

### Task 10: Validate guarded production research and record final state

**Files:**
- Modify: `RESUME_CONTEXT.md` (final deployed state only)
- Create: `/Users/josephstewart/.codex/memories/extensions/ad_hoc/notes/<timestamp>-research-steady-state-sqlite-concurrency.md`

**Interfaces:**
- Consumes: exact deployed merge SHA and active normal timer set.
- Produces: successful guarded research evidence, then paper review only after
  research success, plus Basic Memory continuity note.

- [ ] **Step 1: Trigger one guarded research refresh.**

  Use the existing guarded read/research route only. Require terminal
  `completed`, persisted targets, persisted candidates/plans, no duplicate
  active research run, and structured contention telemetry free of unbounded
  retries.

- [ ] **Step 2: Run paper review only after research succeeds.**

  Run the read/review artifact path permitted by the user after successful
  research. Do not run paper execution, exit execution, or any order-producing
  command.

- [ ] **Step 3: Update continuity state.**

  Record the exact failing SQL, closest proven competing scope, changed files,
  tests, PR/merge/VPS/Vercel SHAs, production result, integrity/foreign-key
  results, timer health, and zero-order confirmation in `RESUME_CONTEXT.md` and
  the requested Basic Memory ad-hoc note without secrets.

- [ ] **Step 4: Final verification before reporting.**

  Re-run `git status --short`, `git diff --check`, GitHub/VPS/Vercel SHA checks,
  timer listing, database verification, and paper/live order counts. Report
  every unvalidated area explicitly.
