# Autonomous Universe Lifecycle Service Implementation Plan

> For Codex: REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a bounded, paper-only daily universe lifecycle worker that turns
authoritative Alpaca asset discovery into observable, research-eligible,
paper-eligible, active, suspended, and retired symbols without bypassing any
existing order gate.

**Architecture:** Keep universe_symbols as the compatibility membership
projection, add append-only lifecycle runs and events, and make the lifecycle
service the only new owner of automatic state transitions. The existing
observatory reads observable symbols. Existing research and all downstream
systems retain getActiveSymbols as their input.

**Tech Stack:** TypeScript, Node SQLite, existing Alpaca read-only clients,
systemd oneshot/timer units, node:test.

---

### Task 1: Specify lifecycle behavior and lock the release boundary

**Files:**
- Create: docs/specs/2026-07-14-autonomous-universe-lifecycle-service.md
- Create: docs/decisions/ADR-003-autonomous-universe-lifecycle-policy.md

**Steps:**

1. Record the subsystem completion matrix and identify universe lifecycle as
   the first incomplete subsystem.
2. Define state membership, evidence sources, reason codes, bounded defaults,
   recovery behavior, and explicit non-goals.
3. Record that strategy promotion and global self-healing remain later
   subsystems.

### Task 2: Write lifecycle tests before implementation

**Files:**
- Create: tests/universeLifecycleService.test.ts

**Steps:**

1. Add a temporary SQLite test harness with paper-only environment defaults.
2. Add a failing test that discovers a valid Alpaca asset and records
   discovered then observe_only events while keeping it out of research.
3. Add failing tests for qualification, paper eligibility, active-position
   state, failure suspension, recovery, retirement, event metadata, and
   bounded discovery cursor behavior.
4. Run tsx --test tests/universeLifecycleService.test.ts and confirm each test
   fails because the service does not yet exist.

### Task 3: Add lifecycle persistence and typed universe membership

**Files:**
- Modify: src/types.ts
- Modify: src/lib/db.ts
- Modify: src/services/databaseMaintenanceService.ts
- Modify: src/services/universeService.ts

**Steps:**

1. Add lifecycle state and reason types plus lifecycle row/event/run types.
2. Add additive current-state columns and append-only lifecycle run/event
   tables with migration-safe defaults and indexes.
3. Make database verification require the lifecycle tables, columns, indexes,
   and migration version.
4. Extend universe row mapping and add getObservableUniverse and
   getObservableSymbols.
5. Restrict getActiveUniverse to research_eligible, paper_eligible, and
   paper_active while retaining the enabled and tradable compatibility checks.
6. Run the focused lifecycle tests and confirm they remain failing only for the
   unimplemented worker.

### Task 4: Implement bounded discovery and state transitions

**Files:**
- Modify: src/config.ts
- Modify: src/services/alpacaAssetService.ts
- Create: src/services/universeLifecycleService.ts

**Steps:**

1. Add conservative, allowlisted universe lifecycle configuration and a
   versioned policy fingerprint.
2. Add a read-only Alpaca active-US-equity list function using GET /v2/assets.
3. Implement a deterministic rotating discovery cursor, metadata admission,
   bounded historical-bar refresh, evidence aggregation, and local transition
   persistence.
4. Persist Git SHA, config version, and config hash on every event and run.
5. Use injected dependencies in tests and never import an order-submit client.
6. Run the focused lifecycle tests and confirm green behavior.

### Task 5: Connect the automatic consumers without changing trade gates

**Files:**
- Modify: src/services/stockObservationService.ts
- Modify: src/cli.ts
- Modify: package.json

**Steps:**

1. Change the observatory default universe to getObservableSymbols.
2. Keep research and downstream callers on getActiveSymbols.
3. Add universe lifecycle and status CLI commands plus the universe:lifecycle
   script.
4. Confirm the command is non-executing and failures set a nonzero exit code.
5. Run the focused lifecycle test and the existing market observatory test.

### Task 6: Add the dedicated daily VPS worker

**Files:**
- Create: server/systemd/alpaca-universe-lifecycle.service
- Create: server/systemd/alpaca-universe-lifecycle.timer
- Modify: scripts/install-paper-monitoring-systemd.sh
- Modify: scripts/disable-paper-monitoring-systemd.sh
- Modify: tests/paperMonitoringScheduler.test.ts
- Modify: server/systemd/README.md

**Steps:**

1. Create an alpaca-user oneshot service with paper-only/live-off environment
   values and no execution command.
2. Schedule it on weekdays at 16:30 America/New_York after existing late-day
   database-heavy work.
3. Install and disable the timer through the existing systemd scripts.
4. Add scheduler tests for the non-executing command, post-close cadence,
   bounded timeout, and non-overlap rationale.
5. Run the scheduler test, bash -n on both scripts, and systemd-analyze verify.

### Task 7: Synchronize operator documentation and validate the release

**Files:**
- Modify: README.md
- Modify: RESUME_CONTEXT.md

**Steps:**

1. Document lifecycle commands, membership semantics, configuration, daily
   scheduling, recovery, and paper-only boundaries.
2. Update the resume checkpoint with the exact post-deploy validation sequence.
3. Run npm run typecheck, npm run lint, the focused tests, and the required
   scheduler/database checks.
4. Deploy only the reviewed branch, install the unit, inspect the first run,
   and validate that no order was submitted.

### Task 8: Complete the authorized delivery loop

**Files:**
- Update: Basic Memory Current State, Trading Boundaries, Decision Log, and
  dated acceptance checkpoint after deployment evidence exists.

**Steps:**

1. Commit only lifecycle files.
2. Push the feature branch, open a PR, merge after checks pass, deploy to the
   VPS, and verify production.
3. Record exact production SHA, timer state, first-run status, lifecycle
   evidence, validation commands, and no-order boundary in Basic Memory.
