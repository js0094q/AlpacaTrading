# Lane-Aware PostgreSQL Target Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make equity, standard-option, SPY 0DTE, SPY/QQQ LEAPS, and applicable hedge targets coexist durably without changing paper-trading authority or submitting an order.

**Architecture:** Introduce one canonical target-identity module, propagate its `strategyFamily` and `expressionId` through PostgreSQL feature/target output, and add migration 010 to replace both target-table primary keys with lane-aware keys. Keep the migration additive and explicit; ordinary worker startup verifies but never applies schema changes.

**Tech Stack:** TypeScript, Node.js test runner through `tsx`, PostgreSQL 17-compatible SQL, `pg`, fenced PostgreSQL repositories.

## Global Constraints

- Paper mode is required and live trading remains disabled.
- PostgreSQL is the sole operational authority; no SQLite production path may be introduced.
- Durable identity is exactly `(symbol, as_of, risk_profile, strategy_family, expression_id)`.
- Historical rows receive deterministic `legacy_default` identity without fabricating a former lane.
- Ordinary worker startup never applies this migration; only `npm run db:postgres:migrate` may apply it under separate authorization while affected services are stopped.
- Do not deploy, restart a service, alter secrets, submit a validation order, or manufacture a candidate while implementing this plan.
- Preserve the unrelated untracked `.codex/` directory.

---

## File Structure

- Create `src/services/targetIdentityService.ts`: normalize and validate strategy families and derive deterministic expression IDs.
- Create `tests/targetIdentityService.test.ts`: public-contract tests for equity, option, hedge, invalid, and legacy identities.
- Modify `src/repositories/postgres/postgresMarketDataRepository.ts`: carry identity fields and use the five-column conflict keys.
- Modify `src/services/postgresFeatureTargetService.ts`: attach canonical identity to every generated target.
- Modify `src/services/postgresResearchWorkflowService.ts`: preserve identity in research evidence and candidate IDs.
- Create `src/lib/database/migrations/010_lane_aware_target_identity.sql`: backfill, constrain, and replace both target-table primary keys.
- Create `tests/postgresLaneTargetIdentityMigration.test.ts`: static migration-contract tests.
- Modify `src/lib/database/postgresSchema.ts`: verify new columns, constraints, and indexes.
- Modify `tests/postgresSchema.test.ts`: schema-verifier fixtures and negative tests.
- Modify `tests/postgresMigrations.test.ts`: require migration 010 as the latest checked-in version.
- Modify `tests/postgresMarketDataRepository.test.ts`: prove same-symbol lane coexistence and exact SQL conflict keys.
- Modify `tests/postgresFeatureTargetService.test.ts`: prove generated 0DTE, LEAPS, standard-option, and equity identities are distinct.
- Modify `tests/postgresResearchWorkflowService.test.ts`: prove evidence and candidate joins retain identity.
- Inspect `src/services/postgresDashboardReadService.ts` and modify `tests/postgresDashboardReadService.test.ts`: prove its candidate-backed reads preserve distinct same-symbol option lanes without deriving identity again.
- Modify `README.md` and `RESUME_CONTEXT.md`: document the schema gate and rollback boundary.

### Task 1: Canonical Target Identity

**Files:**
- Create: `src/services/targetIdentityService.ts`
- Create: `tests/targetIdentityService.test.ts`

**Interfaces:**
- Produces: `TargetStrategyFamily`, `TargetIdentity`, and `targetIdentity(input)`.
- Consumes: an optional option symbol and an explicit preferred expression.

- [ ] **Step 1: Write the failing identity tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { targetIdentity } from "../src/services/targetIdentityService.js";

test("option identity binds its lane and exact contract", () => {
  assert.deepEqual(targetIdentity({
    strategyFamily: "zero_dte_spy",
    preferredExpression: "long_call",
    optionSymbol: "SPY260803C00630000"
  }), {
    strategyFamily: "zero_dte_spy",
    expressionId: "option:SPY260803C00630000"
  });
});

test("equity identity binds the explicit expression", () => {
  assert.deepEqual(targetIdentity({
    strategyFamily: "equity",
    preferredExpression: "shares",
    optionSymbol: null
  }), {
    strategyFamily: "equity",
    expressionId: "equity:shares"
  });
});

test("an option lane without an option symbol fails closed", () => {
  assert.throws(() => targetIdentity({
    strategyFamily: "leaps",
    preferredExpression: "long_call",
    optionSymbol: null
  }), /TARGET_OPTION_EXPRESSION_ID_REQUIRED/);
});
```

- [ ] **Step 2: Run the identity tests and verify RED**

Run: `npx tsx --test tests/targetIdentityService.test.ts`

Expected: FAIL because `targetIdentityService.ts` does not exist.

- [ ] **Step 3: Implement the minimal identity module**

```ts
export const TARGET_STRATEGY_FAMILIES = [
  "equity",
  "standard_option",
  "zero_dte_spy",
  "leaps",
  "portfolio_hedge",
  "legacy_default"
] as const;

export type TargetStrategyFamily =
  (typeof TARGET_STRATEGY_FAMILIES)[number];

export type TargetIdentity = {
  readonly strategyFamily: TargetStrategyFamily;
  readonly expressionId: string;
};

export const targetIdentity = (input: {
  readonly strategyFamily: Exclude<TargetStrategyFamily, "legacy_default">;
  readonly preferredExpression: string;
  readonly optionSymbol: string | null;
}): TargetIdentity => {
  const expression = input.preferredExpression.trim().toLowerCase();
  if (!expression) throw new Error("TARGET_EXPRESSION_REQUIRED");
  if (input.strategyFamily === "equity") {
    return { strategyFamily: "equity", expressionId: `equity:${expression}` };
  }
  const optionSymbol = input.optionSymbol?.trim().toUpperCase();
  if (!optionSymbol) throw new Error("TARGET_OPTION_EXPRESSION_ID_REQUIRED");
  return { strategyFamily: input.strategyFamily, expressionId: `option:${optionSymbol}` };
};
```

- [ ] **Step 4: Add hedge, normalization, and runtime-family validation**

Add assertions that `portfolio_hedge` uses the exact option contract, whitespace is normalized, and unknown families cannot enter through an `as never` test without throwing `TARGET_STRATEGY_FAMILY_INVALID`. Before deriving the expression, check the runtime value against `TARGET_STRATEGY_FAMILIES` and explicitly reject `legacy_default`; use the validated local family in the returned identity.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run: `npx tsx --test tests/targetIdentityService.test.ts`

Expected: PASS with no network or database access.

- [ ] **Step 6: Commit the identity contract**

```bash
git add src/services/targetIdentityService.ts tests/targetIdentityService.test.ts
git commit -m "Add canonical target lane identity"
```

### Task 2: Lane Identity on Generated PostgreSQL Targets

**Files:**
- Modify: `src/repositories/postgres/postgresMarketDataRepository.ts:139-157`
- Modify: `src/services/postgresFeatureTargetService.ts:778-908`
- Test: `tests/postgresFeatureTargetService.test.ts`

**Interfaces:**
- Consumes: `targetIdentity()` from Task 1.
- Produces: `PostgresTargetSnapshot.strategyFamily: TargetStrategyFamily` and `PostgresTargetSnapshot.expressionId: string`.

- [ ] **Step 1: Extend the public target type in a failing compile/test slice**

Add these required fields to `PostgresTargetSnapshot`:

```ts
strategyFamily: TargetStrategyFamily;
expressionId: string;
```

Run: `npm run typecheck`

Expected: FAIL at target producers and fixtures that do not yet provide the identity.

- [ ] **Step 2: Write the multi-lane feature-target regression**

Extend the existing SPY fixture with an eligible same-day call, a standard-dated call, and a LEAPS call. Assert:

```ts
assert.deepEqual(
  result.targets.map(({ strategyFamily }) => strategyFamily).sort(),
  ["leaps", "standard_option", "zero_dte_spy"].sort()
);
assert.equal(new Set(result.targets.map(({ expressionId }) => expressionId)).size, 3);
assert.equal(
  result.targets.every(({ expressionId }) => expressionId.startsWith("option:SPY")),
  true
);
```

Add an options-disabled case expecting `strategyFamily === "equity"` and `expressionId === "equity:shares"`.

- [ ] **Step 3: Run the feature-target test and verify RED**

Run: `npx tsx --test tests/postgresFeatureTargetService.test.ts`

Expected: FAIL because generated targets lack identity fields.

- [ ] **Step 4: Derive identity inside `targetFromFeature`**

Use the selected option candidate expiration with the existing `optionLane()` helper. Map no-contract share expressions to `equity`; map dated option contracts to `zero_dte_spy`, `leaps`, or `standard_option`. Call `targetIdentity()` exactly once per returned target and spread the result into `PostgresTargetSnapshot`.

```ts
const strategyFamily = optionCandidate
  ? optionLane(optionCandidate.expirationDate, input.feature.observedAt)
  : "equity";
const identity = targetIdentity({
  strategyFamily,
  preferredExpression: selector.preferredExpression,
  optionSymbol: optionCandidate?.optionSymbol ?? null
});
```

- [ ] **Step 5: Run feature tests and typecheck**

Run: `npx tsx --test tests/postgresFeatureTargetService.test.ts`

Run: `npm run typecheck`

Expected: focused tests PASS; remaining type failures, if any, point only to repository/test fixtures that Task 3 updates.

- [ ] **Step 6: Commit the producer slice**

```bash
git add src/repositories/postgres/postgresMarketDataRepository.ts src/services/postgresFeatureTargetService.ts tests/postgresFeatureTargetService.test.ts
git commit -m "Attach lane identity to Postgres targets"
```

### Task 3: PostgreSQL Migration 010

**Files:**
- Create: `src/lib/database/migrations/010_lane_aware_target_identity.sql`
- Create: `tests/postgresLaneTargetIdentityMigration.test.ts`
- Modify: `tests/postgresMigrations.test.ts`

**Interfaces:**
- Produces: five-column primary keys on `target_snapshots` and `options_strategy_snapshots`.
- Preserves: every historical row under `strategy_family = 'legacy_default'` and `expression_id = 'legacy_default'`.

- [ ] **Step 1: Write the failing migration-contract test**

```ts
const sql = await readFile(
  "src/lib/database/migrations/010_lane_aware_target_identity.sql",
  "utf8"
);
for (const table of ["target_snapshots", "options_strategy_snapshots"]) {
  assert.match(sql, new RegExp(`ALTER TABLE ${table}`));
  assert.match(sql, /strategy_family text/);
  assert.match(sql, /expression_id text/);
}
assert.match(sql, /PRIMARY KEY \(symbol, as_of, risk_profile, strategy_family, expression_id\)/);
assert.match(sql, /legacy_default/);
assert.doesNotMatch(sql, /sqlite/i);
```

Change the migration-order assertion to expect version `10` named `lane_aware_target_identity`.

- [ ] **Step 2: Run migration tests and verify RED**

Run: `npx tsx --test tests/postgresLaneTargetIdentityMigration.test.ts tests/postgresMigrations.test.ts`

Expected: FAIL because migration 010 is absent and version 9 is still latest.

- [ ] **Step 3: Add nullable columns and deterministic legacy backfill**

The migration must execute in this order:

```sql
ALTER TABLE target_snapshots
  ADD COLUMN strategy_family text,
  ADD COLUMN expression_id text;
ALTER TABLE options_strategy_snapshots
  ADD COLUMN strategy_family text,
  ADD COLUMN expression_id text;

UPDATE target_snapshots
SET strategy_family = 'legacy_default', expression_id = 'legacy_default'
WHERE strategy_family IS NULL OR expression_id IS NULL;
UPDATE options_strategy_snapshots
SET strategy_family = 'legacy_default', expression_id = 'legacy_default'
WHERE strategy_family IS NULL OR expression_id IS NULL;
```

The constant pair is deterministic and safe because the old primary key already guarantees one historical row per `(symbol, as_of, risk_profile)`.

- [ ] **Step 4: Replace keys and add constraints**

Drop each existing primary-key constraint by its PostgreSQL-generated name, set both columns `NOT NULL`, add nonempty checks named `target_snapshots_strategy_identity_nonempty` and `options_strategy_snapshots_strategy_identity_nonempty`, then add the exact five-column primary key. Add `target_snapshots_family_as_of_idx` on `(strategy_family, as_of DESC, symbol)` and the equivalent option-strategy index.

- [ ] **Step 5: Run migration-contract tests and verify GREEN**

Run: `npx tsx --test tests/postgresLaneTargetIdentityMigration.test.ts tests/postgresMigrations.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the migration slice**

```bash
git add src/lib/database/migrations/010_lane_aware_target_identity.sql tests/postgresLaneTargetIdentityMigration.test.ts tests/postgresMigrations.test.ts
git commit -m "Add lane-aware target identity migration"
```

### Task 4: Fenced Repository Upserts and Coexistence

**Files:**
- Modify: `src/repositories/postgres/postgresMarketDataRepository.ts:1149-1217`
- Modify: `tests/postgresMarketDataRepository.test.ts`

**Interfaces:**
- Consumes: required identity fields from Task 2.
- Produces: fenced upserts with `ON CONFLICT (symbol, as_of, risk_profile, strategy_family, expression_id)` for both tables.

- [ ] **Step 1: Write the failing SQL-shape and coexistence test**

Call `upsertTargetSnapshots()` with four SPY rows sharing `asOf` and `riskProfile` but using `equity`, `standard_option`, `zero_dte_spy`, and `leaps`. Capture the SQL and values, then assert both insert statements contain the five-column conflict target and all four identity pairs were submitted.

- [ ] **Step 2: Run the repository test and verify RED**

Run: `npx tsx --test tests/postgresMarketDataRepository.test.ts`

Expected: FAIL because the SQL still conflicts on the old three-column key.

- [ ] **Step 3: Update target and option-strategy writes**

Add `strategy_family` and `expression_id` to both insert column lists, values arrays, and conflict keys. Never update either identity column in `DO UPDATE`; identity selects the row and is immutable for that row.

- [ ] **Step 4: Add a conflicting-duplicate guard**

Before writes, deduplicate by the five-column identity and fail with `POSTGRES_TARGET_IDENTITY_CONFLICT` if two inputs share an identity but differ in fingerprint or material target values.

- [ ] **Step 5: Run repository and fence tests**

Run: `npx tsx --test tests/postgresMarketDataRepository.test.ts`

Expected: PASS, including the existing stale-fence rejection.

- [ ] **Step 6: Commit the repository slice**

```bash
git add src/repositories/postgres/postgresMarketDataRepository.ts tests/postgresMarketDataRepository.test.ts
git commit -m "Persist distinct target lane identities"
```

### Task 5: Evidence Keys, Candidate Joins, and Schema Verification

**Files:**
- Modify: `src/services/postgresResearchWorkflowService.ts:415-470,766-934`
- Inspect: `src/services/postgresDashboardReadService.ts`
- Modify: `src/lib/database/postgresSchema.ts`
- Modify: `tests/postgresResearchWorkflowService.test.ts`
- Modify: `tests/postgresDashboardReadService.test.ts`
- Modify: `tests/postgresSchema.test.ts`

**Interfaces:**
- Consumes: the five-column target identity.
- Produces: target evidence keys and candidate IDs that cannot collapse same-symbol lanes; schema verification for columns, checks, indexes, and primary-key shape.

- [ ] **Step 1: Write failing research identity tests**

For same-symbol 0DTE and LEAPS decisions, assert distinct `research_evidence.source_key`, distinct candidate IDs, and the expected `candidate.strategy_family`. The evidence key must be:

```ts
`${row.symbol}:${row.asOf}:${row.riskProfile}:${row.strategyFamily}:${row.expressionId}`
```

- [ ] **Step 2: Run the research tests and verify RED**

Run: `npx tsx --test tests/postgresResearchWorkflowService.test.ts`

Expected: FAIL because evidence still uses the old three-field key.

- [ ] **Step 3: Bind research evidence and candidates to identity**

Update the evidence key and include `strategyFamily` and `expressionId` in the canonical candidate-ID hash. Preserve the existing `strategy_family` candidate column and exact option symbol.

- [ ] **Step 4: Preserve lane identity in dashboard reads**

Add a regression fixture with same-cycle SPY candidates for `zero_dte_spy` and `leaps`, each using a distinct `option_symbol`. Assert both remain visible with their original `strategyFamily` and option symbol. The dashboard currently reads candidate identity rather than the target tables, so the expected implementation is test-only; if the regression fails, repair only the candidate-backed projection and do not add a second identity derivation path.

- [ ] **Step 5: Extend the schema verifier**

Add these required columns:

```ts
"target_snapshots.strategy_family",
"target_snapshots.expression_id",
"options_strategy_snapshots.strategy_family",
"options_strategy_snapshots.expression_id"
```

Add the two named nonempty constraints and family/as-of indexes to verifier metadata. Add a primary-key query using `pg_catalog.pg_constraint` plus `pg_get_constraintdef`, and require the ordered five-column definition for both tables.

- [ ] **Step 6: Add negative schema-verifier tests**

Assert verification fails separately for a missing identity column, invalid nonempty constraint, missing family index, and old three-column primary key.

- [ ] **Step 7: Run focused verification**

Run: `npx tsx --test tests/postgresResearchWorkflowService.test.ts tests/postgresDashboardReadService.test.ts tests/postgresSchema.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit evidence and verifier changes**

```bash
git add src/services/postgresResearchWorkflowService.ts src/lib/database/postgresSchema.ts tests/postgresResearchWorkflowService.test.ts tests/postgresDashboardReadService.test.ts tests/postgresSchema.test.ts
git commit -m "Retain lane identity through research evidence"
```

### Task 6: Disposable-PostgreSQL Verification and Documentation

**Files:**
- Modify: `tests/postgresNeonIntegration.test.ts`
- Modify: `README.md`
- Modify: `RESUME_CONTEXT.md`

**Interfaces:**
- Verifies: migration application, idempotent second application, same-symbol coexistence, and clean readback on disposable PostgreSQL.
- Does not authorize: applying migration 010 to the paper VPS.

- [ ] **Step 1: Add the integration assertion**

Inside the existing opt-in PostgreSQL integration test, migrate twice, insert four same-symbol rows using the new repository interface, and query:

```sql
SELECT strategy_family, expression_id
FROM target_snapshots
WHERE symbol = 'SPY' AND as_of = $1 AND risk_profile = 'aggressive'
ORDER BY strategy_family, expression_id
```

Assert four distinct rows and equivalent option-strategy rows where applicable.

- [ ] **Step 2: Run all focused local tests**

Run:

```bash
npx tsx --test \
  tests/targetIdentityService.test.ts \
  tests/postgresLaneTargetIdentityMigration.test.ts \
  tests/postgresMigrations.test.ts \
  tests/postgresMarketDataRepository.test.ts \
  tests/postgresFeatureTargetService.test.ts \
  tests/postgresResearchWorkflowService.test.ts \
  tests/postgresSchema.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the disposable PostgreSQL integration gate when a disposable URL is available**

Run: `POSTGRES_INTEGRATION_TEST_ENABLED=true npx tsx --test tests/postgresNeonIntegration.test.ts`

Expected: PASS. If no disposable database is available, record this gate as unverified; do not point it at the paper VPS.

- [ ] **Step 4: Update operational documentation**

Document migration 010, service-stop requirement, verification command, and rollback rule. Rollback before production migration is code rollback; after migration, retain the additive columns and deploy forward because dropping lane rows would be destructive.

- [ ] **Step 5: Run broad local gates**

Run: `npm run typecheck`

Run: `npm run build`

Run: `npm test`

Run: `git diff --check`

Run: `rg -n "DELETE FROM (target_snapshots|options_strategy_snapshots)" src scripts server`

Expected: all test/build checks PASS, and the retention scan produces no production deletion path. If a target cleanup path exists or is introduced, it must delete by an explicit age cutoff and preserve the full five-column identity; it may not select rows for deletion by the former three-column key. Classify any failure before changing unrelated code.

- [ ] **Step 6: Commit the verified persistence plan implementation**

```bash
git add tests/postgresNeonIntegration.test.ts README.md RESUME_CONTEXT.md
git commit -m "Verify lane-aware target persistence"
```

## Plan 1 Completion Gate

Do not begin scheduler concurrency until all local focused tests, typecheck, build, and the disposable migration test pass. The production database remains unchanged. Hand off the exact final SHA and the explicit statement that migration 010 has not been applied to the VPS.
