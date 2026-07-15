# Release 3: Control-Plane Migration

> Begin only after the PostgreSQL foundation gate passes. Any unexplained reconciliation discrepancy blocks authority expansion.

**Goal:** Make PostgreSQL authoritative for distributed scheduler and research control-plane state while retaining execution authority in SQLite.

**Architecture:** Backfill into PostgreSQL idempotently, shadow current paper operations, reconcile exact state, then enable control-plane reads/writes through flags. Scheduler fencing prevents stale workers from committing.

**Tech stack:** TypeScript, `pg`, Neon PostgreSQL, SQLite snapshot/export tooling, systemd jobs.

---

### Task 1: Scheduler leases with fencing

Implement atomic acquisition, heartbeat, expiration, monotonic fencing token, owner/run/workstream identity, release, and conditional state writes. Cover research, zero DTE, observatory, reconciliation, exit review, paper exit, allocation, and market-data refresh. Test acquisition races, expiration, heartbeat, token rejection, and stale-worker writes.

### Task 2: Control-plane repositories and projections

Implement PostgreSQL repositories for research runs, candidates, candidate lifecycle events, idempotency records, workstream events/failures, and reconciliation checkpoints. Event ingestion must atomically record, project, and mark completion. Test duplicate and out-of-order delivery.

### Task 3: Snapshot, backfill, and reconciliation

Add explicit resumable commands that create or consume a read-consistent SQLite snapshot, record checksum/count/integrity evidence, backfill in dependency order, and reconcile counts, IDs, status distributions, active runs, candidates by run, lifecycle ordering, idempotency keys, lease state, and checkpoints. Produce a redacted discrepancy report.

### Task 4: Shadow comparison and feature-flagged authority

Add paper-only shadow writes/comparisons with finite duration and structured discrepancy telemetry. Preserve SQLite authority until comparison and reconciliation pass. Then enable PostgreSQL control-plane writes and reads while execution-state authority remains disabled. Do not retain indefinite mutable dual writes.

### Task 5: Deploy and validate

Install Neon variables on the VPS with a protected backup and atomic edit, preserve permissions/ownership, and restart only affected services. Verify Vercel integration scopes without overwriting values. Deploy exact merged SHA, verify paper/live-disabled state, connectivity, migration version, pool health, lease ownership, no duplicate work, no uncontrolled migration, and no credential leakage.

### Task 6: Release gate and commit

Run all repository validation plus backfill/reconciliation, concurrent control-plane tests, and overlapping paper research/zero-DTE/reconciliation/observatory workflows. Stop if any discrepancy is unexplained. Commit and update Basic Memory Cloud only after the gate passes.
