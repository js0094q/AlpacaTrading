import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  "zero-dte:reconcile",
  "research:daily",
  "paper:options:discover",
  "paper:review",
  "paper:portfolio:review",
  "paper:ops:review",
  "hedge:review",
  "paper:execute:reviewed",
  "zero-dte:engine",
  "zero-dte:reconcile",
  "paper:exit:review",
  "zero-dte:exit:review",
  "hedge:exit:review",
  "paper:exit:execute",
  "hedge:exit:execute",
  "zero-dte:reconcile",
  "paper:order:cancel",
  "zero-dte:reconcile",
  "paper:learn",
  "system:recover"
] as const;

const executedCommands = [
  "zero-dte:reconcile",
  "research:daily",
  "paper:options:discover",
  "paper:review",
  "paper:portfolio:review",
  "paper:ops:review",
  "hedge:review",
  "paper:execute:reviewed",
  "zero-dte:reconcile",
  "zero-dte:engine",
  "zero-dte:reconcile",
  "paper:exit:review",
  "zero-dte:exit:review",
  "hedge:exit:review",
  "paper:exit:execute",
  "zero-dte:reconcile",
  "hedge:exit:execute",
  "zero-dte:reconcile",
  "paper:order:cancel",
  "zero-dte:reconcile",
  "paper:learn",
  "system:recover"
] as const;

const emptyRecoveryCounters = {
  researchRuns: 0,
  reservations: 0,
  reviews: 0,
  confirmations: 0,
  intents: 0,
  staleReadyIntents: 0,
  staleReadyCancelled: 0,
  staleReadyPreserved: 0,
  staleReadyReservationsReleased: 0,
  staleReadyAllocationsAdjusted: 0
} as const;

const acknowledgedMutationReceipt = {
  mutationReceiptId: "mutation_receipt_test",
  environment: "paper",
  intentId: "intent-test",
  cycleId: "cycle-test",
  workstream: "paper:execute:reviewed",
  schedulerRunId: "run-test",
  fencingToken: "42",
  deterministicClientOrderId: "pg-test",
  submissionAttemptSequence: 1,
  submissionAction: "opening",
  brokerOrderId: "broker-test",
  requestFingerprint: "a".repeat(64),
  requestedSymbol: "AAPL",
  requestedSide: "buy",
  requestedQuantity: "1",
  requestedNotional: null,
  requestedOrderType: "market",
  requestedLimitPrice: null,
  requestedStopPrice: null,
  requestedPositionIntent: "buy_to_open",
  submissionAttemptTimestamp: "2026-07-28T16:00:00.000Z",
  brokerAcknowledgementTimestamp: "2026-07-28T16:00:01.000Z",
  outcomeClassification: "submission_acknowledged",
  resultingLifecycleState: "broker_order_accepted"
} as const;

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
  workerPid?: number;
  cycleId?: string;
  resumeCycleId?: string;
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
  failStateEventOnce?: string;
  invalidStateEvent?: string;
  stateResponseEvent?: string;
  stateResponseOnce?: boolean;
  stateResponseScenario?:
    | "ambiguous"
    | "canonical"
    | "missing"
    | "telemetry"
    | "wrong_cycle"
    | "wrong_operation";
  stopAfterCycleStarts?: number;
  once?: boolean;
  successCommand?: string;
  successOutput?: string;
  successOutputs?: Record<string, string>;
  resumeCycleId?: string;
  environment?: Record<string, string>;
} = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "autonomous-paper-worker-"));
  const callsPath = join(directory, "calls.jsonl");
  const statesPath = join(directory, "states.jsonl");
  const activePath = join(directory, "active");
  const overlapPath = join(directory, "overlap");
  const stateFailurePath = join(directory, "state-failure");
  const stateResponsePath = join(directory, "state-response");
  const cycleCountPath = join(directory, "cycle-count");
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
  workerPid: process.ppid,
  cycleId: process.env.AUTONOMOUS_CYCLE_ID,
  resumeCycleId: process.env.AUTONOMOUS_RESUME_CYCLE_ID,
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
  const failOnce =
    state.eventType === process.env.WORKER_FAIL_STATE_EVENT_ONCE &&
    !existsSync(process.env.WORKER_STATE_FAILURE_PATH);
  if (failOnce) writeFileSync(process.env.WORKER_STATE_FAILURE_PATH, "failed");
  if (state.eventType === process.env.WORKER_FAIL_STATE_EVENT || failOnce) {
    const persistenceClassification =
      state.eventType === "preflight_failed"
        ? "OBSERVABILITY_SUPPLEMENTAL"
        : "AUTHORITATIVE_RECOVERABLE";
    process.stdout.write(JSON.stringify({
      error: {
        code: "AUTONOMOUS_WORKER_STATE_PERSIST_FAILED",
        message: "worker-test-secret-state-failure"
      },
      persistence: {
        operationName: "persist_autonomous_worker_state:" + state.eventType,
        persistenceClassification,
        cycleId: state.cycleId,
        workstreamName: String(state.payload.workstream || "autonomous_worker"),
        lifecycleState: state.eventType,
        retryAttempt: 2,
        maximumAttempts: 3,
        errorCode: "08006",
        postgresErrorCode: "08006",
        retryable: true,
        schedulerFenceStatus: "held",
        transactionStatus: "rolled_back_or_not_started",
        finalDisposition:
          persistenceClassification === "OBSERVABILITY_SUPPLEMENTAL"
            ? "SUPPLEMENTAL_WRITE_SKIPPED"
            : "CYCLE_FAILED_WORKER_CONTINUED",
        timestamp: "2026-07-28T15:00:00.000Z"
      }
    }));
    process.exit(1);
  }
  if (state.eventType === "cycle_started") {
    const prior = existsSync(process.env.WORKER_CYCLE_COUNT_PATH)
      ? Number(require("node:fs").readFileSync(process.env.WORKER_CYCLE_COUNT_PATH, "utf8"))
      : 0;
    const count = prior + 1;
    writeFileSync(process.env.WORKER_CYCLE_COUNT_PATH, String(count));
    if (count === Number(process.env.WORKER_STOP_AFTER_CYCLE_STARTS || 0)) {
      process.kill(process.ppid, "SIGTERM");
    }
  }
  const responseScenarioConfigured =
    (
      state.eventType === process.env.WORKER_STATE_RESPONSE_EVENT ||
      process.env.WORKER_STATE_RESPONSE_EVENT === "*"
    ) &&
    (
      process.env.WORKER_STATE_RESPONSE_ONCE !== "true" ||
      !existsSync(process.env.WORKER_STATE_RESPONSE_PATH)
    );
  if (responseScenarioConfigured && process.env.WORKER_STATE_RESPONSE_ONCE === "true") {
    writeFileSync(process.env.WORKER_STATE_RESPONSE_PATH, "used");
  }
  const responseScenario =
    state.eventType === process.env.WORKER_INVALID_STATE_EVENT
      ? "invalid"
      : responseScenarioConfigured
        ? process.env.WORKER_STATE_RESPONSE_SCENARIO
        : "canonical";
  const operation = "persist_autonomous_worker_state:" + state.eventType;
  const canonical = {
    environment: "paper",
    paperOnly: true,
    liveTradingEnabled: false,
    command: "worker:state",
    operation,
    eventType: state.eventType,
    cycleId: state.cycleId,
    status: "persisted",
    persisted: true,
    eventId: "worker-state-test-event",
    ...(state.eventType === "cycle_started" && process.env.WORKER_RESUME_CYCLE_ID
      ? { resumedCycleId: process.env.WORKER_RESUME_CYCLE_ID }
      : {})
  };
  const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  const leaseAcquired = {
    event: "postgres_scheduler_lease_acquired",
    command: "worker:state",
    cycleId: state.cycleId
  };
  const leaseReleased = {
    event: "postgres_scheduler_lease_released",
    command: "worker:state",
    cycleId: state.cycleId
  };
  if (responseScenario === "telemetry") emit(leaseAcquired);
  if (responseScenario === "missing") {
    emit(leaseReleased);
  } else if (responseScenario === "wrong_operation") {
    emit({ ...canonical, operation: "persist_autonomous_worker_state:cycle_failed" });
  } else if (responseScenario === "wrong_cycle") {
    emit({ ...canonical, cycleId: "00000000-0000-4000-8000-000000000000" });
  } else if (responseScenario === "invalid") {
    emit({ ...canonical, status: "unexpected", persisted: false });
  } else if (responseScenario === "ambiguous") {
    emit(canonical);
    emit({ ...canonical, eventId: "worker-state-test-event-conflict" });
  } else {
    emit(canonical);
  }
  if (responseScenario === "telemetry") emit(leaseReleased);
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
const successOutputs = JSON.parse(process.env.WORKER_SUCCESS_OUTPUTS || "{}");
if (Object.prototype.hasOwnProperty.call(successOutputs, command)) {
  process.stdout.write(successOutputs[command]);
  process.exit(0);
}
if (command === "system:recover") {
  process.stdout.write(JSON.stringify({
    status: "completed",
    recovery: {
      researchRuns: 0,
      reservations: 0,
      reviews: 0,
      confirmations: 0,
      intents: 0,
      staleReadyIntents: 0,
      staleReadyCancelled: 0,
      staleReadyPreserved: 0,
      staleReadyReservationsReleased: 0,
      staleReadyAllocationsAdjusted: 0
    }
  }));
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
      [
        workerPath,
        ...(options.once === false ? [] : ["--once"]),
        "--cycle-delay-ms=0"
      ],
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
          WORKER_STATE_FAILURE_PATH: stateFailurePath,
          WORKER_STATE_RESPONSE_PATH: stateResponsePath,
          WORKER_CYCLE_COUNT_PATH: cycleCountPath,
          WORKER_FAIL_COMMAND: options.failCommand ?? "",
          WORKER_FAIL_OUTPUT: options.failOutput ?? "",
          WORKER_FAIL_STATE_EVENT: options.failStateEvent ?? "",
          WORKER_FAIL_STATE_EVENT_ONCE: options.failStateEventOnce ?? "",
          WORKER_INVALID_STATE_EVENT: options.invalidStateEvent ?? "",
          WORKER_STATE_RESPONSE_EVENT: options.stateResponseEvent ?? "",
          WORKER_STATE_RESPONSE_ONCE: String(options.stateResponseOnce ?? false),
          WORKER_STATE_RESPONSE_SCENARIO: options.stateResponseScenario ?? "canonical",
          WORKER_STOP_AFTER_CYCLE_STARTS: String(options.stopAfterCycleStarts ?? 0),
          WORKER_SUCCESS_COMMAND: options.successCommand ?? "",
          WORKER_SUCCESS_OUTPUT: options.successOutput ?? "",
          WORKER_SUCCESS_OUTPUTS: JSON.stringify(options.successOutputs ?? {}),
          WORKER_RESUME_CYCLE_ID: options.resumeCycleId ?? ""
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
  process.stdout.write(JSON.stringify({
    environment: "paper",
    paperOnly: true,
    liveTradingEnabled: false,
    command: "worker:state",
    operation: "persist_autonomous_worker_state:" + value("eventType"),
    eventType: value("eventType"),
    cycleId: value("cycleId"),
    status: "persisted",
    persisted: true
  }));
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
  assert.deepEqual(workstreamCalls.map((call) => call.command), executedCommands);
  assert.ok(workstreamCalls.every((call) => call.cycleId === states[0]?.cycleId));
  assert.ok(workstreamCalls.every((call) => call.workstream === call.command));
  assert.equal(
    workstreamCalls.find((call) => call.command === "research:daily")
      ?.args.includes("--maxCandidates=25"),
    true
  );
  assert.ok(calls.every((call) => call.safety.alpacaEnv === "paper"));
  assert.ok(calls.every((call) => call.safety.tradingMode === "paper"));
  assert.ok(calls.every((call) => call.safety.alpacaLiveTrade === "false"));
  assert.ok(calls.every((call) => call.safety.liveTradingEnabled === "false"));
  for (const command of [
    "paper:execute:reviewed",
    "zero-dte:engine",
    "paper:exit:execute",
    "hedge:exit:execute",
    "paper:order:cancel"
  ]) {
    const call = workstreamCalls.find((candidate) => candidate.command === command);
    assert.equal(call?.args.includes("--confirmPaper"), true, command);
  }
  const cancellation = workstreamCalls.find((call) => call.command === "paper:order:cancel");
  assert.equal(cancellation?.args.includes("--autonomous"), true);
  const entryExecution = workstreamCalls.find((call) => call.command === "paper:execute:reviewed");
  assert.equal(
    entryExecution?.args.includes("--sections=equityBuys,equityAdds,optionBuys"),
    true
  );
  assert.ok(
    workstreamCalls.findIndex((call) => call.command === "paper:portfolio:review") <
      workstreamCalls.findIndex((call) => call.command === "paper:ops:review")
  );
  assert.ok(
    workstreamCalls.findIndex((call) => call.command === "paper:ops:review") <
      workstreamCalls.findIndex((call) => call.command === "paper:execute:reviewed"),
    "the signed reviewed artifact must be refreshed before entry execution"
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
  assert.deepEqual(
    states
      .filter((state) => state.eventType === "workstream_started")
      .map((state) => state.payload.workstream),
    workstreams,
    "internal reconciliation must not increase the 20 public workstream states"
  );
  assert.match(states[0]!.cycleId, /^[0-9a-f-]{36}$/i);
  assert.ok(states.every((state) => Number.isFinite(Date.parse(state.occurredAt))));
  assert.match(result.stdout, /"event":"cycle_completed"/);
  assert.match(result.stdout, /"event":"worker_stopped"/);
  assert.doesNotMatch(result.stdout + result.stderr, /worker-test-secret/);
});

test("cycle-start persistence selects the exact canonical response around scheduler telemetry", () => {
  const { result, calls, states } = runWorker({
    stateResponseEvent: "*",
    stateResponseScenario: "telemetry"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    calls.find((call) => call.command !== "worker:state")?.command,
    "zero-dte:reconcile"
  );
  assert.equal(states.some((state) => state.eventType === "cycle_completed"), true);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /AUTONOMOUS_(?:CYCLE_START|WORKER_STATE)_RESPONSE_(?:MISSING|INVALID|AMBIGUOUS)/
  );
});

test("cycle-start persistence rejects missing, mismatched, invalid, and ambiguous canonical responses", () => {
  for (const testCase of [
    {
      name: "wrong operation discriminator",
      scenario: "wrong_operation",
      expectedCode: "AUTONOMOUS_CYCLE_START_RESPONSE_MISSING"
    },
    {
      name: "wrong cycle identity",
      scenario: "wrong_cycle",
      expectedCode: "AUTONOMOUS_CYCLE_START_RESPONSE_MISSING"
    },
    {
      name: "no canonical result",
      scenario: "missing",
      expectedCode: "AUTONOMOUS_CYCLE_START_RESPONSE_MISSING"
    },
    {
      name: "invalid canonical result",
      scenario: "canonical",
      invalidStateEvent: "cycle_started",
      expectedCode: "AUTONOMOUS_CYCLE_START_RESPONSE_INVALID"
    },
    {
      name: "conflicting canonical results",
      scenario: "ambiguous",
      expectedCode: "AUTONOMOUS_CYCLE_START_RESPONSE_AMBIGUOUS"
    }
  ] as const) {
    const { result, calls } = runWorker({
      stateResponseEvent: "cycle_started",
      stateResponseScenario: testCase.scenario,
      ...("invalidStateEvent" in testCase
        ? { invalidStateEvent: testCase.invalidStateEvent }
        : {})
    });

    assert.notEqual(result.status, 0, testCase.name);
    assert.equal(
      calls.some((call) => call.command !== "worker:state"),
      false,
      testCase.name
    );
    assert.match(result.stdout, new RegExp(testCase.expectedCode), testCase.name);
  }
});

test("a cycle-start response-selection failure remains cycle-scoped in one worker process", () => {
  const { result, calls, states } = runWorker({
    once: false,
    stateResponseEvent: "cycle_started",
    stateResponseOnce: true,
    stateResponseScenario: "missing",
    stopAfterCycleStarts: 2
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    states.filter((state) => state.eventType === "cycle_started").length,
    2
  );
  assert.equal(new Set(calls.map((call) => call.workerPid)).size, 1);
  assert.equal(
    calls.some((call) => call.command !== "worker:state"),
    false,
    "the worker must not launch a workstream before the second cycle-start checkpoint returns"
  );
  assert.match(result.stdout, /AUTONOMOUS_CYCLE_START_RESPONSE_MISSING/);
  assert.match(result.stdout, /"event":"cycle_incomplete_worker_continued"/);
  assert.doesNotMatch(result.stdout + result.stderr, /"event":"worker_failed"/);
});

test("the 20 public workstreams enforce lifecycle phase order and publish dashboard-ready state", () => {
  const { result, calls, states } = runWorker();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(workstreams.length, 20);
  assert.deepEqual(
    calls
      .filter((call) => call.command !== "worker:state")
      .map((call) => call.command),
    executedCommands
  );
  assert.equal(workstreams[0], "zero-dte:reconcile");
  assert.equal(workstreams.at(-1), "system:recover");

  for (const mutation of [
    "paper:execute:reviewed",
    "zero-dte:engine",
    "paper:exit:execute",
    "hedge:exit:execute",
    "paper:order:cancel"
  ] as const) {
    assert.equal(
      executedCommands[executedCommands.indexOf(mutation) + 1],
      "zero-dte:reconcile",
      `${mutation} must be immediately followed by reconciliation`
    );
  }
  assert.ok(
    executedCommands.indexOf("paper:portfolio:review") <
      executedCommands.indexOf("paper:ops:review")
  );
  assert.ok(
    executedCommands.indexOf("paper:ops:review") <
      executedCommands.indexOf("paper:execute:reviewed")
  );

  const dashboardRefresh = states.find(
    (state) =>
      state.eventType === "workstream_completed" &&
      state.payload.workstream === "paper:learn"
  );
  assert.equal(dashboardRefresh?.payload.dashboardProjectionReady, true);
  assert.equal(dashboardRefresh?.payload.dashboardProjectionAuthority, "postgres");
});

test("the worker preserves canonical success results from research output", () => {
  const workstreamResults = [
    {
      cycle_id: "research-cycle",
      lane: "equity",
      started_at: "2026-07-27T12:00:00.000Z",
      completed_at: "2026-07-27T12:00:01.000Z",
      outcome: "success",
      proposals: [{ id: "equity-proposal" }],
      evidence_references: ["candidate:equity"],
      reason_codes: ["RANKED_SELECTED"],
      diagnostic_summary: "Lane produced one proposal."
    }
  ];
  const { result, states } = runWorker({
    successOutputs: {
      "research:daily": JSON.stringify({
        status: "completed",
        workstreamResults
      })
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const completion = states.find(
    (state) =>
      state.eventType === "workstream_completed" &&
      state.payload.workstream === "research:daily"
  );
  assert.deepEqual(completion?.payload.workstreamResults, workstreamResults);
});

test("the worker preserves canonical results from a large research envelope", () => {
  const workstreamResults = [
    {
      cycle_id: "research-cycle-large",
      lane: "equity",
      started_at: "2026-07-27T12:00:00.000Z",
      completed_at: "2026-07-27T12:00:01.000Z",
      outcome: "success",
      proposals: [{ id: "equity-proposal", detail: "x".repeat(40 * 1024) }],
      evidence_references: ["candidate:equity"],
      reason_codes: ["RANKED_SELECTED"],
      diagnostic_summary: "Lane produced one proposal."
    }
  ];
  const researchOutput = JSON.stringify({
    status: "completed",
    workstreamResults
  });
  assert.ok(Buffer.byteLength(researchOutput) > 32 * 1024);

  const { result, states } = runWorker({
    successOutputs: {
      "research:daily": researchOutput
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const completion = states.find(
    (state) =>
      state.eventType === "workstream_completed" &&
      state.payload.workstream === "research:daily"
  );
  assert.deepEqual(completion?.payload.workstreamResults, workstreamResults);
});

test("a 0DTE lane failure is isolated while other broker mutation failures remain fatal", () => {
  const brokerMutations = [
    "paper:execute:reviewed",
    "zero-dte:engine",
    "paper:exit:execute",
    "hedge:exit:execute",
    "paper:order:cancel"
  ] as const;

  for (const [mutationPosition, mutation] of brokerMutations.entries()) {
    const { result, calls, states } = runWorker({
      failCommand: mutation,
      failOutput: JSON.stringify({
        status: "failed",
        code: "BROKER_SUBMISSION_AMBIGUOUS"
      })
    });
    const invoked = calls
      .filter((call) => call.command !== "worker:state")
      .map((call) => call.command);
    const mutationIndex = invoked.indexOf(mutation);
    assert.notEqual(mutationIndex, -1, mutation);
    assert.equal(
      invoked[mutationIndex + 1],
      "zero-dte:reconcile",
      mutation
    );
    if (mutation === "zero-dte:engine") {
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(invoked.at(-1), "system:recover");
      const completion = states.find(
        (state) =>
          state.eventType === "workstream_completed" &&
          state.payload.workstream === mutation
      );
      const [laneResult] = completion?.payload.workstreamResults as Array<{
        cycle_id: string;
        lane: string;
        outcome: string;
        reason_codes: string[];
        diagnostic_summary: string;
      }>;
      assert.equal(completion?.payload.classification, "lane_error");
      assert.equal(laneResult?.cycle_id, completion?.cycleId);
      assert.equal(laneResult?.lane, "options_0dte");
      assert.equal(laneResult?.outcome, "error");
      assert.deepEqual(laneResult?.reason_codes, ["BROKER_SUBMISSION_AMBIGUOUS"]);
      assert.ok(laneResult.diagnostic_summary.length <= 240);
      assert.equal(states.at(-2)?.eventType, "cycle_completed");
      continue;
    }
    assert.notEqual(
      result.status,
      0,
      `${mutation}: ${result.stderr || result.stdout}`
    );
    for (const laterMutation of brokerMutations.slice(mutationPosition + 1)) {
      assert.equal(invoked.includes(laterMutation), false, laterMutation);
    }
    assert.equal(states.at(-2)?.eventType, "workstream_failed", mutation);
    assert.equal(states.at(-2)?.payload.workstream, mutation, mutation);
    assert.equal(states.at(-1)?.eventType, "cycle_failed", mutation);
  }
});

test("an unresolved reconciliation prevents later broker mutations but still reaches terminal recovery", () => {
  const { result, calls, states } = runWorker({
    successOutputs: {
      "zero-dte:reconcile": JSON.stringify({
        status: "blocked",
        code: "POSTGRES_RECONCILIATION_UNRESOLVED"
      })
    }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const brokerMutations = new Set([
    "paper:execute:reviewed",
    "zero-dte:engine",
    "paper:exit:execute",
    "hedge:exit:execute",
    "paper:order:cancel"
  ]);
  const invoked = calls
    .filter((call) => call.command !== "worker:state")
    .map((call) => call.command);
  assert.equal(invoked.some((command) => brokerMutations.has(command)), false);
  assert.equal(invoked.at(-1), "system:recover");

  for (const workstream of brokerMutations) {
    const completion = states.find(
      (state) =>
        state.eventType === "workstream_completed" &&
        state.payload.workstream === workstream
    );
    assert.equal(completion?.payload.classification, "blocked", workstream);
    assert.equal(completion?.payload.code, "WORKSTREAM_BLOCKED", workstream);
    assert.equal(
      completion?.payload.reasonCode,
      "UNRESOLVED_PRIOR_MUTATION",
      workstream
    );
  }
  const skippedEntry = states.find(
    (state) =>
      state.eventType === "workstream_completed" &&
      state.payload.workstream === "paper:execute:reviewed"
  );
  const retryReconciliation = skippedEntry?.payload
    .postMutationReconciliation as Record<string, unknown> | undefined;
  assert.equal(retryReconciliation?.classification, "blocked");
  assert.equal(retryReconciliation?.code, "WORKSTREAM_BLOCKED");
  assert.equal(
    retryReconciliation?.reasonCode,
    "POSTGRES_RECONCILIATION_UNRESOLVED"
  );
  assert.equal(typeof retryReconciliation?.durationMs, "number");
  assert.equal(
    states.some(
      (state) =>
        state.eventType === "workstream_completed" &&
        state.payload.workstream === "system:recover"
    ),
    true
  );
});

test("worker restart passes persisted cycle context into initial reconciliation", () => {
  const resumedCycleId = "81ef842a-c66e-4f91-944d-65b78102ea50";
  const { result, calls, states } = runWorker({ resumeCycleId: resumedCycleId });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const firstWorkstream = calls.find((call) => call.command !== "worker:state");
  assert.equal(firstWorkstream?.command, "zero-dte:reconcile");
  assert.equal(firstWorkstream?.resumeCycleId, resumedCycleId);
  const initialCompletion = states.find(
    (state) =>
      state.eventType === "workstream_completed" &&
      state.payload.position === 1
  );
  assert.equal(initialCompletion?.payload.resumedCycleId, resumedCycleId);
  assert.match(result.stdout, /"event":"cycle_resuming"/);
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
    assert.equal(heartbeat.workstream, "zero-dte:reconcile");
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
  assert.equal(batch.position, 2);
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
    ["zero-dte:reconcile", "research:daily", "paper:options:discover", "paper:review"]
  );
  assert.deepEqual(states.map((state) => state.eventType), [
    "cycle_started",
    "workstream_started",
    "workstream_completed",
    "workstream_started",
    "workstream_completed",
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

test("expected market-data readiness conditions defer without stopping the worker", () => {
  for (const reasonCode of [
    "POSTGRES_STOCK_SNAPSHOT_STALE",
    "POSTGRES_REVIEW_MARKET_EVIDENCE_STALE",
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
      executedCommands
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

test("legitimate PostgreSQL empty-work outcomes are no-action completions across the full lifecycle", () => {
  const expected = {
    "paper:review": "NO_ELIGIBLE_POSTGRES_CANDIDATES",
    "paper:exit:review": "NO_POSTGRES_EXIT_TRIGGER",
    "paper:execute:reviewed": "NO_READY_POSTGRES_ORDER_INTENTS",
    "paper:order:cancel": "NO_CANCELLABLE_POSTGRES_ORDERS",
    "paper:learn": "NO_RECONCILIABLE_POSTGRES_ORDERS"
  } as const;
  const { result, calls, states } = runWorker({
    successOutputs: Object.fromEntries(
      Object.entries(expected).map(([command, code]) => [
        command,
        JSON.stringify({ status: "no_op", code })
      ])
    )
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(
    calls.filter((call) => call.command !== "worker:state").map((call) => call.command),
    executedCommands
  );
  const completions = states.filter((state) => state.eventType === "workstream_completed");
  assert.equal(completions.length, workstreams.length);
  for (const [workstream, reasonCode] of Object.entries(expected)) {
    const completion = completions.find((state) => state.payload.workstream === workstream);
    assert.equal(completion?.payload.classification, "no_action");
    assert.equal(completion?.payload.code, "WORKSTREAM_NO_ACTION");
    assert.equal(completion?.payload.reasonCode, reasonCode);
  }
  assert.equal(
    completions.some((state) => state.payload.code === "WORKSTREAM_BLOCKED"),
    false
  );
  assert.equal(states.some((state) => state.eventType === "cycle_completed"), true);
});

test("an acknowledged broker mutation is persisted as a mutation-bearing workstream success", () => {
  const { result, states } = runWorker({
    successOutputs: {
      "paper:execute:reviewed": JSON.stringify({
        status: "completed",
        submittedOrderCount: 1,
        evidence: { mutationReceipt: acknowledgedMutationReceipt }
      })
    }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const completion = states.find(
    (state) =>
      state.eventType === "workstream_completed" &&
      state.payload.workstream === "paper:execute:reviewed"
  );
  assert.equal(completion?.payload.classification, "success");
  assert.deepEqual(completion?.payload.mutationSummary, {
    mutationReceiptId: "mutation_receipt_test",
    intentId: "intent-test",
    clientOrderId: "pg-test",
    brokerOrderId: "broker-test",
    outcomeClassification: "submission_acknowledged",
    resultingLifecycleState: "broker_order_accepted"
  });
});

test("a workstream with a broker mutation cannot be persisted as no_action", () => {
  const { result, states } = runWorker({
    successOutputs: {
      "paper:execute:reviewed": JSON.stringify({
        status: "no_op",
        code: "NO_READY_POSTGRES_ORDER_INTENTS",
        submittedOrderCount: 1,
        evidence: { mutationReceipt: acknowledgedMutationReceipt }
      })
    }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const completion = states.find(
    (state) =>
      state.eventType === "workstream_completed" &&
      state.payload.workstream === "paper:execute:reviewed"
  );
  assert.notEqual(completion?.payload.classification, "no_action");
  assert.equal(completion?.payload.mutationSummary !== undefined, true);
});

test("a transport-unknown submission is mutation-indeterminate and lookup-oriented", () => {
  const receipt = {
    ...acknowledgedMutationReceipt,
    brokerOrderId: null,
    brokerAcknowledgementTimestamp: null,
    outcomeClassification: "submission_transport_unknown",
    resultingLifecycleState: "submission_ambiguous"
  };
  const { result, states } = runWorker({
    successOutputs: {
      "paper:execute:reviewed": JSON.stringify({
        status: "recovery_pending",
        code: "POSTGRES_BROKER_SUBMISSION_RECOVERY_PENDING",
        submittedOrderCount: 0,
        evidence: {
          recoveredFromAmbiguous: false,
          recoveryAttempts: 8,
          mutationReceipt: receipt
        }
      })
    }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const completion = states.find(
    (state) =>
      state.eventType === "workstream_completed" &&
      state.payload.workstream === "paper:execute:reviewed"
  );
  assert.equal(completion?.payload.classification, "mutation_indeterminate");
  assert.equal(
    (completion?.payload.mutationSummary as Record<string, unknown>)
      ?.outcomeClassification,
    "submission_transport_unknown"
  );
});

test("empty terminal recovery is a successful no-action outcome", () => {
  const { result, states } = runWorker({
    successOutputs: {
      "system:recover": JSON.stringify({
        status: "completed",
        recovery: emptyRecoveryCounters
      }, null, 2)
    }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const recovery = states.find(
    (state) =>
      state.eventType === "workstream_completed" &&
      state.payload.workstream === "system:recover"
  );
  assert.equal(recovery?.payload.classification, "no_action");
  assert.equal(recovery?.payload.code, "WORKSTREAM_NO_ACTION");
  assert.equal(
    recovery?.payload.reasonCode,
    "NO_RECOVERABLE_POSTGRES_STATE"
  );
});

test("empty terminal recovery remains no-action before trailing scheduler telemetry", () => {
  const { result, states } = runWorker({
    successOutputs: {
      "system:recover": [
        JSON.stringify({ event: "postgres_scheduler_lease_acquired" }),
        JSON.stringify({
          status: "completed",
          recovery: emptyRecoveryCounters
        }, null, 2),
        JSON.stringify({
          event: "postgres_scheduler_lease_released",
          releaseReason: "completed"
        })
      ].join("\n")
    }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const recovery = states.find(
    (state) =>
      state.eventType === "workstream_completed" &&
      state.payload.workstream === "system:recover"
  );
  assert.equal(recovery?.payload.classification, "no_action");
  assert.equal(recovery?.payload.reasonCode, "NO_RECOVERABLE_POSTGRES_STATE");
  assert.equal(states.some((state) => state.eventType === "cycle_completed"), true);
});

test("malformed empty recovery envelopes fail closed instead of becoming no-action", () => {
  const malformed = [
    {
      name: "missing terminal status",
      value: { recovery: emptyRecoveryCounters }
    },
    {
      name: "unrecognized terminal status",
      value: { status: "success", recovery: emptyRecoveryCounters }
    },
    {
      name: "null counter",
      value: {
        status: "completed",
        recovery: { ...emptyRecoveryCounters, intents: null }
      }
    },
    {
      name: "coerced string counter",
      value: {
        status: "completed",
        recovery: { ...emptyRecoveryCounters, reviews: "0" }
      }
    },
    {
      name: "missing counter",
      value: {
        status: "completed",
        recovery: Object.fromEntries(
          Object.entries(emptyRecoveryCounters)
            .filter(([field]) => field !== "confirmations")
        )
      }
    },
    {
      name: "future extra counter",
      value: {
        status: "completed",
        recovery: { ...emptyRecoveryCounters, futureRecoveryCount: 0 }
      }
    },
    {
      name: "negative counter",
      value: {
        status: "completed",
        recovery: { ...emptyRecoveryCounters, reservations: -1 }
      }
    },
    {
      name: "fractional counter",
      value: {
        status: "completed",
        recovery: { ...emptyRecoveryCounters, staleReadyIntents: 0.5 }
      }
    }
  ] as const;

  for (const testCase of malformed) {
    const { result, states } = runWorker({
      successOutputs: {
        "system:recover": JSON.stringify(testCase.value)
      }
    });
    assert.notEqual(result.status, 0, testCase.name);
    assert.equal(states.at(-2)?.eventType, "workstream_failed", testCase.name);
    assert.equal(
      states.at(-2)?.payload.code,
      "WORKSTREAM_COMMAND_FAILED",
      testCase.name
    );
    assert.equal(states.at(-1)?.eventType, "cycle_failed", testCase.name);
  }
});

test("learning authority, reconciliation, and database blockers remain blocked", () => {
  for (const reasonCode of [
    "POSTGRES_CONTROL_PLANE_AUTHORITY_REQUIRED",
    "POSTGRES_RECONCILIATION_ACCOUNT_PERSISTENCE_FAILED",
    "POSTGRES_RESEARCH_EVIDENCE_PERSISTENCE_FAILED",
    "SCHEDULER_FENCE_LOST",
    "BROKER_ORDER_LOOKUP_FAILED",
    "MALFORMED_BROKER_RESPONSE"
  ]) {
    const { result, calls, states } = runWorker({
      successOutputs: {
        "paper:learn": JSON.stringify({ status: "blocked", code: reasonCode })
      }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(
      calls.filter((call) => call.command !== "worker:state").map((call) => call.command),
      executedCommands
    );
    const learningCompletion = states.find((state) =>
      state.eventType === "workstream_completed" &&
      state.payload.workstream === "paper:learn"
    );
    assert.equal(learningCompletion?.payload.classification, "blocked");
    assert.equal(learningCompletion?.payload.code, "WORKSTREAM_BLOCKED");
    assert.equal(learningCompletion?.payload.reasonCode, reasonCode);
    assert.equal(states.some((state) => state.eventType === "workstream_failed"), false);
    assert.equal(states.some((state) => state.eventType === "cycle_failed"), false);
    assert.equal(states.some((state) => state.eventType === "cycle_completed"), true);
  }
});

test("a recoverable worker-state persistence failure scopes the cycle and the same worker starts the next cycle", () => {
  const { result, calls, states } = runWorker({
    failStateEventOnce: "workstream_started",
    stopAfterCycleStarts: 2,
    once: false
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const cycleStarts = states.filter((state) => state.eventType === "cycle_started");
  assert.equal(cycleStarts.length, 2);
  assert.notEqual(cycleStarts[0]?.cycleId, cycleStarts[1]?.cycleId);
  assert.equal(new Set(calls.map((call) => call.workerPid)).size, 1);
  assert.equal(
    states.some(
      (state) =>
        state.eventType === "cycle_failed" &&
        state.cycleId === cycleStarts[0]?.cycleId
    ),
    true
  );
  assert.equal(
    calls.some(
      (call) =>
        call.command !== "worker:state" &&
        call.cycleId === cycleStarts[0]?.cycleId
    ),
    false,
    "a workstream must not run when its authoritative checkpoint did not persist"
  );
  assert.match(result.stdout, /"event":"autonomous_worker_state_persistence_failure"/);
  assert.match(result.stdout, /"postgresErrorCode":"08006"/);
  assert.match(result.stdout, /"finalDisposition":"CYCLE_FAILED_WORKER_CONTINUED"/);
  assert.match(result.stdout, /"persistenceFailureCount":1/);
  assert.doesNotMatch(result.stdout + result.stderr, /worker-test-secret-state-failure/);
});

test("a failed workstream-completion checkpoint does not replay the workstream before the next cycle", () => {
  const { result, calls, states } = runWorker({
    failStateEventOnce: "workstream_completed",
    stopAfterCycleStarts: 2,
    once: false
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const cycleStarts = states.filter((state) => state.eventType === "cycle_started");
  assert.equal(cycleStarts.length, 2);
  assert.equal(new Set(calls.map((call) => call.workerPid)).size, 1);
  assert.deepEqual(
    calls
      .filter(
        (call) =>
          call.command !== "worker:state" &&
          call.cycleId === cycleStarts[0]?.cycleId
      )
      .map((call) => call.command),
    ["zero-dte:reconcile"]
  );
  assert.equal(
    calls.some(
      (call) =>
        call.command !== "worker:state" &&
        call.cycleId === cycleStarts[1]?.cycleId
    ),
    false
  );
  assert.equal(
    states.some(
      (state) =>
        state.eventType === "cycle_failed" &&
        state.cycleId === cycleStarts[0]?.cycleId
    ),
    true
  );
  assert.match(result.stdout, /"event":"cycle_failed_worker_continued"/);
  assert.doesNotMatch(result.stdout + result.stderr, /"event":"worker_failed"/);
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
process.stdout.write(JSON.stringify({
  environment: "paper",
  paperOnly: true,
  liveTradingEnabled: false,
  command: "worker:state",
  operation: "persist_autonomous_worker_state:" + state.eventType,
  eventType: state.eventType,
  cycleId: state.cycleId,
  status: "persisted",
  persisted: true
}));
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
    assert.equal(timeout.workstream, "zero-dte:reconcile");
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
    for (const stateFailure of [
      {},
      { failStateEvent: "preflight_failed" },
      { invalidStateEvent: "preflight_failed" }
    ] as const) {
      const { result, calls, states } = runWorker({
        cwd: directory,
        ...stateFailure
      });
      assert.notEqual(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(calls.map((call) => call.command), ["worker:state"]);
      assert.deepEqual(states.map((state) => state.eventType), ["preflight_failed"]);
      assert.equal(states[0]?.payload.code, "AUTONOMOUS_WORKER_COMMAND_CONTRACT_INVALID");
      assert.match(result.stdout, /AUTONOMOUS_WORKER_COMMAND_CONTRACT_INVALID/);
      if ("failStateEvent" in stateFailure) {
        assert.match(result.stdout, /"finalDisposition":"SUPPLEMENTAL_WRITE_SKIPPED"/);
        assert.match(result.stdout, /"persistenceFailureCount":1/);
        assert.doesNotMatch(result.stdout + result.stderr, /worker-test-secret-state-failure/);
      } else if ("invalidStateEvent" in stateFailure) {
        assert.match(result.stdout, /"finalDisposition":"SUPPLEMENTAL_WRITE_SKIPPED"/);
        assert.match(result.stdout, /"persistenceFailureCount":1/);
      }
    }
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
  assert.match(service, /^Environment=PAPER_EXPLORATION_DIRECTION_SCORE=0\.04$/m);
  assert.match(service, /^Environment=PAPER_EXPLORATION_MIN_DIRECTIONAL_CONFIDENCE=0\.05$/m);
  assert.match(service, /^Environment=PAPER_EXPLORATION_MIN_OPTION_LIQUIDITY_SCORE=0\.10$/m);
  assert.match(service, /^Environment=PAPER_EXPLORATION_MAX_OPTION_SPREAD_PCT=0\.15$/m);
  assert.match(service, /^Environment=PAPER_EXPLORATION_MIN_LONG_OPTION_CONFIDENCE=0\.20$/m);
  assert.match(service, /^Environment=PAPER_EXPLORATION_MIN_AGGRESSIVE_OPTION_CONFIDENCE=0\.35$/m);
  assert.match(service, /^Environment=PAPER_EXPLORATION_MIN_DEFINED_RISK_CONFIDENCE=0\.45$/m);
  assert.match(service, /^Environment=PAPER_EXPLORATION_MIN_OPTION_EXPECTED_RETURN_PCT=0\.20$/m);
  assert.match(service, /^Environment=PAPER_EXPLORATION_MIN_DEFINED_RISK_EXPECTED_RETURN_PCT=0\.40$/m);
  assert.match(service, /^Environment=PAPER_EXPLORATION_MAX_CANDIDATES=25$/m);
  assert.match(service, /^Environment=PAPER_EXPLORATION_MAX_ORDER_NOTIONAL=1000$/m);
  assert.match(service, /^Environment=LEAPS_MAX_ENTRY_CAPITAL_USD=5000$/m);
  assert.match(service, /^Environment=POSTGRES_READS_ENABLED=true$/m);
  assert.match(service, /^Environment=POSTGRES_WRITES_ENABLED=true$/m);
  assert.match(service, /^Environment=POSTGRES_CONTROL_PLANE_AUTHORITY_ENABLED=true$/m);
  assert.match(service, /^Environment=POSTGRES_SCHEDULER_AUTHORITY_ENABLED=true$/m);
  assert.match(service, /^Environment=POSTGRES_EXECUTION_STATE_AUTHORITY_ENABLED=true$/m);
  assert.match(service, /^Environment=POSTGRES_SHADOW_COMPARE_ENABLED=false$/m);
  assert.match(service, /^Environment=POSTGRES_EXECUTION_STATE_SHADOW_ENABLED=false$/m);
  assert.match(service, /^Environment=SQLITE_AUDIT_MIRROR_ENABLED=false$/m);
  assert.match(service, /^Environment=MARKET_OBSERVATORY_MAX_AGE_SECONDS=1800$/m);
  assert.match(service, /^Environment=PAPER_SUBMIT_QUOTE_MAX_AGE_SECONDS=1800$/m);
  assert.match(service, /^ExecStart=\/usr\/bin\/node scripts\/autonomous-paper-worker\.mjs --workstream-timeout-ms=3600000$/m);
  assert.doesNotMatch(service, /^ExecStart=.*npm run paper:autonomous/m);
  assert.match(service, /^StartLimitIntervalSec=300$/m);
  assert.match(service, /^StartLimitBurst=3$/m);
  assert.match(service, /^Restart=on-failure$/m);
  assert.match(service, /^RestartSec=30$/m);
  assert.match(service, /^KillMode=mixed$/m);
});

test("every protected production unit fixes the autonomous evidence window at 30 minutes", () => {
  const systemdRoot = join(repoRoot, "server/systemd");
  const protectedUnits = readdirSync(systemdRoot)
    .filter((name) => name.endsWith(".service"))
    .map((name) => ({
      name,
      source: readFileSync(join(systemdRoot, name), "utf8")
    }))
    .filter(({ source }) =>
      source.includes("EnvironmentFile=/opt/alpaca-investing/secrets/alpaca.env")
    );
  assert.ok(protectedUnits.length > 0);
  for (const { name, source } of protectedUnits) {
    assert.match(
      source,
      /^Environment=MARKET_OBSERVATORY_MAX_AGE_SECONDS=1800$/m,
      name
    );
    assert.match(
      source,
      /^Environment=PAPER_SUBMIT_QUOTE_MAX_AGE_SECONDS=1800$/m,
      name
    );
  }
});
