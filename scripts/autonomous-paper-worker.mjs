#!/usr/bin/env node
import { spawn } from "node:child_process";

const MAX_CAPTURE_BYTES = 32 * 1024;
const POSTGRES_FAILURE_LIMIT = 3;
const DEFAULT_CYCLE_DELAY_MS = 30_000;

const WORKSTREAMS = [
  ["research:daily", ["--riskProfile=aggressive", "--optionsEnabled=true", "--maxCandidates=10", "--assetClass=all", "--format=json"]],
  ["paper:review", ["--format=json"]],
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

const normalized = (value) => String(value ?? "").trim().toLowerCase();
const isTrue = (value) => ["true", "1"].includes(normalized(value));
const isFalse = (value) => ["false", "0"].includes(normalized(value));
const log = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);

const argumentValue = (name) => {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
};

const cycleDelay = () => {
  const value = Number(argumentValue("cycle-delay-ms") ?? DEFAULT_CYCLE_DELAY_MS);
  if (!Number.isSafeInteger(value) || value < 0 || value > 300_000) {
    throw new Error("AUTONOMOUS_WORKER_CYCLE_DELAY_INVALID");
  }
  return value;
};

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
  if (!isFalse(process.env.SQLITE_AUDIT_MIRROR_ENABLED)) {
    failures.push("SQLITE_AUDIT_MIRROR_DISABLED_REQUIRED");
  }
  if (failures.length) {
    const error = new Error("AUTONOMOUS_WORKER_CONFIGURATION_INVALID");
    error.code = failures[0];
    throw error;
  }
};

const appendBounded = (current, chunk) =>
  `${current}${chunk}`.slice(-MAX_CAPTURE_BYTES);

const classify = (exitCode, output, spawnError) => {
  if (spawnError) return { classification: "runner_unavailable", code: "WORKSTREAM_RUNNER_UNAVAILABLE" };
  if (/PAPER_RUNTIME_REQUIRED|LIVE_TRADING_DISABLED_REQUIRED|ALPACA_ENV=live|TRADING_MODE=live/i.test(output)) {
    return { classification: "safety_failure", code: "PAPER_SAFETY_GUARD_FAILED" };
  }
  if (/SCHEDULER_LEASE_HELD|already owned by another active lease/i.test(output)) {
    return { classification: "lease_unavailable", code: "SCHEDULER_LEASE_UNAVAILABLE" };
  }
  if (/Scheduler (heartbeat|lease acquisition) failed|POSTGRES_[A-Z0-9_]+|PostgreSQL (connection|transaction)/i.test(output)) {
    return { classification: "postgres_unavailable", code: "POSTGRES_WORKSTREAM_UNAVAILABLE" };
  }
  if (/"status"\s*:\s*"(blocked|no_op)"|NO_CANDIDATE|NO_RUNTIME_CANDIDATES/i.test(output)) {
    return { classification: "blocked", code: "WORKSTREAM_BLOCKED" };
  }
  if (/"status"\s*:\s*"skipped"/i.test(output)) {
    return { classification: "skipped", code: "WORKSTREAM_SKIPPED" };
  }
  return exitCode === 0
    ? { classification: "success", code: null }
    : { classification: "failed", code: "WORKSTREAM_COMMAND_FAILED" };
};

let activeChild = null;
let wakeDelay = null;
let stopRequested = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    stopRequested = true;
    activeChild?.kill("SIGTERM");
    wakeDelay?.();
  });
}

const runWorkstream = (script, args) =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let spawnError = false;
    let settled = false;
    const child = spawn("npm", ["run", script, "--", ...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    activeChild = child;
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", () => {
      spawnError = true;
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      activeChild = null;
      const exitCode = Number.isInteger(code) ? code : 1;
      resolve({
        ...classify(exitCode, `${stdout}\n${stderr}`, spawnError),
        exitCode,
        durationMs: Date.now() - startedAt
      });
    });
  });

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

const main = async () => {
  assertRuntime();
  const cycleDelayMs = cycleDelay();
  const once = process.argv.includes("--once");
  let cycle = 0;
  let consecutivePostgresFailures = 0;
  log({ event: "worker_started", paperOnly: true, workstreamCount: WORKSTREAMS.length });
  while (!stopRequested) {
    cycle += 1;
    let failed = 0;
    for (let index = 0; index < WORKSTREAMS.length && !stopRequested; index += 1) {
      const [script, args] = WORKSTREAMS[index];
      const result = await runWorkstream(script, args);
      if (result.classification === "safety_failure" || result.classification === "runner_unavailable") {
        const error = new Error(result.code);
        error.code = result.code;
        throw error;
      }
      if (result.classification === "postgres_unavailable") {
        consecutivePostgresFailures += 1;
      } else {
        consecutivePostgresFailures = 0;
      }
      if (consecutivePostgresFailures >= POSTGRES_FAILURE_LIMIT) {
        const error = new Error("POSTGRES_UNAVAILABLE_RETRY_LIMIT");
        error.code = "POSTGRES_UNAVAILABLE_RETRY_LIMIT";
        throw error;
      }
      if (["failed", "postgres_unavailable"].includes(result.classification)) failed += 1;
      log({
        event: "workstream_completed",
        cycle,
        position: index + 1,
        workstream: script,
        ...result
      });
    }
    if (stopRequested) break;
    log({ event: "cycle_completed", cycle, workstreamCount: WORKSTREAMS.length, failed });
    if (once) break;
    await wait(cycleDelayMs);
  }
  log({ event: "worker_stopped", cycle, reason: stopRequested ? "signal" : "once" });
};

main().catch((error) => {
  log({
    event: "worker_failed",
    code: typeof error?.code === "string" ? error.code : "AUTONOMOUS_WORKER_FAILED"
  });
  process.exitCode = 1;
});
