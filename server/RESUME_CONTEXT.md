# Server Resume Context: PostgreSQL-Only Runtime

Date: 2026-07-24

The VPS must run the exact validated cutover commit with PostgreSQL as its sole
runtime authority. Do not run any SQLite migration, backfill, reconciliation,
shadow, mirror, fallback, or historical import command.

The repository worker uses paper exploration V3 and narrowly classifies
`NO_ELIGIBLE_POSTGRES_CANDIDATES`, `NO_POSTGRES_EXIT_TRIGGER`, and
`NO_READY_POSTGRES_ORDER_INTENTS`, plus the learning result
`NO_RECONCILIABLE_POSTGRES_ORDERS`, as successful `WORKSTREAM_NO_ACTION`
outcomes. Require the checked-in unit's paper/live-off assertions, unchanged
liquidity/spread/notional gates, and all PostgreSQL/reconciliation controls.

## Deployment sequence

1. Confirm the checkout is clean and record the pre-deploy SHA.
2. Stop and disable the autonomous worker and every paper workflow timer.
3. Install the exact validated commit.
4. Merge only the non-secret PostgreSQL authority and paper/live-off flags from
   the root `RESUME_CONTEXT.md` into
   `/opt/alpaca-investing/secrets/alpaca.env`; preserve secrets, ownership, and
   mode without printing values.
5. Run pooled connectivity and PostgreSQL schema verification.
6. Run `npm run db:postgres:authority:cutover` once. Require a passed fresh
   baseline with `historicalSqliteReconciliation=false` and zero submitted
   orders.
7. Run one current `research:daily` refresh and verify genuine PostgreSQL market
   bars, stock/option snapshots, features, targets, and research evidence.
8. Run `zero-dte:reconcile` against the Alpaca paper account; retain unresolved
   ambiguous submissions for later resolution.
9. Install the checked-in dashboard-control and autonomous-worker units,
   daemon-reload, and start
   `alpaca-dashboard-control.service`.
10. Validate `/api/v1/health`, `/api/v1/postgres-authority/status`, and
   `/api/v1/summary` locally.
11. Enable and start `alpaca-autonomous-paper.service`; keep every legacy timer
    disabled and require one persisted `cycle_completed` event.
12. Confirm the checkout is clean, the deployed SHA is exact, PostgreSQL is
    reachable, no application process has a SQLite file open, dashboard-control
    is healthy, and paper/live-off safety flags remain exact.
13. Exercise one controlled service stop during an active workstream. Require
    the workstream process group to exit before `worker_stopped`, its domain
    lifecycle row to be terminal, its scheduler lease to be released, and the
    following restart to acquire the lease without preflight recovery. Confirm
    the scheduler abort cancelled any in-flight SIP/OPRA request and the worker
    remained inside the unit's 30-second stop timeout.

Do not delete old SQLite files during this cutover. Deletion requires a later,
separate confirmation that no process has them open and no supported runtime
path references them.

Next action: deploy the exact validated worker-restoration commit and collect
the runtime acceptance evidence above.
