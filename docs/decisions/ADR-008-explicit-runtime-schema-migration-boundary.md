# ADR-008: Explicit Runtime Schema Migration Boundary

## Context

Every SQLite-backed CLI process currently executes base schema DDL and enters
two immediate migration transactions even when all migrations are recorded as
applied. Concurrent scheduled paper workflows therefore acquire avoidable
writer locks during ordinary startup, and production research has failed with
`database is locked` under overlap.

## Decision

Separate ordinary database initialization from schema mutation.

- Ordinary startup configures connection PRAGMAs and verifies the required
  migration versions using reads only.
- An existing database with pending versions fails closed and directs the
  operator to the explicit `db:migrate` path.
- An empty first-start database may initialize through that same transactional
  migration implementation for local development and tests.
- Each migration group reads applied state before `BEGIN IMMEDIATE`, returns
  immediately when current, and rechecks after acquiring the lock before
  applying transactional, idempotent changes.
- Production deployment runs `db:migrate` before restarting affected services.
- SQLite journal mode remains unchanged; bounded busy handling does not replace
  the removal of unnecessary writes.

## Rationale

The migration ledger becomes the fast steady-state gate, while the recheck
under the writer lock keeps concurrent first-start and deployment migration
safe. Failing closed on an existing pending database prevents an ordinary
command from observing or extending a partially migrated schema.

## Alternatives considered

- Replace `BEGIN IMMEDIATE` with a deferred transaction: rejected because it
  weakens migration serialization without removing repeated migration work.
- Enable WAL as the primary fix: rejected because production currently uses
  rollback-journal mode and the demonstrated contention is avoidable startup
  writing, not evidence that journal mode must change.
- Add broad retries: rejected because they hide persistent contention and may
  repeat unsafe application work.
- Space every timer permanently: rejected because long runtimes can still
  overlap and schedule changes do not repair the startup contract.

## Consequences

Deployments must run and verify migrations explicitly before affected services
start. Runtime commands gain a clear `DATABASE_MIGRATION_REQUIRED` failure
instead of silently mutating schema. Migration metadata is now a required
runtime dependency, while full schema verification remains an explicit
maintenance command rather than per-command DDL.

## Validation

Tests cover current-schema read-only startup, skipped applied migrations,
concurrent starters, losing-starter recheck, rollback, idempotency, and schema
verification. Deployment validates a copied database twice before production,
then checks integrity, foreign keys, migration rows, PRAGMAs, and legacy counts.

## Reconsideration

Revisit for a reproduced lock failure after steady-state migration writes are
removed, a required online-migration strategy, or evidence supporting a
production journal-mode change.
