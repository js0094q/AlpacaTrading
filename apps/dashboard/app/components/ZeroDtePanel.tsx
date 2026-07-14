import type { ZeroDteDashboardSummary } from "../../lib/data";

type Props = {
  summary: ZeroDteDashboardSummary | null;
  error?: string | null;
};

const numberValue = (value: unknown, digits = 2) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : "-";
};

const textValue = (value: unknown) =>
  value === null || value === undefined || value === "" ? "-" : String(value);

export const ZeroDtePanel = ({ summary, error }: Props) => {
  const queue = summary?.queue ?? [];
  const paperPositions = summary?.paperPositions ?? [];
  const shadowTrades = summary?.shadowTrades ?? [];
  const lifecycleCounts = Object.entries(summary?.lifecycle.counts ?? {}).slice(0, 8);
  const learning = summary?.learning;
  const learningCounts = learning?.counts && typeof learning.counts === "object"
    ? learning.counts as Record<string, unknown>
    : {};

  return (
    <div className="panel full zero-dte-panel">
      <div className="zero-dte-header">
        <div>
          <h2>0DTE Level 2</h2>
          <p className="subtle">
            Ranked paper queue, lifecycle evidence, and simulated alternatives.
          </p>
        </div>
        <div className="zero-dte-badges">
          <span className="badge">PAPER ONLY</span>
          <span className="state-pill">SHADOW SIMULATED</span>
        </div>
      </div>

      {error ? <p className="warning">{error}</p> : null}
      {summary?.blockers.length ? (
        <p className="warning">Blockers: {summary.blockers.slice(0, 8).join(", ")}</p>
      ) : null}

      <div className="zero-dte-health">
        <div><span>Status</span><strong>{summary?.engine.status ?? "unavailable"}</strong></div>
        <div><span>Last cycle</span><strong>{textValue(summary?.engine.lastRunAt)}</strong></div>
        <div><span>Queue</span><strong>{summary?.engine.queueSize ?? 0}</strong></div>
        <div><span>Stale data</span><strong>{summary?.engine.staleDataCount ?? 0}</strong></div>
        <div><span>Trading date</span><strong>{textValue(summary?.tradingDate)}</strong></div>
      </div>

      <div className="zero-dte-columns">
        <section className="zero-dte-section">
          <h3>Ranked candidate queue</h3>
          <div className="zero-dte-table">
            <div className="zero-dte-row zero-dte-row-head">
              <span>Rank</span><span>Contract</span><span>Playbook</span><span>Score / slope</span>
              <span>Spread</span><span>State</span><span>Blocker</span>
            </div>
            {queue.slice(0, 20).map((candidate, index) => {
              const quote = candidate.quote && typeof candidate.quote === "object"
                ? candidate.quote as Record<string, unknown>
                : {};
              const blocker = Array.isArray(candidate.blockers) ? candidate.blockers[0] : null;
              return (
                <div className="zero-dte-row" key={String(candidate.candidateId || index)}>
                  <span>{textValue(candidate.rank ?? index + 1)}</span>
                  <strong>{textValue(candidate.optionSymbol)}</strong>
                  <span>{textValue(candidate.playbook)} / {textValue(candidate.direction)}</span>
                  <span className="mono">
                    {numberValue(candidate.totalScore ?? candidate.score)} / {numberValue(candidate.signalSlope)}
                  </span>
                  <span className="mono">{numberValue(quote.spreadPct)}%</span>
                  <span>{textValue(candidate.state)}</span>
                  <span>{textValue(blocker)}</span>
                </div>
              );
            })}
            {!queue.length ? <p className="subtle">No Level 2 candidates available.</p> : null}
          </div>
        </section>

        <section className="zero-dte-section">
          <h3>Active paper positions</h3>
          <div className="zero-dte-list">
            {paperPositions.slice(0, 10).map((position, index) => (
              <div className="zero-dte-list-row" key={String(position.paperTradeId || index)}>
                <strong>{textValue(position.optionSymbol)}</strong>
                <span>{textValue(position.status)} / {textValue(position.playbook)}</span>
                <span className="mono">
                  {numberValue(position.entryPremium)} → {numberValue(position.currentMark)}
                </span>
                <span className="mono">P/L {numberValue(position.unrealizedPnl)}</span>
              </div>
            ))}
            {!paperPositions.length ? <p className="subtle">No active 0DTE paper positions.</p> : null}
          </div>
        </section>

        <section className="zero-dte-section">
          <h3>Shadow portfolio <span className="subtle">(simulated)</span></h3>
          <div className="zero-dte-list">
            {shadowTrades.slice(0, 10).map((trade, index) => (
              <div className="zero-dte-list-row" key={String(trade.shadowTradeId || index)}>
                <strong>{textValue(trade.optionSymbol)}</strong>
                <span>{textValue(trade.status)} / {textValue(trade.alternativeType)}</span>
                <span className="mono">P/L {numberValue(trade.realizedPnl ?? trade.mfe)}</span>
                <span>{textValue(trade.terminalState)}</span>
              </div>
            ))}
            {!shadowTrades.length ? <p className="subtle">No simulated shadow trades.</p> : null}
          </div>
        </section>
      </div>

      <div className="zero-dte-footer">
        <section>
          <h3>Lifecycle counts</h3>
          <div className="zero-dte-counts">
            {lifecycleCounts.map(([event, count]) => <span key={event}>{event}: <strong>{count}</strong></span>)}
            {!lifecycleCounts.length ? <span className="subtle">No lifecycle events.</span> : null}
          </div>
        </section>
        <section>
          <h3>Learning summary</h3>
          <div className="zero-dte-counts">
            <span>Outcomes: <strong>{textValue(learningCounts.outcomes)}</strong></span>
            <span>Complete: <strong>{textValue(learningCounts.complete)}</strong></span>
            <span>Shadow closed: <strong>{textValue(learningCounts.closedShadowTrades)}</strong></span>
            <span>Realized P/L: <strong>{numberValue(learning?.realizedPnl)}</strong></span>
          </div>
        </section>
      </div>
    </div>
  );
};

export default ZeroDtePanel;
