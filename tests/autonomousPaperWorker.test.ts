import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as waitFor } from "node:timers/promises";

const repoRoot = process.cwd();
const workerPath = join(repoRoot, "scripts/autonomous-paper-worker.mjs");

const workstreams = [
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
  "system:recover"
] as const;

const completePostgresOnlyEnvironment = {
  ...process.env,
  ALPACA_ENV: "paper",
  TRADING_MODE: "paper",
  ALPACA_LIVE_TRADE: "false",
  LIVE_TRADING_ENABLED: "false",
  DATABASE_BACKEND: "postgres",
  POSTGRES_READS_ENABLED: "true",
  POSTGRES_WRITES_ENABLED: "true",
  POSTGRES_CONTROL_PLANE_AUTHORITY_ENABLED: "true",
  POSTGRES_SCHEDULER_AUTHORITY_ENABLED: "true",
  POSTGRES_EXECUTION_STATE_AUTHORITY_ENABLED: "true",
  POSTGRES_SHADOW_COMPARE_ENABLED: "false",
  POSTGRES_EXECUTION_STATE_SHADOW_ENABLED: "false",
  SQLITE_AUDIT_MIRROR_ENABLED: "false",
  AUTONOMOUS_RUNTIME_AUDIT_APPROVED: "true"
};

type FakeCall = {
  command: string;
  args: string[];
  safety: {
    alpacaEnv?: string;
    tradingMode?: string;
    alpacaLiveTrade?: string;
    liveTradingEnabled?: string;
  };
};

type FakeState = {
  cycleId: string;
  eventType: string;
  occurredAt: string;
  payload: Record<string, unknown>;
};

const readJsonLines = <T>(path: string): T[] => {
  if (!existsSync(path)) return [];
  const value = readFileSync(path, "utf8").trim();
  return value ? value.split("\n").map((line) => JSON.parse(line) as T) : [];
};

const runWorker = (options: {
  cwd?: string;
  failCommand?: string;
  failOutput?: string;
  failStateEvent?: string;
  environment?: Record<string, string>;
} = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "autonomous-paper-worker-"));
  const callsPath = join(directory, "calls.jsonl");
  const statesPath = join(directory, "states.jsonl");
  const activePath = join(directory, "active");
  const overlapPath = join(directory, "overlap");
  const fakeNpm = join(directory, "npm");
  writeFileSync(
    fakeNpm,
    `#!/usr/bin/env node
const { appendFileSync, existsSync, rmSync, writeFileSync } = require("node:fs");
const command = process.argv[3];
const args = process.argv.slice(4);
appendFileSync(process.env.WORKER_CALLS_PATH, JSON.stringify({
  command,
  args,
  safety: {
    alpacaEnv: process.env.ALPACA_ENV,
    tradingMode: process.env.TRADING_MODE,
    alpacaLiveTrade: process.env.ALPACA_LIVE_TRADE,
    liveTradingEnabled: process.env.LIVE_TRADING_ENABLED
  }
}) + "\\n");
if (command === "worker:state") {
  const value = (name) => args.find((entry) => entry.startsWith("--" + name + "="))?.slice(name.length + 3);
  const state = {
    cycleId: value("cycleId"),
    eventType: value("eventType"),
    occurredAt: value("occurredAt"),
    payload: JSON.parse(Buffer.from(value("payload"), "base64url").toString("utf8"))
  };
  appendFileSync(process.env.WORKER_STATES_PATH, JSON.stringify(state) + "\\n");
  if (state.eventType === process.env.WORKER_FAIL_STATE_EVENT) {
    process.stdout.write(JSON.stringify({ error: "worker-test-secret-state-failure" }));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ status: "persisted" }));
  process.exit(0);
}
if (existsSync(process.env.WORKER_ACTIVE_PATH)) {
  appendFileSync(process.env.WORKER_OVERLAP_PATH, command + "\\n");
}
writeFileSync(process.env.WORKER_ACTIVE_PATH, command);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
rmSync(process.env.WORKER_ACTIVE_PATH, { force: true });
if (command === process.env.WORKER_FAIL_COMMAND) {
  process.stdout.write(process.env.WORKER_FAIL_OUTPUT || JSON.stringify({ status: "failed", reason: "EXPECTED_TEST_FAILURE", token: "worker-test-secret" }));
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
      [workerPath, "--once", "--cycle-delay-ms=0"],
      {
        cwd: options.cwd ?? repoRoot,
        env: {
          ...completePostgresOnlyEnvironment,
          ...options.environment,
          PATH: `${directory}:${process.env.PATH}`,
          WORKER_CALLS_PATH: callsPath,
          WORKER_STATES_PATH: statesPath,
          WORKER_ACTIVE_PATH: activePath,
          WORKER_OVERLAP_PATH: overlapPath,
          WORKER_FAIL_COMMAND: options.failCommand ?? "",
          WORKER_FAIL_OUTPUT: options.failOutput ?? "",
          WORKER_FAIL_STATE_EVENT: options.failStateEvent ?? ""
        },
        encoding: "utf8",
        timeout: 15_000
      }
    );
    return {
      result,
      calls: readJsonLines<FakeCall>(callsPath),
      states: readJsonLines<FakeState>(statesPath),
      overlapped: existsSync(overlapPath)
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("autonomous worker rejects an unapproved runtime before invoking npm", () => {
  const result = spawnSync(
    process.execPath,
    [workerPath, "--once", "--cycle-delay-ms=0"],
    {
      cwd: repoRoot,
      env: {
        ...completePostgresOnlyEnvironment,
        AUTONOMOUS_RUNTIME_AUDIT_APPROVED: "false"
      },
      encoding: "utf8"
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /EVIDENCE_UTILIZATION_RUNTIME_AUDIT_REQUIRED/);
  assert.doesNotMatch(result.stdout, /worker_started|workstream_completed/);
});

test("approved worker validates the production contract and persists a complete sequential cycle", () => {
  const { result, calls, states, overlapped } = runWorker();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(overlapped, false, "workstreams and state writes must not overlap");

  const workstreamCalls = calls.filter((call) => call.command !== "worker:state");
  assert.deepEqual(workstreamCalls.map((call) => call.command), workstreams);
  assert.ok(calls.every((call) => call.safety.alpacaEnv === "paper"));
  assert.ok(calls.every((call) => call.safety.tradingMode === "paper"));
  assert.ok(calls.every((call) => call.safety.alpacaLiveTrade === "false"));
  assert.ok(calls.every((call) => call.safety.liveTradingEnabled === "false"));
  for (const index of [6, 7, 10, 11]) {
    assert.equal(workstreamCalls[index]!.args.includes("--confirmPaper"), true);
  }
  assert.equal(
    workstreamCalls[7]!.args.includes("--sections=equityBuys,equityAdds,optionBuys"),
    true
  );

  const expectedEvents = ["cycle_started"];
  for (const workstream of workstreams) {
    expectedEvents.push("workstream_started", "workstream_completed");
    const completed = states.find((state) =>
      state.eventType === "workstream_completed" && state.payload.workstream === workstream
    );
    assert.ok(completed, `${workstream} completion must be persisted`);
  }
  expectedEvents.push("cycle_completed", "worker_stopped");
  assert.deepEqual(states.map((state) => state.eventType), expectedEvents);
  assert.equal(new Set(states.map((state) => state.cycleId)).size, 1);
  assert.match(states[0]!.cycleId, /^[0-9a-f-]{36}$/i);
  assert.ok(states.every((state) => Number.isFinite(Date.parse(state.occurredAt))));
  assert.match(result.stdout, /"event":"cycle_completed"/);
  assert.match(result.stdout, /"event":"worker_stopped"/);
  assert.doesNotMatch(result.stdout + result.stderr, /worker-test-secret/);
});

test("an ordinary workstream failure fails fast with durable terminal state", () => {
  const { result, calls, states } = runWorker({ failCommand: "paper:review" });
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(
    calls.filter((call) => call.command !== "worker:state").map((call) => call.command),
    ["research:daily", "paper:review"]
  );
  assert.deepEqual(states.map((state) => state.eventType), [
    "cycle_started",
    "workstream_started",
    "workstream_completed",
    "workstream_started",
    "workstream_failed",
    "cycle_failed"
  ]);
  assert.equal(states.at(-2)?.payload.workstream, "paper:review");
  assert.equal(states.at(-1)?.payload.code, "WORKSTREAM_COMMAND_FAILED");
  assert.match(result.stdout, /"event":"workstream_failed"/);
  assert.match(result.stdout, /"event":"cycle_failed"/);
  assert.doesNotMatch(result.stdout, /"event":"cycle_completed"|"event":"worker_stopped"/);
  assert.doesNotMatch(result.stdout + result.stderr, /worker-test-secret/);
});

test("a PostgreSQL workstream failure preserves the exact safe dependency code", () => {
  const { result, states } = runWorker({
    failCommand: "paper:review",
    failOutput: JSON.stringify({ error: "POSTGRES_REVIEW_POSITION_EXISTS:CVS" })
  });
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  assert.equal(states.at(-2)?.eventType, "workstream_failed");
  assert.equal(states.at(-2)?.payload.code, "POSTGRES_REVIEW_POSITION_EXISTS");
  assert.equal(states.at(-1)?.eventType, "cycle_failed");
  assert.equal(states.at(-1)?.payload.code, "POSTGRES_REVIEW_POSITION_EXISTS");
  assert.doesNotMatch(result.stdout, /"event":"cycle_completed"/);
});

test("expected closed-market readiness conditions defer without stopping the worker", () => {
  for (const reasonCode of [
    "POSTGRES_OPTION_SNAPSHOTS_CURRENT_MISSING",
    "POSTGRES_DECISION_MARKET_SESSION_INELIGIBLE"
  ]) {
    const { result, calls, states } = runWorker({
      failCommand: "research:daily",
      failOutput: JSON.stringify({ error: `${reasonCode}:SPY` })
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(
      calls.filter((call) => call.command !== "worker:state").map((call) => call.command),
      workstreams
    );
    const researchCompletion = states.find((state) =>
      state.eventType === "workstream_completed" && state.payload.workstream === "research:daily"
    );
    assert.equal(researchCompletion?.payload.classification, "deferred");
    assert.equal(researchCompletion?.payload.code, "WORKSTREAM_DEFERRED");
    assert.equal(researchCompletion?.payload.reasonCode, reasonCode);
    assert.equal(states.some((state) => state.eventType === "workstream_failed"), false);
    assert.equal(states.some((state) => state.eventType === "cycle_failed"), false);
    assert.equal(states.some((state) => state.eventType === "cycle_completed"), true);
  }
});

test("a worker-state persistence failure is fatal before the workstream starts", () => {
  const { result, calls, states } = runWorker({ failStateEvent: "workstream_started" });
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(calls.map((call) => call.command), ["worker:state", "worker:state"]);
  assert.deepEqual(states.map((state) => state.eventType), [
    "cycle_started",
    "workstream_started"
  ]);
  assert.match(result.stdout, /AUTONOMOUS_WORKER_STATE_PERSIST_FAILED/);
  assert.doesNotMatch(result.stdout + result.stderr, /worker-test-secret-state-failure/);
});

test("SIGTERM during workstream-start persistence stops before launching the workstream", async () => {
  const directory = mkdtempSync(join(tmpdir(), "autonomous-paper-worker-signal-state-"));
  const callsPath = join(directory, "calls.jsonl");
  const statesPath = join(directory, "states.jsonl");
  const stateStartedPath = join(directory, "state-started");
  const fakeNpm = join(directory, "npm");
  writeFileSync(
    fakeNpm,
    `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require("node:fs");
const command = process.argv[3];
const args = process.argv.slice(4);
appendFileSync(process.env.WORKER_CALLS_PATH, JSON.stringify({ command, args }) + "\\n");
if (command !== "worker:state") process.exit(20);
const value = (name) => args.find((entry) => entry.startsWith("--" + name + "="))?.slice(name.length + 3);
const state = {
  cycleId: value("cycleId"),
  eventType: value("eventType"),
  occurredAt: value("occurredAt"),
  payload: JSON.parse(Buffer.from(value("payload"), "base64url").toString("utf8"))
};
if (state.eventType === "workstream_started") {
  writeFileSync(process.env.WORKER_STATE_STARTED_PATH, "started");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
}
appendFileSync(process.env.WORKER_STATES_PATH, JSON.stringify(state) + "\\n");
process.stdout.write(JSON.stringify({ status: "persisted" }));
`,
    { mode: 0o700 }
  );
  chmodSync(fakeNpm, 0o700);

  let child: ReturnType<typeof spawn> | undefined;
  try {
    let stdout = "";
    let stderr = "";
    child = spawn(process.execPath, [workerPath, "--cycle-delay-ms=0"], {
      cwd: repoRoot,
      env: {
        ...completePostgresOnlyEnvironment,
        PATH: `${directory}:${process.env.PATH}`,
        WORKER_CALLS_PATH: callsPath,
        WORKER_STATES_PATH: statesPath,
        WORKER_STATE_STARTED_PATH: stateStartedPath
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child!.once("close", (code, signal) => resolve({ code, signal }));
    });

    for (let attempt = 0; attempt < 200 && !existsSync(stateStartedPath); attempt += 1) {
      await waitFor(10);
    }
    assert.equal(existsSync(stateStartedPath), true, "state persistence did not start");
    child.kill("SIGTERM");
    const outcome = await Promise.race([
      closed,
      waitFor(5_000).then(() => ({ code: null, signal: "SIGALRM" as NodeJS.Signals }))
    ]);

    assert.equal(outcome.code, 0, stderr || stdout);
    assert.equal(outcome.signal, null, stderr || stdout);
    assert.deepEqual(
      readJsonLines<FakeState>(statesPath).map((state) => state.eventType),
      ["cycle_started", "workstream_started", "worker_stopped"]
    );
    assert.equal(
      readJsonLines<{ command: string }>(callsPath).every((call) => call.command === "worker:state"),
      true,
      "no workstream may launch after a stop requested during state persistence"
    );
    assert.match(stdout, /"event":"worker_stopped"/);
    assert.doesNotMatch(stdout + stderr, /AUTONOMOUS_WORKER_STATE_PERSIST_FAILED|worker_failed/);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a mismatched production command entry persists preflight_failed and runs no workstream", () => {
  const directory = mkdtempSync(join(tmpdir(), "autonomous-paper-worker-contract-"));
  mkdirSync(join(directory, "scripts"));
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  packageJson.scripts["paper:review"] = "node unapproved-entry.mjs";
  writeFileSync(join(directory, "package.json"), JSON.stringify(packageJson));
  writeFileSync(
    join(directory, "scripts", "autonomous-worker-command-contract.json"),
    readFileSync(join(repoRoot, "scripts", "autonomous-worker-command-contract.json"), "utf8")
  );
  try {
    const { result, calls, states } = runWorker({ cwd: directory });
    assert.notEqual(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(calls.map((call) => call.command), ["worker:state"]);
    assert.deepEqual(states.map((state) => state.eventType), ["preflight_failed"]);
    assert.equal(states[0]?.payload.code, "AUTONOMOUS_WORKER_COMMAND_CONTRACT_INVALID");
    assert.match(result.stdout, /AUTONOMOUS_WORKER_COMMAND_CONTRACT_INVALID/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("autonomous service fixes paper-only authority and bounds failure restarts", () => {
  const service = readFileSync(
    "server/systemd/alpaca-autonomous-paper.service",
    "utf8"
  );
  assert.match(service, /^Environment=TRADING_MODE=paper$/m);
  assert.match(service, /^Environment=ALPACA_ENV=paper$/m);
  assert.match(service, /^Environment=ALPACA_LIVE_TRADE=false$/m);
  assert.match(service, /^Environment=LIVE_TRADING_ENABLED=false$/m);
  assert.match(service, /^Environment=AUTONOMOUS_RUNTIME_AUDIT_APPROVED=true$/m);
  assert.match(service, /^Environment=DATABASE_BACKEND=postgres$/m);
  assert.match(service, /^Environment=POSTGRES_READS_ENABLED=true$/m);
  assert.match(service, /^Environment=POSTGRES_WRITES_ENABLED=true$/m);
  assert.match(service, /^Environment=POSTGRES_CONTROL_PLANE_AUTHORITY_ENABLED=true$/m);
  assert.match(service, /^Environment=POSTGRES_SCHEDULER_AUTHORITY_ENABLED=true$/m);
  assert.match(service, /^Environment=POSTGRES_EXECUTION_STATE_AUTHORITY_ENABLED=true$/m);
  assert.match(service, /^Environment=POSTGRES_SHADOW_COMPARE_ENABLED=false$/m);
  assert.match(service, /^Environment=POSTGRES_EXECUTION_STATE_SHADOW_ENABLED=false$/m);
  assert.match(service, /^Environment=SQLITE_AUDIT_MIRROR_ENABLED=false$/m);
  assert.match(service, /^ExecStart=\/usr\/bin\/npm run paper:autonomous -- --workstream-timeout-ms=3600000$/m);
  assert.match(service, /^StartLimitIntervalSec=300$/m);
  assert.match(service, /^StartLimitBurst=3$/m);
  assert.match(service, /^Restart=on-failure$/m);
  assert.match(service, /^RestartSec=30$/m);
  assert.match(service, /^KillMode=mixed$/m);
});
