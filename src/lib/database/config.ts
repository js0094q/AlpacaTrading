import { sqliteTestFixtureInitializationEnabled } from "./postgresOnlyRuntime.js";

export type DatabaseBackend = "sqlite" | "postgres";
export type DatabaseRuntime = "vercel" | "vps" | "local" | "test";
export type DatabasePurpose = "application" | "migration" | "backfill";

export type DatabaseFeatureFlags = {
  postgresReads: boolean;
  postgresWrites: boolean;
  shadowComparison: boolean;
  controlPlaneAuthority: boolean;
  schedulerAuthority: boolean;
  executionStateShadow: boolean;
  executionStateAuthority: boolean;
  sqliteAuditMirror: boolean;
};

export type DatabaseConfig = {
  backend: DatabaseBackend;
  runtime: DatabaseRuntime;
  purpose: DatabasePurpose;
  pooledUrl?: string;
  directUrl?: string;
  pooledVariable?: string;
  directVariable?: string;
  sslRequired: boolean;
  applicationName: string;
  maxConnections: number;
  minConnections: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
  transactionTimeoutMs: number;
  features: DatabaseFeatureFlags;
};

type Environment = Record<string, string | undefined>;

export class DatabaseConfigurationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DatabaseConfigurationError";
    this.code = code;
  }
}

const pooledVariables = ["DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL"] as const;
const directVariables = ["DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING"] as const;

const firstPresent = (environment: Environment, names: readonly string[]) => {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value) return { name, value };
  }
  return undefined;
};

const strictBoolean = (environment: Environment, name: string, fallback = false) => {
  const value = environment[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new DatabaseConfigurationError(
    "DATABASE_BOOLEAN_INVALID",
    `${name} must be true or false.`
  );
};

const boundedInteger = (
  environment: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
) => {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new DatabaseConfigurationError(
      "DATABASE_INTEGER_INVALID",
      `${name} must be an integer.`
    );
  }
  return Math.min(maximum, Math.max(minimum, parsed));
};

const inferRuntime = (environment: Environment): DatabaseRuntime => {
  if (environment.VERCEL === "1" || environment.VERCEL_ENV) return "vercel";
  if (environment.NODE_TEST_CONTEXT) return "test";
  if (environment.INVOCATION_ID || environment.SYSTEMD_EXEC_PID) return "vps";
  return "local";
};

const runtimeDefaults = (runtime: DatabaseRuntime, purpose: DatabasePurpose) => {
  if (purpose !== "application") {
    return { maxConnections: 1, minConnections: 0, idleTimeoutMs: 1_000 };
  }
  if (runtime === "vercel") {
    return { maxConnections: 1, minConnections: 0, idleTimeoutMs: 1_000 };
  }
  if (runtime === "vps") {
    return { maxConnections: 5, minConnections: 0, idleTimeoutMs: 30_000 };
  }
  return { maxConnections: 3, minConnections: 0, idleTimeoutMs: 10_000 };
};

const safeApplicationName = (value: string) => {
  const normalized = value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 63);
  return normalized || "alpaca-paper";
};

export const loadDatabaseConfig = (
  environment: Environment = process.env,
  options: { runtime?: DatabaseRuntime; purpose?: DatabasePurpose } = {}
): DatabaseConfig => {
  const runtime = options.runtime || inferRuntime(environment);
  const purpose = options.purpose || "application";
  const backendValue = environment.DATABASE_BACKEND?.trim().toLowerCase() || "postgres";
  if (backendValue !== "sqlite" && backendValue !== "postgres") {
    throw new DatabaseConfigurationError(
      "DATABASE_BACKEND_INVALID",
      "DATABASE_BACKEND must be postgres; SQLite runtime authority is retired."
    );
  }

  const pooled = firstPresent(environment, pooledVariables);
  const direct = firstPresent(environment, directVariables);
  const features: DatabaseFeatureFlags = {
    postgresReads: strictBoolean(environment, "POSTGRES_READS_ENABLED"),
    postgresWrites: strictBoolean(environment, "POSTGRES_WRITES_ENABLED"),
    shadowComparison: strictBoolean(environment, "POSTGRES_SHADOW_COMPARE_ENABLED"),
    controlPlaneAuthority: strictBoolean(
      environment,
      "POSTGRES_CONTROL_PLANE_AUTHORITY_ENABLED"
    ),
    schedulerAuthority: strictBoolean(
      environment,
      "POSTGRES_SCHEDULER_AUTHORITY_ENABLED"
    ),
    executionStateShadow: strictBoolean(
      environment,
      "POSTGRES_EXECUTION_STATE_SHADOW_ENABLED"
    ),
    executionStateAuthority: strictBoolean(
      environment,
      "POSTGRES_EXECUTION_STATE_AUTHORITY_ENABLED"
    ),
    sqliteAuditMirror: strictBoolean(environment, "SQLITE_AUDIT_MIRROR_ENABLED")
  };

  const postgresSelected = backendValue === "postgres" || Object.values(features).some(Boolean);
  if (postgresSelected && !pooled) {
    throw new DatabaseConfigurationError(
      "POSTGRES_POOLED_URL_REQUIRED",
      `PostgreSQL requires one pooled connection variable: ${pooledVariables.join(", ")}.`
    );
  }
  if ((purpose === "migration" || purpose === "backfill") && !direct) {
    throw new DatabaseConfigurationError(
      "POSTGRES_DIRECT_URL_REQUIRED",
      `PostgreSQL ${purpose} requires one direct connection variable: ${directVariables.join(", ")}.`
    );
  }
  if (
    (features.shadowComparison || features.executionStateShadow) &&
    (!features.postgresReads || !features.postgresWrites)
  ) {
    throw new DatabaseConfigurationError(
      "POSTGRES_SHADOW_PREREQUISITES_REQUIRED",
      "PostgreSQL shadow comparison requires POSTGRES_READS_ENABLED and POSTGRES_WRITES_ENABLED."
    );
  }

  const testFixtureInitializationEnabled = sqliteTestFixtureInitializationEnabled();
  if (purpose === "application" && !testFixtureInitializationEnabled) {
    const requiredAuthorityFlags = [
      features.postgresReads,
      features.postgresWrites,
      features.controlPlaneAuthority,
      features.schedulerAuthority,
      features.executionStateAuthority
    ];
    if (backendValue !== "postgres" || requiredAuthorityFlags.some((value) => !value)) {
      throw new DatabaseConfigurationError(
        "POSTGRES_ONLY_AUTHORITY_REQUIRED",
        "Application runtime requires PostgreSQL reads, writes, control-plane authority, scheduler authority, and execution-state authority."
      );
    }
    if (
      features.shadowComparison ||
      features.executionStateShadow ||
      features.sqliteAuditMirror
    ) {
      throw new DatabaseConfigurationError(
        "POSTGRES_ONLY_FALLBACK_DISABLED",
        "SQLite mirrors, shadow comparison, and dual-authority runtime modes are disabled."
      );
    }
  }
  if (
    (features.controlPlaneAuthority ||
      features.schedulerAuthority ||
      features.executionStateAuthority) &&
    (!features.postgresReads || !features.postgresWrites)
  ) {
    throw new DatabaseConfigurationError(
      "POSTGRES_AUTHORITY_PREREQUISITES_REQUIRED",
      "PostgreSQL authority requires POSTGRES_READS_ENABLED and POSTGRES_WRITES_ENABLED."
    );
  }
  if (
    (features.schedulerAuthority ||
      features.executionStateShadow ||
      features.executionStateAuthority) &&
    !features.controlPlaneAuthority
  ) {
    throw new DatabaseConfigurationError(
      "CONTROL_PLANE_AUTHORITY_REQUIRED",
      "Scheduler and execution-state authority require control-plane authority first."
    );
  }
  if (
    (features.executionStateShadow || features.executionStateAuthority) &&
    !features.schedulerAuthority
  ) {
    throw new DatabaseConfigurationError(
      "SCHEDULER_AUTHORITY_REQUIRED",
      "Execution-state shadow and authority require scheduler authority first."
    );
  }
  if (
    (features.controlPlaneAuthority ||
      features.schedulerAuthority ||
      features.executionStateAuthority) &&
    backendValue !== "postgres"
  ) {
    throw new DatabaseConfigurationError(
      "POSTGRES_AUTHORITY_BACKEND_REQUIRED",
      "PostgreSQL authority requires DATABASE_BACKEND=postgres."
    );
  }

  const defaults = runtimeDefaults(runtime, purpose);
  const migrationPurpose = purpose !== "application";
  return {
    backend: backendValue,
    runtime,
    purpose,
    ...(pooled ? { pooledUrl: pooled.value, pooledVariable: pooled.name } : {}),
    ...(direct ? { directUrl: direct.value, directVariable: direct.name } : {}),
    sslRequired: strictBoolean(environment, "POSTGRES_SSL_REQUIRED", true),
    applicationName: safeApplicationName(
      environment.POSTGRES_APPLICATION_NAME?.trim() ||
        `alpaca-paper-${runtime}-${purpose}`
    ),
    maxConnections: boundedInteger(
      environment,
      "POSTGRES_POOL_MAX",
      defaults.maxConnections,
      1,
      runtime === "vercel" || migrationPurpose ? 1 : 10
    ),
    minConnections: boundedInteger(
      environment,
      "POSTGRES_POOL_MIN",
      defaults.minConnections,
      0,
      migrationPurpose ? 0 : 2
    ),
    idleTimeoutMs: boundedInteger(
      environment,
      "POSTGRES_IDLE_TIMEOUT_MS",
      defaults.idleTimeoutMs,
      1_000,
      120_000
    ),
    connectionTimeoutMs: boundedInteger(
      environment,
      "POSTGRES_CONNECTION_TIMEOUT_MS",
      10_000,
      1_000,
      30_000
    ),
    statementTimeoutMs: boundedInteger(
      environment,
      "POSTGRES_STATEMENT_TIMEOUT_MS",
      migrationPurpose ? 120_000 : 15_000,
      1_000,
      300_000
    ),
    lockTimeoutMs: boundedInteger(
      environment,
      "POSTGRES_LOCK_TIMEOUT_MS",
      migrationPurpose ? 10_000 : 5_000,
      100,
      60_000
    ),
    idleInTransactionTimeoutMs: boundedInteger(
      environment,
      "POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS",
      migrationPurpose ? 60_000 : 15_000,
      1_000,
      300_000
    ),
    transactionTimeoutMs: boundedInteger(
      environment,
      "POSTGRES_TRANSACTION_TIMEOUT_MS",
      migrationPurpose ? 180_000 : 30_000,
      1_000,
      600_000
    ),
    features
  };
};

export const databaseConfigDiagnostics = (config: DatabaseConfig) => ({
  backend: config.backend,
  runtime: config.runtime,
  purpose: config.purpose,
  pooledConnection: {
    present: Boolean(config.pooledUrl),
    variable: config.pooledVariable || null
  },
  directConnection: {
    present: Boolean(config.directUrl),
    variable: config.directVariable || null
  },
  sslRequired: config.sslRequired,
  applicationName: config.applicationName,
  pool: {
    minConnections: config.minConnections,
    maxConnections: config.maxConnections,
    idleTimeoutMs: config.idleTimeoutMs,
    connectionTimeoutMs: config.connectionTimeoutMs
  },
  timeouts: {
    statementMs: config.statementTimeoutMs,
    lockMs: config.lockTimeoutMs,
    idleInTransactionMs: config.idleInTransactionTimeoutMs,
    transactionMs: config.transactionTimeoutMs
  },
  features: config.features
});
