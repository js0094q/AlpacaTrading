#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_CAPTURE_BYTES = 32 * 1024;
const DEFAULT_CYCLE_DELAY_MS = 30_000;
const DEFAULT_WORKSTREAM_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_WORKSTREAM_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const STATE_PERSIST_TIMEOUT_MS = 60_000;
const FORCE_KILL_DELAY_MS = 5_000;
const EXPECTED_DEFERRED_REASON_PATTERN = /\b(POSTGRES_OPTION_SNAPSHOTS_CURRENT_MISSING|POSTGRES_DECISION_MARKET_SESSION_INELIGIBLE|NO_ELIGIBLE_POSTGRES_CANDIDATES|NO_READY_POSTGRES_ORDER_INTENTS)\b/;
const configuredMaxCandidates = Number(process.env.PAPER_EXPLORATION_MAX_CANDIDATES ?? 25);
const PAPER_EXPLORATION_MAX_CANDIDATES =
  Number.isSafeInteger(configuredMaxCandidates) &&
  configuredMaxCandidates >= 1 &&
  configuredMaxCandidates <= 25
    ? configuredMaxCandidates
    : 25;

const WORKSTREAMS = [
  ["research:daily", ["--riskProfile=aggressive", "--optionsEnabled=true", `--maxCandidates=${PAPER_EXPLORATION_MAX_CANDIDATES}`, "--assetClass=all", "--format=json"]],
  ["paper:review", ["--riskProfile=aggressive", "--optionsEnabled=true", `--maxCandidates=${PAPER_EXPLORATION_MAX_CANDIDATES}`, "--format=json"]],
  ["paper:portfolio:review", ["--format=json"]],
  ["paper:options:discover", ["--underlying=SPY", "--dte=0", "--format=json"]],
  ["paper:ops:review", ["--format=json"]],
  ["paper:exit:review", ["--format=json"]],
  ["paper:exit:execute", ["--confirmPaper", "--format=json"]],
  ["paper:execute:reviewed", ["--confirmPaper", "--sections=equityBuys,equityAdds,optionBuys", "--format=json"]],
  ["hedge:review", ["--format=json"]],
  ["hedge:exit:review", ["--format=json"]],
  ["hedge:exit:execute", ["--confirmPaper", "--format=json"]],
  ["zero-dte:engine", ["--confirmPaper", "--format=json"]],
  ["zero-dte:exit:review", ["--format=json"]],
  ["zero-dte:reconcile", ["--format=json"]],
  ["paper:learn", ["--format=json"]],
  ["system:recover", ["--format=json"]]
];

const STATE_COMMAND = "worker:state";
const REQUIRED_COMMANDS = [...WORKSTREAMS.map(([command]) => command), STATE_COMMAND];
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
const log = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);

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
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    stopRequested = true;
    stopSignal = signal;
    if (activeChildPurpose === "workstream") activeChild?.kill("SIGTERM");
    wakeDelay?.();
  });
}

const runNpmCommand = (script, args, timeoutMs, purpose, environment = {}) =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let spawnError = false;
    let timedOut = false;
    let settled = false;
    let forceKillTimer = null;
    const child = spawn("npm", ["run", script, "--", ...args], {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"]
    });
    activeChild = child;
    activeChildPurpose = purpose;
    child.stdout?.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", () => {
      spawnError = true;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_DELAY_MS);
      forceKillTimer.unref?.();
    }, timeoutMs);
    timeout.unref?.();
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
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
    });
  });

const classify = ({ exitCode, output, spawnError, timedOut }) => {
  if (spawnError) return { classification: "runner_unavailable", code: "WORKSTREAM_RUNNER_UNAVAILABLE" };
  if (timedOut) return { classification: "timed_out", code: "WORKSTREAM_TIMEOUT" };
  if (exitCode === 0) {
    if (/"status"\s*:\s*"(failed|rejected)"/i.test(output)) {
      return { classification: "failed", code: "WORKSTREAM_COMMAND_FAILED" };
    }
    if (/"status"\s*:\s*"(blocked|no_op)"|NO_CANDIDATE|NO_RUNTIME_CANDIDATES/i.test(output)) {
      return { classification: "blocked", code: "WORKSTREAM_BLOCKED" };
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

const runWorkstream = async (script, args, timeoutMs, cycleId) => {
  const raw = await runNpmCommand(script, args, timeoutMs, "workstream", {
    AUTONOMOUS_CYCLE_ID: cycleId,
    AUTONOMOUS_WORKSTREAM: script
  });
  const result = classify(raw);
  return {
    ...result,
    exitCode: raw.exitCode,
    durationMs: raw.durationMs
  };
};

const persistState = async (cycleId, eventType, payload) => {
  const occurredAt = new Date().toISOString();
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const result = await runNpmCommand(STATE_COMMAND, [
    `--cycleId=${cycleId}`,
    `--eventType=${eventType}`,
    `--payload=${encodedPayload}`,
    `--occurredAt=${occurredAt}`
  ], STATE_PERSIST_TIMEOUT_MS, "state");
  if (result.exitCode !== 0 || result.spawnError || result.timedOut) {
    throw codedError("AUTONOMOUS_WORKER_STATE_PERSIST_FAILED");
  }
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
    log({ event: "preflight_failed", cycleId: preflightCycleId, code });
    throw error;
  }

  let cycle = 0;
  let lastCycleId = preflightCycleId;
  log({ event: "worker_started", paperOnly: true, workstreamCount: WORKSTREAMS.length });
  while (!stopRequested) {
    cycle += 1;
    const cycleId = cycle === 1 ? preflightCycleId : randomUUID();
    lastCycleId = cycleId;
    await persistState(cycleId, "cycle_started", statePayload(cycle, {
      workerPid: process.pid,
      workstreamCount: WORKSTREAMS.length
    }));
    log({ event: "cycle_started", cycle, cycleId, workstreamCount: WORKSTREAMS.length });

    for (let index = 0; index < WORKSTREAMS.length; index += 1) {
      if (stopRequested) break;
      const [script, args] = WORKSTREAMS[index];
      const basePayload = statePayload(cycle, {
        position: index + 1,
        workstream: script
      });
      await persistState(cycleId, "workstream_started", basePayload);
      log({ event: "workstream_started", cycle, cycleId, position: index + 1, workstream: script });
      if (stopRequested) {
        await persistState(cycleId, "worker_stopped", statePayload(cycle, {
          reason: "signal",
          signal: stopSignal,
          position: index + 1,
          workstream: script
        }));
        log({ event: "worker_stopped", cycle, cycleId, reason: "signal" });
        return;
      }
      const result = await runWorkstream(script, args, workstreamTimeoutMs, cycleId);

      if (stopRequested) {
        await persistState(cycleId, "worker_stopped", statePayload(cycle, {
          reason: "signal",
          signal: stopSignal,
          position: index + 1,
          workstream: script
        }));
        log({ event: "worker_stopped", cycle, cycleId, reason: "signal" });
        return;
      }

      if (
        result.code &&
        !["WORKSTREAM_BLOCKED", "WORKSTREAM_SKIPPED", "WORKSTREAM_DEFERRED"].includes(result.code)
      ) {
        const failurePayload = {
          ...basePayload,
          ...result,
          message: "A required autonomous workstream failed."
        };
        await persistState(cycleId, "workstream_failed", failurePayload);
        log({ event: "workstream_failed", cycle, cycleId, position: index + 1, workstream: script, ...result });
        await persistState(cycleId, "cycle_failed", statePayload(cycle, {
          classification: result.classification,
          code: result.code,
          message: "The autonomous cycle failed before completion.",
          failedPosition: index + 1,
          failedWorkstream: script
        }));
        log({ event: "cycle_failed", cycle, cycleId, code: result.code, failedWorkstream: script });
        throw codedError(result.code);
      }

      const completionPayload = { ...basePayload, ...result };
      await persistState(cycleId, "workstream_completed", completionPayload);
      log({ event: "workstream_completed", cycle, cycleId, position: index + 1, workstream: script, ...result });
    }

    if (stopRequested) break;
    await persistState(cycleId, "cycle_completed", statePayload(cycle, {
      workstreamCount: WORKSTREAMS.length,
      failed: 0
    }));
    log({ event: "cycle_completed", cycle, cycleId, workstreamCount: WORKSTREAMS.length, failed: 0 });
    if (once) {
      await persistState(cycleId, "worker_stopped", statePayload(cycle, { reason: "once" }));
      log({ event: "worker_stopped", cycle, cycleId, reason: "once" });
      return;
    }
    await wait(cycleDelayMs);
  }

  await persistState(lastCycleId, "worker_stopped", statePayload(cycle, {
    reason: "signal",
    signal: stopSignal
  }));
  log({ event: "worker_stopped", cycle, cycleId: lastCycleId, reason: "signal" });
};

main().catch((error) => {
  log({ event: "worker_failed", code: codeOf(error) });
  process.exitCode = 1;
});
