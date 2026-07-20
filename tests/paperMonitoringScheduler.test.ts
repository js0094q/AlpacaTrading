import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

const repoRoot = process.cwd();
const runnerPath = join(repoRoot, "scripts/paper-monitor-runner.mjs");

const postgresOnlyEnv = {
  ...process.env,
  ALPACA_ENV: "paper",
  TRADING_MODE: "paper",
  ALPACA_LIVE_TRADE: "false",
  LIVE_TRADING_ENABLED: "false",
  DATABASE_BACKEND: "postgres",
  POSTGRES_READS_ENABLED: "true",
  POSTGRES_WRITES_ENABLED: "true",
  POSTGRES_SHADOW_COMPARE_ENABLED: "false",
  POSTGRES_CONTROL_PLANE_AUTHORITY_ENABLED: "true",
  POSTGRES_SCHEDULER_AUTHORITY_ENABLED: "true",
  POSTGRES_EXECUTION_STATE_SHADOW_ENABLED: "false",
  POSTGRES_EXECUTION_STATE_AUTHORITY_ENABLED: "true",
  SQLITE_AUDIT_MIRROR_ENABLED: "false",
  AUTONOMOUS_RUNTIME_AUDIT_APPROVED: "false",
  PAPER_ORDER_EXECUTION_ENABLED: "false",
  PAPER_OPTIONS_EXECUTION_ENABLED: "false",
  AUTOMATED_PAPER_EXECUTION_ENABLED: "false"
};

const runMonitor = (task: string) => {
  const result = spawnSync(process.execPath, [runnerPath, `--task=${task}`], {
    cwd: repoRoot,
    env: postgresOnlyEnv,
    encoding: "utf8",
    timeout: 10_000
  });
  return {
    ...result,
    payload: result.stdout.trim()
      ? JSON.parse(result.stdout) as Record<string, unknown>
      : null
  };
};

describe("retired paper monitoring scheduler", () => {
  test("every historical task fails closed before spawning an npm workflow", () => {
    for (const task of [
      "observatory",
      "review",
      "execute",
      "exit-review",
      "exit-execute",
      "zero-dte-engine",
      "zero-dte-exit-review",
      "zero-dte-reconcile",
      "zero-dte-eod"
    ]) {
      const result = runMonitor(task);
      assert.equal(result.status, 1, `${task}: ${result.stderr}`);
      assert.equal(result.payload?.status, "blocked", task);
      assert.ok(
        (result.payload?.failedChecks as string[]).includes(
          "POSTGRES_ONLY_RUNTIME_PATH_DISABLED"
        ),
        task
      );
      assert.ok(
        (result.payload?.failedChecks as string[]).includes(
          "EVIDENCE_UTILIZATION_RUNTIME_AUDIT_REQUIRED"
        ),
        task
      );
    }
  });

  test("the runner has no SQLite runtime path or audit-approval bypass", () => {
    const source = readFileSync(runnerPath, "utf8");
    assert.doesNotMatch(source, /node:sqlite|RESEARCH_DB_PATH|MARKET_OBSERVATORY_DB_PATH/);
    assert.match(source, /AUTONOMOUS_RUNTIME_AUDIT_APPROVED/);
    assert.match(source, /POSTGRES_ONLY_RUNTIME_PATH_DISABLED/);
  });

  test("package scripts expose no retired monitor dependencies", () => {
    const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string | undefined>;
    };
    for (const command of [
      "observatory:collect",
      "paper:ops:morning",
      "paper:execute:reviewed",
      "zero-dte:engine",
      "zero-dte:reconcile"
    ]) {
      assert.equal(packageJson.scripts[command], undefined, command);
    }
  });

  test("historical timers are explicitly documented as disabled", () => {
    const systemdReadme = readFileSync(
      join(repoRoot, "server/systemd/README.md"),
      "utf8"
    );
    assert.match(systemdReadme, /stopped and disabled pending/);
    assert.match(systemdReadme, /POSTGRES_ONLY_RUNTIME_PATH_DISABLED/);
    assert.match(systemdReadme, /AUTONOMOUS_RUNTIME_AUDIT_APPROVED=false/);
  });
});
