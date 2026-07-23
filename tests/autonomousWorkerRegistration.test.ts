import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { listSafePostgresOnlyCliCommands } from "../src/lib/database/postgresOnlyRuntime.js";
import { resolvePostgresSchedulerJob } from "../src/services/postgresSchedulerCommandRegistry.js";

const REQUIRED_COMMANDS = [
  "research:daily",
  "paper:review",
  "paper:portfolio:review",
  "paper:options:discover",
  "paper:ops:review",
  "paper:exit:review",
  "paper:exit:execute",
  "paper:execute:reviewed",
  "hedge:review",
  "hedge:exit:review",
  "hedge:exit:execute",
  "zero-dte:engine",
  "zero-dte:exit:review",
  "zero-dte:reconcile",
  "paper:learn",
  "system:recover",
  "worker:state"
] as const;

test("every autonomous command has an exact PostgreSQL-only production entry", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const contract = JSON.parse(await readFile(
    new URL("../scripts/autonomous-worker-command-contract.json", import.meta.url),
    "utf8"
  ));
  const allowed = new Set(listSafePostgresOnlyCliCommands());

  assert.equal(contract.version, 1);
  for (const command of REQUIRED_COMMANDS) {
    assert.equal(packageJson.scripts[command], `tsx src/postgresOnlyCli.ts ${command}`);
    assert.equal(allowed.has(command), true, `${command} must be production-allowed`);
    assert.deepEqual(contract.commands[command], {
      allowed: true,
      entry: `tsx src/postgresOnlyCli.ts ${command}`,
      persistence: "postgres",
      production: true,
      noOp: false,
      schedulerRegistered: true,
      sqliteFreeImportGraph: true,
      required: true
    });
    assert.ok(resolvePostgresSchedulerJob({ command }), `${command} must be scheduler registered`);
  }
});

test("the production entry point does not import the retired SQLite CLI", async () => {
  const source = await readFile(new URL("../src/postgresOnlyCli.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["']\.\/cli(?:\.js)?["']/);
  assert.doesNotMatch(source, /from\s+["']\.\/lib\/db(?:\.js)?["']/);
  assert.doesNotMatch(source, /better-sqlite3|node:sqlite/);
});

test("zero-dte reconciliation dispatches the PostgreSQL execution-state reconciler", async () => {
  const source = await readFile(new URL("../src/postgresOnlyCli.ts", import.meta.url), "utf8");
  assert.match(source, /command === "zero-dte:reconcile"/);
  assert.match(source, /reconcilePostgresPaperOrders/);
  assert.doesNotMatch(source, /executionStateProjectionService/);
});

test("research and review dispatch real PostgreSQL workflows", async () => {
  const source = await readFile(new URL("../src/postgresOnlyCli.ts", import.meta.url), "utf8");
  assert.match(source, /runPostgresResearchWorkflow/);
  assert.match(source, /runPostgresReviewWorkflow/);
});
