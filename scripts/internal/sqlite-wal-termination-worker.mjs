#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";

let database;

const fail = () => {
  process.exitCode = 1;
  process.disconnect?.();
};

if (typeof process.send !== "function") {
  fail();
} else {
  process.once("message", (message) => {
    const expectedCapability = process.env.SQLITE_WAL_CHILD_CAPABILITY;
    if (
      !message ||
      typeof message !== "object" ||
      message.type !== "initialize" ||
      typeof message.capability !== "string" ||
      message.capability.length < 32 ||
      message.capability !== expectedCapability ||
      typeof message.databasePath !== "string" ||
      (message.mode !== "uncommitted" && message.mode !== "committed-uncheckpointed")
    ) {
      fail();
      return;
    }

    database = new DatabaseSync(message.databasePath);
    if (message.mode === "uncommitted") {
      database.exec("BEGIN IMMEDIATE");
      database.prepare(
        "INSERT INTO wal_compatibility_probe(id, value) VALUES (?, ?)"
      ).run("child_uncommitted", 1);
    } else {
      database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; BEGIN IMMEDIATE");
      database.prepare(
        "INSERT INTO wal_compatibility_probe(id, value) VALUES (?, ?)"
      ).run("child_committed", 1);
      database.exec("COMMIT");
    }

    process.send({ type: "ready", capability: message.capability });
  });
}
