import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Pool, PoolClient, QueryResult } from "pg";

import type { DatabaseConfig } from "../src/lib/database/config.js";
import {
  getPostgresMigrationStatus,
  listPostgresMigrations,
  runPostgresMigrations
} from "../src/lib/database/postgresMigrations.js";

const config: DatabaseConfig = {
  backend: "postgres",
  runtime: "test",
  purpose: "migration",
  directUrl: "postgresql://synthetic:synthetic@host.invalid/db",
  directVariable: "DATABASE_URL_UNPOOLED",
  sslRequired: true,
  applicationName: "migration-test",
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
    executionStateAuthority: false,
    sqliteAuditMirror: false
  }
};

const migrationDirectory = async (sql = "CREATE TABLE release_two_test (id uuid PRIMARY KEY);") => {
  const directory = await mkdtemp(join(tmpdir(), "postgres-migrations-"));
  await writeFile(join(directory, "001_initial.sql"), sql, "utf8");
  return directory;
};

const fakePool = (options: { failMigration?: boolean; failUnlock?: boolean } = {}) => {
  const applied = new Map<number, { name: string; checksum: string }>();
  const queries: string[] = [];
  let releases = 0;
  let migrationExecutions = 0;
  const client = {
    query: async (text: string, values?: unknown[]) => {
      queries.push(text);
      if (text.includes("pg_advisory_unlock") && options.failUnlock) {
        throw new Error("forced unlock failure");
      }
      if (text.includes("FROM schema_migrations") && text.includes("ORDER BY version")) {
        return {
          rows: [...applied.entries()].map(([version, value]) => ({ version, ...value })),
          rowCount: applied.size
        } as unknown as QueryResult;
      }
      if (text.startsWith("INSERT INTO schema_migrations")) {
        const [version, name, checksum] = values as [number, string, string];
        applied.set(version, { name, checksum });
      }
      if (text.includes("CREATE TABLE release_two_test")) {
        migrationExecutions += 1;
        if (options.failMigration) throw new Error("forced migration failure");
      }
      return { rows: [], rowCount: 0 } as unknown as QueryResult;
    },
    release: () => {
      releases += 1;
    }
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  return {
    pool,
    applied,
    queries,
    releases: () => releases,
    migrationExecutions: () => migrationExecutions
  };
};

test("discovers ordered, checksummed PostgreSQL migrations", async () => {
  const directory = await migrationDirectory();
  try {
    await writeFile(join(directory, "002_more.sql"), "SELECT 2;", "utf8");
    const migrations = await listPostgresMigrations(directory);
    assert.deepEqual(migrations.map((entry) => entry.version), [1, 2]);
    assert.deepEqual(migrations.map((entry) => entry.name), ["initial", "more"]);
    assert.match(migrations[0]!.checksum, /^[a-f0-9]{64}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("applies a migration exactly once and reports the second run as idempotent", async () => {
  const directory = await migrationDirectory();
  const fake = fakePool();
  try {
    const first = await runPostgresMigrations(fake.pool, config, { directory });
    const second = await runPostgresMigrations(fake.pool, config, { directory });
    assert.deepEqual(first.appliedVersions, [1]);
    assert.deepEqual(second.appliedVersions, []);
    assert.deepEqual(second.currentVersions, [1]);
    assert.equal(fake.migrationExecutions(), 1);
    assert.equal(fake.releases(), 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects an edited migration whose recorded checksum no longer matches", async () => {
  const directory = await migrationDirectory();
  const fake = fakePool();
  try {
    await runPostgresMigrations(fake.pool, config, { directory });
    await writeFile(join(directory, "001_initial.sql"), "SELECT 99;", "utf8");
    await assert.rejects(
      () => runPostgresMigrations(fake.pool, config, { directory }),
      /POSTGRES_MIGRATION_CHECKSUM_MISMATCH/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rolls back a failed migration and does not record it", async () => {
  const directory = await migrationDirectory();
  const fake = fakePool({ failMigration: true });
  try {
    await assert.rejects(
      () => runPostgresMigrations(fake.pool, config, { directory }),
      /forced migration failure/
    );
    assert.equal(fake.queries.at(-2), "ROLLBACK");
    assert.match(fake.queries.at(-1) || "", /pg_advisory_unlock/);
    assert.equal(fake.applied.size, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves both migration and advisory-unlock failures", async () => {
  const directory = await migrationDirectory();
  const fake = fakePool({ failMigration: true, failUnlock: true });
  try {
    await assert.rejects(
      () => runPostgresMigrations(fake.pool, config, { directory }),
      (error) =>
        error instanceof AggregateError &&
        error.errors.some((item) => item instanceof Error && /migration failure/.test(item.message)) &&
        error.errors.some((item) => item instanceof Error && /unlock failure/.test(item.message))
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("status and migration reject applied versions missing from the local release", async () => {
  const directory = await migrationDirectory();
  const fake = fakePool();
  fake.applied.set(2, { name: "future_release", checksum: "a".repeat(64) });
  try {
    const status = await getPostgresMigrationStatus(fake.pool, { directory });
    assert.deepEqual(status.unexpectedAppliedVersions, [2]);
    await assert.rejects(
      () => runPostgresMigrations(fake.pool, config, { directory }),
      /POSTGRES_MIGRATION_VERSION_UNKNOWN:2/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
