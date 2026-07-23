# ADR-010: PostgreSQL is the sole runtime authority

## Status

Accepted 2026-07-15; amended and made final 2026-07-20.

The 2026-07-20 amendment ends the staged SQLite migration. Historical SQLite
reconciliation is not a prerequisite for current paper runtime authority and
will not continue.

## Context

The earlier staged design used SQLite snapshots, backfill, shadow comparison,
and feature flags to move operational domains incrementally into Neon
PostgreSQL. The semantic snapshot-identity repair was deployed, but the
historical execution-state backfill remained blocked on conflicting historical
risk-limit state. Current PostgreSQL state and current Alpaca paper state can be
validated directly without inventing or importing additional history.

Keeping SQLite migration, fallback, shadow, and dual-write paths after deciding
that PostgreSQL owns current runtime state would create competing authority and
an unsafe startup dependency on an abandoned historical reconciliation.

## Decision

PostgreSQL is the only production runtime database. It owns scheduler leases,
research control, candidates and lifecycle events, accounts and snapshots,
positions, order intents and orders, broker events, reservations, strategy
allocations, exposure, risk limits, reviews and confirmation evidence,
learning/recovery state, idempotency, workstream events, and current authority
checkpoints.

Production requires the full PostgreSQL authority flag set and a working pooled
connection. It fails closed if PostgreSQL is unavailable or if any SQLite
shadow, fallback, audit-mirror, or partial-authority configuration is enabled.
Production code may not open SQLite. Explicit isolated test fixtures may retain
SQLite solely to verify legacy logic while it is removed.

The cutover is established from current broker truth:

- Alpaca paper is read for the current account, positions, and open orders;
- installed allocation and risk-policy fingerprints must match before state is
  synchronized;
- only stale/invalid PostgreSQL lifecycle state is closed through supported
  repository transitions;
- a new `fresh_postgresql_authority_cutover` checkpoint records the verified
  current baseline and explicitly states that historical reconciliation is
  incomplete and was not attempted;
- historical reconciliation checkpoints are preserved as immutable evidence
  but never grant or block current authority.

The cutover must not submit, replace, or cancel paper or live orders. It must not
change strategy logic, risk limits, execution caps, or broker state.

Dashboard-control is read-only and starts only after a passed current
PostgreSQL authority checkpoint. All autonomous and trading workers remain
stopped until a separate evidence-utilization and runtime audit is approved.

## Connection and transaction policy

- Pooled PostgreSQL connections serve ordinary VPS and Vercel application
  traffic.
- Direct/unpooled connections serve explicit schema migration only.
- One checked-out `pg` client owns each transaction from `BEGIN` through
  completion.
- Scheduler mutations require a current fencing token in the same transaction.
- No transaction spans broker or market-data I/O.
- Secret values never appear in logs, errors, tests, documentation, or reports.

## Alternatives considered

- Continue historical SQLite reconciliation: rejected because it does not
  improve current broker correctness and perpetuates the abandoned authority
  dependency.
- Keep SQLite as a read fallback or audit mirror: rejected because an outage or
  partial write could silently revive stale authority.
- Indefinite dual writes: rejected because partial divergence cannot be made
  safe for capital and execution state.
- Manually fabricate a historical-complete checkpoint: rejected because it
  would misrepresent provenance and weaken the authority gate.

## Consequences

Runtime availability now depends on PostgreSQL and its fenced repository
contracts. A PostgreSQL outage stops the application instead of degrading to
local state. Historical SQLite artifacts may remain offline until a separately
authorized deletion confirms that no process has them open and no supported
runtime path references them.

The fresh authority checkpoint proves current runtime readiness, not historical
parity. Future reviews must evaluate PostgreSQL state and broker evidence
directly.

## Validation

Acceptance requires focused PostgreSQL-only tests, Release 4 tests, the full
test suite, typecheck, build, independent review, exact commit deployment, a
clean VPS checkout, stable PostgreSQL connectivity, paper mode with both live
flags off, no active SQLite access, a passed fresh checkpoint, read-only
dashboard-control health, autonomous worker stopped, and zero submitted orders.

## Conditions for reconsideration

Changing the sole-authority design requires a new ADR and explicit safety
review. A PostgreSQL availability issue does not authorize SQLite fallback or
dual authority.
