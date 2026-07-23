# Strategy Allocation Backfill Conflict Repair

## Goal

Resolve the production `EXECUTION_STATE_BACKFILL_CONFLICT:strategy_allocations`
without changing allocation policy, strategy behavior, or execution limits.

## Verified current state

- The sealed SQLite source has no physical `strategy_allocations` table. The
  migration projects one current allocation observation from the latest signed
  review artifact.
- The projected row and PostgreSQL row have the same primary key, account,
  strategy key, configuration fingerprint, currency, allocation amount, and
  allocation ratio.
- PostgreSQL retains an earlier superseded allocation for a different
  configuration and a current row for the matching configuration.
- The matching PostgreSQL row has a higher version, a later `updated_at`, and a
  greater (not regressed) deployed amount. Reserved amount is equal.
- `effective_from`, `created_at`, `updated_at`, `version`, and
  `deployed_amount` differ. The first two are projection/activation provenance;
  the latter three are mutable singleton authority state.
- No PostgreSQL foreign key references `strategy_allocations.id`. Related
  reservation and intent rows use account and strategy identity, so no primary
  key remap is required for the observed same-key conflict.
- The current generic primary-key replay path treats every difference as a
  conflict and stops before later tables are backfilled.

## Decision

Classify the production row as Outcome A, mutable singleton advancement. Reuse
the current PostgreSQL row only when all immutable identity, environment,
strategy, lifecycle, and allocation-policy fields are semantically equal; the
target version and update time are strictly newer; deployed state does not
regress; and activation provenance is not later than the sealed observation.

Preserve the PostgreSQL primary key and row without updating it. Preserve
superseded PostgreSQL-only allocation history. Report all accepted mutable and
provenance differences. Reconciliation must apply the same classifier.

## Scope and non-goals

In scope:

- a dedicated strategy-allocation primary replay classifier;
- canonical comparison of existing numeric, bigint, and timestamp formats;
- sanitized failure classifications;
- production-shaped positive and fail-closed tests;
- backfill and reconciliation use of the same contract.

Out of scope:

- schema or unique-index changes;
- allocation or risk-policy changes;
- strategy changes;
- rewriting execution history;
- treating distinct configuration versions as equivalent.

## Failure behavior

Fail closed for malformed rows, different primary/account/strategy identity,
different environment or policy values, lifecycle incompatibility, stale or
non-monotonic target state, a deployed-state regression, later activation
provenance, a distinct current allocation collision, or an unknown difference.
On failure, do not overwrite, insert a duplicate, remap, or continue.

## Validation

- focused strategy-allocation identity tests;
- execution-state migration tests;
- Release 4 tests;
- full test suite;
- typecheck, build, and `git diff --check`;
- supported Neon integration test when its configured environment is available.

## Deployment boundary

Promote only the validated commit. Keep dashboard-control and autonomous-worker
stopped through backfill. Create a fresh sealed snapshot and run one supported
backfill. Reconcile only after a successful backfill, and start dashboard-control
only after a durable passed reconciliation checkpoint. Never start the worker or
submit an order in this task.
