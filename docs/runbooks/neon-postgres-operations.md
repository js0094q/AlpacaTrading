# PostgreSQL-only runtime operations

## Scope and safety

PostgreSQL is the sole production runtime authority. This runbook does not
authorize broker mutation, paper order submission, live trading, strategy
changes, risk-limit changes, or execution-cap changes. Never display database
URLs, credentials, tokens, or the protected environment file.

Historical SQLite migration, backfill, reconciliation, shadow comparison,
dual-write, and fallback workflows are retired. Do not run or recreate them.

## Required authority configuration

```text
DATABASE_BACKEND=postgres
POSTGRES_READS_ENABLED=true
POSTGRES_WRITES_ENABLED=true
POSTGRES_SHADOW_COMPARE_ENABLED=false
POSTGRES_CONTROL_PLANE_AUTHORITY_ENABLED=true
POSTGRES_SCHEDULER_AUTHORITY_ENABLED=true
POSTGRES_EXECUTION_STATE_SHADOW_ENABLED=false
POSTGRES_EXECUTION_STATE_AUTHORITY_ENABLED=true
SQLITE_AUDIT_MIRROR_ENABLED=false
AUTONOMOUS_RUNTIME_AUDIT_APPROVED=false
```

Production application startup rejects any other combination. A missing pooled
connection or failed PostgreSQL query is terminal; no SQLite fallback exists.

## Connections and timeouts

- `DATABASE_URL`: pooled endpoint for ordinary application traffic.
- `DATABASE_URL_UNPOOLED`: direct endpoint for explicit schema migration.

The selected variable name, never its value, may appear in diagnostics. TLS
certificate and host verification must remain enabled.

Every transaction checks out one client, executes `BEGIN`, all statements, and
`COMMIT` or `ROLLBACK`, then releases in `finally`. Do not perform Alpaca,
market-data, other HTTP, sleeps, file I/O, or scoring inside a transaction.

## Supported commands

```bash
npm run db:postgres:connectivity
npm run db:postgres:connectivity -- --mode=direct
npm run db:postgres:status
npm run db:postgres:migrate
npm run db:postgres:verify
npm run db:postgres:authority:cutover
npm run db:postgres:authority:status
```

Application, service, timer, and health startup never run schema migrations.
`db:postgres:migrate` uses the direct endpoint and a session advisory lock.
`db:postgres:verify` must report the expected migration checksum, 23 tables, 59
indexes, required constraints, and scheduler fencing sequence.

## Pre-cutover preservation

1. Record the local and VPS branch, exact commit, and clean/dirty state.
2. Stop dashboard-control, the autonomous worker, and all paper/autonomous
   timers. Record their state before changing units.
3. Confirm no migration, backfill, reconciliation, research, or application
   process is active.
4. Confirm no application SQLite file is open. An unrelated system SQLite file,
   such as fail2ban state, is outside this application boundary.
5. Do not delete or modify old SQLite files.
6. Back up the protected environment file without printing its contents and
   preserve ownership/mode.

## Fresh current-state cutover

Run pooled connectivity and schema verification first. Then run:

```bash
npm run db:postgres:authority:cutover
npm run db:postgres:authority:status
```

The cutover obtains a fenced PostgreSQL scheduler lease, reads the Alpaca paper
account, and synchronizes current account, position, and open-order truth. It
requires existing risk-limit and strategy-allocation configuration fingerprints
to match the current captured configuration before it makes changes.

Only these stale PostgreSQL lifecycle transitions are supported during cutover:

- expired active reservations become expired;
- expired current reviews and confirmations become expired;
- stale running research becomes recovered with explicit recovery evidence.

The command verifies current account/snapshot; exact position identity,
quantity, available quantity, entry/current price, market value, cost basis,
and unrealized P/L; exact open/pending order identity and terms; active
reservations; allocations; risk limits; one-to-one current review/confirmation
evidence; complete learning state; required recovery state; retryable failures;
and held leases. Any policy drift, missing required state, broker discrepancy,
or unclassified condition rolls back and fails closed.

A fenced `running` checkpoint is written before broker capture. Stale-state
cleanup, broker-state projection, validation, and the `passed` transition then
run in one serializable transaction. A validation error rolls that transaction
back and terminalizes the checkpoint as sanitized `blocked` evidence.

On success it writes a checkpoint with:

- source `alpaca_paper_current_state`;
- target `postgres_only_runtime_authority`;
- baseline type `fresh_postgresql_authority_cutover`;
- `historicalReconciliationComplete=false`;
- `historicalReconciliationAttempted=false`;
- `brokerMutationAttempted=false` and `ordersSubmitted=0`.

Never relabel an older historical checkpoint as passed.

## Service startup

Install the exact validated dashboard-control unit, reload systemd, and start
only `alpaca-dashboard-control.service`. Verify its authenticated local health,
status, account, positions, orders, and summary routes.

Keep the autonomous worker and every trading/research timer stopped and disabled.
`AUTONOMOUS_RUNTIME_AUDIT_APPROVED=false` is a mandatory fail-closed gate until
the separate evidence-utilization and runtime audit is complete.

## Post-deploy verification

- VPS checkout is clean and equals the validated commit.
- Paper mode is enabled.
- `ALPACA_LIVE_TRADE=false` and `LIVE_TRADING_ENABLED=false`.
- Full PostgreSQL authority flags match the required configuration.
- Pooled connectivity remains stable across repeated checks.
- The fresh authority checkpoint is passed and current.
- Dashboard-control is active and local-only.
- Autonomous worker and paper/autonomous timers are stopped.
- No application process has an SQLite file open.
- No migration, backfill, or historical reconciliation process is active.
- Alpaca open-order count and `ordersSubmitted` remain unchanged by cutover.

## Failure behavior

Stop on any failed gate. Do not re-enable SQLite, weaken an authority flag,
change policy, edit database rows manually, alter broker state, or fabricate a
checkpoint. Preserve the exact failure evidence for diagnosis.

Old SQLite files may be deleted only under a separately authorized operation
after proving that no process has them open and no supported runtime path
references them. Deletion is not part of this cutover.
