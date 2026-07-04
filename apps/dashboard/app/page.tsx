import { ActionPanel } from "./components/ActionPanel";
import { buildDashboardSnapshot, dashboardMoney, type DashboardSnapshot } from "../lib/data";

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

type PaperExecutionSnapshot = {
  symbol?: string;
  id?: string;
  status?: string;
  strategy?: string;
  requestId?: string;
  clientOrderId?: string;
};

const Metric = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="metric">
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
);

export default async function DashboardPage() {
  let snapshot: DashboardSnapshot | null = null;
  let guardError: string | null = null;

  try {
    snapshot = await buildDashboardSnapshot();
  } catch (error) {
    guardError = error instanceof Error ? error.message : "Dashboard guard failed.";
  }

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
  const executions = snapshot
    ? asResult<PaperExecutionSnapshot[]>(snapshot.executions as DashboardCaptureResult<PaperExecutionSnapshot[]> | DashboardCaptureError)
    : null;
  const vercelReadOnly = snapshot?.mode === "vercel-read-only";

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1 className="title">Alpaca Paper Dashboard</h1>
          <div className="subtle">
            {snapshot?.generatedAt || new Date().toISOString()}
          </div>
        </div>
        <span className="badge">PAPER ONLY</span>
      </header>

      {guardError ? (
        <section className="grid">
          <div className="panel full">
            <h2>Environment Guard</h2>
            <p className="danger">{guardError}</p>
          </div>
        </section>
      ) : null}

      {snapshot?.historicalDataAvailable === false ? (
        <section className="grid">
          <div className="panel full">
            <h2>Runtime History</h2>
            <p className="warning">{snapshot.historicalWarning}</p>
            <p className="subtle">{snapshot.durableStorageWarning}</p>
          </div>
        </section>
      ) : null}

      <section className="grid">
        <ActionPanel readOnly={vercelReadOnly} />

        <div className="panel">
          <h2>Environment</h2>
          <Metric label="Alpaca env" value={snapshot?.environment || "-"} />
          <Metric label="Live trading enabled" value={String(Boolean(snapshot?.liveTradingEnabled))} />
          <Metric label="Paper only" value={String(Boolean(snapshot?.paperOnly))} />
        </div>

        <div className="panel">
          <h2>Paper Account</h2>
          {account?.ok ? (
            <>
              <Metric label="Status" value={account.data.status || "-"} />
              <Metric label="Equity" value={dashboardMoney(account.data.equity)} />
              <Metric label="Cash" value={dashboardMoney(account.data.cash)} />
              <Metric label="Buying power" value={dashboardMoney(account.data.buyingPower)} />
            </>
          ) : (
            <p className="warning">{account?.error || "Unavailable"}</p>
          )}
        </div>

        <div className="panel">
          <h2>Execution Readiness</h2>
          {review?.ok ? (
            <>
              <Metric label="Review status" value={review.data.review.status} />
              <Metric label="Blockers" value={review.data.review.blockers.length} />
              <Metric label="Warnings" value={review.data.review.warnings.length} />
              <Metric label="Planned orders" value={review.data.planSummary.plannedOrders} />
            </>
          ) : (
            <p className="warning">{review?.error || "Unavailable"}</p>
          )}
        </div>

        <div className="panel wide">
          <h2>Latest Plan</h2>
          {plan?.ok ? (
            <div className="list">
              {plan.data.plan.slice(0, 8).map((entry) => (
                <div className="row" key={`${entry.symbol}-${entry.latestRank}`}>
                  <strong>{entry.symbol}</strong>
                  <span>{entry.decision} {entry.strategy ? `- ${entry.strategy}` : ""}</span>
                  <span className="mono">{dashboardMoney(entry.estimatedNotional)}</span>
                </div>
              ))}
              {!plan.data.plan.length ? <p className="subtle">No current plan rows.</p> : null}
            </div>
          ) : (
            <p className="warning">{plan?.error || "Unavailable"}</p>
          )}
        </div>

        <div className="panel">
          <h2>Dry Run</h2>
          {dryRun?.ok ? (
            <>
              <Metric label="Would submit" value={dryRun.data.summary.wouldSubmitCount} />
              <Metric label="Blocked payloads" value={dryRun.data.summary.payloadsBlocked} />
              <Metric label="Asset filter" value={dryRun.data.assetClass} />
            </>
          ) : (
            <p className="warning">{dryRun?.error || "Unavailable"}</p>
          )}
        </div>

        <div className="panel">
          <h2>Positions</h2>
          {positions?.ok ? (
            <div className="list">
              {positions.data.positions.slice(0, 6).map((position) => (
                <div className="row" key={position.symbol}>
                  <strong>{position.symbol}</strong>
                  <span>qty {position.qty || "-"}</span>
                  <span className="mono">{dashboardMoney(position.marketValue)}</span>
                </div>
              ))}
              {!positions.data.positions.length ? <p className="subtle">No open paper positions.</p> : null}
            </div>
          ) : (
            <p className="warning">{positions?.error || "Unavailable"}</p>
          )}
        </div>

        <div className="panel">
          <h2>Latest Research</h2>
          <div className="list">
            {(snapshot?.latestResearch || []).map((row: any) => (
              <div className="row" key={row.id}>
                <strong>{row.risk_profile}</strong>
                <span>{row.status}</span>
                <span className="mono">{row.candidates_selected}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="panel full">
          <h2>Execution Ledger</h2>
          {executions?.ok ? (
            <div className="list">
              {executions.data.slice(0, 12).map((entry) => (
                <div className="row" key={entry.id}>
                  <strong>{entry.symbol}</strong>
                  <span>{entry.status} {entry.strategy ? `- ${entry.strategy}` : ""}</span>
                  <span className="mono">{entry.requestId || entry.clientOrderId}</span>
                </div>
              ))}
              {!executions.data.length ? <p className="subtle">No ledger rows yet.</p> : null}
            </div>
          ) : (
            <p className="warning">{executions?.error || "Unavailable"}</p>
          )}
        </div>

        <div className="panel wide">
          <h2>Option Contracts</h2>
          <pre>{JSON.stringify(snapshot?.optionContracts || [], null, 2)}</pre>
        </div>

        <div className="panel">
          <h2>Recent Request IDs</h2>
          <pre>{JSON.stringify(snapshot?.requestIds || [], null, 2)}</pre>
        </div>
      </section>
    </main>
  );
}
