import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const runCli = () => spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli.ts",
    "db:postgres:control-plane:reconcile"
  ],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME }
  }
);

const runInternalModule = () => spawnSync(
  process.execPath,
  ["--import", "tsx", "src/services/controlPlaneMigrationService.ts"],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME }
  }
);

const reportsSuccessfulCompletion = (stdout: string) => {
  try {
    const report = JSON.parse(stdout) as Record<string, unknown>;
    return report.status === "passed" && report.durableCheckpointVerified === true;
  } catch {
    return false;
  }
};

const runPackagedCli = () => spawnSync(
  "npm",
  ["run", "--silent", "db:postgres:control-plane:reconcile"],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME }
  }
);

test("direct CLI invocation is unsupported and cannot appear successful", () => {
  const result = runCli();
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    error: "CONTROL_PLANE_PACKAGED_CLI_REQUIRED"
  });
  assert.equal(reportsSuccessfulCompletion(result.stdout), false);
});

test("internal module exit zero without a completion report is not success", () => {
  const result = runInternalModule();
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(reportsSuccessfulCompletion(result.stdout), false);
});

test("the canonical packaged lifecycle reaches the CLI body", () => {
  const result = runPackagedCli();
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    error: "CONTROL_PLANE_SNAPSHOT_PATH_REQUIRED"
  });
});

test("package and CLI expose one canonical control-plane operational path", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const cli = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");

  assert.equal(
    packageJson.scripts["db:postgres:control-plane:backfill"],
    "tsx src/cli.ts db:postgres:control-plane:backfill"
  );
  assert.equal(
    packageJson.scripts["db:postgres:control-plane:reconcile"],
    "tsx src/cli.ts db:postgres:control-plane:reconcile"
  );
  assert.equal(packageJson.scripts["db:postgres:backfill"], undefined);
  assert.equal(packageJson.scripts["db:postgres:reconcile"], undefined);
  assert.doesNotMatch(cli, /command === "db:postgres:(?:backfill|reconcile|shadow)"/);
  assert.match(cli, /npm_lifecycle_event/);
  assert.match(cli, /CONTROL_PLANE_PACKAGED_CLI_REQUIRED/);
  assert.match(cli, /assertDurableControlPlaneCheckpoint/);
  assert.match(cli, /durableCheckpointVerified/);
  assert.match(cli, /discrepancyCategories/);
  assert.doesNotMatch(cli, /discrepancies:\s*result\.discrepancies/);
});
