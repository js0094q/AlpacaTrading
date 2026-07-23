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
- `AUTONOMOUS_RUNTIME_AUDIT_APPROVED=true` (worker service only, after all gates pass)

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

Execution-state freshness safeguard: the projection boundary reads the current
Alpaca paper `/v2/positions` response directly, treats a successful empty array
as authoritative, and fails closed on failed or malformed position evidence.
No-intent paper state capture does not bypass the account/position refresh.

Do not relabel or overwrite earlier blocked historical reconciliation
checkpoints.

## Runtime state required after deployment

- Start and validate `alpaca-dashboard-control.service` on `127.0.0.1:4100`.
- Apply migration `003_market_data_authority.sql` and verify the PostgreSQL schema.
- Run a current SIP/OPRA research refresh and verify genuine PostgreSQL market
  bars, stock snapshots, option contracts/snapshots, features, targets, and
  research evidence.
- Reconcile PostgreSQL order state against the Alpaca paper account; unresolved
  ambiguous submissions must remain non-terminal for a later lookup.
- Install, enable, and start `alpaca-autonomous-paper.service`; require a
  persisted `cycle_completed` lifecycle event for one complete 16-workstream cycle.
- Require a `workstream_heartbeat` event every 30 seconds while a workstream is
  running. Each workstream must retain its own process group; timeout or worker
  shutdown sends `SIGTERM` to the group and escalates surviving descendants to
  `SIGKILL` after five seconds. `worker_stopping` and `workstream_timeout`
  events are operational telemetry only and do not relax any trading gate.
- Keep all paper execution/review/research/observatory/0DTE timers disabled.
- Dashboard reads and guarded paper actions require the PostgreSQL-backed VPS
  bridge and return `503` when PostgreSQL or the passed authority baseline is
  unavailable. The bridge includes PostgreSQL-backed research, review,
  portfolio-review, options-discovery, learning, dry-run, and reviewed paper
  execution routes; `GET /api/v1/zero-dte/summary` is PostgreSQL-backed.
- Dashboard health derives `autonomousWorker` from persisted PostgreSQL worker
  lifecycle events. A blocked strategy decision is a valid domain result and
  is not reported as infrastructure failure.
- Production worker, research, review, reconciliation, execution, and market-data
  imports must remain isolated from SQLite.
- Missing current option snapshots outside the option session and explicit
  market-session ineligibility do not weaken any execution-readiness gate.
  Stale OPRA rows are rejected before snapshot persistence, their provider
  timestamps/counts/reason are written to `market_data_ingestion_runs`, and
  current SIP-backed equity research continues with option data marked degraded.
- The 2026-07-23 autonomous paper exploration profile is configured in
  `alpaca-autonomous-paper.service`. Research persists every baseline/effective
  gate pair and all selected/rejected candidate reasons. Entry review uses a
  `$1,000` per-order exploration cap while retaining PostgreSQL risk limits,
  aggregate exposure, cash reserve, reservation, reconciliation, and duplicate
  gates. Candidate lifecycle reasons record review skips, capacity blocks,
  sizing, execution deferral/ambiguity, and successful paper submission.
- Repeated entry-review workstreams must skip an already persisted
  candidate/account-snapshot review identity rather than create a second review
  with the same client order ID.
- Keep `ALPACA_ENV=paper`, `TRADING_MODE=paper`, `ALPACA_LIVE_TRADE=false`, and
  `LIVE_TRADING_ENABLED=false`; no live order path is permitted.

## Next action

Deploy the exact validated worker-restoration commit and collect the runtime
evidence above without enabling any legacy timer.
