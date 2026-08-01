# Compartmentalized Autonomous Worker Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 20-position sequential outer worker loop with a two-slot readiness scheduler whose workflow compartments fail independently while every paper broker mutation remains globally serialized and reconciled.

**Architecture:** Move production workflow metadata into a checked-in registry and execute it with a pure, testable graph scheduler. Split the monolithic daily research command into prepare, four independently scheduled lane invocations, and finalize stages while retaining one registered production command. The scheduler admits at most two compute workflows, falls back to one under bounded pressure, serializes authoritative PostgreSQL work, and uses a separate one-slot broker-mutation gate. PostgreSQL worker events become workflow-ID scoped so concurrent starts and completions remain valid and recoverable.

**Tech Stack:** Node.js ESM, TypeScript, Node.js test runner through `tsx`, child-process groups, PostgreSQL worker-event persistence, systemd.

## Global Constraints

- VPS capacity is 3 CPU cores, 4.5 GB RAM, 45 GB disk, and 4.5 TB monthly traffic.
- Non-broker workflow concurrency defaults to `2`, never exceeds `2`, and falls back to `1` under pressure.
- Available memory below 1 GiB or sustained one-minute load average above 2.5 prevents new two-slot admission.
- Provider throttling, PostgreSQL latency, worker-state latency, heartbeat/fence risk, timeout, file-descriptor pressure, or disk pressure may also reduce admission to `1`.
- Broker mutation concurrency is exactly `1` globally.
- A lane-local failure, timeout, deferral, or no-action result must not cancel an unrelated queued or active compartment.
- Only enumerated paper/live, authority, fence, authoritative-persistence, inconsistent shared truth, command-contract, indeterminate-mutation, or failed-shutdown conditions block all later broker mutation.
- Paper mode, live-off flags, PostgreSQL-only authority, deterministic client order IDs, reservations, fencing, and reconciliation remain unchanged.
- Begin only after Plan 1 is integrated and green; migration 010 remains unapplied to the paper VPS until separately authorized.
- Do not deploy, restart the VPS worker, change environment values, or submit any order while implementing this plan.
- Preserve the unrelated untracked `.codex/` directory.

---

## File Structure

- Create `scripts/lib/autonomous-worker-registry.mjs`: immutable workflow definitions and registry/command-contract validation.
- Create `scripts/lib/bounded-workflow-scheduler.mjs`: FIFO two-slot semaphore, pressure fallback, readiness graph, and mutation gate.
- Create `tests/autonomousWorkerRegistry.test.ts`: registry completeness, acyclicity, direct dependencies, and privilege metadata.
- Create `tests/boundedWorkflowScheduler.test.ts`: deterministic concurrency, fault isolation, fallback, join, and mutation serialization.
- Modify `src/services/canonicalWorkstreamResult.ts`, `src/services/investmentOrchestratorService.ts`, and `src/services/postgresResearchWorkflowService.ts`: expose equity, standard-option, 0DTE, and LEAPS as independently invocable proposal compartments.
- Modify `src/postgresOnlyCli.ts` and focused research/orchestrator tests: support prepare/lane/finalize stages through the existing `research:daily` production command.
- Modify `scripts/autonomous-paper-worker.mjs`: use the registry and scheduler; track multiple process groups.
- Modify `src/services/autonomousWorkerStateService.ts`: scope transitions by `workflowId` instead of global latest-event order.
- Modify `tests/autonomousWorkerStateService.test.ts` and `tests/autonomousPaperWorker.test.ts`: concurrent lifecycle and production-shaped behavior.
- Modify `scripts/autonomous-worker-command-contract.json`, `server/systemd/alpaca-autonomous-paper.service`, `server/README.md`, `README.md`, and `RESUME_CONTEXT.md` only where the new contract or operation requires it.

### Task 1: Canonical Production Workflow Registry

**Files:**
- Create: `scripts/lib/autonomous-worker-registry.mjs`
- Create: `tests/autonomousWorkerRegistry.test.ts`
- Modify: `scripts/autonomous-worker-command-contract.json`

**Interfaces:**
- Produces: `AUTONOMOUS_WORKFLOW_REGISTRY`, `BROKER_MUTATION_COMMANDS`, `STATE_COMMAND`, and `validateWorkflowRegistry(input)`.
- Consumes: `package.json` scripts and the production command contract.

- [ ] **Step 1: Write the failing registry tests**

```ts
const requiredCommands = new Set([
  "zero-dte:reconcile", "research:daily", "paper:options:discover",
  "paper:review", "paper:portfolio:review", "paper:ops:review",
  "hedge:review", "paper:execute:reviewed", "zero-dte:engine",
  "paper:exit:review", "zero-dte:exit:review", "hedge:exit:review",
  "paper:exit:execute", "hedge:exit:execute", "paper:order:cancel",
  "paper:learn", "system:recover", "worker:state"
]);
assert.deepEqual(new Set(registryCommands), requiredCommands);
assert.equal(new Set(registry.map(({ id }) => id)).size, registry.length);
```

Also assert every dependency ID exists, the graph is acyclic, every broker-mutating command has `resourceClass: "broker_mutation"`, and no other command has that class.

- [ ] **Step 2: Run the registry test and verify RED**

Run: `npx tsx --test tests/autonomousWorkerRegistry.test.ts`

Expected: FAIL because the registry module does not exist.

- [ ] **Step 3: Define and freeze registry entries**

```js
/** @typedef {"shared_context"|"compute_readonly"|"postgres_serial"|"broker_mutation"} ResourceClass */
/** @typedef {"shared"|"equity"|"options_standard"|"options_0dte"|"options_leaps"|"hedge"|"exits"|"learning"} WorkflowLane */
/** @typedef {"local"|"global_mutation_block"} FailureScope */
/** @typedef {{ maxAttempts: number, backoffMs: number,
 * retryableReasonCodes: readonly string[] }} RetryPolicy */
/** @typedef {{ argName: string, fromWorkflowId: string,
 * outputField: string }} InputBinding */
/** @typedef {{ id: string, schedulerIdentity: string, command: string,
 * args: readonly string[], compartment: string, lane: WorkflowLane,
 * phase: string, dependencies: readonly string[], resourceClass: ResourceClass,
 * enableWhen: "always"|"options_enabled"|"hedging_enabled",
 * requiredRuntimeFlags: Readonly<Record<string, string>>,
 * timeoutMs: number, retryPolicy: RetryPolicy,
 * expectedNoActionReasons: readonly string[], failureScope: FailureScope,
 * sharedContextPhase: null|string,
 * inputBindings: readonly InputBinding[] }} WorkflowDefinition */
```

Freeze every entry and nested metadata object. Validate unique `schedulerIdentity`, known enablement predicates, retry attempts in `[1,3]`, bounded backoff, known reason codes, dependency-backed input bindings, and resource-class/command privilege compatibility. Runtime output may not change any registry field.

`worker:state` participates in command-contract completeness without becoming a scheduled graph node.

- [ ] **Step 4: Encode these direct terminal dependencies**

| Workflow ID | Command | Direct dependencies |
| --- | --- | --- |
| `reconcile.initial` | `zero-dte:reconcile` | none |
| `research.prepare` | `research:daily --stage=prepare` | `reconcile.initial` |
| `options.discover` | `paper:options:discover` | `reconcile.initial` |
| `proposal.equity` | `research:daily --stage=lane --lane=equity` | `research.prepare` |
| `proposal.standard_option` | `research:daily --stage=lane --lane=options_standard` | `research.prepare` |
| `proposal.zero_dte` | `research:daily --stage=lane --lane=options_0dte` | `research.prepare` |
| `proposal.leaps` | `research:daily --stage=lane --lane=options_leaps` | `research.prepare` |
| `research.finalize` | `research:daily --stage=finalize` | `research.prepare` and all four `proposal.*` IDs |
| `exit.review.paper` | `paper:exit:review` | `reconcile.initial` |
| `exit.review.zero_dte` | `zero-dte:exit:review` | `reconcile.initial` |
| `exit.review.hedge` | `hedge:exit:review` | `reconcile.initial` |
| `review.general` | `paper:review` | `research.finalize`, `options.discover` |
| `review.portfolio` | `paper:portfolio:review` | `review.general` |
| `review.operations` | `paper:ops:review` | `review.portfolio` |
| `review.hedge` | `hedge:review` | `review.portfolio` |
| `entry.paper` | `paper:execute:reviewed` | `review.operations`, `review.hedge` |
| `entry.zero_dte` | `zero-dte:engine` | `review.operations`, `review.hedge` |
| `reconcile.entries` | `zero-dte:reconcile` | `entry.paper`, `entry.zero_dte` |
| `exit.execute.paper` | `paper:exit:execute` | `exit.review.paper`, `exit.review.zero_dte`, `reconcile.entries` |
| `exit.execute.hedge` | `hedge:exit:execute` | `exit.review.hedge`, `reconcile.entries` |
| `reconcile.exits` | `zero-dte:reconcile` | `exit.execute.paper`, `exit.execute.hedge` |
| `cancel.orders` | `paper:order:cancel` | `reconcile.exits` |
| `reconcile.final` | `zero-dte:reconcile` | `cancel.orders` |
| `learn.paper` | `paper:learn` | `reconcile.final`, `research.finalize`, `options.discover` |
| `recover.final` | `system:recover` | all preceding IDs: `reconcile.initial` through `learn.paper` |

Dependencies require a terminal record, not success. `research.finalize` receives all four terminal lane records and persists the healthy proposal subset plus every failure/no-action record. Each command retains its own evidence checks.

The four lane nodes and `research.finalize` declare a `researchRunId` input binding from the sanitized `research.prepare` output. A binding may read only an allowlisted scalar field from its declared dependency. Missing, malformed, or oversized bound output creates a terminal `WORKFLOW_INPUT_BINDING_INVALID`; it never falls back to an unrestricted latest research run.

Evaluate every `enableWhen` predicate once from validated startup flags and freeze the enabled node set for the cycle. Disabled nodes are never admitted; their dependency edges are treated as inactive, recorded as sanitized registry decisions, and excluded from joins that require a terminal record for every enabled compartment.

- [ ] **Step 5: Validate command-contract parity**

Compare the unique base command set plus `worker:state` against `package.json` and the JSON contract; repeated staged invocations of `research:daily` count once for command parity. Reject unknown or missing commands and require the existing production/PostgreSQL/SQLite-free flags. If the JSON shape changes, change its version and validator together.

- [ ] **Step 6: Run and commit**

Run: `npx tsx --test tests/autonomousWorkerRegistry.test.ts`

Expected: PASS.

```bash
git add scripts/lib/autonomous-worker-registry.mjs scripts/autonomous-worker-command-contract.json tests/autonomousWorkerRegistry.test.ts
git commit -m "Declare autonomous workflow readiness graph"
```

### Task 2: FIFO Two-Slot Scheduler and Pressure Fallback

**Files:**
- Create: `scripts/lib/bounded-workflow-scheduler.mjs`
- Create: `tests/boundedWorkflowScheduler.test.ts`

**Interfaces:**
- Produces: `createBoundedScheduler(options)`, `resourcePressureSample(input)`, and `executeWorkflowGraph(input)`.
- Consumes: immutable registry entries plus injected `runWorkflow(definition, signal)` and `persistTerminal(result)` functions.

- [ ] **Step 1: Write deterministic concurrency and bounds tests**

Start three independent operations with deferred promises. Assert two start, the third remains queued, maximum observed concurrency is two, and release admits the third FIFO. Assert `0`, `3`, `1.5`, and `NaN` throw `AUTONOMOUS_COMPUTE_CONCURRENCY_INVALID`; `1` and `2` are valid.

- [ ] **Step 2: Run and verify RED**

Run: `npx tsx --test tests/boundedWorkflowScheduler.test.ts`

Expected: FAIL because the scheduler module is absent.

- [ ] **Step 3: Implement the abort-aware interface**

```js
const scheduler = createBoundedScheduler({
  configuredConcurrency: 2,
  minimumConcurrency: 1,
  maximumConcurrency: 2,
  samplePressure,
  emit
});
await scheduler.run({ workflowId, resourceClass, signal }, operation);
```

Use one FIFO non-mutating admission queue with a hard total cap of two, plus nested `shared_context` and `postgres_serial` gates of one and a separate `broker_mutation` gate of one. Pressure reduces new `compute_readonly` admission to one; every shared-context, compute, and PostgreSQL workflow still counts toward the hard two-workflow non-mutating total. A node becomes terminal for readiness only after its injected `persistTerminal()` call succeeds under the PostgreSQL serial gate; a `postgres_serial` node persists before releasing its existing gate ownership, while every other class acquires the gate for persistence. Check abort before every admission and do not use unbounded `Promise.all`.

- [ ] **Step 4: Implement exact pressure thresholds**

```js
availableMemoryBytes < 1024 ** 3
loadAverageOneMinute > 2.5
postgresLatencyMs > configuredPostgresLatencyMs
workerStateLatencyMs > configuredStateLatencyMs
providerThrottled === true
priorWorkflowTimedOut === true
heartbeatOrFenceRisk === true
diskFreeRatio < 0.10
fileDescriptorRatio >= 0.90
```

Never kill a running second workflow. Require five pressure-free samples and a 60-second cooldown before returning to two.

- [ ] **Step 5: Add boundary and recovery tests**

Test exactly 1 GiB and exactly 2.5 as non-pressure boundaries. Assert sanitized fallback/recovery telemetry contains reason, configured/effective limits, and timestamp.

- [ ] **Step 6: Implement bounded registry retries**

Retry only reason codes declared in the immutable registry entry, never exceed `maxAttempts`, and sleep only the declared bounded backoff with abort support. Never retry a broker mutation after submission may have occurred; an indeterminate mutation instead enters reconciliation and latches later mutation. Persist attempt number and terminal `RETRY_EXHAUSTED` evidence.

- [ ] **Step 7: Implement terminal-dependency readiness**

Admit after every enabled direct dependency has any terminal result; ignore dependency edges to nodes disabled by the frozen cycle configuration. Resolve declared input bindings only from allowlisted scalar fields in terminal outputs. An `error`, `blocked`, `deferred`, or `no_action` dependency cannot cancel an unrelated node; a node whose own required binding is absent terminates explicitly without affecting peers. Return one terminal result per enabled registry entry and one non-terminal registry-decision record per disabled entry.

- [ ] **Step 8: Add forced-failure tests**

Fail `proposal.zero_dte`, `proposal.leaps`, `entry.zero_dte`, and `exit.review.hedge` separately. Prove the other proposal lanes, unrelated compartments, and `recover.final` still run. Exhaust a two-attempt local retry and assert later ready compartments continue. A local error plus healthy results is `partial`.

- [ ] **Step 9: Run and commit**

Run: `npx tsx --test tests/boundedWorkflowScheduler.test.ts`

Expected: PASS.

```bash
git add scripts/lib/bounded-workflow-scheduler.mjs tests/boundedWorkflowScheduler.test.ts
git commit -m "Add bounded compartment scheduler"
```

### Task 3: Split Daily Research into Independent Proposal Lanes

**Files:**
- Modify: `src/services/canonicalWorkstreamResult.ts`
- Modify: `src/services/investmentOrchestratorService.ts`
- Modify: `src/services/postgresResearchWorkflowService.ts`
- Modify: `src/postgresOnlyCli.ts`
- Modify: `tests/canonicalWorkstreamResult.test.ts`
- Modify: `tests/investmentOrchestratorService.test.ts`
- Modify: `tests/postgresResearchWorkflowService.test.ts`

**Interfaces:**
- Produces: `preparePostgresResearchWorkflow(input)`, `runPostgresResearchLane(input)`, and `finalizePostgresResearchWorkflow(input)`.
- Consumes: one fenced `researchRunId`, exact lane, and persisted prepared evidence through repeated `research:daily` invocations.

- [ ] **Step 1: Write failing four-lane contract tests**

Extend `WorkstreamLane` with `options_standard` and extend `WorkstreamOutcome` to exactly `success | no_action | deferred | blocked | error`. Assert the enabled set is exactly `equity`, `options_standard`, `options_0dte`, and `options_leaps`; each stable lane ID produces one terminal result; and standard-option proposals are no longer appended outside the canonical lane result collection.

- [ ] **Step 2: Write failing staged-research tests**

Prepare one research run, invoke all four lane functions with the returned `researchRunId`, then finalize their terminal records. Use deferred promises to prove two injected lane invocations may overlap. Force 0DTE failure and assert LEAPS, standard-option, and equity records and proposals survive; repeat with LEAPS failure. In an options-disabled case, assert only equity is enabled and finalize does not wait for the three disabled option lanes.

- [ ] **Step 3: Run and verify RED**

Run: `npx tsx --test tests/canonicalWorkstreamResult.test.ts tests/investmentOrchestratorService.test.ts tests/postgresResearchWorkflowService.test.ts`

Expected: FAIL because standard options are outside `WorkstreamLane` and research is monolithic.

- [ ] **Step 4: Persist a reusable prepared research run**

Move shared provider/database acquisition, feature construction, target writes, and immutable configuration/evidence fingerprints into `preparePostgresResearchWorkflow()`. Under the existing fence, persist a prepared marker and return only bounded references:

```ts
type PreparedPostgresResearch = {
  readonly cycleId: string;
  readonly researchRunId: string;
  readonly evidenceFingerprint: string;
  readonly enabledLanes: readonly WorkstreamLane[];
};
```

The prepare stage executes once. Lane stages load the same prepared rows by exact `researchRunId`; they do not refetch Alpaca data or select unrestricted latest evidence.

- [ ] **Step 5: Implement one-lane evaluation and terminal persistence**

`runPostgresResearchLane()` accepts exactly one lane and maps it to exactly one family: `equity -> equity`, `options_standard -> standard_option`, `options_0dte -> zero_dte_spy`, and `options_leaps -> leaps`. Return one canonical result carrying cycle ID, research-run ID, and lane. The outer worker persists that result as the node's authoritative terminal `workstream_event` before downstream readiness. Replay returns the existing terminal result; conflicting re-execution fails closed. A lane exception becomes only that lane's sanitized `error` terminal.

- [ ] **Step 6: Implement the terminal finalize join**

`finalizePostgresResearchWorkflow()` reads exact-cycle terminal worker events for all enabled `proposal.*` IDs, requires their `researchRunId` binding to match, returns proposals only from successful lane records, and retains all error/no-action/deferred reason codes. It never re-runs a lane and never turns a local lane failure into a global mutation block.

- [ ] **Step 7: Route stages through the existing production command**

In `postgresOnlyCli.ts`, support:

```bash
npm run research:daily -- --stage=prepare --cycleId=<uuid> --format=json
npm run research:daily -- --stage=lane --cycleId=<uuid> --researchRunId=<id> --lane=<lane> --format=json
npm run research:daily -- --stage=finalize --cycleId=<uuid> --researchRunId=<id> --format=json
```

Reject missing/unknown stages, IDs, and lanes before work. Preserve the current unstaged invocation as a bounded compatibility wrapper for operator use, but the autonomous registry may only use explicit stages. The command remains one PostgreSQL-only, production, required command in the contract.

- [ ] **Step 8: Run focused tests and commit**

Run: `npx tsx --test tests/canonicalWorkstreamResult.test.ts tests/investmentOrchestratorService.test.ts tests/postgresResearchWorkflowService.test.ts tests/postgresOnlyAuthority.test.ts`

Expected: PASS; shared preparation occurs once and each lane has independent terminal evidence.

```bash
git add src/services/canonicalWorkstreamResult.ts src/services/investmentOrchestratorService.ts src/services/postgresResearchWorkflowService.ts src/postgresOnlyCli.ts tests/canonicalWorkstreamResult.test.ts tests/investmentOrchestratorService.test.ts tests/postgresResearchWorkflowService.test.ts tests/postgresOnlyAuthority.test.ts
git commit -m "Split research into independent proposal lanes"
```

### Task 4: Concurrent Worker-State Lifecycle Persistence

**Files:**
- Modify: `src/services/autonomousWorkerStateService.ts:38-52,383-615`
- Modify: `tests/autonomousWorkerStateService.test.ts`

**Interfaces:**
- Consumes: `payload.workflowId` and `payload.workstream` for every workstream event.
- Produces: independent transitions per `(cycleId, workflowId)` and a cycle terminal only after no compartment remains open.

- [ ] **Step 1: Write failing concurrent lifecycle tests**

Persist `cycle_started`; start `proposal.equity` and `exit.review.paper` before either completes; complete them in reverse order. Assert both are valid. Assert a completion cannot close a different workflow ID, including repeated reconciliation commands.

- [ ] **Step 2: Run and verify RED**

Run: `npx tsx --test tests/autonomousWorkerStateService.test.ts`

Expected: FAIL because the service reads only the global latest event.

- [ ] **Step 3: Query prior state by workflow ID**

```sql
SELECT event_type, payload->>'workflowId' AS workflow_id,
       payload->>'workstream' AS workstream
FROM workstream_events
WHERE workstream = 'autonomous_worker'
  AND entity_id = $1
  AND payload->>'workflowId' = $2
ORDER BY occurred_at DESC, event_id DESC
LIMIT 1
FOR UPDATE
```

Require `null -> workstream_started -> workstream_completed|workstream_failed` independently per ID.

- [ ] **Step 4: Validate cycle terminal separately**

Require `cycle_started` and reject a terminal event with `AUTONOMOUS_WORKER_COMPARTMENTS_ACTIVE` while any workflow's latest event remains `workstream_started`.

- [ ] **Step 5: Preserve replay, fencing, and restart semantics**

Keep replay idempotence and fence validation. Orphan recovery records sanitized open workflow IDs/counts instead of assuming one active child. Concurrent callers are accepted, but the outer scheduler serializes their authoritative state writes and awaits each terminal event before releasing downstream readiness.

- [ ] **Step 6: Run and commit**

Run: `npx tsx --test tests/autonomousWorkerStateService.test.ts`

Expected: PASS, including retry, replay, redaction, and fence loss.

```bash
git add src/services/autonomousWorkerStateService.ts tests/autonomousWorkerStateService.test.ts
git commit -m "Persist concurrent workflow compartments safely"
```

### Task 5: Worker Graph Integration and Fault Isolation

**Files:**
- Modify: `scripts/autonomous-paper-worker.mjs`
- Modify: `tests/autonomousPaperWorker.test.ts`

**Interfaces:**
- Consumes: registry and scheduler.
- Produces: one outer terminal result per workflow ID and cycle status `complete`, `partial`, `blocked`, or `failed`.

- [ ] **Step 1: Extend the fake command harness**

Use one active file per PID. Log start/completion time, command, workflow ID, and active count. Add command-delay and command-failure maps for deterministic overlap.

- [ ] **Step 2: Write failing worker integration tests**

Delay the `proposal.equity` staged `research:daily` invocation and `exit.review.paper`; assert overlap and no third non-mutating workflow. Force `proposal.zero_dte` failure and separately `proposal.leaps` failure; assert the other three proposal nodes, exits, final reconciliation, learning, and recovery still terminate. Assert `research.prepare` runs once and `research.finalize` receives four terminal records.

- [ ] **Step 3: Run and verify RED**

Run: `npx tsx --test tests/autonomousPaperWorker.test.ts`

Expected: FAIL because the worker is sequential and fails fast on ordinary errors.

- [ ] **Step 4: Execute the registry**

Retain runtime/contract preflight. Create a cycle `AbortController`, execute the graph, and inject the existing command runner. Pass `AUTONOMOUS_CYCLE_ID`, `AUTONOMOUS_WORKFLOW_ID`, and `AUTONOMOUS_WORKSTREAM` to every child.

- [ ] **Step 5: Persist scheduling evidence**

Each lifecycle payload includes workflow ID, scheduler identity, compartment, lane, enablement decision, resource class, dependencies, input-binding references, attempt number, queue wait, configured/effective concurrency, timestamps, duration, classification, code, reason, evidence references, context requirement, fence, and mutation state. Route starts and terminals through one scheduler-owned PostgreSQL state-write queue; never mark a node ready for dependents before its terminal event is durable. A terminal-persistence failure latches the global mutation block.

- [ ] **Step 6: Classify local and global results**

Runner unavailable, timeout, provider/scoring/qualification failure, and known broker rejection are local. Paper/live violations, authority mismatch, lost fence, authoritative state failure, inconsistent shared truth, invalid command contract, indeterminate mutation, and failed process-group shutdown set the global mutation block.

- [ ] **Step 7: Assert cycle status mapping**

- All healthy/no-action results: `complete`.
- Local error plus healthy terminal work: `partial`.
- Global mutation block plus preserved evidence: `blocked`.
- Preflight or unrecoverable terminal-persistence failure: `failed`.

- [ ] **Step 8: Run and commit**

Run: `npx tsx --test tests/boundedWorkflowScheduler.test.ts tests/autonomousPaperWorker.test.ts`

Expected: PASS.

```bash
git add scripts/autonomous-paper-worker.mjs tests/autonomousPaperWorker.test.ts
git commit -m "Run autonomous workflows as fault compartments"
```

### Task 6: Broker-Mutation Gate and Reconciliation

**Files:**
- Modify: `scripts/lib/bounded-workflow-scheduler.mjs`
- Modify: `scripts/autonomous-paper-worker.mjs`
- Modify: `tests/boundedWorkflowScheduler.test.ts`
- Modify: `tests/autonomousPaperWorker.test.ts`

**Interfaces:**
- Produces: one-slot mutation admission and cycle-local `mutationBlockedReason`.
- Preserves: mutation receipt validation and lookup-oriented reconciliation.

- [ ] **Step 1: Write failing mutation tests**

Make `entry.paper` and `entry.zero_dte` ready together and delay both. Assert no overlap while non-broker work may run. Return `submission_transport_unknown` and assert later mutations block while reconciliation, learning, and recovery continue.

- [ ] **Step 2: Test known rejection isolation**

Return an acknowledged rejection with a valid receipt. Assert it is local and a later reviewed mutation may run after reconciliation.

- [ ] **Step 3: Run and verify RED**

Run: `npx tsx --test tests/boundedWorkflowScheduler.test.ts tests/autonomousPaperWorker.test.ts`

Expected: FAIL until the dedicated gate and latch exist.

- [ ] **Step 4: Implement one-slot admission**

Every `broker_mutation` node acquires a FIFO semaphore with capacity one and rechecks the latch immediately before spawn. Runtime output cannot promote mutation authority.

- [ ] **Step 5: Preserve reconciliation barriers**

Use registered entry, exit, and final reconciliation nodes. Only an indeterminate mutation triggers immediate internal lookup reconciliation before gate release; attach it as `postMutationReconciliation`.

- [ ] **Step 6: Run lifecycle suites and commit**

Run: `npx tsx --test tests/autonomousPaperWorker.test.ts tests/autonomousPostgresExecutionService.test.ts tests/autonomousTradeLifecycleService.test.ts tests/postgresReconciliationService.test.ts`

Expected: PASS.

```bash
git add scripts/lib/bounded-workflow-scheduler.mjs scripts/autonomous-paper-worker.mjs tests/boundedWorkflowScheduler.test.ts tests/autonomousPaperWorker.test.ts
git commit -m "Serialize autonomous broker mutations"
```

### Task 7: Multi-Process Shutdown and Full Verification

**Files:**
- Modify: `scripts/autonomous-paper-worker.mjs`
- Modify: `tests/autonomousPaperWorker.test.ts`
- Modify: `server/systemd/alpaca-autonomous-paper.service`
- Modify: `server/README.md`
- Modify: `README.md`
- Modify: `RESUME_CONTEXT.md`

**Interfaces:**
- Produces: bounded shutdown for every active workstream group and documented rollback.

- [ ] **Step 1: Write a failing two-process SIGTERM test**

Start two delayed workflows, each with a descendant. Send SIGTERM and assert admission stops, both groups receive SIGTERM, bounded SIGKILL covers survivors, and `worker_stopped` persists only after neither group exists.

- [ ] **Step 2: Track process groups by workflow ID**

Replace the single child variable with `Map<string, ChildProcess>`. Schedule one bounded force-kill timer per survivor. State-command children may finish within `STATE_PERSIST_TIMEOUT_MS` but cannot spawn work.

- [ ] **Step 3: Validate systemd timing without restart**

Ensure `TimeoutStopSec` exceeds the 25-second maximum force-kill delay plus 60-second state-persistence timeout. Keep `ExecStart` unchanged unless explicit `--compute-concurrency=2` improves audit clarity. Run `systemd-analyze verify` when available; retain static tests otherwise.

- [ ] **Step 4: Update documentation**

Document the readiness graph, outcomes, limits, fallback/cooldown, mutation latch, shutdown, and rollback to the exact Plan 1 completion SHA, which retains the sequential worker while remaining compatible with migration 010. A post-migration rollback must never target a pre-Plan-1 SHA, and rollback does not reverse migration 010.

- [ ] **Step 5: Run focused and authority gates**

```bash
npx tsx --test tests/autonomousWorkerRegistry.test.ts tests/boundedWorkflowScheduler.test.ts tests/autonomousWorkerStateService.test.ts tests/autonomousPaperWorker.test.ts
npx tsx --test tests/postgresOnlyAuthority.test.ts tests/autonomousPostgresExecutionService.test.ts tests/autonomousTradeLifecycleService.test.ts tests/postgresReconciliationService.test.ts tests/postgresOrderCancellationService.test.ts
```

Expected: PASS without a broker connection.

- [ ] **Step 6: Run broad gates and broker-disabled soak**

Run `npm run typecheck`, `npm run build`, `npm test`, and `git diff --check`. Then run 25 fake-provider `--once` cycles with randomized 10-100 ms delays and local failures. Assert non-broker concurrency never exceeds two, broker concurrency never exceeds one, every workflow terminates, and no child survives.

- [ ] **Step 7: Commit documentation and unit changes**

```bash
git add scripts/autonomous-paper-worker.mjs tests/autonomousPaperWorker.test.ts server/systemd/alpaca-autonomous-paper.service server/README.md README.md RESUME_CONTEXT.md
git commit -m "Harden compartment worker operation"
```

## Plan 2 Completion Gate

Do not deploy after this plan. Report the exact integrated SHA, focused/broad evidence, maximum observed non-broker and broker concurrency, fallback evidence, shutdown evidence, and unavailable systemd tooling. Migration, push, deployment, and restart require separate authorization.
