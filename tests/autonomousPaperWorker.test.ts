import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

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
  AUTONOMOUS_RUNTIME_AUDIT_APPROVED: "false"
};

test("autonomous worker remains stopped pending the evidence-utilization runtime audit", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/autonomous-paper-worker.mjs", "--once", "--cycle-delay-ms=0"],
    { cwd: process.cwd(), env: completePostgresOnlyEnvironment, encoding: "utf8" }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /EVIDENCE_UTILIZATION_RUNTIME_AUDIT_REQUIRED/);
  assert.doesNotMatch(result.stdout, /worker_started|workstream_completed/);
});

test("autonomous service hard-codes paper mode and the audit gate off", () => {
  const service = readFileSync(
    "server/systemd/alpaca-autonomous-paper.service",
    "utf8"
  );
  assert.match(service, /^Environment=TRADING_MODE=paper$/m);
  assert.match(service, /^Environment=ALPACA_ENV=paper$/m);
  assert.match(service, /^Environment=ALPACA_LIVE_TRADE=false$/m);
  assert.match(service, /^Environment=LIVE_TRADING_ENABLED=false$/m);
  assert.match(service, /^Environment=AUTONOMOUS_RUNTIME_AUDIT_APPROVED=false$/m);
  assert.match(service, /^Environment=POSTGRES_SHADOW_COMPARE_ENABLED=false$/m);
  assert.match(service, /^Environment=POSTGRES_EXECUTION_STATE_SHADOW_ENABLED=false$/m);
  assert.match(service, /^Environment=SQLITE_AUDIT_MIRROR_ENABLED=false$/m);
});
