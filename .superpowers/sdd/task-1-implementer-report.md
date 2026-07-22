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
