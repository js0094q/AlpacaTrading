"use client";

import { useState } from "react";

type ActionConfig = {
  label: string;
  path: string;
  submit?: boolean;
  confirmMessage?: string;
};

const actions: ActionConfig[] = [
  { label: "Refresh dashboard state", path: "/api/paper/refresh" },
  { label: "Run aggressive research", path: "/api/paper/research/run" },
  { label: "Build paper plan", path: "/api/paper/plan/run" },
  { label: "Run paper review", path: "/api/paper/review/run" },
  { label: "Run dry-run execution", path: "/api/paper/execute/dry-run" },
  {
    label: "Submit to Alpaca Paper Account",
    path: "/api/paper/execute/confirm",
    submit: true,
    confirmMessage:
      "This submits eligible orders to Alpaca PAPER only. Continue?"
  }
];

type DashboardControlPayload = {
  ok: boolean;
  action?: string;
  requestId?: string;
  correlationId?: string;
  data?: unknown;
  error?: {
    code?: string;
    message?: string;
  };
};

type ActionRecord = ActionConfig;

type ActionResultData = {
  summary?: {
    submitted?: number;
    blocked?: number;
    errors?: number;
    wouldSubmitCount?: number;
    payloadsBlocked?: number;
    rejected?: number;
  };
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

const collectResultLines = (data: unknown, actionLabel: string): string[] => {
  if (!data || typeof data !== "object") {
    return [];
  }

  const record = data as ActionResultData;
  const lines: string[] = [];

  if (record.summary) {
    if (typeof record.summary.submitted === "number" || typeof record.summary.blocked === "number") {
      lines.push(
        `${actionLabel} result: submitted=${String(record.summary.submitted ?? 0)}, rejected=${String(
          record.summary.blocked ?? 0
        )}, errors=${String(record.summary.errors ?? 0)}`
      );
    }

    if (
      typeof record.summary.wouldSubmitCount === "number" ||
      typeof record.summary.payloadsBlocked === "number"
    ) {
      lines.push(
        `${actionLabel} result: wouldSubmit=${String(
          record.summary.wouldSubmitCount ?? 0
        )}, blockedPayloads=${String(record.summary.payloadsBlocked ?? 0)}`
      );
    }
  }

  const submitRows = record.submitted ?? [];
  for (const row of submitRows.slice(0, 3)) {
    const parts = [row.symbol, row.requestId, row.clientOrderId].filter(Boolean);
    if (parts.length) {
      lines.push(`submit: ${parts.join(" | ")}`);
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

export function ActionPanel({ readOnly = false }: { readOnly?: boolean }) {
  const [adminToken, setAdminToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<{
    label: string;
    correlationId: string | null;
    requestId: string | null;
    status: string;
    summary: string;
    details: string[];
  } | null>(null);
  const [status, setStatus] = useState(
    readOnly ? "Historical runtime data unavailable on Vercel." : "Enter admin token to run control actions."
  );

  const runAction = async (action: ActionRecord) => {
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

    const correlationId = crypto.randomUUID();
    const payload = {
      riskProfile: "aggressive",
      optionsEnabled: true,
      maxCandidates: 10,
      assetClass: "all"
    };

    let result = "Action failed.";
    let requestId: string | null = null;
    let correlation: string | null = correlationId;

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
        const message =
          parsed?.error && typeof parsed.error === "object"
            ? parsed.error.message || parsed.error.code || "Action failed."
            : parsed?.error
              ? String(parsed.error)
              : `${action.label} failed`;
        result = message;
        setStatus(message);
        setLastAction({
          label: action.label,
          correlationId: parsed.correlationId || correlationId,
          requestId: parsed.requestId || null,
          status: "failed",
          summary: `${response.status}: ${message}`,
          details: []
        });
        return;
      }
      requestId = parsed.requestId || null;
      correlation = parsed.correlationId || correlationId;
      result = `requestId=${requestId || "unknown"}, requestCorrelation=${correlation}`;
      const details = collectResultLines(parsed.data, action.label);
      setStatus(`${action.label} finished`);
      setLastAction({
        label: action.label,
        correlationId: correlation,
        requestId,
        status: "success",
        summary: result,
        details
      });
    } catch {
      setStatus(`${action.label} failed`);
      setLastAction({
        label: action.label,
        correlationId: correlationId,
        requestId: null,
        status: "failed",
        summary: "Network error while calling dashboard action endpoint.",
        details: []
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="panel full">
      <h2>Paper Workflow Controls</h2>
      <p className="warning">Paper only · Live trading disabled required · PAPER_ONLY execution gates enforced</p>
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
      <div className="actions">
        {actions.map((action) => (
          <button
            className={`action-button${action.submit ? " submit" : ""}`}
            disabled={readOnly || busy !== null}
            key={action.path}
            onClick={() => runAction(action as ActionRecord)}
            type="button"
          >
            {action.label}
          </button>
        ))}
      </div>
      <p className="status">{busy ? "Working..." : status}</p>
      {lastAction ? (
        <div className="status">
          <strong>{lastAction.label}</strong> - {lastAction.status} ({lastAction.summary})
          <div className="subtle">
            {lastAction.requestId ? `requestId ${lastAction.requestId}` : null}
            {lastAction.requestId && lastAction.correlationId ? " · " : ""}
            {lastAction.correlationId ? `correlationId ${lastAction.correlationId}` : null}
          </div>
          {lastAction.details.length ? (
            <ul className="subtle">
              {lastAction.details.map((entry) => (
                <li key={`${lastAction.label}-${entry}`}>{entry}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
