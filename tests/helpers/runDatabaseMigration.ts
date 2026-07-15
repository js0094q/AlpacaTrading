import { DatabaseSync } from "node:sqlite";

import { initializeDatabaseHandle } from "../../src/lib/db.js";

const databasePath = process.argv[2];
if (!databasePath) {
  throw new Error("database path is required");
}

const db = new DatabaseSync(databasePath);
try {
  initializeDatabaseHandle(db);
  process.stdout.write(JSON.stringify({ ok: true }));
} finally {
  db.close();
}
