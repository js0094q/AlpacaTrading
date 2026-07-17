import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const repoRoot = process.cwd();

test("persistent paper worker runs the guarded workstreams sequentially and survives bounded failures", () => {
  const directory = mkdtempSync(join(tmpdir(), "autonomous-paper-worker-"));
  const callsPath = join(directory, "calls.jsonl");
  const activePath = join(directory, "active");
  const overlapPath = join(directory, "overlap");
  const fakeNpm = join(directory, "npm");
  writeFileSync(
    fakeNpm,
    `#!/usr/bin/env node
const { appendFileSync, existsSync, unlinkSync, writeFileSync } = require("node:fs");
const script = process.argv[3];
appendFileSync(process.env.WORKER_CALLS_PATH, JSON.stringify(process.argv.slice(2)) + "\\n");
if (existsSync(process.env.WORKER_ACTIVE_PATH)) appendFileSync(process.env.WORKER_OVERLAP_PATH, script + "\\n");
writeFileSync(process.env.WORKER_ACTIVE_PATH, script);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
unlinkSync(process.env.WORKER_ACTIVE_PATH);
if (script === "paper:review") {
  process.stdout.write(JSON.stringify({ status: "failed", reason: "RECOVERABLE_API_TIMEOUT", token: "worker-test-secret" }));
  process.exit(1);
}
if (script === "paper:portfolio:review") {
  process.stdout.write(JSON.stringify({ error: "The scheduler job is already owned by another active lease." }));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ status: "success" }));
`,
    { mode: 0o700 }
  );
  chmodSync(fakeNpm, 0o700);

  try {
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, "scripts/autonomous-paper-worker.mjs"), "--once", "--cycle-delay-ms=0"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          WORKER_CALLS_PATH: callsPath,
          WORKER_ACTIVE_PATH: activePath,
          WORKER_OVERLAP_PATH: overlapPath,
          ALPACA_ENV: "paper",
          TRADING_MODE: "paper",
          ALPACA_LIVE_TRADE: "false",
          LIVE_TRADING_ENABLED: "false",
          DATABASE_BACKEND: "postgres",
          POSTGRES_READS_ENABLED: "true",
          POSTGRES_WRITES_ENABLED: "true",
          POSTGRES_CONTROL_PLANE_AUTHORITY_ENABLED: "true",
          POSTGRES_SCHEDULER_AUTHORITY_ENABLED: "true",
          POSTGRES_EXECUTION_STATE_AUTHORITY_ENABLED: "false",
          SQLITE_AUDIT_MIRROR_ENABLED: "false"
        },
        encoding: "utf8"
      }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const calls = readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(existsSync(overlapPath), false, "workstreams must not overlap");
    for (const argument of [
      "--riskProfile=aggressive",
      "--optionsEnabled=true",
      "--maxCandidates=10"
    ]) {
      assert.equal(calls[1].includes(argument), true);
    }
    for (const index of [6, 7, 10, 11]) {
      assert.equal(calls[index].includes("--confirmPaper"), true);
    }
    assert.equal(
      calls[7].includes("--sections=equityBuys,equityAdds,optionBuys"),
      true
    );
    assert.deepEqual(
      calls.map((args) => args.slice(0, 2)),
      [
        ["run", "research:daily"],
        ["run", "paper:review"],
        ["run", "paper:portfolio:review"],
        ["run", "paper:options:discover"],
        ["run", "paper:ops:review"],
        ["run", "paper:exit:review"],
        ["run", "paper:exit:execute"],
        ["run", "paper:execute:reviewed"],
        ["run", "hedge:review"],
        ["run", "hedge:exit:review"],
        ["run", "hedge:exit:execute"],
        ["run", "zero-dte:engine"],
        ["run", "zero-dte:exit:review"],
        ["run", "zero-dte:reconcile"],
        ["run", "paper:learn"],
        ["run", "system:recover"]
      ]
    );
    assert.match(result.stdout, /"event":"cycle_completed"/);
    assert.match(result.stdout, /"classification":"failed"/);
    assert.match(result.stdout, /"classification":"lease_unavailable"/);
    assert.doesNotMatch(result.stdout + result.stderr, /worker-test-secret/);

    const service = readFileSync(
      join(repoRoot, "server/systemd/alpaca-autonomous-paper.service"),
      "utf8"
    );
    assert.match(service, /^Type=simple$/m);
    assert.match(service, /^ExecStart=\/usr\/bin\/npm run paper:autonomous$/m);
    assert.match(service, /^Restart=always$/m);
    assert.match(service, /^Environment=SQLITE_AUDIT_MIRROR_ENABLED=false$/m);
    assert.doesNotMatch(service, /\.timer\b/);

    const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    assert.equal(
      packageJson.scripts["paper:autonomous"],
      "node scripts/autonomous-paper-worker.mjs"
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
