# 0DTE Exposure and LEAPS Allocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permit SPY equity to coexist with a distinct SPY 0DTE contract and raise the paper LEAPS per-entry cap to $7,500 without weakening exact-contract or portfolio safeguards.

**Architecture:** Preserve the pure portfolio arbitrator and correct only its review-context adapter: scalar position counts are a compatibility fallback when aggregate positions are absent, never an override of authoritative exact-position data. Update the existing paper-only LEAPS allocation resolver and checked-in worker environment to the approved $7,500 value.

**Tech Stack:** TypeScript, Node test runner through `tsx`, PostgreSQL review adapter, systemd unit configuration.

## Global Constraints

- Paper trading only; live trading remains disabled.
- PostgreSQL remains the sole operational authority.
- No broker mutation, schema change, threshold change, research change, or deployment.
- Exact option positions, active orders, pending commitments, cash, buying power, portfolio capacity, and risk limits remain enforced.
- LEAPS per-entry allocation is exactly $7,500.

---

### Task 1: Preserve exact 0DTE position identity

**Files:**
- Modify: `tests/postgresReviewWorkflowService.test.ts`
- Modify: `src/services/postgresReviewWorkflowService.ts`

**Interfaces:**
- Consumes: `ReviewSourceRow.current_positions`, `ReviewSourceRow.open_position_count`, and `portfolioResourceContext()`.
- Produces: authoritative exact-position arbitration context without scalar-count false positives.

- [ ] **Step 1: Write the failing tests**

Add one review-workflow case with a SPY 0DTE candidate, an authoritative
`current_positions` array containing only SPY equity, and
`open_position_count: "1"`; assert that a review and intent are created. Add a
sibling case whose aggregate contains the exact option symbol and assert
`ARBITRATION_SKIPPED_SYMBOL_EXPOSURE`. Retain the existing missing-aggregate
scalar-count regression.

- [ ] **Step 2: Run the focused test to verify RED**

Run:
`tsx --test --test-name-pattern='0DTE.*SPY equity|exact 0DTE contract|held/open-order' tests/postgresReviewWorkflowService.test.ts`

Expected: the SPY-equity coexistence case fails because the scalar count still
synthesizes an exact option position.

- [ ] **Step 3: Implement the minimal adapter correction**

In `portfolioResourceContext()`, synthesize legacy count-based positions only
when `shared.current_positions` is absent. Do not change arbitrator conflict
logic or any downstream safety check.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run the same command and require zero failures.

### Task 2: Raise LEAPS per-entry allocation to $7,500

**Files:**
- Modify: `tests/leapsEntryAllocationService.test.ts`
- Modify: `tests/autonomousPaperWorker.test.ts`
- Modify: `src/services/leapsEntryAllocationService.ts`
- Modify: `server/systemd/alpaca-autonomous-paper.service`

**Interfaces:**
- Consumes: `LEAPS_MAX_ENTRY_CAPITAL_USD` in the paper worker environment.
- Produces: `resolveLeapsEntryAllocation()` and `sizeLeapsEntry()` behavior bounded at $7,500.

- [ ] **Step 1: Write the failing allocation tests**

Update behavioral expectations to default to $7,500, accept an exact $7,500
configuration, reject $7,500.01 and larger values, and size affordable whole
contracts within $7,500. Update the worker-unit expectation to require the
explicit $7,500 environment value.

- [ ] **Step 2: Run the focused tests to verify RED**

Run:
`tsx --test tests/leapsEntryAllocationService.test.ts tests/autonomousPaperWorker.test.ts`

Expected: failures report the existing $5,000 default/maximum and worker
environment.

- [ ] **Step 3: Implement the minimal allocation change**

Set `DEFAULT_LEAPS_MAX_ENTRY_CAPITAL_USD` and the checked-in worker environment
to `7_500`/`7500`; keep all paper-only validation and sizing formulas unchanged.

- [ ] **Step 4: Run the focused tests to verify GREEN**

Run the same command and require zero failures.

### Task 3: Synchronize documentation and verify the release candidate

**Files:**
- Modify: `README.md`
- Modify: `RESUME_CONTEXT.md`

**Interfaces:**
- Consumes: approved behavior and verified test evidence.
- Produces: current operator documentation and exact verification record.

- [ ] **Step 1: Update current LEAPS documentation**

Replace only the current autonomous LEAPS $5,000 cap references with $7,500
and document that authoritative exact option positions, rather than underlying
equity alone, drive 0DTE position conflicts.

- [ ] **Step 2: Run affected and static gates**

Run:
`tsx --test tests/leapsEntryAllocationService.test.ts tests/portfolioResourceArbitrator.test.ts tests/postgresReviewWorkflowService.test.ts tests/autonomousPaperWorker.test.ts`

Then run `npm run typecheck`, `npm run build`, and `git diff --check`.

- [ ] **Step 3: Review the exact diff and scan for secrets**

Inspect `git diff --stat`, `git diff`, and changed paths. Search the exact diff
for credential-shaped material without printing environment files or secrets.

- [ ] **Step 4: Obtain independent review and commit**

Request read-only review of the exact diff. Correct any validated finding,
rerun affected gates, then create one verified implementation commit and report
its exact SHA. Do not deploy it.
