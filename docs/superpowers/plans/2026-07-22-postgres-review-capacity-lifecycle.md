# PostgreSQL Review Capacity Lifecycle Repair

> **Scope:** Repair only the production `POSTGRES_REVIEW_CAPACITY_UNAVAILABLE` lifecycle path. Preserve PostgreSQL authority, paper-only execution, all existing sizing/allocation/risk controls, and fail-closed behavior for unsafe or incomplete evidence.

**Baseline:** `46bb03867796c461fdf5c974671cbd4bf67338a6`

**Production evidence:** The active allocation is `$30,000`, current broker-backed deployed exposure is `$42,870.426794`, and active reservations total `$0`. Thirty-two `created` order intents are linked to already-expired execution reviews; they have no reservation, submission, broker order, or broker event. Review sizing therefore correctly computes zero remaining capacity, but the command currently throws and aborts the worker before later workstreams run.

## Task 1: Make exhausted review capacity nonfatal and recover provably stale intents

**Files:**

- Modify: `src/services/postgresReviewWorkflowService.ts`
- Modify: `src/services/autonomousPostgresCommandService.ts`
- Modify: `tests/postgresReviewWorkflowService.test.ts`
- Modify: `tests/autonomousPostgresCommandService.test.ts`

**Requirements:**

1. Add a failing regression test proving that a candidate with zero remaining allocation capacity creates no review or order intent and returns a successful, explicit no-capacity outcome instead of throwing.
2. Preserve batch-wide fail-closed behavior for stale market evidence, missing account evidence, malformed sizing evidence, and insufficient option-contract notional when positive capacity exists.
3. Treat zero remaining capacity as a row-level skip. If every otherwise eligible candidate is capacity-blocked, return `status: "completed"`, code `POSTGRES_REVIEW_CAPACITY_UNAVAILABLE`, zero reviews/intents, and an explicit capacity-blocked count. Do not alter any sizing input or threshold.
4. Add a failing recovery test proving `system:recover` cancels only `created` intents whose linked execution review is terminal (`expired`, `revoked`, or `blocked`) or whose review expiry has elapsed. Set `terminal_at`, `updated_at`, increment `version`, and update the lifecycle fingerprint. Do not cancel `ready_for_submission`, `submission_pending`, `submitted`, `ambiguous`, or reconciled intents.
5. When normal recovery expires buying-power reservations, decrement the matching active strategy allocation's `reserved_amount` in the same fenced PostgreSQL statement. Do not change `deployed_amount` or allocation capacity.
6. Keep every recovery mutation fenced by the current scheduler lease and report recovered intent count in the command result.
7. Run the focused tests first, then `npm run typecheck`, `npm run build`, and `git diff --check`.
8. Commit the validated change with a narrow production-fix message and write the implementation report requested by the subagent-driven-development workflow.

**Focused validation:**

```bash
npx tsx --test tests/postgresReviewWorkflowService.test.ts tests/autonomousPostgresCommandService.test.ts
npm run typecheck
npm run build
git diff --check
```

**Production validation after deployment:**

- Run the existing PostgreSQL-only recovery path; confirm only provably stale `created` intents close.
- Start and enable `alpaca-autonomous-paper.service` with paper-only flags unchanged.
- Observe one worker cycle through `research:daily`, `paper:review`, `paper:options:discover`, and `paper:execute:reviewed`.
- Confirm capacity exhaustion creates no intent/order, does not terminate the cycle, and the service remains running.
