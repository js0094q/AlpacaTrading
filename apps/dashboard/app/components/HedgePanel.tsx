import React from "react";

export type HedgeDashboardStatus =
  | "current"
  | "monitoring"
  | "stale"
  | "expired"
  | "blocked";

export interface HedgeDashboardRecommendation {
  recommendationId?: string;
  effectiveStatus: HedgeDashboardStatus;
  recommendationStatus?: string;
  generatedAt?: string;
  expiresAt?: string;
  environment?: string;
  sourceSnapshotId?: string;
  riskModelVersion?: string;
  regimeModelVersion?: string;
  configurationFingerprint?: string;
  dataQualityStatus?: string;
  reviewedPayloadHash?: string | null;
  decision?: string;
  risk?: {
    portfolioBeta?: number | null;
    betaCoverage?: number | null;
    exposures?: {
      grossExposurePct?: number | null;
      netExposurePct?: number | null;
    };
    concentration?: {
      largestUnderlyingWeight?: number | null;
      topFiveUnderlyingWeight?: number | null;
    };
    scenarios?: Array<{
      benchmarkDeclinePct?: number;
      netModeledLoss?: number | null;
      existingProtection?: number | null;
    }>;
  };
  regime?: {
    regime?: string;
    selectedRule?: string;
  };
  score?: {
    total?: number;
    band?: string;
  };
  sizing?: {
    targetScenarioDeclinePct?: number;
    grossProtectionTarget?: number;
    existingMeasuredProtection?: number;
    netProtectionTarget?: number;
    residualUnprotectedLoss?: number;
  };
  leaps?: {
    profitFundedPremiumBudget?: number;
    unrealizedGainFundingProxy?: boolean;
    trimRecommendations?: Array<{
      symbol?: string;
      quantityToTrim?: number;
    }>;
  };
  candidates?: Array<{
    candidateId?: string;
    rank?: number;
    instrumentType?: string;
    symbol?: string;
    expectedProtection?: number | null;
    estimatedCost?: number | null;
    units?: number | null;
    blockers?: string[];
    warnings?: string[];
  }>;
  warnings?: string[];
  blockers?: string[];
  integrityWarnings?: string[];
}

const money = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0
      }).format(value)
    : "-";

const percent = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value)
    ? `${(value * 100).toFixed(1)}%`
    : "-";

const metric = (label: string, value: string | number) => (
  <div className="metric" key={label}>
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
);

const statusCopy = (status: HedgeDashboardStatus) => {
  if (status === "current") {
    return "Current recommendation";
  }
  return `${status.toUpperCase()} — This recommendation is not current.`;
};

export const HedgePanel = ({
  recommendation,
  error
}: {
  recommendation: HedgeDashboardRecommendation | null;
  error?: string | null;
}) => {
  if (error) {
    return (
      <div className="panel full hedge-panel">
        <h2>Portfolio Risk and Hedge Review</h2>
        <p className="warning">{error}</p>
      </div>
    );
  }
  if (!recommendation) {
    return (
      <div className="panel full hedge-panel">
        <div className="hedge-header">
          <h2>Portfolio Risk and Hedge Review</h2>
          <span className="hedge-status hedge-status-blocked">BLOCKED</span>
        </div>
        <p className="warning">No persisted hedge recommendation is available. This is not a current recommendation.</p>
      </div>
    );
  }

  const status = recommendation.effectiveStatus;
  const scenarios = recommendation.risk?.scenarios ?? [];
  const trims = recommendation.leaps?.trimRecommendations ?? [];
  const candidates = recommendation.candidates ?? [];
  const warnings = [
    ...(recommendation.warnings ?? []),
    ...(recommendation.integrityWarnings ?? [])
  ];
  const blockers = recommendation.blockers ?? [];

  return (
    <div className="panel full hedge-panel">
      <div className="hedge-header">
        <div>
          <h2>Portfolio Risk and Hedge Review</h2>
          <p className={status === "current" ? "subtle" : "warning"}>
            {statusCopy(status)}
          </p>
        </div>
        <span className={`hedge-status hedge-status-${status}`}>
          {status.toUpperCase()}
        </span>
      </div>

      <div className="hedge-metrics">
        <div>
          {metric("Risk score", `${recommendation.score?.total ?? "-"} (${recommendation.score?.band ?? "-"})`)}
          {metric("Decision", recommendation.decision ?? "-")}
          {metric("Data quality", recommendation.dataQualityStatus ?? "-")}
          {metric("Market regime", recommendation.regime?.regime ?? "-")}
          {metric("Regime rule", recommendation.regime?.selectedRule ?? "-")}
        </div>
        <div>
          {metric("Portfolio beta", recommendation.risk?.portfolioBeta ?? "-")}
          {metric("Beta coverage", percent(recommendation.risk?.betaCoverage))}
          {metric("Gross exposure", percent(recommendation.risk?.exposures?.grossExposurePct))}
          {metric("Net exposure", percent(recommendation.risk?.exposures?.netExposurePct))}
          {metric("Largest underlying", percent(recommendation.risk?.concentration?.largestUnderlyingWeight))}
        </div>
        <div>
          {metric("Generated", recommendation.generatedAt ?? "-")}
          {metric("Expires", recommendation.expiresAt ?? "-")}
          {metric("Source snapshot", recommendation.sourceSnapshotId ?? "-")}
          {metric("Risk model", recommendation.riskModelVersion ?? "-")}
          {metric("Regime model", recommendation.regimeModelVersion ?? "-")}
        </div>
      </div>

      <div className="hedge-sections">
        <section>
          <h3>Modeled downside scenarios</h3>
          <div className="list">
            {scenarios.map((scenario) => (
              <div className="row" key={scenario.benchmarkDeclinePct}>
                <strong>{scenario.benchmarkDeclinePct}% decline</strong>
                <span>Net loss {money(scenario.netModeledLoss)}</span>
                <span className="mono">Protection {money(scenario.existingProtection)}</span>
              </div>
            ))}
            {!scenarios.length ? <p className="subtle">No scenario evidence available.</p> : null}
          </div>
        </section>

        <section>
          <h3>Hedge sizing</h3>
          {metric("Target scenario", `${recommendation.sizing?.targetScenarioDeclinePct ?? "-"}% decline`)}
          {metric("Gross protection target", money(recommendation.sizing?.grossProtectionTarget))}
          {metric("Existing protection", money(recommendation.sizing?.existingMeasuredProtection))}
          {metric("Net protection target", money(recommendation.sizing?.netProtectionTarget))}
          {metric("Residual unprotected loss", money(recommendation.sizing?.residualUnprotectedLoss))}
        </section>

        <section>
          <h3>LEAPS risk</h3>
          {metric("Profit-funded premium budget", money(recommendation.leaps?.profitFundedPremiumBudget))}
          <p className="subtle">
            Funding is an unrealized-gain proxy, not realized proceeds.
          </p>
          <div className="list">
            {trims.map((trim) => (
              <div className="row" key={trim.symbol}>
                <strong>{trim.symbol ?? "-"}</strong>
                <span>Trim recommendation</span>
                <span className="mono">qty {trim.quantityToTrim ?? "-"}</span>
              </div>
            ))}
            {!trims.length ? <p className="subtle">No LEAPS trim recommendation.</p> : null}
          </div>
        </section>
      </div>

      <section className="hedge-candidates">
        <h3>Ranked hedge candidates</h3>
        <div className="list">
          {candidates.map((candidate) => (
            <div className="hedge-candidate" key={candidate.candidateId ?? candidate.symbol}>
              <strong>#{candidate.rank ?? "-"} {candidate.symbol ?? "-"}</strong>
              <span>{candidate.instrumentType ?? "-"}</span>
              <span>Units {candidate.units ?? "-"}</span>
              <span>Cost {money(candidate.estimatedCost)}</span>
              <span>Protection {money(candidate.expectedProtection)}</span>
              <span className="warning">
                {[...(candidate.blockers ?? []), ...(candidate.warnings ?? [])].join(", ") || "Analysis only; execution is not exposed."}
              </span>
            </div>
          ))}
          {!candidates.length ? <p className="subtle">No supported hedge candidate is currently ranked.</p> : null}
        </div>
      </section>

      {warnings.length ? <p className="warning">Warnings: {warnings.join(", ")}</p> : null}
      {blockers.length ? <p className="danger">Blockers: {blockers.join(", ")}</p> : null}
      <p className="subtle">Read-only recommendation. No paper or live orders are submitted from this panel.</p>
    </div>
  );
};
