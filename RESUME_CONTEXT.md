# Resume Context: AlpacaTrading

## Authority

This file is intentionally short. It is not an implementation diary and does not preserve unfinished roadmap work.

Before changing or operating the system, verify current repository state, deployed runtime state, PostgreSQL authority, broker state, and relevant provider state. Current verified state overrides this file and all historical plans or release notes.

## Durable architecture

- PostgreSQL is the sole durable runtime authority for scheduler coordination, decision lineage, intent, reservation, idempotency, execution state, and reconciliation.
- Do not restore SQLite runtime fallback, shadow, dual-write, migration replay, or reconciliation authority.
- Alpaca is broker authority for current account state, positions, open orders, order status, and fills; reconcile exact broker evidence into PostgreSQL.
- Broker mutations require deterministic identity, durable lineage, current risk/capital authorization, and immediate pre-submit revalidation.
- Ambiguous broker outcomes reconcile by exact client-order identity; never blindly resubmit.
- Market-data freshness is an execution gate. Refresh, recompute, or reject stale evidence according to the lane-specific hard cutoff.
- If PostgreSQL cannot provide durable intent, reservation, idempotency, or risk authority, new broker submission fails closed.

## Feature-retention rule

Treat a feature as active only when current repository and deployed/runtime evidence proves it is intentionally supported and reachable.

Do not revive or preserve a capability merely because it appears in an old numbered Section, plan, branch, migration, feature flag, test fixture, dashboard panel, README history, or Basic Memory note.

Delete abandoned scaffolding and obsolete compatibility paths when they have no current operational or safety purpose. Preserve safety invariants, PostgreSQL authority, broker reconciliation, idempotency, current market-data gates, and validated strategy/execution paths.

## Current work rule

Work from reproduced current defects and explicit current objectives. There is no implicit Section 11, Section 12, or other historical roadmap queue. Historical documents are provenance only unless explicitly reactivated.

## Latency acceptance

Do not use a generic 1-second, 2-second, or 5-second p95 target as the primary acceptance gate. Measure the deployed path by stage, establish lane-specific soft SLOs from evidence, and enforce hard freshness/pre-submit cutoffs that prevent stale-state submission.
