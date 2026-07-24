import React from "react";

type EvidenceRow = Record<string, unknown>;

const recordValue = (value: unknown): EvidenceRow =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as EvidenceRow
    : {};

const displayValue = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return typeof value === "string" ? value : "-";
};

const compactFields = (
  value: unknown,
  fields: readonly string[]
) => {
  const row = recordValue(value);
  const parts = fields
    .map((field) => [field, row[field]] as const)
    .filter(([, entry]) => entry !== null && entry !== undefined && entry !== "")
    .map(([field, entry]) => `${field}=${displayValue(entry)}`);
  return parts.length ? parts.join(", ") : "-";
};

const lifecycleLabel = (classification: unknown) => {
  const value = displayValue(classification);
  if (value === "no_action") return "Successful-empty";
  if (value === "blocked") return "Blocked";
  if (value === "success") return "Success";
  return value;
};

const PremiumEvidence = ({ value }: { value: unknown }) => {
  const evidence = recordValue(value);
  const fields = [
    ["SIP price", evidence.sipPrice],
    ["SIP freshness", evidence.sipFreshnessStatus],
    ["OPRA", evidence.opraFeed],
    ["Bid", evidence.bid],
    ["Ask", evidence.ask],
    ["Spread", evidence.spread],
    ["Volume", evidence.volume],
    ["Open interest", evidence.openInterest],
    ["Implied volatility", evidence.impliedVolatility],
    ["Delta", evidence.delta],
    ["Gamma", evidence.gamma],
    ["Theta", evidence.theta],
    ["Vega", evidence.vega],
    ["Rho", evidence.rho],
    ["Historical bars", evidence.historicalBarCount],
    ["Realized volatility", evidence.realizedVolatility],
    ["Liquidity score", evidence.liquidityScore],
    ["Final confidence", evidence.finalConfidence],
    ["Expected return", evidence.expectedReturn]
  ] as const;

  return (
    <div className="row">
      <strong>Premium decision evidence</strong>
      {fields.map(([label, entry]) => (
        <span key={label}>{label}: {displayValue(entry)}</span>
      ))}
      <span>
        Position sizing: {compactFields(
          evidence.positionSizingInput,
          ["quantity", "notional", "referencePrice", "allocationAmount"]
        )}
      </span>
      <span>
        Limit construction: {compactFields(
          evidence.limitPriceConstruction,
          ["limitPrice", "bid", "ask", "midpoint", "referencePrice"]
        )}
      </span>
      <span>
        Score components: {compactFields(
          evidence.scoreComponents,
          [
            "confidence",
            "expectedReturn",
            "volatilityAdjusted",
            "freshness",
            "optionLiquidity",
            "riskProfile"
          ]
        )}
      </span>
      <span>
        Strategy classification: {compactFields(
          evidence.strategyClassification,
          ["family", "daysToExpiration", "leapsMinDte", "leapsMaxDte"]
        )}
      </span>
    </div>
  );
};

export const PostgresEvidencePanel = ({
  plans,
  intents,
  lifecycle
}: {
  plans: unknown[];
  intents: unknown[];
  lifecycle: unknown[];
}) => (
  <div className="panel wide">
    <h2>PostgreSQL Evidence Trail</h2>
    <p className="subtle">
      Durable PostgreSQL lineage and broker-backed state. Missing evidence remains unavailable.
    </p>

    <h3>Candidates and executions</h3>
    <div className="list">
      {plans.slice(0, 8).map((value, index) => {
        const row = recordValue(value);
        return (
          <div key={displayValue(row.candidate_id ?? row.id) || `candidate-${index}`}>
            <div className="row">
              <strong>
                Candidate {displayValue(row.candidate_id ?? row.id)} ·{" "}
                {displayValue(row.option_symbol ?? row.symbol)}
              </strong>
              <span>strategy {displayValue(row.strategy_family)}</span>
              <span>expression {displayValue(row.preferred_expression)}</span>
              <span>direction {displayValue(row.direction)}</span>
              <span>review {displayValue(row.review_id)}</span>
              <span>
                confirmation {displayValue(row.confirmation_id)} ({displayValue(row.confirmation_status)})
              </span>
              <span>
                intent {displayValue(row.intent_id)} ({displayValue(row.intent_status)})
              </span>
              <span>client {displayValue(row.client_order_id)}</span>
              <span>
                broker {displayValue(row.broker_order_id)} ({displayValue(row.broker_order_status)})
              </span>
              <span>
                fill {displayValue(row.filled_quantity)} @ {displayValue(row.filled_average_price)}
              </span>
              <span>
                position {displayValue(row.position_id)} ({displayValue(row.position_status)})
              </span>
              <span>
                reservation {displayValue(row.reservation_id)} ({displayValue(row.reservation_status)})
              </span>
              <span>reconciled {displayValue(row.last_reconciled_at)}</span>
            </div>
            <PremiumEvidence value={row.premium_decision_evidence} />
          </div>
        );
      })}
      {!plans.length ? (
        <p className="subtle">Successful-empty: no candidate rows are currently available.</p>
      ) : null}
    </div>

    <h3>Recent order intents</h3>
    <div className="list">
      {intents.slice(0, 12).map((value, index) => {
        const row = recordValue(value);
        return (
          <div className="row" key={displayValue(row.intent_id) || `intent-${index}`}>
            <strong>
              Intent {displayValue(row.intent_id)} · {displayValue(row.symbol)}
            </strong>
            <span>{displayValue(row.intent_status)}</span>
            <span>reason {displayValue(row.intent_terminal_reason)}</span>
            <span>candidate {displayValue(row.candidate_id)}</span>
            <span>review {displayValue(row.review_id)}</span>
            <span>
              confirmation {displayValue(row.confirmation_id)} ({displayValue(row.confirmation_status)})
            </span>
            <span>client {displayValue(row.client_order_id)}</span>
            <span>
              broker {displayValue(row.broker_order_id)} ({displayValue(row.broker_order_status)})
            </span>
            <span>
              reservation {displayValue(row.reservation_id)} ({displayValue(row.reservation_status)})
            </span>
            <span>
              position {displayValue(row.position_id)} ({displayValue(row.position_status)})
            </span>
            <span>reconciled {displayValue(row.last_reconciled_at)}</span>
          </div>
        );
      })}
      {!intents.length ? (
        <p className="subtle">Successful-empty: no recent order intents are available.</p>
      ) : null}
    </div>

    <h3>Latest completed autonomous cycle</h3>
    <div className="list">
      {lifecycle.map((value, index) => {
        const row = recordValue(value);
        return (
          <div
            className="row"
            key={`${displayValue(row.cycle_id)}-${displayValue(row.position)}-${index}`}
          >
            <strong>
              {lifecycleLabel(row.classification)} · {displayValue(row.workstream ?? row.event_type)}
            </strong>
            <span>cycle {displayValue(row.cycle_id)}</span>
            <span>position {displayValue(row.position)}</span>
            <span>reason {displayValue(row.reason_code)}</span>
            <span>duration {displayValue(row.duration_ms)} ms</span>
            <span>at {displayValue(row.occurred_at)}</span>
          </div>
        );
      })}
      {!lifecycle.length ? (
        <p className="subtle">Unavailable: no completed autonomous cycle evidence is present.</p>
      ) : null}
    </div>
  </div>
);
