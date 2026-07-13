# ADR-002: Durable Market Decision and Position Lifecycle Identity

**Status:** Accepted
**Date:** 2026-07-13

## Context

Candidate, review, execution, broker position, outcome, and learning records were
previously connected through identifiers whose meanings were not consistently
separated. Alpaca can also net multiple decisions into one symbol-level position.
Using candidate IDs or symbol/time proximity as universal decision identity would
make later attribution appear more precise than the broker evidence permits.

## Decision

1. `candidate_id` identifies a researched opportunity, `decision_id` identifies
   one immutable entry, exit, or non-executable decision, and
   `position_lifecycle_id` identifies one broker-reconciled analytical lifecycle.
2. New candidate decisions receive UUIDs distinct from candidate IDs. Legacy IDs
   are reused only by exact one-candidate/one-decision backfill; uncertain rows are
   `LEGACY_UNLINKED`.
3. Decision identity is idempotent on `(origin_type, origin_id, decision_role)`.
   A materially new exit review receives a new exit decision.
4. Analytical positions are created only from a broker-confirmed fill joined to
   an exact execution-ledger decision. Alpaca remains broker truth and the ledger
   remains execution-audit truth.
5. Observations are append-only. One open lifecycle gets an `EXACT` link. Multiple
   possible lifecycles get `AMBIGUOUS_NETTED_POSITION` links, and per-decision
   return, MFE, and MAE are withheld.
6. Original terminal outcomes are unique by lifecycle and immutable. Corrections
   are appended to the revision table.
7. Decision snapshots are insert-only through narrow repository functions.
   Database update/delete rejection triggers are deferred pending separate
   operational compatibility validation.

## Rationale

The model preserves what is known without allocating netted positions across
decisions or revising earlier evidence with later facts. Separate entry and exit
decisions retain the evidence actually available at each review boundary.

## Alternatives Considered

- **Use candidate IDs as all decision IDs:** rejected because candidates can have
  multiple later exit decisions and non-candidate origins exist.
- **Allocate netted broker positions pro rata:** rejected because the allocation
  would be fabricated.
- **Update snapshots as fills and outcomes arrive:** rejected because it destroys
  decision-time evidence.
- **Install SQLite rejection triggers now:** deferred because operational and
  migration compatibility has not been separately validated.

## Consequences

- Additive tables and linkage columns are required.
- Legacy uncertainty remains visible and excluded from per-decision analytics.
- Learning can reference candidate, entry/exit decisions, lifecycle, original
  outcome, and effective revision without changing promotion thresholds.
- Read-only traces can reconstruct a lifecycle without exposing raw payloads or
  secret-bearing configuration.

## Validation

Migration, identity, immutability, exact/ambiguous reconciliation, observation,
outcome, revision, learning-linkage, trace-redaction, and paper/live safety tests
must pass. Deployment must verify the named migration, retained rows, indexes,
integrity, and paper-only runtime state.

## Reconsideration

Database rejection triggers or more granular broker allocation may be reconsidered
only after compatibility and exact broker attribution evidence are demonstrated.
