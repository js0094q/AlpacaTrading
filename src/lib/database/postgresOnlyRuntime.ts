import type { DatabaseConfig } from "./config.js";

export const POSTGRES_ONLY_RUNTIME_PATH_DISABLED =
  "POSTGRES_ONLY_RUNTIME_PATH_DISABLED";
export const RUNTIME_SQLITE_DISABLED = "RUNTIME_SQLITE_DISABLED";

const SAFE_PRODUCTION_CLI_COMMANDS = new Set([
  "alpaca:account",
  "alpaca:asset",
  "alpaca:config",
  "alpaca:health",
  "alpaca:orders",
  "alpaca:positions",
  "hedge:exit:execute",
  "hedge:exit:review",
  "hedge:review",
  "paper:execute:reviewed",
  "paper:exit:execute",
  "paper:exit:review",
  "paper:learn",
  "paper:ops:review",
  "paper:options:discover",
  "paper:order:cancel",
  "paper:portfolio:review",
  "paper:reconcile:external-order",
  "paper:review",
  "research:daily",
  "system:recover",
  "worker:state",
  "zero-dte:engine",
  "zero-dte:exit:review",
  "zero-dte:reconcile",
  "db:postgres:authority:cutover",
  "db:postgres:authority:status",
  "db:postgres:connectivity",
  "db:postgres:migrate",
  "db:postgres:status",
  "db:postgres:verify"
]);

export const sqliteTestFixtureInitializationEnabled = () =>
  process.env.NODE_ENV === "test" &&
  Boolean(process.env.NODE_TEST_CONTEXT) &&
  (globalThis as typeof globalThis & { [key: symbol]: unknown })[
    Symbol.for("alpaca.sqlite.test-fixture-initialization")
  ] === true;

export class PostgresOnlyRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PostgresOnlyRuntimeError";
    this.code = code;
  }
}

export const assertPostgresOnlyDatabaseAuthority = (config: DatabaseConfig) => {
  const failures = [
    config.backend !== "postgres" ? "POSTGRES_BACKEND_REQUIRED" : null,
    !config.features.postgresReads ? "POSTGRES_READS_REQUIRED" : null,
    !config.features.postgresWrites ? "POSTGRES_WRITES_REQUIRED" : null,
    !config.features.controlPlaneAuthority
      ? "POSTGRES_CONTROL_PLANE_AUTHORITY_REQUIRED"
      : null,
    !config.features.schedulerAuthority
      ? "POSTGRES_SCHEDULER_AUTHORITY_REQUIRED"
      : null,
    !config.features.executionStateAuthority
      ? "POSTGRES_EXECUTION_STATE_AUTHORITY_REQUIRED"
      : null,
    config.features.shadowComparison
      ? "POSTGRES_SHADOW_COMPARE_DISABLED_REQUIRED"
      : null,
    config.features.executionStateShadow
      ? "POSTGRES_EXECUTION_STATE_SHADOW_DISABLED_REQUIRED"
      : null,
    config.features.sqliteAuditMirror
      ? "SQLITE_AUDIT_MIRROR_DISABLED_REQUIRED"
      : null
  ].filter((value): value is string => value !== null);

  if (failures.length > 0) {
    throw new PostgresOnlyRuntimeError(
      failures[0]!,
      `PostgreSQL-only runtime authority is required (${failures.join(", ")}).`
    );
  }
  return true;
};

export const assertPostgresOnlyCliCommand = (command: string | undefined) => {
  if (sqliteTestFixtureInitializationEnabled()) return;
  if (command && SAFE_PRODUCTION_CLI_COMMANDS.has(command)) return;
  throw new PostgresOnlyRuntimeError(
    POSTGRES_ONLY_RUNTIME_PATH_DISABLED,
    `${POSTGRES_ONLY_RUNTIME_PATH_DISABLED}: ${command || "missing command"}`
  );
};

export const listSafePostgresOnlyCliCommands = () =>
  [...SAFE_PRODUCTION_CLI_COMMANDS].sort();
