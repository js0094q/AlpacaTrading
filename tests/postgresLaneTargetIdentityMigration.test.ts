import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL(
  "../src/lib/database/migrations/010_lane_aware_target_identity.sql",
  import.meta.url
);

const indexOf = (sql: string, snippet: string) => {
  const index = sql.indexOf(snippet);
  assert.notEqual(index, -1, `missing SQL: ${snippet}`);
  return index;
};

test("migration 010 backfills lane-aware target identity before replacing keys", async () => {
  const sql = await readFile(migrationPath, "utf8");

  const additions = [
    "ALTER TABLE target_snapshots\n  ADD COLUMN strategy_family text,\n  ADD COLUMN expression_id text;",
    "ALTER TABLE options_strategy_snapshots\n  ADD COLUMN strategy_family text,\n  ADD COLUMN expression_id text;"
  ];
  const updates = [
    "UPDATE target_snapshots\nSET strategy_family = 'legacy_default', expression_id = 'legacy_default'\nWHERE strategy_family IS NULL OR expression_id IS NULL;",
    "UPDATE options_strategy_snapshots\nSET strategy_family = 'legacy_default', expression_id = 'legacy_default'\nWHERE strategy_family IS NULL OR expression_id IS NULL;"
  ];

  for (const addition of additions) {
    assert.match(addition, /strategy_family text/);
    assert.match(addition, /expression_id text/);
    assert.doesNotMatch(addition, /NOT NULL/);
  }

  const addTarget = indexOf(sql, additions[0]!);
  const addOptions = indexOf(sql, additions[1]!);
  const updateTarget = indexOf(sql, updates[0]!);
  const updateOptions = indexOf(sql, updates[1]!);

  assert.ok(addTarget < updateTarget, "target columns must be nullable before its legacy backfill");
  assert.ok(addOptions < updateOptions, "option columns must be nullable before its legacy backfill");

  for (const [table, primaryKey, check] of [
    ["target_snapshots", "target_snapshots_pkey", "target_snapshots_strategy_identity_nonempty"],
    [
      "options_strategy_snapshots",
      "options_strategy_snapshots_pkey",
      "options_strategy_snapshots_strategy_identity_nonempty"
    ]
  ] as const) {
    const drop = `ALTER TABLE ${table}\n  DROP CONSTRAINT ${primaryKey};`;
    const notNull = `ALTER TABLE ${table}\n  ALTER COLUMN strategy_family SET NOT NULL,\n  ALTER COLUMN expression_id SET NOT NULL;`;
    const nonempty = `ALTER TABLE ${table}\n  ADD CONSTRAINT ${check} CHECK (\n    btrim(strategy_family) <> ''\n    AND btrim(expression_id) <> ''\n  );`;
    const replacementKey = `ALTER TABLE ${table}\n  ADD CONSTRAINT ${primaryKey} PRIMARY KEY (symbol, as_of, risk_profile, strategy_family, expression_id);`;
    const dropIndex = indexOf(sql, drop);
    const notNullIndex = indexOf(sql, notNull);
    const nonemptyIndex = indexOf(sql, nonempty);
    const replacementKeyIndex = indexOf(sql, replacementKey);

    assert.ok(updateTarget < dropIndex, `${table} key replacement must follow target legacy backfill`);
    assert.ok(updateOptions < dropIndex, `${table} key replacement must follow option legacy backfill`);
    assert.ok(dropIndex < notNullIndex, `${table} must drop its generated key before making identity non-null`);
    assert.ok(notNullIndex < nonemptyIndex, `${table} must validate nonempty identity after backfill`);
    assert.ok(nonemptyIndex < replacementKeyIndex, `${table} must add the five-column key after validation`);
  }
});

test("migration 010 creates lane-aware family and as-of lookup indexes", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.match(
    sql,
    /CREATE INDEX target_snapshots_family_as_of_idx\s+ON target_snapshots \(strategy_family, as_of DESC, symbol\);/
  );
  assert.match(
    sql,
    /CREATE INDEX options_strategy_snapshots_family_as_of_idx\s+ON options_strategy_snapshots \(strategy_family, as_of DESC, symbol\);/
  );
  assert.doesNotMatch(sql, /sqlite/i);
});
