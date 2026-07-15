# Release 2: PostgreSQL Foundation

> Begin only after Release 1 passes and is merged or otherwise accepted as the release base.

**Goal:** Add a safe PostgreSQL runtime, schema, explicit tooling, and repository boundary without moving production authority.

**Architecture:** `pg` provides bounded application pools and direct migration clients. Domain repositories preserve PostgreSQL transaction semantics. Defaults leave PostgreSQL reads, writes, and authority disabled.

**Tech stack:** TypeScript, `pg`, Neon PostgreSQL, Node test runner.

---

### Task 1: Typed, redacted database configuration

**Files:**
- Create: `src/lib/database/config.ts`
- Create: `src/lib/database/redaction.ts`
- Test: `tests/databaseConfig.test.ts`, `tests/databaseRedaction.test.ts`
- Update: `.env.example`, `README.md`

Test and implement backend/feature-flag validation, pooled/direct variable selection, safe defaults, timeout and pool settings, missing-key errors, and startup diagnostics that never expose connection values.

### Task 2: PostgreSQL clients, transactions, and retries

**Files:**
- Create: `src/lib/database/postgres.ts`
- Create: `src/lib/database/postgresTransaction.ts`
- Create: `src/lib/database/postgresRetry.ts`
- Test: `tests/postgresTransaction.test.ts`, `tests/postgresRetry.test.ts`

Implement separate application pool and direct migration access, one-client transactions, rollback/release guarantees, statement/lock/idle/connection/transaction timeouts, and bounded idempotent retry classification for serialization, deadlock, and safe transient connection failures.

### Task 3: Versioned schema and explicit migration tooling

**Files:**
- Create: `src/lib/database/postgresMigrations.ts`
- Create: `src/lib/database/migrations/001_initial_operational_state.sql`
- Create: `scripts/postgres-database.mjs` or repository-conventional TypeScript entrypoint
- Modify: `package.json`
- Test: `tests/postgresMigrations.test.ts`

Add explicit connectivity, migrate, status, and verify commands. Ensure application startup never applies PostgreSQL migrations. Test migration idempotency, duplicate execution, rollback, schema verification, and sanitized failure output. Run the migration twice against controlled Neon using the direct URL.

### Task 4: Domain repository boundaries

**Files:**
- Create: `src/repositories/contracts/*.ts`
- Create: PostgreSQL implementations for approved control-plane domains
- Create: repository factory/backend selection
- Test: focused repository contract tests

Define typed repositories for research runs, candidates, scheduler leases, reconciliation, workstream events, and idempotency without reducing PostgreSQL guarantees to generic SQL.

### Task 5: Runtime and deployment policy

**Files:**
- Update: `docs/ARCHITECTURE.md`
- Create: `docs/runbooks/neon-postgres-operations.md`
- Update: `server/README.md`, `.env.example`, `RESUME_CONTEXT.md`

Document exact Vercel/VPS pool and timeout settings, pooled/direct policy, safe retries, explicit commands, environment presence checks, backup-first VPS secret installation, and rollback behavior.

### Task 6: Release gate and commit

Run all focused tests and repository validation, PostgreSQL migration twice, schema verification, connectivity from controlled local/Vercel/VPS contexts where safe, secret scans, and `git diff --check`. Authority flags must remain off. Commit only the foundation. Update Basic Memory Cloud.
