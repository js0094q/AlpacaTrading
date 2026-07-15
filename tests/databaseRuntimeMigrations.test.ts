import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, test } from "node:test";

import {
  DatabaseMigrationRequiredError,
  REQUIRED_RUNTIME_MIGRATION_VERSIONS,
  closeDbForTests,
  getDb,
  initializeDatabaseHandle,
  initializeRuntimeDatabaseHandle
} from "../src/lib/db.js";
import { runMigrationGroup } from "../src/lib/sqliteMigrations.js";
import {
  verifyDatabaseFile,
  verifyDatabaseSchema
} from "../src/services/databaseMaintenanceService.js";

const root = mkdtempSync(join(tmpdir(), "alpaca-runtime-migrations-"));

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const databasePath = (name: string) => join(root, `${name}.db`);

const appliedRows = (db: DatabaseSync) =>
  db
    .prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: string; applied_at: string }>;

const spawnMigration = (path: string) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "tests/helpers/runDatabaseMigration.ts", path],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

describe("runtime database migration boundary", () => {
  test("ordinary startup does not create a missing database file", () => {
    const path = databasePath("missing-runtime");
    const previousPath = process.env.RESEARCH_DB_PATH;
    const testFixtureFlag = Symbol.for("alpaca.sqlite.test-fixture-initialization");
    const globalState = globalThis as typeof globalThis & { [key: symbol]: unknown };
    const previousTestFixtureFlag = globalState[testFixtureFlag];
    closeDbForTests();
    process.env.RESEARCH_DB_PATH = path;
    delete globalState[testFixtureFlag];
    try {
      assert.throws(
        () => getDb(),
        (error) =>
          error instanceof DatabaseMigrationRequiredError &&
          error.pendingVersions.length === REQUIRED_RUNTIME_MIGRATION_VERSIONS.length
      );
      assert.equal(existsSync(path), false);
    } finally {
      closeDbForTests();
      if (previousPath === undefined) delete process.env.RESEARCH_DB_PATH;
      else process.env.RESEARCH_DB_PATH = previousPath;
      if (previousTestFixtureFlag === undefined) delete globalState[testFixtureFlag];
      else globalState[testFixtureFlag] = previousTestFixtureFlag;
    }
  });

  test("an empty runtime database fails closed without creating schema", () => {
    const db = new DatabaseSync(databasePath("empty-runtime"));

    assert.throws(
      () => initializeRuntimeDatabaseHandle(db),
      (error) =>
        error instanceof DatabaseMigrationRequiredError &&
        error.code === "DATABASE_MIGRATION_REQUIRED" &&
        error.pendingVersions.length === REQUIRED_RUNTIME_MIGRATION_VERSIONS.length
    );
    assert.equal(
      (db
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type IN ('table', 'index', 'trigger', 'view')"
        )
        .get() as { count: number }).count,
      0
    );
    db.close();
  });

  test("a current database performs no write transaction during runtime or migration checks", () => {
    const db = new DatabaseSync(databasePath("current-read-only"));
    initializeDatabaseHandle(db);
    const before = appliedRows(db);

    db.exec("PRAGMA query_only = ON");
    assert.doesNotThrow(() => initializeRuntimeDatabaseHandle(db));
    assert.doesNotThrow(() => initializeDatabaseHandle(db));
    assert.deepEqual(appliedRows(db), before);
    db.close();
  });

  test("read-only runtime initialization succeeds while another connection holds a writer reservation", () => {
    const path = databasePath("writer-overlap");
    const setup = new DatabaseSync(path);
    initializeDatabaseHandle(setup);
    setup.close();

    const writer = new DatabaseSync(path);
    const runtime = new DatabaseSync(path);
    runtime.exec("PRAGMA busy_timeout = 10");
    writer.exec("BEGIN IMMEDIATE");
    try {
      assert.doesNotThrow(() => initializeRuntimeDatabaseHandle(runtime));
    } finally {
      writer.exec("ROLLBACK");
      runtime.close();
      writer.close();
    }
  });

  test("concurrent first starters apply each required migration once and the losing starter exits cleanly", async () => {
    const path = databasePath("concurrent-first-start");
    const [first, second] = await Promise.all([spawnMigration(path), spawnMigration(path)]);

    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(JSON.parse(first.stdout), { ok: true });
    assert.deepEqual(JSON.parse(second.stdout), { ok: true });

    const db = new DatabaseSync(path, { readOnly: true });
    const versions = appliedRows(db).map((row) => row.version);
    for (const version of REQUIRED_RUNTIME_MIGRATION_VERSIONS) {
      assert.equal(versions.filter((candidate) => candidate === version).length, 1);
    }
    db.close();
  });

  test("failed migration work rolls back without recording the version", () => {
    const db = new DatabaseSync(databasePath("rollback"));
    runMigrationGroup(db, ["test-prerequisite"], () => undefined);
    assert.throws(
      () =>
        runMigrationGroup(db, ["test-failed-migration"], () => {
          db.exec("CREATE TABLE rollback_probe(id TEXT PRIMARY KEY)");
          throw new Error("forced migration failure");
        }),
      /forced migration failure/
    );

    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'rollback_probe'")
        .get()!.count,
      0
    );
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 'test-failed-migration'")
        .get()!.count,
      0
    );
    db.close();
  });

  test("existing databases with pending migrations fail closed at runtime", () => {
    const db = new DatabaseSync(databasePath("pending-runtime"));
    db.exec("CREATE TABLE legacy_data(id TEXT PRIMARY KEY)");

    assert.throws(
      () => initializeRuntimeDatabaseHandle(db),
      (error) =>
        error instanceof DatabaseMigrationRequiredError &&
        error.code === "DATABASE_MIGRATION_REQUIRED" &&
        error.pendingVersions.length > 0
    );
    db.close();
  });

  test("the migrated production schema passes explicit verification", () => {
    const path = databasePath("verification");
    const db = new DatabaseSync(path);
    initializeDatabaseHandle(db);

    const result = verifyDatabaseSchema({ db, databasePath: path });
    assert.equal(result.ok, true);
    assert.deepEqual(result.pendingMigrations, []);
    assert.deepEqual(result.foreignKeyViolations, []);
    assert.equal(result.pragmas.integrityCheck, "ok");
    db.close();
  });

  test("file verification reports the same bounded connection PRAGMAs as runtime", () => {
    const path = databasePath("file-verification-pragmas");
    const db = new DatabaseSync(path);
    initializeDatabaseHandle(db);
    db.close();

    const result = verifyDatabaseFile(path);
    assert.equal(result.pragmas.busyTimeout, 5_000);
    assert.equal(result.pragmas.foreignKeys, 1);
  });
});
