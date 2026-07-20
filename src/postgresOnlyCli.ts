import { config as loadDotenv } from "dotenv";

loadDotenv();
loadDotenv({ path: ".env.txt", override: false });

import {
  databaseConfigDiagnostics,
  loadDatabaseConfig
} from "./lib/database/config.js";
import { createPostgresPool, type PostgresConnectionMode } from "./lib/database/postgres.js";
import { checkPostgresConnectivity } from "./lib/database/postgresConnectivity.js";
import {
  getPostgresMigrationStatus,
  runPostgresMigrations
} from "./lib/database/postgresMigrations.js";
import { assertPostgresOnlyCliCommand } from "./lib/database/postgresOnlyRuntime.js";
import { verifyPostgresSchema } from "./lib/database/postgresSchema.js";
import { redactSensitiveData } from "./lib/securityRedaction.js";
import { normalizeSymbol } from "./lib/utils.js";
import { getAlpacaAccountSnapshot } from "./services/alpacaAccountService.js";
import { checkAlpacaSymbolTradability } from "./services/alpacaAssetService.js";
import { AlpacaApiError } from "./services/alpacaClient.js";
import { buildAlpacaConfigDiagnostic } from "./services/alpacaConfigDiagnosticService.js";
import { getAlpacaMarketClock } from "./services/alpacaMarketClockService.js";
import { listAlpacaOpenOrders } from "./services/alpacaOrderReadService.js";
import { listAlpacaPositions } from "./services/alpacaPositionService.js";
import {
  AlpacaOperationDeadlineError,
  createOperationDeadline
} from "./services/operationDeadline.js";
import {
  readPostgresAuthorityStatus,
  runPostgresAuthorityCutover
} from "./services/postgresAuthorityCutoverService.js";
import { runPostgresScheduledCommand } from "./services/postgresScheduledCommandService.js";
import { getTradingSafetyState } from "./services/tradingSafetyService.js";

const command = process.argv[2];
const rawArgs = process.argv.slice(3);
const args = Object.fromEntries(rawArgs.flatMap((entry, index) => {
  if (!entry.startsWith("--")) return [];
  const [key, inline] = entry.slice(2).split("=", 2);
  const next = rawArgs[index + 1];
  return [[key!, inline ?? (next && !next.startsWith("--") ? next : "")]];
}));

const print = (payload: unknown) => {
  process.stdout.write(`${JSON.stringify(redactSensitiveData(payload), null, 2)}\n`);
};

const paperEnvelope = () => {
  const safety = getTradingSafetyState();
  return {
    paperOnly: safety.paperOnly,
    environment: safety.alpacaEnv,
    liveTradingEnabled: safety.liveTradingEnabled,
    mutationAllowed: safety.mutationAllowed,
    liveMutationAllowed: safety.liveMutationAllowed
  };
};

const run = async () => {
  assertPostgresOnlyCliCommand(command);

  if (command === "db:postgres:connectivity") {
    const mode: PostgresConnectionMode = args.mode === "direct" ? "direct" : "pooled";
    const databaseConfig = loadDatabaseConfig(process.env, {
      purpose: mode === "direct" ? "migration" : "application"
    });
    print({
      config: databaseConfigDiagnostics(databaseConfig),
      connectivity: await checkPostgresConnectivity(databaseConfig, { mode })
    });
    return;
  }

  if (command === "db:postgres:migrate") {
    const databaseConfig = loadDatabaseConfig(process.env, { purpose: "migration" });
    const pool = createPostgresPool(databaseConfig, "direct");
    try {
      print({
        config: databaseConfigDiagnostics(databaseConfig),
        migration: await runPostgresMigrations(pool, databaseConfig)
      });
    } finally {
      await pool.end();
    }
    return;
  }

  if (command === "db:postgres:status") {
    const databaseConfig = loadDatabaseConfig(process.env, { purpose: "migration" });
    const pool = createPostgresPool(databaseConfig, "direct");
    try {
      print({
        config: databaseConfigDiagnostics(databaseConfig),
        migration: await getPostgresMigrationStatus(pool)
      });
    } finally {
      await pool.end();
    }
    return;
  }

  if (command === "db:postgres:verify") {
    const databaseConfig = loadDatabaseConfig(process.env, { purpose: "migration" });
    const pool = createPostgresPool(databaseConfig, "direct");
    try {
      const [migration, schema] = await Promise.all([
        getPostgresMigrationStatus(pool),
        verifyPostgresSchema(pool)
      ]);
      const verificationPassed =
        migration.pending.length === 0 &&
        migration.checksumMismatches.length === 0 &&
        migration.unexpectedAppliedVersions.length === 0 &&
        schema.verificationPassed;
      print({
        config: databaseConfigDiagnostics(databaseConfig),
        verificationPassed,
        migration,
        schema
      });
      if (!verificationPassed) process.exitCode = 1;
    } finally {
      await pool.end();
    }
    return;
  }

  if (command === "db:postgres:authority:cutover") {
    const result = await runPostgresAuthorityCutover();
    print(result);
    if (result.status !== "passed") process.exitCode = 1;
    return;
  }

  if (command === "db:postgres:authority:status") {
    const databaseConfig = loadDatabaseConfig(process.env, { purpose: "application" });
    const pool = createPostgresPool(databaseConfig, "pooled");
    try {
      print({
        config: databaseConfigDiagnostics(databaseConfig),
        authority: await readPostgresAuthorityStatus(pool)
      });
    } finally {
      await pool.end();
    }
    return;
  }

  if (command === "alpaca:config") {
    print(buildAlpacaConfigDiagnostic());
    return;
  }

  if (command === "alpaca:health") {
    const configuredTimeout = Number.parseInt(
      process.env.ALPACA_HEALTH_OPERATION_TIMEOUT_MS || "9000",
      10
    );
    const configuredMargin = Number.parseInt(
      process.env.ALPACA_HEALTH_COMPLETION_MARGIN_MS || "750",
      10
    );
    const deadline = createOperationDeadline({
      timeoutMs: Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : 9000,
      completionMarginMs: Number.isFinite(configuredMargin) && configuredMargin >= 0
        ? configuredMargin
        : 750
    });
    const [account, clock] = await Promise.all([
      getAlpacaAccountSnapshot({ deadline }),
      getAlpacaMarketClock({ deadline })
    ]);
    print({
      ...paperEnvelope(),
      accountReachable: true,
      accountStatus: account.status,
      tradingBlocked: Boolean(account.tradingBlocked),
      transfersBlocked: Boolean(account.transfersBlocked),
      accountBlocked: Boolean(account.accountBlocked),
      marketClockReachable: true,
      marketOpen: Boolean(clock.isOpen),
      nextOpen: clock.nextOpen,
      nextClose: clock.nextClose,
      requestIds: { account: account.requestId, clock: clock.requestId },
      config: buildAlpacaConfigDiagnostic().config
    });
    return;
  }

  if (command === "alpaca:account") {
    print({ ...paperEnvelope(), ...(await getAlpacaAccountSnapshot()) });
    return;
  }

  if (command === "alpaca:positions") {
    const snapshot = await listAlpacaPositions();
    print({
      ...paperEnvelope(),
      readOnly: true,
      positions: snapshot.positions,
      requestId: snapshot.requestId
    });
    return;
  }

  if (command === "alpaca:orders") {
    const snapshot = await listAlpacaOpenOrders();
    print({
      ...paperEnvelope(),
      readOnly: true,
      orders: snapshot.orders,
      requestId: snapshot.requestId
    });
    return;
  }

  if (command === "alpaca:asset") {
    const symbol = normalizeSymbol(String(args.symbol || ""));
    if (!symbol) throw new Error("ALPACA_ASSET_SYMBOL_REQUIRED");
    const result = await checkAlpacaSymbolTradability(symbol);
    print({ ...paperEnvelope(), readOnly: true, ...result });
    return;
  }

  throw new Error(`POSTGRES_ONLY_RUNTIME_PATH_DISABLED: ${command || "missing command"}`);
};

try {
  assertPostgresOnlyCliCommand(command);
  await runPostgresScheduledCommand({ command, operation: run });
} catch (error) {
  if (error instanceof AlpacaOperationDeadlineError) {
    print({ error: { code: error.code, message: error.message }, deadline: error.metadata });
    process.exit(1);
  }
  if (error instanceof AlpacaApiError) {
    print({
      error: error.message,
      status: error.status,
      requestId: error.requestId,
      url: error.url,
      diagnostic: buildAlpacaConfigDiagnostic()
    });
    process.exit(1);
  }
  print({ error: error instanceof Error ? error.message : "An unexpected error occurred." });
  process.exit(1);
}
