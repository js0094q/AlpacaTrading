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

const makeFixture = async (prefix: string) => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const snapshotPath = join(directory, "source.db");
  createExecutionStateSnapshotFixture(snapshotPath);
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
    const riskLimit = fake.rows.get("risk_limits")?.[0];
    assert.ok(riskLimit);
    riskLimit.status = "revised";
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
    assert.equal(first.classifiedStateDifferences["risk_limits:status"], 1);
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
