# Account Snapshot Identity Conflict Repair

## Goal

Allow the supported execution-state backfill to reuse an existing PostgreSQL
`account_snapshots` row only for the production-proven case where the same
canonical portfolio-state identity is observed again with separately refreshed
market context. Preserve fail-closed behavior for every material snapshot
difference.

## Verified production evidence

The sealed snapshot
`ee7624b0254eab23335b922dae774e4ddbb00fe5a399ddcb89125575435b2431` contains
67 source account snapshots. PostgreSQL contains 86 snapshots for the source
account. There are zero duplicate source identities and two cross-primary-key
collisions on `(account_id, snapshot_fingerprint)`. Both collisions have newer
source timestamps and differ only at `evidence.marketEvidenceFingerprint` in
the persisted evidence object; all other mapped fields compare equal after the
existing numeric, timestamp, and canonical-JSON normalization.

The source projection sets `snapshot_fingerprint` to `portfolioFingerprint`,
groups historical projections by account plus that fingerprint, and retains the
newest projection. Market evidence is stored separately and is validated
separately from portfolio-state drift. This establishes that the production
identity contract excludes only the refreshed market-evidence fingerprint, not
the rest of the snapshot evidence.

## Decision

Use a dedicated `account_snapshots` semantic comparator that:

- requires the existing `(account_id, snapshot_fingerprint)` identity;
- compares all mapped fields with the existing deterministic numeric, timestamp,
  and canonical-JSON normalization;
- excludes only a present, non-empty top-level
  `evidence.marketEvidenceFingerprint` value from identity equality;
- records that excluded difference explicitly as
  `account_snapshots:evidence.marketEvidenceFingerprint`;
- preserves the existing PostgreSQL primary key and evidence;
- remaps all dependent backfilled foreign keys through the existing aliases; and
- rejects malformed, missing, structurally different, or otherwise contradictory
  evidence.

No schema, unique constraint, fingerprint-generation algorithm, strategy logic,
or account-head comparator is changed.

## Required failure behavior

The backfill must fail closed on different account IDs, different fingerprints,
structural portfolio evidence differences, account-state differences, malformed
market-evidence values, or any other material mismatch. It must not insert a
duplicate, overwrite the PostgreSQL row, delete history, or remap unrelated
PostgreSQL-only authority rows.

## Validation and promotion gates

Tests must cover the exact production-shaped collision, separate market-evidence
reuse, numeric/timestamp normalization, material evidence mismatch, foreign-key
reuse, PostgreSQL-only preservation, duplicate prevention, idempotent replay, and
durable checkpoint creation only after successful reconciliation. Run focused
identity tests, Release 4, the full test suite, typecheck, build, and
`git diff --check`. Promote one exact commit only after independent review. Use
one fresh sealed snapshot, one supported backfill attempt, and reconcile only if
backfill succeeds. Keep both services and all live-trading paths stopped until
the durable reconciliation checkpoint passes.
