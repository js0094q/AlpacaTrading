import { getAlpacaAccountSnapshot } from "../../../src/services/alpacaAccountService";
import { listAlpacaPositions } from "../../../src/services/alpacaPositionService";
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

const queryAllRows = async <T = Record<string, unknown>>(
  sql: string,
  params: Array<string | number | null> = []
): Promise<T[]> => {
  const { queryAll } = await import("../../../src/lib/db");
  return queryAll<T>(sql, params);
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

export const latestResearchRuns = async (limit = 5) =>
  shouldUseVercelReadOnlyFallback()
    ? []
    : queryAllRows(
        `
        SELECT id, started_at, completed_at, status, risk_profile, options_enabled, candidates_selected
        FROM research_runs
        ORDER BY started_at DESC
        LIMIT ?
        `,
        [safeLimit(limit, 5, 25)]
      );

export const latestPaperPlans = async (limit = 10) =>
  shouldUseVercelReadOnlyFallback()
    ? []
    : queryAllRows(
        `
        SELECT id, research_run_id, symbol, created_at, status, direction, expression, option_symbol, estimated_max_loss, estimated_max_profit
        FROM paper_trade_plans
        ORDER BY created_at DESC
        LIMIT ?
        `,
        [safeLimit(limit, 10, 50)]
      );

export const latestOptionContracts = async (limit = 10) =>
  shouldUseVercelReadOnlyFallback()
    ? []
    : queryAllRows(
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

export const latestApiRequestIds = async (limit = 12) =>
  shouldUseVercelReadOnlyFallback()
    ? []
    : queryAllRows(
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

export const latestPaperExecutions = async (limit = 50) => {
  if (shouldUseVercelReadOnlyFallback()) {
    return [];
  }
  const { listPaperExecutionLedgerEntries } = await import(
    "../../../src/services/paperExecutionLedgerService"
  );
  return listPaperExecutionLedgerEntries(limit);
};

const latestPaperRecommendationSnapshots = async (limit = 10) => {
  if (shouldUseVercelReadOnlyFallback()) {
    return [];
  }
  const { listPaperRecommendationSnapshots } = await import(
    "../../../src/services/paperRecommendationSnapshotService"
  );
  return listPaperRecommendationSnapshots({ limit });
};

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
      capture("runtime", async () => {
        const { buildPaperRuntimeReport } = await import(
          "../../../src/services/paperRuntimeService"
        );
        return buildPaperRuntimeReport({
          riskProfile: "aggressive",
          optionsEnabled: true,
          maxCandidates: 10
        });
      }),
      capture("plan", async () => {
        const { buildPaperPlanReport } = await import(
          "../../../src/services/paperPlanService"
        );
        return buildPaperPlanReport({
          riskProfile: "aggressive",
          optionsEnabled: true,
          maxCandidates: 10
        });
      }),
      capture("review", async () => {
        const { buildPaperReviewReport } = await import(
          "../../../src/services/paperReviewService"
        );
        return buildPaperReviewReport({
          riskProfile: "aggressive",
          optionsEnabled: true,
          maxCandidates: 10
        });
      }),
      capture("dryRun", async () => {
        const { buildPaperExecuteDryRunReport } = await import(
          "../../../src/services/paperExecuteDryRunService"
        );
        return buildPaperExecuteDryRunReport({
          dryRun: true,
          riskProfile: "aggressive",
          optionsEnabled: true,
          maxCandidates: 10,
          assetClass: "all"
        });
      }),
      capture("executions", () => latestPaperExecutions(25))
    ]);
  const [
    latestResearch,
    latestPlans,
    snapshots,
    optionContracts,
    requestIds
  ] = await Promise.all([
    latestResearchRuns(5),
    latestPaperPlans(10),
    latestPaperRecommendationSnapshots(10),
    latestOptionContracts(10),
    latestApiRequestIds(12)
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
    latestResearch,
    latestPaperPlans: latestPlans,
    snapshots,
    executions,
    optionContracts,
    requestIds
  };
};

export const runPaperResearch = async (input: PaperActionInput) => {
  const { runResearchDaily } = await import("../../../src/services/researchOrchestrator");
  return runResearchDaily({
    riskProfile: input.riskProfile,
    optionsEnabled: input.optionsEnabled,
    maxCandidates: input.maxCandidates,
    useAlpacaAssets: true
  });
};

export const runPaperPlan = async (input: PaperActionInput) => {
  const { buildPaperPlanReport } = await import("../../../src/services/paperPlanService");
  return buildPaperPlanReport({
    riskProfile: input.riskProfile,
    optionsEnabled: input.optionsEnabled,
    maxCandidates: input.maxCandidates
  });
};

export const runPaperReview = async (input: PaperActionInput) => {
  const { buildPaperReviewReport } = await import("../../../src/services/paperReviewService");
  return buildPaperReviewReport({
    riskProfile: input.riskProfile,
    optionsEnabled: input.optionsEnabled,
    maxCandidates: input.maxCandidates
  });
};

export const runPaperDryRun = async (input: PaperActionInput) => {
  const { buildPaperExecuteDryRunReport } = await import(
    "../../../src/services/paperExecuteDryRunService"
  );
  return buildPaperExecuteDryRunReport({
    dryRun: true,
    riskProfile: input.riskProfile,
    optionsEnabled: input.optionsEnabled,
    maxCandidates: input.maxCandidates,
    assetClass: input.assetClass
  });
};

export const runPaperConfirm = async (input: PaperActionInput) => {
  const { buildPaperExecuteConfirmPaperReport } = await import(
    "../../../src/services/paperExecuteDryRunService"
  );
  return buildPaperExecuteConfirmPaperReport({
    confirmPaper: true,
    riskProfile: input.riskProfile,
    optionsEnabled: input.optionsEnabled,
    maxCandidates: input.maxCandidates,
    assetClass: input.assetClass
  });
};

export const dashboardMoney = (value: unknown) => {
  const numeric = numberOrNull(value);
  return numeric === null
    ? "-"
    : numeric.toLocaleString("en-US", { style: "currency", currency: "USD" });
};
