# Risk-Limit Backfill Conflict Repair

Date: 2026-07-18

## Goal

Resolve the production `EXECUTION_STATE_BACKFILL_CONFLICT:risk_limits` without
changing risk policy, execution limits, strategy behavior, or the historical
PostgreSQL authority model.

## Verified Current State

- The deployed VPS checkout is clean at
  `c5a6e2e4c5e03f24dd723b0fce488cd75446ff91`.
- `alpaca-dashboard-control.service` and `alpaca-autonomous-paper.service` are
  stopped. No execution-state backfill or reconciliation process is active.
- The sealed SQLite snapshot has SHA-256
  `ee7624b0254eab23335b922dae774e4ddbb00fe5a399ddcb89125575435b2431`,
  mode `0400`, SQLite integrity `ok`, and zero SQLite foreign-key violations.
- PostgreSQL direct connectivity is healthy. The latest execution-state
  checkpoint is blocked; no durable passed reconciliation checkpoint exists.
- Paper mode is enabled and both live flags are false. No order command was run.

## Exact Production Conflict

The collision is on `risk_limits_pkey (id)`. The source and target primary-key
hashes are both
`77b04afbce353823a175493d56bf3ba77daf7fd0180f8c4d7a96e6b895e9b48f`.
The account, portfolio scope, paper environment, associated strategy,
configuration fingerprint, and every persisted limit or policy field match.

The only differences after existing numeric and timestamp normalization are:

| Field | Classification | Source versus PostgreSQL |
| --- | --- | --- |
| `effective_from` | observation/ingestion provenance | later sealed observation versus earlier policy activation |
| `created_at` | observation/ingestion provenance | later sealed observation versus earlier first persistence |
| `updated_at` | observation/ingestion provenance | later sealed observation versus earlier authority persistence |
| `version` | deterministic representation | numeric `1` versus PostgreSQL bigint string `"1"` |

The source projection derives `risk_limits.id` from account identity, portfolio
scope, and `configurationFingerprint`, but derives all three timestamps from the
latest account observation. Therefore a later sealed observation of the same
configuration recreates the same policy identity with later provenance.

PostgreSQL contains two portfolio-scope rows: one separately keyed superseded
configuration and the active row that collides with the source. The active row
has the matching configuration fingerprint and complete matching policy
semantics. Preserving it does not collapse the superseded policy version.

Neither the generated source projection, the sealed SQLite schema, nor the
PostgreSQL schema contains a foreign key to `risk_limits`. Reuse therefore
retains the same primary key and requires no downstream foreign-key rewrite.

A bounded read-only follow-on comparison also found that the associated
`strategy_allocations` row has the same primary key, account, strategy, and
configuration identity but a later PostgreSQL authority version and deployed
amount. That is a distinct singleton contract and is not part of this repair.
The risk-limit comparator must not be reused for it. If the supported backfill
reaches a strategy-allocation conflict after this repair, the attempt must stop
fail-closed for a separately scoped diagnosis.

## Resolution Classification

Outcome C: provenance-only difference.

The numeric-versus-string `version` difference is a proven PostgreSQL bigint
representation difference within this outcome. It must be normalized before
semantic comparison, but the resolution is not Outcome B because three genuine
provenance timestamps also differ.

## Required Behavior

- Reuse only an existing row with the same primary key, account, scope type,
  scope key, configuration fingerprint, and complete risk-policy semantics.
- Require the account environment to have already passed the existing account
  identity check; this production row is paper-only.
- Treat all amounts, ratios, counts, currency, configuration version,
  configuration fingerprint, lifecycle status, and effective end as
  policy-bearing or lifecycle-bearing and require semantic equality.
- Normalize positive integer `version` values across number/string PostgreSQL
  representations.
- Permit only the proven source-later provenance shape for `effective_from`,
  `created_at`, and `updated_at`.
- Preserve the PostgreSQL row, its primary key, its provenance, and the separate
  superseded policy row.
- Emit the sanitized reuse classification `provenance_only`.
- Remain idempotent.

## Fail-Closed Behavior

Reject a replay when any of the following differs or is malformed:

- primary key, account identity, scope type, or scope key;
- account environment through the existing account identity gate;
- currency, configuration version, or configuration fingerprint;
- any risk amount, ratio, count, hard cap, or immutable policy definition;
- status, effective end, or integer version semantics;
- invalid timestamps, numerics, counts, or versions;
- provenance ordering not supported by the observed production shape;
- unknown or unclassified differences.

Do not insert, update, overwrite, remap, or continue after a material conflict.

## Acceptance and Validation

- A production-shaped test initially fails with the production conflict code.
- Equivalent provenance and bigint representations reuse the PostgreSQL row.
- Account, strategy-scope, policy, malformed-value, and fingerprint collisions
  fail closed.
- PostgreSQL-only authority history remains unchanged and no duplicate is made.
- Replay is idempotent.
- Reconciliation classifies the three provenance fields without treating the
  row as a material mismatch.
- Focused migration, Release 4, full test, typecheck, build, and diff checks pass.
- Neon integration runs when the supported environment is available.

## Deployment Boundary

Deploy only the validated focused commit. Keep dashboard-control and the
autonomous worker stopped through backfill and reconciliation. Run one supported
backfill against a fresh sealed snapshot. Start dashboard-control only after a
durable passed reconciliation checkpoint is persisted and independently read
back. Do not start the autonomous worker or submit orders.
