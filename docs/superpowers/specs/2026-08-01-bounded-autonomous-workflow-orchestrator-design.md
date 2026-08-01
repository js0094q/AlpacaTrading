# Bounded Autonomous Workflow Orchestrator Design

**Status:** Approved architecture; implementation planning pending user review
**Date:** 2026-08-01
**Selected approach:** Approach B — one compartmentalized orchestrator with two bounded non-mutating compute slots

## Purpose

Replace the autonomous worker's predominantly linear command loop with one canonical, PostgreSQL-fenced workflow orchestrator that invokes every enabled production workflow, uses the upgraded VPS capacity safely, preserves lane identity from evidence through learning, compartmentalizes workflow failures, and keeps all broker mutation globally serialized.

The design covers equity, standard options, SPY 0DTE, SPY/QQQ LEAPS, portfolio review, hedging, exits, reconciliation, cancellation, learning, recovery, and worker-state persistence. It does not authorize deployment, a service restart, environment changes, live trading, or a validation order.

## Confirmed deployment profile

- 3 CPU cores, 4.5 GB RAM, 45 GB disk, and 4.5 TB monthly traffic.
- One `alpaca-autonomous-paper.service` supervisor.
- PostgreSQL is the sole operational authority.
- Paper mode is required and live trading remains disabled.
- Non-mutating concurrency defaults to `2` and may never exceed `2`.
- Resource pressure automatically reduces new compute admission to `1`.
- Every broker-mutating operation remains globally serialized.

The third CPU core is reserved for the supervisor, dashboard control, operating system, SSH, logging, shutdown, and recovery. Added traffic and disk do not justify duplicate provider downloads or unbounded retention.

## Current-state findings

The outer worker executes 20 positions sequentially, and the inner investment orchestrator executes `equity`, `options_0dte`, and `options_leaps` sequentially. This leaves upgraded capacity idle during network and database waits and makes dependencies implicit.

The deployed lane repair creates distinct in-memory `zero_dte_spy`, `leaps`, and `standard_option` targets. PostgreSQL currently keys `target_snapshots` and `options_strategy_snapshots` only by `(symbol, as_of, risk_profile)`, so sequential upserts can collapse multiple same-symbol lanes. Candidate generation in the active transaction may retain lane identity, but the durable target audit trail does not. This design includes an additive lane-aware persistence repair.

Read-only production evidence confirms upstream inventory is not empty: PostgreSQL contains 340 next-session SPY contracts and 6,948 SPY/QQQ contracts in the configured LEAPS window. Natural market-hours snapshots and decisions remain the end-to-end proof.

## Design principles

1. One supervisor owns one cycle identity.
2. One checked-in registry declares every production workflow and only its direct dependencies.
3. Shared evidence is loaded once, frozen, versioned, and fanned out.
4. At most two non-mutating workflows execute concurrently across independent fault compartments.
5. Portfolio allocation runs once after every enabled proposal compartment has a terminal record; successful proposals remain eligible when another compartment fails locally.
6. Broker mutation is globally serialized and exact-client-ID reconciled.
7. PostgreSQL fencing remains authoritative for leases and writes.
8. Each workflow compartment owns its status, timeout, retry budget, evidence, and terminal result; lane-local failures do not cancel unrelated work.
9. Safety, authority, fence, persistence, and indeterminate-mutation failures block all later broker mutation without cancelling compartment evidence collection.
10. Every enabled workflow emits terminal, sanitized, queryable evidence.

## Canonical workflow registry

Each typed registry entry declares a stable workflow ID, command or executor, phase, direct dependency IDs, resource class, fault compartment, lane, scheduler identity, enablement predicate, required runtime flags, timeout, retry policy, expected no-action reasons, failure scope, and shared-context requirement. Registry edges are narrow data or safety prerequisites, not implicit sequencing between peer compartments.

Startup compares this registry with `scripts/autonomous-worker-command-contract.json` and `package.json`. A required enabled command that is missing, unregistered, SQLite-backed, non-production, or assigned an invalid resource class fails startup closed.

The initial registry must account for every command in the current production loop: `zero-dte:reconcile`, `research:daily`, `paper:options:discover`, `paper:review`, `paper:portfolio:review`, `paper:ops:review`, `hedge:review`, `paper:execute:reviewed`, `zero-dte:engine`, `paper:exit:review`, `zero-dte:exit:review`, `hedge:exit:review`, `paper:exit:execute`, `hedge:exit:execute`, `paper:order:cancel`, `paper:learn`, `system:recover`, and `worker:state`. Repeated reconciliation or recovery barriers are represented as explicit graph invocations of the same registered workflow, not as undeclared duplicate nodes. If the command contract changes, registry completeness tests must change in the same commit.

## Execution graph

The graph is a readiness graph, not a failure-propagation chain. Equity, standard options, SPY 0DTE, SPY/QQQ LEAPS, hedging, exits, cancellation, reconciliation, recovery, and learning are independently scheduled compartments. A compartment becomes ready when its own direct prerequisites are satisfied. Failure, timeout, deferral, or no-action in one compartment does not cancel an unrelated ready or active compartment.

### Phase 1: preflight and recovery

1. Persist `cycle_started`.
2. Validate paper mode, live-off flags, PostgreSQL authority, and the runtime audit gate.
3. Verify the command contract and workflow registry.
4. Recover bounded stale PostgreSQL lifecycle state.
5. Reconcile current paper broker and PostgreSQL order state.
6. Load immutable shared cycle context.

### Phase 2: proposal-producing analysis

Eligible independent compartments share the two compute slots:

- equity research and scoring;
- standard-option evaluation;
- SPY 0DTE evaluation;
- SPY/QQQ LEAPS evaluation;
- paper option discovery;
- hedge-review inputs;
- enabled observatory and diagnostic inputs.

Every compartment emits a canonical `WorkstreamResult` with evidence references and explicit success, no-action, deferred, blocked, or error reasons. The scheduler continues admitting unrelated ready compartments after a lane-local failure.

### Phase 3: portfolio decision join

The orchestrator waits for every enabled proposal compartment to emit a terminal record, then runs one serialized decision stage over the successful proposal subset plus the complete set of failure, no-action, deferred, and blocked records:

1. Normalize proposals without erasing lane identity.
2. Validate evidence freshness and completeness.
3. Deduplicate incompatible same-symbol proposals.
4. Apply positions, open orders, and reservations.
5. Apply reserve, deployment, position, sleeve, strategy, daily, premium, LEAPS, and 0DTE limits.
6. Run allocation, general paper, portfolio, paper-operations, and hedge reviews in declared order.
7. Persist every selected, rejected, skipped, blocked, and deferred decision.

Healthy independent lanes survive lane-local failure. A failed 0DTE compartment does not cancel LEAPS, equity, standard options, hedging, exits, or reconciliation; the same isolation applies in every direction. Portfolio review may approve healthy proposals when their own evidence and the shared risk state are valid. Account-truth, risk-configuration, authority, fence, and paper/live failures invalidate mutation eligibility globally, but still produce explicit compartment results and do not erase completed evidence.

### Phase 4: globally serialized mutation

One `broker_mutation` gate protects reviewed entries, the reviewed 0DTE path, reviewed equity/option exits, reviewed hedge exits, autonomous cancellation, and any future broker-mutating workflow.

Each mutation must reconcile state, revalidate the fence and configuration versions, claim exactly one intent, persist reservation/idempotency evidence, submit at most once with a deterministic client order ID, persist a mutation receipt, reconcile the outcome, and resolve the reservation before another intent is considered. An indeterminate outcome blocks all later mutation until reconciliation resolves it.

### Phase 5: learning and completion

- Collect bounded outcomes.
- Run paper learning independently for each compartment with sufficient outcome evidence; an absent or failed lane yields a partial learning result rather than cancelling other learning.
- Run final recovery inspection.
- Persist reconciled cycle metrics.
- Persist exactly one cycle terminal event with `complete`, `partial`, `blocked`, or `failed` status, plus one terminal record per enabled compartment.

## Resource classes

| Resource class | Maximum | Responsibility |
| --- | ---: | --- |
| `shared_context` | 1 | Clock, account, order, position, market, and configuration evidence |
| `compute_readonly` | 2 | Normalization, features, scoring, diagnostics, and proposals |
| `postgres_serial` | 1 when ordered | Allocation, lifecycle, reservation, and authoritative writes |
| `broker_mutation` | 1 globally | Paper submission, exit, cancellation, and mutation reconciliation |

Resource class is immutable registry metadata. Runtime results cannot promote privilege. Any command capable of reaching broker mutation must be registered as `broker_mutation`.

## Two-slot scheduler

Use a FIFO, abort-aware semaphore with default `2`, hard maximum `2`, and minimum `1`. Values outside `[1,2]` fail startup. There is no unbounded `Promise.all`, duplicate active workflow ID, or next-cycle overlap. Only a workflow's declared direct prerequisites affect its admission; a peer compartment's failure cannot remove an otherwise ready workflow from the queue. Queue wait, duration, and effective concurrency are recorded.

## Automatic fallback

Reduce new compute admission from two to one when bounded pressure is present:

- available memory below 1 GiB;
- sustained one-minute load average above 2.5;
- repeated PostgreSQL latency beyond configured bounds;
- provider `429` or explicit throttling;
- scheduler-heartbeat or fence-risk evidence;
- worker-state persistence latency above its safe bound;
- prior compute timeout or resource exhaustion;
- file-descriptor, task, or disk pressure near a hard limit.

Fallback never kills healthy in-progress work. Recovery to two requires a stable cooldown with all signals below recovery thresholds. Transitions are sanitized and persisted.

## Shared cycle context

Load once: market session, paper account, cash, buying power, portfolio value, positions, orders, reservations, allocations, risk and strategy fingerprints, required bars, current SIP evidence, option contracts, OPRA snapshots, feeds, timestamps, and provider request IDs.

Every proposal lane receives the same immutable evidence. Duplicate lane requests reuse it. Post-mutation reconciliation creates a new versioned context and never rewrites original research evidence.

## Lane-aware target persistence

Add an additive migration so `target_snapshots` and `options_strategy_snapshots` distinguish equity, `standard_option`, `zero_dte_spy`, `leaps`, and applicable hedge expressions.

The durable identity is `(symbol, as_of, risk_profile, strategy_family, expression_id)`. `expression_id` deterministically incorporates the option symbol or an explicit equity expression. Historical rows receive a deterministic `legacy_default` identity without fabricating a former lane.

Update database constraints, repository conflict keys, types, research-evidence keys, candidate joins, dashboard reads, schema verification, cleanup, and fixtures. Ordinary worker startup never applies this migration; a later authorized deployment applies it explicitly through the direct migration command while affected services are stopped.

## Failure handling

Lane-local provider, scoring, qualification, evidence-availability, timeout, and retry-exhaustion failures isolate only that compartment when shared state remains valid. They cannot cancel unrelated research, exits, reconciliation, recovery, or learning. Each compartment persists its own terminal result and the cycle continues with any safe ready work.

Only enumerated global invariants may block all later broker mutation: paper/live failure, authority mismatch, lost fence, authoritative persistence failure, inconsistent account/order/position/reservation/allocation/risk truth, command-contract mismatch, indeterminate mutation, or failed mutation-process shutdown. A global mutation block does not retroactively fail healthy completed compartments; the overall cycle records `blocked` or `partial` with the specific global reason.

Closed market, stale closed-market evidence, no candidate, no exit trigger, no ready intent, no cancellable order, and no recoverable state remain explicit non-fatal outcomes when existing hard gates are satisfied.

## Shutdown and recovery

On termination, stop admission, abort shared provider requests, signal every active compute process group, wait within the reviewed systemd budget, use only the existing bounded kill policy, persist terminal results, release leases after ownership stops, and persist one `worker_stopped` event. Restart resumes from PostgreSQL evidence, never repeats completed mutation, and reconciles indeterminate mutation before admitting another.

## Observability

Record cycle/workflow ID, lane, resource class, dependencies, queue/start/completion timestamps, queue wait, duration, configured/effective concurrency, fallback reason, evidence references, provider request counts, proposal/decision counts, outcome, reason codes, fence state, and mutation state.

Reconcile counts by family across:

`contracts -> snapshots -> features -> targets -> candidates -> proposals -> allocations -> reviews -> intents -> mutations -> reconciled orders -> outcomes -> learning`

Missing transitions become explicit blockers.

## Disk and traffic policy

- Bound journald size and retention age.
- Preserve the per-workstream capture limit.
- Do not retain raw provider responses indefinitely.
- Monitor free disk and block unreliable persistence before exhaustion.
- Clean builds only through the reviewed deployment process.
- Do not add swap as part of this release.
- Deduplicate provider requests and retain pagination and rate limits.
- Do not expand the universe merely to consume traffic allowance.

## Required tests

- FIFO two-slot admission, hard maximum, invalid configuration, fallback, and cooldown recovery.
- Direct-prerequisite ordering, compartmentalized join behavior, and no duplicate admission.
- Complete production command registry with no SQLite or retired timer path.
- Shared context loads once and is reused.
- Portfolio arbitration waits for terminal records from all enabled proposal compartments but accepts healthy proposals from the successful subset.
- Lane-local versus global-mutation-blocking failure classification.
- Forced 0DTE failure does not stop LEAPS, equity, standard options, exits, or reconciliation.
- Forced LEAPS failure does not stop 0DTE, equity, standard options, exits, or reconciliation.
- Lane-local provider failure and timeout do not cancel unrelated ready or active compartments.
- Partial learning proceeds for compartments with sufficient outcome evidence.
- Global mutation non-overlap and indeterminate-outcome blocking.
- Shutdown with two active process groups.
- Lane-aware target and option-strategy persistence.
- Same-symbol equity, standard-option, 0DTE, and LEAPS targets coexist.
- Research evidence, candidates, dashboards, and learning retain lane identity.

## Production-shaped acceptance

- Full test, typecheck, and build graph passes.
- Migration verification passes against disposable PostgreSQL.
- Broker-disabled soak testing exercises two slots and fallback telemetry.
- Any later deployment verifies exact local, remote, and deployed SHA.
- Paper-only, live-off, PostgreSQL-only, clean-checkout posture remains intact.
- No manufactured candidate or validation order is used.
- Two natural market-hours cycles reconcile 0DTE and LEAPS through candidate decisions.
- Deployment requires separate authorization of the exact verified SHA and separately authorized restart count.

## Success criteria

1. Every enabled autonomous workflow is present in one readiness graph with only direct prerequisites.
2. No more than two non-mutating workflows run concurrently.
3. Pressure reduces new admission to one without killing healthy work.
4. Equity, standard-option, 0DTE, and LEAPS targets coexist durably.
5. Portfolio allocation observes all terminal compartment records and can act on the healthy proposal subset.
6. Broker mutation remains globally serialized and idempotent.
7. Shutdown and recovery do not duplicate work or orders.
8. Cycle evidence explains every compartment from discovery through learning and distinguishes `complete`, `partial`, `blocked`, and `failed` cycles.
9. Added compute reduces natural cycle duration without weakening safety.

## Authorization boundary

This specification authorizes design documentation only. Implementation planning follows user review. Implementation, push, migration, deployment, restart, environment changes, and broker mutation each remain subject to the repository's existing authorization boundaries.
