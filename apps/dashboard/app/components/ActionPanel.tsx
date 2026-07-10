"use client";

import { useEffect, useState } from "react";

type ActionStatus = "idle" | "running" | "success" | "warning" | "failed" | "blocked";

type ActionConfig = {
  label: string;
  description: string;
  path: string;
  submit?: boolean;
  requiresReviewedPayloads?: boolean;
  confirmMessage?: string;
  warning?: string;
  payload?: Record<string, unknown>;
};

const actions: ActionConfig[] = [
  {
    label: "Run Automated Paper Research",
    description: "Refreshes paper candidates through the guarded VPS research workflow.",
    path: "/api/paper/actions/research/run"
  },
  {
    label: "Commit Learning",
    description: "Evaluates paper learning ledger rows and promotion-readiness signals.",
    path: "/api/paper/actions/learn/run"
  },
  {
    label: "Run Portfolio Review",
    description: "Reviews held equities and options for add, sell, exit, or hold recommendations.",
    path: "/api/paper/actions/portfolio/review"
  },
  {
    label: "Run 0DTE Options Discovery",
    description: "Discovers SPY 0DTE contracts or next-session preparation candidates.",
    path: "/api/paper/actions/options/discover",
    payload: {
      underlying: "SPY",
      dte: 0
    }
  },
  {
    label: "Review Paper Order Payloads",
    description: "Builds separated equity buy/add/sell and option buy/exit review payloads.",
    path: "/api/paper/actions/review"
  },
  {
    label: "Execute Reviewed Paper Payloads",
    description: "Paper account only. Requires confirmPaper. No live route exists.",
    path: "/api/paper/actions/execute",
    submit: true,
    requiresReviewedPayloads: true,
    warning: "Paper-mutating action",
    confirmMessage:
      "Execute latest reviewed payloads in the Alpaca PAPER account only? This requires confirmPaper and will not run live orders.",
    payload: {
      confirmPaper: true
    }
  }
];

type DashboardControlPayload = {
  ok: boolean;
  status?: ActionStatus | string;
  action?: string;
  requestId?: string;
  correlationId?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  summary?: unknown;
  details?: unknown;
  data?: unknown;
  blockers?: unknown;
  warnings?: unknown;
  error?: {
    code?: string;
    message?: string;
  } | string;
  guard?: {
    paperOnly?: boolean;
    liveTradingEnabled?: boolean;
    mutationAllowed?: boolean;
    paperOrderExecutionEnabled?: boolean;
    paperOptionsExecutionEnabled?: boolean;
  };
};

type ActionResultData = {
  summary?: Record<string, unknown>;
  submitted?: Array<{
    requestId?: string;
    clientOrderId?: string;
    symbol?: string;
  }>;
  blocked?: Array<{
    requestId?: string;
    clientOrderId?: string;
    symbol?: string;
    reason?: string;
  }>;
};

type ActionState = {
  label: string;
  status: ActionStatus;
  lastRunAt: string | null;
  requestId: string | null;
  correlationId: string | null;
  summary: string;
  details: string[];
  raw: unknown;
};

const getRecord = (value: unknown) =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

const extractReviewReadiness = (payload: unknown) => {
  const record = getRecord(payload);
  const data = getRecord(record?.data);
  return getRecord(data?.reviewReadiness || record?.reviewReadiness);
};

const extractOperations = (payload: unknown) => {
  const record = getRecord(payload);
  const data = getRecord(record?.data);
  const operations =
    data?.operations ||
    record?.operations ||
    (Array.isArray(record?.data) ? record?.data : []);
  return Array.isArray(operations) ? operations : [];
};

const payloadCountFrom = (payload: unknown) => {
  const record = getRecord(payload);
  const data = getRecord(record?.data);
  const summary = getRecord(data?.summary || record?.summary);
  const count = Number(summary?.payloadCount);
  return Number.isFinite(count) ? count : 0;
};

const statusFromPayload = (payload: DashboardControlPayload, responseOk: boolean): ActionStatus => {
  const status = String(payload.status || "").toLowerCase();
  if (status === "warning" || status === "blocked" || status === "failed" || status === "success") {
    return status as ActionStatus;
  }
  if (!responseOk || payload.ok === false) {
    return "failed";
  }
  return "success";
};

const flagLine = (label: string, value: boolean | undefined) =>
  typeof value === "boolean" ? `${label}=${String(value)}` : null;

const collectGuardLines = (payload: DashboardControlPayload): string[] => {
  if (!payload.guard) {
    return [];
  }

  return [
    flagLine("paperOnly", payload.guard.paperOnly),
    flagLine("liveTradingEnabled", payload.guard.liveTradingEnabled),
    flagLine("mutationAllowed", payload.guard.mutationAllowed),
    flagLine("PAPER_ORDER_EXECUTION_ENABLED", payload.guard.paperOrderExecutionEnabled),
    flagLine("PAPER_OPTIONS_EXECUTION_ENABLED", payload.guard.paperOptionsExecutionEnabled)
  ].filter((line): line is string => Boolean(line));
};

export const describeActionFailure = (
  parsed: DashboardControlPayload,
  responseStatus: number,
  actionLabel: string
) => {
  const message =
    parsed?.error && typeof parsed.error === "object"
      ? parsed.error.message || parsed.error.code || "Action failed."
      : parsed?.error
        ? String(parsed.error)
        : `${actionLabel} failed`;

  return {
    message,
    summary: `${responseStatus}: ${message}`,
    details: collectGuardLines(parsed)
  };
};

const collectResultLines = (data: unknown, actionLabel: string): string[] => {
  if (!data || typeof data !== "object") {
    return [];
  }

  const record = data as ActionResultData;
  const lines: string[] = [];

  if (record.summary) {
    const compact = Object.entries(record.summary)
      .slice(0, 6)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(", ");
    if (compact) {
      lines.push(`${actionLabel} summary: ${compact}`);
    }
  }

  const submitRows = record.submitted ?? [];
  for (const row of submitRows.slice(0, 3)) {
    const parts = [row.symbol, row.requestId, row.clientOrderId].filter(Boolean);
    if (parts.length) {
      lines.push(`submitted: ${parts.join(" | ")}`);
    }
  }

  const blockedRows = record.blocked ?? [];
  for (const row of blockedRows.slice(0, 3)) {
    const parts = [row.symbol, row.reason, row.requestId, row.clientOrderId].filter(Boolean);
    if (parts.length) {
      lines.push(`blocked: ${parts.join(" | ")}`);
    }
  }

  return lines;
};

const summarizePayload = (payload: DashboardControlPayload, fallback: string) => {
  if (payload.summary && typeof payload.summary === "object") {
    const entries = Object.entries(payload.summary as Record<string, unknown>)
      .slice(0, 5)
      .map(([key, value]) => `${key}=${String(value)}`);
    if (entries.length) {
      return entries.join(", ");
    }
  }
  if (payload.error && typeof payload.error === "object") {
    return payload.error.message || payload.error.code || fallback;
  }
  return fallback;
};

const initialStates = () =>
  Object.fromEntries(
    actions.map((action) => [
      action.path,
      {
        label: action.label,
        status: "idle" as ActionStatus,
        lastRunAt: null,
        requestId: null,
        correlationId: null,
        summary: "Not run yet.",
        details: [],
        raw: null
      }
    ])
  ) as Record<string, ActionState>;

export function ActionPanel({ readOnly = false }: { readOnly?: boolean }) {
  const [adminToken, setAdminToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [states, setStates] = useState(initialStates);
  const [history, setHistory] = useState<unknown[]>([]);
  const [executeReady, setExecuteReady] = useState(false);
  const [status, setStatus] = useState(
    readOnly ? "Historical runtime data unavailable on Vercel." : "Enter admin token to run control actions."
  );

  useEffect(() => {
    let active = true;
    fetch("/api/paper/actions/history", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (!active) return;
        const readiness = extractReviewReadiness(payload);
        setExecuteReady(readiness?.ready === true);
        setHistory(extractOperations(payload).slice(0, 8));
      })
      .catch(() => {
        if (active) setHistory([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const updateState = (path: string, patch: Partial<ActionState>) => {
    setStates((current) => ({
      ...current,
      [path]: {
        ...current[path],
        ...patch
      }
    }));
  };

  const runAction = async (action: ActionConfig) => {
    if (readOnly) {
      return;
    }
    if (!adminToken.trim()) {
      setStatus("Admin token required for dashboard actions.");
      return;
    }

    if (action.submit && action.confirmMessage && !window.confirm(action.confirmMessage)) {
      setStatus("Action cancelled.");
      return;
    }

    setBusy(action.path);
    setStatus(`${action.label} requested...`);
    updateState(action.path, {
      status: "running",
      summary: "Running...",
      details: [],
      raw: null
    });

    const correlationId = crypto.randomUUID();
    const payload = {
      riskProfile: "aggressive",
      optionsEnabled: true,
      maxCandidates: 10,
      assetClass: "all",
      ...(action.payload || {})
    };

    try {
      const response = await fetch(action.path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken.trim()}`,
          "X-Correlation-Id": correlationId
        },
        body: JSON.stringify(payload)
      });
      const responseBody = await response.text();
      let parsed: DashboardControlPayload = { ok: false };
      try {
        const json = responseBody ? JSON.parse(responseBody) : {};
        if (json && typeof json === "object") {
          parsed = json as DashboardControlPayload;
        }
      } catch {
        parsed = {
          ok: false,
          error: {
            message: responseBody || "Non-JSON VPS response."
          }
        };
      }

      if (!response.ok || parsed?.ok === false) {
        const failure = describeActionFailure(parsed, response.status, action.label);
        const nextStatus = statusFromPayload(parsed, false);
        setStatus(failure.message);
        updateState(action.path, {
          status: nextStatus === "warning" ? "warning" : nextStatus === "blocked" ? "blocked" : "failed",
          lastRunAt: new Date().toISOString(),
          correlationId: parsed.correlationId || correlationId,
          requestId: parsed.requestId || null,
          summary: failure.summary,
          details: failure.details,
          raw: parsed
        });
        return;
      }

      const nextStatus = statusFromPayload(parsed, response.ok);
      const details = collectResultLines(parsed.data, action.label);
      const summary = summarizePayload(parsed, `requestId=${parsed.requestId || "unknown"}`);
      if (action.path === "/api/paper/actions/review") {
        setExecuteReady(payloadCountFrom(parsed) > 0);
      }
      if (action.path === "/api/paper/actions/execute" && nextStatus !== "success") {
        setExecuteReady(false);
      }
      setStatus(`${action.label} finished`);
      updateState(action.path, {
        status: nextStatus,
        lastRunAt: parsed.finishedAt || new Date().toISOString(),
        correlationId: parsed.correlationId || correlationId,
        requestId: parsed.requestId || null,
        summary,
        details,
        raw: parsed
      });
    } catch {
      setStatus(`${action.label} failed`);
      updateState(action.path, {
        status: "failed",
        lastRunAt: new Date().toISOString(),
        correlationId,
        requestId: null,
        summary: "Network error while calling dashboard action endpoint.",
        details: [],
        raw: null
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="panel full">
      <h2>Paper Trading Controls</h2>
      <p className="warning">Paper only. Live trading disabled required. Guarded VPS actions only.</p>
      <label className="subtle">
        Dashboard admin token
        <input
          type="password"
          value={adminToken}
          onChange={(event) => setAdminToken(event.target.value)}
          placeholder="DASHBOARD_ADMIN_TOKEN"
          autoComplete="off"
        />
      </label>
      <div className="action-grid">
        {actions.map((action) => {
          const state = states[action.path];
          const actionDisabled =
            readOnly ||
            busy !== null ||
            (action.requiresReviewedPayloads === true && !executeReady);
          return (
            <div className="action-card" key={action.path}>
              <div className="action-card-head">
                <h3>{action.label}</h3>
                <span className={`state-pill ${state.status}`}>{state.status}</span>
              </div>
              <p className="subtle">{action.description}</p>
              {action.warning ? <p className="warning">{action.warning}</p> : null}
              <div className="action-meta">
                <span>Last run</span>
                <strong>{state.lastRunAt || "-"}</strong>
                <span>Request ID</span>
                <strong>{state.requestId || "-"}</strong>
                <span>Correlation ID</span>
                <strong>{state.correlationId || "-"}</strong>
              </div>
              <button
                className={`action-button${action.submit ? " submit" : ""}`}
                disabled={actionDisabled}
                onClick={() => runAction(action)}
                type="button"
                title={
                  action.requiresReviewedPayloads && !executeReady
                    ? "Run Review Paper Order Payloads first; no fresh eligible reviewed payload is available."
                    : undefined
                }
              >
                {busy === action.path ? "Running..." : action.label}
              </button>
              <p className="status">{state.summary}</p>
              {state.details.length ? (
                <ul className="subtle">
                  {state.details.map((entry) => (
                    <li key={`${action.path}-${entry}`}>{entry}</li>
                  ))}
                </ul>
              ) : null}
              <details>
                <summary>Raw JSON details</summary>
                <pre>{JSON.stringify(state.raw, null, 2)}</pre>
              </details>
            </div>
          );
        })}
      </div>
      <p className="status">{busy ? "Working..." : status}</p>
      <details>
        <summary>Recent operation history</summary>
        <pre>{JSON.stringify(history, null, 2)}</pre>
      </details>
    </div>
  );
}
