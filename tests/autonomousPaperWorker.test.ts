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
  "zero-dte:exit:review",
  "paper:exit:review",
  "paper:exit:execute",
  "paper:execute:reviewed",
  "hedge:review",
  "hedge:exit:review",
  "hedge:exit:execute",
  "zero-dte:engine",
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
  AUTONOMOUS_RUNTIME_AUDIT_APPROVED: "true",
  AUTONOMOUS_WORKER_FORCE_KILL_DELAY_MS: "1000"
};

type FakeCall = {
  command: string;
  args: string[];
  cycleId?: string;
  workstream?: string;
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
  workstreamProcessGroupAlive?: boolean;
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
  successCommand?: string;
  successOutput?: string;
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
  cycleId: process.env.AUTONOMOUS_CYCLE_ID,
  workstream: process.env.AUTONOMOUS_WORKSTREAM,
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
const workstreamDelayMs = Number(process.env.WORKER_WORKSTREAM_DELAY_MS || 5);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workstreamDelayMs);
rmSync(process.env.WORKER_ACTIVE_PATH, { force: true });
if (command === process.env.WORKER_FAIL_COMMAND) {
  process.stdout.write(process.env.WORKER_FAIL_OUTPUT || JSON.stringify({ status: "failed", reason: "EXPECTED_TEST_FAILURE", token: "worker-test-secret" }));
  process.exit(1);
}
if (command === process.env.WORKER_SUCCESS_COMMAND) {
  process.stdout.write(process.env.WORKER_SUCCESS_OUTPUT || JSON.stringify({ status: "success" }));
  process.exit(0);
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
          WORKER_FAIL_STATE_EVENT: options.failStateEvent ?? "",
          WORKER_SUCCESS_COMMAND: options.successCommand ?? "",
          WORKER_SUCCESS_OUTPUT: options.successOutput ?? ""
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

const outputEvents = (output: string): Array<Record<string, unknown>> =>
  output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });

const processIsAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const waitUntil = async (condition: () => boolean, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await waitFor(10);
  }
  return condition();
};

const startNestedWorkstreamWorker = (
  workerArguments: string[],
  descendantIgnoresSigterm = false
) => {
  const directory = mkdtempSync(join(tmpdir(), "autonomous-paper-worker-tree-"));
  const statesPath = join(directory, "states.jsonl");
  const startedPath = join(directory, "workstream-started");
  const commandPidPath = join(directory, "command-pid");
  const descendantPidPath = join(directory, "descendant-pid");
  const descendantReadyPath = join(directory, "descendant-ready");
  const fakeNpm = join(directory, "npm");
  writeFileSync(
    fakeNpm,
    `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const command = process.argv[3];
const args = process.argv.slice(4);
if (command === "worker:state") {
  const value = (name) => args.find((entry) => entry.startsWith("--" + name + "="))?.slice(name.length + 3);
  let workstreamProcessGroupAlive = false;
  if (value("eventType") === "worker_stopped") {
    try {
      const commandPid = Number(require("node:fs").readFileSync(process.env.WORKER_COMMAND_PID_PATH, "utf8"));
      process.kill(-commandPid, 0);
      workstreamProcessGroupAlive = true;
    } catch (error) {
      if (error?.code !== "ESRCH" && error?.code !== "ENOENT") throw error;
    }
  }
  appendFileSync(process.env.WORKER_STATES_PATH, JSON.stringify({
    cycleId: value("cycleId"),
    eventType: value("eventType"),
    occurredAt: value("occurredAt"),
    payload: JSON.parse(Buffer.from(value("payload"), "base64url").toString("utf8")),
    workstreamProcessGroupAlive
  }) + "\\n");
  process.stdout.write(JSON.stringify({ status: "persisted" }));
  process.exit(0);
}
const descendantSource = process.env.WORKER_DESCENDANT_IGNORES_SIGTERM === "true"
  ? "const { writeFileSync } = require('node:fs'); process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); writeFileSync(process.env.WORKER_DESCENDANT_READY_PATH, 'ready'); setInterval(() => {}, 1000);"
  : "const { writeFileSync } = require('node:fs'); process.on('SIGTERM', () => process.exit(0)); process.on('SIGINT', () => process.exit(0)); writeFileSync(process.env.WORKER_DESCENDANT_READY_PATH, 'ready'); setInterval(() => {}, 1000);";
const descendant = spawn(
  process.execPath,
  ["-e", descendantSource],
  { stdio: "ignore" }
);
writeFileSync(process.env.WORKER_COMMAND_PID_PATH, String(process.pid));
writeFileSync(process.env.WORKER_DESCENDANT_PID_PATH, String(descendant.pid));
writeFileSync(process.env.WORKER_STARTED_PATH, command);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
setInterval(() => {}, 1000);
`,
    { mode: 0o700 }
  );
  chmodSync(fakeNpm, 0o700);

  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, [workerPath, ...workerArguments], {
    cwd: repoRoot,
    env: {
      ...completePostgresOnlyEnvironment,
      PATH: `${directory}:${process.env.PATH}`,
      WORKER_STATES_PATH: statesPath,
      WORKER_STARTED_PATH: startedPath,
      WORKER_COMMAND_PID_PATH: commandPidPath,
      WORKER_DESCENDANT_PID_PATH: descendantPidPath,
      WORKER_DESCENDANT_READY_PATH: descendantReadyPath,
      WORKER_DESCENDANT_IGNORES_SIGTERM: String(descendantIgnoresSigterm)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  const cleanup = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    for (const path of [commandPidPath, descendantPidPath]) {
      if (!existsSync(path)) continue;
      const pid = Number(readFileSync(path, "utf8"));
      if (!Number.isSafeInteger(pid) || !processIsAlive(pid)) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    rmSync(directory, { recursive: true, force: true });
  };

  return {
    child,
    closed,
    startedPath,
    commandPidPath,
    descendantPidPath,
    descendantReadyPath,
    statesPath,
    stdout: () => stdout,
    stderr: () => stderr,
    cleanup
  };
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
  assert.ok(workstreamCalls.every((call) => call.cycleId === states[0]?.cycleId));
  assert.ok(workstreamCalls.every((call) => call.workstream === call.command));
  assert.equal(workstreamCalls[0]!.args.includes("--maxCandidates=25"), true);
  assert.ok(calls.every((call) => call.safety.alpacaEnv === "paper"));
  assert.ok(calls.every((call) => call.safety.tradingMode === "paper"));
  assert.ok(calls.every((call) => call.safety.alpacaLiveTrade === "false"));
  assert.ok(calls.every((call) => call.safety.liveTradingEnabled === "false"));
  for (const index of [7, 8, 11, 12]) {
    assert.equal(workstreamCalls[index]!.args.includes("--confirmPaper"), true);
  }
  assert.equal(
    workstreamCalls[8]!.args.includes("--sections=equityBuys,equityAdds,optionBuys"),
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

test("a running workstream emits a 30-second heartbeat with cycle and child identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "autonomous-paper-worker-heartbeat-"));
  const preloadPath = join(directory, "accelerate-heartbeat.mjs");
  writeFileSync(
    preloadPath,
    `const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (callback, delay, ...args) =>
  realSetInterval(callback, delay === 30_000 ? 20 : delay, ...args);
`
  );
  try {
    const nodeOptions = [process.env.NODE_OPTIONS, `--import=${preloadPath}`]
      .filter(Boolean)
      .join(" ");
    const { result } = runWorker({
      environment: {
        NODE_OPTIONS: nodeOptions,
        WORKER_WORKSTREAM_DELAY_MS: "75"
      }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const heartbeat = outputEvents(result.stdout).find(
      (event) => event.event === "workstream_heartbeat"
    );
    assert.ok(heartbeat, result.stdout);
    assert.equal(heartbeat.cycle, 1);
    assert.equal(heartbeat.position, 1);
    assert.equal(heartbeat.workstream, "research:daily");
    assert.match(String(heartbeat.cycleId), /^[0-9a-f-]{36}$/i);
    assert.equal(Number.isSafeInteger(heartbeat.childPid), true);
    assert.equal(typeof heartbeat.elapsedMs, "number");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("successful workstreams forward structured PostgreSQL telemetry with cycle identity", () => {
  const { result } = runWorker({
    successCommand: "research:daily",
    successOutput: [
      JSON.stringify({
        event: "postgres_option_snapshot_batch",
        batchNumber: 1,
        symbol: "SPY",
        rowsCommitted: 250,
        rowsReadBack: 250,
        outcome: "committed_and_read_back"
      }),
      JSON.stringify({ status: "success", token: "worker-test-secret-success-output" })
    ].join("\n")
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const events = outputEvents(result.stdout);
  const batch = events.find(
    (event) => event.event === "postgres_option_snapshot_batch"
  );
  assert.ok(batch, result.stdout);
  assert.equal(batch.cycle, 1);
  assert.equal(batch.position, 1);
  assert.equal(batch.workstream, "research:daily");
  assert.match(String(batch.cycleId), /^[0-9a-f-]{36}$/i);
  assert.equal(batch.batchNumber, 1);
  assert.equal(batch.symbol, "SPY");
  assert.equal(batch.rowsCommitted, 250);
  assert.equal(batch.rowsReadBack, 250);
  assert.doesNotMatch(result.stdout + result.stderr, /worker-test-secret-success-output/);
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
    "POSTGRES_DECISION_MARKET_SESSION_INELIGIBLE",
    "NO_ELIGIBLE_POSTGRES_CANDIDATES",
    "NO_READY_POSTGRES_ORDER_INTENTS"
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

test("successful PostgreSQL no-op output preserves its exact blocked reason", () => {
  const { result, states } = runWorker({
    successCommand: "paper:portfolio:review",
    successOutput: JSON.stringify({
      status: "no_op",
      code: "NO_OPEN_POSTGRES_POSITIONS"
    })
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const completion = states.find((state) =>
    state.eventType === "workstream_completed" &&
    state.payload.workstream === "paper:portfolio:review"
  );
  assert.equal(completion?.payload.classification, "blocked");
  assert.equal(completion?.payload.code, "WORKSTREAM_BLOCKED");
  assert.equal(completion?.payload.reasonCode, "NO_OPEN_POSTGRES_POSITIONS");
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

test("SIGTERM emits worker_stopping and terminates the active workstream process group", async () => {
  const worker = startNestedWorkstreamWorker(["--cycle-delay-ms=0"], true);
  try {
    assert.equal(
      await waitUntil(
        () => existsSync(worker.startedPath) && existsSync(worker.descendantReadyPath),
        3_000
      ),
      true,
      worker.stderr() || worker.stdout()
    );
    const descendantPid = Number(readFileSync(worker.descendantPidPath, "utf8"));
    const commandPid = Number(readFileSync(worker.commandPidPath, "utf8"));
    assert.equal(processIsAlive(descendantPid), true);

    worker.child.kill("SIGTERM");
    const outcome = await Promise.race([
      worker.closed,
      waitFor(10_000).then(() => ({ code: null, signal: "SIGALRM" as NodeJS.Signals }))
    ]);

    assert.equal(outcome.code, 0, worker.stderr() || worker.stdout());
    assert.equal(outcome.signal, null, worker.stderr() || worker.stdout());
    assert.equal(
      await waitUntil(() => !processIsAlive(descendantPid), 3_000),
      true,
      `descendant ${descendantPid} survived worker shutdown`
    );
    const events = outputEvents(worker.stdout());
    const stopping = events.find((event) => event.event === "worker_stopping");
    assert.ok(stopping, worker.stdout());
    assert.equal(stopping.signal, "SIGTERM");
    assert.equal(stopping.activeChildPid, commandPid);
    assert.equal(events.some((event) => event.event === "worker_stopped"), true);
    const states = readJsonLines<FakeState>(worker.statesPath);
    assert.deepEqual(
      states.map((state) => state.eventType),
      ["cycle_started", "workstream_started", "worker_stopped"]
    );
    assert.equal(
      states.at(-1)?.workstreamProcessGroupAlive,
      false,
      "worker_stopped must not be persisted while the workstream process group is alive"
    );
  } finally {
    worker.cleanup();
  }
});

test("workstream timeout emits telemetry and terminates the full process group", async () => {
  const worker = startNestedWorkstreamWorker(
    [
      "--once",
      "--cycle-delay-ms=0",
      "--workstream-timeout-ms=1000"
    ],
    true
  );
  try {
    assert.equal(
      await waitUntil(
        () => existsSync(worker.startedPath) && existsSync(worker.descendantReadyPath),
        3_000
      ),
      true,
      worker.stderr() || worker.stdout()
    );
    const descendantPid = Number(readFileSync(worker.descendantPidPath, "utf8"));
    const commandPid = Number(readFileSync(worker.commandPidPath, "utf8"));
    const outcome = await Promise.race([
      worker.closed,
      waitFor(10_000).then(() => ({ code: null, signal: "SIGALRM" as NodeJS.Signals }))
    ]);

    assert.equal(outcome.code, 1, worker.stderr() || worker.stdout());
    assert.equal(outcome.signal, null, worker.stderr() || worker.stdout());
    assert.equal(
      await waitUntil(() => !processIsAlive(descendantPid), 3_000),
      true,
      `descendant ${descendantPid} survived workstream timeout`
    );
    const timeout = outputEvents(worker.stdout()).find(
      (event) => event.event === "workstream_timeout"
    );
    assert.ok(timeout, worker.stdout());
    assert.equal(timeout.cycle, 1);
    assert.equal(timeout.position, 1);
    assert.equal(timeout.workstream, "research:daily");
    assert.equal(timeout.childPid, commandPid);
    assert.equal(typeof timeout.elapsedMs, "number");
    assert.deepEqual(
      readJsonLines<FakeState>(worker.statesPath).map((state) => state.eventType),
      ["cycle_started", "workstream_started", "workstream_failed", "cycle_failed"]
    );
  } finally {
    worker.cleanup();
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
  assert.match(service, /^Environment=PAPER_EXPLORATION_DIRECTION_SCORE=0\.05$/m);
  assert.match(service, /^Environment=PAPER_EXPLORATION_MIN_DIRECTIONAL_CONFIDENCE=0\.10$/m);
  assert.match(service, /^Environment=PAPER_EXPLORATION_MIN_OPTION_LIQUIDITY_SCORE=0\.10$/m);
  assert.match(service, /^Environment=PAPER_EXPLORATION_MAX_OPTION_SPREAD_PCT=0\.15$/m);
  assert.match(service, /^Environment=PAPER_EXPLORATION_MIN_LONG_OPTION_CONFIDENCE=0\.25$/m);
  assert.match(service, /^Environment=PAPER_EXPLORATION_MIN_AGGRESSIVE_OPTION_CONFIDENCE=0\.40$/m);
  assert.match(service, /^Environment=PAPER_EXPLORATION_MIN_DEFINED_RISK_CONFIDENCE=0\.50$/m);
  assert.match(service, /^Environment=PAPER_EXPLORATION_MIN_OPTION_EXPECTED_RETURN_PCT=0\.25$/m);
  assert.match(service, /^Environment=PAPER_EXPLORATION_MIN_DEFINED_RISK_EXPECTED_RETURN_PCT=0\.50$/m);
  assert.match(service, /^Environment=PAPER_EXPLORATION_MAX_CANDIDATES=25$/m);
  assert.match(service, /^Environment=PAPER_EXPLORATION_MAX_ORDER_NOTIONAL=1000$/m);
  assert.match(service, /^Environment=POSTGRES_READS_ENABLED=true$/m);
  assert.match(service, /^Environment=POSTGRES_WRITES_ENABLED=true$/m);
  assert.match(service, /^Environment=POSTGRES_CONTROL_PLANE_AUTHORITY_ENABLED=true$/m);
  assert.match(service, /^Environment=POSTGRES_SCHEDULER_AUTHORITY_ENABLED=true$/m);
  assert.match(service, /^Environment=POSTGRES_EXECUTION_STATE_AUTHORITY_ENABLED=true$/m);
  assert.match(service, /^Environment=POSTGRES_SHADOW_COMPARE_ENABLED=false$/m);
  assert.match(service, /^Environment=POSTGRES_EXECUTION_STATE_SHADOW_ENABLED=false$/m);
  assert.match(service, /^Environment=SQLITE_AUDIT_MIRROR_ENABLED=false$/m);
  assert.match(service, /^ExecStart=\/usr\/bin\/node scripts\/autonomous-paper-worker\.mjs --workstream-timeout-ms=3600000$/m);
  assert.doesNotMatch(service, /^ExecStart=.*npm run paper:autonomous/m);
  assert.match(service, /^StartLimitIntervalSec=300$/m);
  assert.match(service, /^StartLimitBurst=3$/m);
  assert.match(service, /^Restart=on-failure$/m);
  assert.match(service, /^RestartSec=30$/m);
  assert.match(service, /^KillMode=mixed$/m);
});
