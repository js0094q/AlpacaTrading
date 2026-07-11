# Resume Context: Guarded Paper Hedge Execution

**Paused:** 2026-07-10 America/New_York  
**Repository:** `/Users/josephstewart/Documents/Alpaca Trading`  
**Branch:** `feat/paper-hedge-execution`  
**HEAD:** resume-context commit (`Record guarded hedge resume context`; verify with `git rev-parse HEAD`)
**Working tree at pause:** clean  
**Task status:** paused during Task 3 review remediation, before any fix edits

## User-Authorized Outcome

Complete portfolio Greeks, implement guarded paper-only long-put hedge entry and exit lifecycles, validate, commit/push/PR/merge, deploy VPS and Vercel, enable explicit paper hedge execution, create one current reviewed hedge, and submit one eligible bounded paper hedge to the Alpaca paper account. Verify broker/order/position/protection/learning state.

Live trading remains prohibited. Do not stop at recommendation-only output when all paper execution gates pass. Do not weaken a legitimate freshness, coverage, liquidity, premium, account-identity, reconciliation, or buying-power blocker to manufacture an order.

## Authoritative Files

Read in this order:

1. `AGENTS.md`
2. This file
3. `docs/specs/2026-07-10-guarded-paper-hedge-execution.md`
4. `docs/decisions/ADR-001-guarded-paper-hedge-execution.md`
5. `docs/superpowers/plans/2026-07-10-guarded-paper-hedge-execution.md`
6. `.superpowers/sdd/progress.md` (git-ignored local execution ledger)
7. Relevant current source/tests

The older `docs/specs/2026-07-10-portfolio-hedge-management.md` is the historical read-only framework contract and contains stale branch/non-execution language that Task 9 must synchronize.

## Branch History

```text
<resume-context commit> Record guarded hedge resume context
f3baa73 Expose complete portfolio Greeks
644755f Fix portfolio Greek evidence gates
19e8213 Complete portfolio Greek quality gates
3d5ef16 Fix option snapshot evidence boundaries
0bbfde6 Normalize complete option snapshot evidence
ff19f0e Define guarded paper hedge execution
67721e7 Merge pull request #1 from js0094q/paper-ops-layer
```

`origin/main` and local `main` were `67721e7324cfd8b48d679b0840db6e216d4baa57` at the start of this task.

## Completed and Independently Approved

### Design checkpoint (`ff19f0e`)

- Added the guarded paper hedge execution specification.
- Added ADR-001 selecting a separate HMAC-reviewed, single-leg long-put path.
- Added the ten-task TDD/subagent implementation plan.
- Put spreads remain analysis-only even though Alpaca currently supports atomic paper `mleg` orders, because this repository client has no `legs` model, parent/leg persistence, or coordinated recovery path.

### Task 1: Canonical option snapshot evidence (`0bbfde6`, `3d5ef16`)

Status: complete; independent review clean.

- Added one canonical current/legacy/mixed snapshot normalizer.
- Preserves zero, rejects NaN/infinity, validates OCC and timestamps.
- Gives independently fetched quote evidence explicit semantic precedence.
- Keeps quote and trade timestamps separate.
- Adds additive evidence columns and a legacy/idempotent migration test.
- Removes downstream compatibility-alias reads from ingestion/diagnostics.
- Final reported verification: 43 focused tests, full suite, typecheck, build.

Review artifacts:

- `.superpowers/sdd/task-1-report.md`
- `.superpowers/sdd/review-ff19f0e..3d5ef16.diff`

### Task 2: Complete portfolio Greeks and quality gates (`19e8213`, `644755f`)

Status: complete; independent review clean.

- Adds explicit delta/gamma/theta/vega/rho units and signed exposure math.
- Adds IV weighted by contracts, market value, and absolute vega.
- Adds per-metric position/contract/market-value coverage and freshness.
- Adds underlying/expiration/option-type/DTE groupings with incomplete-quality handling.
- Uses only canonical `snapshotTimestamp` for Greek freshness; current quote cannot rescue stale/missing Greeks.
- Normalizes all injected numeric evidence to finite-or-null.
- Enforces exact inclusive 90% absolute-contract and 95% absolute-market-value delta execution thresholds.
- Material/stale evidence remains fail-closed and makes sizing indeterminate.
- Final reported verification: 54 focused tests, typecheck, build.

Review artifacts:

- `.superpowers/sdd/task-2-report.md`
- `.superpowers/sdd/review-3d5ef16..644755f.diff`

## Current Task 3 State

### Commit present but NOT approved: `f3baa73`

Task 3 added persisted nested-risk validation, cached VPS/Vercel GET propagation, and complete Greek dashboard display. The implementer reported 47 focused tests, full `npm test`, typecheck, TypeScript build, dashboard build, and diff check passing.

Independent review found Task 3 **Needs fixes**. Do not mark Task 3 complete or start Task 4 until all findings below are fixed and re-reviewed.

### Open Task 3 findings

1. **Fresh outer recommendations can still make old nested Greek evidence appear current.**
   - Recompute freshness from validated per-position Greek/IV observation timestamps using current `buildHedgeConfig().optionGreeksFreshness` and the read `asOf` time.
   - Do not trust aggregate freshness counters alone.
   - Test old risk inside a fresh recommendation, stale per-metric evidence, stale per-position evidence, and malformed timestamps.

2. **The persisted runtime decoder validates only part of `PortfolioRiskSnapshot`.**
   - Validate exact paper environment, current model/config/source identity, required account/exposures/concentration/optionDataCoverage/scenarios/dataQuality structures, enums, finite-or-null numerics, position shapes, group shapes, coverage arithmetic, and ratio consistency.
   - Update fixtures so position/contract/value totals and measured/unmeasured fields are internally consistent.

3. **Missing freshness fields render as observed zero.**
   - Remove `?? 0` behavior for freshness display.
   - Partial or missing freshness must render `Unavailable`.

4. **Non-paper persisted state can be relabeled as paper.**
   - Fail closed unless persisted environment is exactly `paper`.
   - Base dashboard paper/live labels on explicit `paperOnly`, `environment`, and `liveTradingEnabled` evidence, not a hard-coded mapping.

5. **Coverage/group display is incomplete.**
   - Display position/contract/market-value total, measured, unmeasured, and ratio fields.
   - Display grouped weighted IV where present.

The interrupted Task 3 implementer had received these instructions but had not written any working-tree changes at pause time.

Task 3 artifacts:

- `.superpowers/sdd/task-3-brief.md`
- `.superpowers/sdd/task-3-report.md`
- `.superpowers/sdd/review-644755f..f3baa73.diff`

## Exact Resume Sequence

```bash
cd '/Users/josephstewart/Documents/Alpaca Trading'
git status --short --branch
git branch --show-current
git rev-parse HEAD
git fetch origin
git rev-parse origin/main
sed -n '1,220p' RESUME_GUARDED_PAPER_HEDGE_EXECUTION.md
sed -n '1,220p' .superpowers/sdd/progress.md
```

Expected before resuming edits:

```text
branch=feat/paper-hedge-execution
HEAD=<commit containing this resume file>
working tree clean
```

Then:

1. Re-dispatch a focused Task 3 fixer using the open findings above and strict TDD.
2. Run:

   ```bash
   npx tsx --test tests/hedgePersistenceService.test.ts tests/hedgeDashboard.test.ts tests/dashboardControlServer.test.ts tests/dashboardVercelBridge.test.ts
   npm test
   npm run typecheck
   npm run build
   npm run dashboard:build
   git diff --check
   ```

3. Commit only Task 3 fix files and append `.superpowers/sdd/task-3-report.md`.
4. Generate a new full Task 3 review package from `644755f..HEAD` and re-dispatch the independent Task 3 reviewer.
5. Only after a clean review, append Task 3 completion to `.superpowers/sdd/progress.md`.
6. Continue sequentially with Task 4 from `.superpowers/sdd/task-4-brief.md`.

Do not dispatch multiple implementation agents concurrently; use one implementer plus an independent reviewer for each task so shared-file edits do not conflict.

## Remaining Plan

- Task 4: centralized hedge policy, long-put candidate ranking, HMAC-reviewed payload, additive review persistence.
- Task 5: shared paper option validation, account/order/position reconciliation, atomic ledger reservation, implemented execution gate.
- Task 6: paper order get/replace/cancel methods, bounded entry fill management, `hedge:execute` CLI.
- Task 7: paper hedge exit review/execute and dedicated learning/outcome lifecycle.
- Task 8: authenticated VPS/Vercel mutations, dashboard action state, review/monitor/evaluate-only scheduler integration.
- Task 9: synchronize docs, migration probes, full local verification, whole-branch review.
- Task 10: push/PR/checks/merge, VPS backup/deploy/migrate/configure, refresh Greeks/risk, create exactly one eligible review, submit/monitor one bounded paper hedge, verify broker/position/protection/learning, deploy Vercel, validate production and duplicate rejection.

## Verified VPS Baseline at Start

Read-only SSH verification found:

```text
host=jspaper
branch=main
head=67721e7324cfd8b48d679b0840db6e216d4baa57
service alpaca-dashboard-control=active/enabled
disk usage=10%
ALPACA_ENV=paper
TRADING_MODE=paper
ALPACA_LIVE_TRADE=false
LIVE_TRADING_ENABLED=false
PAPER_ORDER_EXECUTION_ENABLED=true
PAPER_OPTIONS_EXECUTION_ENABLED=true
HEDGE_PAPER_EXECUTION_ENABLED=false
HEDGE_LIVE_EXECUTION_ENABLED=missing
HEDGE_AUTOMATED_PAPER_EXECUTION_ENABLED=missing
VPS_CONTROL_TOKEN=present
DASHBOARD_ADMIN_TOKEN=present
```

The control health payload reported `paperOnly=true`, `liveTradingEnabled=false`, `mutationAllowed=false`, paper account reachable/active, and the hard-coded paper endpoint. It also reported live credentials present; they must never be used for execution.

No VPS deployment, database backup/migration, environment mutation, service restart, Vercel deployment, paper order, live order, order cancellation/replacement, or position change occurred before this pause.

## Market and Source Notes

- The initial runtime check occurred after market close. The next open reported was Monday, 2026-07-13 at 09:30 ET.
- A real hedge review/submission must not proceed on stale weekend option quotes. Market closure is a legitimate hard blocker, not a reason to weaken `HEDGE_LIMIT_PRICE_MAX_AGE_SECONDS`.
- Local Alpaca CLI is version `0.0.12`, current according to `alpaca update --check --quiet`.
- The Alpaca app option-snapshot connector returned internal errors for both batch and single-contract reads; use the authoritative VPS repository data path for runtime validation.
- Official Alpaca documentation confirms atomic `mleg` paper support and paper replace behavior, but the repository client is not yet an established atomic multi-leg SDK path. Keep the first executable structure `long_put` only.

## Hard Safety Gates to Preserve

```text
ALPACA_ENV=paper
TRADING_MODE=paper
ALPACA_LIVE_TRADE=false
LIVE_TRADING_ENABLED=false
PAPER_ORDER_EXECUTION_ENABLED=true
PAPER_OPTIONS_EXECUTION_ENABLED=true
HEDGE_PAPER_EXECUTION_ENABLED=true          # only after merged-main deployment and disabled-state validation
HEDGE_LIVE_EXECUTION_ENABLED=false
HEDGE_AUTOMATED_PAPER_EXECUTION_ENABLED=false
broker endpoint=https://paper-api.alpaca.markets
explicit --confirmPaper or confirmPaper=true
```

- Do not add hedge orders to timer-owned `optionBuys`.
- Do not emulate spreads through sequential legs.
- Do not submit market orders.
- Do not cancel or replace any unrelated order.
- Do not modify pre-existing non-hedge positions.
- Do not persist or print signing keys, API keys, tokens, raw account IDs, or full authenticated broker responses.
- Do not submit when Greek coverage, selected delta, quote freshness, OCC identity, premium, buying power, reviewed payload, account identity, reconciliation, duplicate, or frequency gates fail.

## External Documentation Used

- Alpaca create-order reference: `https://docs.alpaca.markets/us/v1.1/reference/postorder`
- Alpaca Level 3/multi-leg guide: `https://docs.alpaca.markets/us/docs/options-level-3-trading`
- Alpaca paper multi-leg announcement: `https://docs.alpaca.markets/us/v1.1/changelog/multi-leg-level-3-options-trading-in-paper`
- Alpaca replace-order reference: `https://docs.alpaca.markets/us/reference/patchorderbyorderid-1`
- Alpaca option snapshot reference: `https://docs.alpaca.markets/us/v1.1/reference/optionsnapshots`
