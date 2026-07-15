import { getAlpacaPaperCredentials } from "./alpacaClient.js";
import {
  checkAlpacaSymbolTradability,
  type AlpacaAssetFilterReason,
  type AlpacaAssetTradabilityResult
} from "./alpacaAssetService.js";
import { config } from "../config.js";
import {
  getActiveSymbols,
  getActiveUniverse,
  seedInitialUniverse
} from "./universeService.js";
import { ingestBars } from "./marketDataIngest.js";
import { ingestOptionContracts, ingestOptionSnapshots } from "./optionsService.js";
import { buildFeatures } from "./featureService.js";
import { runLearning } from "./learningService.js";
import { generateTargets } from "./targetService.js";
import { dedupeSymbols, normalizeSymbol } from "../lib/utils.js";
import { rankResearchCandidates, persistCandidateDecisions } from "./candidateRankingService.js";
import { buildPaperTradePlans } from "./paperTradeService.js";
import type { PaperTradeCandidateRow } from "../types.js";
import {
  finishResearchRun,
  heartbeatResearchRun,
  ResearchRunLeaseLostError,
  reserveResearchRun,
  updateResearchRunUniverseSize,
  withActiveResearchRunLease
} from "./researchRunLifecycleService.js";

interface ResearchDailyInput {
  riskProfile?: "aggressive" | "conservative" | "moderate";
  optionsEnabled?: boolean;
  maxCandidates?: number;
  maxPerSymbol?: number;
  maxPerDirection?: number;
  maxPerExpression?: number;
  requireSectorDiversity?: boolean;
  useAlpacaAssets?: boolean;
  barLookbackDays?: number;
}

interface AlpacaAssetFilterSummary {
  enabled: boolean;
  checked: number;
  retained: number;
  excluded: Array<{
    symbol: string;
    reason: AlpacaAssetFilterReason;
  }>;
}

interface RunSummary {
  runId: string;
  startedAt: string;
  status: "running" | "completed" | "failed";
  riskProfile: "aggressive" | "conservative" | "moderate";
  optionsEnabled: boolean;
  universeSize: number;
  targetsGenerated: number;
  candidatesSelected: number;
  barLookbackDays: number;
  barLookbackStart: string;
  warnings: string[];
  alpacaAssetFilter?: AlpacaAssetFilterSummary;
}

interface AlreadyRunningSummary {
  status: "already_running";
  runId: string;
  activeRunId: string;
  startedAt: string;
  heartbeatAt: string;
  riskProfile: "aggressive" | "conservative" | "moderate";
  optionsEnabled: boolean;
  universeSize: number;
  targetsGenerated: number;
  candidatesSelected: number;
  barLookbackDays: number;
  barLookbackStart: string;
  warnings: string[];
}

const assertResearchRunLease = (runId: string, renewed?: boolean): void => {
  if (!(renewed ?? heartbeatResearchRun(runId))) {
    throw new ResearchRunLeaseLostError(runId);
  }
};

interface PersistedRunSummary {
  warnings: string[];
  alpacaAssetFilter?: AlpacaAssetFilterSummary;
}

const parseTargetRows = (input: Awaited<ReturnType<typeof generateTargets>>) => input.rows;

const finishRun = (
  runId: string,
  input: {
    status: "completed" | "failed";
    targetsGenerated: number;
    candidatesSelected: number;
    warnings?: string[];
    summary?: PersistedRunSummary;
    errorMessage?: string | null;
  }
) => {
  const summaryPayload = input.summary ? input.summary : { warnings: input.warnings || [] };
  finishResearchRun(runId, {
    status: input.status,
    targetsGenerated: input.targetsGenerated,
    candidatesSelected: input.candidatesSelected,
    errorMessage: input.errorMessage || null,
    summaryJson: JSON.stringify(summaryPayload)
  });
};

const pickDefaults = (riskProfile: "aggressive" | "moderate" | "conservative") => {
  if (riskProfile === "aggressive") {
    return {
      maxCandidates: 10,
      maxPerSymbol: 3,
      maxPerDirection: 8,
      maxPerExpression: 6
    };
  }
  if (riskProfile === "conservative") {
    return {
      maxCandidates: 8,
      maxPerSymbol: 1,
      maxPerDirection: 3,
      maxPerExpression: 2
    };
  }
  return {
    maxCandidates: 10,
    maxPerSymbol: 2,
    maxPerDirection: 5,
    maxPerExpression: 4
  };
};

const safeExcludeWarning = (symbol: string, reason: string) =>
  `Alpaca asset filter excluded ${symbol}: ${reason}`;

const safeWarningMessage = (error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown";
  return message.length > 240 ? `${message.slice(0, 240)}...` : message;
};

const DEFAULT_DAILY_BAR_LOOKBACK_DAYS = 365;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const normalizeLookbackDays = (value: number | undefined) => {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_DAILY_BAR_LOOKBACK_DAYS;
  }
  return Math.max(1, Math.floor(value));
};

const lookbackStartIso = (days: number) =>
  new Date(Date.now() - days * MS_PER_DAY).toISOString();

const buildAlpacaAssetFilterSummary = (input: {
  checked: AlpacaAssetTradabilityResult[];
}): AlpacaAssetFilterSummary => {
  const excluded = input.checked
    .filter((row) => !row.tradable && row.reason)
    .map((row) => ({
      symbol: row.symbol,
      reason: row.reason as AlpacaAssetFilterReason
    }));

  return {
    enabled: true,
    checked: input.checked.length,
    retained: input.checked.filter((row) => row.tradable).length,
    excluded
  };
};

const buildAlpacaFilteredTargets = async (
  targets: ReturnType<typeof parseTargetRows>,
  enabled: boolean
): Promise<{
  targets: ReturnType<typeof parseTargetRows>;
  filterSummary: AlpacaAssetFilterSummary | undefined;
  warnings: string[];
}> => {
  if (!enabled) {
    return { targets, filterSummary: undefined, warnings: [] };
  }

  const tradabilityChecks: AlpacaAssetTradabilityResult[] = [];
  for (const target of targets) {
    const symbol = normalizeSymbol(target.symbol);
    if (!symbol) {
      tradabilityChecks.push({
        symbol: String(target.symbol || ""),
        tradable: false,
        reason: "asset_not_found"
      });
      continue;
    }
    const result = await checkAlpacaSymbolTradability(symbol);
    tradabilityChecks.push(result);
  }

  const warnings: string[] = [];
  tradabilityChecks.forEach((row) => {
    if (!row.tradable && row.reason) {
      warnings.push(safeExcludeWarning(row.symbol, row.reason));
    }
  });

  const summary = buildAlpacaAssetFilterSummary({ checked: tradabilityChecks });
  const filteredTargets = targets.filter((target) => {
    const normalized = normalizeSymbol(target.symbol);
    const matchedCheck = tradabilityChecks.find((row) => row.symbol === normalized);
    return matchedCheck?.tradable === true;
  });

  return {
    targets: filteredTargets,
    filterSummary: summary,
    warnings
  };
};

const discoveryOptionUnderlyings = () => {
  const symbols: string[] = [];
  if (config.paperZeroDteSpy.enabled) {
    symbols.push(...config.paperZeroDteSpy.underlyings);
  }
  if (config.paperLeaps.enabled) {
    symbols.push(...config.paperLeaps.underlyings);
  }
  return dedupeSymbols(symbols);
};

export const runResearchDaily = async (
  input: ResearchDailyInput = {}
): Promise<RunSummary | AlreadyRunningSummary> => {
  const runId = `research_${crypto.randomUUID()}`;
  const riskProfile = input.riskProfile || "moderate";
  const optionsEnabled = input.optionsEnabled || false;
  const defaults = pickDefaults(riskProfile);
  const maxCandidates = input.maxCandidates ?? defaults.maxCandidates;
  const isAggressiveMode = riskProfile === "aggressive";
  const useAlpacaAssets = input.useAlpacaAssets || false;
  const barLookbackDays = normalizeLookbackDays(input.barLookbackDays);
  const barLookbackStart = lookbackStartIso(barLookbackDays);

  if (isAggressiveMode && !config.enableAggressivePaperStrategies) {
    throw new Error("AGGRESSIVE paper mode requires ENABLE_AGGRESSIVE_PAPER_STRATEGIES=true.");
  }

  const configPayload = {
    riskProfile,
    optionsEnabled,
    maxCandidates,
    maxPerSymbol: input.maxPerSymbol ?? defaults.maxPerSymbol,
    maxPerDirection: input.maxPerDirection ?? defaults.maxPerDirection,
    maxPerExpression: input.maxPerExpression ?? defaults.maxPerExpression,
    requireSectorDiversity: input.requireSectorDiversity ?? false,
    barLookbackDays,
    barLookbackStart,
    runModeLabel: isAggressiveMode
      ? "AGGRESSIVE PAPER STRATEGY, NOT LIVE-TRADING APPROVED"
      : "PAPER STRATEGY, NOT LIVE-TRADING APPROVED",
    useAlpacaAssets
  };

  const reservation = reserveResearchRun({
    runId,
    riskProfile,
    optionsEnabled,
    configJson: JSON.stringify(configPayload),
    requestId: process.env.RESEARCH_REQUEST_ID?.trim() || undefined,
    correlationId: process.env.RESEARCH_CORRELATION_ID?.trim() || undefined
  });
  if (reservation.status === "already_running") {
    return {
      status: "already_running",
      runId: reservation.activeRunId,
      activeRunId: reservation.activeRunId,
      startedAt: reservation.startedAt,
      heartbeatAt: reservation.heartbeatAt,
      riskProfile,
      optionsEnabled,
      universeSize: 0,
      targetsGenerated: 0,
      candidatesSelected: 0,
      barLookbackDays,
      barLookbackStart,
      warnings: ["RESEARCH_ALREADY_RUNNING"]
    };
  }

  const startedAt = reservation.startedAt;
  let universeSize = 0;
  let symbols: string[] = [];
  let targets: Awaited<ReturnType<typeof parseTargetRows>> = [];
  let persistedCandidates: PaperTradeCandidateRow[] = [];
  const warnings: string[] = [];
  let alpacaAssetFilter: AlpacaAssetFilterSummary | undefined;

  try {
    if (useAlpacaAssets) {
      getAlpacaPaperCredentials();
    }
    await seedInitialUniverse();
    universeSize = getActiveUniverse().length;
    symbols = getActiveSymbols();
    assertResearchRunLease(runId, updateResearchRunUniverseSize(runId, universeSize));

    await ingestBars({ symbols, timeframe: "1Day", start: barLookbackStart });
    assertResearchRunLease(runId);
    if (optionsEnabled) {
      try {
        const optionUnderlyings = dedupeSymbols([
          ...symbols,
          ...discoveryOptionUnderlyings()
        ]);
        await ingestOptionContracts({ underlyingSymbols: optionUnderlyings });
        await ingestOptionSnapshots({ underlyingSymbols: optionUnderlyings });
      } catch (error) {
        warnings.push(
          `Options data ingestion skipped; continuing equity candidate generation: ${safeWarningMessage(error)}`
        );
      }
      assertResearchRunLease(runId);
    }

    await buildFeatures({ symbols, start: barLookbackStart });
    assertResearchRunLease(runId);
    await runLearning();
    assertResearchRunLease(runId);

    targets = parseTargetRows(await generateTargets({ riskProfile }));
    assertResearchRunLease(runId);

    const filteredTargets = await buildAlpacaFilteredTargets(targets, useAlpacaAssets);
    if (filteredTargets.warnings.length) {
      warnings.push(...filteredTargets.warnings);
    }
    if (filteredTargets.filterSummary) {
      alpacaAssetFilter = filteredTargets.filterSummary;
    }
    assertResearchRunLease(runId);

    const ranked = rankResearchCandidates({
      researchRunId: runId,
      riskProfile,
      optionsEnabled,
      targets: filteredTargets.targets,
      maxCandidates,
      maxPerSymbol: input.maxPerSymbol ?? defaults.maxPerSymbol,
      maxPerDirection: input.maxPerDirection ?? defaults.maxPerDirection,
      maxPerExpression: input.maxPerExpression ?? defaults.maxPerExpression,
      requireSectorDiversity: input.requireSectorDiversity
    });

    persistedCandidates = withActiveResearchRunLease(runId, () => {
      const persistedDecisions = persistCandidateDecisions({
        researchRunId: runId,
        decisions: ranked.decisions
      });
      const selectedCandidates = persistedDecisions.filter(
        (candidate) => candidate.decision === "selected"
      );
      buildPaperTradePlans({
        researchRunId: runId,
        candidates: ranked.candidates,
        riskProfile
      });
      return selectedCandidates;
    });

    warnings.push(...ranked.warnings);

    finishRun(runId, {
      status: "completed",
      targetsGenerated: targets.length,
      candidatesSelected: persistedCandidates.length,
      warnings,
      summary: {
        warnings,
        ...(alpacaAssetFilter ? { alpacaAssetFilter } : {})
      }
    });

    return {
      runId,
      startedAt,
      status: "completed",
      riskProfile,
      optionsEnabled,
      universeSize,
      targetsGenerated: targets.length,
      candidatesSelected: persistedCandidates.length,
      barLookbackDays,
      barLookbackStart,
      warnings,
      ...(alpacaAssetFilter ? { alpacaAssetFilter } : {})
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    finishRun(runId, {
      status: "failed",
      targetsGenerated: targets.length,
      candidatesSelected: persistedCandidates.length,
      warnings,
      summary: {
        warnings,
        ...(alpacaAssetFilter ? { alpacaAssetFilter } : {})
      },
      errorMessage: message
    });
    throw error;
  }
};
