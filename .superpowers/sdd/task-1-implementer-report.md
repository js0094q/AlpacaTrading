# Task 1 Implementer Report: PostgreSQL Review Capacity Lifecycle Repair

## Status

DONE_WITH_CONCERNS

## Scope and files

Implemented only Task 1 in the assigned worktree. Changed:

- `src/services/postgresReviewWorkflowService.ts`
- `src/services/autonomousPostgresCommandService.ts`
- `tests/postgresReviewWorkflowService.test.ts`
- `tests/autonomousPostgresCommandService.test.ts`
- `docs/superpowers/plans/2026-07-22-postgres-review-capacity-lifecycle.md` was included in the task commit as requested; it was already present as the worktree's untracked plan file and was not substantively edited.

## Implementation

### Review capacity lifecycle

- Computed non-positive review sizing is now a row-level capacity skip rather than a thrown error.
- The result reports `capacityBlocked`.
- When no candidate remains reviewable because all otherwise eligible candidates are capacity-blocked, the workflow returns `status: "completed"` and `code: "POSTGRES_REVIEW_CAPACITY_UNAVAILABLE"` with zero reviews and intents.
- Mixed batches continue to review positively sized candidates while reporting capacity-blocked rows.
- Existing market, account-fingerprint, sizing-evidence, and option-contract validations remain before persistence and continue to fail closed.
- Existing sizing constants, allocation inputs, exposure inputs, risk limits, and execution gates were not changed.

### Recovery lifecycle

- `system:recover` now cancels only `created` order intents joined to an execution review that is `expired`, `revoked`, or `blocked`, or whose expiry has elapsed.
- The cancellation update is scheduler-fenced and sets `status`, `terminal_at`, `updated_at`, increments `version`, and derives a new lifecycle fingerprint.
- Expired buying-power reservations and the matching active strategy allocation are reconciled in one fenced PostgreSQL statement. The allocation update decrements only `reserved_amount`; it does not change `deployed_amount` or allocation capacity.
- Recovery results now report the cancelled intent count as `recovery.intents`.

## RED evidence

After adding the focused regression tests and before implementation:

```text
npx tsx --test tests/postgresReviewWorkflowService.test.ts tests/autonomousPostgresCommandService.test.ts
13 tests: 10 passed, 3 failed
```

The new capacity test failed with `POSTGRES_REVIEW_CAPACITY_UNAVAILABLE:SPY`. The recovery assertions failed because the result had no `intents` count and the required intent/allocation SQL was absent.

## GREEN and validation evidence

Commands run:

```text
npx tsx --test tests/postgresReviewWorkflowService.test.ts tests/autonomousPostgresCommandService.test.ts
npm run typecheck
npm run build
git diff --check
```

Results:

- Focused tests: PASS, 13/13.
- Typecheck: PASS.
- Build: PASS.
- `git diff --check`: PASS.

## Self-review

- Zero capacity cannot create a review or intent: capacity is classified before either insert, and the regression test asserts both inserts are absent.
- Stale market evidence, missing fingerprints/account sizing evidence, malformed required account values, and insufficient option-contract notional remain fail-closed when positive capacity exists.
- Recovery selects `created` intents only and requires a linked review plus terminal/expired evidence.
- Submission-capable, submitted, ambiguous, reconciled, and other non-created intents are excluded by the status predicate.
- Recovery mutations retain the current scheduler lease fence, including both the reservation and allocation updates in the same SQL statement.
- Allocation `deployed_amount` and capacity fields are untouched.
- No production, broker, SQLite, secret, deployment, or dirty canonical-checkout access was performed.

## Concerns / unresolved risks

- The focused tests validate generated SQL and mocked row counts; no PostgreSQL integration execution was run, per the task boundary prohibiting production/database access. The CTE should be exercised by the existing PostgreSQL-only recovery path after deployment.
- Production validation and worker-cycle observation remain pending deployment by the parent workflow. No deployment was performed here.

## Follow-up reviewer fixes

The independent review identified two Important issues, both fixed in the follow-up commit.

### SHA-256 lifecycle contract and audit

- Replaced the recovery-time `md5` expression with PostgreSQL `encode(sha256(convert_to(..., 'UTF8')), 'hex')`.
- The hashed input contains the intent id, prior lifecycle fingerprint, cancelled stage, and recovery timestamp.
- Recovery now uses a fenced data-modifying CTE to insert one `lifecycle_fingerprints` row per cancelled intent with `order_intent` / `cancelled` identity, SHA-256 algorithm, payload version 1, linked review status and expiry, recovery reason, and recovery timestamps.
- The final `SELECT` explicitly joins the fingerprint-insert CTE and therefore preserves rowCount equal to cancelled intents.
- Exported only the narrow `runAutonomousPostgresRecovery` helper for isolated PostgreSQL integration coverage; command result semantics are unchanged except for the existing recovered-intent count.

### PostgreSQL-only integration evidence

Added an environment-gated test in `tests/autonomousPostgresCommandService.test.ts`. It imports only PostgreSQL configuration, pool, migration, and recovery modules; it does not import or initialize SQLite. When enabled, it creates a random temporary schema, runs the actual migrations and recovery helper, seeds the held scheduler fence, allocation, expired/live reservations, terminal/current reviews, stale/current intents, and ready-for-submission intent, then drops the schema in `finally`.

## Follow-up RED evidence

After tightening the existing SQL regression assertions to require the SHA-256 expression and lifecycle audit CTE, before the reviewer fix:

```text
npx tsx --test tests/postgresReviewWorkflowService.test.ts tests/autonomousPostgresCommandService.test.ts
13 tests: 12 passed, 1 failed
```

The failure showed the old recovery SQL still used `md5` and had no `lifecycle_fingerprints` insert.

## Follow-up GREEN evidence

Commands run after the reviewer fixes:

```text
npx tsx --test tests/postgresReviewWorkflowService.test.ts tests/autonomousPostgresCommandService.test.ts
npm run typecheck
npm run build
git diff --check
```

Results:

- Ordinary focused tests: PASS, 13 passed and 1 integration test skipped because `POSTGRES_INTEGRATION_TEST_ENABLED` was unset.
- Typecheck: PASS.
- Build: PASS.
- `git diff --check`: PASS.
- The gated PostgreSQL integration test was not enabled because the available connection configuration was not explicitly authorized as isolated test infrastructure; no production or external database was accessed.

## Integration setup follow-up

The parent ran the gated PostgreSQL-only integration test against an isolated temporary VPS schema and supplied this real RED result before this fix:

```text
4 passed, integration test failed before recovery
PostgreSQL 42601: cannot insert multiple commands into a prepared statement
```

The failure occurred at the setup query around test line 202, where parameterized account, snapshot, scheduler lease, and allocation inserts were combined with semicolon separators. The setup now executes those four inserts as separate parameterized `schemaPool.query` calls. Recovery logic and all existing seed/assertion scope are unchanged.

Follow-up local validation after splitting the setup statements:

```text
npx tsx --test tests/postgresReviewWorkflowService.test.ts tests/autonomousPostgresCommandService.test.ts
npm run typecheck
npm run build
git diff --check
```

The integration gate remained disabled locally; no database was accessed in this follow-up.

## Scheduler-fence fixture follow-up

The parent then reran the isolated PostgreSQL integration test and reported a second RED result after setup succeeded:

```text
4 passed; integration reached recovery but result.intents was 0 at test line 286
```

The deterministic scheduler lease expiry reused `liveExpiry` (`2026-07-20T23:00:00.000Z`), but the real PostgreSQL clock was 2026-07-22, so the production fence predicate `lease.expires_at > now()` correctly rejected the lease. The test now gives only the scheduler lease a runtime-future expiry (`Date.now() + 60 minutes`); deterministic recovery, review, and reservation timestamps remain unchanged.

## Timestamp canonicalization follow-up

The parent’s third isolated-PostgreSQL run reached recovery and proved selective mutation, but reported a real RED fingerprint mismatch:

```text
PostgreSQL produced cf8e...; JavaScript expected 3298...
```

The cause was production SQL hashing `$1::text`, whose timestamptz text rendering depends on session timezone/format. The recovery hash input now uses PostgreSQL `to_char($1::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`, matching the JavaScript `Date.toISOString()` value used by the integration assertion. The SQL-text regression assertion now requires this canonical UTC expression.

## Audit evidence timestamp assertion follow-up

The parent’s fourth isolated-PostgreSQL run passed recovery, selective intent states, SHA-256 fingerprint, and allocation assertions. Its only failure was the raw JSONB evidence timestamp representation:

```text
PostgreSQL JSONB: 2026-07-20T21:30:00+00:00
JavaScript expected: 2026-07-20T21:30:00.000Z
```

These values are semantically equivalent. The integration test now compares the non-timestamp evidence fields directly and normalizes `reviewExpiresAt` through `new Date(...).toISOString()` before comparison. Production code was unchanged for this follow-up.
