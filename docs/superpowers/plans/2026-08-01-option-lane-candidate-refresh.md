# Option Lane Candidate Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve independently eligible 0DTE and LEAPS proposals and refresh the exact selected option/SIP evidence pair once before review, without weakening paper-only safeguards.

**Architecture:** Extend PostgreSQL feature output with lane-separated call/put candidates and expand them into independent research targets before persistence. Align executable option quote freshness with the existing 1,800-second autonomous evidence constant; review remains a PostgreSQL-only consumer and stale evidence still fails closed.

**Tech Stack:** TypeScript, Node.js test runner through `tsx`, PostgreSQL repositories, Alpaca paper SIP/OPRA data providers, autonomous worker scheduler.

## Global Constraints

- Paper environment only; live trading remains disabled.
- PostgreSQL remains the sole operational authority.
- Keep the market-evidence freshness limit at exactly 1,800 seconds.
- No fallback feed, synthesized quote, repeated refresh retry, or manufactured broker order.
- Existing sizing, $5,000 LEAPS entry ceiling, portfolio arbitration, signed review, idempotency, and order-manager authority remain unchanged.
- Preserve unrelated `.codex/` machine state and existing user work.

---

### Task 1: Lane-separated option targets

**Files:**
- Modify: `src/services/postgresFeatureTargetService.ts`
- Modify: `src/services/postgresResearchWorkflowService.ts`
- Test: `tests/postgresFeatureTargetService.test.ts`
- Test: `tests/postgresResearchWorkflowService.test.ts`

**Interfaces:**
- Produces: lane-specific target objects whose `optionsStrategy.optionsCandidate` is the best eligible call or put for `zero_dte_spy`, `leaps`, or `standard_option`.
- Consumes: existing option eligibility, selection score, New York date, and configured LEAPS DTE range.

- [x] **Step 1: Write a failing feature-target regression test**

Build SPY fixtures containing an eligible same-day call and a higher-scoring longer-dated call. Assert that the result exposes both lane-specific candidates and that the 0DTE candidate expiration equals the hand-authored New York trading date.

- [x] **Step 2: Run the focused test and verify RED**

Run the explicit bundled Node/tsx command for `tests/postgresFeatureTargetService.test.ts`. Expected: FAIL because only the global call/put candidates exist.

- [x] **Step 3: Implement minimum lane bucketing**

Rank already-eligible contract features inside call/put plus expiration-family buckets. Reuse existing eligibility and ordering; expose lane candidates without changing global feature metrics.

- [x] **Step 4: Verify existing research persistence coverage**

The existing research tests already assert independent `zero_dte_spy` and
production LEAPS classification from generated targets; no duplicate mock-only
test was added.

- [x] **Step 5: Run the research suite**

Run `tests/postgresResearchWorkflowService.test.ts`. Observed: 23/23 pass after
lane target expansion, including both 0DTE and LEAPS classification coverage.

- [x] **Step 6: Expand lane targets before candidate evaluation**

Create deterministic lane-target variants using the existing target direction and candidate scoring. Ensure candidates retain distinct source fingerprints, option symbols, evidence profiles, and strategy families.

- [x] **Step 7: Run both focused suites and verify GREEN**

Expected: all existing and new feature/research tests pass with no execution-service call.

### Task 2: Unified autonomous option freshness

**Files:**
- Modify: `src/services/optionQuoteNormalizer.ts`
- Test: `tests/optionQuoteNormalizer.test.ts`
- Test: `tests/postgresReviewWorkflowService.test.ts`

**Interfaces:**
- Produces: an option quote default equal to `AUTONOMOUS_MARKET_DATA_FRESHNESS_MS`.
- Consumes: the existing autonomous 1,800-second freshness policy.

- [x] **Step 1: Write a failing default-policy test**

Assert the default option quote age is 1,800,000 milliseconds.

- [x] **Step 2: Run the test and verify RED**

Observed: 900,000 did not equal 1,800,000.

- [x] **Step 3: Align the default with the shared constant**

Use `AUTONOMOUS_MARKET_DATA_FRESHNESS_MS` as the option normalizer fallback while preserving an explicit positive `OPTIONS_QUOTE_MAX_AGE_MS` override.

- [x] **Step 4: Preserve the boundary rejection test**

Update the obsolete 15-minute review test to prove 30 minutes plus one second remains rejected.

- [x] **Step 5: Run option and review suites and verify GREEN**

Observed: normalizer passes 8/8; review passes with the 1,800-second boundary intact.

### Task 3: Documentation and full verification

**Files:**
- Modify: `tests/postgresReviewWorkflowService.test.ts`
- Modify: `README.md`
- Modify: `RESUME_CONTEXT.md`

- [x] **Step 1: Update operational documentation**

Document lane-separated selection, unified freshness policy, natural-cycle
validation, and rollback boundaries in `README.md` and `RESUME_CONTEXT.md`.

- [x] **Step 2: Run verification**

Run focused suites, full `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, and `npm run dashboard:build` through the explicit bundled runtime. Run `git diff --check` and verify the import graph contains no new order-manager authority.

- [ ] **Step 3: Commit and push implementation**

Stage only the plan, implementation, tests, and synchronized documentation. Exclude `.codex/`. Commit with a terse repair message, push the current branch, and verify the remote SHA exactly.
