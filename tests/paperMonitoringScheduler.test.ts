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
  "alpaca-paper-exit-execute.timer"
];

const marketOpenIso = "2026-07-08T14:00:00-04:00";
const marketClosedIso = "2026-07-11T14:00:00-04:00";
const finalHourIso = "2026-07-08T15:10:00-04:00";

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

  test("exit monitor command exists and switches to late-day review in the final hour", () => {
    const normal = parseStdout(runMonitor("exit-review"));
    const finalHour = parseStdout(runMonitor("exit-review", { now: finalHourIso }));

    assert.match(normal.command, /paper:ops:review/);
    assert.match(finalHour.command, /paper:ops:late-day/);
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
