import { getTradingSafetyState } from "./tradingSafetyService.js";
import {
  buildPaperRecommendationTrends,
  type PaperTrendRecord
} from "./paperTrendsService.js";
import {
  listPaperRecommendationSnapshots,
  type PaperRecommendationSnapshotHistoryRecord
} from "./paperRecommendationSnapshotService.js";
import { buildPaperRuntimeReport, type PaperRuntimeReport } from "./paperRuntimeService.js";

export interface PaperIntelInput {
  riskProfile?: string;
  optionsEnabled?: boolean;
  from?: string;
  to?: string;
  maxCandidates?: number;
  snapshotLimit?: number;
  trendLimit?: number;
}

export interface PaperIntelReport {
  paperOnly: true;
  environment: ReturnType<typeof getTradingSafetyState>["alpacaEnv"];
  snapshots: PaperRecommendationSnapshotHistoryRecord[];
  trends: PaperTrendRecord[];
  runtime: PaperRuntimeReport;
}

export const buildPaperIntelligenceReport = async (input: PaperIntelInput = {}): Promise<PaperIntelReport> => {
  const snapshotLimit = input.snapshotLimit ?? 20;
  const trendLimit = input.trendLimit ?? 20;
  const snapshots = listPaperRecommendationSnapshots({
    riskProfile: input.riskProfile,
    optionsEnabled: input.optionsEnabled,
    from: input.from,
    to: input.to,
    limit: snapshotLimit
  });

  const trendsReport = buildPaperRecommendationTrends({
    riskProfile: input.riskProfile,
    optionsEnabled: input.optionsEnabled,
    from: input.from,
    to: input.to,
    limit: trendLimit
  });

  const runtime = await buildPaperRuntimeReport({
    riskProfile: input.riskProfile,
    optionsEnabled: input.optionsEnabled,
    maxCandidates: input.maxCandidates
  });

  return {
    paperOnly: true,
    environment: getTradingSafetyState().alpacaEnv,
    snapshots,
    trends: trendsReport.trends,
    runtime
  };
};
