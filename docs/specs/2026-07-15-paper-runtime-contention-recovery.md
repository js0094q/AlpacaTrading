# Paper Runtime Contention and Recovery Repair

## Goal

Remove avoidable SQLite writer contention from ordinary CLI startup, preserve
causal command failures, bound Alpaca health requests inside the control-route
deadline, and make paper research lifecycle recovery and single-flight behavior
durable. The release remains paper-only and must not submit any paper or live
order during implementation or validation.

## Verified current state

- `getDb()` calls `initializeDatabaseHandle()` for every CLI process.
- Initialization executes the complete base `CREATE TABLE IF NOT EXISTS`
  schema, legacy column checks, an unconditional Phase 1B `BEGIN IMMEDIATE`,
  and an unconditional 0DTE `BEGIN IMMEDIATE`, even when all recorded
  migrations are already applied.
- Production uses SQLite `journal_mode=delete`; this repair does not change the
  journal mode. Runtime currently sets `foreign_keys=ON` and a 60-second
  `busy_timeout`; the database default synchronous mode remains in effect.
- The control runner stores stdout and stderr separately while the child runs,
  but on failure it selects stderr first. A Node `ExperimentalWarning` can
  therefore replace a structured stdout `database is locked` failure.
- `/api/v1/health` and its child command each allow 10 seconds. The CLI performs
  account and clock requests sequentially, while each Alpaca call independently
  defaults to a 15-second timeout and two retries.
- `research_runs` records `running`, `completed`, and `failed`, but has no
  heartbeat/recovery metadata, database-backed single-flight reservation, or
  autonomous stale-run recovery.
- Existing autonomous recovery handles universe lifecycle, learning governance,
  and selected paper operations in one immediate transaction with immutable
  recovery events.

## Desired end state

1. Ordinary startup configures connection PRAGMAs and verifies recorded schema
   state without DDL or a write transaction.
2. An explicit migration path reads applied versions first, returns without a
   write transaction when current, and otherwise acquires `BEGIN IMMEDIATE`,
   rechecks under the lock, applies one transactional migration group, records
   it, and commits.
3. An empty first-start database may initialize transactionally. An existing
   database with pending migrations fails closed with a structured
   `DATABASE_MIGRATION_REQUIRED` error until `db:migrate` is run.
4. Command failures preserve exit code, signal, timeout state, bounded/redacted
   stdout and stderr, warnings, and a primary structured error.
5. Health account and clock calls share one monotonic operation deadline with a
   completion margin. Every request attempt and retry delay is derived from the
   remaining budget and in-flight work is aborted on cancellation.
6. Research creation is a database-backed compare-and-set reservation. A valid
   active run returns `already_running`; a stale run is terminalized under the
   same deterministic recovery policy before a replacement is reserved.
7. Autonomous recovery terminalizes stale research rows as `failed`, records
   `WORKER_TERMINATED_OR_HEARTBEAT_EXPIRED`, and retains timestamps and available
   worker/request/correlation evidence in the source row and recovery event.

## Scope

- SQLite migration runner, runtime initialization, explicit verification, and
  migration metadata.
- Research lifecycle columns, stale recovery, heartbeats, and single-flight.
- Dashboard child-process result normalization and error envelope metadata.
- Alpaca read-only request deadline propagation for the health command.
- Focused tests, repository documentation, deployment runbook, and exact-SHA
  VPS/Vercel release validation.

## Non-goals

- No WAL conversion, unbounded lock retry, timer disablement, strategy change,
  live-trading path, order-submission change, execution-cap change, or weakening
  of reviews, signatures, freshness checks, reservations, fingerprints, or
  confirmation gates.
- No paper or live order submission during validation.

## Interfaces and contracts

### Migration contract

- Required runtime migration versions are explicit and read-only to inspect.
- `db:migrate` is the production mutation path.
- `db:verify` is read-only and reports required migration presence, integrity,
  foreign-key violations, missing schema objects, and configured PRAGMAs.
- Lock retries, if required for migration startup races, are bounded to
  SQLite busy/locked errors and never wrap non-idempotent application work.

### Command failure contract

```json
{
  "exitCode": 1,
  "signal": null,
  "timedOut": false,
  "stdout": "...",
  "stderr": "...",
  "warnings": ["ExperimentalWarning: SQLite is an experimental feature"],
  "error": { "code": "SQLITE_BUSY", "message": "database is locked" },
  "diagnosticExcerpt": "..."
}
```

Failure diagnostics are bounded and redacted. Structured stdout failure is
primary; stderr warnings remain secondary. Stderr-only and malformed-output
failures retain safe fallbacks. Successful structured JSON remains intact until
it is parsed within a 4,194,304-character per-stream cap. A child that exceeds that
cap is terminated and returns `COMMAND_OUTPUT_LIMIT_EXCEEDED` rather than a
truncated success value.

### Health deadline contract

- Control outer timeout: 10,000 ms.
- Child health operation budget: 9,000 ms by default.
- Completion margin: 750 ms by default.
- Account and clock calls share the same monotonic deadline.
- The request timeout is the lesser of configured timeout and usable remaining
  time. Retry waits and attempts stop when the budget is insufficient.
- Parent cancellation aborts the active fetch; the control runner kills the
  detached child process group on outer timeout.

### Research lifecycle contract

- Stale threshold: 15 minutes from `COALESCE(heartbeat_at, started_at)`, matching
  the existing bounded paper-operation recovery convention and exceeding the
  7-minute dashboard research deadline and 10-minute morning service deadline.
- Terminal status: existing `failed` vocabulary.
- Recovery reason: `WORKER_TERMINATED_OR_HEARTBEAT_EXPIRED`.
- A reservation transaction first terminalizes eligible stale rows, then returns
  the oldest valid active row or inserts exactly one new `running` row.
- Heartbeats are written between major research stages; no network call is held
  inside the reservation or recovery transaction.
- A worker that cannot renew its persisted `running` lease fails closed before
  candidate or plan persistence.
- The final lease renewal and candidate/plan persistence share one SQLite write
  transaction, so recovery cannot interleave between the check and those writes.

## Timer overlap review

No schedule changes are planned. Existing unit offsets reduce deterministic
overlap but do not prevent long tasks from crossing later windows.

The duration column is the latest successful production sample observed on
2026-07-15, not a long-run percentile; the parenthetical value is the service
deadline.

| Workflow | Checked-in schedule | Typical duration (latest sample) | Writes SQLite | Calls Alpaca | Can overlap research |
| --- | --- | ---: | --- | --- | --- |
| 0DTE engine | Every minute in entry window near `:45` | 8.5 s (300 s max) | Yes | Yes | Yes |
| 0DTE exit review | Every minute near `:55` | 6.3 s (300 s max) | Yes | Yes | Yes |
| 0DTE reconciliation | Every 5 minutes near `:30` | 8.9 s (300 s max) | Yes | Yes | Yes |
| Market observatory | Every 15 minutes | 17.8 s (300 s max) | Yes | Yes | Yes |
| Paper exit review | Every 15 minutes, then every 5 late day | 81.1 s (300 s max) | Yes | Yes | Yes |
| Paper exit execute | Every 15 minutes, then every 5 late day | 6.9 s (300 s max) | Yes | Yes | Yes |
| Paper review | Every 30 minutes | 298.7 s (900 s max) | Yes | Yes | Yes |
| Paper execute | Every 30 minutes | 4.0 s (300 s max) | Yes | Yes | Yes |
| Autonomous recovery | Minutes 07, 22, 37, 52 | 3.8 s (60 s max) | Yes | No | Yes |
| Morning research workflow | Weekdays 08:30 | 251.3 s (600 s max) | Yes | Yes | It is the scheduled research owner |

Removing migration writes from ordinary process startup is the primary fix.
Timer changes require new post-fix contention evidence.

## Failure behavior

- Pending schema on an existing runtime database fails closed before command
  execution.
- Failed migrations roll back and do not record their version.
- Health budget exhaustion returns structured deadline metadata before the
  control route's outer timeout whenever cleanup margin remains.
- A fresh active research run is never terminalized or duplicated.
- Recovery is idempotent and source-row updates use `status='running'` compare
  conditions so concurrent workers cannot double-transition a run.

## Acceptance criteria

- Required migration, concurrency, rollback, error-reporting, deadline,
  recovery, and single-flight regression tests pass.
- `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` pass.
- A copied database passes two migrations, verification, integrity, and
  foreign-key checks with legacy row counts preserved.
- One focused PR is reviewed, merged, and deployed by exact merge SHA.
- Production migrations run once through `db:migrate` before affected services
  restart; ordinary CLI startup does not migrate.
- The pre-existing stale research row is recovered through `system:recover`.
- One guarded dashboard research run and one read-only 0DTE discovery complete
  or return their documented internal deadline state without overlap/orphans.
- GitHub main, VPS, running service, and Vercel resolve to the merged SHA.
- No paper or live order is submitted.

## Deployment and rollback boundaries

Deployment is authorized for the merged SHA only. Stop affected SQLite writers,
back up the database, validate the migration on a copy twice, migrate production
once, verify, deploy/restart only required services, and restore prior timer
state. Rollback may return the application to the immediately prior SHA because
the migration is additive; new nullable lifecycle columns and the recovery
counter remain compatible. Do not reverse the migration or delete recovery
evidence during application rollback.
