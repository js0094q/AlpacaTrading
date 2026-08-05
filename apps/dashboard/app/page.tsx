import { ActionPanel } from "./components/ActionPanel";
import {
  HedgePanel,
  type HedgeDashboardRecommendation
} from "./components/HedgePanel";
import ZeroDtePanel from "./components/ZeroDtePanel";
import { PostgresEvidencePanel } from "./components/PostgresEvidencePanel";
import {
  buildDashboardSnapshot,
  dashboardMoney,
  latestZeroDteSummary,
  type DashboardSnapshot,
  type ZeroDteDashboardSummary
} from "../lib/data";
import {
  formatOptionDecisionField,
  formatOptionEvidenceValue
} from "../../../src/services/optionDecisionEvidenceService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type DashboardCaptureResult<T> = {
  ok: true;
  data: T;
  label?: string;
};

type DashboardCaptureError = {
  ok: false;
  error: string;
  label?: string;
};

const asResult = <T,>(value: DashboardCaptureResult<T> | DashboardCaptureError | null) =>
  value as DashboardCaptureResult<T> | DashboardCaptureError | null;

type PaperAccountSnapshot = {
  status?: string;
  equity?: string | number;
  cash?: string | number;
  buyingPower?: string | number;
};

type PaperPositionsSnapshot = {
  positions: Array<{
    symbol?: string;
    qty?: string | number;
    marketValue?: string | number;
  }>;
};

type PaperPlanSnapshot = {
  plan: Array<{
    symbol?: string;
    decision?: string;
    latestRank?: number;
    strategy?: string | null;
    estimatedNotional?: number | null;
  }>;
};

type PaperReviewSnapshot = {
  review: {
    status: string;
    blockers: Array<string>;
    warnings: Array<string>;
  };
  planSummary: {
    plannedOrders: number;
  };
};

type PaperDryRunSnapshot = {
  summary: {
    wouldSubmitCount: number;
    payloadsBlocked: number;
  };
  assetClass: string;
};

type AutonomousWorkerSnapshot = {
  status?: "running" | "stopped" | "failed" | "stale" | "unknown";
  active?: boolean;
  lastEventType?: string | null;
  lastEventAt?: string | null;
  cycleId?: string | null;
  lastCycleCompletedAt?: string | null;
};

type PaperExecutionSnapshot = {
  symbol?: string;
  id?: string;
  order_intent_id?: string | null;
  execution_review_id?: string | null;
  candidate_id?: string | null;
  reservation_id?: string | null;
  position_id?: string | null;
  status?: string;
  strategy?: string;
  requestId?: string;
  clientOrderId?: string;
  broker_order_id?: string | null;
  filled_quantity?: string | number | null;
  filled_average_price?: string | number | null;
  last_reconciled_at?: string | null;
};

type PaperOpenOrder = {
  id?: string;
  clientOrderId?: string;
  symbol?: string;
  side?: string;
  status?: string;
  qty?: string;
  notional?: string;
  submittedAt?: string;
};

type PaperOpenOrdersSnapshot = {
  orders?: PaperOpenOrder[];
  requestId?: string;
};

type OptionContractRow = DashboardSnapshot["optionContracts"][number];

type PaperLearningSummary = {
  pending?: number;
  evaluated?: number;
  promoted?: number;
  rejected?: number;
};

type PromotionReadinessRow = {
  strategyFamily?: string;
  totalTrades?: number;
  evaluatedTrades?: number;
  profitFactorLiveLike?: number;
  eligibleForLiveReview?: boolean;
  blockReasons?: string[];
};

const dashboardLoadError = (message: string) => {
  const lower = message.toLowerCase();
  if (lower.includes("abort") || lower.includes("timed out") || lower.includes("timeout")) {
    return {
      title: "Dashboard Data",
      message: "VPS summary timed out while loading dashboard state."
    };
  }

  return {
    title: "Environment Guard",
    message
  };
};

const Metric = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="metric">
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
);

const optionPrice = (value: number | null | undefined) =>
  typeof value === "number" ? value.toFixed(2) : "-";

const optionCategoryCount = (
  rows: OptionContractRow[],
  category: OptionContractRow["displayCategory"]
) => rows.filter((row) => row.displayCategory === category).length;

const StatusSignal = ({
  label,
  value,
  tone,
  detail
}: {
  label: string;
  value: string;
  tone: "healthy" | "warning" | "danger" | "neutral";
  detail: string;
}) => (
  <div className={`status-signal ${tone}`}>
    <span className="status-dot" aria-hidden="true" />
    <span>
      <small>{label}</small>
      <strong>{value}</strong>
      <span className="sr-only">. {detail}</span>
    </span>
  </div>
);

const DetailHeader = ({ title, description }: { title: string; description: string }) => (
  <span className="detail-header">
    <strong>{title}</strong>
    <span>{description}</span>
  </span>
);

export default async function DashboardPage() {
  let snapshot: DashboardSnapshot | null = null;
  let guardError: string | null = null;
  let zeroDteSummary: ZeroDteDashboardSummary | null = null;
  let zeroDteError: string | null = null;

  try {
    snapshot = await buildDashboardSnapshot();
  } catch (error) {
    guardError = error instanceof Error ? error.message : "Dashboard guard failed.";
  }
  try {
    zeroDteSummary = await latestZeroDteSummary(25);
  } catch (error) {
    zeroDteError = error instanceof Error ? error.message : "0DTE summary unavailable.";
  }
  const loadError = guardError ? dashboardLoadError(guardError) : null;

  const account = snapshot
    ? asResult<PaperAccountSnapshot>(snapshot.account as DashboardCaptureResult<PaperAccountSnapshot> | DashboardCaptureError)
    : null;
  const positions = snapshot
    ? asResult<PaperPositionsSnapshot>(snapshot.positions as DashboardCaptureResult<PaperPositionsSnapshot> | DashboardCaptureError)
    : null;
  const plan = snapshot
    ? asResult<PaperPlanSnapshot>(snapshot.plan as DashboardCaptureResult<PaperPlanSnapshot> | DashboardCaptureError)
    : null;
  const review = snapshot
    ? asResult<PaperReviewSnapshot>(snapshot.review as DashboardCaptureResult<PaperReviewSnapshot> | DashboardCaptureError)
    : null;
  const dryRun = snapshot
    ? asResult<PaperDryRunSnapshot>(snapshot.dryRun as DashboardCaptureResult<PaperDryRunSnapshot> | DashboardCaptureError)
    : null;
  const worker = snapshot
    ? asResult<AutonomousWorkerSnapshot>(
        snapshot.runtime as
          | DashboardCaptureResult<AutonomousWorkerSnapshot>
          | DashboardCaptureError
      )
    : null;
  const executions = snapshot
    ? asResult<PaperExecutionSnapshot[]>(snapshot.executions as DashboardCaptureResult<PaperExecutionSnapshot[]> | DashboardCaptureError)
    : null;
  const openOrders = snapshot
    ? asResult<PaperOpenOrdersSnapshot>(snapshot.openOrders as DashboardCaptureResult<PaperOpenOrdersSnapshot> | DashboardCaptureError)
    : null;
  const learningSummary = snapshot
    ? asResult<PaperLearningSummary>(snapshot.learningSummary as DashboardCaptureResult<PaperLearningSummary> | DashboardCaptureError)
    : null;
  const hedge = snapshot
    ? asResult<HedgeDashboardRecommendation | null>(
        snapshot.hedge as
          | DashboardCaptureResult<HedgeDashboardRecommendation | null>
          | DashboardCaptureError
      )
    : null;
  const openOrderRows = openOrders?.ok ? openOrders.data.orders || [] : [];
  const optionRows = snapshot?.optionContracts || [];
  const promotionReadiness = (Array.isArray(snapshot?.promotionReadiness)
    ? snapshot?.promotionReadiness
    : []) as PromotionReadinessRow[];
  const vercelReadOnly = snapshot?.mode === "vercel-read-only";
  const workerRunning = Boolean(
    worker?.ok && worker.data.active && worker.data.status === "running"
  );
  const workerStatus = worker?.ok ? worker.data.status || "unknown" : "unavailable";
  const reviewStatus = review?.ok ? review.data.review.status : "unavailable";
  const reviewBlockers = review?.ok ? review.data.review.blockers : [];
  const zeroDteBlockers = zeroDteSummary?.blockers || [];
  const postgresReady = Boolean(snapshot && !loadError && snapshot.paperOnly);

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Dashboard navigation">
        <a className="brand" href="#overview">Alpaca Paper</a>
        <nav>
          <a className="active" href="#overview">Overview</a>
          <a href="#portfolio">Portfolio</a>
          <a href="#orders">Orders</a>
          <a href="#research">Research</a>
          <a href="#zero-dte">0DTE</a>
          <a href="#evidence">Evidence</a>
          <a href="#controls">Controls</a>
        </nav>
        <div className="sidebar-safety">
          <strong>Paper environment</strong>
          <span>Live trading is off</span>
        </div>
      </aside>

      <main className="shell">
        <header className="topbar">
          <div>
            <h1 className="title">Alpaca Paper Operations</h1>
            <p>Monitor the paper runtime, account, readiness, and evidence.</p>
          </div>
          <div className="topbar-actions">
            <span className="last-refresh">Updated {snapshot?.generatedAt || new Date().toISOString()}</span>
            <span className="badge">PAPER ONLY</span>
            <a className="refresh-button" href="/">Refresh</a>
          </div>
        </header>

        {loadError ? (
          <section className="inline-alert danger-alert">
            <strong>{loadError.title}</strong>
            <span>{loadError.message}</span>
          </section>
        ) : null}

        {snapshot?.historicalDataAvailable === false ? (
          <section className="inline-alert warning-alert">
            <strong>Runtime history is limited</strong>
            <span>{snapshot.historicalWarning}</span>
          </section>
        ) : null}

        <section className="overview" id="overview">
          <h2 className="sr-only">Operations overview</h2>
          <div className="status-rail">
            <StatusSignal
              label="Control API"
              value={loadError ? "UNAVAILABLE" : "HEALTHY"}
              tone={loadError ? "danger" : "healthy"}
              detail="Dashboard control bridge status"
            />
            <StatusSignal
              label="Autonomous worker"
              value={workerRunning ? "RUNNING" : workerStatus.toUpperCase()}
              tone={workerRunning ? "healthy" : "warning"}
              detail={workerRunning ? "Paper worker is active" : "Paper worker is not running"}
            />
            <StatusSignal
              label="PostgreSQL authority"
              value={postgresReady ? "PASSED" : "UNAVAILABLE"}
              tone={postgresReady ? "healthy" : "danger"}
              detail="Dashboard state is PostgreSQL authoritative"
            />
            <StatusSignal
              label="Live trading"
              value={snapshot?.liveTradingEnabled ? "ON" : "OFF"}
              tone={snapshot?.liveTradingEnabled ? "danger" : "neutral"}
              detail="Live trading must remain disabled"
            />
          </div>

          <div className="overview-layout">
            <div className="overview-primary">
              <section className="ops-panel account-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Account summary</h2>
                    <p>Current Alpaca paper-account values.</p>
                  </div>
                  <span className="text-state healthy-text">{account?.ok ? account.data.status || "ACTIVE" : "UNAVAILABLE"}</span>
                </div>
                {account?.ok ? (
                  <div className="account-metrics">
                    <Metric label="Equity" value={dashboardMoney(account.data.equity)} />
                    <Metric label="Cash" value={dashboardMoney(account.data.cash)} />
                    <Metric label="Buying power" value={dashboardMoney(account.data.buyingPower)} />
                  </div>
                ) : (
                  <p className="warning">{account?.error || "Unavailable"}</p>
                )}
              </section>

              <section className="ops-panel readiness-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Execution readiness</h2>
                    <p>Review state and paper-order prerequisites.</p>
                  </div>
                  <span className={`text-state ${reviewStatus === "ready" ? "healthy-text" : "danger-text"}`}>
                    {reviewStatus.toUpperCase()}
                  </span>
                </div>
                <div className="readiness-layout">
                  <div className="readiness-summary">
                    <strong>{reviewStatus === "ready" ? "Paper execution is ready." : "Paper execution is blocked."}</strong>
                    <span>{review?.ok ? `${review.data.planSummary.plannedOrders} planned orders` : review?.error || "Review unavailable"}</span>
                  </div>
                  <div className="blocker-list">
                    <h3>Top blockers</h3>
                    {reviewBlockers.slice(0, 4).map((blocker) => <span key={blocker}>{blocker}</span>)}
                    {!reviewBlockers.length ? <span>No persisted blockers.</span> : null}
                  </div>
                </div>
              </section>

              <section className="ops-panel" id="orders">
                <div className="panel-heading">
                  <div><h2>Open orders</h2><p>Current broker-backed paper orders.</p></div>
                  <strong>{openOrderRows.length}</strong>
                </div>
                {openOrders?.ok ? (
                  <div className="ops-table" role="table" aria-label="Open paper orders">
                    <div className="ops-table-row ops-table-head" role="row">
                      <span>Symbol</span><span>Side</span><span>Quantity</span><span>Status</span>
                    </div>
                    {openOrderRows.slice(0, 8).map((order) => (
                      <div className="ops-table-row" role="row" key={order.id || order.clientOrderId}>
                        <strong>{order.symbol || "-"}</strong>
                        <span>{order.side || "-"}</span>
                        <span className="mono">{order.qty || order.notional || "-"}</span>
                        <span>{order.status || "-"}</span>
                      </div>
                    ))}
                    {!openOrderRows.length ? <p className="empty-state">No open paper orders.</p> : null}
                  </div>
                ) : <p className="warning">{openOrders?.error || "Unavailable"}</p>}
              </section>

              <section className="ops-panel" id="portfolio">
                <div className="panel-heading">
                  <div><h2>Positions</h2><p>Current paper holdings and market value.</p></div>
                  <strong>{positions?.ok ? positions.data.positions.length : "-"}</strong>
                </div>
                {positions?.ok ? (
                  <div className="ops-table" role="table" aria-label="Paper positions">
                    <div className="ops-table-row position-row ops-table-head" role="row">
                      <span>Symbol</span><span>Quantity</span><span>Market value</span>
                    </div>
                    {positions.data.positions.slice(0, 8).map((position) => (
                      <div className="ops-table-row position-row" role="row" key={position.symbol}>
                        <strong>{position.symbol}</strong>
                        <span className="mono">{position.qty || "-"}</span>
                        <span className="mono">{dashboardMoney(position.marketValue)}</span>
                      </div>
                    ))}
                    {!positions.data.positions.length ? <p className="empty-state">No open paper positions.</p> : null}
                  </div>
                ) : <p className="warning">{positions?.error || "Unavailable"}</p>}
              </section>
            </div>

            <aside className="overview-rail" aria-label="Attention and next steps">
              <section className="ops-panel attention-panel">
                <div className="panel-heading"><h2>Needs attention</h2></div>
                <div className="attention-list">
                  {!workerRunning ? (
                    <a href="#controls"><strong>Paper worker is {workerStatus}</strong><span>Autonomous paper processing is not active.</span></a>
                  ) : null}
                  {reviewStatus !== "ready" ? (
                    <a href="#research"><strong>Execution review is {reviewStatus}</strong><span>Refresh and review before any paper action.</span></a>
                  ) : null}
                  {zeroDteBlockers.length ? (
                    <a href="#zero-dte"><strong>No current 0DTE candidates</strong><span>{zeroDteBlockers[0]}</span></a>
                  ) : null}
                  <div className="attention-info"><strong>Live trading is off</strong><span>Paper operations only.</span></div>
                </div>
              </section>

              <section className="ops-panel next-steps-panel">
                <div className="panel-heading"><h2>Safe next steps</h2></div>
                <a href="#portfolio"><span><strong>Review portfolio risk</strong><small>Inspect holdings and hedge state</small></span><b>Open</b></a>
                <a href="#research"><span><strong>Refresh research</strong><small>Review candidates and learning</small></span><b>Open</b></a>
                <a href="#zero-dte"><span><strong>Inspect 0DTE</strong><small>Queue, blockers, and simulated state</small></span><b>Open</b></a>
                <a href="#evidence"><span><strong>View system checks</strong><small>PostgreSQL lineage and execution evidence</small></span><b>View</b></a>
              </section>

              <section className="ops-panel activity-panel">
                <div className="panel-heading"><h2>Recent activity</h2></div>
                <div className="activity-list">
                  <span><i className="healthy-dot" /><time>{snapshot?.generatedAt || "-"}</time><strong>Control API snapshot loaded</strong></span>
                  <span><i className={workerRunning ? "healthy-dot" : "warning-dot"} /><time>{worker?.ok ? worker.data.lastEventAt || "-" : "-"}</time><strong>{worker?.ok ? worker.data.lastEventType || "Worker state checked" : "Worker unavailable"}</strong></span>
                  <span><i className="healthy-dot" /><time>{worker?.ok ? worker.data.lastCycleCompletedAt || "-" : "-"}</time><strong>Last completed worker cycle</strong></span>
                </div>
              </section>
            </aside>
          </div>
        </section>

        <details className="detail-section" id="portfolio-details">
          <summary><DetailHeader title="Portfolio risk and hedge review" description="Detailed risk measurements, scenarios, and hedge evidence." /></summary>
          <div className="detail-grid">
            <HedgePanel recommendation={hedge?.ok ? hedge.data : null} error={hedge && !hedge.ok ? hedge.error : null} />
            <div className="panel wide">
              <h2>Latest plan</h2>
              {plan?.ok ? <div className="list">
                {plan.data.plan.slice(0, 8).map((entry) => <div className="row" key={`${entry.symbol}-${entry.latestRank}`}><strong>{entry.symbol}</strong><span>{entry.decision} {entry.strategy ? `- ${entry.strategy}` : ""}</span><span className="mono">{dashboardMoney(entry.estimatedNotional)}</span></div>)}
                {!plan.data.plan.length ? <p className="subtle">No current plan rows.</p> : null}
              </div> : <p className="warning">{plan?.error || "Unavailable"}</p>}
            </div>
          </div>
        </details>

        <details className="detail-section" id="zero-dte">
          <summary><DetailHeader title="0DTE operations" description="Ranked queue, paper positions, lifecycle, and simulated alternatives." /></summary>
          <div className="detail-grid"><ZeroDtePanel summary={zeroDteSummary} error={zeroDteError} /></div>
        </details>

        <details className="detail-section" id="research">
          <summary><DetailHeader title="Research and learning" description="Latest research, learning ledger, promotion evidence, and dry-run state." /></summary>
          <div className="detail-grid">
            <div className="panel wide">
              <h2>Learning ledger</h2>
              {learningSummary?.ok ? <>
                <div className="option-counts"><Metric label="Pending" value={learningSummary.data.pending ?? 0} /><Metric label="Evaluated" value={learningSummary.data.evaluated ?? 0} /><Metric label="Promoted" value={learningSummary.data.promoted ?? 0} /><Metric label="Rejected" value={learningSummary.data.rejected ?? 0} /></div>
                <div className="list">{promotionReadiness.map((entry) => <div className="row" key={entry.strategyFamily}><strong>{entry.strategyFamily || "-"}</strong><span>{String(Boolean(entry.eligibleForLiveReview))}</span><span className="mono">{entry.evaluatedTrades ?? 0}/{entry.totalTrades ?? 0}</span><span className="mono">PF {entry.profitFactorLiveLike ?? 0}</span><span>{entry.blockReasons?.join(", ") || "none"}</span></div>)}{!promotionReadiness.length ? <p className="subtle">No promotion analytics yet.</p> : null}</div>
              </> : <p className="warning">{learningSummary?.error || "Unavailable"}</p>}
            </div>
            <div className="panel">
              <h2>Latest research</h2>
              <div className="list">{(snapshot?.latestResearch || []).map((row) => { const researchRow = row as Record<string, unknown>; return <div className="row" key={String(researchRow.id || "research")}><strong>{String(researchRow.risk_profile || "-")}</strong><span>{String(researchRow.status || "-")}</span><span className="mono">{String(researchRow.candidates_selected ?? "-")}</span></div>; })}{!snapshot?.latestResearch?.length ? <p className="subtle">Successful-empty: no research runs are available.</p> : null}</div>
            </div>
            <div className="panel">
              <h2>Dry run</h2>
              {dryRun?.ok ? <><Metric label="Would submit" value={dryRun.data.summary.wouldSubmitCount} /><Metric label="Blocked payloads" value={dryRun.data.summary.payloadsBlocked} /><Metric label="Asset filter" value={dryRun.data.assetClass} /></> : <p className="warning">{dryRun?.error || "Unavailable"}</p>}
            </div>
          </div>
        </details>

        <details className="detail-section" id="evidence">
          <summary><DetailHeader title="PostgreSQL evidence" description="Durable lineage, execution ledger, option evidence, and request IDs." /></summary>
          <div className="detail-grid">
            <PostgresEvidencePanel plans={snapshot?.latestPaperPlans || []} intents={snapshot?.orderIntents || []} lifecycle={snapshot?.autonomousLifecycle || []} />
            <div className="panel full"><h2>Execution ledger</h2>{executions?.ok ? <div className="list">{executions.data.slice(0, 12).map((entry) => <div className="row" key={entry.id || entry.broker_order_id || entry.clientOrderId}><strong>{entry.symbol || "-"}</strong><span>{entry.status || "-"} {entry.strategy ? `- ${entry.strategy}` : ""}</span><span className="mono">{entry.broker_order_id || entry.clientOrderId || "-"}</span><span>intent {entry.order_intent_id || "-"}</span><span>position {entry.position_id || "-"}</span><span>fill {entry.filled_quantity ?? "-"} @ {entry.filled_average_price ?? "-"}</span><span>reconciled {entry.last_reconciled_at || "-"}</span></div>)}{!executions.data.length ? <p className="subtle">No ledger rows yet.</p> : null}</div> : <p className="warning">{executions?.error || "Unavailable"}</p>}</div>
            <div className="panel wide">
              <h2>Option contracts</h2>
              <div className="option-counts"><Metric label="Discovered" value={optionCategoryCount(optionRows, "Discovered")} /><Metric label="Quoted" value={optionCategoryCount(optionRows, "Quoted")} /><Metric label="Executable" value={optionCategoryCount(optionRows, "Executable")} /><Metric label="Rejected" value={optionCategoryCount(optionRows, "Rejected")} /></div>
              <div className="option-table"><div className="option-row option-head"><span>Category</span><span>Contract</span><span>Quote Status</span><span>Executable</span><span>Reject Reason</span><span>Executable Price</span><span>Source</span></div>{optionRows.slice(0, 10).map((entry) => <div key={entry.option_symbol}><div className="option-row"><span>{entry.displayCategory}</span><strong>{entry.option_symbol}</strong><span>{entry.quoteStatus}</span><span>{String(entry.executable)}</span><span>{entry.rejectionReason || "-"}</span><span className="mono">{optionPrice(entry.executablePrice)}</span><span>{entry.executablePriceSource || "-"}</span></div><div className="option-evidence-grid"><span><b>Underlying price</b>{formatOptionDecisionField(entry.decisionUse.underlyingPrice)}</span><span><b>Strike</b>{formatOptionDecisionField(entry.decisionUse.strike)}</span><span><b>DTE</b>{formatOptionDecisionField(entry.decisionUse.daysToExpiration)}</span><span><b>Delta</b>{formatOptionDecisionField(entry.decisionUse.delta)}</span><span><b>Gamma</b>{formatOptionDecisionField(entry.decisionUse.gamma)}</span><span><b>Theta</b>{formatOptionDecisionField(entry.decisionUse.theta)}</span><span><b>Vega</b>{formatOptionDecisionField(entry.decisionUse.vega)}</span><span><b>Rho</b>{formatOptionDecisionField(entry.decisionUse.rho)}</span><span><b>IV</b>{formatOptionDecisionField(entry.decisionUse.impliedVolatility)}</span><span><b>Bid</b>{formatOptionDecisionField(entry.decisionUse.bid)}</span><span><b>Ask</b>{formatOptionDecisionField(entry.decisionUse.ask)}</span><span><b>Midpoint</b>{formatOptionDecisionField(entry.decisionUse.midpoint)}</span><span><b>Last</b>{formatOptionDecisionField(entry.decisionUse.last)}</span><span><b>Spread %</b>{formatOptionDecisionField(entry.decisionUse.spreadPercentage, "%")}</span><span><b>Open interest</b>{formatOptionDecisionField(entry.decisionUse.openInterest)}</span><span><b>Volume</b>{formatOptionDecisionField(entry.decisionUse.volume)}</span><span><b>Quote time</b>{formatOptionEvidenceValue(entry.quoteTimestamp, entry.decisionSnapshot.availability.quote)}</span><span><b>Quote age</b>{formatOptionDecisionField(entry.decisionUse.quoteAgeMs, " ms")}</span><span><b>Source</b>{entry.sourceFeed || entry.source || formatOptionEvidenceValue(null, entry.decisionSnapshot.availability.snapshot)}</span><span><b>Greek status</b>{entry.greekAvailability} · {entry.dataQualityStatus}</span><span className="option-evidence-reason"><b>Rejection reason</b>{entry.rejectionReasons.join(", ") || "-"}</span></div></div>)}{!optionRows.length ? <p className="subtle">No option contracts discovered.</p> : null}</div>
            </div>
            <div className="panel"><h2>Recent request IDs</h2><pre>{JSON.stringify(snapshot?.requestIds || [], null, 2)}</pre></div>
          </div>
        </details>

        <details className="guarded-actions" id="controls">
          <summary><DetailHeader title="Guarded actions" description="High-impact paper actions are hidden by default. Expand deliberately." /></summary>
          <ActionPanel readOnly={vercelReadOnly} />
        </details>
      </main>
    </div>
  );
}
