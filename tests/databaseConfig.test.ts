import assert from "node:assert/strict";
import test from "node:test";

import {
  DatabaseConfigurationError,
  databaseConfigDiagnostics,
  loadDatabaseConfig
} from "../src/lib/database/config.js";
import {
  createPostgresPool,
  preparePostgresConnectionString
} from "../src/lib/database/postgres.js";

Object.defineProperty(
  globalThis,
  Symbol.for("alpaca.sqlite.test-fixture-initialization"),
  { configurable: true, value: true, writable: true }
);

const base = {
  DATABASE_URL: "postgresql://synthetic-user:synthetic-password@pooled.example.invalid/db",
  DATABASE_URL_UNPOOLED:
    "postgresql://synthetic-user:synthetic-password@direct.example.invalid/db"
};

test("database configuration defaults to PostgreSQL and fails closed without a pooled URL", () => {
  assert.throws(
    () => loadDatabaseConfig({}, { runtime: "local" }),
    (error) =>
      error instanceof DatabaseConfigurationError &&
      error.code === "POSTGRES_POOLED_URL_REQUIRED"
  );
  const config = loadDatabaseConfig(base, { runtime: "test" });

  assert.equal(config.backend, "postgres");
  assert.deepEqual(config.features, {
    postgresReads: false,
    postgresWrites: false,
    shadowComparison: false,
    controlPlaneAuthority: false,
    schedulerAuthority: false,
    executionStateShadow: false,
    executionStateAuthority: false,
    sqliteAuditMirror: false
  });
  assert.equal(config.pooledUrl, base.DATABASE_URL);
  assert.equal(config.directUrl, base.DATABASE_URL_UNPOOLED);
});

test("selects actual pooled and direct variables by documented precedence", () => {
  const config = loadDatabaseConfig(
    {
      ...base,
      POSTGRES_URL: "postgresql://fallback:secret@fallback.invalid/db",
      POSTGRES_URL_NON_POOLING: "postgresql://fallback:secret@direct.invalid/db",
      DATABASE_BACKEND: "postgres"
    },
    { runtime: "vps", purpose: "migration" }
  );

  assert.equal(config.pooledVariable, "DATABASE_URL");
  assert.equal(config.directVariable, "DATABASE_URL_UNPOOLED");
  assert.equal(config.pooledUrl, base.DATABASE_URL);
  assert.equal(config.directUrl, base.DATABASE_URL_UNPOOLED);
  assert.equal(config.maxConnections, 1);
  assert.equal(config.applicationName, "alpaca-paper-vps-migration");
});

test("fails with variable names but never a connection value when PostgreSQL configuration is missing", () => {
  assert.throws(
    () =>
      loadDatabaseConfig(
        { DATABASE_BACKEND: "postgres" },
        { runtime: "vercel" }
      ),
    (error) => {
      assert.ok(error instanceof DatabaseConfigurationError);
      assert.equal(error.code, "POSTGRES_POOLED_URL_REQUIRED");
      assert.match(error.message, /DATABASE_URL/);
      assert.doesNotMatch(error.message, /postgres(?:ql)?:\/\//i);
      return true;
    }
  );

  assert.throws(
    () =>
      loadDatabaseConfig(
        { DATABASE_BACKEND: "postgres", DATABASE_URL: base.DATABASE_URL },
        { runtime: "local", purpose: "migration" }
      ),
    (error) => {
      assert.ok(error instanceof DatabaseConfigurationError);
      assert.equal(error.code, "POSTGRES_DIRECT_URL_REQUIRED");
      assert.doesNotMatch(error.message, /synthetic-password/);
      return true;
    }
  );
});

test("VPS PostgreSQL selection fails closed when its pooled variable is unavailable", () => {
  assert.throws(
    () =>
      loadDatabaseConfig(
        { DATABASE_BACKEND: "postgres", INVOCATION_ID: "synthetic-systemd-run" },
        { runtime: "vps" }
      ),
    (error) =>
      error instanceof DatabaseConfigurationError &&
      error.code === "POSTGRES_POOLED_URL_REQUIRED" &&
      !/postgres(?:ql)?:\/\//i.test(error.message)
  );
});

test("authority flags fail closed unless their prerequisite read and write flags are enabled", () => {
  assert.throws(
    () =>
      loadDatabaseConfig({
        ...base,
        POSTGRES_CONTROL_PLANE_AUTHORITY_ENABLED: "true"
      }),
    (error) =>
      error instanceof DatabaseConfigurationError &&
      error.code === "POSTGRES_AUTHORITY_PREREQUISITES_REQUIRED"
  );

  assert.throws(
    () =>
      loadDatabaseConfig({
        ...base,
        POSTGRES_READS_ENABLED: "true",
        POSTGRES_WRITES_ENABLED: "true",
        POSTGRES_EXECUTION_STATE_AUTHORITY_ENABLED: "true"
      }),
    (error) =>
      error instanceof DatabaseConfigurationError &&
      error.code === "CONTROL_PLANE_AUTHORITY_REQUIRED"
  );

  assert.throws(
    () =>
      loadDatabaseConfig({
        ...base,
        DATABASE_BACKEND: "postgres",
        POSTGRES_READS_ENABLED: "true",
        POSTGRES_WRITES_ENABLED: "true",
        POSTGRES_SCHEDULER_AUTHORITY_ENABLED: "true"
      }),
    (error) =>
      error instanceof DatabaseConfigurationError &&
      error.code === "CONTROL_PLANE_AUTHORITY_REQUIRED"
  );
});

test("shadow comparison is a non-authoritative read-write prerequisite stage", () => {
  assert.throws(
    () =>
      loadDatabaseConfig({
        ...base,
        POSTGRES_READS_ENABLED: "true",
        POSTGRES_SHADOW_COMPARE_ENABLED: "true"
      }),
    (error) =>
      error instanceof DatabaseConfigurationError &&
      error.code === "POSTGRES_SHADOW_PREREQUISITES_REQUIRED"
  );

  const config = loadDatabaseConfig({
    ...base,
    POSTGRES_READS_ENABLED: "true",
    POSTGRES_WRITES_ENABLED: "true",
    POSTGRES_SHADOW_COMPARE_ENABLED: "true"
  });
  assert.equal(config.backend, "postgres");
  assert.equal(config.features.controlPlaneAuthority, false);
  assert.equal(config.features.schedulerAuthority, false);
  assert.equal(config.features.executionStateShadow, false);
  assert.equal(config.features.executionStateAuthority, false);
});

test("execution-state shadow and authority cannot bypass scheduler authority", () => {
  assert.throws(
    () =>
      loadDatabaseConfig({
        ...base,
        DATABASE_BACKEND: "postgres",
        POSTGRES_READS_ENABLED: "true",
        POSTGRES_WRITES_ENABLED: "true",
        POSTGRES_CONTROL_PLANE_AUTHORITY_ENABLED: "true",
        POSTGRES_EXECUTION_STATE_SHADOW_ENABLED: "true"
      }),
    (error) =>
      error instanceof DatabaseConfigurationError &&
      error.code === "SCHEDULER_AUTHORITY_REQUIRED"
  );

  assert.throws(
    () =>
      loadDatabaseConfig({
        ...base,
        DATABASE_BACKEND: "postgres",
        POSTGRES_READS_ENABLED: "true",
        POSTGRES_WRITES_ENABLED: "true",
        POSTGRES_CONTROL_PLANE_AUTHORITY_ENABLED: "true",
        POSTGRES_EXECUTION_STATE_AUTHORITY_ENABLED: "true"
      }),
    (error) =>
      error instanceof DatabaseConfigurationError &&
      error.code === "SCHEDULER_AUTHORITY_REQUIRED"
  );
});

test("authority cannot be enabled while SQLite remains the selected backend", () => {
  assert.throws(
    () =>
      loadDatabaseConfig({
        ...base,
        DATABASE_BACKEND: "sqlite",
        POSTGRES_READS_ENABLED: "true",
        POSTGRES_WRITES_ENABLED: "true",
        POSTGRES_CONTROL_PLANE_AUTHORITY_ENABLED: "true"
      }),
    (error) =>
      error instanceof DatabaseConfigurationError &&
      error.code === "POSTGRES_AUTHORITY_BACKEND_REQUIRED"
  );
});

test("uses conservative runtime-specific pool and timeout defaults with bounded overrides", () => {
  const vercel = loadDatabaseConfig(
    { ...base, POSTGRES_READS_ENABLED: "true" },
    { runtime: "vercel" }
  );
  assert.equal(vercel.maxConnections, 1);
  assert.equal(vercel.idleTimeoutMs, 1_000);
  assert.equal(vercel.connectionTimeoutMs, 10_000);
  assert.equal(vercel.statementTimeoutMs, 15_000);
  assert.equal(vercel.lockTimeoutMs, 5_000);
  assert.equal(vercel.transactionTimeoutMs, 30_000);

  const vps = loadDatabaseConfig(
    {
      ...base,
      POSTGRES_READS_ENABLED: "true",
      POSTGRES_POOL_MAX: "999",
      POSTGRES_STATEMENT_TIMEOUT_MS: "1"
    },
    { runtime: "vps" }
  );
  assert.equal(vps.maxConnections, 10);
  assert.equal(vps.statementTimeoutMs, 1_000);
  assert.equal(vps.idleTimeoutMs, 30_000);
});

test("startup diagnostics report modes and names without connection values", () => {
  const config = loadDatabaseConfig(
    {
      ...base,
      POSTGRES_READS_ENABLED: "true",
      POSTGRES_WRITES_ENABLED: "true",
      POSTGRES_SHADOW_COMPARE_ENABLED: "true"
    },
    { runtime: "local" }
  );
  const diagnostics = databaseConfigDiagnostics(config);
  const serialized = JSON.stringify(diagnostics);

  assert.equal(diagnostics.pooledConnection.present, true);
  assert.equal(diagnostics.directConnection.present, true);
  assert.equal(diagnostics.pooledConnection.variable, "DATABASE_URL");
  assert.doesNotMatch(serialized, /synthetic-password|pooled\.example|direct\.example/);
});

test("PostgreSQL pool construction enforces verified TLS before connecting", async () => {
  const prepared = preparePostgresConnectionString(
    `${base.DATABASE_URL}?sslmode=require&channel_binding=require`,
    true
  );
  assert.doesNotMatch(prepared, /sslmode=/);
  assert.match(prepared, /channel_binding=require/);

  for (const suffix of [
    "sslmode=disable",
    "sslmode=prefer",
    "sslmode=no-verify",
    "ssl=no-verify",
    "uselibpqcompat=true&sslmode=require",
    "sslrootcert=%2Ftmp%2Fsynthetic-ca.pem"
  ]) {
    assert.throws(
      () => preparePostgresConnectionString(`${base.DATABASE_URL}?${suffix}`, true),
      (error) =>
        error instanceof DatabaseConfigurationError &&
        /POSTGRES_SSL_(DOWNGRADE|FILE_PARAMETER)_REJECTED/.test(error.code) &&
        !error.message.includes(base.DATABASE_URL)
    );
  }

  const config = loadDatabaseConfig(
    { ...base, DATABASE_URL: `${base.DATABASE_URL}?sslmode=require` },
    { runtime: "test" }
  );
  const pool = createPostgresPool(config, "pooled");
  try {
    assert.deepEqual(pool.options.ssl, { rejectUnauthorized: true });
    assert.doesNotMatch(String(pool.options.connectionString), /sslmode=/);
  } finally {
    await pool.end();
  }
});

test("specialized direct pools retain the migration timeout policy", async () => {
  const config = loadDatabaseConfig(
    { ...base, DATABASE_BACKEND: "postgres" },
    { runtime: "test", purpose: "migration" }
  );
  const pool = createPostgresPool(config, "direct", {
    sessionOptions: "-c search_path=synthetic_test_schema"
  });
  try {
    assert.equal(pool.options.statement_timeout, config.statementTimeoutMs);
    assert.equal(pool.options.lock_timeout, config.lockTimeoutMs);
    assert.equal(
      pool.options.idle_in_transaction_session_timeout,
      config.idleInTransactionTimeoutMs
    );
    assert.equal(pool.options.query_timeout, config.statementTimeoutMs);
    assert.equal(pool.options.options, "-c search_path=synthetic_test_schema");
  } finally {
    await pool.end();
  }
});
