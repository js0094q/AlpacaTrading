import React from "react";
import type { PortfolioRiskSnapshot } from "../../../../src/services/portfolioRiskService.js";

export type HedgeDashboardStatus =
  | "current"
  | "monitoring"
  | "stale"
  | "expired"
  | "blocked";

type DeepPartial<T> = T extends Array<infer Item>
  ? Array<DeepPartial<Item>>
  : T extends object
    ? { [Key in keyof T]?: DeepPartial<T[Key]> }
    : T;

type PartialGreekGroup = DeepPartial<
  NonNullable<PortfolioRiskSnapshot["options"]["groupings"]>["byUnderlying"][string]
>;

type PartialMetricCoverage = DeepPartial<
  NonNullable<PortfolioRiskSnapshot["options"]["coverage"]>["delta"]
>;

export interface HedgeDashboardRecommendation {
  recommendationId?: string;
  effectiveStatus: HedgeDashboardStatus;
  recommendationStatus?: string;
  generatedAt?: string;
  expiresAt?: string;
  environment?: string;
  paperOnly?: boolean;
  liveTradingEnabled?: boolean;
  sourceSnapshotId?: string;
  riskModelVersion?: string;
  regimeModelVersion?: string;
  configurationFingerprint?: string;
  dataQualityStatus?: string;
  reviewedPayloadHash?: string | null;
  decision?: string;
  risk?: DeepPartial<PortfolioRiskSnapshot> | null;
  regime?: {
    regime?: string;
    selectedRule?: string;
  };
  score?: {
    total?: number;
    band?: string;
    measurementStatus?: string;
    effectiveBand?: string;
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
    : "Unavailable";

const numeric = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)
    : "Unavailable";

const percent = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value)
    ? `${(value * 100).toFixed(1)}%`
    : "Unavailable";

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

const freshnessCopy = (
  freshness: DeepPartial<PortfolioRiskSnapshot["options"]["freshness"]> | undefined
) => {
  if (
    !freshness ||
    !["current", "stale", "expired", "malformed", "total"].every(
      (key) => Number.isInteger(freshness[key as keyof typeof freshness])
    )
  ) {
    return "Unavailable";
  }
  return `current ${freshness.current}; stale ${freshness.stale}; expired ${freshness.expired}; malformed ${freshness.malformed}`;
};

const coverageRows = (
  label: string,
  coverage: PartialMetricCoverage | undefined
) => (
  <div>
    {metric(`${label} positions total`, numeric(coverage?.positions?.total))}
    {metric(`${label} positions measured`, numeric(coverage?.positions?.measured))}
    {metric(`${label} positions unmeasured`, numeric(coverage?.positions?.unmeasured))}
    {metric(`${label} position coverage`, percent(coverage?.positions?.coverageRatio))}
    {metric(`${label} contracts total`, numeric(coverage?.absoluteContracts?.total))}
    {metric(`${label} contracts measured`, numeric(coverage?.absoluteContracts?.measured))}
    {metric(`${label} contracts unmeasured`, numeric(coverage?.absoluteContracts?.unmeasured))}
    {metric(`${label} contract coverage`, percent(coverage?.absoluteContracts?.coverageRatio))}
    {metric(`${label} market value total`, money(coverage?.absoluteMarketValue?.total))}
    {metric(`${label} market value measured`, money(coverage?.absoluteMarketValue?.measured))}
    {metric(`${label} market value unmeasured`, money(coverage?.absoluteMarketValue?.unmeasured))}
    {metric(`${label} market-value coverage`, percent(coverage?.absoluteMarketValue?.coverageRatio))}
    {metric(`${label} freshness`, freshnessCopy(coverage?.freshness))}
  </div>
);

const groupingRows = (
  title: string,
  groups: Record<string, PartialGreekGroup | undefined> | undefined
) => {
  const entries = Object.entries(groups ?? {});
  return (
    <div>
      <h4>{title}</h4>
      <div className="list">
        {entries.map(([key, group]) => (
          <div className="row" key={`${title}-${key}`}>
            <strong>{key}</strong>
            <span>{group?.quality ?? "incomplete"}</span>
            <span className="mono">
              Delta {numeric(group?.deltaShares)} shares / {money(group?.deltaDollars)}
            </span>
            <span className="mono">Gamma {numeric(group?.gammaSharesPerDollar)} shares/$1</span>
            <span className="mono">Theta {money(group?.thetaDollarsPerDay)}/day</span>
            <span className="mono">Vega {money(group?.vegaDollarsPerVolPoint)}/vol point</span>
            <span className="mono">Rho {money(group?.rhoDollarsPerRatePoint)}/rate point</span>
            <span className="mono">
              Group IV weighted by contracts {percent(group?.impliedVolatility?.weightedByAbsoluteContracts)}
            </span>
            <span className="mono">
              Group IV weighted by market value {percent(group?.impliedVolatility?.weightedByAbsoluteMarketValue)}
            </span>
            <span className="mono">
              Group IV weighted by vega {percent(group?.impliedVolatility?.weightedByAbsoluteVega)}
            </span>
          </div>
        ))}
        {!entries.length ? <p className="subtle">No grouping evidence available.</p> : null}
      </div>
    </div>
  );
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
  const materialOptionCoverageMissing =
    recommendation.risk?.optionDataCoverage?.materialCoverageMissing === true;
  const optionRisk = recommendation.risk?.options;
  const coverage = optionRisk?.coverage;
  const groupings = optionRisk?.groupings;
  const tradingState =
    recommendation.paperOnly === true &&
    recommendation.environment === "paper" &&
    recommendation.liveTradingEnabled === false
      ? "Paper only — Live trading disabled"
      : "Unavailable";

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

      {materialOptionCoverageMissing ? (
        <p className="danger">
          Incomplete risk measurement: Material option exposure could not be delta-measured.
          The calculated score and band are not a conclusive low-risk classification.
        </p>
      ) : null}

      <div className="hedge-metrics">
        <div>
          {metric("Calculated risk score", recommendation.score?.total ?? "-")}
          {metric("Calculated band", recommendation.score?.band ?? "-")}
          {metric("Measurement status", recommendation.score?.measurementStatus ?? "-")}
          {metric("Effective risk band", recommendation.score?.effectiveBand ?? "-")}
          {metric("Effective decision status", recommendation.recommendationStatus ?? status)}
          {metric("Decision", recommendation.decision ?? "-")}
          {metric("Data quality", recommendation.dataQualityStatus ?? "-")}
          {metric("Market regime", recommendation.regime?.regime ?? "-")}
          {metric("Regime rule", recommendation.regime?.selectedRule ?? "-")}
        </div>
        <div>
          {metric("Portfolio beta", recommendation.risk?.portfolioBeta ?? "-")}
          {metric("Beta coverage", percent(recommendation.risk?.betaCoverage))}
          {metric(
            "Option delta contract coverage",
            percent(recommendation.risk?.optionDataCoverage?.contractDeltaCoveragePct)
          )}
          {metric(
            "Option delta market-value coverage",
            percent(recommendation.risk?.optionDataCoverage?.marketValueDeltaCoveragePct)
          )}
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
          {metric("Trading state", tradingState)}
        </div>
      </div>

      <section>
        <h3>Portfolio option Greeks</h3>
        <div className="hedge-metrics">
          <div>
            {metric("Delta shares", numeric(optionRisk?.deltaShares))}
            {metric("Delta dollars", money(optionRisk?.deltaDollars))}
            {metric(
              "Gamma shares per $1 underlying move",
              numeric(optionRisk?.gammaSharesPerDollar)
            )}
            {metric("Theta dollars per day", money(optionRisk?.thetaDollarsPerDay))}
            {metric(
              "Vega dollars per volatility point",
              money(optionRisk?.vegaDollarsPerVolPoint)
            )}
            {metric("Rho dollars per rate point", money(optionRisk?.rhoDollarsPerRatePoint))}
          </div>
          <div>
            {metric(
              "IV weighted by contracts",
              percent(optionRisk?.impliedVolatility?.weightedByAbsoluteContracts)
            )}
            {metric(
              "IV weighted by market value",
              percent(optionRisk?.impliedVolatility?.weightedByAbsoluteMarketValue)
            )}
            {metric(
              "IV weighted by vega",
              percent(optionRisk?.impliedVolatility?.weightedByAbsoluteVega)
            )}
            {metric("Greek freshness", freshnessCopy(optionRisk?.freshness))}
          </div>
        </div>
      </section>

      <section>
        <h3>Greek evidence coverage</h3>
        <div className="hedge-metrics">
          {([
            ["Delta", "delta"],
            ["Gamma", "gamma"],
            ["Theta", "theta"],
            ["Vega", "vega"],
            ["Rho", "rho"],
            ["IV", "impliedVolatility"]
          ] as const).map(([label, key]) => (
            <React.Fragment key={key}>
              {coverageRows(label, coverage?.[key])}
            </React.Fragment>
          ))}
        </div>
      </section>

      <section>
        <h3>Greek exposure groupings</h3>
        <div className="hedge-sections">
          {groupingRows("By underlying", groupings?.byUnderlying)}
          {groupingRows("By expiration", groupings?.byExpiration)}
          {groupingRows("By option type", groupings?.byOptionType)}
          {groupingRows("By DTE bucket", groupings?.byDteBucket)}
        </div>
      </section>

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
