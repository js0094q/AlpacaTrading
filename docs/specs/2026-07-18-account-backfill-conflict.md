# Account Backfill Conflict Repair

## Goal

Allow execution-state backfill to preserve and reuse a provably newer
PostgreSQL account head when replaying a sealed SQLite source, while retaining
fail-closed behavior for stale, contradictory, or unprovable account records.

## Verified conflict

The sealed SQLite row and existing PostgreSQL row have the same account primary
key, broker identity, paper environment, currency, creation provenance, and
source observation fingerprint. The deployed comparison rejected the pair only
because PostgreSQL had a later mutable `version` and later `updated_at` after
additional valid observations.

The `accounts` row represents the current mutable head of one broker account.
Historical observations are represented by `account_snapshots`; their
fingerprints include immutable account identity together with mutable account,
position, order, and reservation evidence. The fingerprint contract is not
changed by this repair.

## Required behavior

- Compare `accounts.version` canonically as an integer so equivalent string and
  numeric representations compare equal.
- Reuse an existing account row at the same primary key only when immutable
  fields match and every differing field is an allowed mutable/provenance field.
- Require the existing PostgreSQL row to be no older in either `version` or
  `updated_at`, and require at least one of those ordering fields to be newer
  when a difference exists.
- Preserve the PostgreSQL primary key, dependent foreign-key mapping, and all
  PostgreSQL-only authority rows without update or deletion.
- Sanitize account identity errors so account payloads are not emitted.

## Fail-closed behavior

Backfill must stop without insert, overwrite, or remapping when account IDs,
broker identities, environments, currencies, creation provenance, or other
immutable fields differ. It must also stop when the target is stale, ordering
cannot be parsed, or a mutable difference cannot be proven to belong to a newer
PostgreSQL head. A different primary key occupying the same broker-account
identity remains a conflict.

## Non-goals

- No account-snapshot fingerprint, schema, or unique-constraint change.
- No strategy, broker, order, worker, live-trading, or authority-cutover change.
- No production data update, history deletion, or conflict override.

## Validation and promotion gates

The production-shaped fixture must first reproduce the deployed conflict. Tests
must then prove newer-head reuse, normalization, immutable and stale rejection,
foreign-key preservation, PostgreSQL-only history preservation, idempotent
replay, no duplicate account, and reconciliation checkpoint status. Promotion
requires the supported sealed snapshot, one backfill attempt, reconciliation,
and a durable passed checkpoint before any later market-evidence or worker gate.
