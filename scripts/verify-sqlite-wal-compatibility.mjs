#!/usr/bin/env node

import { fork } from "node:child_process";
import { COPYFILE_EXCL } from "node:constants";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync
} from "node:fs";
import { dirname, basename, join, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

const terminationWorkerPath = new URL(
  "./internal/sqlite-wal-termination-worker.mjs",
  import.meta.url
);

const checksum = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

const optionValue = (args, name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const fail = (code) => {
  process.stderr.write(`verification failed: ${code}\n`);
  process.exitCode = 1;
};

const getPragmaValue = (db, pragma, key) => {
  const row = db.prepare(`PRAGMA ${pragma}`).get();
  return row?.[key];
};

const synchronousModeName = (value) => ({
  0: "off",
  1: "normal",
  2: "full",
  3: "extra"
})[Number(value)] || "unknown";

const waitForSigkill = (databasePath, mode, beforeKill = () => true) =>
  new Promise((resolve, reject) => {
    const capability = randomBytes(32).toString("hex");
    const child = fork(
      terminationWorkerPath,
      [],
      {
        env: { ...process.env, SQLITE_WAL_CHILD_CAPABILITY: capability },
        execArgv: [],
        stdio: ["ignore", "ignore", "ignore", "ipc"]
      }
    );
    let ready = false;
    let preKillCheck = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5_000);
    child.on("message", (message) => {
      if (
        !ready &&
        message &&
        typeof message === "object" &&
        message.type === "ready" &&
        message.capability === capability
      ) {
        ready = true;
        preKillCheck = beforeKill();
        child.kill("SIGKILL");
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, ready, preKillCheck });
    });
    child.send({
      type: "initialize",
      capability,
      databasePath,
      mode
    });
  });

const validatePaths = (sourceArg, copyArg) => {
  if (!sourceArg || !copyArg) {
    throw new Error("SOURCE_AND_COPY_REQUIRED");
  }

  const sourcePath = resolve(sourceArg);
  const copyPath = resolve(copyArg);
  if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) {
    throw new Error("SOURCE_DATABASE_REQUIRED");
  }
  const canonicalSource = realpathSync(sourcePath);
  const canonicalCopy = resolve(realpathSync(dirname(copyPath)), basename(copyPath));
  if (canonicalSource === canonicalCopy) {
    throw new Error("DISTINCT_PATHS_REQUIRED");
  }
  if (existsSync(copyPath)) {
    throw new Error("COPY_PATH_MUST_NOT_EXIST");
  }

  return { sourcePath, copyPath };
};

const assertNoSourceSidecars = (sourcePath) => {
  const sidecars = [`${sourcePath}-wal`, `${sourcePath}-shm`, `${sourcePath}-journal`];
  if (sidecars.some((path) => existsSync(path))) {
    throw new Error("SOURCE_DATABASE_NOT_QUIESCED");
  }
};

const runVerifier = async (sourceArg, copyArg) => {
  const startedAt = Date.now();
  const { sourcePath, copyPath } = validatePaths(sourceArg, copyArg);
  assertNoSourceSidecars(sourcePath);
  const sourceChecksumBefore = checksum(sourcePath);
  assertNoSourceSidecars(sourcePath);
  const copyStartedAt = Date.now();
  copyFileSync(sourcePath, copyPath, COPYFILE_EXCL);
  const copyLatencyMs = Date.now() - copyStartedAt;
  assertNoSourceSidecars(sourcePath);
  const sourceChecksumAfterCopy = checksum(sourcePath);
  const copyChecksumBeforeMutation = checksum(copyPath);
  const sourceChecksumMatchBeforeMutation = sourceChecksumBefore === sourceChecksumAfterCopy;
  const copyChecksumMatchesSourceBeforeMutation = sourceChecksumBefore === copyChecksumBeforeMutation;
  if (!sourceChecksumMatchBeforeMutation || !copyChecksumMatchesSourceBeforeMutation) {
    throw new Error("COPY_CHECKSUM_MISMATCH");
  }

  const db = new DatabaseSync(copyPath);
  const reader = new DatabaseSync(copyPath);
  let backupDirectory;
  let backupDb;
  try {
    const journalModeBefore = String(getPragmaValue(db, "journal_mode", "journal_mode"));
    db.exec("PRAGMA foreign_keys = ON");
    const journalModeAfter = String(getPragmaValue(db, "journal_mode = WAL", "journal_mode"));
    const walActive = journalModeAfter.toLowerCase() === "wal";
    db.exec("PRAGMA synchronous = FULL");
    const synchronousMode = synchronousModeName(getPragmaValue(db, "synchronous", "synchronous"));

    db.exec(`
      CREATE TABLE IF NOT EXISTS wal_compatibility_probe (
        id TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      INSERT OR REPLACE INTO wal_compatibility_probe(id, value) VALUES ('seed', 1);
    `);
    reader.exec("PRAGMA foreign_keys = ON; BEGIN");
    const readerCountBefore = Number(
      reader.prepare("SELECT COUNT(*) AS count FROM wal_compatibility_probe").get().count
    );
    db.prepare(
      "INSERT OR REPLACE INTO wal_compatibility_probe(id, value) VALUES (?, ?)"
    ).run("writer_commit", 1);
    const readerCountDuringWrite = Number(
      reader.prepare("SELECT COUNT(*) AS count FROM wal_compatibility_probe").get().count
    );
    reader.exec("COMMIT");
    const readerCountAfter = Number(
      reader.prepare("SELECT COUNT(*) AS count FROM wal_compatibility_probe").get().count
    );
    const concurrentReaderObservedWriter =
      readerCountDuringWrite === readerCountBefore && readerCountAfter === readerCountBefore + 1;
    const walSidecarsCreated = existsSync(`${copyPath}-wal`) && existsSync(`${copyPath}-shm`);

    const fullSynchronousCommitStartedAt = Date.now();
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      "INSERT OR REPLACE INTO wal_compatibility_probe(id, value) VALUES (?, ?)"
    ).run("full_synchronous_commit", 1);
    db.exec("COMMIT");
    const fullSynchronousCommitLatencyMs = Date.now() - fullSynchronousCommitStartedAt;
    const fullSynchronousCommitCompleted = synchronousMode === "full";

    const checkpointStartedAt = Date.now();
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    const checkpointLatencyMs = Date.now() - checkpointStartedAt;
    const checkpointCompleted = Number(checkpoint?.busy) === 0;

    const uncommittedChild = await waitForSigkill(copyPath, "uncommitted");
    const uncommittedCount = Number(
      db.prepare("SELECT COUNT(*) AS count FROM wal_compatibility_probe WHERE id = ?")
        .get("child_uncommitted").count
    );
    const uncommittedSigkillRolledBack =
      uncommittedChild.signal === "SIGKILL" && uncommittedChild.ready && uncommittedCount === 0;

    const committedChild = await waitForSigkill(
      copyPath,
      "committed-uncheckpointed",
      () => existsSync(`${copyPath}-wal`) && statSync(`${copyPath}-wal`).size > 0
    );
    const committedCount = Number(
      db.prepare("SELECT COUNT(*) AS count FROM wal_compatibility_probe WHERE id = ?")
        .get("child_committed").count
    );
    const committedChildHadUncheckpointedWal =
      committedChild.signal === "SIGKILL" && committedChild.ready && committedChild.preKillCheck;
    const committedUncheckpointedSigkillSurvived =
      committedChildHadUncheckpointedWal && committedCount === 1;
    const terminationRecoveryCompleted =
      uncommittedSigkillRolledBack && committedUncheckpointedSigkillSurvived;

    backupDirectory = mkdtempSync(join(dirname(copyPath), ".sqlite-wal-compatibility-"));
    const backupPath = join(backupDirectory, "recovery.db");
    const backupPageCount = await backup(db, backupPath);
    backupDb = new DatabaseSync(backupPath, { readOnly: true });
    const backupIntegrity = String(getPragmaValue(backupDb, "integrity_check", "integrity_check"));
    const backupCompleted = existsSync(backupPath) && backupIntegrity === "ok";

    const integrityCheckPassed = String(getPragmaValue(db, "integrity_check", "integrity_check")) === "ok";
    const foreignKeyViolationCount = db.prepare("PRAGMA foreign_key_check").all().length;
    const foreignKeyCheckPassed = foreignKeyViolationCount === 0;
    const sourceChecksumPreserved = checksum(sourcePath) === sourceChecksumBefore;
    const report = {
      ok:
        sourceChecksumMatchBeforeMutation &&
        copyChecksumMatchesSourceBeforeMutation &&
        sourceChecksumPreserved &&
        walActive &&
        walSidecarsCreated &&
        checkpointCompleted &&
        concurrentReaderObservedWriter &&
        fullSynchronousCommitCompleted &&
        backupCompleted &&
        terminationRecoveryCompleted &&
        integrityCheckPassed &&
        foreignKeyCheckPassed,
      sourceChecksumMatchBeforeMutation,
      copyChecksumMatchesSourceBeforeMutation,
      sourceChecksumPreserved,
      walActive,
      walSidecarsCreated,
      checkpointCompleted,
      checkpointLatencyMs,
      concurrentReaderObservedWriter,
      fullSynchronousCommitCompleted,
      fullSynchronousCommitLatencyMs,
      backupCompleted,
      backupPageCount,
      terminationRecoveryCompleted,
      uncommittedSigkillRolledBack,
      committedChildHadUncheckpointedWal,
      committedUncheckpointedSigkillSurvived,
      integrityCheckPassed,
      foreignKeyCheckPassed,
      foreignKeyViolationCount,
      journalModeBefore,
      journalModeAfter,
      synchronousMode,
      copyLatencyMs,
      verificationLatencyMs: Date.now() - startedAt
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.ok) process.exitCode = 1;
  } finally {
    backupDb?.close();
    reader.close();
    db.close();
    if (backupDirectory) rmSync(backupDirectory, { recursive: true, force: true });
  }
};

const args = process.argv.slice(2);
runVerifier(optionValue(args, "--source"), optionValue(args, "--copy")).catch((error) => {
  const code = error instanceof Error ? error.message : "UNEXPECTED_FAILURE";
  if (code === "SOURCE_AND_COPY_REQUIRED") {
    fail("--source and --copy are required");
    return;
  }
  if (code === "DISTINCT_PATHS_REQUIRED") {
    fail("--source and --copy must use distinct paths");
    return;
  }
  fail("WAL_COMPATIBILITY_CHECK_FAILED");
});
