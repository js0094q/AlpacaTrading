"use client";

import { useState } from "react";

const actions = [
  { label: "Run research", path: "/api/paper/research/run" },
  { label: "Build paper plan", path: "/api/paper/plan/run" },
  { label: "Run paper review", path: "/api/paper/review/run" },
  { label: "Run dry-run execution", path: "/api/paper/execute/dry-run" },
  {
    label: "Submit to Alpaca Paper Account",
    path: "/api/paper/execute/confirm",
    submit: true
  }
];

export function ActionPanel({ readOnly = false }: { readOnly?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState(
    readOnly ? "Historical runtime data unavailable on Vercel." : "Ready"
  );

  const runAction = async (path: string, label: string) => {
    if (readOnly) {
      return;
    }

    setBusy(path);
    setStatus(`${label} requested...`);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          riskProfile: "aggressive",
          optionsEnabled: true,
          maxCandidates: 10,
          assetClass: "all"
        })
      });
      const payload = await response.json();
      if (!response.ok || payload?.ok === false) {
        setStatus(payload?.error?.message || `${label} failed`);
        return;
      }
      setStatus(`${label} finished`);
    } catch {
      setStatus(`${label} failed`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="panel full">
      <h2>Paper Workflow Controls</h2>
      <div className="actions">
        {actions.map((action) => (
          <button
            className={`action-button${action.submit ? " submit" : ""}`}
            disabled={readOnly || busy !== null}
            key={action.path}
            onClick={() => runAction(action.path, action.label)}
            type="button"
          >
            {action.label}
          </button>
        ))}
      </div>
      <p className="status">{busy ? "Working..." : status}</p>
    </div>
  );
}
