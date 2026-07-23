# Research Steady-State SQLite Concurrency Repair

## Goal

Make paper research complete under the unchanged staggered timer schedule by
removing the evidenced long-writer overlap, bounding retries to idempotent work,
and making future SQLite contention attributable without changing order or
paper-safety behavior.

## Verified current state

- The production failure `research_048b8cb3-e615-472c-95ad-be96ff497f3b`
  reached `options_snapshots` completion at `2026-07-15T17:07:06.401Z` and
  then failed on the next research lifecycle heartbeat before features,
  targets, candidates, or plans were generated.
- The failing statement is the idempotent lifecycle update:

  ```sql
  UPDATE research_runs
  SET heartbeat_at = ?
  WHERE id = ? AND status = 'running'
  ```

- The closest proven competing write scope is the scheduled 0DTE engine's
  `BEGIN IMMEDIATE` persistence batch. It wrote 100 observations/evaluations
  during the research interval. The historical runtime did not retain lock
  owner PID or SQL trace telemetry, so the exact historical holder and exact
  lock duration are intentionally not claimed.
- Options network fetches and 0DTE network/CPU preparation occur before their
  respective persistence transactions. The long option persistence phase
  currently writes all rows in one transaction.
- Runtime connections use the existing bounded `busy_timeout` and
  `foreign_keys=ON` configuration. Production remains on rollback-journal
  (`journal_mode=delete`) mode.
- The explicit migration boundary from ADR-008 is deployed and must remain:
  runtime startup is read-only for current databases; `db:migrate` is the
  only production schema mutation path.

## Desired end state

1. Research option contracts and snapshots are normalized before persistence,
   then committed in bounded idempotent batches.
2. Only the research options persistence scope and the 0DTE engine persistence
   scope participate in a named database-backed heavy-persistence lease. Reads,
   ordinary paper review, reconciliation, and execution paths are not globally
   serialized.
3. `SQLITE_BUSY` retry is finite and applies only to explicitly idempotent
   lifecycle updates, lease maintenance, and rollback-safe idempotent batches.
   Reservations, order ledger writes, broker calls, and non-idempotent audit
   inserts are never blindly retried.
4. Contention diagnostics emit bounded structured JSON with operation name,
   transaction/attempt duration, retry count, process identity, and run or
   correlation ID. Values and secrets are excluded.
5. Every relevant runtime or maintenance connection reports the same bounded
   `busy_timeout` and `foreign_keys=ON` settings.
6. A deterministic two-process DELETE-journal test proves the pre-repair
   heartbeat race fails and the repaired race completes and terminalizes the
   research run without duplicate durable rows.

## Scope

- Add one additive schema migration for the heavy-persistence lease table;
  keep the existing runtime migration boundary and journal mode unchanged.
- Add focused SQLite contention/retry/lease helpers and use them only in the
  named research options and 0DTE engine persistence paths plus idempotent
  research lifecycle updates.
- Batch option contract and snapshot persistence and preserve existing
  `ON CONFLICT` idempotency.
- Add focused tests, migration/integrity/foreign-key checks, documentation, and
  exact-SHA deployment validation.

## Non-goals

- No WAL conversion, journal-mode change, timer disablement, schedule rewrite,
  strategy change, live trading, paper order submission, execution-path change,
  or weakening of review, freshness, reservation, cap, or confirmation gates.
- No retry around broker calls, order reservations, paper execution ledger
  mutations, append-only non-idempotent API logging, or arbitrary application
  transactions.
- No claim that the historical lock-holder PID is known.

## Interfaces and contracts

### Heavy-persistence lease

The additive table is keyed by a single lease name and stores an owner token,
acquisition time, and expiry time. Acquisition and release are short
`BEGIN IMMEDIATE` transactions. A participant checks ownership before each
bounded persistence batch and renews after a successful batch. Expired leases
are reclaimable after a bounded wait. A lost lease stops further writes in that
participant.

### Bounded busy retry

The retry helper accepts an operation label, idempotency declaration, optional
run/correlation IDs, a finite attempt bound, and an injectable sleep/emitter for
tests. It retries only SQLite busy errors after the transaction has rolled back,
then emits one bounded diagnostic and rethrows. A non-idempotent operation is
never retried even when it raises `SQLITE_BUSY`.

### Option persistence

All network and row normalization work happens before the lease and write
transactions. Each bounded batch uses `BEGIN IMMEDIATE`, `ON CONFLICT`-safe
inserts, commit, and lease renewal. A later retry or rerun can safely replay a
completed batch without duplicate contracts or snapshots.

### 0DTE persistence

The engine's existing deterministic candidate, observation, evaluation, queue,
decision, and lifecycle identities remain unchanged. The engine wraps only its
existing persistence batch in the heavy lease and a rollback-safe bounded retry;
execution and broker mutation remain outside this scope and are not invoked by
tests or validation.

## Failure behavior

- Lease acquisition stops after its configured finite wait and returns a
  structured persistence failure; it never spins indefinitely.
- Lease loss raises a dedicated error before the next durable batch.
- A busy error from a non-idempotent operation propagates after one attempt.
- A busy error from an idempotent operation retries only within the finite
  bound; persistent contention terminalizes the research run through its
  existing failed-status path.
- Existing research single-flight, stale recovery, candidate/plan lease check,
  duplicate reservation, review, freshness, cap, and paper-only blockers stay
  authoritative.

## Acceptance criteria

- Focused tests cover the pre-repair RED race, repaired GREEN race, every
  connection PRAGMA, retry bounds, non-idempotent no-retry, lease loss,
  terminal status, scheduler-scope persistence, and duplicate prevention.
- `npm run test:zero-dte`, the full test chain, lint/typecheck/build, migration
  tests, integrity/foreign-key checks, and paper/live safety tests pass.
- A copied production database accepts the additive migration twice without
  changing journal mode or foreign-key/integrity results.
- One focused PR is reviewed, merged, and deployed at one exact SHA to the VPS
  and Vercel.
- All 14 normal timers remain enabled and healthy.
- One guarded research run succeeds with targets and candidates persisted and a
  concurrent duplicate request rejected as `already_running`.
- Paper review runs only after that successful research run; paper execution,
  exit execution, and all order-producing commands are not run.
- Final report identifies the exact failing statement, labels the closest
  proven competing write scope without inventing a historical PID, lists files
  and SHAs, reports integrity/foreign-key/timer state, and confirms zero orders.

## Deployment boundaries

Before production restart, copy and validate the additive migration twice,
capture integrity/foreign-key/journal/busy-timeout results, run `db:migrate`
once on production, deploy only the merged SHA, and restore the existing timer
state. Do not change `journal_mode`, disable timers, or run order-producing
commands during this repair.
