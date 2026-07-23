import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("historical execution-state migration commands are not packaged runtime paths", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  ) as { scripts: Record<string, string> };
  for (const action of ["backfill", "reconcile", "shadow", "status"]) {
    assert.equal(packageJson.scripts[`db:postgres:execution-state:${action}`], undefined);
  }
  assert.equal(
    packageJson.scripts["db:postgres:authority:cutover"],
    "tsx src/postgresOnlyCli.ts db:postgres:authority:cutover"
  );
});

test("Release 4 implementation remains testable but is not an enabled production command", async () => {
  const cli = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  ) as { scripts: Record<string, string> };
  assert.match(cli, /assertPostgresOnlyCliCommand\(command\)/);
  assert.equal(packageJson.scripts["test:release-4"]?.includes("executionStateMigration.test.ts"), true);
  assert.equal(packageJson.scripts["test:release-4"]?.includes("postgresExecutionStateRepository.test.ts"), true);
});
