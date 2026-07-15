# Neon Operational State Migration

Date: 2026-07-15
Status: Approved for staged implementation

## Goal

Move concurrent operational state from the shared SQLite database to Neon PostgreSQL while preserving the existing paper-only execution safety floor. SQLite may remain only for append-only, derived, cache, diagnostic, or transient data.

## Verified Starting Point

- Isolated branch: `codex/neon-postgres-operational-state`
- Verified implementation source, GitHub main, and VPS commit:
  `8cc9fe8431e3676b96a3a904a1256d4aa2dcf21b`
- Vercel project: `alpaca-dashboard-paper`
- Verified Vercel production deployment: `dpl_BYnG8j2RGBkgTNsfUgCd7KBxw2Ns`
- VPS runtime environment file: `/opt/alpaca-investing/secrets/alpaca.env`
- Local Neon environment file: `/Users/josephstewart/Desktop/neon.env`
- The local Neon file was changed from mode `0644` to `0600` before use.
- Canonical pooled and direct variables are present. Values are secret and must never be emitted.

The approved baseline `d30435ed18cf3f95480e1b17d3f5d6b84eb987a7`
advanced through merged PR 28 before implementation. The isolated branch was
rebased onto the reverified `8cc9fe8` GitHub/Vercel/VPS baseline before Release
1 changes were applied.

All SHAs, deployment identifiers, environment scopes, and connection availability must be reverified at the stage that relies on them.

## Architectural Decision

Neon PostgreSQL owns state that requires concurrent access, transactional consistency, distributed scheduler ownership, or cross-workstream coordination. Local SQLite stores may retain only non-authoritative data. Workstreams synchronize through immutable, idempotent events; independently mutable trading databases are never merged.

Application services use domain repositories. PostgreSQL-specific repositories may use row locks, advisory locks, conditional writes, fencing tokens, optimistic versions, and other PostgreSQL-native guarantees. Transactions use one checked-out `pg` client from `BEGIN` through `COMMIT` or `ROLLBACK`.

## Scope

### Release 1: inventory and transition stabilization

- Classify every existing SQLite table.
- Map every SQLite writer, transaction, migration call, runtime DDL path, and scheduled owner.
- Test WAL against a copied VPS database on the deployment filesystem before changing journal mode.
- Add bounded, operation-aware handling for `SQLITE_BUSY` and `SQLITE_LOCKED`.
- Isolate schema mutation behind explicit migration commands.
- Add secret-redaction tests.
- Record the durable database decision and cutover procedure.

### Release 2: PostgreSQL foundation

- Add `pg`, typed configuration, pooled application access, and direct migration access.
- Add explicit connectivity, migrate, status, and verify commands.
- Create versioned PostgreSQL schema migrations.
- Add domain repository boundaries and transaction/retry helpers.
- Define Vercel and VPS pool and timeout policy.
- Test configuration, redaction, migration idempotency, rollback, and connectivity behavior.

### Release 3: control-plane authority

- Migrate scheduler leases with fencing.
- Migrate research-run control state, candidates and lifecycle events, idempotency records, workstream events and failures, and reconciliation checkpoints.
- Provide resumable backfill, reconciliation, paper-only shadow comparison, discrepancy reports, and feature-flagged authority.
- Do not expand authority while any unexplained discrepancy remains.

### Release 4: execution-state authority

- Migrate accounts, snapshots, positions, order intents, orders, broker events, reservations, allocations, exposure, risk limits, reviews, confirmation evidence, and lifecycle fingerprints.
- Keep every Alpaca or market-data request outside database transactions.
- Make reservation and allocation decisions atomic across strategies.
- Persist deterministic order intents before broker submission and broker responses afterward.
- Resolve ambiguous submissions by deterministic client order ID before resubmission.
- Cut off authoritative SQLite writes after reconciliation and preserve SQLite read-only or as an explicitly bounded audit mirror.

## Non-Goals

- Enabling live trading.
- Weakening paper-review, confirmation, freshness, allocation, or kill-switch gates.
- Asynchronously merging mutable operational databases.
- Deleting or overwriting the source SQLite database.
- Indefinite dual authority.
- Copying Desktop credentials into source control, documentation, logs, fixtures, screenshots, or reports.

## Configuration Contract

Configuration names follow current repository conventions and are validated at startup. The intended controls are:

- database backend
- PostgreSQL reads enabled
- PostgreSQL writes enabled
- shadow comparison enabled
- control-plane authority enabled
- execution-state authority enabled
- SQLite audit mirror enabled

Defaults retain SQLite authority and existing paper-only behavior until each cutover gate passes. Startup diagnostics may report backend and feature-state names but never connection values.

The pooled URL is selected from the actual pooled integration variables, preferring the established canonical name. The direct URL is selected from the actual unpooled variables for migrations and controlled backfill. Missing-variable errors name only the missing key and never include a URL.

## Transaction Rules

- A transaction acquires one client, begins on that client, executes all statements on that client, commits or rolls back, and releases in `finally`.
- No transaction contains Alpaca calls, market-data calls, file operations, sleeps, retry delays, feature computation, scoring, or large loops.
- PostgreSQL retries are bounded and limited to idempotent serialization failures, deadlocks, and safe transient connection failures.
- SQLite retries are bounded and limited to explicitly retry-safe operations that fail with `SQLITE_BUSY` or `SQLITE_LOCKED`.
- Final causal errors are rethrown with sanitized structured context.

## Data Migration Contract

Before each backfill:

1. Create a timestamped, read-only SQLite snapshot without altering the source.
2. Record its checksum and table counts.
3. Run SQLite integrity and foreign-key checks.
4. Verify the PostgreSQL migration version.
5. Verify that no uncontrolled schema migration is running.

Backfill is resumable, idempotent, dependency-ordered, transactionally bounded, and observable. Each table mapping defines identifier, timestamp, null, duplicate, and foreign-key behavior.

## Reconciliation Gates

Control-plane authority requires exact or explained agreement for row counts, identifiers, lifecycle status counts, active research runs, candidates by run, lifecycle ordering, idempotency records, scheduler lease state, and reconciliation checkpoints.

Execution-state authority additionally requires agreement for account snapshots, positions, open orders, order intents, broker IDs, client order IDs, active reservations, allocation totals, cash reserve, deployment exposure, reviews, confirmation evidence, fingerprints, duplicate checks, and orphan checks.

Any unexplained discrepancy blocks authority expansion.

## Deployment Boundaries

- Vercel integration variables remain the deployment source of truth. Existing values are not duplicated or overwritten without evidence.
- The VPS receives required variables through its protected environment file using an atomic, backup-first update that preserves ownership, mode, and unrelated values.
- Only affected services are restarted.
- Deployments remain paper-only and live execution remains disabled.
- Each deployed stage verifies exact GitHub, Vercel, and VPS SHAs before runtime validation.

## Validation

Run the smallest focused tests during implementation and the applicable release gate before merge:

- `npm test`
- `npm run test:zero-dte`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm run dashboard:build`
- `git diff --check`
- PostgreSQL migration twice
- PostgreSQL schema verification
- SQLite integrity and foreign-key checks
- backfill reconciliation
- concurrent workflow tests
- secret-redaction tests

Final production validation uses overlapping paper workflows only. It must not force an order. Naturally occurring paper execution remains subject to existing reviewed and confirmed safeguards.

## Acceptance Criteria

The migration is complete only after PostgreSQL is authoritative for every approved operational domain, both cutovers reconcile, uncontrolled authoritative SQLite writes stop, scheduler leases fence stale workers, reservations are atomic, no transaction spans a broker call, duplicate delivery is idempotent, overlapping paper workflows complete without SQLite lock failures, no credentials leak, no environment file is committed, and exact deployed SHAs are verified with live trading disabled.
