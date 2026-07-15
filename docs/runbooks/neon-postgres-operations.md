# Neon PostgreSQL operations

## Scope and safety

This runbook covers the staged Neon operational-state migration. It never
authorizes live trading or broker mutation. Vercel and VPS validation remains
paper-only. Do not print, copy into documentation, or commit connection values.
Do not source an environment file into diagnostic output.

Release 2 creates the schema and connection foundation only. SQLite remains
authoritative and these defaults stay in force:

```text
DATABASE_BACKEND=sqlite
POSTGRES_READS_ENABLED=false
POSTGRES_WRITES_ENABLED=false
POSTGRES_SHADOW_COMPARE_ENABLED=false
POSTGRES_CONTROL_PLANE_AUTHORITY_ENABLED=false
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
```

Connectivity must report TLS enabled and a supported transaction timeout.
Migration uses the direct connection, a session advisory lock, one transaction
per version, and a checksum ledger. The second migration invocation must apply
nothing. Verification must report no pending version, no checksum mismatch, all
22 expected tables, all 55 named indexes, and the scheduler fencing sequence.
The integration test creates a uniquely named isolated schema, applies the full
migration twice, verifies its catalogs, and removes only that test schema.

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

Before backfill, create a timestamped read-only SQLite snapshot, checksum it,
record counts, and run integrity and foreign-key checks. Backfill is resumable,
idempotent, bounded, and non-destructive. A failed Release 2 deployment rolls
application code back while leaving additive Neon schema version 1 in place;
do not drop tables or delete the original SQLite database.
