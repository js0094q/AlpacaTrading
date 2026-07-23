import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Pool, PoolClient, QueryResult } from "pg";

import type { DatabaseConfig } from "../src/lib/database/config.js";
import {
  backfillExecutionStateSnapshot,
  reconcileExecutionStateSnapshot,
  readExecutionStateSnapshot
} from "../src/services/executionStateMigrationService.js";
import { createExecutionStateSnapshotFixture } from "./helpers/executionStateSnapshotFixture.js";

const migrationConfig: DatabaseConfig = {
  backend: "postgres",
  runtime: "test",
  purpose: "migration",
  directUrl: "postgresql://synthetic:synthetic@host.invalid/db",
  directVariable: "DATABASE_URL_UNPOOLED",
  sslRequired: true,
  applicationName: "execution-state-identity-test",
  maxConnections: 1,
  minConnections: 0,
  idleTimeoutMs: 1_000,
  connectionTimeoutMs: 1_000,
  statementTimeoutMs: 120_000,
  lockTimeoutMs: 10_000,
  idleInTransactionTimeoutMs: 60_000,
  transactionTimeoutMs: 180_000,
  features: {
    postgresReads: false,
    postgresWrites: false,
    shadowComparison: false,
    controlPlaneAuthority: false,
    schedulerAuthority: false,
    executionStateShadow: false,
    executionStateAuthority: false,
    sqliteAuditMirror: false
  }
};

type StoredRow = Record<string, unknown>;

const primaryKeys: Readonly<Record<string, string>> = {
  accounts: "id",
  account_snapshots: "id",
  risk_limits: "id",
  strategy_allocations: "id",
  portfolio_exposure: "id",
  execution_reviews: "id",
  confirmation_evidence: "id",
  buying_power_reservations: "id",
  order_intents: "id",
  orders: "id",
  positions: "id",
  broker_events: "event_id",
  lifecycle_fingerprints: "id"
};

const identityColumns: Readonly<Record<string, readonly string[]>> = {
  accounts: ["broker", "environment", "broker_account_id"],
  account_snapshots: ["account_id", "snapshot_fingerprint"],
  buying_power_reservations: ["account_id", "idempotency_key"]
};

const compact = (sql: string) => sql.replace(/\s+/g, " ").trim();

const asQueryResult = (rows: readonly Record<string, unknown>[] = [], rowCount = rows.length) =>
  ({ rows, rowCount } as unknown as QueryResult);

const sameValue = (left: unknown, right: unknown) => {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) {
    return left === right || (left == null && right == null);
  }
  return JSON.stringify(left) === JSON.stringify(right);
};

const createFakeExecutionStatePool = () => {
  const rows = new Map<string, StoredRow[]>();
  for (const table of Object.keys(primaryKeys)) rows.set(table, []);
  const checkpoints: StoredRow[] = [];

  const seed = (table: string, row: StoredRow) => {
    rows.get(table)?.push({ ...row });
  };

  const findByPrimaryKey = (table: string, value: unknown) =>
    rows.get(table)?.find((row) => sameValue(row[primaryKeys[table]!], value));

  const findByIdentity = (table: string, values: readonly unknown[]) => {
    const columns = identityColumns[table];
    if (!columns) return undefined;
    return rows.get(table)?.find((row) => columns.every((column, index) =>
      sameValue(row[column], values[index])
    ));
  };

  const query = async (sql: string, values: readonly unknown[] = []) => {
    const text = compact(sql);
    if (
      text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" ||
      text.startsWith("SET TRANSACTION") || text.startsWith("SET LOCAL") ||
      text.includes("pg_advisory_lock") || text.includes("pg_advisory_unlock") ||
      text.includes("pg_advisory_xact_lock") || text.startsWith("LOCK TABLE")
    ) return asQueryResult([], 0);

    if (text.includes("FROM reconciliation_checkpoints") && text.startsWith("SELECT")) {
      const id = values[0];
      const checkpoint = checkpoints.find((row) => sameValue(row.id, id));
      return checkpoint ? asQueryResult([checkpoint]) : asQueryResult([], 0);
    }

    const insert = /^INSERT INTO ([a-z_]+)\(([^)]+)\)/.exec(text);
    if (insert) {
      const table = insert[1]!;
      const columns = insert[2]!.split(",").map((column) => column.trim());
      const row = Object.fromEntries(columns.map((column, index) => [column, values[index] ?? null]));
      if (table === "reconciliation_checkpoints") {
        const checkpoint = text.includes("'execution_state_backfill'")
          ? {
            id: values[0],
            workstream: "execution_state_backfill",
            status: "passed",
            source_checksum: values[2],
            source_row_count: values[3],
            target_row_count: values[3],
            discrepancy_count: 0,
            cursor_value: values[4],
            source_aggregates: values[5],
            target_aggregates: values[5],
            discrepancy_report: values[6],
            completed_at: values[7]
          }
          : {
            id: values[0],
            workstream: "execution_state_reconciliation",
            status: values[1],
            source_checksum: values[2],
            discrepancy_count: values[5],
            cursor_value: values[6],
            source_aggregates: values[7],
            target_aggregates: values[8],
            discrepancy_report: values[9],
            completed_at: values[11]
          };
        if (checkpoints.some((existing) => sameValue(existing.id, checkpoint.id))) {
          return asQueryResult([], 0);
        }
        checkpoints.push(checkpoint);
        return asQueryResult([], 1);
      }
      if (!(table in primaryKeys)) return asQueryResult([], 1);
      const existingPrimary = findByPrimaryKey(table, row[primaryKeys[table]!]);
      const identity = findByIdentity(
        table,
        (identityColumns[table] ?? []).map((column) => row[column])
      );
      const activeRiskScope = table === "risk_limits"
        ? rows.get(table)?.find((existing) =>
          existing.status === "active" && existing.effective_to === null &&
          row.status === "active" && row.effective_to === null &&
          sameValue(existing.account_id, row.account_id) &&
          sameValue(existing.scope_type, row.scope_type) &&
          sameValue(existing.scope_key, row.scope_key)
        )
        : undefined;
      const activeStrategyAllocation = table === "strategy_allocations"
        ? rows.get(table)?.find((existing) =>
          existing.status === "active" && existing.effective_to === null &&
          row.status === "active" && row.effective_to === null &&
          sameValue(existing.account_id, row.account_id) &&
          sameValue(existing.strategy_key, row.strategy_key)
        )
        : undefined;
      if (activeRiskScope && !existingPrimary) {
        const error = new Error(`duplicate current risk scope for ${table}`) as Error & {
          code?: string;
        };
        error.code = "23505";
        throw error;
      }
      if (activeStrategyAllocation && !existingPrimary) {
        const error = new Error(`duplicate current strategy allocation for ${table}`) as Error & {
          code?: string;
        };
        error.code = "23505";
        throw error;
      }
      if (identity && !existingPrimary && !text.includes("ON CONFLICT DO NOTHING")) {
        const error = new Error(`duplicate identity for ${table}`) as Error & { code?: string };
        error.code = "23505";
        throw error;
      }
      if (existingPrimary || identity) return asQueryResult([], 0);
      rows.get(table)!.push(row);
      return asQueryResult([], 1);
    }

    const matches = /^SELECT \((.+)\) AS matches FROM ([a-z_]+) WHERE ([a-z_]+) = \$(\d+)$/.exec(text);
    if (matches) {
      const table = matches[2]!;
      const key = matches[3]!;
      const stored = rows.get(table)?.find((row) => sameValue(row[key], values[Number(matches[4]) - 1]));
      if (!stored) return asQueryResult([], 0);
      const expected = values.slice(0, Object.keys(stored).length);
      const columns = matches[1]!
        .split(" AND ")
        .map((condition) => /^([a-z_]+) IS NOT DISTINCT FROM \$\d+(?:::jsonb)?$/.exec(condition)?.[1])
        .filter((column): column is string => Boolean(column));
      return asQueryResult([{
        matches: columns.every((column, index) => sameValue(stored[column], expected[index]))
      }]);
    }

    const select = /^SELECT (.+) FROM ([a-z_]+)(?: WHERE (.+))?$/.exec(text);
    if (select && select[1] !== "COUNT(*) AS count") {
      const table = select[2]!;
      const where = select[3] ?? "";
      const keyMatch = /([a-z_]+) = \$(\d+)/g;
      const predicates = [...where.matchAll(keyMatch)].map((match) => ({
        column: match[1]!,
        value: values[Number(match[2]) - 1]
      }));
      const stored = (rows.get(table) ?? []).filter((row) => predicates.every((predicate) =>
        sameValue(row[predicate.column], predicate.value)
      ));
      return asQueryResult(stored);
    }

    const count = /^SELECT COUNT\(\*\) AS count FROM ([a-z_]+)(?: WHERE (.+))?$/.exec(text);
    if (count) {
      const table = count[1]!;
      const where = count[2] ?? "";
      const keyMatch = /([a-z_]+) = \$(\d+)/g;
      const predicates = [...where.matchAll(keyMatch)].map((match) => ({
        column: match[1]!,
        value: values[Number(match[2]) - 1]
      }));
      const total = (rows.get(table) ?? []).filter((row) => predicates.every((predicate) =>
        sameValue(row[predicate.column], predicate.value)
      )).length;
      return asQueryResult([{ count: total }]);
    }

    if (text.startsWith("SELECT COUNT(*) AS count FROM")) return asQueryResult([{ count: 0 }]);
    return asQueryResult([], 0);
  };

  const client = {
    query,
    release: () => undefined
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, rows, checkpoints, seed };
};

const makeFixture = async (
  prefix: string,
  options: { capturedAt?: string; positionMarketValue?: number } = {}
) => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const snapshotPath = join(directory, "source.db");
  createExecutionStateSnapshotFixture(snapshotPath, options);
  return { directory, snapshotPath };
};

test("reuses the newer PostgreSQL account head for the exact production conflict", async () => {
  const fixture = await makeFixture("execution-state-account-head-production-");
  try {
    const source = await readExecutionStateSnapshot(fixture.snapshotPath);
    const sourceAccount = source.rows.get("accounts")?.[0];
    const sourceSnapshot = source.rows.get("account_snapshots")?.[0];
    assert.ok(sourceAccount);
    assert.ok(sourceSnapshot);
    const fake = createFakeExecutionStatePool();
    fake.seed("accounts", {
      ...sourceAccount,
      version: "57",
      updated_at: "2026-07-18T18:20:00.000Z"
    });
    const authorityOnlySnapshot = {
      ...sourceSnapshot,
      id: "postgres-authority-only-account-snapshot",
      observed_at: "2026-07-18T18:20:00.000Z",
      snapshot_fingerprint: "postgres-authority-only-fingerprint",
      created_at: "2026-07-18T18:20:00.000Z"
    };
    fake.seed("account_snapshots", authorityOnlySnapshot);

    const first = await backfillExecutionStateSnapshot({
      snapshotPath: fixture.snapshotPath,
      pool: fake.pool,
      config: migrationConfig,
      batchSize: 1,
      observedAt: "2026-07-18T18:25:00.000Z"
    });

    assert.equal(first.insertedRows.accounts, 0);
    assert.ok(first.identityReuses.some((reuse) =>
      reuse.table === "accounts" &&
      reuse.sourceId === sourceAccount.id &&
      reuse.targetId === sourceAccount.id &&
      reuse.identityColumns.join(",") === "id" &&
      reuse.mutableDifferences.join(",") === "version,updated_at"
    ));
    assert.equal(first.mutableStateDifferences["accounts:version"], 1);
    assert.equal(first.mutableStateDifferences["accounts:updated_at"], 1);
    assert.equal(fake.rows.get("accounts")?.length, 1);
    assert.equal(
      fake.checkpoints.some(
        (checkpoint) => checkpoint.workstream === "execution_state_reconciliation"
      ),
      false
    );
    assert.equal(fake.rows.get("accounts")?.[0]?.version, "57");
    assert.deepEqual(
      fake.rows.get("account_snapshots")?.find(
        (row) => row.id === authorityOnlySnapshot.id
      ),
      authorityOnlySnapshot
    );
    for (const rows of fake.rows.values()) {
      assert.ok(rows.every((row) =>
        row.account_id === undefined || row.account_id === sourceAccount.id
      ));
    }

    const replay = await backfillExecutionStateSnapshot({
      snapshotPath: fixture.snapshotPath,
      pool: fake.pool,
      config: migrationConfig,
      batchSize: 1,
      observedAt: "2026-07-18T18:25:00.000Z"
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.mutationCount, 0);
    assert.equal(fake.rows.get("accounts")?.length, 1);
    assert.deepEqual(
      fake.rows.get("account_snapshots")?.find(
        (row) => row.id === authorityOnlySnapshot.id
      ),
      authorityOnlySnapshot
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("reuses a newer account head when only mutable status differs", async () => {
  const fixture = await makeFixture("execution-state-account-head-mutable-");
  try {
    const source = await readExecutionStateSnapshot(fixture.snapshotPath);
    const sourceAccount = source.rows.get("accounts")?.[0];
    assert.ok(sourceAccount);
    const fake = createFakeExecutionStatePool();
    fake.seed("accounts", {
      ...sourceAccount,
      status: "ACCOUNT_RESTRICTED",
      version: 2,
      updated_at: "2026-07-18T18:20:00.000Z"
    });

    const result = await backfillExecutionStateSnapshot({
      snapshotPath: fixture.snapshotPath,
      pool: fake.pool,
      config: migrationConfig,
      batchSize: 1
    });

    assert.equal(result.insertedRows.accounts, 0);
    assert.equal(result.mutableStateDifferences["accounts:status"], 1);
    assert.equal(fake.rows.get("accounts")?.[0]?.status, "ACCOUNT_RESTRICTED");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("normalizes equivalent account version representations", async () => {
  const fixture = await makeFixture("execution-state-account-version-normalization-");
  try {
    const source = await readExecutionStateSnapshot(fixture.snapshotPath);
    const sourceAccount = source.rows.get("accounts")?.[0];
    assert.ok(sourceAccount);
    const fake = createFakeExecutionStatePool();
    fake.seed("accounts", {
      ...sourceAccount,
      version: String(sourceAccount.version)
    });

    const result = await backfillExecutionStateSnapshot({
      snapshotPath: fixture.snapshotPath,
      pool: fake.pool,
      config: migrationConfig,
      batchSize: 1
    });

    assert.equal(result.insertedRows.accounts, 0);
    assert.equal(result.mutableStateDifferences["accounts:version"], undefined);
    assert.equal(fake.rows.get("accounts")?.length, 1);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("fails closed for a contradictory immutable account environment", async () => {
  const fixture = await makeFixture("execution-state-account-immutable-conflict-");
  try {
    const source = await readExecutionStateSnapshot(fixture.snapshotPath);
    const sourceAccount = source.rows.get("accounts")?.[0];
    assert.ok(sourceAccount);
    const fake = createFakeExecutionStatePool();
    fake.seed("accounts", {
      ...sourceAccount,
      environment: "live",
      version: 57,
      updated_at: "2026-07-18T18:20:00.000Z"
    });

    await assert.rejects(
      () => backfillExecutionStateSnapshot({
        snapshotPath: fixture.snapshotPath,
        pool: fake.pool,
        config: migrationConfig,
        batchSize: 1
      }),
      /EXECUTION_STATE_BACKFILL_IDENTITY_CONFLICT:accounts/
    );
    assert.equal(fake.rows.get("accounts")?.length, 1);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("fails closed with a sanitized conflict for a different account primary key", async () => {
  const fixture = await makeFixture("execution-state-account-primary-conflict-");
  try {
    const source = await readExecutionStateSnapshot(fixture.snapshotPath);
    const sourceAccount = source.rows.get("accounts")?.[0];
    assert.ok(sourceAccount);
    const fake = createFakeExecutionStatePool();
    fake.seed("accounts", {
      ...sourceAccount,
      id: "postgres-different-account-primary-key"
    });

    await assert.rejects(
      () => backfillExecutionStateSnapshot({
        snapshotPath: fixture.snapshotPath,
        pool: fake.pool,
        config: migrationConfig,
        batchSize: 1
      }),
      /EXECUTION_STATE_BACKFILL_IDENTITY_CONFLICT:accounts/
    );
    assert.equal(fake.rows.get("accounts")?.length, 1);
    assert.equal(
      fake.rows.get("accounts")?.[0]?.id,
      "postgres-different-account-primary-key"
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("reuses the exact production risk-limit identity when only observation provenance differs", async () => {
  const fixture = await makeFixture("execution-state-risk-limit-production-", {
    capturedAt: "2026-07-17T19:59:53.128Z"
  });
  try {
    const source = await readExecutionStateSnapshot(fixture.snapshotPath);
    const sourceRiskLimit = source.rows.get("risk_limits")?.[0];
    assert.ok(sourceRiskLimit);
    const fake = createFakeExecutionStatePool();
    const existingRiskLimit = {
      ...sourceRiskLimit,
      effective_from: "2026-07-17T16:35:00.031Z",
      version: String(sourceRiskLimit.version),
      created_at: "2026-07-17T16:35:00.031Z",
      updated_at: "2026-07-17T16:35:00.031Z"
    };
    const authorityOnlySupersededRiskLimit = {
      ...sourceRiskLimit,
      id: "postgres-superseded-risk-policy",
      status: "superseded",
      config_fingerprint: "postgres-prior-config-fingerprint",
      effective_from: "2026-07-17T13:54:34.316Z",
      effective_to: "2026-07-17T16:35:00.031Z",
      version: "2",
      created_at: "2026-07-17T13:54:34.316Z",
      updated_at: "2026-07-17T16:35:00.031Z"
    };
    fake.seed("risk_limits", existingRiskLimit);
    fake.seed("risk_limits", authorityOnlySupersededRiskLimit);

    const result = await backfillExecutionStateSnapshot({
      snapshotPath: fixture.snapshotPath,
      pool: fake.pool,
      config: migrationConfig,
      batchSize: 1,
      observedAt: "2026-07-18T12:00:00.000Z"
    });

    assert.equal(result.insertedRows.risk_limits, 0);
    assert.deepEqual(
      result.identityReuses.find((reuse) => reuse.table === "risk_limits"),
      {
        table: "risk_limits",
        sourceId: sourceRiskLimit.id,
        targetId: sourceRiskLimit.id,
        identityColumns: [
          "id", "account_id", "scope_type", "scope_key", "config_fingerprint"
        ],
        mutableDifferences: ["effective_from", "created_at", "updated_at"],
        classification: "provenance_only"
      }
    );
    assert.deepEqual(
      fake.rows.get("risk_limits")?.find((row) => row.id === sourceRiskLimit.id),
      existingRiskLimit
    );
    assert.deepEqual(
      fake.rows.get("risk_limits")?.find(
        (row) => row.id === authorityOnlySupersededRiskLimit.id
      ),
      authorityOnlySupersededRiskLimit
    );
    assert.equal(fake.rows.get("risk_limits")?.length, 2);
    assert.equal(result.mutableStateDifferences["risk_limits:effective_from"], 1);
    assert.equal(result.mutableStateDifferences["risk_limits:created_at"], 1);
    assert.equal(result.mutableStateDifferences["risk_limits:updated_at"], 1);
    assert.equal(result.mutableStateDifferences["risk_limits:version"], undefined);
    assert.ok([...source.rows.entries()].every(([table, rows]) =>
      table === "risk_limits" || rows.every((row) =>
        Object.values(row).every((value) => value !== sourceRiskLimit.id)
      )
    ));

    const replay = await backfillExecutionStateSnapshot({
      snapshotPath: fixture.snapshotPath,
      pool: fake.pool,
      config: migrationConfig,
      batchSize: 1,
      observedAt: "2026-07-18T12:00:00.000Z"
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.mutationCount, 0);
    assert.equal(fake.rows.get("risk_limits")?.length, 2);

    const reconciliation = await reconcileExecutionStateSnapshot({
      snapshotPath: fixture.snapshotPath,
      pool: fake.pool,
      config: migrationConfig,
      checkpointId: "execution-state-risk-limit-production",
      observedAt: "2026-07-18T12:00:00.000Z"
    });
    assert.equal(reconciliation.status, "passed");
    assert.equal(reconciliation.discrepancyCount, 0);
    assert.equal(reconciliation.tableComparisons.risk_limits.authorityOnly, 1);
    assert.equal(reconciliation.tableComparisons.risk_limits.mutableStateDifference, 1);
    assert.equal(
      reconciliation.classifiedStateDifferences["risk_limits:effective_from"],
      1
    );
    assert.equal(
      reconciliation.classifiedStateDifferences["risk_limits:created_at"],
      1
    );
    assert.equal(
      reconciliation.classifiedStateDifferences["risk_limits:updated_at"],
      1
    );
    assert.equal(
      fake.checkpoints.find(
        (checkpoint) => checkpoint.id === "execution-state-risk-limit-production"
      )?.status,
      "passed"
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("reuses the exact production-shaped newer strategy-allocation singleton", async () => {
  const fixture = await makeFixture("execution-state-strategy-allocation-production-", {
    capturedAt: "2026-07-17T19:59:53.128Z"
  });
  try {
    const source = await readExecutionStateSnapshot(fixture.snapshotPath);
    const sourceAllocation = source.rows.get("strategy_allocations")?.[0];
    assert.ok(sourceAllocation);
    const fake = createFakeExecutionStatePool();
    const existingAllocation = {
      ...sourceAllocation,
      deployed_amount: "1250.50000000",
      effective_from: "2026-07-17T16:35:00.031Z",
      version: "158",
      created_at: "2026-07-17T16:35:00.031Z",
      updated_at: "2026-07-17T20:00:24.062Z"
    };
    const authorityOnlySupersededAllocation = {
      ...sourceAllocation,
      id: "postgres-superseded-strategy-allocation",
      status: "superseded",
      config_version: "postgres-prior-config-version",
      config_fingerprint: "postgres-prior-config-fingerprint",
      effective_from: "2026-07-17T13:54:34.316Z",
      effective_to: "2026-07-17T16:35:00.031Z",
      version: "2",
      created_at: "2026-07-17T13:54:34.316Z",
      updated_at: "2026-07-17T16:35:00.031Z"
    };
    fake.seed("strategy_allocations", existingAllocation);
    fake.seed("strategy_allocations", authorityOnlySupersededAllocation);

    const result = await backfillExecutionStateSnapshot({
      snapshotPath: fixture.snapshotPath,
      pool: fake.pool,
      config: migrationConfig,
      batchSize: 1,
      observedAt: "2026-07-18T12:00:00.000Z"
    });

    assert.equal(result.insertedRows.strategy_allocations, 0);
    assert.deepEqual(
      result.identityReuses.find((reuse) => reuse.table === "strategy_allocations"),
      {
        table: "strategy_allocations",
        sourceId: sourceAllocation.id,
        targetId: sourceAllocation.id,
        identityColumns: [
          "id", "account_id", "strategy_key", "config_fingerprint"
        ],
        mutableDifferences: [
          "deployed_amount", "effective_from", "version", "created_at", "updated_at"
        ],
        classification: "mutable_singleton_advancement"
      }
    );
    assert.deepEqual(
      fake.rows.get("strategy_allocations")?.find(
        (row) => row.id === sourceAllocation.id
      ),
      existingAllocation
    );
    assert.deepEqual(
      fake.rows.get("strategy_allocations")?.find(
        (row) => row.id === authorityOnlySupersededAllocation.id
      ),
      authorityOnlySupersededAllocation
    );
    assert.equal(fake.rows.get("strategy_allocations")?.length, 2);
    for (const column of [
      "deployed_amount", "effective_from", "version", "created_at", "updated_at"
    ]) {
      assert.equal(result.mutableStateDifferences[`strategy_allocations:${column}`], 1);
    }
    assert.ok([...source.rows.entries()].every(([table, rows]) =>
      table === "strategy_allocations" || rows.every((row) =>
        Object.values(row).every((value) => value !== sourceAllocation.id)
      )
    ));

    const replay = await backfillExecutionStateSnapshot({
      snapshotPath: fixture.snapshotPath,
      pool: fake.pool,
      config: migrationConfig,
      batchSize: 1,
      observedAt: "2026-07-18T12:00:00.000Z"
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.mutationCount, 0);
    assert.equal(fake.rows.get("strategy_allocations")?.length, 2);

    const reconciliation = await reconcileExecutionStateSnapshot({
      snapshotPath: fixture.snapshotPath,
      pool: fake.pool,
      config: migrationConfig,
      checkpointId: "execution-state-strategy-allocation-production",
      observedAt: "2026-07-18T12:00:00.000Z"
    });
    assert.equal(reconciliation.status, "passed");
    assert.equal(reconciliation.discrepancyCount, 0);
    assert.equal(
      reconciliation.tableComparisons.strategy_allocations.authorityOnly,
      1
    );
    assert.equal(
      reconciliation.tableComparisons.strategy_allocations.mutableStateDifference,
      1
    );
    assert.equal(
      fake.checkpoints.find(
        (checkpoint) => checkpoint.id === "execution-state-strategy-allocation-production"
      )?.status,
      "passed"
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("accepts only proven strategy-allocation normalization equivalence", async () => {
  const normalizationFixture = await makeFixture(
    "execution-state-strategy-allocation-normalization-"
  );
  try {
    const source = await readExecutionStateSnapshot(normalizationFixture.snapshotPath);
    const sourceAllocation = source.rows.get("strategy_allocations")?.[0];
    assert.ok(sourceAllocation);
    const normalizedTarget: StoredRow = {
      ...sourceAllocation,
      allocation_amount: Number(sourceAllocation.allocation_amount),
      allocation_ratio: Number(sourceAllocation.allocation_ratio),
      reserved_amount: Number(sourceAllocation.reserved_amount),
      deployed_amount: Number(sourceAllocation.deployed_amount),
      version: String(sourceAllocation.version)
    };
    const fake = createFakeExecutionStatePool();
    fake.seed("strategy_allocations", normalizedTarget);

    const result = await backfillExecutionStateSnapshot({
      snapshotPath: normalizationFixture.snapshotPath,
      pool: fake.pool,
      config: migrationConfig,
      batchSize: 1
    });

    assert.equal(result.insertedRows.strategy_allocations, 0);
    assert.equal(
      result.identityReuses.some((reuse) => reuse.table === "strategy_allocations"),
      false
    );
    assert.deepEqual(fake.rows.get("strategy_allocations"), [normalizedTarget]);
  } finally {
    await rm(normalizationFixture.directory, { recursive: true, force: true });
  }

  const staleProvenanceFixture = await makeFixture(
    "execution-state-strategy-allocation-stale-provenance-",
    { capturedAt: "2026-07-17T19:59:53.128Z" }
  );
  try {
    const source = await readExecutionStateSnapshot(staleProvenanceFixture.snapshotPath);
    const sourceAllocation = source.rows.get("strategy_allocations")?.[0];
    assert.ok(sourceAllocation);
    const staleProvenanceTarget = {
      ...sourceAllocation,
      effective_from: "2026-07-17T16:35:00.031Z",
      created_at: "2026-07-17T16:35:00.031Z",
      updated_at: "2026-07-17T16:35:00.031Z"
    };
    const fake = createFakeExecutionStatePool();
    fake.seed("strategy_allocations", staleProvenanceTarget);

    await assert.rejects(
      () => backfillExecutionStateSnapshot({
        snapshotPath: staleProvenanceFixture.snapshotPath,
        pool: fake.pool,
        config: migrationConfig,
        batchSize: 1
      }),
      /EXECUTION_STATE_BACKFILL_STRATEGY_ALLOCATION_CONFLICT:STALE/
    );
    assert.deepEqual(
      fake.rows.get("strategy_allocations"),
      [staleProvenanceTarget]
    );
  } finally {
    await rm(staleProvenanceFixture.directory, { recursive: true, force: true });
  }
});

test("fails closed with sanitized classifications for incompatible strategy allocations", async () => {
  const cases: Array<{
    label: string;
    mutateTarget: (row: StoredRow) => void;
    code: RegExp;
  }> = [
    {
      label: "account-identity",
      mutateTarget: (row) => { row.account_id = "different-account-identity"; },
      code: /EXECUTION_STATE_BACKFILL_STRATEGY_ALLOCATION_CONFLICT:IDENTITY/
    },
    {
      label: "strategy-identity",
      mutateTarget: (row) => { row.strategy_key = "different-strategy"; },
      code: /EXECUTION_STATE_BACKFILL_STRATEGY_ALLOCATION_CONFLICT:IDENTITY/
    },
    {
      label: "configuration-fingerprint",
      mutateTarget: (row) => { row.config_fingerprint = "different-fingerprint"; },
      code: /EXECUTION_STATE_BACKFILL_STRATEGY_ALLOCATION_CONFLICT:POLICY/
    },
    {
      label: "allocation-amount",
      mutateTarget: (row) => { row.allocation_amount = "999999.00000000"; },
      code: /EXECUTION_STATE_BACKFILL_STRATEGY_ALLOCATION_CONFLICT:POLICY/
    },
    {
      label: "allocation-ratio",
      mutateTarget: (row) => { row.allocation_ratio = "0.9999999999"; },
      code: /EXECUTION_STATE_BACKFILL_STRATEGY_ALLOCATION_CONFLICT:POLICY/
    },
    {
      label: "lifecycle-status",
      mutateTarget: (row) => { row.status = "superseded"; },
      code: /EXECUTION_STATE_BACKFILL_STRATEGY_ALLOCATION_CONFLICT:LIFECYCLE/
    },
    {
      label: "malformed-numeric",
      mutateTarget: (row) => { row.reserved_amount = "not-a-decimal"; },
      code: /EXECUTION_STATE_BACKFILL_STRATEGY_ALLOCATION_CONFLICT:MALFORMED/
    },
    {
      label: "malformed-version",
      mutateTarget: (row) => { row.version = "not-an-integer"; },
      code: /EXECUTION_STATE_BACKFILL_STRATEGY_ALLOCATION_CONFLICT:MALFORMED/
    },
    {
      label: "unadvanced-version",
      mutateTarget: (row) => {
        row.deployed_amount = "1.00000000";
        row.updated_at = "2026-07-18T18:20:00.000Z";
      },
      code: /EXECUTION_STATE_BACKFILL_STRATEGY_ALLOCATION_CONFLICT:STALE/
    },
    {
      label: "later-activation-provenance",
      mutateTarget: (row) => {
        row.effective_from = "2026-07-19T00:00:00.000Z";
        row.created_at = "2026-07-19T00:00:00.000Z";
        row.updated_at = "2026-07-19T00:00:00.000Z";
      },
      code: /EXECUTION_STATE_BACKFILL_STRATEGY_ALLOCATION_CONFLICT:PROVENANCE_ORDER/
    }
  ];

  for (const scenario of cases) {
    const fixture = await makeFixture(`execution-state-strategy-${scenario.label}-`);
    try {
      const source = await readExecutionStateSnapshot(fixture.snapshotPath);
      const sourceAllocation = source.rows.get("strategy_allocations")?.[0];
      assert.ok(sourceAllocation);
      const target: StoredRow = { ...sourceAllocation };
      scenario.mutateTarget(target);
      const fake = createFakeExecutionStatePool();
      fake.seed("strategy_allocations", target);

      await assert.rejects(
        () => backfillExecutionStateSnapshot({
          snapshotPath: fixture.snapshotPath,
          pool: fake.pool,
          config: migrationConfig,
          batchSize: 1
        }),
        scenario.code,
        scenario.label
      );
      assert.deepEqual(fake.rows.get("strategy_allocations"), [target], scenario.label);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }
});

test("fails closed when a newer strategy-allocation head regresses deployed state", async () => {
  const fixture = await makeFixture("execution-state-strategy-deployed-regression-", {
    positionMarketValue: 100
  });
  try {
    const source = await readExecutionStateSnapshot(fixture.snapshotPath);
    const sourceAllocation = source.rows.get("strategy_allocations")?.[0];
    assert.ok(sourceAllocation);
    const target = {
      ...sourceAllocation,
      deployed_amount: "99.00000000",
      version: "2",
      updated_at: "2026-07-18T18:20:00.000Z"
    };
    const fake = createFakeExecutionStatePool();
    fake.seed("strategy_allocations", target);

    await assert.rejects(
      () => backfillExecutionStateSnapshot({
        snapshotPath: fixture.snapshotPath,
        pool: fake.pool,
        config: migrationConfig,
        batchSize: 1
      }),
      /EXECUTION_STATE_BACKFILL_STRATEGY_ALLOCATION_CONFLICT:STATE_REGRESSION/
    );
    assert.deepEqual(fake.rows.get("strategy_allocations"), [target]);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("fails closed on a distinct current allocation in the same account strategy", async () => {
  const fixture = await makeFixture("execution-state-strategy-current-collision-");
  try {
    const source = await readExecutionStateSnapshot(fixture.snapshotPath);
    const sourceAllocation = source.rows.get("strategy_allocations")?.[0];
    assert.ok(sourceAllocation);
    const distinctCurrent = {
      ...sourceAllocation,
      id: "postgres-distinct-current-strategy-allocation",
      config_version: "postgres-distinct-config-version",
      config_fingerprint: "postgres-distinct-config-fingerprint"
    };
    const fake = createFakeExecutionStatePool();
    fake.seed("strategy_allocations", distinctCurrent);

    await assert.rejects(
      () => backfillExecutionStateSnapshot({
        snapshotPath: fixture.snapshotPath,
        pool: fake.pool,
        config: migrationConfig,
        batchSize: 1
      }),
      /EXECUTION_STATE_BACKFILL_STRATEGY_ALLOCATION_CONFLICT:CURRENT_STRATEGY/
    );
    assert.deepEqual(fake.rows.get("strategy_allocations"), [distinctCurrent]);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("incompatible strategy allocation cannot produce a passed reconciliation checkpoint", async () => {
  const fixture = await makeFixture("execution-state-strategy-reconciliation-conflict-");
  try {
    const source = await readExecutionStateSnapshot(fixture.snapshotPath);
    const sourceAllocation = source.rows.get("strategy_allocations")?.[0];
    assert.ok(sourceAllocation);
    const target = {
      ...sourceAllocation,
      allocation_amount: "999999.00000000"
    };
    const fake = createFakeExecutionStatePool();
    fake.seed("strategy_allocations", target);

    const reconciliation = await reconcileExecutionStateSnapshot({
      snapshotPath: fixture.snapshotPath,
      pool: fake.pool,
      config: migrationConfig,
      checkpointId: "execution-state-strategy-reconciliation-conflict"
    });

    assert.equal(reconciliation.status, "blocked");
    assert.equal(reconciliation.tableComparisons.strategy_allocations.mismatch, 1);
    assert.equal(
      reconciliation.discrepancyCategories["strategy_allocations:MISMATCH"],
      1
    );
    assert.equal(
      fake.checkpoints.find(
        (checkpoint) => checkpoint.id ===
          "execution-state-strategy-reconciliation-conflict"
      )?.status,
      "blocked"
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("accepts only proven risk-limit numeric and bigint representation equivalence", async () => {
  const fixture = await makeFixture("execution-state-risk-limit-normalization-");
  try {
    const source = await readExecutionStateSnapshot(fixture.snapshotPath);
    const sourceRiskLimit = source.rows.get("risk_limits")?.[0];
    assert.ok(sourceRiskLimit);
    const fake = createFakeExecutionStatePool();
    const numericColumns = [
      "cash_reserve_amount", "cash_reserve_ratio", "max_deployment_amount",
      "max_deployment_ratio", "max_gross_exposure", "max_net_exposure",
      "max_open_order_exposure", "max_position_notional", "max_symbol_notional"
    ];
    const target: StoredRow = {
      ...sourceRiskLimit,
      version: String(sourceRiskLimit.version)
    };
    for (const column of numericColumns) {
      if (target[column] !== null) target[column] = Number(target[column]);
    }
    fake.seed("risk_limits", target);

    const result = await backfillExecutionStateSnapshot({
      snapshotPath: fixture.snapshotPath,
      pool: fake.pool,
      config: migrationConfig,
      batchSize: 1
    });

    assert.equal(result.insertedRows.risk_limits, 0);
    assert.equal(fake.rows.get("risk_limits")?.length, 1);
    assert.equal(
      result.mutableStateDifferences["risk_limits:version"],
      undefined
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("fails closed with sanitized classifications for incompatible risk-limit rows", async () => {
  const cases: Array<{
    label: string;
    mutateSource?: (row: StoredRow) => void;
    mutateTarget: (row: StoredRow) => void;
    code: RegExp;
  }> = [
    {
      label: "account-identity",
      mutateTarget: (row) => { row.account_id = "different-account-identity"; },
      code: /EXECUTION_STATE_BACKFILL_RISK_LIMIT_CONFLICT:IDENTITY/
    },
    {
      label: "strategy-identity",
      mutateSource: (row) => {
        row.scope_type = "strategy";
        row.scope_key = "strategy-one";
      },
      mutateTarget: (row) => { row.scope_key = "strategy-two"; },
      code: /EXECUTION_STATE_BACKFILL_RISK_LIMIT_CONFLICT:IDENTITY/
    },
    {
      label: "configuration-fingerprint-collision",
      mutateTarget: (row) => { row.config_fingerprint = "contradictory-fingerprint"; },
      code: /EXECUTION_STATE_BACKFILL_RISK_LIMIT_CONFLICT:POLICY/
    },
    {
      label: "hard-cap-policy",
      mutateTarget: (row) => { row.max_position_notional = "999999.00000000"; },
      code: /EXECUTION_STATE_BACKFILL_RISK_LIMIT_CONFLICT:POLICY/
    },
    {
      label: "ratio-policy",
      mutateTarget: (row) => { row.max_deployment_ratio = "0.9999999999"; },
      code: /EXECUTION_STATE_BACKFILL_RISK_LIMIT_CONFLICT:POLICY/
    },
    {
      label: "lifecycle-status",
      mutateTarget: (row) => { row.status = "superseded"; },
      code: /EXECUTION_STATE_BACKFILL_RISK_LIMIT_CONFLICT:LIFECYCLE/
    },
    {
      label: "malformed-numeric",
      mutateTarget: (row) => { row.max_gross_exposure = "not-a-decimal"; },
      code: /EXECUTION_STATE_BACKFILL_RISK_LIMIT_CONFLICT:MALFORMED/
    },
    {
      label: "malformed-version",
      mutateTarget: (row) => { row.version = "not-an-integer"; },
      code: /EXECUTION_STATE_BACKFILL_RISK_LIMIT_CONFLICT:MALFORMED/
    },
    {
      label: "unsupported-provenance-order",
      mutateTarget: (row) => {
        row.effective_from = "2026-07-19T00:00:00.000Z";
        row.created_at = "2026-07-19T00:00:00.000Z";
        row.updated_at = "2026-07-19T00:00:00.000Z";
      },
      code: /EXECUTION_STATE_BACKFILL_RISK_LIMIT_CONFLICT:PROVENANCE_ORDER/
    }
  ];

  for (const scenario of cases) {
    const fixture = await makeFixture(`execution-state-risk-limit-${scenario.label}-`);
    try {
      const source = await readExecutionStateSnapshot(fixture.snapshotPath);
      const sourceRiskLimit = source.rows.get("risk_limits")?.[0] as StoredRow | undefined;
      assert.ok(sourceRiskLimit);
      scenario.mutateSource?.(sourceRiskLimit);
      const target = { ...sourceRiskLimit };
      scenario.mutateTarget(target);
      const fake = createFakeExecutionStatePool();
      fake.seed("risk_limits", target);

      await assert.rejects(
        () => backfillExecutionStateSnapshot({
          snapshotPath: fixture.snapshotPath,
          pool: fake.pool,
          config: migrationConfig,
          batchSize: 1
        }),
        scenario.code,
        scenario.label
      );
      assert.deepEqual(fake.rows.get("risk_limits"), [target], scenario.label);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }
});

test("fails closed on a different active risk policy in the same unique current scope", async () => {
  const fixture = await makeFixture("execution-state-risk-limit-current-scope-");
  try {
    const source = await readExecutionStateSnapshot(fixture.snapshotPath);
    const sourceRiskLimit = source.rows.get("risk_limits")?.[0];
    assert.ok(sourceRiskLimit);
    const existingCurrentPolicy = {
      ...sourceRiskLimit,
      id: "postgres-distinct-current-risk-policy",
      config_fingerprint: "postgres-distinct-current-configuration"
    };
    const fake = createFakeExecutionStatePool();
    fake.seed("risk_limits", existingCurrentPolicy);

    await assert.rejects(
      () => backfillExecutionStateSnapshot({
        snapshotPath: fixture.snapshotPath,
        pool: fake.pool,
        config: migrationConfig,
        batchSize: 1
      }),
      /EXECUTION_STATE_BACKFILL_RISK_LIMIT_CONFLICT:CURRENT_SCOPE/
    );
    assert.deepEqual(fake.rows.get("risk_limits"), [existingCurrentPolicy]);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("newer PostgreSQL risk-limit provenance cannot produce a passed reconciliation checkpoint", async () => {
  const fixture = await makeFixture("execution-state-risk-limit-newer-provenance-");
  try {
    const source = await readExecutionStateSnapshot(fixture.snapshotPath);
    const sourceRiskLimit = source.rows.get("risk_limits")?.[0];
    assert.ok(sourceRiskLimit);
    const newerTarget = {
      ...sourceRiskLimit,
      effective_from: "2026-07-19T00:00:00.000Z",
      created_at: "2026-07-19T00:00:00.000Z",
      updated_at: "2026-07-19T00:00:00.000Z"
    };
    const fake = createFakeExecutionStatePool();
    fake.seed("risk_limits", newerTarget);

    await assert.rejects(
      () => backfillExecutionStateSnapshot({
        snapshotPath: fixture.snapshotPath,
        pool: fake.pool,
        config: migrationConfig,
        batchSize: 1
      }),
      /EXECUTION_STATE_BACKFILL_RISK_LIMIT_CONFLICT:PROVENANCE_ORDER/
    );
    const reconciliation = await reconcileExecutionStateSnapshot({
      snapshotPath: fixture.snapshotPath,
      pool: fake.pool,
      config: migrationConfig,
      checkpointId: "execution-state-risk-limit-newer-provenance",
      observedAt: "2026-07-18T12:00:00.000Z"
    });
    assert.equal(reconciliation.status, "blocked");
    assert.equal(reconciliation.tableComparisons.risk_limits.mismatch, 1);
    assert.equal(reconciliation.discrepancyCategories["risk_limits:MISMATCH"], 1);
    assert.equal(
      fake.checkpoints.find(
        (checkpoint) => checkpoint.id === "execution-state-risk-limit-newer-provenance"
      )?.status,
      "blocked"
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("fails closed when a differing account head is older than the sealed source", async () => {
  const fixture = await makeFixture("execution-state-account-stale-target-");
  try {
    const source = await readExecutionStateSnapshot(fixture.snapshotPath);
    const sourceAccount = source.rows.get("accounts")?.[0];
    assert.ok(sourceAccount);
    const fake = createFakeExecutionStatePool();
    fake.seed("accounts", {
      ...sourceAccount,
      status: "ACCOUNT_RESTRICTED",
      version: 2,
      updated_at: "2020-01-01T00:00:00.000Z"
    });

    await assert.rejects(
      () => backfillExecutionStateSnapshot({
        snapshotPath: fixture.snapshotPath,
        pool: fake.pool,
        config: migrationConfig,
        batchSize: 1
      }),
      /EXECUTION_STATE_BACKFILL_STALE_IDENTITY_CONFLICT:accounts/
    );
    assert.equal(fake.rows.get("accounts")?.length, 1);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("reuses an equivalent account snapshot identity and remaps downstream foreign keys", async () => {
  const fixture = await makeFixture("execution-state-snapshot-identity-");
  try {
    const source = await readExecutionStateSnapshot(fixture.snapshotPath);
    const sourceSnapshot = source.rows.get("account_snapshots")?.[0];
    assert.ok(sourceSnapshot);
    const fake = createFakeExecutionStatePool();
    fake.seed("account_snapshots", {
      ...sourceSnapshot,
      id: "postgres-existing-account-snapshot"
    });

    const result = await backfillExecutionStateSnapshot({
      snapshotPath: fixture.snapshotPath,
      pool: fake.pool,
      config: migrationConfig,
      batchSize: 1,
      observedAt: "2026-07-18T12:00:00.000Z"
    });

    assert.equal(result.insertedRows.account_snapshots, 0);
    const snapshotReuse = result.identityReuses.find(
      (reuse) => reuse.table === "account_snapshots"
    );
    assert.ok(snapshotReuse);
    assert.deepEqual(
      {
        table: snapshotReuse.table,
        sourceId: snapshotReuse.sourceId,
        targetId: snapshotReuse.targetId,
        identityColumns: snapshotReuse.identityColumns
      },
      {
        table: "account_snapshots",
        sourceId: sourceSnapshot.id,
        targetId: "postgres-existing-account-snapshot",
        identityColumns: ["account_id", "snapshot_fingerprint"]
      }
    );
    assert.ok(fake.rows.get("portfolio_exposure")?.every(
      (row) => row.account_snapshot_id === "postgres-existing-account-snapshot"
    ));
    assert.ok(fake.rows.get("buying_power_reservations")?.every(
      (row) => row.account_snapshot_id === "postgres-existing-account-snapshot"
    ));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("reuses a portfolio snapshot when only separate market evidence and provenance differ", async () => {
  const fixture = await makeFixture("execution-state-snapshot-market-evidence-identity-");
  try {
    const source = await readExecutionStateSnapshot(fixture.snapshotPath);
    const sourceSnapshot = source.rows.get("account_snapshots")?.[0];
    assert.ok(sourceSnapshot);
    const sourceEvidence = JSON.parse(String(sourceSnapshot.evidence)) as Record<string, unknown>;
    const existingEvidence = {
      ...sourceEvidence,
      marketEvidenceFingerprint: "prior-market-evidence-fingerprint"
    };
    const fake = createFakeExecutionStatePool();
    fake.seed("account_snapshots", {
      ...sourceSnapshot,
      id: "postgres-existing-market-evidence-snapshot",
      observed_at: "2026-07-16T15:59:00.000Z",
      created_at: "2026-07-16T15:59:00.000Z",
      evidence: existingEvidence
    });

    const result = await backfillExecutionStateSnapshot({
      snapshotPath: fixture.snapshotPath,
      pool: fake.pool,
      config: migrationConfig,
      batchSize: 1,
      observedAt: "2026-07-18T12:00:00.000Z"
    });

    assert.equal(result.insertedRows.account_snapshots, 0);
    assert.ok(result.identityReuses.some((reuse) =>
      reuse.table === "account_snapshots" &&
      reuse.sourceId === sourceSnapshot.id &&
      reuse.targetId === "postgres-existing-market-evidence-snapshot"
    ));
    assert.ok(fake.rows.get("portfolio_exposure")?.every(
      (row) => row.account_snapshot_id === "postgres-existing-market-evidence-snapshot"
    ));
    assert.deepEqual(
      result.identityReuses.find((reuse) => reuse.table === "account_snapshots")
        ?.mutableDifferences,
      ["observed_at", "evidence.marketEvidenceFingerprint", "created_at"]
    );
    assert.equal(
      result.mutableStateDifferences["account_snapshots:evidence.marketEvidenceFingerprint"],
      1
    );
    assert.deepEqual(
      (fake.rows.get("account_snapshots") ?? []).find(
        (row) => row.id === "postgres-existing-market-evidence-snapshot"
      )?.evidence,
      existingEvidence
    );

    const replay = await backfillExecutionStateSnapshot({
      snapshotPath: fixture.snapshotPath,
      pool: fake.pool,
      config: migrationConfig,
      batchSize: 1,
      observedAt: "2026-07-18T12:00:00.000Z"
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.mutationCount, 0);
    assert.equal(fake.rows.get("account_snapshots")?.length, 1);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("accepts equivalent account snapshot numeric and timestamp representations", async () => {
  const fixture = await makeFixture("execution-state-snapshot-normalization-");
  try {
    const source = await readExecutionStateSnapshot(fixture.snapshotPath);
    const sourceSnapshot = source.rows.get("account_snapshots")?.[0];
    assert.ok(sourceSnapshot);
    const fake = createFakeExecutionStatePool();
    fake.seed("account_snapshots", {
      ...sourceSnapshot,
      id: "postgres-normalized-account-snapshot",
      observed_at: "2026-07-16T12:00:00-04:00",
      created_at: "2026-07-16T12:00:00-04:00",
      cash: Number(sourceSnapshot.cash),
      portfolio_value: Number(sourceSnapshot.portfolio_value),
      equity: Number(sourceSnapshot.equity),
      buying_power: Number(sourceSnapshot.buying_power),
      options_buying_power: Number(sourceSnapshot.options_buying_power)
    });

    const result = await backfillExecutionStateSnapshot({
      snapshotPath: fixture.snapshotPath,
      pool: fake.pool,
      config: migrationConfig,
      batchSize: 1
    });

    assert.equal(result.insertedRows.account_snapshots, 0);
    assert.ok(result.identityReuses.some((reuse) =>
      reuse.table === "account_snapshots" &&
      reuse.targetId === "postgres-normalized-account-snapshot"
    ));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("fails closed on an account snapshot fingerprint collision outside market evidence", async () => {
  const fixture = await makeFixture("execution-state-snapshot-evidence-mismatch-");
  try {
    const source = await readExecutionStateSnapshot(fixture.snapshotPath);
    const sourceSnapshot = source.rows.get("account_snapshots")?.[0];
    assert.ok(sourceSnapshot);
    const sourceEvidence = JSON.parse(String(sourceSnapshot.evidence)) as Record<string, unknown>;
    const fake = createFakeExecutionStatePool();
    fake.seed("account_snapshots", {
      ...sourceSnapshot,
      id: "postgres-conflicting-snapshot-evidence",
      evidence: {
        ...sourceEvidence,
        structuralPortfolioFingerprint: "contradictory-structural-fingerprint"
      }
    });

    await assert.rejects(
      () => backfillExecutionStateSnapshot({
        snapshotPath: fixture.snapshotPath,
        pool: fake.pool,
        config: migrationConfig,
        batchSize: 1
      }),
      /EXECUTION_STATE_BACKFILL_IDENTITY_CONFLICT:account_snapshots/
    );
    assert.equal(fake.rows.get("account_snapshots")?.length, 1);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("fails closed when market evidence fingerprint is missing, empty, or malformed", async () => {
  for (const [label, value] of [
    ["missing", undefined],
    ["empty", ""],
    ["malformed", 42]
  ] as const) {
    const fixture = await makeFixture(`execution-state-snapshot-market-evidence-${label}-`);
    try {
      const source = await readExecutionStateSnapshot(fixture.snapshotPath);
      const sourceSnapshot = source.rows.get("account_snapshots")?.[0];
      assert.ok(sourceSnapshot);
      const sourceEvidence = JSON.parse(String(sourceSnapshot.evidence)) as Record<string, unknown>;
      const existingEvidence = { ...sourceEvidence };
      if (value === undefined) delete existingEvidence.marketEvidenceFingerprint;
      else existingEvidence.marketEvidenceFingerprint = value;
      const fake = createFakeExecutionStatePool();
      fake.seed("account_snapshots", {
        ...sourceSnapshot,
        id: `postgres-${label}-market-evidence-snapshot`,
        evidence: existingEvidence
      });

      await assert.rejects(
        () => backfillExecutionStateSnapshot({
          snapshotPath: fixture.snapshotPath,
          pool: fake.pool,
          config: migrationConfig,
          batchSize: 1
        }),
        /EXECUTION_STATE_BACKFILL_IDENTITY_CONFLICT:account_snapshots/
      );
      assert.equal(fake.rows.get("account_snapshots")?.length, 1);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }
});

test("reuses an equivalent reservation identity, preserves the existing row, and classifies mutable state", async () => {
  const fixture = await makeFixture("execution-state-reservation-identity-");
  try {
    const source = await readExecutionStateSnapshot(fixture.snapshotPath);
    const sourceReservation = source.rows.get("buying_power_reservations")?.[0];
    assert.ok(sourceReservation);
    const fake = createFakeExecutionStatePool();
    fake.seed("buying_power_reservations", {
      ...sourceReservation,
      id: "postgres-existing-reservation",
      updated_at: "2026-07-16T16:06:01.000Z"
    });

    const result = await backfillExecutionStateSnapshot({
      snapshotPath: fixture.snapshotPath,
      pool: fake.pool,
      config: migrationConfig,
      batchSize: 1,
      observedAt: "2026-07-18T12:00:00.000Z"
    });

    assert.equal(result.insertedRows.buying_power_reservations, 0);
    assert.ok(result.identityReuses.some((reuse) =>
      reuse.table === "buying_power_reservations" &&
      reuse.sourceId === sourceReservation.id &&
      reuse.targetId === "postgres-existing-reservation"
    ));
    assert.equal(
      fake.rows.get("order_intents")?.[0]?.reservation_id,
      "postgres-existing-reservation"
    );
    assert.equal(
      result.mutableStateDifferences["buying_power_reservations:updated_at"],
      1
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("fails closed when an existing identity has a material mismatch", async () => {
  const fixture = await makeFixture("execution-state-identity-mismatch-");
  try {
    const source = await readExecutionStateSnapshot(fixture.snapshotPath);
    const sourceReservation = source.rows.get("buying_power_reservations")?.[0];
    assert.ok(sourceReservation);
    const fake = createFakeExecutionStatePool();
    fake.seed("buying_power_reservations", {
      ...sourceReservation,
      id: "postgres-conflicting-reservation",
      amount: "9999.00000000"
    });

    await assert.rejects(
      () => backfillExecutionStateSnapshot({
        snapshotPath: fixture.snapshotPath,
        pool: fake.pool,
        config: migrationConfig,
        batchSize: 1
      }),
      /EXECUTION_STATE_BACKFILL_IDENTITY_CONFLICT:buying_power_reservations/
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("reconciliation classifies mutable differences and preserves PostgreSQL-only authority rows", async () => {
  const fixture = await makeFixture("execution-state-reconciliation-classification-");
  try {
    const source = await readExecutionStateSnapshot(fixture.snapshotPath);
    const sourceReservation = source.rows.get("buying_power_reservations")?.[0];
    const sourceOrder = source.rows.get("orders")?.[0];
    assert.ok(sourceReservation);
    assert.ok(sourceOrder);
    const fake = createFakeExecutionStatePool();
    fake.seed("buying_power_reservations", {
      ...sourceReservation,
      id: "postgres-existing-reservation",
      updated_at: "2026-07-16T16:06:01.000Z"
    });

    await backfillExecutionStateSnapshot({
      snapshotPath: fixture.snapshotPath,
      pool: fake.pool,
      config: migrationConfig,
      batchSize: 1,
      observedAt: "2026-07-18T12:00:00.000Z"
    });
    fake.seed("orders", {
      ...sourceOrder,
      id: "postgres-authority-only-order",
      updated_at: "2026-07-17T19:00:00.000Z"
    });

    const first = await reconcileExecutionStateSnapshot({
      snapshotPath: fixture.snapshotPath,
      pool: fake.pool,
      config: migrationConfig,
      checkpointId: "execution-state-classification-test",
      observedAt: "2026-07-18T12:00:00.000Z"
    });
    assert.equal(first.status, "passed");
    assert.equal(first.discrepancyCount, 0);
    assert.equal(first.tableComparisons.orders.authorityOnly, 1);
    assert.equal(first.tableComparisons.orders.unexpected, 0);
    assert.equal(first.classifiedStateDifferences["buying_power_reservations:updated_at"], 1);
    assert.equal(first.authorityOnlyRows.orders, 1);
    assert.equal(first.checkpointMutationCount, 1);
    assert.equal(
      fake.checkpoints.find(
        (checkpoint) => checkpoint.id === "execution-state-classification-test"
      )?.status,
      "passed"
    );

    const replay = await reconcileExecutionStateSnapshot({
      snapshotPath: fixture.snapshotPath,
      pool: fake.pool,
      config: migrationConfig,
      checkpointId: "execution-state-classification-test",
      observedAt: "2026-07-18T12:00:00.000Z"
    });
    assert.equal(replay.status, "passed");
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.mutationCount, 0);

    const authorityOnlyOrder = fake.rows.get("orders")?.find(
      (row) => row.id === "postgres-authority-only-order"
    );
    assert.ok(authorityOnlyOrder);
    authorityOnlyOrder.updated_at = "2026-07-15T19:00:00.000Z";
    authorityOnlyOrder.created_at = "2026-07-15T19:00:00.000Z";
    const unexplained = await reconcileExecutionStateSnapshot({
      snapshotPath: fixture.snapshotPath,
      pool: fake.pool,
      config: migrationConfig,
      checkpointId: "execution-state-unexplained-target-test",
      observedAt: "2026-07-18T12:00:00.000Z"
    });
    assert.equal(unexplained.status, "blocked");
    assert.equal(unexplained.discrepancyCategories["orders:UNEXPECTED"], 1);
    assert.equal(
      fake.checkpoints.find(
        (checkpoint) => checkpoint.id === "execution-state-unexplained-target-test"
      )?.status,
      "blocked"
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a PostgreSQL failure before reconciliation checkpoint persistence cannot count as success", async () => {
  const fixture = await makeFixture("execution-state-checkpoint-connection-failure-");
  try {
    const fake = createFakeExecutionStatePool();
    await backfillExecutionStateSnapshot({
      snapshotPath: fixture.snapshotPath,
      pool: fake.pool,
      config: migrationConfig,
      batchSize: 1,
      observedAt: "2026-07-18T12:00:00.000Z"
    });
    const baseClient = await fake.pool.connect();
    const originalQuery = baseClient.query.bind(baseClient) as (
      sql: string,
      values?: readonly unknown[]
    ) => Promise<QueryResult>;
    let checkpointFailureInjected = false;
    const failingClient = {
      query: async (sql: string, values: readonly unknown[] = []) => {
        if (
          !checkpointFailureInjected &&
          compact(sql).startsWith("INSERT INTO reconciliation_checkpoints")
        ) {
          checkpointFailureInjected = true;
          const error = new Error(
            "synthetic connection terminated before checkpoint persistence"
          ) as Error & { code?: string };
          error.code = "08006";
          throw error;
        }
        return originalQuery(sql, values);
      },
      release: () => undefined
    } as unknown as PoolClient;
    const failingPool = {
      connect: async () => failingClient
    } as unknown as Pool;

    await assert.rejects(
      () => reconcileExecutionStateSnapshot({
        snapshotPath: fixture.snapshotPath,
        pool: failingPool,
        config: migrationConfig,
        checkpointId: "execution-state-connection-failure",
        observedAt: "2026-07-18T12:00:00.000Z"
      }),
      /connection terminated before checkpoint persistence/
    );
    assert.equal(checkpointFailureInjected, true);
    assert.equal(
      fake.checkpoints.some(
        (checkpoint) => checkpoint.id === "execution-state-connection-failure"
      ),
      false
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
