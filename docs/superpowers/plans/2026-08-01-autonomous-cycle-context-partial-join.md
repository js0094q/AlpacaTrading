# Autonomous Cycle Context and Partial-Join Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every compartment a versioned, immutable PostgreSQL evidence context; let portfolio review and learning consume healthy subsets explicitly; and produce complete release evidence without manufacturing an order.

**Architecture:** Add append-only cycle-context versions that reference authoritative PostgreSQL account, order, position, market, research, risk, and configuration evidence without copying secrets or raw provider payloads. Insert context-capture barriers into the registry, require downstream commands to bind to an existing frozen version, and summarize terminal compartment records for portfolio arbitration and learning. Add bounded observability and a separate, authorization-gated production runbook.

**Tech Stack:** TypeScript, Node.js ESM, PostgreSQL migrations and fenced transactions, canonical JSON fingerprints, existing PostgreSQL-only CLI and worker-state events.

## Global Constraints

- Paper mode is required and live trading remains disabled.
- PostgreSQL remains the sole operational authority.
- Shared context contains references and fingerprints, not credentials or unbounded provider responses.
- Each context version is immutable; post-mutation reconciliation creates a new version instead of rewriting research evidence.
- Portfolio review waits for terminal proposal-compartment records but may use the healthy proposal subset.
- Learning proceeds per compartment when sufficient outcome evidence exists.
- Cycle outcomes are exactly `complete`, `partial`, `blocked`, or `failed`.
- Journald and captured-output retention remain bounded; provider calls remain paginated and rate-limited.
- Do not add swap and do not expand the trading universe merely to consume disk, CPU, or traffic allowance.
- Natural market-hours evidence, not a manufactured candidate or validation order, is the acceptance proof.
- Migration, push, deployment, restart, environment changes, and broker mutation remain separate authorization gates.
- Begin only after Plans 1 and 2 are integrated and green; migrations 010 and 011 remain unapplied to the paper VPS until separately authorized.
- Preserve the unrelated untracked `.codex/` directory.

---

## File Structure

- Create `src/lib/database/migrations/011_autonomous_cycle_context.sql`: append-only context versions and indexes.
- Create `src/services/autonomousCycleContextService.ts`: capture, freeze, read, and validate context references under a scheduler fence.
- Create `src/services/autonomousCompartmentResultService.ts`: read terminal workflow records and build proposal/join summaries.
- Create `tests/postgresAutonomousCycleContextMigration.test.ts`, `tests/autonomousCycleContextService.test.ts`, and `tests/autonomousCompartmentResultService.test.ts`.
- Modify `src/lib/database/postgresSchema.ts` and `tests/postgresSchema.test.ts`: verify the new table, columns, constraints, trigger, and indexes.
- Modify `src/lib/database/postgresOnlyRuntime.ts`, `src/postgresOnlyCli.ts`, `src/services/postgresSchedulerCommandRegistry.ts`, `scripts/autonomous-worker-command-contract.json`, and `package.json`: add the internal production command `worker:context`.
- Modify `scripts/lib/autonomous-worker-registry.mjs` and `tests/autonomousWorkerRegistry.test.ts`: add context barriers with direct dependencies.
- Modify `scripts/autonomous-paper-worker.mjs` and `tests/autonomousPaperWorker.test.ts`: pass context version/fingerprint to downstream commands.
- Modify `src/services/postgresReviewWorkflowService.ts`, `src/services/postgresPortfolioArbitrationService.ts`, and their tests: persist partial-join evidence.
- Modify `src/services/postgresOutcomeLearningService.ts` and tests: record compartment-aware partial refresh evidence.
- Create `tests/postgresScheduledCommandContext.test.ts` and modify focused consumer tests: reject unrestricted latest-row reads after a context is frozen.
- Modify `server/systemd/alpaca-autonomous-paper.service`, `server/README.md`, `README.md`, and `RESUME_CONTEXT.md`: bounded observability and operations.
- Create `docs/runbooks/compartmentalized-autonomous-worker-release.md`: explicit migration/deploy/rollback/natural-cycle acceptance procedure.

### Task 1: Append-Only Cycle Context Migration

**Files:**
- Create: `src/lib/database/migrations/011_autonomous_cycle_context.sql`
- Create: `tests/postgresAutonomousCycleContextMigration.test.ts`
- Modify: `tests/postgresMigrations.test.ts`
- Modify: `src/lib/database/postgresSchema.ts`
- Modify: `tests/postgresSchema.test.ts`

**Interfaces:**
- Produces: one immutable row per `(cycle_id, version)` with a unique `(cycle_id, phase)` barrier.
- Consumes: migration 010 from Plan 1.

- [ ] **Step 1: Write the failing migration test**

```ts
const sql = await readFile(
  "src/lib/database/migrations/011_autonomous_cycle_context.sql",
  "utf8"
);
assert.match(sql, /CREATE TABLE autonomous_cycle_contexts/);
assert.match(sql, /PRIMARY KEY \(cycle_id, version\)/);
assert.match(sql, /UNIQUE \(cycle_id, phase\)/);
assert.match(sql, /evidence_references jsonb NOT NULL/);
assert.match(sql, /configuration_fingerprint text NOT NULL/);
assert.match(sql, /autonomous_cycle_contexts_append_only/);
assert.doesNotMatch(sql, /sqlite/i);
```

Change the latest migration assertion to version `11`, name `autonomous_cycle_context`.

- [ ] **Step 2: Run migration tests and verify RED**

Run: `npx tsx --test tests/postgresAutonomousCycleContextMigration.test.ts tests/postgresMigrations.test.ts`

Expected: FAIL because migration 011 is absent.

- [ ] **Step 3: Create the table and exact constraints**

```sql
CREATE TABLE autonomous_cycle_contexts (
  cycle_id text NOT NULL,
  version integer NOT NULL,
  phase text NOT NULL,
  status text NOT NULL DEFAULT 'frozen',
  captured_at timestamptz NOT NULL,
  account_snapshot_id text,
  research_run_id text,
  context_fingerprint text NOT NULL,
  configuration_fingerprint text NOT NULL,
  evidence_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cycle_id, version),
  UNIQUE (cycle_id, phase),
  CONSTRAINT autonomous_cycle_context_phase_valid CHECK (
    phase IN ('preflight', 'research', 'post_entry', 'post_exit', 'final')
  ),
  CONSTRAINT autonomous_cycle_context_status_frozen CHECK (status = 'frozen'),
  CONSTRAINT autonomous_cycle_context_fingerprints_nonempty CHECK (
    btrim(context_fingerprint) <> '' AND btrim(configuration_fingerprint) <> ''
  ),
  CONSTRAINT autonomous_cycle_context_evidence_array CHECK (
    jsonb_typeof(evidence_references) = 'array'
  )
);
```

Add cycle/version and captured-at indexes. Add a trigger that rejects `UPDATE` and `DELETE` with `AUTONOMOUS_CYCLE_CONTEXT_APPEND_ONLY`.

- [ ] **Step 4: Extend schema verification**

Require the table, indexes, columns, constraints, and append-only trigger. Add negative tests for a missing fingerprint column, invalid evidence JSON constraint, and missing trigger.

- [ ] **Step 5: Run tests and commit**

Run: `npx tsx --test tests/postgresAutonomousCycleContextMigration.test.ts tests/postgresMigrations.test.ts tests/postgresSchema.test.ts`

Expected: PASS.

```bash
git add src/lib/database/migrations/011_autonomous_cycle_context.sql tests/postgresAutonomousCycleContextMigration.test.ts tests/postgresMigrations.test.ts src/lib/database/postgresSchema.ts tests/postgresSchema.test.ts
git commit -m "Add immutable autonomous cycle contexts"
```

### Task 2: Fenced Context Capture and Validation

**Files:**
- Create: `src/services/autonomousCycleContextService.ts`
- Create: `tests/autonomousCycleContextService.test.ts`

**Interfaces:**
- Produces: `captureAutonomousCycleContext(input)`, `readAutonomousCycleContext(input)`, and `requireAutonomousCycleContext(input)`.
- Consumes: scheduler fence, cycle ID, phase, timestamp, configuration fingerprint, and bounded evidence references.

- [ ] **Step 1: Write failing capture tests**

Build a fake query executor with one current paper account snapshot, positions/orders/reservations/allocations, latest completed research, market evidence timestamps, and workflow terminal references. Assert the returned context has version 1 at preflight, a stable fingerprint, sorted unique references, and no raw account number, API key, order payload, or provider response.

- [ ] **Step 2: Write failing immutability and fence tests**

Assert a second capture for the same phase returns the exact stored row only when its fingerprint matches; a different fingerprint throws `AUTONOMOUS_CYCLE_CONTEXT_PHASE_CONFLICT`; a lost fence throws `SCHEDULER_FENCE_LOST` before insert.

- [ ] **Step 3: Run and verify RED**

Run: `npx tsx --test tests/autonomousCycleContextService.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 4: Define the context type**

```ts
export type AutonomousCycleContextPhase =
  | "preflight" | "research" | "post_entry" | "post_exit" | "final";

export type AutonomousCycleContext = {
  readonly cycleId: string;
  readonly version: number;
  readonly phase: AutonomousCycleContextPhase;
  readonly capturedAt: string;
  readonly accountSnapshotId: string | null;
  readonly researchRunId: string | null;
  readonly contextFingerprint: string;
  readonly configurationFingerprint: string;
  readonly evidenceReferences: readonly string[];
  readonly evidenceSummary: Readonly<Record<string, number | string | boolean | null>>;
};
```

- [ ] **Step 5: Capture bounded PostgreSQL references**

Under the fence, read the current paper account snapshot; counts and IDs for positions, open orders, reservations, allocations, and risk limits; latest research run; newest stock/option evidence timestamps; and terminal workflow IDs. Sort/deduplicate references, cap them at 2,000 entries, hash canonical JSON, and insert the next version. Never call Alpaca from this service.

- [ ] **Step 6: Validate downstream bindings**

`requireAutonomousCycleContext()` accepts cycle ID, version, fingerprint, and minimum phase; it loads exactly one frozen row and rejects mismatches with `AUTONOMOUS_CYCLE_CONTEXT_REQUIRED`, `AUTONOMOUS_CYCLE_CONTEXT_FINGERPRINT_MISMATCH`, or `AUTONOMOUS_CYCLE_CONTEXT_PHASE_INSUFFICIENT`.

- [ ] **Step 7: Run and commit**

Run: `npx tsx --test tests/autonomousCycleContextService.test.ts`

Expected: PASS.

```bash
git add src/services/autonomousCycleContextService.ts tests/autonomousCycleContextService.test.ts
git commit -m "Capture fenced cycle evidence contexts"
```

### Task 3: Internal `worker:context` Command and Registry Barriers

**Files:**
- Modify: `src/lib/database/postgresOnlyRuntime.ts`
- Modify: `src/postgresOnlyCli.ts`
- Modify: `src/services/postgresSchedulerCommandRegistry.ts`
- Modify: `scripts/autonomous-worker-command-contract.json`
- Modify: `package.json`
- Modify: `scripts/lib/autonomous-worker-registry.mjs`
- Modify: `scripts/autonomous-paper-worker.mjs`
- Modify: `tests/postgresOnlyAuthority.test.ts`
- Modify: `tests/postgresSchedulerCommandRegistry.test.ts`
- Modify: `tests/autonomousWorkerRegistry.test.ts`
- Modify: `tests/autonomousPaperWorker.test.ts`

**Interfaces:**
- Produces: `npm run worker:context -- --cycleId=<uuid> --phase=<phase> --configurationFingerprint=<sha256> --format=json`.
- Passes: `AUTONOMOUS_CONTEXT_VERSION` and `AUTONOMOUS_CONTEXT_FINGERPRINT` to downstream children.

- [ ] **Step 1: Write failing command-contract tests**

Assert `worker:context` is PostgreSQL-only, production, registered, required, and absent from broker-mutation sets. Assert malformed phase/fingerprint arguments fail before persistence.

- [ ] **Step 2: Run and verify RED**

Run: `npx tsx --test tests/postgresOnlyAuthority.test.ts tests/postgresSchedulerCommandRegistry.test.ts tests/autonomousWorkerRegistry.test.ts`

Expected: FAIL because the command is unregistered.

- [ ] **Step 3: Route the command through the scheduled PostgreSQL context**

Add the package script and command contract entry. In `postgresOnlyCli.ts`, require scheduled context and call `captureAutonomousCycleContext()` using `queryAdapter(context.pool)`, `context.fence`, the explicit cycle/phase, and a 64-character lowercase hexadecimal configuration fingerprint. Print only the paper envelope and bounded context result.

- [ ] **Step 4: Add context barrier nodes**

Insert these `postgres_serial` nodes:

- `context.preflight` after `reconcile.initial`; `research.prepare`, option discovery, and exit-review nodes depend on it.
- `context.research` after `research.finalize` and `options.discover`; decision nodes depend on it.
- `context.post_entry` after `reconcile.entries`; exit mutations depend on it.
- `context.post_exit` after `reconcile.exits`; cancellation depends on it.
- `context.final` after `reconcile.final`; learning and recovery depend on it.

Each barrier is a distinct workflow ID invoking `worker:context` with an explicit phase.

- [ ] **Step 5: Bind child processes to frozen versions**

After each context node succeeds, parse its canonical output and store only version/fingerprint in cycle memory. Add registry `inputBindings` so every downstream node receives `AUTONOMOUS_CONTEXT_VERSION` and `AUTONOMOUS_CONTEXT_FINGERPRINT` from its exact phase barrier; registry tests must fail if a context-requiring node lacks either binding or points at the wrong phase. A context failure is a global mutation block but does not erase already completed compartment evidence.

- [ ] **Step 6: Run focused tests and commit**

Run: `npx tsx --test tests/postgresOnlyAuthority.test.ts tests/postgresSchedulerCommandRegistry.test.ts tests/autonomousWorkerRegistry.test.ts tests/autonomousPaperWorker.test.ts`

Expected: PASS.

```bash
git add src/lib/database/postgresOnlyRuntime.ts src/postgresOnlyCli.ts src/services/postgresSchedulerCommandRegistry.ts scripts/autonomous-worker-command-contract.json package.json scripts/lib/autonomous-worker-registry.mjs scripts/autonomous-paper-worker.mjs tests/postgresOnlyAuthority.test.ts tests/postgresSchedulerCommandRegistry.test.ts tests/autonomousWorkerRegistry.test.ts tests/autonomousPaperWorker.test.ts
git commit -m "Bind workflows to frozen cycle contexts"
```

### Task 4: Context-Scoped Workflow Consumers

**Files:**
- Create: `tests/postgresScheduledCommandContext.test.ts`
- Modify: `src/services/postgresScheduledCommandService.ts`
- Modify: `src/postgresOnlyCli.ts`
- Modify: `src/services/autonomousPostgresCommandService.ts`
- Modify: `src/services/postgresResearchWorkflowService.ts`
- Modify: `src/services/postgresReviewWorkflowService.ts`
- Modify: `src/services/autonomousPostgresExecutionService.ts`
- Modify: `src/services/postgresReconciliationService.ts`
- Modify: `src/services/postgresOrderCancellationService.ts`
- Modify: `src/services/postgresOutcomeLearningService.ts`
- Modify: `tests/postgresResearchWorkflowService.test.ts`
- Modify: `tests/postgresReviewWorkflowService.test.ts`
- Modify: `tests/autonomousPostgresExecutionService.test.ts`
- Modify: `tests/postgresReconciliationService.test.ts`
- Modify: `tests/postgresOrderCancellationService.test.ts`
- Modify: `tests/postgresOutcomeLearningService.test.ts`

**Interfaces:**
- Consumes: a verified `AutonomousCycleContext` and a command-specific minimum phase.
- Produces: SQL and service inputs bound to the context's referenced account snapshot, research run, evidence cutoffs, and configuration fingerprint instead of unconstrained “latest” rows.

- [ ] **Step 1: Write the stale-latest regression tests**

For each consumer class, provide a frozen context referencing account snapshot A and research run A while the fake database also contains newer snapshot B/run B. Assert review, arbitration, execution, cancellation, and learning use A. Assert reconciliation may observe new broker state but reports those new references for the next immutable context barrier instead of rewriting A.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx tsx --test tests/postgresScheduledCommandContext.test.ts tests/postgresResearchWorkflowService.test.ts tests/postgresReviewWorkflowService.test.ts tests/autonomousPostgresExecutionService.test.ts tests/postgresReconciliationService.test.ts tests/postgresOrderCancellationService.test.ts tests/postgresOutcomeLearningService.test.ts`

Expected: FAIL where current queries select the latest unrestricted evidence.

- [ ] **Step 3: Resolve and verify context once per CLI command**

Extend the scheduled operation context with `autonomousCycleContext?: AutonomousCycleContext`. In `postgresOnlyCli.ts`, read `AUTONOMOUS_CONTEXT_VERSION` and `AUTONOMOUS_CONTEXT_FINGERPRINT`, call `requireAutonomousCycleContext()` once, and attach the verified result before dispatch. Use this command-to-minimum-phase map:

```ts
const minimumContextPhase = {
  "research:daily": "preflight",
  "paper:options:discover": "preflight",
  "paper:exit:review": "preflight",
  "zero-dte:exit:review": "preflight",
  "hedge:exit:review": "preflight",
  "paper:review": "research",
  "paper:portfolio:review": "research",
  "paper:ops:review": "research",
  "hedge:review": "research",
  "paper:execute:reviewed": "research",
  "zero-dte:engine": "research",
  "paper:exit:execute": "post_entry",
  "hedge:exit:execute": "post_entry",
  "paper:order:cancel": "post_exit",
  "paper:learn": "final",
  "system:recover": "final"
} as const;
```

- [ ] **Step 4: Bind service queries to referenced identities**

Thread the verified context as a required input. Use `accountSnapshotId`, `researchRunId`, referenced position/order IDs, stock/option evidence timestamps, and configuration fingerprint in SQL predicates. If a required reference is absent, return an explicit no-action only where the existing command contract permits it; otherwise fail with `AUTONOMOUS_CYCLE_CONTEXT_EVIDENCE_MISSING` before mutation.

- [ ] **Step 5: Keep reconciliation version-producing**

Reconciliation reads current broker state under its existing fence and idempotency rules. It returns the newly persisted broker/order/position references so the following `worker:context` barrier can freeze a new version. It never updates an existing context row.

- [ ] **Step 6: Run context-scope tests and verify GREEN**

Run the same focused command from Step 2.

Expected: PASS; every ordinary consumer is pinned to the frozen evidence and reconciliation is the only controlled source of newer broker references.

- [ ] **Step 7: Commit the context-consumer slice**

```bash
git add src/services/postgresScheduledCommandService.ts src/postgresOnlyCli.ts src/services/autonomousPostgresCommandService.ts src/services/postgresResearchWorkflowService.ts src/services/postgresReviewWorkflowService.ts src/services/autonomousPostgresExecutionService.ts src/services/postgresReconciliationService.ts src/services/postgresOrderCancellationService.ts src/services/postgresOutcomeLearningService.ts tests/postgresScheduledCommandContext.test.ts tests/postgresResearchWorkflowService.test.ts tests/postgresReviewWorkflowService.test.ts tests/autonomousPostgresExecutionService.test.ts tests/postgresReconciliationService.test.ts tests/postgresOrderCancellationService.test.ts tests/postgresOutcomeLearningService.test.ts
git commit -m "Scope workflows to frozen cycle evidence"
```

### Task 5: Partial Portfolio Join

**Files:**
- Create: `src/services/autonomousCompartmentResultService.ts`
- Create: `tests/autonomousCompartmentResultService.test.ts`
- Modify: `src/services/postgresReviewWorkflowService.ts`
- Modify: `src/services/postgresPortfolioArbitrationService.ts`
- Modify: `tests/postgresReviewWorkflowService.test.ts`
- Modify: `tests/postgresPortfolioArbitrationService.test.ts`

**Interfaces:**
- Produces: `readProposalCompartmentSummary(query, cycleId)`.
- Consumes: terminal `workstream_events` records for the current cycle.

- [ ] **Step 1: Write failing summary tests**

Create terminal records for healthy `proposal.equity`, errored `proposal.zero_dte`, healthy `proposal.leaps`, and no-action `proposal.standard_option` results. Assert the summary requires exactly those four enabled proposal IDs, exposes proposals only from successful results, retains error/no-action reason codes, and reports `partial` without throwing. Add a second scenario with deferred and blocked local lanes and assert both arrays and reasons remain visible without cancelling a healthy peer.

- [ ] **Step 2: Define the join interface**

```ts
export type ProposalCompartmentSummary = {
  readonly cycleId: string;
  readonly terminalCount: number;
  readonly successfulWorkflowIds: readonly string[];
  readonly failedWorkflowIds: readonly string[];
  readonly noActionWorkflowIds: readonly string[];
  readonly deferredWorkflowIds: readonly string[];
  readonly blockedWorkflowIds: readonly string[];
  readonly proposalReferences: readonly string[];
  readonly globalMutationBlockReason: string | null;
  readonly outcome: "complete" | "partial" | "blocked" | "failed";
};
```

- [ ] **Step 3: Run and verify RED**

Run: `npx tsx --test tests/autonomousCompartmentResultService.test.ts`

Expected: FAIL because the summary service does not exist.

- [ ] **Step 4: Read terminal records by stable workflow ID**

Query the latest terminal event per `payload->>'workflowId'`, require one record for each enabled proposal compartment, and reject duplicate or missing identities. Parse only sanitized counts, reason codes, and evidence references; never trust child output to grant mutation authority.

- [ ] **Step 5: Integrate portfolio review**

Before `paper:portfolio:review`, load the current cycle summary and frozen research context. Pass both into portfolio arbitration. Persist successful/failed/no-action workflow IDs, proposal references, context version/fingerprint, and global block reason in the existing arbitration decision evidence. A local lane failure does not reject healthy candidates; a global block prevents intent readiness.

- [ ] **Step 6: Add integration tests**

Force 0DTE failure with healthy LEAPS/equity candidates and assert those candidates remain eligible for normal risk checks. Force a context fingerprint mismatch and assert no intent becomes ready.

- [ ] **Step 7: Run and commit**

Run: `npx tsx --test tests/autonomousCompartmentResultService.test.ts tests/postgresReviewWorkflowService.test.ts tests/postgresPortfolioArbitrationService.test.ts`

Expected: PASS.

```bash
git add src/services/autonomousCompartmentResultService.ts src/services/postgresReviewWorkflowService.ts src/services/postgresPortfolioArbitrationService.ts tests/autonomousCompartmentResultService.test.ts tests/postgresReviewWorkflowService.test.ts tests/postgresPortfolioArbitrationService.test.ts
git commit -m "Arbitrate healthy workflow subsets"
```

### Task 6: Compartment-Aware Learning and Observability

**Files:**
- Modify: `src/services/postgresOutcomeLearningService.ts`
- Modify: `tests/postgresOutcomeLearningService.test.ts`
- Modify: `scripts/autonomous-paper-worker.mjs`
- Modify: `tests/autonomousPaperWorker.test.ts`
- Modify: `server/systemd/alpaca-autonomous-paper.service`
- Modify: `server/README.md`

**Interfaces:**
- Produces: partial learning evidence and bounded cycle/compartment metrics.

- [ ] **Step 1: Write failing partial-learning tests**

Provide outcomes for equity and LEAPS with an errored 0DTE compartment. Assert learning records are refreshed for the two evidence-bearing compartments, 0DTE is recorded as skipped with its reason, and the refresh result is `partial` rather than failed.

- [ ] **Step 2: Implement compartment evidence in learning refresh**

Accept an optional `ProposalCompartmentSummary`; filter only when a terminal compartment explicitly lacks sufficient outcome evidence. Persist included/skipped workflow IDs, context fingerprint, source counts, and reason codes in the refresh summary. Preserve replay idempotency.

- [ ] **Step 3: Add reconciled count telemetry**

Emit bounded counts for `contracts -> snapshots -> features -> targets -> candidates -> proposals -> allocations -> reviews -> intents -> mutations -> reconciled orders -> outcomes -> learning`, plus queue wait, duration, configured/effective concurrency, fallback, fence, and context version per workflow. Missing required transitions become `WORKFLOW_EVIDENCE_TRANSITION_MISSING` blockers, not fabricated zeros.

- [ ] **Step 4: Bound logging and capture**

Retain `MAX_CAPTURE_BYTES = 256 * 1024`. Add systemd log rate limits only if supported by the deployed systemd version, and document journald size/age commands in the runbook rather than changing global journald configuration automatically. Never retain raw provider bodies indefinitely.

- [ ] **Step 5: Run focused tests**

Run: `npx tsx --test tests/postgresOutcomeLearningService.test.ts tests/autonomousPaperWorker.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit learning and observability**

```bash
git add src/services/postgresOutcomeLearningService.ts tests/postgresOutcomeLearningService.test.ts scripts/autonomous-paper-worker.mjs tests/autonomousPaperWorker.test.ts server/systemd/alpaca-autonomous-paper.service server/README.md
git commit -m "Record partial cycle learning evidence"
```

### Task 7: Release Runbook and Integrated Verification

**Files:**
- Create: `docs/runbooks/compartmentalized-autonomous-worker-release.md`
- Modify: `README.md`
- Modify: `RESUME_CONTEXT.md`

**Interfaces:**
- Produces: an exact, non-self-authorizing release and acceptance procedure.

- [ ] **Step 1: Write the runbook authorization gates**

The runbook must require separate approval for the exact verified SHA, migration 010/011 application, one worker restart, and production observation. It must prohibit live mode, secret changes, validation orders, manufactured candidates, extra restarts, and automatic rollback that drops new schema. Record two compatible code rollback anchors: the exact Plan 1 completion SHA for scheduler failures after migration 010, and the exact Plan 2 completion SHA for context-orchestration failures after migration 011; never roll back to code that assumes the old three-column target key.

- [ ] **Step 2: Add pre-deployment verification commands**

Document local/remote SHA equality, clean tracked status excluding `.codex/`, full tests/typecheck/build, disposable PostgreSQL migrations twice, `db:postgres:verify`, service-stop-before-migrate, disk/memory/load checks, and rollback artifact capture.

- [ ] **Step 3: Add broker-disabled soak acceptance**

Require at least 25 randomized fake-provider cycles with maximum non-broker concurrency two, broker concurrency one, forced local failures, fallback/recovery transitions, complete terminal records, and no surviving processes.

- [ ] **Step 4: Add production-shaped natural-cycle acceptance**

After separately authorized deployment and one restart, observe two natural market-hours cycles. Require paper/live-off/PostgreSQL-only gates, exact deployed SHA, fresh SIP/OPRA evidence, distinct 0DTE and LEAPS target identities, terminal candidate decisions, serialized mutation evidence when a natural approved intent exists, exact broker acknowledgement/reconciliation, and explicit no-action reasons when no intent exists. Do not submit an order merely to validate deployment.

- [ ] **Step 5: Run the full local verification graph**

Run the focused tests from Plans 1-3, then `npm run typecheck`, `npm run build`, `npm test`, `npm run dashboard:build`, and `git diff --check`. Run disposable PostgreSQL integration when a disposable URL is available. Classify every failure before repair.

- [ ] **Step 6: Perform independent requirement mapping**

Record a matrix in the runbook: each approved spec requirement, observable behavior, exact test/command, result, and remaining gap. A missing disposable database, systemd tool, or market-hours cycle yields `partial`, not pass.

- [ ] **Step 7: Commit documentation**

```bash
git add docs/runbooks/compartmentalized-autonomous-worker-release.md README.md RESUME_CONTEXT.md
git commit -m "Document compartment worker release gates"
```

## Plan 3 Completion Gate

Implementation is complete only when every approved-spec requirement maps to fresh local or disposable-environment evidence. That does not authorize push, production migrations, deployment, restart, or broker mutation. Hand off the exact SHA and request those authorities separately.
