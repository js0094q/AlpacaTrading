import { Pool, type PoolConfig } from "pg";

import type { DatabaseConfig } from "./config.js";
import { DatabaseConfigurationError } from "./config.js";
import { sanitizeDatabaseError } from "./redaction.js";

export type PostgresConnectionMode = "pooled" | "direct";

export type PostgresPoolOptions = {
  sessionOptions?: string;
};

const forbiddenSslModes = new Set(["disable", "prefer", "no-verify"]);
const fileBasedSslParameters = ["sslcert", "sslkey", "sslrootcert"] as const;

export const preparePostgresConnectionString = (
  connectionString: string,
  sslRequired: boolean
) => {
  if (!sslRequired) return connectionString;
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new DatabaseConfigurationError(
      "POSTGRES_CONNECTION_URL_INVALID",
      "The selected PostgreSQL connection variable is not a valid URL."
    );
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new DatabaseConfigurationError(
      "POSTGRES_CONNECTION_PROTOCOL_INVALID",
      "The selected PostgreSQL connection variable must use the PostgreSQL protocol."
    );
  }

  const sslMode = parsed.searchParams.get("sslmode")?.toLowerCase();
  const sslValue = parsed.searchParams.get("ssl")?.toLowerCase();
  const libpqCompatibility = parsed.searchParams.get("uselibpqcompat")?.toLowerCase();
  if (
    (sslMode && forbiddenSslModes.has(sslMode)) ||
    (sslValue && ["0", "false", "no-verify"].includes(sslValue)) ||
    (libpqCompatibility === "true" && sslMode !== "verify-full")
  ) {
    throw new DatabaseConfigurationError(
      "POSTGRES_SSL_DOWNGRADE_REJECTED",
      "The selected PostgreSQL connection variable requests an unsupported SSL downgrade."
    );
  }
  if (fileBasedSslParameters.some((name) => parsed.searchParams.has(name))) {
    throw new DatabaseConfigurationError(
      "POSTGRES_SSL_FILE_PARAMETER_REJECTED",
      "File-based SSL parameters are not accepted in PostgreSQL connection variables."
    );
  }

  // pg lets connection-string SSL parameters override the explicit Pool option.
  // Remove accepted URL hints and impose verified TLS through the Pool config.
  for (const name of [
    "ssl",
    "sslmode",
    "uselibpqcompat",
    "sslnegotiation"
  ]) {
    parsed.searchParams.delete(name);
  }
  return parsed.toString();
};

export const createPostgresPool = (
  config: DatabaseConfig,
  mode: PostgresConnectionMode,
  options: PostgresPoolOptions = {}
) => {
  const connectionString = mode === "direct" ? config.directUrl : config.pooledUrl;
  const variable = mode === "direct" ? config.directVariable : config.pooledVariable;
  if (!connectionString) {
    throw new DatabaseConfigurationError(
      mode === "direct" ? "POSTGRES_DIRECT_URL_REQUIRED" : "POSTGRES_POOLED_URL_REQUIRED",
      `${mode === "direct" ? "Direct" : "Pooled"} PostgreSQL connection variable ${variable || "is missing"}.`
    );
  }

  const poolConfig: PoolConfig = {
    connectionString: preparePostgresConnectionString(connectionString, config.sslRequired),
    application_name: config.applicationName,
    max: mode === "direct" ? 1 : config.maxConnections,
    min: mode === "direct" ? 0 : config.minConnections,
    idleTimeoutMillis: config.idleTimeoutMs,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    allowExitOnIdle: config.runtime === "vercel" || config.runtime === "test",
    ssl: config.sslRequired ? { rejectUnauthorized: true } : false,
    statement_timeout: config.statementTimeoutMs,
    lock_timeout: config.lockTimeoutMs,
    idle_in_transaction_session_timeout: config.idleInTransactionTimeoutMs,
    query_timeout: config.statementTimeoutMs,
    ...(options.sessionOptions ? { options: options.sessionOptions } : {})
  };

  const pool = new Pool(poolConfig);
  pool.on("error", (error) => {
    const sanitized = sanitizeDatabaseError(error);
    process.stderr.write(`${JSON.stringify({
      event: "postgres_pool_error",
      code: sanitized.code,
      message: sanitized.message
    })}\n`);
  });
  return pool;
};
