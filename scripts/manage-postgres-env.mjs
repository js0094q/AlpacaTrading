#!/usr/bin/env node

import {
  constants,
  copyFileSync,
  chmodSync,
  chownSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";

const REQUIRED_KEYS = ["DATABASE_URL", "DATABASE_URL_UNPOOLED"];

const parseArgs = (argv) => {
  const [mode, ...rest] = argv;
  const args = { mode };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token?.startsWith("--")) continue;
    args[token.slice(2)] = rest[index + 1];
    index += 1;
  }
  return args;
};

const fail = (code) => {
  process.stderr.write(`${code}\n`);
  process.exit(1);
};

const assertRestrictedFile = (path, label) => {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(`${label.toUpperCase()}_FILE_NOT_FOUND`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label.toUpperCase()}_MUST_BE_REGULAR_FILE`);
  }
  if ((stat.mode & 0o077) !== 0) fail(`${label.toUpperCase()}_PERMISSIONS_TOO_OPEN`);
  return stat;
};

const parseSelectedLines = (content) => {
  const selected = new Map();
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || !REQUIRED_KEYS.includes(match[1])) continue;
    if (!match[2]?.trim()) fail(`REQUIRED_VARIABLE_EMPTY:${match[1]}`);
    selected.set(match[1], match[2]);
  }
  for (const key of REQUIRED_KEYS) {
    if (!selected.has(key)) fail(`REQUIRED_VARIABLE_MISSING:${key}`);
  }
  return selected;
};

const writeRestricted = (path, content, ownership) => {
  const temporaryPath = join(
    dirname(path),
    `.${path.split("/").at(-1)}.${process.pid}.${Date.now()}.tmp`
  );
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (ownership) chownSync(temporaryPath, ownership.uid, ownership.gid);
    chmodSync(temporaryPath, ownership?.mode ?? 0o600);
    renameSync(temporaryPath, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary path may not have been created.
    }
    throw error;
  }
};

const args = parseArgs(process.argv.slice(2));
if (!args.source || !args.target || !["extract", "merge"].includes(args.mode)) {
  fail("USAGE: manage-postgres-env.mjs extract|merge --source <path> --target <path> [--backup <path>]");
}

const sourceStat = assertRestrictedFile(args.source, "source");
const selected = parseSelectedLines(readFileSync(args.source, "utf8"));

if (args.mode === "extract") {
  try {
    statSync(args.target);
    fail("EXTRACT_TARGET_ALREADY_EXISTS");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const content = `${REQUIRED_KEYS.map((key) => `${key}=${selected.get(key)}`).join("\n")}\n`;
  writeRestricted(args.target, content);
  process.stdout.write([
    "mode: extract",
    "source permissions restrictive: yes",
    "required variables present: yes",
    "target permissions: 0600",
    "values printed: no"
  ].join("\n") + "\n");
  process.exit(0);
}

if (!args.backup) fail("BACKUP_PATH_REQUIRED");
const targetStat = assertRestrictedFile(args.target, "target");
try {
  copyFileSync(args.target, args.backup, constants.COPYFILE_EXCL);
} catch (error) {
  if (error?.code === "EEXIST") fail("BACKUP_ALREADY_EXISTS");
  throw error;
}
chownSync(args.backup, targetStat.uid, targetStat.gid);
chmodSync(args.backup, 0o400);

const retained = [];
const replaced = new Set();
for (const line of readFileSync(args.target, "utf8").split(/\r?\n/)) {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  const key = match?.[1];
  if (key && REQUIRED_KEYS.includes(key)) {
    if (!replaced.has(key)) {
      retained.push(`${key}=${selected.get(key)}`);
      replaced.add(key);
    }
    continue;
  }
  retained.push(line);
}
for (const key of REQUIRED_KEYS) {
  if (!replaced.has(key)) retained.push(`${key}=${selected.get(key)}`);
}
while (retained.at(-1) === "") retained.pop();
writeRestricted(args.target, `${retained.join("\n")}\n`, {
  uid: targetStat.uid,
  gid: targetStat.gid,
  mode: targetStat.mode & 0o777
});

const after = statSync(args.target);
if (after.uid !== targetStat.uid || after.gid !== targetStat.gid) fail("TARGET_OWNERSHIP_CHANGED");
if ((after.mode & 0o777) !== (targetStat.mode & 0o777)) fail("TARGET_PERMISSIONS_CHANGED");
if ((sourceStat.mode & 0o077) !== 0) fail("SOURCE_PERMISSIONS_CHANGED");

process.stdout.write([
  "mode: merge",
  "source permissions restrictive: yes",
  "required variables present: yes",
  "target ownership preserved: yes",
  "target permissions preserved: yes",
  "backup permissions: 0400",
  "unrelated variables preserved: yes",
  "values printed: no"
].join("\n") + "\n");
