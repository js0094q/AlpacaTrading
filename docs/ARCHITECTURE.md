# Architecture

## Runtime authority

PostgreSQL is the sole production runtime authority. The VPS application,
dashboard-control service, scheduler fencing, and execution-state repositories
use the pooled PostgreSQL connection. PostgreSQL schema changes use the direct
connection and the explicit migration command.

Production startup requires all of these conditions:

- `DATABASE_BACKEND=postgres`;
- PostgreSQL reads and writes enabled;
- control-plane, scheduler, and execution-state authority enabled;
- both PostgreSQL shadow modes disabled;
- the SQLite audit mirror disabled;
- a pooled PostgreSQL connection available.

Failure of any condition is terminal. There is no SQLite read, write, fallback,
dual-write, shadow, migration, or reconciliation path in production. SQLite is
available only to explicitly marked isolated test fixtures. Old SQLite files are
historical artifacts and must not be opened by supported runtime commands.

## Runtime topology

- The VPS owns the paper-only Alpaca credentials, PostgreSQL application pool,
  scheduler leases, current operational state, and dashboard-control service.
- Neon PostgreSQL owns accounts, snapshots, positions, orders, broker events,
  reservations, strategy allocations, risk limits, reviews, confirmation
  evidence, learning/recovery state, and scheduler/workstream state.
- Alpaca paper remains broker truth for the current account, positions, and
  orders. PostgreSQL records the exact current observation and internal
  attribution; it never overrides broker state.
- Vercel is a read-only bridge to dashboard-control. It owns no local database,
  does not fall back to bundled state, and cannot execute broker mutations.
- `alpaca-dashboard-control.service` is the only application service enabled by
  the fresh cutover. Autonomous and trading timers remain disabled until the
  separately authorized evidence-utilization and runtime audit passes.

## Fresh authority cutover

`npm run db:postgres:authority:cutover` is the supported one-time operational
cutover workflow. It is paper-only and broker-read-only. Under a fenced
PostgreSQL scheduler lease it:

1. captures current Alpaca paper account, position, and open-order state;
2. verifies the installed risk-limit and allocation-policy fingerprints before
   changing runtime state;
3. synchronizes current broker truth into PostgreSQL;
4. expires only stale reservations, reviews, confirmations, and stale research
   runs through their supported PostgreSQL lifecycle transitions;
5. verifies required allocation, risk, evidence, learning, and recovery state;
6. writes a passed checkpoint with baseline type
   `fresh_postgresql_authority_cutover`.

The checkpoint explicitly records that historical reconciliation is not
complete and was not attempted. Existing historical SQLite reconciliation
checkpoints remain immutable historical evidence and do not gate startup.

`npm run db:postgres:authority:status` is the read-only gate used by
dashboard-control. A missing, failed, or stale baseline fails closed.

## State and transaction boundaries

Domain repositories preserve scheduler fencing, optimistic versions,
idempotency, event order, and one transaction scope. They do not expose a
generic backend-neutral interface.

Every PostgreSQL transaction uses one checked-out `pg` client from `BEGIN`
through `COMMIT` or `ROLLBACK`. Transactions must not span Alpaca, market-data,
or other network I/O. Broker evidence is collected first; bounded fenced
transactions then persist and verify it.

Scheduler acquisition and takeover use database time, row locks, expiration,
heartbeats, and monotonically increasing fencing tokens. A stale worker cannot
heartbeat, release, or commit fenced state after a newer owner takes over.

## Decision and execution identity

- Candidate ID: researched opportunity.
- Decision ID: immutable entry, exit, or non-executable decision.
- Position lifecycle ID: broker-confirmed analytical lifecycle.
- Alpaca: broker order and net-position truth.
- PostgreSQL execution ledger: order-attempt and broker-response audit.
- Analytical lifecycle tables: attribution and longitudinal evidence.

Broker submission remains split into two database transactions around the
external paper request. The first validates evidence and commits an idempotent
intent/reservation; the second records the response. Ambiguous results reconcile
by deterministic client-order identity before any retry. The authority cutover
and status commands never submit, replace, or cancel orders.

## Trust and safety boundaries

All broker-mutating paths remain hard-bound to the paper endpoint and their
existing explicit confirmation, review, evidence, risk, and execution gates.
Neither the cutover nor dashboard-control exposes a mutating route.

`PAPER_REVIEW_SIGNING_KEY` authenticates general review artifacts and 0DTE
submit attestations. `HEDGE_REVIEW_SIGNING_KEY` remains independent. Secrets
exist only in the protected VPS environment file and are excluded from logs,
responses, provenance payloads, and repository files.

The safety floor does not redefine strategy weights, budgets, risk limits,
position caps, execution caps, or exit policy. The PostgreSQL-only cutover
verifies installed configuration fingerprints and stops on drift instead of
silently changing policy.

## Schema and operational commands

PostgreSQL schema mutation belongs only to `npm run db:postgres:migrate`, using
the direct connection and a session advisory lock. Application startup never
runs migrations. Supported production database commands are:

```bash
npm run db:postgres:connectivity
npm run db:postgres:status
npm run db:postgres:migrate
npm run db:postgres:verify
npm run db:postgres:authority:cutover
npm run db:postgres:authority:status
```

SQLite migration, backfill, reconciliation, shadow, and status commands are
retired and absent from the production package scripts.
