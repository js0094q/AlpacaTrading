import { config as loadDotenv } from "dotenv";
loadDotenv();
loadDotenv({ path: ".env.txt", override: false });
import { addTicker, getActiveUniverse, getAllUniverse, removeTicker, setTickerEnabled, seedInitialUniverse } from "./services/universeService.js";
import { ingestBars } from "./services/marketDataIngest.js";
import { ingestOptionContracts, ingestOptionSnapshots } from "./services/optionsService.js";
import { buildFeatures } from "./services/featureService.js";
import { generateTargets, getTargets } from "./services/targetService.js";
import { runBacktest } from "./services/backtestService.js";
import { runLearning } from "./services/learningService.js";
import { runResearchDaily } from "./services/researchOrchestrator.js";
import { evaluatePaperTrades, buildResearchReport } from "./services/paperTradeService.js";
import {
  buildPaperOutcomeAnalytics,
  formatPaperOutcomeAnalyticsTable,
  persistRecommendationSnapshots,
  PAPER_RECOMMENDATION_SNAPSHOT_SOURCE_PAPER_ANALYTICS
} from "./services/paperOutcomeAnalyticsService.js";
import {
  formatPaperRecommendationSnapshotsAsTable,
  listPaperRecommendationSnapshots
} from "./services/paperRecommendationSnapshotService.js";
import {
  buildPaperRecommendationTrends,
  formatPaperRecommendationTrendsAsTable
} from "./services/paperTrendsService.js";
import {
  getAlpacaAccountSnapshot
} from "./services/alpacaAccountService.js";
import { buildAlpacaConfigDiagnostic } from "./services/alpacaConfigDiagnosticService.js";
import { getAlpacaMarketClock } from "./services/alpacaMarketClockService.js";
import { getTradingSafetyState } from "./services/tradingSafetyService.js";
import { listAlpacaOpenOrders } from "./services/alpacaOrderReadService.js";
import { checkAlpacaSymbolTradability } from "./services/alpacaAssetService.js";
import { listAlpacaPositions } from "./services/alpacaPositionService.js";
import {
  buildPaperIntelligenceReport,
  type PaperIntelReport
} from "./services/paperIntelService.js";
import {
  buildPaperPlanReport,
  formatPaperPlanReportAsTable
} from "./services/paperPlanService.js";
import {
  buildPaperReviewReport,
  formatPaperReviewReportAsTable
} from "./services/paperReviewService.js";
import {
  buildPaperExecuteConfirmPaperReport,
  buildPaperExecuteDryRunReport,
  formatPaperExecuteConfirmReportAsTable,
  formatPaperExecuteDryRunReportAsTable
} from "./services/paperExecuteDryRunService.js";
import { buildPaperReviewedPayloadExecutionReport } from "./services/paperReviewedPayloadExecutionService.js";
import {
  isReviewedPayloadSectionName,
  type ReviewedPayloadSectionName
} from "./services/paperReviewArtifactService.js";
import {
  buildPaperRuntimeReport,
  formatPaperRuntimeReportAsTable
} from "./services/paperRuntimeService.js";
import { buildOptionsDiagnosticReport } from "./services/optionsDiagnosticService.js";
import {
  buildPaperPortfolioReviewReport,
  formatPaperPortfolioReviewReportAsTable
} from "./services/paperPortfolioReviewService.js";
import {
  buildPaperOptionsDiscoveryReport,
  formatPaperOptionsDiscoveryReportAsTable
} from "./services/paperOptionsDiscoveryService.js";
import {
  formatPaperOpsWorkflowReportAsTable,
  runPaperOpsLateDay,
  runPaperOpsMidday,
  runPaperOpsMorning,
  runPaperOpsReview
} from "./services/paperOpsWorkflowService.js";
import {
  buildPromotionReadinessAnalytics,
  evaluatePaperLearningRecords,
  paperLearningSummary
} from "./services/paperLearningLedgerService.js";
import { config } from "./config.js";
import { normalizeSymbol } from "./lib/utils.js";
import { AlpacaApiError } from "./services/alpacaClient.js";

const parseArg = (input: string): Record<string, string> | null => {
  const [rawKey, rawValue] = input.split("=", 2);
  if (!rawKey.startsWith("--")) {
    return null;
  }
  return { [rawKey.slice(2)]: rawValue ?? "" };
};

const parseArgs = (argv: string[]) => {
  const output: Record<string, string | undefined> = {};
  argv.forEach((item) => {
    const parsed = parseArg(item);
    if (!parsed) {
      return;
    }
    const [key, value] = Object.entries(parsed)[0]!;
    output[key] = value;
  });
  return output;
};

const parseList = (value?: string) =>
  value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];

const command = process.argv[2];
const action = process.argv[3];
const subaction = process.argv[4];
const args = parseArgs(command?.includes(":") ? process.argv.slice(3) : process.argv.slice(4));

const print = (payload: unknown) => {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
};

const boolArg = (value?: string) => value === "true" || value === "1";
const flagArg = (value?: string) =>
  value !== undefined && (value === "" || boolArg(value));
const optionalBoolArg = (value?: string) =>
  value === undefined ? undefined : boolArg(value);
const toInt = (value?: string, fallback = 0) => (value ? Number.parseInt(value, 10) : fallback);
const toOptionalFloat = (value?: string) => (value === undefined ? undefined : Number.parseFloat(value));
const toPercent = (value: number) => `${(value * 100).toFixed(1)}%`;
const normalizeRiskProfile = (value?: string): "moderate" | "aggressive" | "conservative" | undefined => {
  return value === "aggressive" || value === "moderate" || value === "conservative"
    ? value
    : undefined;
};
const normalizePaperPlanFormat = (value?: string): "table" | "json" | undefined => {
  return value === "json" || value === "table" ? value : undefined;
};
const normalizeAssetClass = (value?: string): "all" | "equity" | "option" | undefined => {
  return value === "equity" || value === "option" || value === "all" ? value : undefined;
};
const normalizeReviewedPayloadSections = (value?: string): ReviewedPayloadSectionName[] | undefined => {
  const sections = parseList(value).filter(isReviewedPayloadSectionName);
  return sections.length ? sections : undefined;
};

const appendReportAnalyticsSection = (
  lines: string[],
  symbols: ReturnType<typeof buildPaperOutcomeAnalytics> & { supported: true },
  riskProfiles: ReturnType<typeof buildPaperOutcomeAnalytics> & { supported: true }
) => {
  lines.push("");
  lines.push("Paper Outcome Analytics");

  const topSymbols = [...symbols.groups].sort((left, right) => right.avgReturnPct - left.avgReturnPct).slice(0, 3);
  const weakestSymbols = [...symbols.groups].sort((left, right) => left.avgReturnPct - right.avgReturnPct).slice(0, 3);

  lines.push("Top symbols by average return:");
  if (!topSymbols.length) {
    lines.push("  No eligible symbols found.");
  } else {
    topSymbols.forEach((entry, index) => {
      lines.push(
        `${index + 1}. ${entry.key} | evaluated=${entry.evaluatedCount} | winRate=${toPercent(entry.winRate)} | avgReturn=${entry.avgReturnPct.toFixed(2)}%`
      );
    });
  }

  lines.push("Weakest symbols by average return:");
  if (!weakestSymbols.length) {
    lines.push("  No eligible symbols found.");
  } else {
    weakestSymbols.forEach((entry, index) => {
      lines.push(
        `${index + 1}. ${entry.key} | evaluated=${entry.evaluatedCount} | winRate=${toPercent(entry.winRate)} | avgReturn=${entry.avgReturnPct.toFixed(2)}%`
      );
    });
  }

  lines.push("Risk profile comparison:");
  if (!riskProfiles.groups.length) {
    lines.push("  No risk profile analytics available.");
    return;
  }
  riskProfiles.groups.forEach((entry) => {
    lines.push(
      `- ${entry.key} | evaluated=${entry.evaluatedCount} | winRate=${toPercent(entry.winRate)} | avgReturn=${entry.avgReturnPct.toFixed(2)}%`
    );
  });

  lines.push("UNEVALUATED backlog aging:");
  if (!symbols.backlogAging) {
    lines.push("  Backlog aging not available.");
    return;
  }
  lines.push(`  As of ${symbols.backlogAging.asOf}`);
  lines.push(`  Total unevaluated: ${symbols.backlogAging.totalUnevaluated}`);
  symbols.backlogAging.buckets.forEach((bucket) => {
    lines.push(`  ${bucket.bucket}: ${bucket.count}`);
  });

  if (symbols.rankingSlices) {
    const avgReturnSlice = symbols.rankingSlices.slices.find(
      (slice) => slice.metric === "avgReturnPct"
    );
    if (avgReturnSlice) {
      lines.push("Ranking slices (avgReturn):");
      const top = avgReturnSlice.top.slice(0, 3);
      const bottom = avgReturnSlice.bottom.slice(0, 3);
      lines.push("  Top:");
      if (!top.length) {
        lines.push("    No data");
      } else {
        top.forEach((entry, index) => {
          lines.push(
            `    ${index + 1}. ${entry.key} | ${entry.value.toFixed(2)}% | ${entry.recommendationFlag}`
          );
        });
      }
      lines.push("  Bottom:");
      if (!bottom.length) {
        lines.push("    No data");
      } else {
        bottom.forEach((entry, index) => {
          lines.push(
            `    ${index + 1}. ${entry.key} | ${entry.value.toFixed(2)}% | ${entry.recommendationFlag}`
          );
        });
      }
    }
  }
};

const formatPadded = (
  value: string,
  width: number,
  align: "left" | "right" = "left"
) => {
  const text = value === undefined || value === null ? "" : String(value);
  if (align === "right") {
    return text.padStart(width, " ");
  }
  return text.padEnd(width, " ");
};

const buildSafeBoolean = (value?: boolean) => (value ? "true" : "false");

const run = async () => {
  if (command === "universe") {
    if (action === "seed") {
      const result = await seedInitialUniverse();
      print(result);
      return;
    }
    if (action === "get") {
      print({ universe: getAllUniverse() });
      return;
    }
    if (action === "add") {
      const symbol = String(args.symbol || "");
      const assetClass = String(args.assetClass || "stock");
      const source = String(args.source || "manual_seed_2026_07_02");
      const row = await addTicker(symbol, assetClass, source);
      print({ added: row });
      return;
    }
    if (action === "set-enabled") {
      const symbol = String(args.symbol || "");
      const enabled = boolArg(String(args.enabled || "false"));
      await setTickerEnabled(symbol, enabled);
      print({ symbol, enabled });
      return;
    }
    if (action === "remove") {
      const symbol = String(args.symbol || "");
      removeTicker(symbol);
      print({ removed: symbol });
      return;
    }
  }

  if (command === "data" && action === "ingest") {
    const result = await ingestBars({
      symbols: parseList(args.symbols),
      timeframe: (args.timeframe as any) || "1Day",
      start: args.start,
      end: args.end
    });
    print(result);
    return;
  }

  if (command === "options" && action === "ingest") {
    const optionsRun = await ingestOptionContracts({
      underlyingSymbols: parseList(args.underlyingSymbols),
      minDaysToExpiration: args.minDaysToExpiration
        ? Number(args.minDaysToExpiration)
        : undefined,
      maxDaysToExpiration: args.maxDaysToExpiration
        ? Number(args.maxDaysToExpiration)
        : undefined
    });
    const snapshotRun = await ingestOptionSnapshots({
      underlyingSymbols: parseList(args.underlyingSymbols),
      minDaysToExpiration: args.minDaysToExpiration
        ? Number(args.minDaysToExpiration)
        : undefined,
      maxDaysToExpiration: args.maxDaysToExpiration
        ? Number(args.maxDaysToExpiration)
        : undefined,
      minDelta: args.minDelta ? Number(args.minDelta) : undefined,
      maxDelta: args.maxDelta ? Number(args.maxDelta) : undefined
    });
    print({ contracts: optionsRun, snapshots: snapshotRun });
    return;
  }

  if (command === "options:diagnose") {
    const result = await buildOptionsDiagnosticReport({
      underlyings: parseList(args.underlyings),
      asOfDate: args.asOfDate,
      leapsMinDte: args.leapsMinDte ? Number(args.leapsMinDte) : undefined,
      leapsMaxDte: args.leapsMaxDte ? Number(args.leapsMaxDte) : undefined,
      sampleSize: args.sampleSize ? Number(args.sampleSize) : undefined
    });
    print(result);
    return;
  }

  if (command === "features" && action === "build") {
    const result = await buildFeatures({
      symbols: parseList(args.symbols),
      timeframe: (args.timeframe as any) || "1Day",
      start: args.start,
      end: args.end
    });
    print(result);
    return;
  }

  if (command === "targets" && action === "generate") {
    const result = await generateTargets({
      riskProfile: (args.riskProfile as any) || undefined,
      optionsOnly: boolArg(args.optionsOnly)
    });
    print(result);
    return;
  }

  if (command === "targets" && action === "list") {
    const riskProfile = args.riskProfile as any;
    const optionsOnly = boolArg(args.optionsOnly);
    print({ targets: getTargets(riskProfile, optionsOnly) });
    return;
  }

  if (command === "backtest" && action === "run") {
    const result = await runBacktest({
      startDate: args.start,
      endDate: args.end,
      initialCapital: args.initialCapital
        ? Number(args.initialCapital)
        : undefined,
      maxPositions: args.maxPositions ? Number(args.maxPositions) : undefined,
      positionSize: args.positionSize ? Number(args.positionSize) : undefined,
      holdingPeriod: args.holdingPeriod ? Number(args.holdingPeriod) : undefined,
      longEnabled: args.longEnabled ? boolArg(args.longEnabled) : undefined,
      shortEnabled: args.shortEnabled ? boolArg(args.shortEnabled) : undefined,
      optionsEnabled: args.optionsEnabled ? boolArg(args.optionsEnabled) : undefined,
      aggressiveMode: args.aggressiveMode ? boolArg(args.aggressiveMode) : undefined,
      stopLoss: args.stopLoss ? Number(args.stopLoss) : undefined,
      takeProfit: args.takeProfit ? Number(args.takeProfit) : undefined,
      trailingStop: args.trailingStop ? Number(args.trailingStop) : undefined,
      maxLossPerTrade: args.maxLossPerTrade
        ? Number(args.maxLossPerTrade)
        : undefined,
      maxNotionalPerTrade: args.maxNotionalPerTrade
        ? Number(args.maxNotionalPerTrade)
        : undefined
    });
    print(result);
    return;
  }

  if (command === "learn" && action === "run") {
    const horizon = (args.horizon || "1d") as "1d" | "5d" | "20d";
    const result = await runLearning(horizon);
    print(result);
    return;
  }

  if (command === "research" && action === "daily") {
    const riskProfile = (args.riskProfile as "aggressive" | "conservative" | "moderate") || undefined;
    const optionsEnabled = boolArg(args.optionsEnabled);
    const maxCandidates = toInt(args.maxCandidates, 10);
    const maxPerSymbol = toInt(args.maxPerSymbol, 0);
    const maxPerDirection = toInt(args.maxPerDirection, 0);
    const maxPerExpression = toInt(args.maxPerExpression, 0);
    const requireSectorDiversity = boolArg(args.requireSectorDiversity);
    const useAlpacaAssets = boolArg(args.useAlpacaAssets);
    const barLookbackDays = toInt(args.barLookbackDays, 365);
    const result = await runResearchDaily({
      riskProfile,
      optionsEnabled,
      maxCandidates,
      maxPerSymbol,
      maxPerDirection,
      maxPerExpression,
      requireSectorDiversity,
      useAlpacaAssets,
      barLookbackDays
    });
    if (args.format === "json") {
      print({
        ...result,
        paperOnly: true,
        environment: "paper"
      });
      return;
    }
    const lines = [
      `Research run completed: ${result.runId}`,
      `Paper only: true`,
      `Environment: paper`,
      `Universe size: ${result.universeSize}`,
      `Bar lookback days: ${result.barLookbackDays}`,
      `Bar lookback start: ${result.barLookbackStart}`,
      `Targets generated: ${result.targetsGenerated}`,
      `Candidates selected: ${result.candidatesSelected}`,
      `Aggressive Mode: ${result.riskProfile === "aggressive" ? "YES" : "NO"}`,
      `Options enabled: ${result.optionsEnabled ? "YES" : "NO"}`
    ];
    if (result.alpacaAssetFilter) {
      lines.push("Alpaca paper asset filter: enabled");
      lines.push(`Candidates checked: ${result.alpacaAssetFilter.checked}`);
      lines.push(`Tradable candidates retained: ${result.alpacaAssetFilter.retained}`);
      if (result.alpacaAssetFilter.excluded.length) {
        lines.push("Excluded candidates:");
        result.alpacaAssetFilter.excluded.forEach((entry) => {
          lines.push(`- ${entry.symbol}: ${entry.reason}`);
        });
      }
    }
    if (result.warnings.length) {
      lines.push("Warnings:");
      result.warnings.forEach((warning) => lines.push(`- ${warning}`));
    }
    if (result.riskProfile === "aggressive") {
      lines.push("AGGRESSIVE PAPER STRATEGY, NOT LIVE-TRADING APPROVED");
    }
    print(lines.join("\n"));
    return;
  }

  if (command === "alpaca:config") {
    const diagnostic = buildAlpacaConfigDiagnostic();
    print(diagnostic);
    return;
  }

  if (command === "alpaca:health") {
    const format = args.format;
    const state = getTradingSafetyState();
    const diagnostic = buildAlpacaConfigDiagnostic();
    const account = await getAlpacaAccountSnapshot();
    const clock = await getAlpacaMarketClock();

    if (format === "json") {
      print({
        paperOnly: state.paperOnly,
        environment: state.alpacaEnv,
        liveTradingEnabled: state.liveTradingEnabled,
        mutationAllowed: state.mutationAllowed,
        liveMutationAllowed: state.liveMutationAllowed,
        accountReachable: Boolean(account),
        accountStatus: account.status,
        tradingBlocked: Boolean(account.tradingBlocked),
        transfersBlocked: Boolean(account.transfersBlocked),
        accountBlocked: Boolean(account.accountBlocked),
        marketClockReachable: Boolean(clock),
        marketOpen: Boolean(clock.isOpen),
        nextOpen: clock.nextOpen,
        nextClose: clock.nextClose,
        requestIds: {
          account: account.requestId,
          clock: clock.requestId
        },
        config: diagnostic.config
      });
      return;
    }

    print([
      "ALPACA PAPER API HEALTH CHECK",
      `Environment: ${state.alpacaEnv}`,
      `Paper only: ${buildSafeBoolean(state.paperOnly)}`,
      `Live trading enabled: ${buildSafeBoolean(state.liveTradingEnabled)}`,
      `Mutation allowed: ${buildSafeBoolean(state.mutationAllowed)}`,
      `Live mutation allowed: ${buildSafeBoolean(state.liveMutationAllowed)}`,
      `Account reachable: true`,
      `Account status: ${account.status || "unknown"}`,
      `Trading blocked: ${buildSafeBoolean(Boolean(account.tradingBlocked))}`,
      `Transfers blocked: ${buildSafeBoolean(Boolean(account.transfersBlocked))}`,
      `Account blocked: ${buildSafeBoolean(Boolean(account.accountBlocked))}`,
      `Market clock reachable: true`,
      `Market open: ${buildSafeBoolean(Boolean(clock.isOpen))}`,
      `Next open: ${clock.nextOpen || ""}`,
      `Next close: ${clock.nextClose || ""}`,
      "Recent request IDs:",
      `- account: ${account.requestId || ""}`,
      `- clock: ${clock.requestId || ""}`
    ].join("\n"));
    return;
  }

  if (command === "alpaca:account") {
    const format = args.format;
    const state = getTradingSafetyState();
    const snapshot = await getAlpacaAccountSnapshot();

    if (format === "json") {
      print({
        paperOnly: state.paperOnly,
        environment: state.alpacaEnv,
        liveTradingEnabled: state.liveTradingEnabled,
        ...snapshot
      });
      return;
    }

    print([
      "ALPACA PAPER ACCOUNT SNAPSHOT",
      `Environment: ${state.alpacaEnv}`,
      `Paper only: ${buildSafeBoolean(state.paperOnly)}`,
      `Live trading enabled: ${buildSafeBoolean(state.liveTradingEnabled)}`,
      `Status: ${snapshot.status || "unknown"}`,
      `Currency: ${snapshot.currency || ""}`,
      `Cash: ${snapshot.cash || ""}`,
      `Equity: ${snapshot.equity || ""}`,
      `Last equity: ${snapshot.lastEquity || ""}`,
      `Portfolio value: ${snapshot.portfolioValue || ""}`,
      `Buying power: ${snapshot.buyingPower || ""}`,
      `Reg-T buying power: ${snapshot.regtBuyingPower || ""}`,
      `Daytrading buying power: ${snapshot.daytradingBuyingPower || ""}`,
      `Non-marginable buying power: ${snapshot.nonMarginableBuyingPower || ""}`,
      `Pattern day trader: ${buildSafeBoolean(snapshot.patternDayTrader)}`,
      `Daytrade count: ${snapshot.daytradeCount ?? 0}`,
      `Trading blocked: ${buildSafeBoolean(Boolean(snapshot.tradingBlocked))}`,
      `Transfers blocked: ${buildSafeBoolean(Boolean(snapshot.transfersBlocked))}`,
      `Account blocked: ${buildSafeBoolean(Boolean(snapshot.accountBlocked))}`,
      `Request ID: ${snapshot.requestId || ""}`
    ].join("\n"));
    return;
  }

  if (command === "alpaca:positions") {
    const format = args.format;
    const state = getTradingSafetyState();
    const snapshot = await listAlpacaPositions();

    if (format === "json") {
      print({
        paperOnly: state.paperOnly,
        environment: state.alpacaEnv,
        positions: snapshot.positions,
        requestId: snapshot.requestId
      });
      return;
    }

    if (!snapshot.positions.length) {
      print([
        "ALPACA PAPER POSITIONS",
        `Environment: ${state.alpacaEnv}`,
        `Paper only: ${buildSafeBoolean(state.paperOnly)}`,
        "No open paper positions."
      ].join("\n"));
      return;
    }

    const lines = [
      "ALPACA PAPER POSITIONS",
      `Environment: ${state.alpacaEnv}`,
      `Paper only: ${buildSafeBoolean(state.paperOnly)}`
    ];
    lines.push(
      [
        formatPadded("Symbol", 10),
        formatPadded("Qty", 10, "right"),
        formatPadded("Market Value", 14, "right"),
        formatPadded("Cost Basis", 12, "right"),
        formatPadded("Unrealized P/L", 14, "right"),
        formatPadded("Unrealized P/L %", 16, "right")
      ].join(" ")
    );
    snapshot.positions.forEach((position) => {
      const marketValue = Number(position.marketValue || 0);
      const costBasis = Number(position.costBasis || 0);
      const unrealizedPl = Number(position.unrealizedPl || 0);
      const unrealizedPlpc = Number(position.unrealizedPlpc || 0) * 100;
      lines.push([
        formatPadded(position.symbol, 10),
        formatPadded(position.qty || "", 10, "right"),
        formatPadded(marketValue.toFixed(2), 14, "right"),
        formatPadded(costBasis.toFixed(2), 12, "right"),
        formatPadded(unrealizedPl.toFixed(2), 14, "right"),
        formatPadded(`${unrealizedPlpc.toFixed(2)}%`, 16, "right")
      ].join(" "));
    });
    lines.push(`Request ID: ${snapshot.requestId || ""}`);
    print(lines.join("\n"));
    return;
  }

  if (command === "alpaca:orders") {
    const format = args.format;
    const state = getTradingSafetyState();
    const snapshot = await listAlpacaOpenOrders();

    if (format === "json") {
      print({
        paperOnly: state.paperOnly,
        readOnly: true,
        environment: state.alpacaEnv,
        orders: snapshot.orders,
        requestId: snapshot.requestId
      });
      return;
    }

    if (!snapshot.orders.length) {
      print([
        "ALPACA PAPER OPEN ORDERS",
        `Environment: ${state.alpacaEnv}`,
        `Paper only: ${buildSafeBoolean(state.paperOnly)}`,
        "Read-only: true",
        "No open paper orders."
      ].join("\n"));
      return;
    }

    const lines = [
      "ALPACA PAPER OPEN ORDERS",
      `Environment: ${state.alpacaEnv}`,
      `Paper only: ${buildSafeBoolean(state.paperOnly)}`,
      "Read-only: true"
    ];
    lines.push(
      [
        formatPadded("ID", 10),
        formatPadded("Symbol", 10),
        formatPadded("Side", 6),
        formatPadded("Type", 14),
        formatPadded("Qty/Notional", 16),
        formatPadded("Status", 12),
        formatPadded("Submitted", 20)
      ].join(" ")
    );
    snapshot.orders.forEach((order) => {
      const size = order.qty || order.notional || "";
      lines.push([
        formatPadded(order.id, 10),
        formatPadded(order.symbol, 10),
        formatPadded(order.side || "", 6),
        formatPadded(order.type || "", 14),
        formatPadded(size, 16),
        formatPadded(order.status || "", 12),
        formatPadded(order.submittedAt || "", 20)
      ].join(" "));
    });
    lines.push(`Request ID: ${snapshot.requestId || ""}`);
    print(lines.join("\n"));
    return;
  }

  if (command === "alpaca:asset") {
    const format = args.format;
    const state = getTradingSafetyState();
    const symbol = normalizeSymbol(String(args.symbol || ""));

    if (!symbol) {
      print({
        error: "Missing required --symbol argument."
      });
      process.exitCode = 1;
      return;
    }

    const result = await checkAlpacaSymbolTradability(symbol);
    if (format === "json") {
      print({
        paperOnly: state.paperOnly,
        environment: state.alpacaEnv,
        symbol: result.symbol,
        tradable: result.tradable,
        reason: result.reason,
        requestId: result.requestId
      });
      return;
    }

    if (!result.asset) {
      print([
        "ALPACA PAPER ASSET CHECK",
        `Symbol: ${result.symbol}`,
        `Reason: ${result.reason || "unknown"}`
      ].join("\n"));
      process.exitCode = 1;
      return;
    }

    const asset = result.asset;
    print([
      "ALPACA PAPER ASSET CHECK",
      `Symbol: ${asset.symbol}`,
      `Name: ${asset.name || ""}`,
      `Class: ${asset.class || ""}`,
      `Exchange: ${asset.exchange || ""}`,
      `Status: ${asset.status || ""}`,
      `Tradable: ${buildSafeBoolean(Boolean(asset.tradable))}`,
      `Marginable: ${buildSafeBoolean(Boolean(asset.marginable))}`,
      `Shortable: ${buildSafeBoolean(Boolean(asset.shortable))}`,
      `Easy to borrow: ${buildSafeBoolean(Boolean(asset.easyToBorrow))}`,
      `Fractionable: ${buildSafeBoolean(Boolean(asset.fractionable))}`,
      `Request ID: ${result.requestId || ""}`
    ].join("\n"));
    return;
  }

  if (command === "paper" && action === "evaluate") {
    const horizon = (args.horizon || "5d") as "1d" | "5d" | "20d";
    const result = evaluatePaperTrades({
      asOf: args.asOf,
      horizon
    });
    print(result);
    return;
  }

  if (command === "paper" && action === "analytics") {
    const format = args.format;
    const topN = toInt(args.topN, 0);
    const bottomN = toInt(args.bottomN, 0);
    const includeRankingSlices =
      boolArg(args.includeRankingSlices) || topN > 0 || bottomN > 0;
    const includeBacklogAging = args.includeBacklogAging !== "false";
    const persistSnapshots = boolArg(args.persistSnapshots);
    const result = buildPaperOutcomeAnalytics({
      groupBy: args.groupBy,
      since: args.since,
      until: args.until,
      minEvaluations: toInt(args.minEvaluations, 1),
      topN,
      bottomN,
      includeRankingSlices,
      includeBacklogAging
    });
    const snapshotResult = persistSnapshots && result.supported
      ? persistRecommendationSnapshots({
          result,
          source:
            args.snapshotSource ||
            PAPER_RECOMMENDATION_SNAPSHOT_SOURCE_PAPER_ANALYTICS,
          snapshotRunId: args.snapshotRunId
        })
      : null;

    if (format === "json") {
      print({
        ...result,
        persistedRecommendationSnapshots: snapshotResult,
        persistRequested: persistSnapshots
      });
      return;
    }
    const output = formatPaperOutcomeAnalyticsTable(result);
    if (snapshotResult && result.supported) {
      print([
        output,
        "",
        `Recommendation snapshots persisted: ${snapshotResult.persistedCount}`,
        `Snapshot run: ${snapshotResult.snapshotRunId}`
      ].join("\n"));
      return;
    }
    print(output);
    return;
  }

  if (command === "paper:learn" || (command === "paper" && (action === "learn" || action === "learning"))) {
    const format = args.format;
    const evaluation = evaluatePaperLearningRecords({
      limit: toInt(args.limit, 100),
      asOf: args.asOf
    });
    const promotionReadiness = buildPromotionReadinessAnalytics();
    const summary = paperLearningSummary();

    if (format === "json") {
      print({
        paperOnly: true,
        environment: getTradingSafetyState().alpacaEnv,
        evaluation,
        learningSummary: summary,
        promotionReadiness
      });
      return;
    }

    const lines = [
      "Paper Learning Ledger",
      `Environment: ${getTradingSafetyState().alpacaEnv}`,
      `Evaluated this run: ${evaluation.evaluated}`,
      `Still pending this run: ${evaluation.stillPending}`,
      `Ledger pending: ${summary.pending}`,
      `Ledger evaluated: ${summary.evaluated}`,
      "Promotion readiness:"
    ];
    promotionReadiness.forEach((entry) => {
      lines.push(
        `- ${entry.strategyFamily}: eligible=${buildSafeBoolean(entry.eligibleForLiveReview)}, trades=${entry.totalTrades}, evaluated=${entry.evaluatedTrades}, liveLikePF=${entry.profitFactorLiveLike}, blockers=${entry.blockReasons.join(", ") || "none"}`
      );
    });
    if (evaluation.pendingReasons.length) {
      lines.push("Pending reasons:");
      evaluation.pendingReasons.slice(0, 10).forEach((entry) => {
        lines.push(`- ${entry.id}: ${entry.reason}`);
      });
    }
    print(lines.join("\n"));
    return;
  }

  if (command === "paper" && action === "snapshots") {
    const format = args.format;
    const result = listPaperRecommendationSnapshots({
      runId: args.runId,
      source: args.source,
      symbol: args.symbol,
      riskProfile: args.riskProfile,
      optionsEnabled: optionalBoolArg(args.optionsEnabled),
      from: args.from,
      to: args.to,
      limit: toInt(args.limit, 20)
    });

    if (format === "json") {
      print({
        paperOnly: true,
        environment: getTradingSafetyState().alpacaEnv,
        snapshots: result
      });
      return;
    }

    print(formatPaperRecommendationSnapshotsAsTable(result));
    return;
  }

  if (command === "paper" && action === "trends") {
    const format = args.format;
    const result = buildPaperRecommendationTrends({
      symbol: args.symbol,
      riskProfile: args.riskProfile,
      optionsEnabled: optionalBoolArg(args.optionsEnabled),
      from: args.from,
      to: args.to,
      limit: toInt(args.limit, 20)
    });

    if (format === "json") {
      print(result);
      return;
    }
    print(formatPaperRecommendationTrendsAsTable(result.trends));
    return;
  }

  if (command === "paper" && action === "runtime") {
    const format = args.format;
    const result = await buildPaperRuntimeReport({
      riskProfile: args.riskProfile,
      optionsEnabled: optionalBoolArg(args.optionsEnabled),
      maxCandidates: toInt(args.maxCandidates, 10)
    });
    if (format === "json") {
      print(result);
      return;
    }
    print(formatPaperRuntimeReportAsTable(result));
    return;
  }

  if (
    command === "paper:portfolio:review" ||
    command === "paper:exit:review" ||
    (command === "paper" && action === "portfolio" && subaction === "review")
  ) {
    const format = args.format;
    const result = await buildPaperPortfolioReviewReport({
      moment:
        args.moment === "morning" ||
        args.moment === "midday" ||
        args.moment === "late_day" ||
        args.moment === "manual"
          ? args.moment
          : "manual"
    });

    if (format === "json") {
      print(result);
      return;
    }

    print(formatPaperPortfolioReviewReportAsTable(result));
    return;
  }

  if (
    command === "paper:options:discover" ||
    (command === "paper" && action === "options" && subaction === "discover")
  ) {
    const format = args.format;
    const underlyings = args.underlyings ? parseList(args.underlyings) : undefined;
    const result = await buildPaperOptionsDiscoveryReport({
      underlying: args.underlying,
      underlyings,
      dte: toInt(args.dte, 0),
      allowNextSessionPreparation:
        args.nextSessionPreparation === undefined
          ? undefined
          : boolArg(args.nextSessionPreparation)
    });

    if (format === "json") {
      print(result);
      return;
    }

    print(formatPaperOptionsDiscoveryReportAsTable(result));
    return;
  }

  if (
    command === "paper:ops:morning" ||
    (command === "paper" && action === "ops" && subaction === "morning")
  ) {
    const format = args.format;
    const result = await runPaperOpsMorning({ triggerSource: "cli" });
    if (format === "json") {
      print(result);
      return;
    }
    print(formatPaperOpsWorkflowReportAsTable(result));
    return;
  }

  if (
    command === "paper:ops:midday" ||
    (command === "paper" && action === "ops" && subaction === "midday")
  ) {
    const format = args.format;
    const result = await runPaperOpsMidday({ triggerSource: "cli" });
    if (format === "json") {
      print(result);
      return;
    }
    print(formatPaperOpsWorkflowReportAsTable(result));
    return;
  }

  if (
    command === "paper:ops:late-day" ||
    command === "paper:ops:late_day" ||
    (command === "paper" && action === "ops" && (subaction === "late-day" || subaction === "late_day"))
  ) {
    const format = args.format;
    const result = await runPaperOpsLateDay({ triggerSource: "cli" });
    if (format === "json") {
      print(result);
      return;
    }
    print(formatPaperOpsWorkflowReportAsTable(result));
    return;
  }

  if (
    command === "paper:ops:review" ||
    (command === "paper" && action === "ops" && subaction === "review")
  ) {
    const format = args.format;
    const result = await runPaperOpsReview({ triggerSource: "cli" });
    if (format === "json") {
      print(result);
      return;
    }
    print(formatPaperOpsWorkflowReportAsTable(result));
    return;
  }

  if (command === "paper:execute:reviewed") {
    const format = args.format;
    const result = await buildPaperReviewedPayloadExecutionReport({
      confirmPaper: flagArg(args.confirmPaper),
      expectedPayloadSignature: args.expectedPayloadSignature,
      sections: normalizeReviewedPayloadSections(args.sections)
    });

    if (format === "json") {
      print(result);
      return;
    }

    print([
      "Paper Execute Reviewed Payloads",
      `Status: ${result.status}`,
      `Reason: ${result.reason || "none"}`,
      `Artifact: ${result.artifactId || "none"}`,
      `Reviewed payloads: ${result.summary.reviewedPayloads}`,
      `Submitted: ${result.summary.submitted}`,
      `Blocked: ${result.summary.blocked}`,
      `Errors: ${result.summary.errors}`,
      "Reviewed-payload execution is paper-only and requires --confirmPaper."
    ].join("\n"));
    return;
  }

  if (command === "paper:plan" || (command === "paper" && action === "plan")) {
    const format = args.format;
    const result = await buildPaperPlanReport({
      riskProfile: normalizeRiskProfile(args.riskProfile),
      optionsEnabled: optionalBoolArg(args.optionsEnabled),
      maxCandidates: toInt(args.maxCandidates),
      maxNewPositions: toInt(args.maxNewPositions),
      maxPositionNotional: toInt(args.maxPositionNotional),
      maxTotalPlanNotional: toInt(args.maxTotalPlanNotional),
      minBuyingPowerReservePct: toOptionalFloat(args.minBuyingPowerReservePct),
      format: normalizePaperPlanFormat(format)
    });

    if (format === "json") {
      print(result);
      return;
    }

    print(formatPaperPlanReportAsTable(result));
    return;
  }

  if (command === "paper:review" || (command === "paper" && action === "review")) {
    const format = args.format;
    const result = await buildPaperReviewReport({
      riskProfile: normalizeRiskProfile(args.riskProfile),
      optionsEnabled: optionalBoolArg(args.optionsEnabled),
      maxCandidates: toInt(args.maxCandidates),
      maxNewPositions: toInt(args.maxNewPositions),
      maxPositionNotional: toInt(args.maxPositionNotional),
      maxTotalPlanNotional: toInt(args.maxTotalPlanNotional),
      minBuyingPowerReservePct: toOptionalFloat(args.minBuyingPowerReservePct),
      maxPlanAgeMinutes: toOptionalFloat(args.maxPlanAgeMinutes),
      maxBuyingPowerUsePct: toOptionalFloat(args.maxBuyingPowerUsePct),
      format: normalizePaperPlanFormat(format)
    });

    if (format === "json") {
      print(result);
      return;
    }

    print(formatPaperReviewReportAsTable(result));
    return;
  }

  if (command === "paper:execute" || (command === "paper" && action === "execute")) {
    const format = args.format;
    const dryRun = flagArg(args.dryRun) || flagArg(args["dry-run"]);
    const confirmPaper = flagArg(args.confirmPaper);
    const executeInput = {
      dryRun,
      confirmPaper,
      assetClass: normalizeAssetClass(args.assetClass),
      riskProfile: normalizeRiskProfile(args.riskProfile),
      optionsEnabled: optionalBoolArg(args.optionsEnabled),
      maxCandidates: toInt(args.maxCandidates),
      maxNewPositions: toInt(args.maxNewPositions),
      maxPositionNotional: toInt(args.maxPositionNotional),
      maxTotalPlanNotional: toInt(args.maxTotalPlanNotional),
      minBuyingPowerReservePct: toOptionalFloat(args.minBuyingPowerReservePct),
      maxPlanAgeMinutes: toOptionalFloat(args.maxPlanAgeMinutes),
      maxBuyingPowerUsePct: toOptionalFloat(args.maxBuyingPowerUsePct),
      format: normalizePaperPlanFormat(format)
    };

    if (confirmPaper) {
      const result = await buildPaperExecuteConfirmPaperReport(executeInput);
      if (format === "json") {
        print(result);
      } else {
        print(formatPaperExecuteConfirmReportAsTable(result));
      }
      if (result.errors.length > 0) {
        process.exitCode = 1;
      }
      return;
    }

    const result = await buildPaperExecuteDryRunReport(executeInput);

    if (format === "json") {
      print(result);
    } else {
      print(formatPaperExecuteDryRunReportAsTable(result));
    }

    if (result.blockers.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "paper" && action === "intel") {
    const format = args.format;
    const result: PaperIntelReport = await buildPaperIntelligenceReport({
      riskProfile: args.riskProfile,
      optionsEnabled: optionalBoolArg(args.optionsEnabled),
      from: args.from,
      to: args.to,
      maxCandidates: toInt(args.maxCandidates, 10),
      snapshotLimit: toInt(args.limit, 20),
      trendLimit: toInt(args.limit, 20)
    });

    if (format === "json") {
      print(result);
      return;
    }
    const lines = [
      `Paper Intelligence Report (environment ${result.environment})`,
      `Paper Only: ${buildSafeBoolean(result.paperOnly)}`,
      "",
      formatPaperRecommendationSnapshotsAsTable(result.snapshots),
      "",
      formatPaperRecommendationTrendsAsTable(result.trends),
      "",
      formatPaperRuntimeReportAsTable(result.runtime)
    ];
    print(lines.join("\n"));
    return;
  }

  if (command === "research" && action === "report") {
    const runId = args.runId;
    const format = args.format;
    const includeAnalytics = boolArg(args.includeAnalytics);
    const report = buildResearchReport({ runId });

    const symbolAnalytics = includeAnalytics
      ? buildPaperOutcomeAnalytics({
          groupBy: "symbol",
          includeRankingSlices: true,
          topN: 3,
          bottomN: 3,
          includeBacklogAging: true
        })
      : null;
    const riskProfileAnalytics = includeAnalytics
      ? buildPaperOutcomeAnalytics({ groupBy: "riskProfile" })
      : null;

    if (format === "json") {
      print({
        ...report,
        analytics: includeAnalytics
          ? {
              paperOnly: true,
              symbol: symbolAnalytics,
              riskProfile: riskProfileAnalytics
            }
          : undefined
      });
      return;
    }
    const lines = [
      `Research Run Summary`,
      `Run ID: ${report.run.id}`,
      `Date: ${report.run.date}`,
      `Universe Size: ${report.run.universeSize}`,
      `Targets Generated: ${report.run.targetsGenerated}`,
      `Candidates Selected: ${report.run.candidatesSelected}`,
      `Aggressive Mode: ${report.run.riskProfile === "aggressive" ? "YES" : "NO"}`,
      `Options Enabled: ${report.run.optionsEnabled ? "YES" : "NO"}`,
      `Status: ${report.run.status}`
    ];
    if (report.run.warnings.length) {
      lines.push("Warnings:");
      report.run.warnings.forEach((warning) => lines.push(`- ${warning}`));
    }
    lines.push("");
    lines.push("Top Candidates:");
    report.topCandidates.forEach((candidate) => {
      lines.push(
        `${candidate.rank}. ${candidate.symbol} | ${candidate.direction} | ${candidate.expression} | score ${candidate.score.toFixed(1)}`
      );
    });
    lines.push("");
    lines.push("Best Learning Signals:");
    report.bestLearningSignals.forEach((entry) => lines.push(`- ${entry}`));
    lines.push("");
    lines.push("Paper Trade Plans:");
    report.paperTradePlans.forEach((plan) => {
      lines.push(`- ${plan.symbol} | ${plan.direction} | ${plan.expression}`);
      lines.push(`  Thesis: ${plan.thesis}`);
      lines.push(`  Invalidation: ${plan.invalidation}`);
      lines.push(`  Learning Objective: ${plan.learningObjective}`);
    });
    if (includeAnalytics && symbolAnalytics && riskProfileAnalytics && symbolAnalytics.supported && riskProfileAnalytics.supported) {
      appendReportAnalyticsSection(lines, symbolAnalytics, riskProfileAnalytics);
    }
    if (report.run.riskProfile === "aggressive") {
      lines.push("");
      lines.push("AGGRESSIVE PAPER STRATEGY, NOT LIVE-TRADING APPROVED");
    }
    print(lines.join("\n"));
    return;
  }

  print({
    error:
      "Unknown command. See README for available commands including universe/data/options/features/targets/backtest/learn/research/alpaca:config/paper (including paper:analytics, paper:learn, paper:execute, paper:review, paper:plan, paper:portfolio:review, paper:exit:review, paper:options:discover, paper:ops:morning, paper:ops:midday, paper:ops:late-day, paper:snapshots, paper:trends, paper:runtime, paper:intel).",
    command,
    action,
    config
  });
  process.exitCode = 1;
};

try {
  await run();
} catch (error) {
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

  if (error instanceof Error) {
    print({ error: error.message });
    process.exit(1);
  }

  print({ error: "An unexpected error occurred." });
  process.exit(1);
}
