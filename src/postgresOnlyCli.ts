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
import { withPostgresTransaction } from "./lib/database/postgresTransaction.js";
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
import {
  runPostgresScheduledCommand,
  type PostgresScheduledCommandOperationContext
} from "./services/postgresScheduledCommandService.js";
import {
  AUTONOMOUS_WORKER_EVENT_TYPES,
  decodeAutonomousWorkerStatePayload,
  persistAutonomousWorkerState,
  type AutonomousWorkerEventType
} from "./services/autonomousWorkerStateService.js";
import { runAutonomousPostgresCommand } from "./services/autonomousPostgresCommandService.js";
import { runAutonomousPostgresExecutionCommand } from "./services/autonomousPostgresExecutionService.js";
import { capturePostgresAuthorityBrokerSnapshot } from "./services/postgresAuthorityBrokerSnapshot.js";
import { reconcilePostgresPaperOrders } from "./services/postgresReconciliationService.js";
import { runPostgresResearchWorkflow } from "./services/postgresResearchWorkflowService.js";
import { runPostgresReviewWorkflow } from "./services/postgresReviewWorkflowService.js";
import { paperSubmitConfiguration } from "./services/paperSubmitSafetyConfig.js";
import { submitPaperOrder } from "./services/alpacaClient.js";
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

const AUTONOMOUS_INSPECTION_COMMANDS = new Set([
  "paper:learn",
  "system:recover"
]);

const AUTONOMOUS_REVIEW_COMMANDS = new Set([
  "paper:review",
  "paper:portfolio:review",
  "paper:options:discover",
  "paper:ops:review",
  "paper:exit:review",
  "hedge:review",
  "hedge:exit:review",
  "zero-dte:exit:review"
]);

const AUTONOMOUS_EXECUTION_COMMANDS = new Set([
  "paper:exit:execute",
  "paper:execute:reviewed",
  "hedge:exit:execute",
  "zero-dte:engine"
]);

const requireScheduledContext = (
  context: PostgresScheduledCommandOperationContext | undefined
) => {
  if (!context) throw new Error("POSTGRES_SCHEDULER_CONTEXT_REQUIRED");
  return context;
};

const queryAdapter = (queryable: { query: (sql: string, values?: unknown[]) => Promise<unknown> }) => ({
  query: (sql: string, values?: readonly unknown[]) =>
    queryable.query(sql, values ? [...values] : undefined) as never
});

const run = async (scheduledContext?: PostgresScheduledCommandOperationContext) => {
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

  if (command === "worker:state") {
    const context = requireScheduledContext(scheduledContext);
    const eventType = String(args.eventType || "");
    if (!(AUTONOMOUS_WORKER_EVENT_TYPES as readonly string[]).includes(eventType)) {
      throw new Error("AUTONOMOUS_WORKER_EVENT_TYPE_INVALID");
    }
    const payload = decodeAutonomousWorkerStatePayload(String(args.payload || ""));
    const result = await persistAutonomousWorkerState(context.pool, context.config, {
      cycleId: String(args.cycleId || ""),
      eventType: eventType as AutonomousWorkerEventType,
      payload,
      occurredAt: String(args.occurredAt || new Date().toISOString())
    });
    print({ ...paperEnvelope(), command, ...result });
    return;
  }

  if (command === "zero-dte:reconcile") {
    const context = requireScheduledContext(scheduledContext);
    const result = await reconcilePostgresPaperOrders({
      query: queryAdapter(context.pool),
      fence: context.fence
    });
    print({ ...paperEnvelope(), command, ...result });
    if (result.errors.length > 0) process.exitCode = 1;
    return;
  }

  if (command === "paper:reconcile:external-order") {
    const context = requireScheduledContext(scheduledContext);
    const brokerOrderId = String(args.brokerOrderId || "").trim();
    if (!brokerOrderId) throw new Error("EXTERNAL_BROKER_ORDER_ID_REQUIRED");
    const result = await reconcilePostgresPaperOrders({
      query: queryAdapter(context.pool),
      fence: context.fence,
      externalBrokerOrderId: brokerOrderId
    });
    print({ ...paperEnvelope(), command, ...result });
    if (result.errors.length > 0) process.exitCode = 1;
    return;
  }

  if (command === "research:daily") {
    const context = requireScheduledContext(scheduledContext);
    const riskProfile = ["aggressive", "moderate", "conservative"].includes(String(args.riskProfile))
      ? String(args.riskProfile) as "aggressive" | "moderate" | "conservative"
      : "moderate";
    const maxCandidates = Math.max(1, Math.min(25, Number.parseInt(String(args.maxCandidates || "10"), 10) || 10));
    const result = await runPostgresResearchWorkflow({
      query: queryAdapter(context.pool),
      fence: context.fence,
      riskProfile,
      optionsEnabled: ["true", "1"].includes(String(args.optionsEnabled).toLowerCase()),
      maxCandidates
    });
    print({ ...paperEnvelope(), command, ...result });
    return;
  }

  if (command && AUTONOMOUS_REVIEW_COMMANDS.has(command)) {
    const context = requireScheduledContext(scheduledContext);
    const maxCandidates = Math.max(
      1,
      Math.min(25, Number.parseInt(String(args.maxCandidates || "25"), 10) || 25)
    );
    const result = await runPostgresReviewWorkflow({
      command,
      query: queryAdapter(context.pool),
      fence: context.fence,
      maxCandidates,
      ...(command === "paper:options:discover"
        ? {
            underlying: String(args.underlying || ""),
            dte: Number.parseInt(String(args.dte ?? ""), 10)
          }
        : {})
    });
    print({ ...paperEnvelope(), command, ...result });
    return;
  }

  if (command && AUTONOMOUS_INSPECTION_COMMANDS.has(command)) {
    const context = requireScheduledContext(scheduledContext);
    const result = await runAutonomousPostgresCommand({
      command,
      query: queryAdapter(context.pool),
      fence: context.fence
    });
    print({ ...paperEnvelope(), ...result });
    return;
  }

  if (command && AUTONOMOUS_EXECUTION_COMMANDS.has(command)) {
    const context = requireScheduledContext(scheduledContext);
    const safety = paperSubmitConfiguration();
    const result = await runAutonomousPostgresExecutionCommand({
      command,
      query: queryAdapter(context.pool),
      transaction: (operation) => withPostgresTransaction(
        context.pool,
        context.config,
        (client) => operation(queryAdapter(client))
      ),
      marketOpen: async () => Boolean((await getAlpacaMarketClock()).isOpen),
      captureBrokerSnapshot: capturePostgresAuthorityBrokerSnapshot,
      submitOrder: submitPaperOrder,
      fence: context.fence,
      safety: {
        environment: safety.environment,
        tradingMode: safety.tradingMode,
        liveTradingEnabled: safety.liveTradingEnabled,
        paperOrderExecutionEnabled: safety.paperOrderExecutionEnabled,
        paperOptionsExecutionEnabled: safety.paperOptionsExecutionEnabled,
        quoteMaxAgeSeconds: safety.quoteMaxAgeSeconds
      },
      confirmPaper: Object.prototype.hasOwnProperty.call(args, "confirmPaper")
    });
    print({ ...paperEnvelope(), command, ...result });
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
