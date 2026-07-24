# Task 1 final correction

Implemented on top of `85f6c36` while preserving the working-tree `fence_token` rename.

## Exact contract

- Exported all 26 directive lifecycle states in order.
- Exported all 9 exact strategy classifications, including `standard_long_call`, `zero_dte_long_put`, and `leaps_long_call`.
- Added exact `WorkerExecutionContext`, `PersistedOrderIntent`, `DashboardTradeLifecycle`, `ExecutableOptionEvidence`, `ExitDecision`, service method, and result contracts.
- `validateCloseOperation` throws `SHORT_POSITION_REQUIRES_BUY_TO_COVER` or `LONG_POSITION_REQUIRES_SELL_TO_CLOSE` before any broker mapping.

## PostgreSQL migration and verifier

- Migration 006 uses named, conditionally-created constraints and rerunnable indexes/tables/triggers.
- Exact lifecycle/classification checks are persisted; legal transition edges are enforced by a PostgreSQL trigger.
- Lifecycle audit rows reject UPDATE/DELETE; reservation terminal transitions remain uniquely keyed.
- Schema verification discovers the added columns, tables, indexes, and all autonomous constraints; the nonexistent `order_intents.broker_order_id` column is not registered.

## Validation

- `npm run typecheck` — PASS.
- `git diff --check` — PASS.
- Direct contract import/array and migration inspection — PASS.
- Existing `tests/autonomousTradeLifecycleService.test.ts` remains stale and fails because it asserts the former 25-state and renamed-classification contract; no production compatibility alias changes the authoritative literals.
- No PostgreSQL credentials were present for a live DDL integration run.
