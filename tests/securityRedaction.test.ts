import assert from "node:assert/strict";
import test from "node:test";
import { redactSensitiveData, redactSensitiveText } from "../src/lib/securityRedaction.js";

const NEON_SECRET_ENV_NAMES = [
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "POSTGRES_URL",
  "POSTGRES_URL_NON_POOLING",
  "POSTGRES_PRISMA_URL",
  "PGPASSWORD",
  "POSTGRES_PASSWORD"
] as const;

const withConfiguredNeonValues = (callback: (configured: Record<string, string>) => void) => {
  const originals = new Map<string, string | undefined>();
  const configured = Object.fromEntries(
    NEON_SECRET_ENV_NAMES.map((name, index) => [name, `test-neon-secret-${index}-value`])
  );

  for (const name of NEON_SECRET_ENV_NAMES) {
    originals.set(name, process.env[name]);
    process.env[name] = configured[name];
  }

  try {
    callback(configured);
  } finally {
    for (const name of NEON_SECRET_ENV_NAMES) {
      const original = originals.get(name);
      if (original === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original;
      }
    }
  }
};

test("redacts PostgreSQL connection URLs while retaining surrounding error text", () => {
  const postgresUrl = "postgres://operator%40example.com:encoded%3Apassword@ep-green-leaf-123.us-east-2.aws.neon.tech/neondb?sslmode=require&token=query-token-value";
  const postgresqlUrl = "postgresql://operator:plain-password@ep-blue-river-456.us-east-2.aws.neon.tech/neondb?sslmode=require&authToken=query-token-value";

  const redacted = redactSensitiveText(`Connection attempts failed: ${postgresUrl}; retry also failed: ${postgresqlUrl}`);

  assert.equal(
    redacted,
    "Connection attempts failed: [REDACTED:POSTGRES_CONNECTION_URL]; retry also failed: [REDACTED:POSTGRES_CONNECTION_URL]"
  );
});

test("redacts password-bearing DSNs while retaining non-secret connection context", () => {
  const dsn = "host=ep-green-leaf-123.us-east-2.aws.neon.tech port=5432 dbname=neondb user=operator password=dsn-password-value sslmode=require";

  const redacted = redactSensitiveText(`Database connection failed with ${dsn}`);

  assert.equal(
    redacted,
    "Database connection failed with host=ep-green-leaf-123.us-east-2.aws.neon.tech port=5432 dbname=neondb user=operator password=[REDACTED] sslmode=require"
  );
});

test("redacts every configured Neon connection variable without removing safe key names", () => {
  withConfiguredNeonValues((configured) => {
    const input = NEON_SECRET_ENV_NAMES.map((name) => `${name}=${configured[name]}`).join(" ");
    const redacted = redactSensitiveText(`Configuration rejected: ${input}`);

    for (const name of NEON_SECRET_ENV_NAMES) {
      assert.ok(!redacted.includes(configured[name]));
      assert.ok(redacted.includes(`${name}=[REDACTED]`));
    }
    assert.ok(redacted.startsWith("Configuration rejected: "));
  });
});

test("redacts short configured secrets from free-form error text", () => {
  const original = process.env.PGPASSWORD;
  process.env.PGPASSWORD = "xy";
  try {
    assert.equal(
      redactSensitiveText("connection rejected password fragment xy"),
      "connection rejected password fragment [REDACTED:PGPASSWORD]"
    );
  } finally {
    if (original === undefined) delete process.env.PGPASSWORD;
    else process.env.PGPASSWORD = original;
  }
});

test("redacts sensitive object-key values even when their environment values are not configured", () => {
  const data = {
    DATABASE_URL: "postgresql://operator:object-password@host/neondb?token=object-query-token",
    nested: {
      PGPASSWORD: "object-password-value",
      APCA_API_SECRET_KEY: "existing-secret-value"
    },
    message: "Database connection failed after retry"
  };

  assert.deepEqual(redactSensitiveData(data), {
    DATABASE_URL: "[REDACTED:DATABASE_URL]",
    nested: {
      PGPASSWORD: "[REDACTED:PGPASSWORD]",
      APCA_API_SECRET_KEY: "[REDACTED:APCA_API_SECRET_KEY]"
    },
    message: "Database connection failed after retry"
  });
});

test("redacts common secret-bearing object keys without hiding ordinary fields", () => {
  const data = {
    password: "plain-password-value",
    token: "request-token-value",
    authToken: "auth-token-value",
    access_token: "access-token-value",
    secret: "shared-secret-value",
    client_secret: "client-secret-value",
    apiKey: "api-key-value",
    api_key: "underscored-api-key-value",
    connectionString: "postgresql://operator:password@host/neondb",
    connection_string: "postgresql://operator:password@host/neondb",
    tokenCount: 2,
    connectionStatus: "retrying",
    message: "Password rotation is required before retrying"
  };

  assert.deepEqual(redactSensitiveData(data), {
    password: "[REDACTED:password]",
    token: "[REDACTED:token]",
    authToken: "[REDACTED:authToken]",
    access_token: "[REDACTED:access_token]",
    secret: "[REDACTED:secret]",
    client_secret: "[REDACTED:client_secret]",
    apiKey: "[REDACTED:apiKey]",
    api_key: "[REDACTED:api_key]",
    connectionString: "[REDACTED:connectionString]",
    connection_string: "[REDACTED:connection_string]",
    tokenCount: 2,
    connectionStatus: "retrying",
    message: "Password rotation is required before retrying"
  });
});
