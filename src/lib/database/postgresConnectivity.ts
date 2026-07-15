import type { Pool, PoolClient } from "pg";

import type { DatabaseConfig } from "./config.js";
import { createPostgresPool, type PostgresConnectionMode } from "./postgres.js";
import { sanitizeDatabaseError } from "./redaction.js";

export class PostgresConnectivityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PostgresConnectivityError";
    this.code = code;
  }
}

export type PostgresConnectivityResult = {
  connectionTest: "passed";
  mode: PostgresConnectionMode;
  variable: string;
  ssl: "enabled" | "disabled";
  serverMajorVersion: number;
  transactionTimeoutSupported: boolean;
  latencyMs: number;
};

export const checkPostgresConnectivity = async (
  config: DatabaseConfig,
  options: {
    mode: PostgresConnectionMode;
    createPool?: (config: DatabaseConfig, mode: PostgresConnectionMode) => Pool;
    now?: () => number;
  }
): Promise<PostgresConnectivityResult> => {
  const poolFactory = options.createPool || createPostgresPool;
  const now = options.now || Date.now;
  const pool = poolFactory(config, options.mode);
  const startedAt = now();
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const result = await client.query<{
      server_version_num: string;
      transaction_timeout: string | null;
    }>(`
      SELECT
        current_setting('server_version_num') AS server_version_num,
        current_setting('transaction_timeout', true) AS transaction_timeout
    `);
    const row = result.rows[0];
    if (!row) throw new Error("POSTGRES_CONNECTIVITY_EMPTY_RESULT");
    const serverMajorVersion = Math.floor(Number.parseInt(row.server_version_num, 10) / 10_000);
    if (!Number.isFinite(serverMajorVersion) || serverMajorVersion < 1) {
      throw new Error("POSTGRES_SERVER_VERSION_INVALID");
    }
    if (row.transaction_timeout === null) {
      throw new Error("POSTGRES_TRANSACTION_TIMEOUT_UNSUPPORTED");
    }
    const encrypted = Boolean(
      (client as unknown as { connection?: { stream?: { encrypted?: boolean } } })
        .connection?.stream?.encrypted
    );
    if (config.sslRequired && !encrypted) {
      throw new Error("POSTGRES_SSL_REQUIRED");
    }
    return {
      connectionTest: "passed",
      mode: options.mode,
      variable:
        (options.mode === "direct" ? config.directVariable : config.pooledVariable) ||
        "unknown",
      ssl: encrypted ? "enabled" : "disabled",
      serverMajorVersion,
      transactionTimeoutSupported: true,
      latencyMs: Math.max(0, now() - startedAt)
    };
  } catch (error) {
    const safe = sanitizeDatabaseError(error);
    throw new PostgresConnectivityError(
      safe.code || "POSTGRES_CONNECTIVITY_FAILED",
      safe.message
    );
  } finally {
    client?.release();
    await pool.end();
  }
};
