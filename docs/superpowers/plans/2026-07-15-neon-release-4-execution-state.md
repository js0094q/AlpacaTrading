# Release 4: Execution-State Migration and Final Cutover

> Begin only after PostgreSQL control-plane authority is reconciled and stable.

**Goal:** Make Neon PostgreSQL authoritative for all approved operational trading state and stop uncontrolled authoritative SQLite writes.

**Architecture:** Normalize account/order/reservation/allocation state in PostgreSQL. Reserve capital and create order intent atomically before external submission; persist the broker result in a second idempotent transaction. Reconciliation resolves ambiguity by deterministic client order ID.

**Tech stack:** TypeScript, `pg`, Neon PostgreSQL, Alpaca paper API under existing gates.

---

### Task 1: Execution-state repositories and mappings

Implement repositories and field mappings for accounts, snapshots, positions, order intents, orders, broker events, reservations, allocations, exposure, risk limits, reviews, confirmation evidence, and lifecycle fingerprints. Add constraints and indexes matching actual queries. Test mapping, duplicate handling, orphan prevention, and lifecycle preservation.

### Task 2: Atomic reservation and allocation

In one PostgreSQL transaction, acquire the account/portfolio lock; read account state, active reservations, open-order exposure, and positions; apply cash reserve, deployment, strategy, symbol, and position limits; enforce idempotency; insert the reservation; and commit. Test simultaneous strategies, exhausted buying power, duplicate keys, rollback, serialization/deadlock retries, and pool exhaustion.

### Task 3: Broker submission boundary

Transaction A validates reviewed candidate, confirmation evidence, fresh account/asset evidence, reservation ownership, order intent, lifecycle fingerprint, and reservation transition. Commit before the Alpaca paper request. Transaction B stores request ID, HTTP status, broker order ID, response timestamp, and classified errors idempotently. Reconciliation resolves ambiguous results by client order ID before any resubmission. Test timeout-after-intent and paper-only guards.

### Task 4: Execution backfill and reconciliation

Backfill execution state from a verified read-only snapshot. Reconcile account snapshots, positions, open orders, intents, broker/client IDs, reservations, allocation totals, cash reserve, exposure, reviews, confirmation evidence, fingerprints, duplicates, and orphans. Any unexplained difference blocks authority.

### Task 5: Authority cutover and SQLite retirement

Shadow compare in paper mode for a bounded window, then enable PostgreSQL execution writes and reads. Disable authoritative SQLite writes. Keep SQLite read-only or as an explicitly bounded audit mirror only. Verify no mutable dual authority remains and update architecture/runbooks/resume context.

### Task 6: Final production validation

Verify exact GitHub, Vercel, and VPS SHAs; paper/live-disabled state; connectivity; migrations; schema/indexes; pool health; leases; integrity; and no credential leakage. Run overlapping paper workflows for research, zero DTE, reconciliation, observatory, exit review, and paper exit using the approved research parameters. Do not force an order. Confirm no SQLite lock, duplicate event/order/reservation/lifecycle transition, PostgreSQL pool exhaustion, or transaction spanning an external call.

### Task 7: Commit and completion report

Commit the cutover as a focused release, update Basic Memory Cloud, and report exact SHAs, redacted variable names, clients/pools/timeouts, inventory/classifications, schema/migrations, backfill/reconciliation, tests, deploy steps, validation identifiers, retry/lock observations, secret safety, and live-disabled confirmation. Do not claim completion if any required runtime evidence is missing.
