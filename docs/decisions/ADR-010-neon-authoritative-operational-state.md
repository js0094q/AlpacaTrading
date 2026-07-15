# ADR-010: Neon PostgreSQL owns concurrent operational state

## Status

Accepted 2026-07-15. Authority changes are staged and require the reconciliation gates below.

## Context

The VPS currently runs multiple paper-only research, observatory, reconciliation,
exit, and 0DTE workstreams against one SQLite file. `SQLITE_BUSY` failures have
occurred on short lifecycle writes while another scheduled writer held the
single SQLite writer slot. Bounded transactions and retries reduce symptoms but
cannot provide distributed scheduler ownership, cross-strategy capital
allocation, or durable multi-worker coordination.

Vercel has an attached Neon PostgreSQL integration with pooled and direct
connection variables. The VPS is a separate runtime and must receive its own
protected configuration; Vercel variables are not implicitly available there.

## Decision

Neon PostgreSQL becomes the authoritative store for state that requires
concurrent access, transactional consistency, distributed ownership, or
cross-workstream coordination. This includes scheduler leases, research-run
control, candidates and lifecycle events, idempotency and workstream events,
reconciliation checkpoints, accounts, positions, order intents and orders,
broker events, reservations, allocations, exposure, risk limits, execution
reviews, confirmation evidence, and lifecycle fingerprints.

SQLite may remain only for append-only research observations, derived features
and signals, scoring traces, replay data, diagnostics, caches, and transient
ingestion spools. Workstreams that retain local SQLite publish immutable,
idempotent events to PostgreSQL. They do not own independently mutable copies of
positions, orders, reservations, allocations, or execution authorization.

Application code uses domain repositories. PostgreSQL transactions use one
checked-out `pg` client for every statement from `BEGIN` through `COMMIT` or
`ROLLBACK`. PostgreSQL-specific implementations may use row locks, advisory
locks, conditional writes, fencing tokens, and optimistic versions.

Scheduler ownership moves from process-local lock files to PostgreSQL leases
with atomic acquisition, expiration, heartbeat, monotonic fencing tokens,
owner/run/workstream identity, and conditional writes. A stale token cannot
commit after a newer owner acquires the lease.

Reservation and allocation decisions execute atomically under the applicable
PostgreSQL account or portfolio lock. Broker submission is split into two
transactions: the first validates evidence and commits an idempotent intent and
reservation transition; the external Alpaca paper request occurs with no open
database transaction; the second stores the broker response idempotently.
Ambiguous network results reconcile by deterministic client order ID before
resubmission.

Authority changes proceed through explicit schema creation, backfill,
reconciliation, bounded paper-only shadow comparison, control-plane cutover,
execution-state cutover, and SQLite retirement. No stage creates indefinite
mutable dual authority.

## Connection and secret policy

- Pooled Neon connections serve ordinary Vercel and application traffic.
- A bounded `pg` pool serves long-running VPS processes.
- Direct or unpooled connections serve migrations and controlled backfill.
- Connection variables are discovered from actual Vercel/VPS/local
  configuration and are never hard-coded.
- URLs, passwords, tokens, and environment-file contents never appear in logs,
  errors, tests, fixtures, screenshots, documentation, pull-request text, or
  completion reports.
- PostgreSQL startup fails closed when its selected mode lacks a required key;
  errors identify only the missing variable name.

## SQLite transition policy

SQLite journal mode is not changed from DELETE merely because WAL permits more
reader concurrency. WAL may be adopted temporarily only after a copied
production database passes journal, checkpoint, fsync, backup, concurrent
reader/writer, termination recovery, integrity, foreign-key, filesystem, and
deployment-script tests on the real VPS storage. The source database is never
altered by that test.

Retry remains a bounded transition guard, not the architecture. Only explicitly
idempotent or rollback-safe operations may retry `SQLITE_BUSY` or
`SQLITE_LOCKED`, using finite attempts, exponential backoff with jitter, and a
total deadline. Validation, constraint, corruption, and application failures
are never retried.

Ordinary CLI commands, services, timers, and health checks never apply SQLite or
PostgreSQL migrations. Schema mutation uses dedicated commands before dependent
services start. Runtime may perform read-only compatibility checks. Node test
fixtures may explicitly initialize scratch databases.

## Alternatives considered

- Separate mutable databases per workstream followed by asynchronous merge:
  rejected because risk state and event ordering would be stale or ambiguous,
  and reservations could conflict or duplicate.
- Process-local mutexes or lock files as authoritative ownership: rejected
  because they do not fence distributed or restarted workers.
- Indefinite dual writes: rejected because failures can create competing
  authority and unrecoverable partial divergence.
- SQLite WAL as the long-term solution: rejected because it retains one writer
  and cannot provide the required distributed transactional controls.

## Consequences

The system gains database-enforced ownership, idempotency, and atomic capital
coordination. Migration complexity increases: both control-plane and execution
domains require explicit field mappings, resumable backfill, reconciliation,
shadow comparison, and deployment evidence. Connection pools and transaction
timeouts become operational dependencies. SQLite remains available for local
evidence but cannot authorize or represent canonical trading state after final
cutover.

## Validation and cutover gates

Control-plane authority requires reconciled counts, identifiers, status
distributions, active runs, candidates by run, lifecycle ordering, idempotency
records, leases, and checkpoints. Execution authority additionally requires
reconciled accounts, snapshots, positions, open orders, intents, broker/client
IDs, reservations, allocations, reserve/exposure totals, reviews, confirmation
evidence, fingerprints, duplicates, and orphans.

Any unexplained discrepancy blocks the next authority expansion. Final
acceptance requires exact GitHub/Vercel/VPS SHAs, verified connectivity and
migration version, overlapping paper workflows without SQLite lock failures or
duplicates, no credential leakage, no committed environment file, and live
trading disabled.

## Conditions for reconsideration

Reconsider the client or lock strategy only with runtime evidence that the
selected Neon endpoint, pool, transaction semantics, or fencing design cannot
meet bounded paper-runtime concurrency and safety requirements. Such a change
requires a new ADR and must not reintroduce independently mutable authority.
