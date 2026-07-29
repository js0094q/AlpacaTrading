# Section 10 Bounded Outcome Learning Implementation Plan

> Execute this plan test-first. Preserve the accepted Section 9 parent, produce
> one Section 10 commit, and stop before Section 11.

**Goal:** Build a bounded, PostgreSQL-only candidate-to-outcome projection and
optional read-only historical evidence without changing strategy behavior or
execution authority.

**Architecture:** Add migration 9 for refresh audit, normalized outcome records,
and bounded aggregates. A fenced learning service reads candidates and related
records in bounded batches, computes only supported metrics, and idempotently
upserts derived rows. The existing `paper:learn` scheduler command invokes the
service. A read-only repository loads validated aggregates once per research
batch; consumption defaults off and attaches evidence only.

**Technology:** TypeScript, Node test runner, PostgreSQL, existing scheduler
leases/fences, existing CLI and migration infrastructure.

## Global Constraints

- Do not change `config.toml`, `AGENTS.md`, strategy thresholds, strategy
  priorities, allocation, Section 9 arbitration, or order submission.
- Do not import broker/execution modules from any outcome or aggregate module.
- Do not update or delete authoritative lifecycle or market tables.
- Keep every query date-bounded, record-bounded, parameterized, and indexed.
- Keep paper and live environments separate; never estimate hypothetical live
  costs.
- Make missing, ambiguous, and unsupported fields explicit; never use zero for
  unavailable data.
- Validate with the smallest useful backfill only.

### Task 1: Lock the migration contract

**Files:**

- Create: `src/lib/database/migrations/009_bounded_outcome_learning.sql`
- Create: `tests/postgresOutcomeLearningMigration.test.ts`
- Modify: `tests/postgresSchema.test.ts`

1. Write failing tests for tables, constraints, foreign keys, JSON/array
   defaults, environment checks, unique identities, and required indexes.
2. Run the migration tests and verify failure is caused by missing migration 9.
3. Add the migration with derived tables and `candidates(as_of, id)`.
4. Run focused migration/schema tests to green.

### Task 2: Define bounded domain calculations

**Files:**

- Create: `src/services/outcomeLearningModel.ts`
- Create: `tests/outcomeLearningModel.test.ts`

1. Write failing fixtures for exact, partial, missing, ambiguous, and
   unsupported lifecycle joins.
2. Add failing tests for authoritative fill timing, partial/full status,
   nearest-prior market reference, stale/future exclusion, side-aware
   slippage, supported closed return, open unrealized checkpoint, bounded equity
   and option excursion, and paper limitations.
3. Add failing tests for equity/0DTE/LEAPS and reason/confidence/spread/
   liquidity/research/catalyst grouping.
4. Implement pure deterministic helpers with null-preserving metrics.
5. Run the focused tests to green.

### Task 3: Implement the fenced bounded projection

**Files:**

- Create: `src/services/postgresOutcomeLearningService.ts`
- Create: `tests/postgresOutcomeLearningService.test.ts`

1. Write failing tests for explicit manual bounds, maximum 500 records, maximum
   31-day range, invalid timestamps/numerics, `max + 1` truncation detection,
   batched source loads, parameterized SQL, and indexed nearest-prior lookups.
2. Write failing tests for deterministic source fingerprints, replay
   idempotency, scheduler-fence checks, source immutability, broken-record
   isolation, and no recursive scheduling.
3. Implement the bounded reads, domain transformation, fenced derived-table
   writes, refresh audit, aggregate rebuild, and no-op replay.
4. Run focused service tests to green.

### Task 4: Add aggregate validation and read-only consumption

**Files:**

- Create: `src/services/historicalOutcomeEvidenceService.ts`
- Create: `tests/historicalOutcomeEvidenceService.test.ts`
- Modify: the existing PostgreSQL research proposal workflow at its bounded,
  once-per-batch evidence integration point
- Modify: focused research workflow tests

1. Write failing tests for environment/lane matching, minimum sample, date
   bound, incomplete-join ratio, staleness, schema compatibility, and truncated
   source rejection.
2. Write failing regression tests proving no evidence preserves byte-equivalent
   proposal score/configuration behavior and valid evidence only adds compact
   evidence plus a reason code.
3. Write failing tests proving one aggregate load per batch and local failure
   isolation.
4. Implement default-off configuration and read-only evidence attachment.
5. Run focused research and Section 8/9 tests to green.

### Task 5: Wire the existing learning workstream and query surface

**Files:**

- Modify: `src/postgresOnlyCli.ts`
- Modify: `src/services/postgresSchedulerCommandRegistry.ts`
- Modify: `src/lib/database/postgresOnlyRuntime.ts`
- Modify: `package.json`
- Modify: autonomous worker and CLI tests

1. Write failing tests that `paper:learn` invokes the fenced outcome refresh and
   accepts only bounded `--start`, `--end`, and `--maxRecords`.
2. Add a read-only `paper:outcomes` command with bounded filters and limit.
3. Prove the worker still runs `paper:learn` once in its established position,
   an empty range is a no-action completion, and failure is local.
4. Remove broker lookup from the learning path and preserve it only for
   recovery.
5. Run focused scheduler, worker, CLI, authority, and execution-separation
   tests.

### Task 6: Document configuration and operations

**Files:**

- Modify: `.env.example`
- Modify: `README.md`
- Modify: `RESUME_CONTEXT.md`
- Modify: `server/README.md`
- Modify: `server/RESUME_CONTEXT.md`

1. Document default-off evidence, bounds, bucket definitions, paper
   limitations, manual bounded refresh/query commands, migration 9, performance
   tolerance, and rollback.
2. Keep the root and server continuation notes synchronized.
3. Confirm no secret values or live-trading changes are present.

### Task 7: Validate scope and release

1. Run all focused Section 10 tests and query-plan/static execution-boundary
   tests.
2. Run Section 6, 7, 8, and 9 regression sets plus lifecycle, reconciliation,
   recovery, cancellation, and exit tests.
3. Run full tests, lint, typecheck, application build, and dashboard build.
4. Run `git diff --check`, secret scan, complete diff inspection, and an
   independent code review; resolve all material findings and revalidate changed
   scope.
5. Stage only Section 10 files, inspect the entire staged diff, and create one
   precise commit whose parent is
   `de8f885642f688abceac58b156e56023d5bef568`.
6. Push `main` normally; verify local, origin, and direct remote SHAs match and
   the tracked worktree is clean.

### Task 8: Deploy and validate the exact SHA

1. Verify VPS path, SHA, clean tracked checkout, paper/live flags,
   PostgreSQL-only authority, SQLite-off posture, systemd units, rollback SHA,
   and that no secret change is needed.
2. Pull the exact SHA, install/build as required, apply only migration 9, and use
   no more than one intentional worker restart.
3. Verify migration checksum, schema objects/indexes/constraints, no drift, and
   unchanged authoritative-source counts.
4. Run the explicit `2026-07-28T00:00:00Z` to
   `2026-07-29T00:00:00Z`, maximum-250 validation refresh twice; prove actual
   bounded count, truncation state, and idempotency.
5. Query bounded outcomes/aggregates and verify exact/missing lineage,
   paper limitations, read-only evidence, duplicate absence, unchanged broker
   mutation counts, and measured duration within 45 seconds.
6. Verify worker/dashboard stability, safety posture, Vercel exact SHA/READY,
   and public paper summary HTTP 200.
7. Update the existing Basic Memory continuity record, read it back, deliver the
   required 32-point report, and stop.
