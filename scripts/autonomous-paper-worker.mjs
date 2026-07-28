#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_CAPTURE_BYTES = 256 * 1024;
const DEFAULT_CYCLE_DELAY_MS = 30_000;
const DEFAULT_WORKSTREAM_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_WORKSTREAM_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const STATE_PERSIST_TIMEOUT_MS = 60_000;
const configuredForceKillDelayMs = Number(
  process.env.AUTONOMOUS_WORKER_FORCE_KILL_DELAY_MS ?? 20_000
);
const FORCE_KILL_DELAY_MS =
  Number.isSafeInteger(configuredForceKillDelayMs) &&
  configuredForceKillDelayMs >= 1_000 &&
  configuredForceKillDelayMs <= 25_000
    ? configuredForceKillDelayMs
    : 20_000;
const WORKSTREAM_HEARTBEAT_MS = 30_000;
const EXPECTED_DEFERRED_REASON_PATTERN = /\b(POSTGRES_STOCK_SNAPSHOT_STALE|POSTGRES_REVIEW_MARKET_EVIDENCE_STALE|POSTGRES_OPTION_SNAPSHOTS_CURRENT_MISSING|POSTGRES_DECISION_MARKET_SESSION_INELIGIBLE|NO_ELIGIBLE_POSTGRES_CANDIDATES|NO_READY_POSTGRES_ORDER_INTENTS)\b/;
const SUCCESSFUL_NO_ACTION_REASON_CODES = new Set([
  "NO_ELIGIBLE_POSTGRES_CANDIDATES",
  "NO_POSTGRES_EXIT_TRIGGER",
  "NO_READY_POSTGRES_ORDER_INTENTS",
  "NO_CANCELLABLE_POSTGRES_ORDERS",
  "NO_RECONCILIABLE_POSTGRES_ORDERS",
  "NO_RECOVERABLE_POSTGRES_STATE"
]);
const BROKER_MUTATION_WORKSTREAMS = new Set([
  "paper:execute:reviewed",
  "zero-dte:engine",
  "paper:exit:execute",
  "hedge:exit:execute",
  "paper:order:cancel"
]);
const INTERNAL_RECONCILIATION_AFTER = new Set([
  "paper:execute:reviewed",
  "paper:exit:execute"
]);
const RECONCILIATION_WORKSTREAM = "zero-dte:reconcile";
const RECONCILIATION_ARGS = ["--format=json"];
const NON_FATAL_WORKSTREAM_CODES = new Set([
  "WORKSTREAM_BLOCKED",
  "WORKSTREAM_SKIPPED",
  "WORKSTREAM_DEFERRED",
  "WORKSTREAM_NO_ACTION"
]);
const SERVICE_FATAL_CODES = new Set([
  "PAPER_RUNTIME_REQUIRED",
  "LIVE_TRADING_DISABLED_REQUIRED",
  "POSTGRES_BACKEND_REQUIRED",
  "POSTGRES_READS_REQUIRED",
  "POSTGRES_WRITES_REQUIRED",
  "POSTGRES_CONTROL_PLANE_AUTHORITY_REQUIRED",
  "POSTGRES_SCHEDULER_AUTHORITY_REQUIRED",
  "POSTGRES_EXECUTION_STATE_AUTHORITY_REQUIRED",
  "POSTGRES_SHADOW_COMPARE_DISABLED_REQUIRED",
  "POSTGRES_EXECUTION_STATE_SHADOW_DISABLED_REQUIRED",
  "SQLITE_AUDIT_MIRROR_DISABLED_REQUIRED",
  "EVIDENCE_UTILIZATION_RUNTIME_AUDIT_REQUIRED",
  "AUTONOMOUS_WORKER_COMMAND_CONTRACT_INVALID",
  "PAPER_SAFETY_GUARD_FAILED",
  "WORKSTREAM_COMMAND_REJECTED"
]);
const RECOVERY_COUNT_FIELDS = [
  "researchRuns",
  "reservations",
  "reviews",
  "confirmations",
  "intents",
  "staleReadyIntents",
  "staleReadyCancelled",
  "staleReadyPreserved",
  "staleReadyReservationsReleased",
  "staleReadyAllocationsAdjusted"
];
const configuredMaxCandidates = Number(process.env.PAPER_EXPLORATION_MAX_CANDIDATES ?? 25);
const PAPER_EXPLORATION_MAX_CANDIDATES =
  Number.isSafeInteger(configuredMaxCandidates) &&
  configuredMaxCandidates >= 1 &&
  configuredMaxCandidates <= 25
    ? configuredMaxCandidates
    : 25;

const WORKSTREAMS = [
  ["zero-dte:reconcile", ["--format=json"]],
  ["research:daily", ["--riskProfile=aggressive", "--optionsEnabled=true", `--maxCandidates=${PAPER_EXPLORATION_MAX_CANDIDATES}`, "--assetClass=all", "--format=json"]],
  ["paper:options:discover", ["--underlying=SPY", "--dte=0", "--format=json"]],
  ["paper:review", ["--riskProfile=aggressive", "--optionsEnabled=true", `--maxCandidates=${PAPER_EXPLORATION_MAX_CANDIDATES}`, "--format=json"]],
  ["paper:portfolio:review", ["--format=json"]],
  ["paper:ops:review", ["--format=json"]],
  ["hedge:review", ["--format=json"]],
  ["paper:execute:reviewed", ["--confirmPaper", "--sections=equityBuys,equityAdds,optionBuys", "--format=json"]],
  ["zero-dte:engine", ["--confirmPaper", "--format=json"]],
  ["zero-dte:reconcile", ["--format=json"]],
  ["paper:exit:review", ["--format=json"]],
  ["zero-dte:exit:review", ["--format=json"]],
  ["hedge:exit:review", ["--format=json"]],
  ["paper:exit:execute", ["--confirmPaper", "--format=json"]],
  ["hedge:exit:execute", ["--confirmPaper", "--format=json"]],
  ["zero-dte:reconcile", ["--format=json"]],
  ["paper:order:cancel", ["--autonomous", "--confirmPaper", "--format=json"]],
  ["zero-dte:reconcile", ["--format=json"]],
  ["paper:learn", ["--format=json"]],
  ["system:recover", ["--format=json"]]
];

const STATE_COMMAND = "worker:state";
const REQUIRED_COMMANDS = [
  ...new Set(WORKSTREAMS.map(([command]) => command)),
  STATE_COMMAND
];
const EXPECTED_CONTRACT_ENTRY = {
  allowed: true,
  persistence: "postgres",
  production: true,
  noOp: false,
  schedulerRegistered: true,
  sqliteFreeImportGraph: true,
  required: true
};

const normalized = (value) => String(value ?? "").trim().toLowerCase();
const isTrue = (value) => ["true", "1"].includes(normalized(value));
const isFalse = (value) => ["false", "0"].includes(normalized(value));
const emitEvent = (event) => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

const forwardWorkstreamTelemetryLine = (line, context, childPid) => {
  if (!context || !line.trim().startsWith("{")) return;
  try {
    const event = JSON.parse(line);
    if (
      !event ||
      typeof event !== "object" ||
      typeof event.event !== "string" ||
      !event.event.startsWith("postgres_")
    ) {
      return;
    }
    emitEvent({
      ...event,
      cycle: context.cycle,
      cycleId: context.cycleId,
      position: context.position,
      workstream: context.workstream,
      childPid
    });
  } catch {
    // Only complete one-line JSON telemetry events are forwarded.
  }
};

const killProcessGroup = (child, signal = "SIGTERM") => {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
};

const processGroupExists = (child) => {
  if (!child?.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
};

const waitForProcessGroupExit = (child) =>
  new Promise((resolve) => {
    const check = () => {
      if (!processGroupExists(child)) {
        resolve();
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });

const codedError = (code) => {
  const error = new Error(code);
  error.code = code;
  return error;
};

const codeOf = (error, fallback = "AUTONOMOUS_WORKER_FAILED") =>
  typeof error?.code === "string" ? error.code : fallback;

const argumentValue = (name) => {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
};

const boundedIntegerArgument = (name, fallback, { minimum, maximum, code }) => {
  const value = Number(argumentValue(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw codedError(code);
  }
  return value;
};

const cycleDelay = () => boundedIntegerArgument(
  "cycle-delay-ms",
  DEFAULT_CYCLE_DELAY_MS,
  { minimum: 0, maximum: 300_000, code: "AUTONOMOUS_WORKER_CYCLE_DELAY_INVALID" }
);

const workstreamTimeout = () => boundedIntegerArgument(
  "workstream-timeout-ms",
  DEFAULT_WORKSTREAM_TIMEOUT_MS,
  { minimum: 1_000, maximum: MAX_WORKSTREAM_TIMEOUT_MS, code: "AUTONOMOUS_WORKER_TIMEOUT_INVALID" }
);

const assertRuntime = () => {
  const failures = [];
  if (process.env.ALPACA_ENV !== "paper" || process.env.TRADING_MODE !== "paper") {
    failures.push("PAPER_RUNTIME_REQUIRED");
  }
  if (!isFalse(process.env.ALPACA_LIVE_TRADE) || !isFalse(process.env.LIVE_TRADING_ENABLED)) {
    failures.push("LIVE_TRADING_DISABLED_REQUIRED");
  }
  if (process.env.DATABASE_BACKEND !== "postgres") failures.push("POSTGRES_BACKEND_REQUIRED");
  if (!isTrue(process.env.POSTGRES_READS_ENABLED)) failures.push("POSTGRES_READS_REQUIRED");
  if (!isTrue(process.env.POSTGRES_WRITES_ENABLED)) failures.push("POSTGRES_WRITES_REQUIRED");
  if (!isTrue(process.env.POSTGRES_CONTROL_PLANE_AUTHORITY_ENABLED)) {
    failures.push("POSTGRES_CONTROL_PLANE_AUTHORITY_REQUIRED");
  }
  if (!isTrue(process.env.POSTGRES_SCHEDULER_AUTHORITY_ENABLED)) {
    failures.push("POSTGRES_SCHEDULER_AUTHORITY_REQUIRED");
  }
  if (!isTrue(process.env.POSTGRES_EXECUTION_STATE_AUTHORITY_ENABLED)) {
    failures.push("POSTGRES_EXECUTION_STATE_AUTHORITY_REQUIRED");
  }
  if (!isFalse(process.env.POSTGRES_SHADOW_COMPARE_ENABLED)) {
    failures.push("POSTGRES_SHADOW_COMPARE_DISABLED_REQUIRED");
  }
  if (!isFalse(process.env.POSTGRES_EXECUTION_STATE_SHADOW_ENABLED)) {
    failures.push("POSTGRES_EXECUTION_STATE_SHADOW_DISABLED_REQUIRED");
  }
  if (!isFalse(process.env.SQLITE_AUDIT_MIRROR_ENABLED)) {
    failures.push("SQLITE_AUDIT_MIRROR_DISABLED_REQUIRED");
  }
  if (!isTrue(process.env.AUTONOMOUS_RUNTIME_AUDIT_APPROVED)) {
    failures.push("EVIDENCE_UTILIZATION_RUNTIME_AUDIT_REQUIRED");
  }
  if (failures.length) throw codedError(failures[0]);
};

const readProductionContract = () => {
  try {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    const contract = JSON.parse(readFileSync(
      join(process.cwd(), "scripts", "autonomous-worker-command-contract.json"),
      "utf8"
    ));
    if (!packageJson?.scripts || typeof packageJson.scripts !== "object") {
      throw codedError("AUTONOMOUS_WORKER_COMMAND_CONTRACT_INVALID");
    }
    if (contract?.version !== 1 || !contract.commands || typeof contract.commands !== "object") {
      throw codedError("AUTONOMOUS_WORKER_COMMAND_CONTRACT_INVALID");
    }
    return { packageScripts: packageJson.scripts, contractCommands: contract.commands };
  } catch (error) {
    if (codeOf(error, "") === "AUTONOMOUS_WORKER_COMMAND_CONTRACT_INVALID") throw error;
    throw codedError("AUTONOMOUS_WORKER_COMMAND_CONTRACT_INVALID");
  }
};

const assertCommandEntry = ({ packageScripts, contractCommands }, command) => {
  const expectedEntry = `tsx src/postgresOnlyCli.ts ${command}`;
  const entry = contractCommands[command];
  if (packageScripts[command] !== expectedEntry || !entry || typeof entry !== "object") {
    throw codedError("AUTONOMOUS_WORKER_COMMAND_CONTRACT_INVALID");
  }
  if (entry.entry !== expectedEntry) {
    throw codedError("AUTONOMOUS_WORKER_COMMAND_CONTRACT_INVALID");
  }
  const expectedKeys = [...Object.keys(EXPECTED_CONTRACT_ENTRY), "entry"].sort();
  if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(expectedKeys)) {
    throw codedError("AUTONOMOUS_WORKER_COMMAND_CONTRACT_INVALID");
  }
  for (const [key, expected] of Object.entries(EXPECTED_CONTRACT_ENTRY)) {
    if (entry[key] !== expected) {
      throw codedError("AUTONOMOUS_WORKER_COMMAND_CONTRACT_INVALID");
    }
  }
};

const assertCompleteCommandContract = (contract) => {
  const actualCommands = Object.keys(contract.contractCommands).sort();
  const expectedCommands = [...REQUIRED_COMMANDS].sort();
  if (JSON.stringify(actualCommands) !== JSON.stringify(expectedCommands)) {
    throw codedError("AUTONOMOUS_WORKER_COMMAND_CONTRACT_INVALID");
  }
  for (const command of REQUIRED_COMMANDS) assertCommandEntry(contract, command);
};

const appendBounded = (current, chunk) => `${current}${chunk}`.slice(-MAX_CAPTURE_BYTES);

let activeChild = null;
let activeChildPurpose = null;
let wakeDelay = null;
let stopRequested = false;
let stopSignal = null;
let statePersistenceFailureCount = 0;
let shutdownForceKillTimer = null;
let shutdownForceKillChild = null;

const stopWorker = (signal) => {
  if (stopRequested) return;
  stopRequested = true;
  stopSignal = signal;
  emitEvent({
    event: "worker_stopping",
    signal,
    activeChildPid: activeChild?.pid ?? null
  });
  if (activeChildPurpose === "workstream" && activeChild) {
    const child = activeChild;
    shutdownForceKillChild = child;
    killProcessGroup(child, "SIGTERM");
    shutdownForceKillTimer = setTimeout(() => {
      killProcessGroup(child, "SIGKILL");
      shutdownForceKillTimer = null;
      shutdownForceKillChild = null;
    }, FORCE_KILL_DELAY_MS);
    shutdownForceKillTimer.unref?.();
  }
  wakeDelay?.();
};

process.once("SIGTERM", () => stopWorker("SIGTERM"));
process.once("SIGINT", () => stopWorker("SIGINT"));

const runNpmCommand = (
  script,
  args,
  timeoutMs,
  purpose,
  environment = {},
  workstreamContext = null
) =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stdoutLineBuffer = "";
    let stderr = "";
    let spawnError = false;
    let timedOut = false;
    let settled = false;
    let forceKillTimer = null;
    const child = spawn("npm", ["run", script, "--", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
      detached: purpose === "workstream"
    });
    activeChild = child;
    activeChildPurpose = purpose;
    const heartbeat = purpose === "workstream" && workstreamContext
      ? setInterval(() => {
          emitEvent({
            event: "workstream_heartbeat",
            ...workstreamContext,
            childPid: child.pid,
            elapsedMs: Date.now() - startedAt
          });
        }, WORKSTREAM_HEARTBEAT_MS)
      : null;
    heartbeat?.unref?.();
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout = appendBounded(stdout, text);
      if (purpose !== "workstream" || !workstreamContext) return;
      const lines = `${stdoutLineBuffer}${text}`.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() ?? "";
      if (stdoutLineBuffer.length > MAX_CAPTURE_BYTES) {
        stdoutLineBuffer = stdoutLineBuffer.slice(-MAX_CAPTURE_BYTES);
      }
      for (const line of lines) {
        forwardWorkstreamTelemetryLine(line, workstreamContext, child.pid);
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", () => {
      spawnError = true;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      if (purpose === "workstream" && workstreamContext) {
        emitEvent({
          event: "workstream_timeout",
          ...workstreamContext,
          childPid: child.pid,
          elapsedMs: Date.now() - startedAt
        });
        killProcessGroup(child, "SIGTERM");
      } else {
        child.kill("SIGTERM");
      }
      forceKillTimer = setTimeout(() => {
        if (purpose === "workstream") {
          killProcessGroup(child, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
        forceKillTimer = null;
      }, FORCE_KILL_DELAY_MS);
      forceKillTimer.unref?.();
    }, timeoutMs);
    timeout.unref?.();
    child.once("close", (code) => {
      void (async () => {
        if (settled) return;
        settled = true;
        if (purpose === "workstream" && workstreamContext && stdoutLineBuffer) {
          forwardWorkstreamTelemetryLine(
            stdoutLineBuffer,
            workstreamContext,
            child.pid
          );
        }
        if (heartbeat) clearInterval(heartbeat);
        clearTimeout(timeout);
        if (forceKillTimer) {
          if (purpose === "workstream" && processGroupExists(child)) {
            forceKillTimer.ref?.();
          } else {
            clearTimeout(forceKillTimer);
            forceKillTimer = null;
          }
        }
        if (shutdownForceKillTimer && shutdownForceKillChild === child) {
          if (processGroupExists(child)) {
            shutdownForceKillTimer.ref?.();
          } else {
            clearTimeout(shutdownForceKillTimer);
            shutdownForceKillTimer = null;
            shutdownForceKillChild = null;
          }
        }
        if (purpose === "workstream" && processGroupExists(child)) {
          await waitForProcessGroupExit(child);
        }
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimer = null;
        }
        if (shutdownForceKillTimer && shutdownForceKillChild === child) {
          clearTimeout(shutdownForceKillTimer);
          shutdownForceKillTimer = null;
          shutdownForceKillChild = null;
        }
        if (activeChild === child) {
          activeChild = null;
          activeChildPurpose = null;
        }
        resolve({
          exitCode: Number.isInteger(code) ? code : 1,
          durationMs: Date.now() - startedAt,
          output: `${stdout}\n${stderr}`,
          spawnError,
          timedOut
        });
      })();
    });
  });

const structuredReasonCode = (output) => {
  const matches = [...output.matchAll(
    /"(?:code|reasonCode)"\s*:\s*"([A-Z][A-Z0-9_]+)"/g
  )];
  return matches.at(-1)?.[1] ?? null;
};

const structuredOutputs = (output, accept = () => true) => {
  const matches = [];
  let cursor = 0;
  while (cursor < output.length) {
    const start = output.indexOf("{", cursor);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < output.length; index += 1) {
      const character = output[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === "\"") {
          inString = false;
        }
        continue;
      }
      if (character === "\"") {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end === -1) {
      cursor = start + 1;
      continue;
    }
    try {
      const value = JSON.parse(output.slice(start, end + 1));
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if (accept(value)) matches.push(value);
        cursor = end + 1;
        continue;
      }
    } catch {
      // Command wrappers may emit diagnostics containing braces around JSON.
    }
    cursor = start + 1;
  }
  return matches;
};

const latestStructuredOutput = (output, accept = () => true) =>
  structuredOutputs(output, accept).at(-1) ?? null;

const recoveryEnvelope = (output) => {
  const envelope = latestStructuredOutput(
    output,
    (value) => Object.prototype.hasOwnProperty.call(value, "recovery")
  );
  if (
    !envelope ||
    !["completed", "no_op"].includes(envelope.status) ||
    !envelope.recovery ||
    typeof envelope.recovery !== "object" ||
    Array.isArray(envelope.recovery)
  ) {
    return null;
  }
  const recoveryFields = Object.keys(envelope.recovery);
  if (
    recoveryFields.length !== RECOVERY_COUNT_FIELDS.length ||
    !recoveryFields.every((field) => RECOVERY_COUNT_FIELDS.includes(field))
  ) {
    return null;
  }
  const counters = RECOVERY_COUNT_FIELDS.map((field) => envelope.recovery[field]);
  if (
    !counters.every(
      (value) =>
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
    )
  ) {
    return null;
  }
  const empty = counters.every((value) => value === 0);
  if (envelope.status === "no_op" && !empty) return null;
  return { empty };
};

const classify = ({ exitCode, output, spawnError, timedOut }, script) => {
  if (spawnError) return { classification: "runner_unavailable", code: "WORKSTREAM_RUNNER_UNAVAILABLE" };
  if (timedOut) return { classification: "timed_out", code: "WORKSTREAM_TIMEOUT" };
  if (exitCode === 0) {
    if (/"status"\s*:\s*"(failed|rejected)"/i.test(output)) {
      return { classification: "failed", code: "WORKSTREAM_COMMAND_FAILED" };
    }
    const reasonCode = structuredReasonCode(output);
    if (script === "system:recover") {
      const recovery = recoveryEnvelope(output);
      if (!recovery) {
        return { classification: "failed", code: "WORKSTREAM_COMMAND_FAILED" };
      }
      if (recovery.empty) {
        return {
          classification: "no_action",
          code: "WORKSTREAM_NO_ACTION",
          reasonCode: "NO_RECOVERABLE_POSTGRES_STATE"
        };
      }
    }
    if (
      /"status"\s*:\s*"no_op"/i.test(output) &&
      reasonCode &&
      SUCCESSFUL_NO_ACTION_REASON_CODES.has(reasonCode)
    ) {
      return {
        classification: "no_action",
        code: "WORKSTREAM_NO_ACTION",
        reasonCode
      };
    }
    if (/"status"\s*:\s*"(blocked|no_op)"|NO_CANDIDATE|NO_RUNTIME_CANDIDATES/i.test(output)) {
      return {
        classification: "blocked",
        code: "WORKSTREAM_BLOCKED",
        reasonCode
      };
    }
    if (/"status"\s*:\s*"skipped"/i.test(output)) {
      return { classification: "skipped", code: "WORKSTREAM_SKIPPED" };
    }
    return { classification: "success", code: null };
  }
  if (/PAPER_RUNTIME_REQUIRED|LIVE_TRADING_DISABLED_REQUIRED|ALPACA_ENV=live|TRADING_MODE=live/i.test(output)) {
    return { classification: "safety_failure", code: "PAPER_SAFETY_GUARD_FAILED" };
  }
  if (/POSTGRES_ONLY_RUNTIME_PATH_DISABLED|AUTONOMOUS_COMMAND_NOT_IMPLEMENTED/i.test(output)) {
    return { classification: "command_rejected", code: "WORKSTREAM_COMMAND_REJECTED" };
  }
  if (/SCHEDULER_LEASE_HELD|already owned by another active lease/i.test(output)) {
    return { classification: "lease_unavailable", code: "SCHEDULER_LEASE_UNAVAILABLE" };
  }
  const deferredReasonCode = output.match(EXPECTED_DEFERRED_REASON_PATTERN)?.[1];
  if (deferredReasonCode) {
    return {
      classification: "deferred",
      code: "WORKSTREAM_DEFERRED",
      reasonCode: deferredReasonCode
    };
  }
  const postgresCode = output.match(/\b(POSTGRES_[A-Z0-9_]+)\b/)?.[1];
  if (postgresCode) {
    return { classification: "postgres_failure", code: postgresCode };
  }
  if (/Scheduler (heartbeat|lease acquisition) failed|PostgreSQL (connection|transaction)/i.test(output)) {
    return { classification: "postgres_unavailable", code: "POSTGRES_WORKSTREAM_UNAVAILABLE" };
  }
  return { classification: "failed", code: "WORKSTREAM_COMMAND_FAILED" };
};

const workstreamResultIsFatal = (result) =>
  Boolean(result.code) && !NON_FATAL_WORKSTREAM_CODES.has(result.code);

const canonicalResultsFromOutput = (output) => {
  const envelope = latestStructuredOutput(
    output,
    (value) => Array.isArray(value.workstreamResults)
  );
  if (!envelope) return [];
  return envelope.workstreamResults.filter(
    (result) =>
      result &&
      typeof result === "object" &&
      ["equity", "options_0dte", "options_leaps"].includes(result.lane) &&
      ["success", "no_action", "error"].includes(result.outcome)
  );
};

const reconciliationResolved = (result) =>
  ["success", "no_action"].includes(result.classification);

const runWorkstream = async (
  script,
  args,
  timeoutMs,
  cycle,
  cycleId,
  position,
  resumedCycleId
) => {
  const startedAt = new Date().toISOString();
  const raw = await runNpmCommand(script, args, timeoutMs, "workstream", {
    AUTONOMOUS_CYCLE_ID: cycleId,
    ...(resumedCycleId ? { AUTONOMOUS_RESUME_CYCLE_ID: resumedCycleId } : {}),
    AUTONOMOUS_WORKSTREAM: script
  }, {
    cycle,
    cycleId,
    position,
    workstream: script
  });
  let result = classify(raw, script);
  let workstreamResults = canonicalResultsFromOutput(raw.output);
  if (script === "zero-dte:engine" && workstreamResultIsFatal(result)) {
    const reasonCode =
      structuredReasonCode(raw.output) ??
      result.reasonCode ??
      result.code ??
      "LANE_EXECUTION_ERROR";
    workstreamResults = [{
      cycle_id: cycleId,
      lane: "options_0dte",
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      outcome: "error",
      proposals: [],
      evidence_references: ["workstream:zero-dte:engine"],
      reason_codes: [reasonCode],
      diagnostic_summary: reasonCode.slice(0, 240)
    }];
    result = {
      classification: "lane_error",
      code: null,
      reasonCode
    };
  }
  return {
    ...result,
    exitCode: raw.exitCode,
    durationMs: raw.durationMs,
    ...(workstreamResults.length ? { workstreamResults } : {})
  };
};

const persistState = async (cycleId, eventType, payload) => {
  const persistenceClassification =
    eventType === "preflight_failed"
      ? "OBSERVABILITY_SUPPLEMENTAL"
      : "AUTHORITATIVE_RECOVERABLE";
  const operationName = `persist_autonomous_worker_state:${eventType}`;
  const occurredAt = new Date().toISOString();
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const result = await runNpmCommand(STATE_COMMAND, [
    `--cycleId=${cycleId}`,
    `--eventType=${eventType}`,
    `--payload=${encodedPayload}`,
    `--occurredAt=${occurredAt}`
  ], STATE_PERSIST_TIMEOUT_MS, "state");
  const envelope = latestStructuredOutput(result.output);
  if (result.exitCode !== 0 || result.spawnError || result.timedOut) {
    statePersistenceFailureCount += 1;
    const source =
      envelope?.persistence &&
      typeof envelope.persistence === "object" &&
      !Array.isArray(envelope.persistence)
        ? envelope.persistence
        : {};
    const evidence = {
      operationName:
        typeof source.operationName === "string"
          ? source.operationName
          : operationName,
      persistenceClassification:
        typeof source.persistenceClassification === "string"
          ? source.persistenceClassification
          : persistenceClassification,
      cycleId,
      workstreamName:
        typeof source.workstreamName === "string"
          ? source.workstreamName
          : typeof payload.workstream === "string"
            ? payload.workstream
            : "autonomous_worker",
      lifecycleState: eventType,
      retryAttempt:
        Number.isSafeInteger(source.retryAttempt) && source.retryAttempt >= 0
          ? source.retryAttempt
          : 0,
      maximumAttempts:
        Number.isSafeInteger(source.maximumAttempts) && source.maximumAttempts > 0
          ? source.maximumAttempts
          : 1,
      errorCode:
        typeof source.errorCode === "string"
          ? source.errorCode
          : result.timedOut
            ? "AUTONOMOUS_WORKER_STATE_PERSIST_TIMEOUT"
            : result.spawnError
              ? "AUTONOMOUS_WORKER_STATE_RUNNER_UNAVAILABLE"
              : "AUTONOMOUS_WORKER_STATE_PERSIST_FAILED",
      postgresErrorCode:
        typeof source.postgresErrorCode === "string"
          ? source.postgresErrorCode
          : null,
      retryable: source.retryable === true,
      schedulerFenceStatus:
        typeof source.schedulerFenceStatus === "string"
          ? source.schedulerFenceStatus
          : "unknown",
      transactionStatus:
        typeof source.transactionStatus === "string"
          ? source.transactionStatus
          : "unknown",
      finalDisposition:
        typeof source.finalDisposition === "string"
          ? source.finalDisposition
          : persistenceClassification === "OBSERVABILITY_SUPPLEMENTAL"
            ? "SUPPLEMENTAL_WRITE_SKIPPED"
            : "NONRETRYABLE_PERSISTENCE_FAILURE",
      timestamp:
        typeof source.timestamp === "string"
          ? source.timestamp
          : new Date().toISOString(),
      persistenceFailureCount: statePersistenceFailureCount
    };
    emitEvent({
      event: "autonomous_worker_state_persistence_failure",
      code: "AUTONOMOUS_WORKER_STATE_PERSIST_FAILED",
      ...evidence
    });
    if (persistenceClassification === "OBSERVABILITY_SUPPLEMENTAL") {
      return { status: "skipped", persistence: evidence };
    }
    const error = codedError("AUTONOMOUS_WORKER_STATE_PERSIST_FAILED");
    error.persistence = evidence;
    throw error;
  }

  const responseCandidates = structuredOutputs(
    result.output,
    (value) =>
      value.command === STATE_COMMAND &&
      value.operation === operationName &&
      value.eventType === eventType &&
      value.cycleId === cycleId
  );
  const responseCode = (classification) =>
    eventType === "cycle_started"
      ? `AUTONOMOUS_CYCLE_START_RESPONSE_${classification}`
      : `AUTONOMOUS_WORKER_STATE_RESPONSE_${classification}`;
  const failResponse = (errorCode) => {
    statePersistenceFailureCount += 1;
    const error = codedError(errorCode);
    error.persistence = {
      operationName,
      persistenceClassification,
      cycleId,
      workstreamName:
        typeof payload.workstream === "string"
          ? payload.workstream
          : "autonomous_worker",
      lifecycleState: eventType,
      retryAttempt: 0,
      maximumAttempts: 1,
      errorCode,
      postgresErrorCode: null,
      retryable: false,
      schedulerFenceStatus: "unknown",
      transactionStatus: "unknown",
      finalDisposition:
        persistenceClassification === "OBSERVABILITY_SUPPLEMENTAL"
          ? "SUPPLEMENTAL_WRITE_SKIPPED"
          : "NONRETRYABLE_PERSISTENCE_FAILURE",
      timestamp: new Date().toISOString(),
      persistenceFailureCount: statePersistenceFailureCount
    };
    emitEvent({
      event: "autonomous_worker_state_persistence_failure",
      code: "AUTONOMOUS_WORKER_STATE_PERSIST_FAILED",
      ...error.persistence
    });
    if (persistenceClassification === "OBSERVABILITY_SUPPLEMENTAL") {
      return { status: "skipped", persistence: error.persistence };
    }
    throw error;
  };

  if (responseCandidates.length === 0) {
    return failResponse(responseCode("MISSING"));
  }
  if (responseCandidates.length > 1) {
    return failResponse(responseCode("AMBIGUOUS"));
  }
  const [canonicalResponse] = responseCandidates;
  if (
    canonicalResponse.status !== "persisted" ||
    canonicalResponse.persisted !== true ||
    canonicalResponse.environment !== "paper" ||
    canonicalResponse.paperOnly !== true ||
    canonicalResponse.liveTradingEnabled !== false
  ) {
    return failResponse(responseCode("INVALID"));
  }
  if (canonicalResponse.persistence?.finalDisposition === "PERSISTED_AFTER_RETRY") {
    emitEvent({
      event: "autonomous_worker_state_persistence_recovered",
      ...canonicalResponse.persistence
    });
  }
  return canonicalResponse;
};

const wait = (milliseconds) =>
  new Promise((resolve) => {
    if (stopRequested || milliseconds === 0) return resolve();
    const finish = () => {
      clearTimeout(timer);
      wakeDelay = null;
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    wakeDelay = finish;
  });

const statePayload = (cycle, extra = {}) => ({
  cycle,
  paperOnly: true,
  ...extra
});

const main = async () => {
  const cycleDelayMs = cycleDelay();
  const workstreamTimeoutMs = workstreamTimeout();
  const once = process.argv.includes("--once");
  const preflightCycleId = randomUUID();
  assertRuntime();

  const contract = readProductionContract();
  assertCommandEntry(contract, STATE_COMMAND);
  try {
    assertCompleteCommandContract(contract);
  } catch (error) {
    const code = codeOf(error, "AUTONOMOUS_WORKER_COMMAND_CONTRACT_INVALID");
    await persistState(preflightCycleId, "preflight_failed", {
      classification: "preflight_failure",
      code,
      message: "The autonomous production command contract is invalid.",
      paperOnly: true
    });
    emitEvent({ event: "preflight_failed", cycleId: preflightCycleId, code });
    throw error;
  }

  let cycle = 0;
  let lastCycleId = preflightCycleId;
  emitEvent({ event: "worker_started", paperOnly: true, workstreamCount: WORKSTREAMS.length });
  while (!stopRequested) {
    cycle += 1;
    const cycleId = cycle === 1 ? preflightCycleId : randomUUID();
    lastCycleId = cycleId;
    let cycleStartedPersisted = false;
    let cycleTerminalPersisted = false;
    try {
      const cycleStartState = await persistState(
        cycleId,
        "cycle_started",
        statePayload(cycle, {
          workerPid: process.pid,
          workstreamCount: WORKSTREAMS.length
        })
      );
      cycleStartedPersisted = true;
      const resumedCycleId =
        typeof cycleStartState?.resumedCycleId === "string" &&
        cycleStartState.resumedCycleId.trim()
          ? cycleStartState.resumedCycleId.trim()
          : null;
      if (resumedCycleId) {
        emitEvent({ event: "cycle_resuming", cycle, cycleId, resumedCycleId });
      }
      emitEvent({ event: "cycle_started", cycle, cycleId, workstreamCount: WORKSTREAMS.length });
      let unresolvedPriorMutation = false;

      for (let index = 0; index < WORKSTREAMS.length; index += 1) {
        if (stopRequested) break;
        const [script, args] = WORKSTREAMS[index];
        const basePayload = statePayload(cycle, {
          position: index + 1,
          workstream: script,
          ...(resumedCycleId ? { resumedCycleId } : {})
        });
        await persistState(cycleId, "workstream_started", basePayload);
        emitEvent({ event: "workstream_started", cycle, cycleId, position: index + 1, workstream: script });
        if (stopRequested) {
          await persistState(cycleId, "worker_stopped", statePayload(cycle, {
            reason: "signal",
            signal: stopSignal,
            position: index + 1,
            workstream: script
          }));
          emitEvent({ event: "worker_stopped", cycle, cycleId, reason: "signal" });
          return;
        }
        const mutationSkippedForUnresolvedReconciliation =
          unresolvedPriorMutation && BROKER_MUTATION_WORKSTREAMS.has(script);
        let result =
          mutationSkippedForUnresolvedReconciliation
            ? {
                classification: "blocked",
                code: "WORKSTREAM_BLOCKED",
                reasonCode: "UNRESOLVED_PRIOR_MUTATION",
                exitCode: null,
                durationMs: 0
              }
            : await runWorkstream(
                script,
                args,
                workstreamTimeoutMs,
                cycle,
                cycleId,
                index + 1,
                resumedCycleId
              );

        let internalReconciliationResult = null;
        const nextPublicWorkstream = WORKSTREAMS[index + 1]?.[0] ?? null;
        const reconcileBeforeLeavingMutation =
          BROKER_MUTATION_WORKSTREAMS.has(script) &&
          (
            INTERNAL_RECONCILIATION_AFTER.has(script) ||
            (
              nextPublicWorkstream === RECONCILIATION_WORKSTREAM &&
              workstreamResultIsFatal(result)
            )
          );
        if (reconcileBeforeLeavingMutation) {
          const mutationResult = result;
          internalReconciliationResult = await runWorkstream(
            RECONCILIATION_WORKSTREAM,
            RECONCILIATION_ARGS,
            workstreamTimeoutMs,
            cycle,
            cycleId,
            index + 1,
            resumedCycleId
          );
          const reconciliationEvidence = {
            classification: internalReconciliationResult.classification,
            code: internalReconciliationResult.code,
            reasonCode: internalReconciliationResult.reasonCode ?? null,
            durationMs: internalReconciliationResult.durationMs
          };
          if (mutationSkippedForUnresolvedReconciliation) {
            result = {
              ...mutationResult,
              postMutationReconciliation: reconciliationEvidence
            };
          } else if (workstreamResultIsFatal(internalReconciliationResult)) {
            result = {
              ...internalReconciliationResult,
              mutationClassification: mutationResult.classification,
              mutationCode: mutationResult.code,
              postMutationReconciliation: reconciliationEvidence
            };
          } else if (
            !reconciliationResolved(internalReconciliationResult) &&
            !workstreamResultIsFatal(mutationResult)
          ) {
            result = {
              ...mutationResult,
              classification: "blocked",
              code: "WORKSTREAM_BLOCKED",
              reasonCode:
                internalReconciliationResult.reasonCode ??
                internalReconciliationResult.code,
              postMutationReconciliation: reconciliationEvidence
            };
          } else {
            result = {
              ...mutationResult,
              postMutationReconciliation: reconciliationEvidence
            };
          }
        }

        if (internalReconciliationResult) {
          unresolvedPriorMutation = !reconciliationResolved(
            internalReconciliationResult
          );
        } else if (script === RECONCILIATION_WORKSTREAM) {
          unresolvedPriorMutation = !reconciliationResolved(result);
        } else if (
          BROKER_MUTATION_WORKSTREAMS.has(script) &&
          result.classification === "blocked" &&
          result.reasonCode !== "UNRESOLVED_PRIOR_MUTATION"
        ) {
          unresolvedPriorMutation = true;
        }

        if (stopRequested) {
          await persistState(cycleId, "worker_stopped", statePayload(cycle, {
            reason: "signal",
            signal: stopSignal,
            position: index + 1,
            workstream: script
          }));
          emitEvent({ event: "worker_stopped", cycle, cycleId, reason: "signal" });
          return;
        }

        if (workstreamResultIsFatal(result)) {
          const failurePayload = {
            ...basePayload,
            ...result,
            message: "A required autonomous workstream failed."
          };
          await persistState(cycleId, "workstream_failed", failurePayload);
          emitEvent({ event: "workstream_failed", cycle, cycleId, position: index + 1, workstream: script, ...result });
          await persistState(cycleId, "cycle_failed", statePayload(cycle, {
            classification: result.classification,
            code: result.code,
            message: "The autonomous cycle failed before completion.",
            failedPosition: index + 1,
            failedWorkstream: script
          }));
          cycleTerminalPersisted = true;
          emitEvent({ event: "cycle_failed", cycle, cycleId, code: result.code, failedWorkstream: script });
          throw codedError(result.code);
        }

        const completionPayload = {
          ...basePayload,
          ...result,
          ...(script === "paper:learn"
            ? {
                dashboardProjectionReady: true,
                dashboardProjectionAuthority: "postgres"
              }
            : {})
        };
        await persistState(cycleId, "workstream_completed", completionPayload);
        emitEvent({ event: "workstream_completed", cycle, cycleId, position: index + 1, workstream: script, ...result });
      }

      if (stopRequested) break;
      await persistState(cycleId, "cycle_completed", statePayload(cycle, {
        workstreamCount: WORKSTREAMS.length,
        failed: 0
      }));
      cycleTerminalPersisted = true;
      emitEvent({ event: "cycle_completed", cycle, cycleId, workstreamCount: WORKSTREAMS.length, failed: 0 });
      if (once) {
        await persistState(cycleId, "worker_stopped", statePayload(cycle, { reason: "once" }));
        emitEvent({ event: "worker_stopped", cycle, cycleId, reason: "once" });
        return;
      }
    } catch (error) {
      const code = codeOf(error);
      if (SERVICE_FATAL_CODES.has(code)) throw error;
      if (stopRequested) break;
      if (cycleStartedPersisted && !cycleTerminalPersisted) {
        try {
          await persistState(cycleId, "cycle_failed", statePayload(cycle, {
            classification: "cycle_scoped_failure",
            code,
            message: "The autonomous cycle ended without weakening worker continuity.",
            failedPersistenceOperation:
              typeof error?.persistence?.operationName === "string"
                ? error.persistence.operationName
                : null
          }));
          cycleTerminalPersisted = true;
          emitEvent({ event: "cycle_failed", cycle, cycleId, code });
        } catch (terminalError) {
          emitEvent({
            event: "cycle_terminal_persistence_incomplete",
            cycle,
            cycleId,
            code: codeOf(terminalError),
            failedPersistenceOperation:
              typeof terminalError?.persistence?.operationName === "string"
                ? terminalError.persistence.operationName
                : null
          });
        }
      }
      emitEvent({
        event: cycleTerminalPersisted
          ? "cycle_failed_worker_continued"
          : "cycle_incomplete_worker_continued",
        cycle,
        cycleId,
        code,
        nextCycleDelayMs: cycleDelayMs
      });
      if (once) throw error;
    }
    await wait(cycleDelayMs);
  }

  try {
    await persistState(lastCycleId, "worker_stopped", statePayload(cycle, {
      reason: "signal",
      signal: stopSignal
    }));
  } catch (error) {
    emitEvent({
      event: "worker_stop_state_incomplete",
      cycle,
      cycleId: lastCycleId,
      code: codeOf(error)
    });
  }
  emitEvent({ event: "worker_stopped", cycle, cycleId: lastCycleId, reason: "signal" });
};

main().catch((error) => {
  emitEvent({ event: "worker_failed", code: codeOf(error) });
  process.exitCode = 1;
});
