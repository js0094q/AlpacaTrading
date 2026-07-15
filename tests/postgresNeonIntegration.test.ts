import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { Pool } from "pg";

import { loadDatabaseConfig } from "../src/lib/database/config.js";
import { createPostgresPool } from "../src/lib/database/postgres.js";
import { runPostgresMigrations } from "../src/lib/database/postgresMigrations.js";
import { sanitizeDatabaseError } from "../src/lib/database/redaction.js";
import { verifyPostgresSchema } from "../src/lib/database/postgresSchema.js";

const enabled = process.env.POSTGRES_INTEGRATION_TEST_ENABLED === "true";

test("actual Neon PostgreSQL applies the full migration twice in an isolated schema", {
  skip: !enabled
}, async () => {
  const config = loadDatabaseConfig(
    {
      ...process.env,
      DATABASE_BACKEND: "postgres",
      POSTGRES_APPLICATION_NAME: "alpaca-paper-neon-integration-test"
    },
    { runtime: "test", purpose: "migration" }
  );
  const schema = `neon_release2_test_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const adminPool = createPostgresPool(config, "direct");
  let schemaPool: Pool | undefined;
  let failureCode: string | null = null;

  try {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    schemaPool = createPostgresPool(config, "direct", {
      sessionOptions: `-c search_path=${schema}`
    });

    const first = await runPostgresMigrations(schemaPool, config);
    const second = await runPostgresMigrations(schemaPool, config);
    const verification = await verifyPostgresSchema(schemaPool);

    assert.deepEqual(first.appliedVersions, [1]);
    assert.deepEqual(second.appliedVersions, []);
    assert.equal(verification.verificationPassed, true);
    assert.equal(verification.presentTableCount, 22);
    assert.equal(verification.presentIndexCount, 55);
    assert.equal(verification.schedulerFencingSequencePresent, true);
  } catch (error) {
    failureCode = sanitizeDatabaseError(error).code || "POSTGRES_INTEGRATION_TEST_FAILED";
  } finally {
    try {
      if (schemaPool) await schemaPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch (error) {
      failureCode ||= sanitizeDatabaseError(error).code || "POSTGRES_INTEGRATION_CLEANUP_FAILED";
    }
    await adminPool.end();
  }

  if (failureCode) throw new Error(`POSTGRES_INTEGRATION_TEST_FAILED:${failureCode}`);
});
