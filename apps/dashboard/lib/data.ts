import { queryAll } from "../../../src/lib/db";
import { getAlpacaAccountSnapshot } from "../../../src/services/alpacaAccountService";
import { listAlpacaPositions } from "../../../src/services/alpacaPositionService";
import {
  buildPaperExecuteConfirmPaperReport,
  buildPaperExecuteDryRunReport
} from "../../../src/services/paperExecuteDryRunService";
import { listPaperExecutionLedgerEntries } from "../../../src/services/paperExecutionLedgerService";
import { buildPaperPlanReport } from "../../../src/services/paperPlanService";
import { listPaperRecommendationSnapshots } from "../../../src/services/paperRecommendationSnapshotService";
import { buildPaperReviewReport } from "../../../src/services/paperReviewService";
import { buildPaperRuntimeReport } from "../../../src/services/paperRuntimeService";
import { runResearchDaily } from "../../../src/services/researchOrchestrator";
import { assertPaperDashboardAccess } from "./guards";
import {
  VERCEL_HISTORICAL_STORAGE_WARNING,
  VERCEL_HISTORICAL_UNAVAILABLE_MESSAGE,
  VERCEL_READ_ONLY_MODE,
  hasDashboardDurableStorageConfig,
  shouldUseVercelReadOnlyFallback
} from "./runtime";

export type RiskProfileInput = "moderate" | "aggressive" | "conservative";

export interface PaperActionInput {
  riskProfile?: RiskProfileInput;
  optionsEnabled?: boolean;
  maxCandidates?: number;
  assetClass?: "all" | "equity" | "option";
}

const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const safeLimit = (value: unknown, fallback: number, max: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(max, Math.floor(parsed))
    : fallback;
};

const normalizeRiskProfile = (value: unknown): RiskProfileInput => {
  return value === "aggressive" || value === "conservative" || value === "moderate"
    ? value
    : "aggressive";
};

const normalizeAssetClass = (value: unknown): "all" | "equity" | "option" => {
  return value === "equity" || value === "option" || value === "all" ? value : "all";
};

export const parsePaperActionInput = (value: unknown): PaperActionInput => {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    riskProfile: normalizeRiskProfile(record.riskProfile),
    optionsEnabled:
      typeof record.optionsEnabled === "boolean" ? record.optionsEnabled : true,
    maxCandidates: safeLimit(record.maxCandidates, 10, 50),
    assetClass: normalizeAssetClass(record.assetClass)
  };
};

export const latestResearchRuns = (limit = 5) =>
  shouldUseVercelReadOnlyFallback()
    ? []
    : queryAll(
        `
        SELECT id, started_at, completed_at, status, risk_profile, options_enabled, candidates_selected
        FROM research_runs
        ORDER BY started_at DESC
        LIMIT ?
        `,
        [safeLimit(limit, 5, 25)]
      );

export const latestPaperPlans = (limit = 10) =>
  shouldUseVercelReadOnlyFallback()
    ? []
    : queryAll(
        `
        SELECT id, research_run_id, symbol, created_at, status, direction, expression, option_symbol, estimated_max_loss, estimated_max_profit
        FROM paper_trade_plans
        ORDER BY created_at DESC
        LIMIT ?
        `,
        [safeLimit(limit, 10, 50)]
      );

export const latestOptionContracts = (limit = 10) =>
  shouldUseVercelReadOnlyFallback()
    ? []
    : queryAll(
        `
        SELECT c.underlying_symbol, c.option_symbol, c.type, c.expiration_date, c.strike, c.tradable,
          s.bid, s.ask, s.midpoint, s.last, s.timestamp
        FROM option_contracts c
        LEFT JOIN option_snapshots s ON s.option_symbol = c.option_symbol
        ORDER BY COALESCE(s.timestamp, c.expiration_date) DESC
        LIMIT ?
        `,
        [safeLimit(limit, 10, 50)]
      );

export const latestApiRequestIds = (limit = 12) =>
  shouldUseVercelReadOnlyFallback()
    ? []
    : queryAll(
        `
        SELECT provider, endpoint, method, status, request_id, created_at
        FROM api_request_log
        WHERE request_id IS NOT NULL
        ORDER BY created_at DESC
        LIMIT ?
        `,
        [safeLimit(limit, 12, 50)]
      );

const capture = async <T>(label: string, fn: () => Promise<T> | T) => {
  try {
    return { ok: true as const, label, data: await fn() };
  } catch (error) {
    return {
      ok: false as const,
      label,
      error:
        error instanceof Error &&
        /Missing Alpaca paper credentials/.test(error.message)
          ? "DASHBOARD_ALPACA_ENV_NOT_CONFIGURED"
          : "Unavailable. Confirm paper environment, credentials, and local DB access."
    };
  }
};

const historicalUnavailable = (label: string) => ({
  ok: false as const,
  label,
  error: VERCEL_HISTORICAL_UNAVAILABLE_MESSAGE
});

export const buildDashboardSnapshot = async () => {
  const state = assertPaperDashboardAccess();

  if (shouldUseVercelReadOnlyFallback()) {
    const [account, positions] = await Promise.all([
      capture("account", () => getAlpacaAccountSnapshot()),
      capture("positions", () => listAlpacaPositions())
    ]);

    return {
      paperOnly: true,
      environment: state.alpacaEnv,
      liveTradingEnabled: state.liveTradingEnabled,
      generatedAt: new Date().toISOString(),
      mode: VERCEL_READ_ONLY_MODE,
      historicalDataAvailable: false,
      durableStorageConfigured: hasDashboardDurableStorageConfig(),
      historicalWarning: VERCEL_HISTORICAL_UNAVAILABLE_MESSAGE,
      durableStorageWarning: VERCEL_HISTORICAL_STORAGE_WARNING,
      account,
      positions,
      runtime: historicalUnavailable("runtime"),
      plan: historicalUnavailable("plan"),
      review: historicalUnavailable("review"),
      dryRun: historicalUnavailable("dryRun"),
      latestResearch: [],
      latestPaperPlans: [],
      snapshots: [],
      executions: historicalUnavailable("executions"),
      optionContracts: [],
      requestIds: []
    };
  }

  const [account, positions, runtime, plan, review, dryRun, executions] =
    await Promise.all([
      capture("account", () => getAlpacaAccountSnapshot()),
      capture("positions", () => listAlpacaPositions()),
      capture("runtime", () => buildPaperRuntimeReport({
        riskProfile: "aggressive",
        optionsEnabled: true,
        maxCandidates: 10
      })),
      capture("plan", () => buildPaperPlanReport({
        riskProfile: "aggressive",
        optionsEnabled: true,
        maxCandidates: 10
      })),
      capture("review", () => buildPaperReviewReport({
        riskProfile: "aggressive",
        optionsEnabled: true,
        maxCandidates: 10
      })),
      capture("dryRun", () => buildPaperExecuteDryRunReport({
        dryRun: true,
        riskProfile: "aggressive",
        optionsEnabled: true,
        maxCandidates: 10,
        assetClass: "all"
      })),
      capture("executions", () => listPaperExecutionLedgerEntries(25))
    ]);

  return {
    paperOnly: true,
    environment: state.alpacaEnv,
    liveTradingEnabled: state.liveTradingEnabled,
    generatedAt: new Date().toISOString(),
    mode: "local-sqlite" as const,
    historicalDataAvailable: true,
    durableStorageConfigured: false,
    historicalWarning: null,
    durableStorageWarning: null,
    account,
    positions,
    runtime,
    plan,
    review,
    dryRun,
    latestResearch: latestResearchRuns(5),
    latestPaperPlans: latestPaperPlans(10),
    snapshots: listPaperRecommendationSnapshots({ limit: 10 }),
    executions,
    optionContracts: latestOptionContracts(10),
    requestIds: latestApiRequestIds(12)
  };
};

export const runPaperResearch = (input: PaperActionInput) =>
  runResearchDaily({
    riskProfile: input.riskProfile,
    optionsEnabled: input.optionsEnabled,
    maxCandidates: input.maxCandidates,
    useAlpacaAssets: true
  });

export const runPaperPlan = (input: PaperActionInput) =>
  buildPaperPlanReport({
    riskProfile: input.riskProfile,
    optionsEnabled: input.optionsEnabled,
    maxCandidates: input.maxCandidates
  });

export const runPaperReview = (input: PaperActionInput) =>
  buildPaperReviewReport({
    riskProfile: input.riskProfile,
    optionsEnabled: input.optionsEnabled,
    maxCandidates: input.maxCandidates
  });

export const runPaperDryRun = (input: PaperActionInput) =>
  buildPaperExecuteDryRunReport({
    dryRun: true,
    riskProfile: input.riskProfile,
    optionsEnabled: input.optionsEnabled,
    maxCandidates: input.maxCandidates,
    assetClass: input.assetClass
  });

export const runPaperConfirm = (input: PaperActionInput) =>
  buildPaperExecuteConfirmPaperReport({
    confirmPaper: true,
    riskProfile: input.riskProfile,
    optionsEnabled: input.optionsEnabled,
    maxCandidates: input.maxCandidates,
    assetClass: input.assetClass
  });

export const dashboardMoney = (value: unknown) => {
  const numeric = numberOrNull(value);
  return numeric === null
    ? "-"
    : numeric.toLocaleString("en-US", { style: "currency", currency: "USD" });
};
