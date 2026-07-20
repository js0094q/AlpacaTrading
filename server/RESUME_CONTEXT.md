# Server Resume Context: PostgreSQL-Only Runtime

Date: 2026-07-20

The VPS must run the exact validated cutover commit with PostgreSQL as its sole
runtime authority. Do not run any SQLite migration, backfill, reconciliation,
shadow, mirror, fallback, or historical import command.

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
7. Install the checked-in dashboard-control unit, daemon-reload, and start
   `alpaca-dashboard-control.service`.
8. Validate `/api/v1/health`, `/api/v1/postgres-authority/status`, and
   `/api/v1/summary` locally.
9. Confirm the checkout is clean, the deployed SHA is exact, PostgreSQL is
   reachable, no application process has a SQLite file open, all timers remain
   disabled, and the autonomous worker is inactive/disabled.

Do not delete old SQLite files during this cutover. Deletion requires a later,
separate confirmation that no process has them open and no supported runtime
path references them.

Next action: evidence-utilization and runtime audit before autonomous paper
trading is restored.
