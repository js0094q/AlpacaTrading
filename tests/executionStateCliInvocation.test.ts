import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const run = (command: string, packaged: boolean) => spawnSync(
  packaged ? "npm" : process.execPath,
  packaged
    ? ["run", "--silent", command]
    : ["--import", "tsx", "src/cli.ts", command],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME }
  }
);

test("execution-state commands reject unsupported direct CLI execution", () => {
  const result = run("db:postgres:execution-state:reconcile", false);
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    error: "EXECUTION_STATE_PACKAGED_CLI_REQUIRED"
  });
});

test("importing the execution-state migration module performs no work", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/services/executionStateMigrationService.ts"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME }
    }
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("packaged execution-state reconciliation reaches the canonical CLI body", () => {
  const result = run("db:postgres:execution-state:reconcile", true);
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    error: "EXECUTION_STATE_SNAPSHOT_PATH_REQUIRED"
  });
});

test("package exposes one execution-state operational command family", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  ) as { scripts: Record<string, string> };
  const cli = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  for (const action of ["backfill", "reconcile", "shadow", "status"]) {
    const command = `db:postgres:execution-state:${action}`;
    assert.equal(packageJson.scripts[command], `tsx src/cli.ts ${command}`);
  }
  assert.equal(packageJson.scripts["db:postgres:execution:backfill"], undefined);
  assert.equal(packageJson.scripts["db:postgres:execution:reconcile"], undefined);
  assert.match(cli, /EXECUTION_STATE_PACKAGED_CLI_REQUIRED/);
  assert.match(cli, /assertDurableExecutionStateCheckpoint/);
  assert.match(cli, /durableCheckpointVerified/);
  assert.doesNotMatch(cli, /execution-state:repair/);
});
