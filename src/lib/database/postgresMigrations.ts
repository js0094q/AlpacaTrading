import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

import type { DatabaseConfig } from "./config.js";
import {
  PostgresTransactionRollbackError,
  withCheckedOutPostgresTransaction
} from "./postgresTransaction.js";

const MIGRATION_LOCK_KEY = "7141502230001";
const defaultMigrationDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations"
);

export type PostgresMigration = {
  version: number;
  name: string;
  path: string;
  checksum: string;
  sql: string;
};

export type AppliedPostgresMigration = {
  version: number;
  name: string;
  checksum: string;
  appliedAt?: string;
};

export type PostgresMigrationRunResult = {
  appliedVersions: number[];
  currentVersions: number[];
  latestVersion: number | null;
};

const migrationPattern = /^(\d{3,})_([a-z0-9][a-z0-9_-]*)\.sql$/;

export const listPostgresMigrations = async (
  directory = defaultMigrationDirectory
): Promise<PostgresMigration[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const migrations = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && migrationPattern.test(entry.name))
      .map(async (entry) => {
        const match = migrationPattern.exec(entry.name)!;
        const version = Number.parseInt(match[1]!, 10);
        const path = join(directory, entry.name);
        const sql = await readFile(path, "utf8");
        return {
          version,
          name: match[2]!,
          path,
          checksum: createHash("sha256").update(sql).digest("hex"),
          sql
        };
      })
  );
  migrations.sort((left, right) => left.version - right.version);
  const duplicateVersion = migrations.find(
    (migration, index) => index > 0 && migrations[index - 1]!.version === migration.version
  );
  if (duplicateVersion) {
    throw new Error(`POSTGRES_MIGRATION_VERSION_DUPLICATE:${duplicateVersion.version}`);
  }
  return migrations;
};

const ensureMigrationLedger = async (poolClient: PoolClient) => {
  await poolClient.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
};

const readAppliedMigrations = async (
  poolClient: PoolClient
): Promise<AppliedPostgresMigration[]> => {
  const result = await poolClient.query<{
    version: number | string;
    name: string;
    checksum: string;
    applied_at?: Date | string;
  }>(`
    SELECT version, name, checksum, applied_at
    FROM schema_migrations
    ORDER BY version
  `);
  return result.rows.map((row) => ({
    version: Number(row.version),
    name: row.name,
    checksum: row.checksum.trim(),
    ...(row.applied_at ? { appliedAt: new Date(row.applied_at).toISOString() } : {})
  }));
};

export const getPostgresMigrationStatus = async (
  pool: Pool,
  options: { directory?: string } = {}
) => {
  const migrations = await listPostgresMigrations(options.directory);
  const client = await pool.connect();
  try {
    let applied: AppliedPostgresMigration[];
    try {
      applied = await readAppliedMigrations(client);
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "42P01") throw error;
      applied = [];
    }
    const appliedByVersion = new Map(applied.map((entry) => [entry.version, entry]));
    const availableByVersion = new Map(migrations.map((entry) => [entry.version, entry]));
    return {
      latestAvailableVersion: migrations.at(-1)?.version ?? null,
      latestAppliedVersion: applied.at(-1)?.version ?? null,
      applied,
      pending: migrations
        .filter((migration) => !appliedByVersion.has(migration.version))
        .map(({ version, name, checksum }) => ({ version, name, checksum })),
      checksumMismatches: migrations
        .filter((migration) => {
          const recorded = appliedByVersion.get(migration.version);
          return recorded !== undefined &&
            (recorded.checksum !== migration.checksum || recorded.name !== migration.name);
        })
        .map((migration) => migration.version),
      unexpectedAppliedVersions: applied
        .filter((migration) => !availableByVersion.has(migration.version))
        .map((migration) => migration.version)
    };
  } finally {
    client.release();
  }
};

export const runPostgresMigrations = async (
  pool: Pool,
  config: DatabaseConfig,
  options: { directory?: string } = {}
): Promise<PostgresMigrationRunResult> => {
  if (config.purpose !== "migration") {
    throw new Error("POSTGRES_MIGRATION_PURPOSE_REQUIRED");
  }
  const migrations = await listPostgresMigrations(options.directory);
  const client = await pool.connect();
  const appliedVersions: number[] = [];
  let lockAcquired = false;
  let primaryError: unknown;
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_KEY]);
    lockAcquired = true;
    await ensureMigrationLedger(client);
    const applied = await readAppliedMigrations(client);
    const appliedByVersion = new Map(applied.map((entry) => [entry.version, entry]));
    const availableVersions = new Set(migrations.map((entry) => entry.version));
    const unexpectedAppliedVersions = applied
      .filter((entry) => !availableVersions.has(entry.version))
      .map((entry) => entry.version);
    if (unexpectedAppliedVersions.length > 0) {
      throw new Error(
        `POSTGRES_MIGRATION_VERSION_UNKNOWN:${unexpectedAppliedVersions.join(",")}`
      );
    }

    for (const migration of migrations) {
      const recorded = appliedByVersion.get(migration.version);
      if (recorded) {
        if (recorded.checksum !== migration.checksum || recorded.name !== migration.name) {
          throw new Error(`POSTGRES_MIGRATION_CHECKSUM_MISMATCH:${migration.version}`);
        }
        continue;
      }
      await withCheckedOutPostgresTransaction(
        client,
        config,
        async (transactionClient) => {
          await transactionClient.query(migration.sql);
          await transactionClient.query(
            `INSERT INTO schema_migrations (version, name, checksum)
             VALUES ($1, $2, $3)`,
            [migration.version, migration.name, migration.checksum]
          );
        }
      );
      appliedVersions.push(migration.version);
      appliedByVersion.set(migration.version, {
        version: migration.version,
        name: migration.name,
        checksum: migration.checksum
      });
    }

    const currentVersions = [...appliedByVersion.keys()].sort((left, right) => left - right);
    return {
      appliedVersions,
      currentVersions,
      latestVersion: currentVersions.at(-1) ?? null
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let unlockError: unknown;
    if (lockAcquired) {
      try {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_KEY]);
      } catch (error) {
        unlockError = error;
      }
    }
    const discardError = unlockError instanceof Error
      ? unlockError
      : primaryError instanceof PostgresTransactionRollbackError
        ? primaryError
        : unlockError !== undefined
          ? true
          : undefined;
    client.release(discardError);
    if (unlockError !== undefined) {
      if (primaryError !== undefined) {
        throw new AggregateError(
          [primaryError, unlockError],
          "PostgreSQL migration and advisory unlock both failed."
        );
      }
      throw unlockError;
    }
  }
};
