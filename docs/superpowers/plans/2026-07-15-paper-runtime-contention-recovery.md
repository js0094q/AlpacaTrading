# Paper Runtime Contention and Recovery Implementation Plan

> Execute with test-driven development. Run every focused test once red before
> writing its production change, then green before moving to the next task.

**Goal:** Remove steady-state migration writes, preserve causal command errors,
share the health deadline, recover stale research, and enforce database-backed
research single-flight without changing paper/live execution gates.

**Architecture:** Add a reusable SQLite migration-group runner and split explicit
migration from read-only runtime verification. Normalize child-process outcomes
in a testable module. Propagate one monotonic deadline through the account and
clock services into the Alpaca client. Centralize research reservation,
heartbeats, terminalization, and recovery metadata around `research_runs`.

**Stack:** TypeScript, Node `node:sqlite`, Node test runner, systemd, Vercel,
GitHub Actions, existing VPS deploy/runbook tooling.

---

## Task 1: Migration runner and runtime boundary

**Files:**
- Create: `src/lib/sqliteMigrations.ts`
- Modify: `src/lib/db.ts`
- Modify: `src/lib/zeroDteSchema.ts`
- Modify: `src/services/databaseMaintenanceService.ts`
- Create: `tests/databaseRuntimeMigrations.test.ts`
- Modify: `tests/marketDecisionTraceability.test.ts`
- Modify: `tests/zeroDtePersistence.test.ts`

1. Add failing tests proving current runtime startup succeeds under
   `query_only`, current migrations do not change their timestamps, a held
   writer does not block read-only startup, concurrent starters apply once,
   the losing starter rechecks, and failed migration work rolls back.
2. Run the focused migration tests and confirm the expected failures.
3. Implement migration-table reads, pending-group detection, bounded
   `BEGIN IMMEDIATE` application with under-lock recheck, commit/rollback, and
   applied-version insertion.
4. Add the new runtime schema version and additive research/recovery columns.
5. Make `getDb()` verify-only for existing databases and preserve transactional
   empty-database initialization. Keep `db:migrate` as the explicit mutator.
6. Extend `db:verify` with all required versions, foreign-key results, and
   current PRAGMA reporting.
7. Run focused tests green, then run existing Phase 1B and 0DTE persistence tests.

## Task 2: Causal child-process errors

**Files:**
- Create: `server/dashboard-control/commandResult.ts`
- Modify: `server/dashboard-control/server.ts`
- Create: `tests/dashboardCommandResult.test.ts`
- Modify: `tests/dashboardControlServer.test.ts`

1. Add failing tests for structured SQLite stdout plus ExperimentalWarning
   stderr, stderr-only failure, malformed stdout, timeout, signal, redaction,
   and output bounds.
2. Run the focused tests red.
3. Implement a redacted, bounded command result/failure type and error class.
4. Parse structured stdout before selecting stderr fallback; keep warnings,
   exit code, signal, timeout state, and diagnostic excerpt.
5. Include safe command diagnostics in the control error envelope and audit
   while preserving existing environment-guard behavior.
6. Run focused command and control tests green.

## Task 3: Shared Alpaca health deadline

**Files:**
- Create: `src/services/operationDeadline.ts`
- Modify: `src/services/alpacaClient.ts`
- Modify: `src/services/alpacaAccountService.ts`
- Modify: `src/services/alpacaMarketClockService.ts`
- Modify: `src/cli.ts`
- Modify: `server/dashboard-control/server.ts`
- Create: `tests/alpacaDeadline.test.ts`
- Modify: `tests/alpacaReadOnlyIntegration.test.ts`
- Modify: `tests/dashboardControlServer.test.ts`

1. Add deterministic failing tests for two sequential calls sharing one budget,
   remaining-derived request timeouts, bounded retry delay, outer abort,
   no pending fetch after timeout, and structured deadline metadata.
2. Run deadline tests red.
3. Implement monotonic operation deadlines, completion margin, signal
   composition, remaining-budget attempt sizing, and bounded retry waits.
4. Let account/clock services accept optional request context and have the CLI
   create one shared health deadline from its bounded environment contract.
5. Pass a 9-second health budget from every 10-second control health/preflight
   child invocation.
6. Run focused deadline, read-only integration, and control tests green.

## Task 4: Research recovery and single-flight

**Files:**
- Create: `src/services/researchRunLifecycleService.ts`
- Modify: `src/services/researchOrchestrator.ts`
- Modify: `src/services/autonomousRecoveryService.ts`
- Modify: `src/cli.ts`
- Modify: `server/dashboard-control/server.ts`
- Create: `tests/researchRunLifecycleService.test.ts`
- Modify: `tests/research.test.ts`
- Modify: `tests/autonomousRecoveryService.test.ts`

1. Add failing tests for stale/fresh recovery, source evidence, idempotency,
   compare-and-set recovery, active-run refusal, and replacement after stale
   recovery.
2. Run lifecycle tests red.
3. Implement the additive lifecycle schema, 15-minute policy, reservation
   transaction, heartbeat updates, terminal completion, and stale terminalization.
4. Add research rows/counts/events to autonomous recovery and status output.
5. Reserve before research network work, heartbeat between major stages, return
   structured `already_running`, and pass the control request ID to the child.
6. Run lifecycle, recovery, research, and paper/live safety tests green.

## Task 5: Documentation and timer review

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `README.md`
- Modify: `RESUME_CONTEXT.md`
- Modify: `server/README.md`
- Modify: `server/RESUME_CONTEXT.md`
- Modify: `server/systemd/README.md`
- Modify: `docs/vps-paper-research-deployment.md`

1. Document explicit migration-before-restart, runtime fail-closed behavior,
   error/deadline contracts, research recovery/single-flight, timer overlap
   table, validation, and compatible rollback.
2. Preserve schedules unless post-fix tests reproduce unsafe contention.
3. Run documentation command/line verification.

## Task 6: Local validation and review

1. Run focused tests for migrations, command results, deadlines, research,
   recovery, control server, 0DTE, and safety.
2. Migrate a copied fixture twice; run `db:verify`, `PRAGMA integrity_check`,
   `PRAGMA foreign_key_check`, and legacy row-count comparisons.
3. Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
4. Run `git diff --check`, inspect the complete diff, and perform an independent
   severity-ordered review without delegating to a subagent.
5. Fix substantive findings and rerun affected validation.

## Task 7: PR, merge, deploy, and production validation

1. Commit only scoped files, push `fix/paper-runtime-contention`, and open one PR
   with symptoms, before/after contracts, tests, deployment, and rollback.
2. Wait for required checks, inspect review feedback, resolve substantive
   findings, and merge.
3. Record the merge SHA. Confirm GitHub main resolves to it.
4. Before deployment, inspect VPS SHA/cleanliness, runtime safety flags by name
   only, timer/service state, database counts/integrity, and make a backup.
5. Stop affected SQLite writers, validate the migration twice on a copy,
   migrate production exactly once, deploy the exact merge SHA, install/build,
   and restart only required services. Restore prior timer state.
6. Deploy the same SHA to Vercel production and verify alias/deployment metadata.
7. Run `system:recover` to terminalize the known stale research row; verify its
   immutable event and retained evidence.
8. Run one guarded dashboard research request and a duplicate-click check.
9. Run read-only 0DTE discovery and controlled automated command-error proof.
10. Verify database PRAGMAs/integrity/foreign keys, systemd failures/timers,
    process cleanup, component SHA alignment, and unchanged order baseline.
11. Report completion only after every runtime criterion passes and explicitly
    confirm no paper or live orders were submitted.
