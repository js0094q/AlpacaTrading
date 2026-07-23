# PostgreSQL-only authority cutover

## Goal

Make PostgreSQL the sole runtime authority for the paper-trading system and
retire every enabled SQLite runtime, fallback, dual-write, shadow, migration,
backfill, and reconciliation path.

## Verified current state

- The preserved primary checkout is dirty and remains untouched. This work is
  isolated from the clean deployed VPS SHA
  `68228ea1c9a1efbe10c4b2ba415a8067c1ec6677`.
- The VPS checkout is clean. Dashboard-control and the autonomous worker are
  inactive. All Alpaca and paper-ops timers are disabled.
- No migration, backfill, reconciliation, research, paper, Node, or tsx
  application process is active. No application SQLite file is open.
- PostgreSQL migration versions 1 and 2 verify with 23 tables, 59 indexes, and
  the scheduler fencing sequence. Pooled TLS connectivity succeeds.
- The Alpaca paper account is active and live trading is disabled. Alpaca has
  24 current positions and zero open orders. PostgreSQL has the same 24
  position identities and quantities and zero open orders, but its latest
  account/position observation is from 2026-07-17.
- PostgreSQL has zero active non-expired buying-power reservations, one active
  strategy allocation, one active portfolio risk-limit row, current execution
  evidence history, and learning adjustments on all migrated candidates.
- One PostgreSQL research run is stale in `running`. Sixty expired execution
  reviews and sixty expired confirmations remain marked active. These are the
  only proved stale current-state classifications before implementation.
- The historical SQLite reconciliation checkpoint remains blocked. It is not a
  prerequisite for this cutover and must not be relabeled as passed.

## Required behavior

1. Application database configuration requires PostgreSQL reads, writes,
   control-plane authority, scheduler authority, and execution-state authority.
   Shadow comparison, execution-state shadowing, and the SQLite audit mirror
   are rejected.
2. PostgreSQL unavailability fails closed. Runtime commands do not open,
   create, migrate, read, or write a SQLite database.
3. Legacy SQLite-backed CLI and dashboard-control actions fail closed with a
   stable PostgreSQL-only retirement code. Maintenance-only SQLite modules may
   remain testable but are not exposed as production package scripts or
   runtime actions.
4. A supported `db:postgres:authority:cutover` workflow reads current Alpaca
   paper account, position, and open-order state; refreshes PostgreSQL through
   the existing fenced execution-state repository; compares exact open-order
   broker/client identity, symbol, asset class, side, type, time-in-force,
   status, quantity/notional, and limit terms; and performs no broker mutation.
5. The same workflow may terminalize only rows proved stale by their existing
   timestamps and lifecycle contracts:
   - expired active reservations become `expired`;
   - expired created/valid reviews and confirmations become `expired`;
   - stale running research becomes `recovered` with
     `WORKER_TERMINATED_OR_HEARTBEAT_EXPIRED` and cutover recovery provenance.
6. Current-state comparison covers account identity/state, current position
   identity, quantity, available quantity, entry/current price, market value,
   cost basis, and unrealized P/L; exact open/pending orders; active reservations,
   strategy allocations, risk limits, current reviews and confirmation
   evidence with one-to-one linkage, complete candidate learning adjustments,
   required recovered research state, scheduler leases, and retryable
   workstream failures.
7. A durable checkpoint uses workstream `postgres_authority_cutover`, source
   `alpaca_paper_current_state`, and target
   `postgres_only_runtime_authority`. Its evidence labels the checkpoint a
   fresh authority cutover and sets `historicalSqliteReconciliation=false`.
8. Dashboard-control starts with PostgreSQL-only health/summary surfaces.
   SQLite-backed research, learning, review, hedge, execution, and 0DTE actions
   remain blocked pending the evidence-utilization and runtime audit.
9. The autonomous worker and all legacy timers remain stopped and disabled.

## Non-goals

- Importing, comparing, repairing, deleting, or reconciling additional SQLite
  history.
- Changing strategy logic, risk limits, execution caps, or broker state.
- Submitting, replacing, canceling, or closing paper or live orders.
- Enabling live trading or restoring autonomous paper execution.
- Claiming the historical SQLite reconciliation completed.

## Failure behavior

- Missing PostgreSQL configuration, unavailable PostgreSQL, an authority flag
  disabled, a shadow/mirror flag enabled, incomplete broker evidence, broker to
  PostgreSQL current-state mismatch, missing allocation/risk/evidence state,
  an order-reconciliation error, a stale lease, or a retryable recovery failure
  blocks the baseline.
- A blocked current-state checkpoint is durable and sanitized. It does not
  weaken execution or risk controls and does not fall back to SQLite.
- The workflow creates a fenced `running` checkpoint before broker capture.
  Cleanup, projection, current-state validation, and the `passed` transition
  share one serializable transaction. Validation failure rolls that transaction
  back before the checkpoint is terminalized as `blocked`.

## Acceptance criteria

- Focused PostgreSQL-only tests prove production configuration and legacy
  runtime entry points fail closed and no enabled production script requires a
  SQLite path.
- Release 4, full `npm test`, `npm run typecheck`, `npm run build`, and
  `git diff --check` pass.
- Independent review finds no unresolved critical or important issue involving
  hidden SQLite access, fallback, missing current state, or weakened safety.
- The exact validated commit is deployed to a clean VPS checkout.
- PostgreSQL connectivity is stable; the current broker/DB comparison passes;
  a fresh PostgreSQL authority checkpoint is `passed`; dashboard-control is
  active; autonomous worker and legacy timers are inactive/disabled; paper mode
  is enabled; both live flags are false; and orders submitted equals zero.

## Validation plan

1. Run focused configuration, runtime-retirement, cutover, scheduler, and
   execution-state tests.
2. Run Release 4, full tests, typecheck, build, and diff checks locally.
3. Run independent diff review against the deployed base SHA.
4. Deploy the exact commit with services stopped and update only the protected
   non-secret database authority flags.
5. Run schema/connectivity checks, the supported cutover workflow, its status
   readback, dashboard-control health, service/timer/process checks, and an
   application SQLite open-file check.

## Deployment authorization and boundaries

The user authorized commit and exact-SHA VPS deployment for this cutover. The
deployment may update PostgreSQL authority/shadow/mirror flags, disable legacy
timers and the autonomous worker, and start dashboard-control. It does not
authorize broker mutation, order submission, live trading, risk/cap changes,
SQLite deletion, Vercel deployment, or autonomous-worker restoration.
