import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const runner = join(repoRoot, "scripts/paper-monitor-runner.mjs");
const monitorUnits = [
  "alpaca-paper-review.service",
  "alpaca-paper-review.timer",
  "alpaca-paper-execute.service",
  "alpaca-paper-execute.timer",
  "alpaca-paper-exit-review.service",
  "alpaca-paper-exit-review.timer",
  "alpaca-paper-exit-execute.service",
  "alpaca-paper-exit-execute.timer",
  "alpaca-zero-dte-engine.service",
  "alpaca-zero-dte-engine.timer",
  "alpaca-zero-dte-exit-review.service",
  "alpaca-zero-dte-exit-review.timer",
  "alpaca-zero-dte-reconcile.service",
  "alpaca-zero-dte-reconcile.timer",
  "alpaca-zero-dte-eod.service",
  "alpaca-zero-dte-eod.timer",
  "alpaca-market-observatory.service",
  "alpaca-market-observatory.timer"
];

const monitorServiceLocks = {
  "alpaca-market-observatory.service": "/tmp/alpaca-market-observatory.lock",
  "alpaca-paper-review.service": "/tmp/alpaca-paper-monitor-review.lock",
  "alpaca-paper-execute.service": "/tmp/alpaca-paper-monitor-execute.lock",
  "alpaca-paper-exit-review.service": "/tmp/alpaca-paper-monitor-exit-review.lock",
  "alpaca-paper-exit-execute.service": "/tmp/alpaca-paper-monitor-exit-execute.lock",
  "alpaca-zero-dte-engine.service": "/tmp/alpaca-zero-dte-engine.lock",
  "alpaca-zero-dte-exit-review.service": "/tmp/alpaca-zero-dte-exit-review.lock",
  "alpaca-zero-dte-reconcile.service": "/tmp/alpaca-zero-dte-reconcile.lock",
  "alpaca-zero-dte-eod.service": "/tmp/alpaca-zero-dte-eod.lock"
} as const;

const marketOpenIso = "2026-07-08T14:00:00-04:00";
const marketClosedIso = "2026-07-11T14:00:00-04:00";
const finalHourIso = "2026-07-08T15:10:00-04:00";
const afterCloseIso = "2026-07-08T16:05:00-04:00";

const baseEnv = {
  ...process.env,
  ALPACA_ENV: "paper",
  TRADING_MODE: "paper",
  ALPACA_LIVE_TRADE: "false",
  LIVE_TRADING_ENABLED: "false",
  PAPER_ORDER_EXECUTION_ENABLED: "true",
  PAPER_OPTIONS_EXECUTION_ENABLED: "true",
  AUTOMATED_PAPER_EXECUTION_ENABLED: "true"
};

const runMonitor = (
  task: string,
  input: {
    now?: string;
    dryRun?: boolean;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  } = {}
) => {
  const args = [runner, `--task=${task}`, `--now=${input.now ?? marketOpenIso}`];
  if (input.dryRun !== false) args.push("--dry-run");
  return spawnSync(process.execPath, args, {
    cwd: input.cwd ?? repoRoot,
    env: input.env ?? baseEnv,
    encoding: "utf8"
  });
};

const parseStdout = (result: ReturnType<typeof runMonitor>) =>
  JSON.parse(result.stdout) as Record<string, any>;

describe("paper monitoring scheduler", () => {
  test("scheduler configs exist, reference paper commands only, and never reference live commands", () => {
    for (const unit of monitorUnits) {
      const path = join(repoRoot, "server/systemd", unit);
      assert.equal(existsSync(path), true, `${unit} should exist`);
      const body = readFileSync(path, "utf8");
      assert.doesNotMatch(body, /live/i);
      if (unit.endsWith(".service")) {
        assert.match(body, /User=alpaca/);
        assert.match(body, /EnvironmentFile=\/opt\/alpaca-investing\/secrets\/alpaca\.env/);
        assert.match(body, /paper:monitor/);
      }
    }
  });

  test("universe lifecycle is a bounded daily non-mutating worker", () => {
    const service = readFileSync(
      join(repoRoot, "server/systemd/alpaca-universe-lifecycle.service"),
      "utf8"
    );
    const timer = readFileSync(
      join(repoRoot, "server/systemd/alpaca-universe-lifecycle.timer"),
      "utf8"
    );

    assert.match(service, /User=alpaca/);
    assert.match(
      service,
      /EnvironmentFile=\/opt\/alpaca-investing\/secrets\/alpaca\.env/
    );
    assert.match(service, /AUTOMATED_PAPER_EXECUTION_ENABLED=false/);
    assert.match(service, /npm run universe:lifecycle/);
    assert.match(service, /After=network-online\.target/);
    assert.doesNotMatch(service, /paper:monitor|paper:execute|confirmPaper|orders/i);
    assert.match(timer, /OnCalendar=Mon\.\.Fri \*-\*-\* 16:30:00/);
    assert.match(timer, /Persistent=false/);
    assert.match(timer, /Unit=alpaca-universe-lifecycle\.service/);
  });

  test("oneshot monitor services remove their own transient lock after forced stop", () => {
    for (const [unit, lockFile] of Object.entries(monitorServiceLocks)) {
      const body = readFileSync(join(repoRoot, "server/systemd", unit), "utf8");
      assert.match(
        body,
        new RegExp(`ExecStopPost=-/usr/bin/rm -f ${lockFile.replaceAll(".", "\\.")}`),
        `${unit} must clean ${lockFile}`
      );
    }
  });

  test("execution wrapper fails closed if live env is enabled", () => {
    const result = runMonitor("execute", {
      env: {
        ...baseEnv,
        LIVE_TRADING_ENABLED: "true"
      }
    });

    assert.notEqual(result.status, 0);
    assert.equal(parseStdout(result).reason, "LIVE_TRADING_DISABLED_REQUIRED");
  });

  test("execution wrapper fails closed if paper env is missing", () => {
    const result = runMonitor("execute", {
      env: {
        ...baseEnv,
        ALPACA_ENV: "live"
      }
    });

    assert.notEqual(result.status, 0);
    assert.equal(parseStdout(result).reason, "PAPER_RUNTIME_REQUIRED");
  });

  test("execution wrapper allows reviewed paper execution only with paper flags true", () => {
    const result = runMonitor("execute");
    const body = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(body.status, "dry_run");
    assert.match(body.command, /paper:execute:reviewed/);
    assert.match(body.command, /--confirmPaper/);
    assert.match(body.command, /--sections=equityBuys,equityAdds,optionBuys/);
  });

  test("execution wrapper blocks when paper execution flags are missing", () => {
    const result = runMonitor("execute", {
      env: {
        ...baseEnv,
        PAPER_ORDER_EXECUTION_ENABLED: "false"
      }
    });

    assert.notEqual(result.status, 0);
    assert.equal(parseStdout(result).reason, "PAPER_EXECUTION_FLAG_REQUIRED");
  });

  test("0DTE scheduler tasks use dedicated paper commands and locks", () => {
    for (const task of [
      "zero-dte-engine",
      "zero-dte-exit-review",
      "zero-dte-reconcile",
      "zero-dte-eod"
    ]) {
      const result = runMonitor(task);
      const body = parseStdout(result);
      assert.equal(result.status, 0);
      assert.equal(body.status, "dry_run");
      assert.match(body.command, new RegExp(`zero-dte[:\\-]`));
      assert.match(body.command, /--format=json/);
      assert.match(body.command, /npm run/);
      assert.match(body.task, /^zero-dte-/);
    }

    const engine = parseStdout(runMonitor("zero-dte-engine"));
    assert.match(engine.command, /--confirmPaper/);

    for (const lockFile of [
      "/tmp/alpaca-zero-dte-engine.lock",
      "/tmp/alpaca-zero-dte-exit-review.lock",
      "/tmp/alpaca-zero-dte-reconcile.lock",
      "/tmp/alpaca-zero-dte-eod.lock"
    ]) {
      assert.match(lockFile, /alpaca-zero-dte-/);
    }
  });

  test("0DTE engine scheduler fails closed outside paper runtime", () => {
    const result = runMonitor("zero-dte-engine", {
      env: {
        ...baseEnv,
        ALPACA_ENV: "live"
      }
    });

    assert.notEqual(result.status, 0);
    assert.equal(parseStdout(result).reason, "PAPER_RUNTIME_REQUIRED");
  });

  test("0DTE scheduler no-ops when the market session is closed", () => {
    const result = runMonitor("zero-dte-reconcile", { now: marketClosedIso });
    const body = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(body.status, "no_op");
    assert.equal(body.reason, "MARKET_CLOSED");
  });

  test("0DTE end-of-day processing runs after a valid weekday session closes", () => {
    const result = runMonitor("zero-dte-eod", { now: afterCloseIso });
    const body = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(body.status, "dry_run");
    assert.match(body.command, /zero-dte:eod/);
  });

  test("exit monitor command exists and switches to late-day review in the final hour", () => {
    const normal = parseStdout(runMonitor("exit-review"));
    const finalHour = parseStdout(runMonitor("exit-review", { now: finalHourIso }));

    assert.match(normal.command, /paper:ops:review/);
    assert.match(finalHour.command, /paper:ops:late-day/);
  });

  test("market observatory uses the read-only collector on a 15-minute weekday cadence", () => {
    const body = parseStdout(runMonitor("observatory"));
    const timer = readFileSync(
      join(repoRoot, "server/systemd/alpaca-market-observatory.timer"),
      "utf8"
    );

    assert.match(body.command, /observatory:collect/);
    assert.doesNotMatch(body.command, /execute|confirmPaper|orders/);
    assert.match(timer, /OnCalendar=Mon\.\.Fri \*-\*-\* 09\.\.15:0\/15:00/);
    assert.match(timer, /Persistent=false/);
  });

  test("database-heavy timers are staggered away from observatory collection", () => {
    const readTimer = (name: string) =>
      readFileSync(join(repoRoot, "server/systemd", name), "utf8");

    assert.match(
      readTimer("alpaca-paper-review.timer"),
      /OnCalendar=Mon\.\.Fri \*-\*-\* 09\.\.15:3\/30:00/
    );
    assert.match(
      readTimer("alpaca-paper-exit-review.timer"),
      /OnCalendar=Mon\.\.Fri \*-\*-\* 09\.\.14:1\/15:00/
    );
    assert.match(
      readTimer("alpaca-zero-dte-engine.timer"),
      /OnCalendar=Mon\.\.Fri \*-\*-\* 10\.\.14:\*:45/
    );
    assert.match(
      readTimer("alpaca-zero-dte-exit-review.timer"),
      /OnCalendar=Mon\.\.Fri \*-\*-\* 09\.\.15:\*:55/
    );
    assert.match(
      readTimer("alpaca-zero-dte-reconcile.timer"),
      /OnCalendar=Mon\.\.Fri \*-\*-\* 09\.\.15:1\/5:30/
    );
    assert.match(
      readTimer("alpaca-universe-lifecycle.timer"),
      /OnCalendar=Mon\.\.Fri \*-\*-\* 16:30:00/
    );
  });

  test("market-hours gate no-ops outside market hours", () => {
    const result = runMonitor("review", { now: marketClosedIso });
    const body = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(body.status, "no_op");
    assert.equal(body.reason, "MARKET_CLOSED");
  });

  test("locking prevents overlapping execution", () => {
    const lockFile = "/tmp/alpaca-paper-monitor-execute.lock";
    writeFileSync(lockFile, "existing\n");
    try {
      const result = runMonitor("execute");
      const body = parseStdout(result);
      assert.equal(result.status, 0);
      assert.equal(body.reason, "LOCK_BUSY");
    } finally {
      unlinkSync(lockFile);
    }
  });

  test("market observatory collection cannot overlap", () => {
    const lockFile = "/tmp/alpaca-market-observatory.lock";
    writeFileSync(lockFile, "existing\n");
    try {
      const result = runMonitor("observatory");
      const body = parseStdout(result);
      assert.equal(result.status, 0);
      assert.equal(body.reason, "LOCK_BUSY");
    } finally {
      unlinkSync(lockFile);
    }
  });

  test("logs redact secrets emitted by child commands", () => {
    const temp = mkdtempSync(join(tmpdir(), "alpaca-monitor-redaction-"));
    const fakeNpm = join(temp, "npm");
    try {
      writeFileSync(
        join(temp, "package.json"),
        JSON.stringify({ scripts: { "paper:ops:morning": "fake" } })
      );
      writeFileSync(
        fakeNpm,
        "#!/usr/bin/env bash\necho 'VPS_CONTROL_TOKEN=supersecret Bearer rawtoken API_KEY=alsosecret'\n"
      );
      chmodSync(fakeNpm, 0o755);
      const result = runMonitor("review", {
        dryRun: false,
        cwd: temp,
        env: {
          ...baseEnv,
          PATH: `${temp}:${process.env.PATH}`
        }
      });

      assert.equal(result.status, 0);
      assert.doesNotMatch(result.stdout, /supersecret|rawtoken|alsosecret/);
      assert.match(result.stdout, /\[REDACTED\]/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
