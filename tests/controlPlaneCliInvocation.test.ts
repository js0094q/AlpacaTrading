import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("historical control-plane migration commands are retired from package scripts", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  ) as { scripts: Record<string, string> };
  for (const action of ["snapshot", "backfill", "reconcile", "shadow", "status"]) {
    assert.equal(packageJson.scripts[`db:postgres:control-plane:${action}`], undefined);
  }
});

test("PostgreSQL authority cutover replaces SQLite reconciliation as the operational path", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  ) as { scripts: Record<string, string> };
  const service = await readFile(
    new URL("../src/services/postgresAuthorityCutoverService.ts", import.meta.url),
    "utf8"
  );
  assert.equal(
    packageJson.scripts["db:postgres:authority:cutover"],
    "tsx src/postgresOnlyCli.ts db:postgres:authority:cutover"
  );
  assert.match(service, /fresh_postgresql_authority_cutover/);
  assert.match(service, /historicalSqliteReconciliation: false/);
  assert.doesNotMatch(service, /node:sqlite|RESEARCH_DB_PATH/);
});
