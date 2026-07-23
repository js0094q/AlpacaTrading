import type { Pool, PoolClient } from "pg";

import type { DatabaseConfig } from "./config.js";

export type PostgresIsolationLevel =
  | "read committed"
  | "repeatable read"
  | "serializable";

export type PostgresTransactionOptions = {
  isolationLevel?: PostgresIsolationLevel;
  readOnly?: boolean;
};

export class PostgresTransactionRollbackError extends AggregateError {
  constructor(operationError: unknown, rollbackError: unknown) {
    super(
      [operationError, rollbackError],
      "PostgreSQL transaction and rollback both failed."
    );
    this.name = "PostgresTransactionRollbackError";
  }
}

const isolationSql = (level: PostgresIsolationLevel) => {
  if (level === "serializable") return "SERIALIZABLE";
  if (level === "repeatable read") return "REPEATABLE READ";
  return "READ COMMITTED";
};

const timeoutSql = (name: string, milliseconds: number) =>
  `SET LOCAL ${name} = '${Math.max(1, Math.floor(milliseconds))}ms'`;

export const withPostgresTransaction = async <T>(
  pool: Pool,
  config: DatabaseConfig,
  operation: (client: PoolClient) => Promise<T>,
  options: PostgresTransactionOptions = {}
): Promise<T> => {
  const client = await pool.connect();
  let discardError: Error | undefined;
  try {
    return await withCheckedOutPostgresTransaction(client, config, operation, options);
  } catch (error) {
    if (error instanceof PostgresTransactionRollbackError) discardError = error;
    throw error;
  } finally {
    client.release(discardError);
  }
};

export const withCheckedOutPostgresTransaction = async <T>(
  client: PoolClient,
  config: DatabaseConfig,
  operation: (client: PoolClient) => Promise<T>,
  options: PostgresTransactionOptions = {}
): Promise<T> => {
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query(
      `SET TRANSACTION ISOLATION LEVEL ${isolationSql(options.isolationLevel || "read committed")} ${options.readOnly ? "READ ONLY" : "READ WRITE"}`
    );
    await client.query(timeoutSql("statement_timeout", config.statementTimeoutMs));
    await client.query(timeoutSql("lock_timeout", config.lockTimeoutMs));
    await client.query(
      timeoutSql(
        "idle_in_transaction_session_timeout",
        config.idleInTransactionTimeoutMs
      )
    );
    await client.query(timeoutSql("transaction_timeout", config.transactionTimeoutMs));
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (began) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new PostgresTransactionRollbackError(error, rollbackError);
      }
    }
    throw error;
  }
};
