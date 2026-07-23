import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "alpaca-sqlite-wal-compatibility-"));
const scriptPath = join(process.cwd(), "scripts", "verify-sqlite-wal-compatibility.mjs");

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const checksum = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const createSourceDatabase = (name: string) => {
  const source = join(root, `${name}-source.db`);
  const db = new DatabaseSync(source);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`
      CREATE TABLE parent(id INTEGER PRIMARY KEY);
      CREATE TABLE child(
        id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES parent(id)
      );
      INSERT INTO parent(id) VALUES (1);
      INSERT INTO child(id, parent_id) VALUES (1, 1);
    `);
  } finally {
    db.close();
  }
  return source;
};

const runVerifier = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });

describe("SQLite WAL compatibility verifier", () => {
  test("refuses missing or in-place source and copy paths", async () => {
    const source = createSourceDatabase("refusal");

    const missingCopy = await runVerifier(["--source", source]);
    assert.equal(missingCopy.code, 1);
    assert.match(missingCopy.stderr, /--source and --copy are required/);
    assert.equal(missingCopy.stdout, "");

    const samePath = await runVerifier(["--source", source, "--copy", source]);
    assert.equal(samePath.code, 1);
    assert.match(samePath.stderr, /distinct paths/);
    assert.equal(samePath.stdout, "");
  });

  test("rejects a source with active WAL state instead of copying a stale main file", async () => {
    const source = createSourceDatabase("active-wal");
    const copy = join(root, "active-wal-copy.db");
    const writer = new DatabaseSync(source);
    try {
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
      writer.exec("CREATE TABLE committed_in_wal(id INTEGER PRIMARY KEY)");
      writer.exec("INSERT INTO committed_in_wal(id) VALUES (1)");
      assert.equal(existsSync(`${source}-wal`), true);

      const result = await runVerifier(["--source", source, "--copy", copy]);

      assert.equal(result.code, 1);
      assert.match(result.stderr, /WAL_COMPATIBILITY_CHECK_FAILED/);
      assert.equal(result.stdout, "");
      assert.equal(existsSync(copy), false);
    } finally {
      writer.close();
    }
  });

  test("the public verifier rejects forged child mode without mutating the database", async () => {
    const source = createSourceDatabase("child-capability");
    const setup = new DatabaseSync(source);
    setup.exec(`
      CREATE TABLE wal_compatibility_probe (
        id TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      )
    `);
    setup.close();
    const sourceChecksumBefore = checksum(source);
    const forgedCapability = "f".repeat(64);

    const result = await runVerifier([
      "--child-terminate",
      "--database",
      source,
      "--mode",
      "committed-uncheckpointed",
      "--capability",
      forgedCapability
    ], {
      ...process.env,
      SQLITE_WAL_CHILD_CAPABILITY: forgedCapability
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /--source and --copy are required/);
    assert.equal(result.stdout, "");
    assert.equal(checksum(source), sourceChecksumBefore);
    const verified = new DatabaseSync(source, { readOnly: true });
    try {
      assert.equal(
        (verified
          .prepare("SELECT COUNT(*) AS count FROM wal_compatibility_probe")
          .get() as { count: number }).count,
        0
      );
    } finally {
      verified.close();
    }
  });

  test("preserves the source checksum while verifying a copied database", async () => {
    const source = createSourceDatabase("preservation");
    const copy = join(root, "preservation-copy.db");
    const sourceChecksumBefore = checksum(source);

    const result = await runVerifier(["--source", source, "--copy", copy]);

    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(report.sourceChecksumMatchBeforeMutation, true);
    assert.equal(report.copyChecksumMatchesSourceBeforeMutation, true);
    assert.equal(report.sourceChecksumPreserved, true);
    assert.equal(checksum(source), sourceChecksumBefore);
    assert.notEqual(checksum(copy), sourceChecksumBefore);
  });

  test("reports SIGKILL recovery plus WAL durability and latency evidence without row data", async () => {
    const source = createSourceDatabase("success");
    const copy = join(root, "success-copy.db");

    const result = await runVerifier(["--source", source, "--copy", copy]);

    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(report).sort(), [
      "backupCompleted",
      "backupPageCount",
      "checkpointCompleted",
      "checkpointLatencyMs",
      "committedChildHadUncheckpointedWal",
      "committedUncheckpointedSigkillSurvived",
      "concurrentReaderObservedWriter",
      "copyChecksumMatchesSourceBeforeMutation",
      "copyLatencyMs",
      "foreignKeyCheckPassed",
      "foreignKeyViolationCount",
      "fullSynchronousCommitCompleted",
      "fullSynchronousCommitLatencyMs",
      "integrityCheckPassed",
      "journalModeAfter",
      "journalModeBefore",
      "ok",
      "sourceChecksumMatchBeforeMutation",
      "sourceChecksumPreserved",
      "synchronousMode",
      "terminationRecoveryCompleted",
      "uncommittedSigkillRolledBack",
      "verificationLatencyMs",
      "walActive",
      "walSidecarsCreated"
    ]);
    for (const key of [
      "ok",
      "sourceChecksumMatchBeforeMutation",
      "copyChecksumMatchesSourceBeforeMutation",
      "sourceChecksumPreserved",
      "walActive",
      "walSidecarsCreated",
      "checkpointCompleted",
      "concurrentReaderObservedWriter",
      "backupCompleted",
      "terminationRecoveryCompleted",
      "uncommittedSigkillRolledBack",
      "committedChildHadUncheckpointedWal",
      "committedUncheckpointedSigkillSurvived",
      "fullSynchronousCommitCompleted",
      "integrityCheckPassed",
      "foreignKeyCheckPassed"
    ]) {
      assert.equal(report[key], true, key);
    }
    assert.equal(report.journalModeBefore, "delete");
    assert.equal(report.journalModeAfter, "wal");
    assert.equal(report.synchronousMode, "full");
    for (const key of [
      "backupPageCount",
      "foreignKeyViolationCount",
      "copyLatencyMs",
      "fullSynchronousCommitLatencyMs",
      "checkpointLatencyMs",
      "verificationLatencyMs"
    ]) {
      assert.equal(typeof report[key], "number", key);
      assert.ok((report[key] as number) >= 0, key);
    }
    const verifiedCopy = new DatabaseSync(copy, { readOnly: true });
    try {
      assert.equal(
        (verifiedCopy
          .prepare("SELECT COUNT(*) AS count FROM wal_compatibility_probe WHERE id = ?")
          .get("child_uncommitted") as { count: number }).count,
        0
      );
      assert.equal(
        (verifiedCopy
          .prepare("SELECT COUNT(*) AS count FROM wal_compatibility_probe WHERE id = ?")
          .get("child_committed") as { count: number }).count,
        1
      );
    } finally {
      verifiedCopy.close();
    }
    assert.doesNotMatch(result.stdout, /parent_id|INSERT INTO|child_uncommitted|child_committed/i);
  });
});
