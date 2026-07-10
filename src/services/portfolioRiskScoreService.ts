import type { MarketRegimeSnapshot } from "./marketRegimeService.js";
import type { PortfolioRiskSnapshot } from "./portfolioRiskService.js";

export type PortfolioRiskBand = "low" | "moderate" | "elevated" | "high" | "critical";

export interface PortfolioRiskScoreComponent {
  key:
    | "grossExposure"
    | "betaAdjustedExposure"
    | "optionsConvexity"
    | "positiveDeltaOptionConcentration"
    | "largestPosition"
    | "topFiveConcentration"
    | "expirationConcentration"
    | "drawdown"
    | "marketRegime"
    | "dataQuality";
  points: number;
  maximum: number;
  measuredValue: number | string | null;
  thresholds: string;
  rationale: string;
  quality: "observed" | "partial" | "unavailable";
}

export interface PortfolioRiskScore {
  total: number;
  band: PortfolioRiskBand;
  components: PortfolioRiskScoreComponent[];
  modelVersion: string;
}

const thresholdPoints = (
  value: number | null,
  thresholds: Array<{ maximum: number; points: number }>,
  fallback: number
) => {
  if (value === null) return 0;
  return thresholds.find((entry) => value <= entry.maximum)?.points ?? fallback;
};

const component = (
  input: Omit<PortfolioRiskScoreComponent, "quality"> & {
    quality?: PortfolioRiskScoreComponent["quality"];
  }
): PortfolioRiskScoreComponent => ({ quality: "observed", ...input });

export const scorePortfolioRisk = (
  risk: PortfolioRiskSnapshot,
  regime: MarketRegimeSnapshot
): PortfolioRiskScore => {
  const gross = risk.exposures.grossExposurePct;
  const beta = risk.portfolioBeta === null ? null : Math.abs(risk.portfolioBeta);
  const optionDelta = risk.options.absoluteDeltaExposurePct;
  const positiveDelta = risk.options.positiveDeltaExposurePct;
  const largest = risk.concentration.largestUnderlyingWeight;
  const topFive = risk.concentration.topFiveUnderlyingWeight;
  const expiration = risk.options.nearTermExposurePct;
  const drawdown = risk.account.drawdownPct;
  const regimePoints = {
    "risk-on": 0,
    neutral: 1,
    transition: 3,
    "insufficient-data": 3,
    "risk-off": 5,
    crisis: 7
  }[regime.regime];
  const qualityPoints = {
    complete: 0,
    partial: 2,
    monitoring: 4,
    blocked: 5
  }[risk.dataQualityStatus];
  const components: PortfolioRiskScoreComponent[] = [
    component({
      key: "grossExposure",
      points: thresholdPoints(gross, [
        { maximum: 1, points: 0 },
        { maximum: 1.25, points: 5 },
        { maximum: 1.5, points: 10 }
      ], 15),
      maximum: 15,
      measuredValue: gross,
      thresholds: "<=1:0, <=1.25:5, <=1.5:10, >1.5:15",
      rationale: "Gross delta-adjusted exposure relative to observed paper equity."
    }),
    component({
      key: "betaAdjustedExposure",
      points: thresholdPoints(beta, [
        { maximum: 0.8, points: 0 },
        { maximum: 1, points: 5 },
        { maximum: 1.25, points: 10 }
      ], 15),
      maximum: 15,
      measuredValue: beta,
      thresholds: "<=0.8:0, <=1:5, <=1.25:10, >1.25:15",
      rationale: beta === null
        ? "Portfolio beta is unavailable and contributes no fabricated points."
        : "Absolute signed-exposure portfolio beta.",
      quality: beta === null ? "unavailable" : "observed"
    }),
    component({
      key: "optionsConvexity",
      points: thresholdPoints(optionDelta, [
        { maximum: 0.1, points: 0 },
        { maximum: 0.25, points: 5 },
        { maximum: 0.5, points: 10 }
      ], 15),
      maximum: 15,
      measuredValue: optionDelta,
      thresholds: "<=0.1:0, <=0.25:5, <=0.5:10, >0.5:15",
      rationale: "Absolute observed option delta exposure relative to equity.",
      quality: optionDelta === null ? "unavailable" : "observed"
    }),
    component({
      key: "positiveDeltaOptionConcentration",
      points: thresholdPoints(positiveDelta, [
        { maximum: 0.1, points: 0 },
        { maximum: 0.25, points: 4 },
        { maximum: 0.4, points: 7 }
      ], 10),
      maximum: 10,
      measuredValue: positiveDelta,
      thresholds: "<=0.1:0, <=0.25:4, <=0.4:7, >0.4:10",
      rationale: "Observed positive option delta concentration relative to equity.",
      quality: positiveDelta === null ? "unavailable" : "observed"
    }),
    component({
      key: "largestPosition",
      points: thresholdPoints(largest, [
        { maximum: 0.1, points: 0 },
        { maximum: 0.15, points: 3 },
        { maximum: 0.25, points: 6 }
      ], 10),
      maximum: 10,
      measuredValue: largest,
      thresholds: "<=0.1:0, <=0.15:3, <=0.25:6, >0.25:10",
      rationale: "Largest grouped-underlying exposure weight."
    }),
    component({
      key: "topFiveConcentration",
      points: thresholdPoints(topFive, [
        { maximum: 0.4, points: 0 },
        { maximum: 0.55, points: 3 },
        { maximum: 0.7, points: 5 }
      ], 8),
      maximum: 8,
      measuredValue: topFive,
      thresholds: "<=0.4:0, <=0.55:3, <=0.7:5, >0.7:8",
      rationale: "Top-five grouped-underlying exposure weight."
    }),
    component({
      key: "expirationConcentration",
      points: thresholdPoints(expiration, [
        { maximum: 0.1, points: 0 },
        { maximum: 0.25, points: 3 },
        { maximum: 0.4, points: 5 }
      ], 7),
      maximum: 7,
      measuredValue: expiration,
      thresholds: "<=0.1:0, <=0.25:3, <=0.4:5, >0.4:7",
      rationale: "Observed option delta exposure expiring within 90 days.",
      quality: expiration === null ? "unavailable" : "observed"
    }),
    component({
      key: "drawdown",
      points: thresholdPoints(drawdown, [
        { maximum: 0.03, points: 0 },
        { maximum: 0.05, points: 2 },
        { maximum: 0.1, points: 5 }
      ], 8),
      maximum: 8,
      measuredValue: drawdown,
      thresholds: "<=0.03:0, <=0.05:2, <=0.1:5, >0.1:8",
      rationale: "Observed equity drawdown from the non-decreasing paper high-water mark.",
      quality: drawdown === null ? "unavailable" : "observed"
    }),
    component({
      key: "marketRegime",
      points: regimePoints,
      maximum: 7,
      measuredValue: regime.regime,
      thresholds: "risk-on:0, neutral:1, transition/insufficient:3, risk-off:5, crisis:7",
      rationale: `Deterministic market regime selected by ${regime.selectedRule}.`
    }),
    component({
      key: "dataQuality",
      points: qualityPoints,
      maximum: 5,
      measuredValue: risk.dataQualityStatus,
      thresholds: "complete:0, partial:2, monitoring:4, blocked:5",
      rationale: "Penalty for missing material prices, Greeks, beta, or sector evidence.",
      quality: risk.dataQualityStatus === "complete" ? "observed" : "partial"
    })
  ];
  const total = Math.min(
    100,
    components.reduce((sum, entry) => sum + Math.min(entry.maximum, entry.points), 0)
  );
  const band: PortfolioRiskBand =
    total >= 80
      ? "critical"
      : total >= 65
        ? "high"
        : total >= 45
          ? "elevated"
          : total >= 25
            ? "moderate"
            : "low";
  return {
    total,
    band,
    components,
    modelVersion: risk.riskModelVersion
  };
};
