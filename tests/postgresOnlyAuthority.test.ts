import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  DatabaseConfigurationError,
  loadDatabaseConfig
} from "../src/lib/database/config.js";
import {
  POSTGRES_ONLY_RUNTIME_PATH_DISABLED,
  PostgresOnlyRuntimeError,
  assertPostgresOnlyCliCommand,
  assertPostgresOnlyDatabaseAuthority,
  listSafePostgresOnlyCliCommands
} from "../src/lib/database/postgresOnlyRuntime.js";
import { getDb } from "../src/lib/db.js";
import {
  POSTGRES_AUTHORITY_BASELINE_TYPE,
  countOrderDiscrepancies,
  countPositionDiscrepancies,
  evaluatePostgresAuthorityState,
  mapBrokerSnapshotToExecutionProjection,
  type PostgresAuthorityState
} from "../src/services/postgresAuthorityCutoverService.js";
import type { PostgresAuthorityBrokerSnapshot } from "../src/services/postgresAuthorityBrokerSnapshot.js";

const postgresOnlyEnvironment = {
  DATABASE_BACKEND: "postgres",
  DATABASE_URL: "postgresql://synthetic:synthetic@pooled.example.invalid/alpaca",
  DATABASE_URL_UNPOOLED: "postgresql://synthetic:synthetic@direct.example.invalid/alpaca",
  POSTGRES_READS_ENABLED: "true",
  POSTGRES_WRITES_ENABLED: "true",
  POSTGRES_SHADOW_COMPARE_ENABLED: "false",
  POSTGRES_CONTROL_PLANE_AUTHORITY_ENABLED: "true",
  POSTGRES_SCHEDULER_AUTHORITY_ENABLED: "true",
  POSTGRES_EXECUTION_STATE_SHADOW_ENABLED: "false",
  POSTGRES_EXECUTION_STATE_AUTHORITY_ENABLED: "true",
  SQLITE_AUDIT_MIRROR_ENABLED: "false"
};

const validState: PostgresAuthorityState = {
  accountCount: 1,
  currentSnapshotCount: 1,
  brokerPositionCount: 24,
  postgresPositionCount: 24,
  positionDiscrepancyCount: 0,
  brokerOpenOrderCount: 0,
  postgresOpenOrderCount: 0,
  orderDiscrepancyCount: 0,
  activeReservationCount: 0,
  staleActiveReservationCount: 0,
  activeStrategyAllocationCount: 1,
  activeRiskLimitCount: 1,
  currentReviewCount: 0,
  staleReviewCount: 0,
  currentConfirmationCount: 0,
  staleConfirmationCount: 0,
  reviewConfirmationLinkDiscrepancyCount: 0,
  historicalReviewCount: 121,
  historicalConfirmationCount: 121,
  candidateCount: 6109,
  candidateLearningStateCount: 6109,
  recoveredResearchRunCount: 40,
  staleResearchRunCount: 0,
  retryableFailureCount: 0,
  unexpectedHeldLeaseCount: 0
};

test("application configuration requires the complete PostgreSQL-only authority set", () => {
  const config = loadDatabaseConfig(postgresOnlyEnvironment, {
    runtime: "vps",
    purpose: "application"
  });
  assert.equal(assertPostgresOnlyDatabaseAuthority(config), true);
  assert.equal(config.backend, "postgres");

  assert.throws(
    () => loadDatabaseConfig({ ...postgresOnlyEnvironment, DATABASE_BACKEND: "sqlite" }),
    (error) =>
      error instanceof DatabaseConfigurationError &&
      error.code === "POSTGRES_ONLY_AUTHORITY_REQUIRED"
  );
  assert.throws(
    () => loadDatabaseConfig({ ...postgresOnlyEnvironment, POSTGRES_SHADOW_COMPARE_ENABLED: "true" }),
    (error) =>
      error instanceof DatabaseConfigurationError &&
      error.code === "POSTGRES_ONLY_FALLBACK_DISABLED"
  );
});

test("ordinary runtime SQLite access is disabled", () => {
  assert.throws(
    () => getDb(),
    (error) =>
      error instanceof PostgresOnlyRuntimeError &&
      error.code === "RUNTIME_SQLITE_DISABLED"
  );
});

test("the SQLite fixture symbol cannot activate SQLite under production NODE_ENV", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./tests/helpers/enableSqliteFixtureInitialization.mjs",
      "--eval",
      "import('./src/lib/db.ts').then(({getDb}) => { try { getDb(); process.exit(7); } catch (error) { process.stdout.write(String(error.code || error.message)); } })"
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "production" }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "RUNTIME_SQLITE_DISABLED");
});

test("production CLI allows only broker reads, PostgreSQL authority, and audited worker operations", () => {
  assert.doesNotThrow(() => assertPostgresOnlyCliCommand("alpaca:positions"));
  assert.doesNotThrow(() => assertPostgresOnlyCliCommand("db:postgres:authority:status"));
  for (const command of [
    "db:migrate",
    "db:postgres:control-plane:backfill",
    "db:postgres:execution-state:reconcile",
    "paper:execute",
    "hedge:execute"
  ]) {
    assert.throws(
      () => assertPostgresOnlyCliCommand(command),
      (error) =>
        error instanceof PostgresOnlyRuntimeError &&
        error.code === POSTGRES_ONLY_RUNTIME_PATH_DISABLED
    );
  }
  const autonomous = new Set([
    "research:daily", "paper:review", "paper:portfolio:review",
    "paper:options:discover", "paper:ops:review", "paper:exit:review",
    "paper:exit:execute", "paper:execute:reviewed", "hedge:review",
    "hedge:exit:review", "hedge:exit:execute", "zero-dte:engine",
    "zero-dte:exit:review", "zero-dte:reconcile", "paper:learn",
    "system:recover", "worker:state"
  ]);
  assert.ok(listSafePostgresOnlyCliCommands().every((command) =>
    command.startsWith("alpaca:") || command.startsWith("db:postgres:") ||
    autonomous.has(command)
  ));
});

test("package scripts expose no SQLite migration, backfill, reconciliation, or mirror gate", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  for (const retired of [
    "db:migrate",
    "db:verify",
    "db:sqlite:wal-verify",
    "db:postgres:control-plane:snapshot",
    "db:postgres:control-plane:backfill",
    "db:postgres:control-plane:reconcile",
    "db:postgres:control-plane:shadow",
    "db:postgres:execution-state:backfill",
    "db:postgres:execution-state:reconcile",
    "db:postgres:execution-state:shadow"
  ]) {
    assert.equal(packageJson.scripts[retired], undefined, retired);
  }
  assert.equal(
    packageJson.scripts["db:postgres:authority:cutover"],
    "tsx src/postgresOnlyCli.ts db:postgres:authority:cutover"
  );
  assert.equal(packageJson.scripts.build, "tsc --project tsconfig.build.json");
  const buildConfig = readFileSync("tsconfig.build.json", "utf8");
  assert.match(buildConfig, /src\/postgresOnlyCli\.ts/);
  assert.match(buildConfig, /server\/dashboard-control\/server\.ts/);
  assert.match(buildConfig, /src\/cli\.ts/);
  assert.match(buildConfig, /src\/lib\/db\.ts/);
  const productionCli = readFileSync("src/postgresOnlyCli.ts", "utf8");
  assert.doesNotMatch(productionCli, /node:sqlite|src\/cli|src\/lib\/db/);
  for (const retired of ["paper:execute", "hedge:execute"]) {
    assert.equal(packageJson.scripts[retired], undefined, retired);
  }
  for (const restored of [
    "research:daily", "paper:review", "paper:portfolio:review",
    "paper:options:discover", "paper:ops:review", "paper:exit:review",
    "paper:exit:execute", "paper:execute:reviewed", "hedge:review",
    "hedge:exit:review", "hedge:exit:execute", "zero-dte:engine",
    "zero-dte:exit:review", "zero-dte:reconcile", "paper:learn",
    "system:recover", "worker:state"
  ]) {
    assert.equal(
      packageJson.scripts[restored],
      `tsx src/postgresOnlyCli.ts ${restored}`,
      restored
    );
  }
});

test("dashboard-control has no SQLite data module or database import", () => {
  const source = readFileSync("server/dashboard-control/server.ts", "utf8");
  assert.doesNotMatch(source, /node:sqlite|src\/lib\/db|apps\/dashboard\/lib\/data/);
  assert.match(source, /POSTGRES_ONLY_RUNTIME_PATH_DISABLED/);
  assert.match(source, /stopped_pending_audit/);
});

test("autonomous and timer runners remain blocked pending the runtime audit", () => {
  const worker = readFileSync("scripts/autonomous-paper-worker.mjs", "utf8");
  const monitor = readFileSync("scripts/paper-monitor-runner.mjs", "utf8");
  for (const source of [worker, monitor]) {
    assert.match(source, /AUTONOMOUS_RUNTIME_AUDIT_APPROVED/);
    assert.match(source, /EVIDENCE_UTILIZATION_RUNTIME_AUDIT_REQUIRED/);
    assert.doesNotMatch(source, /MARKET_OBSERVATORY_DB_PATH|RESEARCH_DB_PATH/);
  }
  assert.match(monitor, /POSTGRES_ONLY_RUNTIME_PATH_DISABLED/);
});

test("fresh baseline validation covers current risk, evidence, learning, and recovery state", () => {
  assert.equal(POSTGRES_AUTHORITY_BASELINE_TYPE, "fresh_postgresql_authority_cutover");
  assert.deepEqual(evaluatePostgresAuthorityState(validState), {
    status: "passed",
    discrepancies: []
  });
  const blocked = evaluatePostgresAuthorityState({
    ...validState,
    activeRiskLimitCount: 0,
    staleResearchRunCount: 1,
    positionDiscrepancyCount: 1
  });
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.discrepancies, [
    "BROKER_POSITION_STATE_MISMATCH",
    "ACTIVE_RISK_LIMIT_INVALID",
    "STALE_RESEARCH_RUN_PRESENT"
  ]);
});

test("authority comparison checks exact position and order identity and terms", () => {
  const brokerPosition = {
    brokerPositionKey: "equity:SPY",
    symbol: "SPY",
    underlyingSymbol: null,
    optionSymbol: null,
    assetClass: "equity" as const,
    side: "long" as const,
    quantity: 2,
    availableQuantity: 2,
    averageEntryPrice: 500,
    currentPrice: 510,
    marketValue: 1020,
    costBasis: 1000,
    unrealizedPnl: 20
  };
  const postgresPosition = {
    broker_position_key: "equity:SPY",
    symbol: "SPY",
    underlying_symbol: null,
    option_symbol: null,
    asset_class: "equity" as const,
    side: "long" as const,
    status: "open",
    quantity: "2",
    available_quantity: "2",
    average_entry_price: "500",
    current_price: "510",
    market_value: "1020",
    cost_basis: "1000",
    unrealized_pnl: "20"
  };
  assert.equal(countPositionDiscrepancies([brokerPosition], [postgresPosition]), 0);
  assert.equal(
    countPositionDiscrepancies([brokerPosition], [{ ...postgresPosition, cost_basis: "999" }]),
    1
  );

  const brokerOrder = {
    brokerOrderId: "broker-1",
    clientOrderId: "client-1",
    symbol: "SPY",
    assetClass: "equity" as const,
    side: "buy",
    orderType: "limit",
    timeInForce: "day",
    status: "accepted",
    quantity: 2,
    notional: null,
    limitPrice: 500
  };
  const postgresOrder = {
    broker_order_id: "broker-1",
    client_order_id: "client-1",
    symbol: "SPY",
    asset_class: "equity" as const,
    side: "buy",
    order_type: "limit",
    time_in_force: "day",
    status: "accepted",
    quantity: "2",
    notional: null,
    limit_price: "500"
  };
  assert.equal(countOrderDiscrepancies([brokerOrder], [postgresOrder]), 0);
  assert.equal(
    countOrderDiscrepancies([brokerOrder], [{ ...postgresOrder, limit_price: "501" }]),
    1
  );
});

test("authority projection preserves the full current broker position state", () => {
  const snapshot: PostgresAuthorityBrokerSnapshot = {
    capturedAt: "2026-07-20T12:00:00.000Z",
    accountIdentityHash: "account-hash",
    account: {
      status: "ACTIVE",
      currency: "USD",
      cash: 62_000,
      equity: 92_000,
      buyingPower: 283_000,
      optionsBuyingPower: 68_000,
      optionsApprovalLevel: 3,
      tradingBlocked: false,
      accountBlocked: false
    },
    configuration: {
      environment: "paper",
      tradingMode: "paper",
      liveTradingEnabled: false,
      paperOrderExecutionEnabled: false,
      paperOptionsExecutionEnabled: false,
      maxPositionNotional: 5_000,
      maxTotalPlanNotional: 30_000,
      equityMaxNotionalPerOrder: 5_000,
      equityMaxPortfolioDeployPct: 50,
      equityMaxPositionPct: 10,
      equityMinCashReservePct: 20,
      optionMaxOrderNotional: 1_500,
      optionMaxContracts: 1,
      optionMaxPortfolioRiskPct: 20,
      optionMaxPositionRiskPct: 5,
      quoteMaxAgeSeconds: 60,
      maxPriceDriftPct: 10,
      zeroDteMaxTradesPerDay: 3,
      zeroDteMaxDailyPremium: 750,
      zeroDteMaxDailyRealizedLoss: 250,
      zeroDteMaxOpenPositions: 3
    },
    configurationFingerprint: "config-fingerprint",
    positions: [{
      brokerPositionKey: "equity:SPY",
      symbol: "SPY",
      underlyingSymbol: null,
      optionSymbol: null,
      assetClass: "equity",
      side: "long",
      quantity: 2,
      availableQuantity: 1,
      averageEntryPrice: 500,
      currentPrice: 510,
      marketValue: 1020,
      costBasis: 1000,
      unrealizedPnl: 20
    }],
    orders: [],
    structuralPortfolioFingerprint: "structural-fingerprint",
    portfolioFingerprint: "portfolio-fingerprint"
  };
  const projection = mapBrokerSnapshotToExecutionProjection(snapshot);
  assert.deepEqual(projection.positions[0], {
    id: projection.positions[0]?.id,
    brokerPositionKey: "equity:SPY",
    candidateId: null,
    openingOrderId: null,
    closingOrderId: null,
    symbol: "SPY",
    underlyingSymbol: null,
    optionSymbol: null,
    assetClass: "equity",
    side: "long",
    quantity: "2.000000000000",
    availableQuantity: "1.000000000000",
    averageEntryPrice: "500.00000000",
    currentPrice: "510.00000000",
    marketValue: "1020.00000000",
    costBasis: "1000.00000000",
    unrealizedPnl: "20.00000000",
    realizedPnl: null,
    openedAt: snapshot.capturedAt
  });
});

test("authority cutover persists a running checkpoint and rolls back failed validation", () => {
  const source = readFileSync(
    "src/services/postgresAuthorityCutoverService.ts",
    "utf8"
  );
  const runningCheckpoint = source.indexOf("await createRunningCheckpoint({");
  const brokerCapture = source.indexOf(
    "await capturePostgresAuthorityBrokerSnapshot(capturedAt)"
  );
  assert.ok(runningCheckpoint >= 0 && brokerCapture > runningCheckpoint);
  assert.match(source, /status = 'blocked'[\s\S]*status = 'running'/);
  assert.match(source, /isolationLevel: "serializable"/);
  assert.match(
    source,
    /cleanupStaleRuntimeState\(client, capturedAt\)[\s\S]*syncAccountState\([\s\S]*readAuthorityState\(client/
  );
  assert.match(source, /throw new PostgresAuthorityValidationError/);
});

const collectImportGraph = (entry: string) => {
  const visited = new Set<string>();
  const visit = (path: string) => {
    if (visited.has(path)) return;
    visited.add(path);
    const source = readFileSync(path, "utf8");
    const imports = [...source.matchAll(/(?:from\s+|import\s*\()(["'])(\.{1,2}\/[^"']+)\1/g)]
      .map((match) => match[2]!);
    for (const specifier of imports) {
      const base = resolve(dirname(path), specifier.replace(/\.js$/, ""));
      const candidate = existsSync(`${base}.ts`) ? `${base}.ts` : base;
      if (existsSync(candidate)) visit(candidate);
    }
  };
  visit(resolve(entry));
  return [...visited];
};

test("enabled production import graphs contain no SQLite dependency", () => {
  for (const entry of [
    "src/postgresOnlyCli.ts",
    "src/services/postgresAuthorityCutoverService.ts",
    "src/services/postgresMarketDataService.ts",
    "src/services/postgresStockStreamPersistenceService.ts",
    "server/dashboard-control/server.ts"
  ]) {
    const graph = collectImportGraph(entry);
    assert.ok(graph.length > 1, entry);
    for (const path of graph) {
      const source = readFileSync(path, "utf8");
      assert.doesNotMatch(path, /\/src\/lib\/db\.ts$/, `${entry} -> ${path}`);
      assert.doesNotMatch(source, /node:sqlite/, `${entry} -> ${path}`);
    }
  }
});
