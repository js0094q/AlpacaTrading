# Resume Context: PostgreSQL-Only Authority Cutover

Date: 2026-07-20

## Authority decision

PostgreSQL is the sole production runtime authority. Do not resume historical
SQLite migration, backfill, reconciliation, shadow comparison, dual-write,
fallback, or migration-gate work. SQLite is available only to isolated test
fixtures and historical implementation modules that are not packaged runtime
commands.

Required production settings:

- `DATABASE_BACKEND=postgres`
- `POSTGRES_READS_ENABLED=true`
- `POSTGRES_WRITES_ENABLED=true`
- `POSTGRES_CONTROL_PLANE_AUTHORITY_ENABLED=true`
- `POSTGRES_SCHEDULER_AUTHORITY_ENABLED=true`
- `POSTGRES_EXECUTION_STATE_AUTHORITY_ENABLED=true`
- `POSTGRES_SHADOW_COMPARE_ENABLED=false`
- `POSTGRES_EXECUTION_STATE_SHADOW_ENABLED=false`
- `SQLITE_AUDIT_MIRROR_ENABLED=false`
- `ALPACA_ENV=paper`
- `TRADING_MODE=paper`
- `ALPACA_LIVE_TRADE=false`
- `LIVE_TRADING_ENABLED=false`
- `AUTONOMOUS_RUNTIME_AUDIT_APPROVED=false`

Missing PostgreSQL authority or connectivity fails closed. Do not print
connection values or other secrets.

## Supported operations

```bash
npm run db:postgres:connectivity
npm run db:postgres:status
npm run db:postgres:verify
npm run db:postgres:authority:status
```

The one-time deployment workflow is
`npm run db:postgres:authority:cutover`. It reads fresh Alpaca paper account,
position, and open-order state; verifies existing risk/allocation policy
fingerprints; expires already-stale PostgreSQL reservations/reviews/evidence;
terminalizes abandoned research rows; projects current state; reconciles known
orders through read-only broker lookups; and writes a fresh authority baseline.
The baseline must say:

- `baselineType=fresh_postgresql_authority_cutover`
- `historicalSqliteReconciliation=false`
- `brokerMutationAttempted=false`
- `ordersSubmitted=0`

Do not relabel or overwrite earlier blocked historical reconciliation
checkpoints.

## Runtime state after deployment

- Start and validate `alpaca-dashboard-control.service` on `127.0.0.1:4100`.
- Keep `alpaca-autonomous-paper.service` stopped and disabled.
- Keep all paper execution/review/research/observatory/0DTE timers disabled.
- Dashboard reads require the PostgreSQL-backed VPS bridge and return `503`
  when PostgreSQL or the passed authority baseline is unavailable.
- Dashboard mutations return `POSTGRES_ONLY_RUNTIME_PATH_DISABLED`.
- Do not submit paper or live orders.

## Next action

Perform the evidence-utilization and runtime audit before restoring any
autonomous paper-trading workflow.
