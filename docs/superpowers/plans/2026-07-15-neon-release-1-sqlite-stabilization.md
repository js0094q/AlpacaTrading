# Release 1: SQLite Inventory and Transition Stabilization

> Execute in the isolated worktree. Commit only after the release gate passes.

**Goal:** Produce a complete evidence-backed SQLite inventory and reduce transition lock risk without changing authority or enabling live behavior.

**Architecture:** Keep current SQLite authority for this release. Make schema mutation explicit, retain the journal mode justified by copied-database evidence, and wrap only retry-safe writes with bounded `BUSY`/`LOCKED` handling.

**Tech stack:** TypeScript, Node SQLite built-in, Node test runner, systemd/VPS shell diagnostics.

---

### Task 1: Capture the authoritative inventory

**Files:**
- Create: `docs/specs/2026-07-15-neon-operational-state-inventory.md`
- Inspect: `src/lib/db.ts`, `src/lib/sqliteMigrations.ts`, `src/services/**/*.ts`, `scripts/**/*.mjs`, `server/systemd/*`

1. Enumerate all 54 tables from migration definitions.
2. Classify each as `AUTHORITATIVE`, `DERIVED`, `APPEND_ONLY`, `CACHE`, `TRANSIENT`, or `OBSOLETE`, with evidence and target ownership.
3. Map every reader, writer, transaction, `BEGIN IMMEDIATE`, retry wrapper, busy timeout, journal setting, migration call, runtime DDL path, scheduler unit, and lock owner.
4. Identify transactions that include or are adjacent to network/file/sleep work.
5. Verify the inventory against `rg` results and schema definitions.

### Task 2: Test WAL on a copied VPS database

**Files:**
- Create: `scripts/verify-sqlite-wal-compatibility.mjs`
- Test: `tests/sqliteWalCompatibility.test.ts`
- Update: `docs/specs/2026-07-15-neon-operational-state-inventory.md`

1. Write focused failing tests for copy-only operation, journal creation/checkpoint, concurrent reader/writer behavior, termination recovery, integrity, and foreign keys.
2. Implement a non-destructive verifier that refuses to operate on the source path and emits no row data.
3. Create a protected VPS copy, record checksum/count/integrity evidence, and test on the deployment filesystem.
4. Inspect filesystem, backup, and deploy-script compatibility.
5. Adopt WAL only if evidence is safer; otherwise retain DELETE mode and document why.

### Task 3: Correct bounded SQLite retry handling

**Files:**
- Modify: `src/lib/sqliteConcurrency.ts`
- Modify: relevant retry-safe call sites only
- Test: `tests/sqliteConcurrency.test.ts`

1. Add failing tests for numeric and named `SQLITE_BUSY`/`SQLITE_LOCKED`, non-lock errors, bounded attempts, exponential delay, jitter bounds, total deadline, telemetry, and causal-error preservation.
2. Add explicit lock classification and operation safety metadata.
3. Implement bounded exponential backoff with injectable jitter/clock for deterministic tests.
4. Apply the helper only to idempotent or transactionally safe writes.
5. Run focused tests and verify no validation/constraint/corruption errors are retried.

### Task 4: Isolate runtime migrations and redact secrets

**Files:**
- Modify: `src/lib/db.ts`, `src/lib/sqliteMigrations.ts`, startup callers as discovered
- Modify: `src/cli.ts`, `package.json`
- Create or modify: focused migration-boundary and redaction tests

1. Add tests proving ordinary commands never apply DDL and pending migrations fail closed.
2. Preserve explicit migration/status commands and test duplicate execution.
3. Add centralized secret sanitization and tests for PostgreSQL-style URLs, passwords, and token query parameters.
4. Ensure startup output contains only mode/key names and presence states.

### Task 5: Record the decision and cutover procedure

**Files:**
- Create: `docs/decisions/ADR-010-neon-authoritative-operational-state.md`
- Update: `docs/ARCHITECTURE.md`
- Update: `README.md`
- Update: `RESUME_CONTEXT.md`

Document ownership, event synchronization, no mutable database merging, staged authority, rollback boundaries, WAL evidence, secret policy, and release gates.

### Task 6: Release gate and commit

Run focused tests, then `npm test`, `npm run test:zero-dte`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run dashboard:build`, `git diff --check`, and SQLite integrity/foreign-key checks. Review the diff for secrets and unrelated files. Commit only this release. Update Basic Memory Cloud with the commit, validation, and remaining authority state.
