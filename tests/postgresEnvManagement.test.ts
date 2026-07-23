import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = join(process.cwd(), "scripts/manage-postgres-env.mjs");

test("extracts and merges only canonical PostgreSQL variables without logging values", () => {
  const directory = mkdtempSync(join(tmpdir(), "postgres-env-test-"));
  const source = join(directory, "neon.env");
  const fragment = join(directory, "fragment.env");
  const target = join(directory, "runtime.env");
  const backup = join(directory, "runtime.env.backup");
  const pooled = "postgresql://synthetic:synthetic-pooled-secret@pooled.invalid/db";
  const direct = "postgresql://synthetic:synthetic-direct-secret@direct.invalid/db";
  try {
    writeFileSync(
      source,
      `DATABASE_URL=${pooled}\nDATABASE_URL_UNPOOLED=${direct}\nIGNORED_SECRET=do-not-copy\n`
    );
    writeFileSync(target, "ALPACA_ENV=paper\nTRADING_MODE=paper\nDATABASE_URL=old\n");
    chmodSync(source, 0o600);
    chmodSync(target, 0o600);

    const extractOutput = execFileSync(
      process.execPath,
      [script, "extract", "--source", source, "--target", fragment],
      { encoding: "utf8" }
    );
    const mergeOutput = execFileSync(
      process.execPath,
      [script, "merge", "--source", fragment, "--target", target, "--backup", backup],
      { encoding: "utf8" }
    );
    const output = `${extractOutput}\n${mergeOutput}`;
    assert.match(output, /values printed: no/);
    assert.doesNotMatch(output, /synthetic-|pooled\.invalid|direct\.invalid|do-not-copy/);
    const merged = readFileSync(target, "utf8");
    assert.match(merged, /ALPACA_ENV=paper/);
    assert.match(merged, /TRADING_MODE=paper/);
    assert.match(merged, /DATABASE_URL=postgresql:/);
    assert.match(merged, /DATABASE_URL_UNPOOLED=postgresql:/);
    assert.doesNotMatch(merged, /IGNORED_SECRET/);
    assert.equal(statSync(fragment).mode & 0o777, 0o600);
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.equal(statSync(backup).mode & 0o777, 0o400);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
