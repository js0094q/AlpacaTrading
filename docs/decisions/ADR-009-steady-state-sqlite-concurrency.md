# ADR-009: Scoped steady-state SQLite concurrency repair

## Status

Accepted 2026-07-15.

## Context

Research run `research_048b8cb3-e615-472c-95ad-be96ff497f3b` failed after the
options snapshot ingestion interval with `database is locked`. The exact
unhandled lifecycle write was:

```sql
UPDATE research_runs
SET heartbeat_at = ?
WHERE id = ? AND status = 'running'
```

The closest proven competing write scope in the same interval was the scheduled
0DTE engine's `BEGIN IMMEDIATE` persistence batch, which wrote 100 observations
and evaluations. Historical logs did not retain the lock-holder PID, exact
SQL trace, or exact lock duration; this ADR does not infer them. Network calls
and CPU-heavy normalization occur before both persistence transactions.

## Decision

- Keep SQLite in its existing DELETE rollback-journal mode and keep the explicit
  `db:migrate` schema boundary. Runtime initialization remains read-only for a
  current database.
- Add one additive migration for `runtime_write_leases`, with one named lease
  `research-options-and-zero-dte-engine`. Only research option contract/snapshot
  persistence and the 0DTE engine persistence batch use this lease.
- Normalize option rows before acquiring the lease. Persist contracts and
  snapshots in bounded 250-row `BEGIN IMMEDIATE` batches using existing
  conflict-safe identities. Assert/renew the lease around each batch.
- Use finite `SQLITE_BUSY` retry only for idempotent lifecycle updates, lease
  maintenance, and rollback-safe persistence batches. Reservations, broker
  calls, order ledgers, and append-only audit writes are not retried blindly.
- Emit bounded structured contention telemetry containing operation,
  transaction duration, retry count, process identity, and run/correlation ID.
- Keep all existing timers, review gates, freshness checks, caps, reservations,
  confirmation controls, and paper/live boundaries unchanged.

## Alternatives rejected

- Global serialization of all reads and writes: broader than the evidence and
  would unnecessarily delay observatory, review, and read paths.
- Disabling timers or changing their stagger: hides the steady-state defect and
  changes normal production behavior.
- WAL mode: a later same-filesystem Btrfs/RBD production-copy test passed WAL,
  checkpoint, concurrent-reader, online-backup, SIGKILL-recovery, integrity,
  foreign-key, and migration-twice checks. DELETE remains in place because the
  deployment has no sidecar-aware backup/restore automation, and WAL would not
  remove the single-writer or distributed-ownership limits. See the Neon
  operational-state inventory for the evidence and decision.
- Unbounded retries: could prolong a failed worker and obscure lease loss.

## Consequences

The two evidenced heavy writers now coordinate without a process-wide lock.
Shorter transactions reduce writer hold time, and a failed lease or bounded
retry returns a terminal persistence failure instead of spinning indefinitely.
The lease table is an additive schema dependency and must be applied through
the explicit migration command before runtime restart. Contention events become
available in service logs for future attribution; they intentionally do not
retroactively identify the historical lock owner.

## Validation

The repair includes deterministic multi-process DELETE-journal contention tests,
retry-bound and non-idempotent tests, connection PRAGMA checks, lease-loss
tests, migration/integrity/foreign-key checks, existing 0DTE safety tests, and
full repository validation. Production validation must keep the normal staggered
timer set active, require one successful guarded research run with persisted
targets/candidates, reject a duplicate run, and submit zero paper/live orders.
