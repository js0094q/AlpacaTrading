# Neon PostgreSQL operations

## Scope and safety

This runbook covers the staged Neon operational-state migration. It never
authorizes live trading or broker mutation. Vercel and VPS validation remains
paper-only. Do not print, copy into documentation, or commit connection values.
Do not source an environment file into diagnostic output.

Release 3 adds the control-plane schema and Release 4 adds execution-state
repositories, backfill/reconciliation commands, authority routing, and fenced
coverage for all approved scheduled workstreams. Release 4 reuses schema
migrations 1 and 2; no migration 3 is required. SQLite remains authoritative
until the runtime gates below pass, and these defaults stay in force:

```text
DATABASE_BACKEND=sqlite
POSTGRES_READS_ENABLED=false
POSTGRES_WRITES_ENABLED=false
POSTGRES_SHADOW_COMPARE_ENABLED=false
POSTGRES_CONTROL_PLANE_AUTHORITY_ENABLED=false
POSTGRES_SCHEDULER_AUTHORITY_ENABLED=false
POSTGRES_EXECUTION_STATE_SHADOW_ENABLED=false
POSTGRES_EXECUTION_STATE_AUTHORITY_ENABLED=false
SQLITE_AUDIT_MIRROR_ENABLED=false
```

## Canonical connection variables

- `DATABASE_URL`: pooled endpoint for Vercel and ordinary application traffic.
- `DATABASE_URL_UNPOOLED`: direct endpoint for migrations and controlled
  backfill.

The Vercel integration may also expose `POSTGRES_URL`,
`POSTGRES_PRISMA_URL`, or `POSTGRES_URL_NON_POOLING`. Configuration accepts those
as ordered fallbacks but does not create duplicates. The selected variable name,
never its value, appears in diagnostics.

When TLS is required, the client rejects URL modes that disable verification,
removes accepted integration SSL hints before `pg` parses them, and supplies
`rejectUnauthorized: true` directly to the pool. This prevents connection-string
parameters from weakening certificate and host verification.

Before local use, require the Desktop source file to exist with mode `0600` and
check only whether the two canonical names have non-empty values. Never copy the
source file into the repository.

## Pool and timeout policy

| Runtime | Endpoint | Max | Idle | Connect | Statement | Lock | Idle transaction | Transaction |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Vercel application | pooled | 1 | 1 s | 10 s | 15 s | 5 s | 15 s | 30 s |
| VPS application | pooled | 5 | 30 s | 10 s | 15 s | 5 s | 15 s | 30 s |
| Local application | pooled | 3 | 10 s | 10 s | 15 s | 5 s | 15 s | 30 s |
| Migration/backfill | direct | 1 | 1 s | 10 s | 120 s | 10 s | 60 s | 180 s |

Every transaction checks out one client, executes `BEGIN`, all statements,
`COMMIT` or `ROLLBACK`, and releases in `finally`. Transactions must not contain
Alpaca, market-data, other HTTP, sleeps, file I/O, scoring, or retry delays.

Retry only PostgreSQL serialization failure `40001`, deadlock `40P01`, or an
explicitly idempotent transient connection failure. Retries are bounded by
attempt count, exponential jitter, and a total deadline. Constraint,
validation, corruption, and application errors are not retryable.

## Explicit commands

```bash
npm run db:postgres:connectivity
npm run db:postgres:connectivity -- --mode=direct
npm run db:postgres:status
npm run db:postgres:migrate
npm run db:postgres:migrate
npm run db:postgres:verify
npm run test:postgres:integration
npm run db:postgres:control-plane:snapshot -- --source /path/to/source.db --destination /protected/snapshot-directory
npm run db:postgres:control-plane:backfill -- --snapshot /protected/snapshot-directory/source-snapshot.db
npm run db:postgres:control-plane:reconcile -- --snapshot /protected/snapshot-directory/source-snapshot.db
npm run db:postgres:control-plane:shadow -- --snapshot /protected/snapshot-directory/source-snapshot.db
npm run db:postgres:control-plane:status
npm run db:postgres:execution-state:backfill -- --snapshot /protected/snapshot-directory/source-snapshot.db
npm run db:postgres:execution-state:reconcile -- --snapshot /protected/snapshot-directory/source-snapshot.db
npm run db:postgres:execution-state:shadow -- --snapshot /protected/snapshot-directory/source-snapshot.db
npm run db:postgres:execution-state:status
```

Connectivity must report TLS enabled and a supported transaction timeout.
Migration uses the direct connection, a session advisory lock, one transaction
per version, and a checksum ledger. The second migration invocation must apply
nothing. Verification must report no pending version, no checksum mismatch, all
23 expected tables, all 59 named indexes, Release 3 columns and constraints,
and the scheduler fencing sequence. The integration test creates a uniquely
named isolated schema, applies the full migration twice, exercises concurrent
lease acquisition/takeover and stale-fence rejection, verifies its catalogs,
and removes only that test schema.

Application, timer, service, and health startup never run migrations. The
protected Vercel `GET /api/paper/database/health` endpoint performs one read-only
pooled connectivity query and requires the dashboard admin token.

## VPS secret installation

1. Record the current target owner and mode without displaying content.
2. Create a mode-`0600` local transfer fragment containing only the two
   canonical variables:
   `node scripts/manage-postgres-env.mjs extract --source <desktop-path> --target <new-temp-path>`.
3. Transfer the fragment over the existing SSH channel to a new mode-`0600`
   temporary VPS path. Do not pass values as command arguments.
4. Merge with an unused backup path:
   `sudo node scripts/manage-postgres-env.mjs merge --source <remote-temp> --target /opt/alpaca-investing/secrets/alpaca.env --backup <protected-backup-path>`.
5. Verify only name presence, target ownership/mode, backup mode `0400`, and
   paper/live-disabled flag names. Remove the temporary fragment.
6. Restart only `alpaca-dashboard-control.service`. Run pooled and direct
   redacted connectivity commands as the runtime user. Check journald for secret
   patterns without displaying matching lines.

Do not overwrite unrelated VPS variables. Do not copy Desktop values to Vercel;
the integration is the deployment source of truth.

## Authority and rollback

Schema presence does not grant authority. Control-plane authority requires its
backfill, reconciliation, shadow comparison, and fencing tests. Execution-state
authority requires the later financial reconciliation gate. Any unexplained
discrepancy leaves SQLite authoritative for that domain.

Before backfill, quiesce SQLite writers and create a timestamped snapshot with
`db:postgres:control-plane:snapshot`. The command uses SQLite online backup,
records the source checksum and table counts, runs integrity and foreign-key
checks, and changes only the copy to mode `0400`. Preserve the original.

Control-plane and execution-state backfill require migration version 2 and a clean schema
verification. It maps candidate lifecycle only from candidate-linked
`decision_snapshots` and `decision_lifecycle_events`; non-candidate decision
lifecycle belongs to Release 4. It is resumable, conflict-checking,
dependency-ordered, transactionally bounded, and non-destructive. Reconciliation
compares row counts, identifiers, decision linkage, lifecycle status/order,
idempotency and provenance, active research, candidates by run, active leases,
and checkpoints. Any unexplained discrepancy returns a non-zero status and
blocks authority.

The source mapper recognizes one bounded legacy case: `EXACT_LEGACY_REUSE`
with `decision_id = candidate.id`, no decision snapshot, and no duplicate
decision owner. That is the deterministic Phase 1B identity backfill, so the
candidate is migrated with its stored candidate status and no invented
lifecycle event. Historical `paper_review_artifact` entry lifecycle records
whose candidate row is absent are included in the deferred Release 4 count.
Other missing candidate snapshots, orphan lifecycle origins, duplicate
decisions, or non-canonical links remain blocking discrepancies.

Execution-state backfill validates the same sealed snapshot, uses bounded
insert-only batches under an advisory lock, and reconciles accounts, snapshots,
positions, order intents, orders, broker events, reservations, allocations,
exposure, risk limits, execution evidence, and lifecycle fingerprints. A durable
passed checkpoint, zero unexplained discrepancies, zero duplicates/orphans, and
an idempotent zero-mutation replay are required before execution-state authority.
The backfill reuses semantically equivalent existing rows for
`(account_id, snapshot_fingerprint)` and `(account_id, idempotency_key)` identity
conflicts, remapping dependent foreign keys and failing closed on material
mismatches. Reconciliation explicitly records mutable-state differences and
PostgreSQL-only rows newer than the sealed snapshot; those classifications do
not erase or mutate PostgreSQL authority rows.

For `accounts`, the stable primary key identifies the broker account while the
row itself is a mutable current-state head. Reuse at that primary key requires
exact agreement on immutable fields and a PostgreSQL row that is monotonic over
the sealed source by both `version` and `updated_at`. Equivalent integer
representations of `version` compare canonically. A stale target, an immutable
difference, or a mutable difference whose ordering cannot be proved is a
sanitized fail-closed conflict. This rule does not weaken the
`account_snapshots` fingerprint identity or collapse distinct observations.

Use this progression after schema and backfill validation:

1. Keep all PostgreSQL feature flags off while migration version 2 is applied
   twice and verified.
2. Enable reads, writes, and shadow comparison with SQLite still authoritative;
   run overlapping paper-only workflows and require zero unexplained
   discrepancies.
3. Set `DATABASE_BACKEND=postgres` and enable control-plane authority only
   after reconciliation and shadow gates pass. Keep execution-state authority
   false.
4. Enable scheduler authority only after acquisition, heartbeat, release,
   expiry recovery, monotonic fencing, and stale-write rejection pass for every
   approved workstream. All 14 production timers resolve to a fenced workstream;
   a mutating timer may not bypass that boundary.
5. Run execution-state backfill and reconciliation, then enable execution-state
   shadow comparison while SQLite remains authoritative. Any discrepancy blocks
   further authority expansion.
6. Enable execution-state authority only after the durable checkpoint and
   overlapping paper-workflow gates pass. Disable authoritative concurrent
   SQLite writes and retain SQLite only for approved audit, append-only, derived,
   cache, diagnostic, or transient roles.

In authority mode, PostgreSQL failures never fall back to SQLite. Roll back
application flags/code while leaving additive schema version 2 in place; do
not drop tables or delete the original SQLite database.

### Market-observatory residual store

Market-observatory snapshots and ingestion diagnostics remain non-authoritative,
derived SQLite data. When control-plane or scheduler authority is enabled, the
paper-monitor runner isolates the observatory child in
`MARKET_OBSERVATORY_DB_PATH` (default `data/market-observatory.db`) so it never
writes the shared operational SQLite database. Feature reads use the same
isolated store.

Create or migrate this store explicitly before enabling scheduler authority by
running the existing `db:migrate` command with `RESEARCH_DB_PATH` set to the
observatory path. The timer must not create or migrate the store at runtime.
