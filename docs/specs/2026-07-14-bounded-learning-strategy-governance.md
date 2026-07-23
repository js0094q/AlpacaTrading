# Bounded Learning Strategy Governance

## Goal

Close the autonomous lifecycle gap between paper-learning evaluation and research selection. The service must translate bounded, evaluated paper outcomes into persisted, non-broker-mutating research governance decisions that the next automated research run consumes.

## Verified Current State

- `paper-ops-morning` evaluates up to 100 learning records, but previously ran research first and treated promotion readiness as reporting only.
- `paper_learning_records` persisted `ANALYTICS_GATE_NOT_REVIEWED`; no table held current strategy or symbol governance state.
- Candidate ranking consumed generic model accuracy but not evaluated paper-learning outcomes.
- `alpaca-universe-lifecycle.timer` and the closed universe lifecycle service are production-complete at `8232ff9` and are out of scope.

## Scope

- Add bounded local governance runs and immutable current-state transitions for strategy families and symbols.
- Evaluate only existing `evaluated` paper-learning records from the supported strategy families: `equity`, `standard_option`, `zero_dte_spy`, and `leaps`.
- Write `observe`, `prioritized`, or research-only `suspended` states with reason codes, evidence, timestamps, Git SHA, policy version, and policy hash.
- Run learning evaluation, governance, then research in the existing morning paper-ops workflow.
- Apply governance in candidate ranking: cap priority score uplift at 1.25x and fail closed for a suspended strategy or symbol.
- Provide governance run and read-only status CLI commands.

## Non-Goals and Boundaries

- This service does not call Alpaca, submit, cancel, or alter broker orders.
- `suspended` means excluded from future research candidate selection only. It does not disable, retire, or change a universe lifecycle symbol.
- The service does not alter observatory cadence, universe lifecycle states, research eligibility, paper eligibility, execution, reconciliation, monitoring, exits, or live-trading policy.
- Existing execution and paper-only gates remain the sole authority for broker mutation.
- No systemd timer is added: the already-enabled morning paper-ops timer is the automatic downstream consumer.

## Policy

- Each family scan is capped at 250 latest evaluated records; no more than 100 symbol scopes are materialized.
- Insufficient sample size or observed days produces `observe` and preserves baseline ranking.
- Positive live-like P&L with a profit factor of at least 1.05 produces a bounded priority multiplier.
- Negative live-like P&L with a profit factor at or below 0.80 produces `suspended` only after the configured minimum evidence threshold.
- The service uses live-like P&L, not paper P&L, so modeled spread and slippage remain part of the decision evidence.

## Downstream Contract

`paper-ops-morning` performs:

`evaluate paper outcomes -> apply governance -> research -> candidate ranking -> review`

Candidate ranking resolves the current strategy-family and symbol decisions once per run. A suspension records `LEARNING_GOVERNANCE_SUSPENDED`; a priority decision is represented in rationale and the candidate score. No aggressive-mode fallback can reselect a suspended candidate.

## Acceptance Criteria

- A completed governance run has durable provenance and bounded evidence.
- Identical governance state creates no duplicate transition while every run remains auditable.
- Positive evidence changes strategy and symbol priority and affects research ordering.
- Negative evidence creates a persisted suspension and prevents candidate selection.
- The scheduled morning workflow evaluates and governs before research.
- The implementation remains paper-only and non-broker-mutating.

## Validation and Deployment

- Run targeted governance and paper-ops tests, then repository lint, test, typecheck, and build checks.
- Merge only after two review cycles contain no Critical or High finding.
- Deploy the merged SHA to the VPS, invoke the existing morning systemd service outside overlapping database-heavy jobs, and capture the resulting governance and research evidence.
