# Guarded Paper Hedge Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete portfolio Greeks and deploy one HMAC-reviewed, bounded, single-leg protective-put lifecycle to the Alpaca paper account while keeping live and automated hedge execution disabled.

**Architecture:** Normalize option evidence once, build explicit freshness/coverage-aware portfolio Greeks, then create a separate executable hedge review bound to one long-put order intent. Execute only on the VPS through current-state revalidation, deterministic idempotency, bounded limit-order management, and dedicated learning records; Vercel remains an authenticated proxy and dashboard.

**Tech Stack:** TypeScript, Node 22, `node:test`, SQLite, Next.js 16/React 19, Alpaca paper REST API, systemd, Vercel.

## Global Constraints

- Live trading is prohibited; no live order path may be added or enabled.
- Initial executable structure is `long_put` only; put spreads remain `MULTI_LEG_EXECUTION_UNSUPPORTED`.
- Never submit sequential spread legs.
- All execution uses limit orders and `position_intent=buy_to_open` or `sell_to_close`.
- `HEDGE_PAPER_EXECUTION_ENABLED` defaults false in code and examples until the post-deployment enable step.
- `HEDGE_LIVE_EXECUTION_ENABLED=false` and `HEDGE_AUTOMATED_PAPER_EXECUTION_ENABLED=false` are permanent deployment gates for this phase.
- Hedge orders must not enter the existing timer-owned `optionBuys` reviewed section.
- Missing numeric evidence remains `null`; preserve observed zero; reject NaN and infinity.
- Delta execution thresholds are 95% absolute market-value coverage and 90% absolute contract coverage.
- Selected contract quote and delta must be current at review and execution.
- Maximum first-run order count is one and maximum reviewed quantity is two contracts, further bounded by premium and buying power.
- No full authenticated broker response, account ID, credentials, tokens, or signing key may be persisted or returned.
- Every behavior change follows RED -> GREEN -> REFACTOR with the focused test command recorded.
- Migrations are additive, idempotent, non-destructive, and tested against clean and existing schemas.
- Existing unrelated user changes must be preserved.

---

### Task 1: Canonical option snapshot and evidence contract

**Files:**
- Create: `src/services/optionSnapshotNormalizer.ts`
- Create: `tests/optionSnapshotNormalizer.test.ts`
- Modify: `src/services/providers/alpaca.ts`
- Modify: `src/services/optionsService.ts`
- Modify: `src/lib/db.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `NormalizedOptionGreeks` and `NormalizedOptionSnapshot` exactly as specified in `docs/specs/2026-07-10-guarded-paper-hedge-execution.md`.
- Produces `normalizeOptionSnapshot(symbol, raw): NormalizedOptionSnapshot`.
- Persists canonical quote, trade, Greek, IV, snapshot timestamp, and normalization path without raw authenticated payloads.

- [ ] **Step 1: Write failing current/legacy/mixed/invalid normalization tests**

Cover current aliases, legacy aliases, field-level mixed fallback, complete/partial/missing Greeks, zero Greeks, NaN/infinity, malformed timestamps, quote sizes, trade timestamp, IV, and invalid OCC symbols. Assert a partial `greeks` object falls back field-by-field to `Greeks`.

- [ ] **Step 2: Verify RED**

Run: `npx tsx --test tests/optionSnapshotNormalizer.test.ts`

Expected: FAIL because the module and canonical output do not exist.

- [ ] **Step 3: Implement the pure normalizer**

Use `parseOptionSymbol`, finite-number parsing, valid ISO timestamp parsing, and field-level alias selection. Derive `snapshotTimestamp` from the newest valid snapshot/quote/trade observation. Return `normalizationPath` from observed alias use.

- [ ] **Step 4: Wire ingestion to the canonical contract**

Keep provider transport types permissive, call the normalizer in `optionsService`, and map only canonical fields into SQLite. Add `normalization_path` and `snapshot_timestamp` additively if current columns cannot represent them.

- [ ] **Step 5: Verify GREEN and regress option ingestion**

Run: `npx tsx --test tests/optionSnapshotNormalizer.test.ts tests/optionsDiagnosticService.test.ts tests/research.test.ts`

Expected: PASS with no compatibility regression.

- [ ] **Step 6: Commit**

Commit message: `Normalize complete option snapshot evidence`

### Task 2: Complete portfolio Greeks, IV, coverage, freshness, and groupings

**Files:**
- Modify: `src/services/hedgeConfigService.ts`
- Modify: `src/services/portfolioRiskService.ts`
- Create: `src/services/portfolioRiskEvidenceService.ts`
- Modify: `tests/hedgeConfigService.test.ts`
- Modify: `tests/portfolioRiskService.test.ts`
- Create: `tests/portfolioRiskEvidenceService.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces explicit fields `deltaShares`, `deltaDollars`, `gammaSharesPerDollar`, `thetaDollarsPerDay`, `vegaDollarsPerVolPoint`, and `rhoDollarsPerRatePoint` per option position.
- Produces coverage for `delta | gamma | theta | vega | rho | impliedVolatility` by positions, absolute contracts, and absolute option market value.
- Produces IV weighted by contracts, absolute market value, and absolute vega.
- Produces Greek groupings by underlying, expiration, option type, and DTE bucket with group-level quality.
- Produces current/stale/expired/malformed observation counts from central age policy.

- [ ] **Step 1: Write failing unit/sign/freshness/coverage tests**

Cover long call, long put, short call, short put, mixed portfolio, multiplier, signed quantity, all aggregate definitions, IV weights, no-options semantics, zero Greeks, stale boundary, expired boundary, future/malformed timestamp, missing market value, and incomplete group coverage.

- [ ] **Step 2: Verify RED**

Run: `npx tsx --test tests/hedgeConfigService.test.ts tests/portfolioRiskService.test.ts tests/portfolioRiskEvidenceService.test.ts`

Expected: FAIL because complete coverage/freshness/group fields are absent.

- [ ] **Step 3: Add central configuration**

Parse `OPTION_GREEKS_CURRENT_MAX_AGE_SECONDS`, `OPTION_GREEKS_STALE_MAX_AGE_SECONDS`, and delta execution thresholds. Validate positive finite ages and `current < stale`; otherwise use conservative defaults and emit `HEDGE_CONFIGURATION_VALUE_INVALID`.

- [ ] **Step 4: Implement DB evidence adapter**

Return canonical OCC identity, all Greeks, IV, snapshot/quote timestamps, quote status, source, and underlying-price timestamp. Expand `PortfolioRiskDeps` so tests can inject evidence without broker/network access.

- [ ] **Step 5: Implement the pure portfolio model**

Use explicit unit names and preserve nulls. A group with missing material exposure returns incomplete quality rather than a falsely small numeric total. Material delta insufficiency forces `measurementStatus=indeterminate`, `effectiveBand=indeterminate`, null scenario sizing precision, and execution ineligibility.

- [ ] **Step 6: Verify GREEN and scoring/recommendation propagation**

Run: `npx tsx --test tests/hedgeConfigService.test.ts tests/portfolioRiskService.test.ts tests/portfolioRiskEvidenceService.test.ts tests/portfolioRiskScoreService.test.ts tests/hedgeRecommendationService.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

Commit message: `Complete portfolio Greek quality gates`

### Task 3: Persisted Greek risk and dashboard read contracts

**Files:**
- Modify: `src/services/hedgeTypes.ts`
- Modify: `src/services/hedgePersistenceService.ts`
- Modify: `server/dashboard-control/server.ts`
- Modify: `apps/dashboard/lib/data.ts`
- Modify: `apps/dashboard/app/components/HedgePanel.tsx`
- Modify: `tests/hedgePersistenceService.test.ts`
- Modify: `tests/hedgeDashboard.test.ts`
- Modify: `tests/dashboardControlServer.test.ts`
- Modify: `tests/dashboardVercelBridge.test.ts`

**Interfaces:**
- Validates persisted nested `risk` against the current risk model version before treating it as current.
- `GET /api/v1/hedge/risk` propagates nested warnings, blockers, coverage, freshness, groupings, and explicit units.
- Dashboard displays portfolio Greek totals, IV metrics, per-Greek contract/value coverage, freshness, and groupings.

- [ ] **Step 1: Write failing persistence and bridge round-trip tests**

Test malformed/missing Greek payloads, model mismatch, stale evidence inside a fresh recommendation, VPS-to-Vercel JSON fidelity, and dashboard labels for all required units and paper-only state.

- [ ] **Step 2: Verify RED**

Run: `npx tsx --test tests/hedgePersistenceService.test.ts tests/hedgeDashboard.test.ts tests/dashboardControlServer.test.ts tests/dashboardVercelBridge.test.ts`

- [ ] **Step 3: Implement strict read validation and complete display**

Do not make existing GET routes mutating. Preserve stale/expired semantics and cached reads. Render missing metrics as unavailable with quality context rather than zero.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command; expected PASS.

- [ ] **Step 5: Commit**

Commit message: `Expose complete portfolio Greeks`

### Task 4: Hedge execution policy, candidate ranking, and HMAC-reviewed payload

**Files:**
- Modify: `src/services/hedgeConfigService.ts`
- Modify: `src/services/hedgeTypes.ts`
- Modify: `src/services/hedgeRecommendationService.ts`
- Create: `src/services/hedgeExecutionReviewService.ts`
- Modify: `src/services/hedgePersistenceService.ts`
- Modify: `src/lib/db.ts`
- Create: `tests/hedgeExecutionReviewService.test.ts`
- Modify: `tests/hedgeRecommendationService.test.ts`
- Modify: `tests/hedgePersistenceService.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces centralized `HedgeExecutionPolicy` with the exact defaults in the execution spec.
- Produces executable-eligibility only for `protective_put` candidates; put spreads and inverse ETFs remain non-executable.
- Produces `createHedgeExecutionReview(input, signingKey)` and `verifyHedgeExecutionReview(input, signingKey)`.
- Persists `hedge_execution_reviews` with primary `review_id` and unique `client_order_id`.

- [ ] **Step 1: Write failing policy and candidate tests**

Cover percent parsing, allowed structures/underlyings, DTE/delta/spread/premium/quantity/frequency limits, SPY-versus-QQQ ranking, current evidence, duplicate exposure, sufficient protection, and zero eligible candidates.

- [ ] **Step 2: Write failing review integrity tests**

Cover valid HMAC, wrong key, changed symbol/quantity/price/cap, expiry, account hash mismatch, environment mismatch, model/config mismatch, missing key, malformed stored JSON, and deterministic client order ID.

- [ ] **Step 3: Verify RED**

Run: `npx tsx --test tests/hedgeConfigService.test.ts tests/hedgeRecommendationService.test.ts tests/hedgeExecutionReviewService.test.ts tests/hedgePersistenceService.test.ts`

- [ ] **Step 4: Implement policy and ranking**

Rank eligible puts by expected protection per premium dollar, liquidity/spread, complete current Greeks, target DTE distance, target delta distance, and theta burden. Cap quantity by incremental need, premium budget, contract cap, and buying power; never size from buying power alone.

- [ ] **Step 5: Implement HMAC review and additive migration**

Canonicalize the payload without `payloadHash` and `signature`, calculate SHA-256 hash, then HMAC-SHA256 the hash with `HEDGE_REVIEW_SIGNING_KEY`. Store sanitized review evidence only. Every read revalidates schema, hash, and signature.

- [ ] **Step 6: Verify GREEN and migration idempotency**

Run the Step 3 command twice against temporary clean and existing-schema DB fixtures; expected PASS both times.

- [ ] **Step 7: Commit**

Commit message: `Add reviewed paper hedge payloads`

### Task 5: Shared single-leg validation, reconciliation, and idempotent reservation

**Files:**
- Create: `src/services/paperOptionOrderValidationService.ts`
- Create: `src/services/hedgeAccountReconciliationService.ts`
- Modify: `src/services/paperExecutionLedgerService.ts`
- Modify: `src/services/runtimeMutationPreflight.ts`
- Modify: `src/services/hedgeExecutionGateService.ts`
- Create: `tests/paperOptionOrderValidationService.test.ts`
- Create: `tests/hedgeAccountReconciliationService.test.ts`
- Modify: `tests/paperReviewedPayloadExecutionService.test.ts`
- Modify: `tests/paperExecuteDryRunService.test.ts`
- Create: `tests/hedgeExecutionGateService.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces one pure shared validator for active/tradable contract, option approval, DTE, quote, spread, quantity, premium, portfolio risk, and buying power.
- Produces a read-only reconciliation report comparing review, current account hash, positions, open/recent orders, and ledger.
- Produces `reservePaperExecutionAttempt` that atomically inserts the unique client order ID before submission.
- `evaluateHedgeExecutionGate` returns `allowed: boolean` and no longer appends `HEDGE_EXECUTION_NOT_IMPLEMENTED` when every implemented gate passes.

- [ ] **Step 1: Write failing validation and reconciliation tests**

Cover each hard blocker, current-position/order disagreement, duplicate client ID, recently completed duplicate, insufficient buying power, account mismatch, and no broker call on any blocked path.

- [ ] **Step 2: Write failing concurrency/idempotency test**

Launch two reservations for the same deterministic client order ID; assert exactly one succeeds and one returns `HEDGE_DUPLICATE_ORDER`.

- [ ] **Step 3: Verify RED**

Run: `npx tsx --test tests/paperOptionOrderValidationService.test.ts tests/hedgeAccountReconciliationService.test.ts tests/hedgeExecutionGateService.test.ts tests/paperReviewedPayloadExecutionService.test.ts tests/paperExecuteDryRunService.test.ts`

- [ ] **Step 4: Extract validation without changing generic behavior**

Refactor existing paper option validation to consume the shared primitive. Keep generic executor contracts and LEAPS exit behavior unchanged.

- [ ] **Step 5: Implement reconciliation and atomic reservation**

Use SQLite uniqueness and catch constraint failure rather than find-then-insert. Reconciliation is warning-only for explainable paper sync lag but blocks material account/position/order/ledger inconsistency.

- [ ] **Step 6: Implement hedge/runtime gate composition**

Require explicit confirmation, paper/live identity, paper endpoint, paper order/options flags, hedge paper flag, hedge live false, and automated hedge false.

- [ ] **Step 7: Verify GREEN and regress existing execution**

Run the Step 3 command; expected PASS.

- [ ] **Step 8: Commit**

Commit message: `Guard hedge execution state`

### Task 6: Paper hedge entry execution and bounded fill management

**Files:**
- Modify: `src/services/alpacaClient.ts`
- Create: `src/services/hedgeExecutionService.ts`
- Modify: `src/cli.ts`
- Modify: `package.json`
- Create: `tests/hedgeExecutionService.test.ts`
- Modify: `tests/hedgeCli.test.ts`

**Interfaces:**
- Adds paper-only `getPaperOrder`, `replacePaperOrder`, and `cancelPaperOrder` methods.
- Produces `executeReviewedPaperHedge({ reviewId, confirmPaper }, deps)`.
- Adds `npm run hedge:execute -- --confirmPaper --reviewId="$REVIEW_ID" --format=json`.

- [ ] **Step 1: Write failing executor tests with broker spies**

Cover paper success, live rejection, disabled flag, missing confirmation, expired/changed review, duplicate, stale/moved quote, wide spread, premium cap, rejection, partial fill, full fill, bounded repricing, terminal cancellation, and cancellation of only the submitted hedge order.

- [ ] **Step 2: Verify RED**

Run: `npx tsx --test tests/hedgeExecutionService.test.ts tests/hedgeCli.test.ts`

- [ ] **Step 3: Implement paper-only order lifecycle**

Refresh the selected snapshot immediately before every submit/replace. Never exceed reviewed quantity or premium. Poll until filled, partial terminal state, rejection, or timeout. For partial fill at timeout, cancel only the remaining reviewed order and record actual filled quantity.

- [ ] **Step 4: Add CLI and sanitized JSON/table output**

Reject missing `--confirmPaper` before broker reads. Output review/client order IDs, symbol, limits, status, filled quantity, average fill, premium, slippage, blockers, warnings, and request/correlation IDs without raw broker payloads.

- [ ] **Step 5: Verify GREEN and source-audit live isolation**

Run: `npx tsx --test tests/hedgeExecutionService.test.ts tests/hedgeCli.test.ts tests/alpacaReadOnlyIntegration.test.ts tests/cliRedaction.test.ts`

Then run: `rg -n "api\.alpaca\.markets|live-execution|HEDGE_LIVE_EXECUTION_ENABLED" src/services/hedge* src/services/alpacaClient.ts`

Expected: tests PASS; no hedge submit path can select a live host.

- [ ] **Step 6: Commit**

Commit message: `Execute bounded paper hedges`

### Task 7: Hedge exits, learning lifecycle, and outcome evaluation

**Files:**
- Create: `src/services/hedgeExitService.ts`
- Extend: `src/services/hedgeExecutionReviewService.ts`
- Extend: `src/services/hedgeExecutionService.ts`
- Extend: `src/services/hedgeLearningService.ts`
- Modify: `src/services/paperLearningLedgerService.ts`
- Modify: `src/cli.ts`
- Modify: `package.json`
- Create: `tests/hedgeExitService.test.ts`
- Create: `tests/hedgeLearningLifecycle.test.ts`

**Interfaces:**
- Adds `hedge:exit:review` and `hedge:exit:execute --confirmPaper --reviewId="$REVIEW_ID"`.
- Uses `sell_to_close`, current held hedge quantity, and a distinct exit review type/client ID namespace.
- Persists the lifecycle event set and scheduled outcome checkpoints without making hedge records eligible for unrelated promotion analytics.

- [ ] **Step 1: Write failing exit policy tests**

Cover DTE, profit target, loss limit, two risk-normalized confirmations, data-quality invalidation, manual review, no immediate post-entry exit, and one-order cap.

- [ ] **Step 2: Write failing learning tests**

Cover idempotent decision/candidate/review/submit/accept/reject/partial/fill/cancel/reprice/position/protection/exit/outcome events, sanitized execution evidence, slippage, and separate decision/selection/sizing/execution/protection/exit quality.

- [ ] **Step 3: Verify RED**

Run: `npx tsx --test tests/hedgeExitService.test.ts tests/hedgeLearningLifecycle.test.ts`

- [ ] **Step 4: Implement exit and learning services**

Reuse HMAC review and fill management. Never close more than the current reviewed hedge position. Exclude `portfolio_hedge` lifecycle rows from generic promotion pending counts.

- [ ] **Step 5: Verify GREEN and regress existing exits**

Run: `npx tsx --test tests/hedgeExitService.test.ts tests/hedgeLearningLifecycle.test.ts tests/leapsExitReviewService.test.ts tests/paperLearningLedgerService.test.ts`

- [ ] **Step 6: Commit**

Commit message: `Track paper hedge outcomes`

### Task 8: Authenticated control/API routes, dashboard actions, and review-only scheduler

**Files:**
- Modify: `server/dashboard-control/server.ts`
- Create: `apps/dashboard/app/api/paper/hedge/review/route.ts`
- Create: `apps/dashboard/app/api/paper/hedge/execute/route.ts`
- Create: `apps/dashboard/app/api/paper/hedge/exit/review/route.ts`
- Create: `apps/dashboard/app/api/paper/hedge/exit/execute/route.ts`
- Create: `apps/dashboard/app/api/paper/hedge/execution/route.ts`
- Create: `apps/dashboard/app/api/paper/hedge/learning/route.ts`
- Modify: `apps/dashboard/lib/data.ts`
- Modify: `apps/dashboard/app/components/HedgePanel.tsx`
- Modify: `src/services/paperOpsWorkflowService.ts`
- Modify: `scripts/paper-monitor-runner.mjs`
- Modify: `tests/dashboardControlServer.test.ts`
- Modify: `tests/dashboardVercelBridge.test.ts`
- Modify: `tests/hedgeDashboard.test.ts`
- Modify: `tests/paperOpsWorkflowService.test.ts`
- Modify: `tests/paperMonitoringScheduler.test.ts`

**Interfaces:**
- Adds cached GET review/execution/learning routes.
- Adds authenticated POST review/execute/exit routes with fixed command mappings and no arbitrary shell input.
- Requires `DASHBOARD_ADMIN_TOKEN` at Vercel, `VPS_CONTROL_TOKEN` to the VPS, runtime preflight, and explicit confirmation for execution.
- Scheduler refreshes/monitors/evaluates only; submission requires `HEDGE_AUTOMATED_PAPER_EXECUTION_ENABLED=true`, which remains false.

- [ ] **Step 1: Write failing route/auth/duplicate tests**

Cover unauthorized/invalid auth, live/paper guard failures, missing confirmation, stale review, duplicate used review, successful command mapping, sanitized envelopes, and no arbitrary command or raw response exposure.

- [ ] **Step 2: Write failing scheduler non-submission tests**

Prove morning/midday/late-day moments cannot call the hedge executor when automated hedge execution is false and never place hedge intents in `optionBuys`.

- [ ] **Step 3: Verify RED**

Run: `npx tsx --test tests/dashboardControlServer.test.ts tests/dashboardVercelBridge.test.ts tests/hedgeDashboard.test.ts tests/paperOpsWorkflowService.test.ts tests/paperMonitoringScheduler.test.ts`

- [ ] **Step 4: Implement allowlisted proxy/actions and dashboard state**

Render `PAPER ONLY`, `LIVE TRADING DISABLED`, and execution-enabled state; show review expiry, order/fill/slippage, resulting position, protection, learning checkpoints, blockers, and warnings.

- [ ] **Step 5: Implement review-only scheduler stages**

Morning refreshes Greeks/risk/review; midday monitors order/fill/protection; late day persists evaluation and reviews exits. Do not call submit unless the separate automated hedge flag is true.

- [ ] **Step 6: Verify GREEN**

Run the Step 3 command; expected PASS.

- [ ] **Step 7: Commit**

Commit message: `Expose guarded paper hedge controls`

### Task 9: Documentation, migrations, full verification, and branch review

**Files:**
- Modify: `docs/specs/2026-07-10-portfolio-hedge-management.md`
- Modify: `docs/specs/2026-07-10-guarded-paper-hedge-execution.md`
- Modify: `docs/decisions/ADR-001-guarded-paper-hedge-execution.md`
- Create or modify: `docs/ARCHITECTURE.md`
- Modify: `README.md`
- Modify: `RESUME_CONTEXT.md`
- Modify: `server/README.md`
- Modify: `server/RESUME_CONTEXT.md`
- Modify: `docs/paper-monitoring-operations.md`
- Modify: `docs/vps-paper-research-deployment.md`
- Modify: `.env.example`

- [ ] **Step 1: Synchronize documentation**

Remove stale statements that the merged framework is branch-only or execution can never exist. Document units, freshness, coverage, policy, HMAC key presence, commands, routes, migration, deployment, rollback, and exact paper/live/automation gates.

- [ ] **Step 2: Run migration probes**

Test a clean temporary DB, existing-schema fixture, and copied development DB. Verify row counts/integrity before and after, and verify a second initialization is a no-op.

- [ ] **Step 3: Run full validation**

```bash
npm run lint
npm test
npm run typecheck
npm run build
npm run dashboard:build
```

Expected: all exit zero.

- [ ] **Step 4: Run local mocked execution and read-only commands**

```bash
npm run hedge:risk -- --format=json
npm run hedge:regime -- --format=json
npm run hedge:review -- --format=json
npm run hedge:plan -- --paperOnly --format=json
npx tsx --test tests/hedgeExecutionService.test.ts tests/hedgeCli.test.ts
```

The execution tests invoke the same service/CLI dispatch with injected broker spies and assert that no real network client receives a call.

- [ ] **Step 5: Whole-branch review and remediation**

Generate a review package from `67721e7..HEAD`, run independent final code review, fix all Critical/Important findings with focused tests, then repeat full validation.

- [ ] **Step 6: Commit**

Commit message: `Document paper hedge operations`

### Task 10: Publish, deploy, execute one eligible paper hedge, and verify production

**Operational task; no source changes unless validation reveals a defect.**

- [ ] **Step 1: Push branch, open PR, pass checks, and merge**

Inspect diff, push `feat/paper-hedge-execution`, open a PR, wait for required checks, resolve findings, and merge through the normal repository strategy. Record final main commit.

- [ ] **Step 2: Back up and deploy VPS**

Verify clean state/health/disk, stop only required services, copy SQLite to a timestamped backup, fast-forward merged `main`, run `npm ci`, build, initialize migrations, and restart only `alpaca-dashboard-control` plus changed paper monitor units.

- [ ] **Step 3: Configure and read back paper gates**

Set presence-only `HEDGE_REVIEW_SIGNING_KEY`, set paper execution true, live execution false, automated hedge execution false, preserve all paper/live flags, restart the consuming service, and run mutation preflight. Stop on any live ambiguity.

- [ ] **Step 4: Refresh current Greeks and risk**

Refresh held option snapshots including `SPY270115C00805000` and `QQQ270115C00840000`; run risk/regime/review/plan and capture required coverage, score, scenario, regime, and protection evidence.

- [ ] **Step 5: Create one executable review**

Create exactly one highest-ranked eligible bounded long-put review and report all contract/Greek/quote/premium/protection fields before submission. Use the review ID emitted by that same command for Step 6; do not substitute a hand-authored ID.

- [ ] **Step 6: Submit and monitor exactly one reviewed paper hedge**

Run `hedge:execute --confirmPaper` for the actual review. Allow only bounded replacements/cancellation for that same client order ID. Do not create a second review/order to chase a fill.

- [ ] **Step 7: Verify broker, position, protection, learning, and duplicate rejection**

Read order/position state, calculate expected versus actual premium/slippage/protection and pre/post risk, persist learning, then prove the used review cannot resubmit.

- [ ] **Step 8: Deploy Vercel and validate production**

Deploy merged main to production, validate all hedge GET routes and authenticated mutation duplicate rejection, visually verify dashboard/console/network state, and confirm no secret leakage.

- [ ] **Step 9: Run operational regressions and final account audit**

Run the approved read-only/dry-run regression set, reconcile account/order activity, and prove the only authorized mutation was the new paper hedge lifecycle.
