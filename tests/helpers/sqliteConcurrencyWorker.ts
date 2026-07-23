import { DatabaseSync } from "node:sqlite";

const [mode, databasePath, holdMsArg] = process.argv.slice(2);

if (mode !== "hold-writer" || !databasePath) {
  process.exit(2);
}

const holdMs = Math.max(0, Number.parseInt(holdMsArg ?? "100", 10));
const db = new DatabaseSync(databasePath);
const sleeper = new Int32Array(new SharedArrayBuffer(4));

try {
  db.exec("PRAGMA busy_timeout = 25;");
  db.exec("BEGIN IMMEDIATE;");
  db.prepare(`
    INSERT INTO api_request_log(provider, endpoint, method, status, request_id, created_at)
    VALUES ('test', '/sqlite-concurrency/holder', 'GET', 200, NULL, ?)
  `).run(new Date().toISOString());
  process.stdout.write("ready\n");
  Atomics.wait(sleeper, 0, 0, holdMs);
  db.exec("COMMIT;");
} catch (error) {
  try {
    db.exec("ROLLBACK;");
  } catch {
    // Preserve the original worker error.
  }
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  db.close();
}
