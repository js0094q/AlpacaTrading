# Portfolio Hedge Data Quality Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent material option positions without observed delta from being presented as conclusively low risk while preserving the paper-only, non-executable hedge architecture.

**Architecture:** Extend the normalized risk snapshot with contract- and absolute-market-value-weighted option delta coverage. Keep the numerical score and calculated band intact, but add measurement status and an effective band that becomes `indeterminate` when material option exposure is not delta-measured. Make recommendation sizing fail closed to monitoring, then expose the distinction in the existing dashboard component.

**Tech Stack:** TypeScript, Node test runner, React 19 server rendering, Next.js 16, SQLite-backed cached market data.

## Global Constraints

- Do not deploy.
- Do not submit paper or live orders.
- Do not add or run `hedge:execute`.
- Keep `HEDGE_PAPER_EXECUTION_ENABLED=false`.
- Do not estimate or fabricate Greeks.
- Preserve expired and stale recommendation behavior.
- Use absolute option market value for coverage calculations.

---

### Task 1: Coverage configuration and normalized risk metrics

**Files:**
- Modify: `src/services/hedgeConfigService.ts`
- Modify: `src/services/portfolioRiskService.ts`
- Test: `tests/hedgeConfigService.test.ts`
- Test: `tests/portfolioRiskService.test.ts`

**Interfaces:**
- Consumes: `HEDGE_MIN_OPTION_DELTA_CONTRACT_COVERAGE_PCT`, `HEDGE_MIN_OPTION_DELTA_MARKET_VALUE_COVERAGE_PCT`, and `HEDGE_MATERIAL_UNMEASURED_OPTION_EXPOSURE_PCT` as percentages from 0 through 100.
- Produces: `HedgeConfig.optionDataCoverage` normalized to ratios and `PortfolioRiskSnapshot.optionDataCoverage` with contract and market-value coverage metrics.

- [ ] **Step 1: Write failing configuration and risk-normalization tests**

Add assertions for defaults `0.8`, `0.8`, and `0.1`; invalid percentage fallback; all Greeks present; immaterial missing delta; material contract coverage missing; and material market-value coverage missing. Assert the material cases return null portfolio beta, option delta, positive-delta concentration, and scenario net loss.

- [ ] **Step 2: Run the tests and verify the expected failures**

Run: `npx tsx --test tests/hedgeConfigService.test.ts tests/portfolioRiskService.test.ts`

Expected: FAIL because `optionDataCoverage` does not exist.

- [ ] **Step 3: Implement percentage parsing and coverage calculations**

Add a fail-safe percentage parser that accepts only finite values from 0 to 100 and normalizes them to ratios. Compute contract coverage from absolute held quantity and market-value coverage from absolute observed option market value. Set `materialCoverageMissing` only when insufficient contract coverage affects material total option market value or unmeasured option market value itself exceeds the configured equity threshold.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `npx tsx --test tests/hedgeConfigService.test.ts tests/portfolioRiskService.test.ts`

Expected: PASS.

### Task 2: Measurement status and recommendation fail-closed behavior

**Files:**
- Modify: `src/services/hedgeTypes.ts`
- Modify: `src/services/portfolioRiskScoreService.ts`
- Modify: `src/services/hedgeRecommendationService.ts`
- Test: `tests/portfolioRiskScoreService.test.ts`
- Test: `tests/hedgeRecommendationService.test.ts`
- Test: `tests/hedgePlanService.test.ts`

**Interfaces:**
- Produces: `RiskAssessmentStatus = "measured" | "partially_measured" | "indeterminate" | "blocked"`.
- Produces: `PortfolioRiskScore.measurementStatus` and `PortfolioRiskScore.effectiveBand`, where the calculated `band` remains unchanged.
- Consumes: `risk.optionDataCoverage.materialCoverageMissing` in recommendation selection.

- [ ] **Step 1: Write failing scoring and recommendation tests**

Assert that a low calculated score with material missing option delta retains `band: "low"` but returns `measurementStatus: "indeterminate"` and `effectiveBand: "indeterminate"`. Assert the recommendation is `monitoring`/`monitor`, sizing is zeroed, candidates are empty, and the material coverage warning is present.

- [ ] **Step 2: Run the tests and verify the expected failures**

Run: `npx tsx --test tests/portfolioRiskScoreService.test.ts tests/hedgeRecommendationService.test.ts tests/hedgePlanService.test.ts`

Expected: FAIL because measurement status and the material-coverage gate do not exist.

- [ ] **Step 3: Implement interpretation and recommendation gates**

Derive measurement status from risk data quality and material option coverage. Preserve the numerical score. Return monitoring before hedge sizing or candidate selection whenever the status is indeterminate, and include `MATERIAL_OPTION_GREEKS_COVERAGE_INSUFFICIENT` plus `HEDGE_SIZING_EVIDENCE_INSUFFICIENT`.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `npx tsx --test tests/portfolioRiskScoreService.test.ts tests/hedgeRecommendationService.test.ts tests/hedgePlanService.test.ts`

Expected: PASS.

### Task 3: Dashboard distinction and read-only safety regression

**Files:**
- Modify: `apps/dashboard/app/components/HedgePanel.tsx`
- Modify: `src/cli.ts`
- Test: `tests/hedgeDashboard.test.ts`
- Test: `tests/hedgeCli.test.ts`

**Interfaces:**
- Consumes: persisted `score.measurementStatus`, `score.effectiveBand`, `risk.optionDataCoverage`, `recommendationStatus`, warnings, and blockers.
- Produces: separate calculated score, calculated band, measurement status, effective risk band, effective decision status, and option delta coverage labels.

- [ ] **Step 1: Write failing dashboard and CLI presentation tests**

Assert incomplete low-score markup contains `Calculated risk score`, `Calculated band`, `Measurement status`, `Indeterminate`, option delta coverage, and the material warning, while stale/expired tests remain unchanged. Assert hedge routes and commands still contain no execution path.

- [ ] **Step 2: Run the tests and verify the expected failures**

Run: `npx tsx --test tests/hedgeDashboard.test.ts tests/hedgeCli.test.ts`

Expected: FAIL because the dashboard currently renders one combined `Risk score` label.

- [ ] **Step 3: Implement presentation changes**

Render the calculated values separately and show an explicit incomplete-data qualifier whenever measurement is indeterminate. Keep all route methods and stale/expired status logic unchanged.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `npx tsx --test tests/hedgeDashboard.test.ts tests/hedgeCli.test.ts`

Expected: PASS.

### Task 4: Documentation, runtime diagnosis, and publication

**Files:**
- Modify: `docs/specs/2026-07-10-portfolio-hedge-management.md`
- Modify: `README.md`
- Modify: `RESUME_CONTEXT.md`

**Interfaces:**
- Documents the percentage env contract, effective-band semantics, observed missing-Greeks cause, and unchanged non-execution boundaries.

- [ ] **Step 1: Diagnose representative current SPY and QQQ calls through the exact read-only snapshot path**

Read current paper positions, choose one January 2027 SPY call and one January 2027 QQQ call, call `/v1beta1/options/snapshots` without order endpoints, and compare raw response field shape with `OptionSnapshotRaw` and `toSnapshotRow` parsing. Record only symbols, response-field presence, request status, and Greek availability; never print secrets.

- [ ] **Step 2: Update implementation documentation**

Document the new environment variables, materiality rule, calculated-versus-effective classification, runtime diagnosis, and deployment blocker.

- [ ] **Step 3: Run the complete required validation**

Run: `npm run lint`, `npm test`, `npm run typecheck`, `npm run build`, `npm run dashboard:build`, `npm run hedge:risk -- --format=json`, `npm run hedge:regime -- --format=json`, `npm run hedge:review -- --format=json`, and `npm run hedge:plan -- --paperOnly --format=json`.

Expected: all commands exit zero; read-only output reports no order submission; no `hedge:execute` command is run.

- [ ] **Step 4: Review, commit, push, and open a draft PR**

Inspect `git diff`, stage only files from this correction, commit with `Correct incomplete hedge risk classification`, push `paper-ops-layer`, and open a draft PR containing the complete branch divergence and required safety/deployment notes.
