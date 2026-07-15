import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";

import type { DatabaseConfig } from "../src/lib/database/config.js";
import type { ControlPlaneRuntimeContext } from "../src/services/controlPlaneRuntimeContext.js";
import {
  createResearchControlPlaneService,
  type ResearchPersistenceAdapter
} from "../src/services/researchControlPlaneService.js";

const configFor = (features: Partial<DatabaseConfig["features"]>): DatabaseConfig => ({
  backend: features.controlPlaneAuthority ? "postgres" : "sqlite",
  runtime: "test",
  purpose: "application",
  sslRequired: true,
  applicationName: "research-control-plane-test",
  maxConnections: 1,
  minConnections: 0,
  idleTimeoutMs: 1_000,
  connectionTimeoutMs: 1_000,
  statementTimeoutMs: 1_000,
  lockTimeoutMs: 500,
  idleInTransactionTimeoutMs: 1_000,
  transactionTimeoutMs: 2_000,
  features: {
    postgresReads: true,
    postgresWrites: true,
    shadowComparison: false,
    controlPlaneAuthority: false,
    executionStateAuthority: false,
    sqliteAuditMirror: false,
    ...features
  }
});

const runtimeFor = (config: DatabaseConfig): ControlPlaneRuntimeContext => ({
  config,
  pool: {} as Pool,
  fence: {
    jobName: "research",
    workstream: "research",
    ownerId: "worker-1",
    runId: "scheduler-run-1",
    fencingToken: "11"
  },
  signal: new AbortController().signal,
  operationId: "operation-1",
  requestId: null,
  correlationId: null,
  researchRunVersions: new Map()
});

const adapters = (calls: string[]) => {
  const make = (name: string): ResearchPersistenceAdapter => ({
    async reserve(input) {
      calls.push(`${name}:reserve`);
      return { status: "reserved", runId: input.runId, startedAt: input.now.toISOString() };
    },
    async heartbeat() {
      calls.push(`${name}:heartbeat`);
      return true;
    },
    async updateUniverseSize() {
      calls.push(`${name}:progress`);
      return true;
    },
    async finish() {
      calls.push(`${name}:finish`);
    },
    async persistCandidates(_runId, decisions) {
      calls.push(`${name}:candidates`);
      return decisions.map((decision) => ({ ...decision, researchRunId: "run-1" }));
    }
  });
  return { sqlite: make("sqlite"), postgres: make("postgres") };
};

const reservation = {
  runId: "run-1",
  now: new Date("2026-07-15T20:00:00.000Z"),
  riskProfile: "aggressive",
  optionsEnabled: true,
  configJson: "{}"
};

test("SQLite remains the only writer when PostgreSQL transition flags are off", async () => {
  const calls: string[] = [];
  const service = createResearchControlPlaneService({
    ...adapters(calls),
    currentRuntime: () => null
  });
  const result = await service.reserve(reservation);
  assert.equal(result.status, "reserved");
  assert.deepEqual(calls, ["sqlite:reserve"]);
});

test("shadow mode keeps SQLite authoritative and reports PostgreSQL discrepancies", async () => {
  const calls: string[] = [];
  const found: string[] = [];
  const pair = adapters(calls);
  pair.postgres.reserve = async () => {
    calls.push("postgres:reserve");
    return {
      status: "already_running",
      activeRunId: "other-run",
      startedAt: "2026-07-15T19:00:00.000Z",
      heartbeatAt: "2026-07-15T19:01:00.000Z"
    };
  };
  const service = createResearchControlPlaneService({
    ...pair,
    currentRuntime: () => runtimeFor(configFor({ shadowComparison: true })),
    reportDiscrepancy: (code) => found.push(code)
  });
  const result = await service.reserve(reservation);
  assert.equal(result.status, "reserved");
  assert.deepEqual(calls, ["sqlite:reserve", "postgres:reserve"]);
  assert.deepEqual(found, ["RESEARCH_RESERVATION_SHADOW_MISMATCH"]);
});

test("authority writes PostgreSQL first and SQLite only as a compatibility projection", async () => {
  const calls: string[] = [];
  const service = createResearchControlPlaneService({
    ...adapters(calls),
    currentRuntime: () =>
      runtimeFor(
        configFor({ controlPlaneAuthority: true, sqliteAuditMirror: true })
      )
  });
  await service.reserve(reservation);
  assert.deepEqual(calls, ["postgres:reserve", "sqlite:reserve"]);
});

test("authority never falls back to SQLite when PostgreSQL fails", async () => {
  const calls: string[] = [];
  const pair = adapters(calls);
  pair.postgres.reserve = async () => {
    calls.push("postgres:reserve");
    throw new Error("synthetic postgres failure");
  };
  const service = createResearchControlPlaneService({
    ...pair,
    currentRuntime: () =>
      runtimeFor(
        configFor({ controlPlaneAuthority: true, sqliteAuditMirror: true })
      )
  });
  await assert.rejects(service.reserve(reservation), /synthetic postgres failure/);
  assert.deepEqual(calls, ["postgres:reserve"]);
});

test("Release 3 authority requires the SQLite compatibility projection until execution cutover", async () => {
  const calls: string[] = [];
  const service = createResearchControlPlaneService({
    ...adapters(calls),
    currentRuntime: () => runtimeFor(configFor({ controlPlaneAuthority: true }))
  });
  await assert.rejects(
    service.reserve(reservation),
    /SQLITE_CONTROL_PLANE_PROJECTION_REQUIRED/
  );
  assert.deepEqual(calls, []);
});

test("execution authority with the audit mirror disabled writes PostgreSQL only", async () => {
  const calls: string[] = [];
  const service = createResearchControlPlaneService({
    ...adapters(calls),
    currentRuntime: () =>
      runtimeFor(
        configFor({
          controlPlaneAuthority: true,
          executionStateAuthority: true,
          sqliteAuditMirror: false
        })
      )
  });
  await service.reserve(reservation);
  await service.heartbeat(reservation.runId);
  await service.updateUniverseSize(reservation.runId, 51);
  await service.persistCandidates(reservation.runId, []);
  await service.finish(reservation.runId, {
    status: "completed",
    targetsGenerated: 0,
    candidatesSelected: 0,
    summaryJson: "{}"
  });
  assert.deepEqual(calls, [
    "postgres:reserve",
    "postgres:heartbeat",
    "postgres:progress",
    "postgres:candidates",
    "postgres:finish"
  ]);
});
