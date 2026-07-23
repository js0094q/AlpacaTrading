# Market Observatory Phase 1B

**Repository:** `/Users/josephstewart/Documents/Alpaca Trading`
**Date:** 2026-07-13
**Status:** Implemented; deployment validation pending
**Target branch:** `feat/market-observatory`
**Baseline:** `9bcb097104031af816d755d1bd53a42eab79f2dc`

## Goal

Add durable decision and position lifecycle traceability, immutable decision-time
evidence, broker-reconciled analytical positions, longitudinal observations,
persisted-only excursions and outcomes, and exact learning linkage while keeping
all execution paper-only and preserving every existing gate.

## Verified Current State

- Phase 1A provides a 51-symbol canonical universe, append-only stock snapshots,
  structured candidate decisions, and a non-executing 15-minute timer.
- Alpaca orders and positions are broker truth. `paper_execution_ledger` is the
  execution audit. No equivalent migration ledger existed before Phase 1B.
- Candidate IDs, review IDs, order IDs, and symbol/time proximity were not a safe
  universal decision identity.
- The existing promotion thresholds, review/reservation/idempotency/duplicate,
  liquidity/freshness/sizing/exposure/concentration, and live-off gates must remain
  unchanged.

## Required Contracts

### Identity and evidence

- Keep candidate, decision, and position lifecycle UUID domains distinct.
- Make `(origin_type, origin_id, decision_role)` unique and retry-idempotent.
- Persist one immutable entry/non-executable snapshot and one new immutable
  snapshot per distinct exit review.
- Append lifecycle status events. Do not revise the original snapshot.
- Preserve machine-readable reasons and narrative rationale separately.

### Persistence

The named migration `2026-07-13-market-observatory-phase-1b` adds:

- `schema_migrations`
- `decision_snapshots`
- `decision_lifecycle_events`
- `paper_review_decisions`
- `paper_positions`
- `paper_position_observations`
- `paper_position_observation_links`
- `paper_position_outcomes`
- `paper_position_outcome_revisions`

It also adds exact linkage columns to candidate, plan, evaluation, execution,
learning, and hedge evidence. Backfill uses exact identifiers only; uncertain
history remains null/`LEGACY_UNLINKED`.

### Provenance

Persist Git SHA, allowlist schema version, hashes of sorted allowlisted strategy
and risk settings, paper environment, feed, request IDs when supplied, and source
and observation timestamps. Never hash or persist a full environment, credentials,
tokens, authorization headers, secret-bearing configuration, or raw runtime dumps.

### Broker reconciliation and outcomes

- Create an analytical position only from a confirmed fill with exact ledger and
  decision lineage.
- Persist symbol evidence even when attribution is ambiguous. Link every possible
  open lifecycle as `AMBIGUOUS_NETTED_POSITION` and withhold per-decision metrics.
- Calculate return, MFE, MAE, excursion timing, first-profit timing, runup,
  drawdown, and holding duration from persisted exact observations only.
- Preserve option-position and underlying-return bases separately.
- Withhold metrics for ambiguous, missing-mark, insufficient, partial, or legacy
  evidence rather than fabricating values.
- Enforce one original terminal outcome per lifecycle. Append corrections.

### Learning and trace

Learning rows retain candidate, entry/exit decision, lifecycle, original outcome,
effective revision, completeness, and linkage fields. Existing promotion logic is
unchanged. `npm run paper:trace -- --decisionId <uuid>` is read-only and omits raw
payload, response, environment, and model-input JSON that could contain secrets.

## Failure Behavior

- Missing or non-exact fill lineage does not create a lifecycle.
- Partial fills preserve partial quality and can advance idempotently when later
  broker evidence confirms more filled quantity.
- Multiple possible open lifecycles remain ambiguous; no pro-rata allocation is
  attempted.
- Missing entry/exit/intermediate marks produce explicit incomplete outcomes with
  null metrics.
- Migration and verification commands fail visibly on missing schema, index,
  migration, or integrity evidence.

## Acceptance Criteria

- Focused identity, evidence, reconciliation, outcomes, learning, trace, safety,
  observatory, research, and paper execution tests pass.
- `npm run lint`, `npm run typecheck`, `npm run build`, canonical `npm test`,
  applicable syntax checks, and Git whitespace/status checks pass.
- A copied database migrates twice without row loss; `db:verify` and
  `PRAGMA integrity_check` pass.
- The merged VPS deploy preserves paper/live flags, backs up the database, applies
  and verifies the migration, restores service/timer state, and enables the market
  observatory timer.
- Observatory validation accounts for all 51 symbols as `COMPLETE` or an explicit
  `PARTIAL`; outside market hours, `SKIPPED_MARKET_CLOSED` plus timer/schema/service
  health is acceptable with regular-session evidence marked pending.
- No paper order is forced for validation, and no live order or credential is used.

## Deployment Boundary

Merge, VPS deployment, timer enablement, and read-only runtime validation are
authorized by the approved Phase 1B plan. Paper execution is not authorized solely
to create evidence. Vercel is required only if the final diff changes a
dashboard-consumed route or display; core/CLI/VPS-only changes do not require it.
