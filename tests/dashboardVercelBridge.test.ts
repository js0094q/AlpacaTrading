import { after, afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

type RecordedCall = {
  url: string;
  init: RequestInit;
};

const originalFetch = globalThis.fetch;
const calls: RecordedCall[] = [];

const importRoute = async <T>(path: string): Promise<T> => {
  const url = pathToFileURL(`${process.cwd()}/${path}`);
  return import(`${url.href}?bridge-${Date.now()}-${Math.random()}`) as Promise<T>;
};

const headerValue = (headers: HeadersInit | undefined, name: string): string | null => {
  if (!headers) return null;
  if (headers instanceof Headers) {
    return headers.get(name) || headers.get(name.toLowerCase()) || null;
  }

  if (Array.isArray(headers)) {
    const match = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    const found = match?.[1];
    return typeof found === "string" ? found : null;
  }

  const direct = (value: string | string[] | undefined) =>
    typeof value === "string" ? value : Array.isArray(value) ? value[0] ?? null : null;

  return (
    direct((headers as Record<string, string | string[] | undefined>)[name]) ||
    direct((headers as Record<string, string | string[] | undefined>)[name.toLowerCase()]) ||
    null
  );
};

const deleteEnv = (name: string) => {
  delete process.env[name];
};

const configureBridgeRuntime = () => {
  process.env.VERCEL = "1";
  process.env.ALPACA_ENV = "paper";
  process.env.TRADING_MODE = "paper";
  process.env.ALPACA_LIVE_TRADE = "false";
  process.env.LIVE_TRADING_ENABLED = "false";
  process.env.PAPER_ORDER_EXECUTION_ENABLED = "false";
  process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "false";
  process.env.AUTOMATED_PAPER_EXECUTION_ENABLED = "false";
  process.env.HEDGE_DASHBOARD_MUTATIONS_ENABLED = "false";
  process.env.ALPACA_PAPER_BASE_URL = "https://paper-api.alpaca.markets";
  process.env.VPS_CONTROL_BASE_URL = "https://vps.internal:4100";
  process.env.DASHBOARD_CONTROL_BASE_URL = "https://legacy-vps.example.com:4100";
  process.env.VPS_CONTROL_TOKEN = "bridge-secret";
  process.env.DASHBOARD_ADMIN_TOKEN = "dashboard-admin-secret";

  [
    "ALPACA_PAPER_API_KEY",
    "ALPACA_PAPER_SECRET_KEY",
    "ALPACA_API_KEY",
    "ALPACA_PAPER_KEY",
    "ALPACA_SECRET_KEY",
    "ALPACA_PAPER_SECRET",
    "ALPACA_LIVE_KEY",
    "ALPACA_LIVE_SECRET",
    "DASHBOARD_DATABASE_URL"
  ].forEach(deleteEnv);
};

const clearBridgeMocks = () => {
  calls.length = 0;
};

const setMockFetchResponse = (body: unknown, status = 200) => {
  globalThis.fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    });
  };
};

beforeEach(() => {
  configureBridgeRuntime();
  clearBridgeMocks();
  setMockFetchResponse({ ok: true, data: { mode: "bridge", health: "ok" } });
});

afterEach(() => {
  deleteEnv("VERCEL");
  deleteEnv("DASHBOARD_CONTROL_BASE_URL");
  deleteEnv("VPS_CONTROL_BASE_URL");
  deleteEnv("VPS_CONTROL_TOKEN");
  deleteEnv("DASHBOARD_ADMIN_TOKEN");
  deleteEnv("HEDGE_DASHBOARD_MUTATIONS_ENABLED");
  globalThis.fetch = originalFetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

describe("Vercel dashboard VPS bridge mode", () => {
  test("hedge risk GET preserves the complete cached Greek payload", async () => {
    const riskPayload = {
      paperOnly: true,
      environment: "paper",
      liveTradingEnabled: false,
      effectiveStatus: "current",
      warnings: ["NESTED_RISK_WARNING"],
      blockers: ["NESTED_RISK_BLOCKER"],
      risk: {
        options: {
          deltaShares: 60,
          deltaDollars: 36000,
          gammaSharesPerDollar: 2,
          thetaDollarsPerDay: -20,
          vegaDollarsPerVolPoint: 80,
          rhoDollarsPerRatePoint: 10,
          impliedVolatility: {
            weightedByAbsoluteContracts: 0.3,
            weightedByAbsoluteMarketValue: 0.32,
            weightedByAbsoluteVega: 0.35
          },
          coverage: {
            delta: {
              absoluteContracts: { coverageRatio: 1 },
              absoluteMarketValue: { coverageRatio: 1 },
              freshness: { current: 1, stale: 0, expired: 0, malformed: 0, total: 1 }
            }
          },
          freshness: { current: 1, stale: 0, expired: 0, malformed: 0, total: 1 },
          groupings: {
            byUnderlying: { SPY: { deltaDollars: 36000, quality: "complete" } },
            byExpiration: {},
            byOptionType: {},
            byDteBucket: {}
          }
        },
        warnings: ["NESTED_RISK_WARNING"],
        blockers: ["NESTED_RISK_BLOCKER"]
      }
    };
    setMockFetchResponse({ ok: true, data: riskPayload });

    const { GET } = await importRoute<{
      GET: (request: Request) => Promise<Response> | Response;
    }>("apps/dashboard/app/api/paper/hedge/risk/route.ts");
    const response = await GET(new Request("http://localhost/api/paper/hedge/risk"));
    const payload = await response.json() as { ok: true; data: typeof riskPayload };

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://vps.internal:4100/api/v1/hedge/risk");
    assert.equal(calls[0].init.method, "GET");
    assert.deepEqual(payload.data, riskPayload);
  });

  test("summary route forwards using control token", async () => {
    setMockFetchResponse({ ok: true, data: { hello: "bridge summary" }, mode: "vercel-read-only" });

    const { GET } = await importRoute<{ GET: () => Promise<Response> | Response }>(
      "apps/dashboard/app/api/paper/summary/route.ts"
    );
    const response = await GET();
    const payload = (await response.json()) as { ok: true; data: { mode: string; hello: string } };

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://vps.internal:4100/api/v1/summary");

    const forwardAuth = headerValue(calls[0].init.headers, "authorization") || "";
    assert.equal(
      forwardAuth,
      "Bearer bridge-secret",
      "VPS bridge must forward server-side token."
    );

    assert.equal(payload.ok, true);
    assert.equal(payload.data.hello, "bridge summary");
  });

  test("read-only summary remains available when paper execution flags are enabled", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    setMockFetchResponse({ ok: true, data: { hello: "bridge summary" }, mode: "vercel-read-only" });

    const { GET } = await importRoute<{ GET: () => Promise<Response> | Response }>(
      "apps/dashboard/app/api/paper/summary/route.ts"
    );
    const response = await GET();
    const payload = (await response.json()) as { ok: true; data: { hello: string } };

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.hello, "bridge summary");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://vps.internal:4100/api/v1/summary");
  });

  test("mutating actions reject missing dashboard admin token", async () => {
    const { POST } = await importRoute<{
      POST: (request: Request) => Promise<Response> | Response;
    }>("apps/dashboard/app/api/paper/execute/confirm/route.ts");

    const response = await POST(new Request("http://localhost/api/paper/execute/confirm", {
      method: "POST",
      body: "{}"
    }));
    const payload = (await response.json()) as { ok: false; error: { code: string } };

    assert.equal(response.status, 403);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "DASHBOARD_ADMIN_TOKEN_INVALID");
    assert.equal(calls.length, 0);
  });

  test("mutating bridge call uses dashboard correlation token and does not reuse client token", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    const requestId = "client-correlation-id-007";
    const summaryPayload = {
      ok: true,
      action: "execute.confirm",
      requestId: "vps-request-id-001",
      correlationId: "vps-correlation-id",
      data: { result: "queued" }
    };
    setMockFetchResponse(summaryPayload);

    const { POST } = await importRoute<{
      POST: (request: Request) => Promise<Response> | Response;
    }>("apps/dashboard/app/api/paper/execute/confirm/route.ts");

    const response = await POST(new Request("http://localhost/api/paper/execute/confirm", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer dashboard-admin-secret",
        "x-correlation-id": requestId
      },
      body: JSON.stringify({
        riskProfile: "aggressive",
        optionsEnabled: true,
        maxCandidates: 10,
        assetClass: "all"
      })
    }));
    const payload = (await response.json()) as {
      ok: true;
      requestId: string;
      correlationId: string;
      data: Record<string, unknown>;
    };

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.requestId, "vps-request-id-001");
    assert.equal(payload.correlationId, "vps-correlation-id");
    assert.equal(calls.length, 1);

    const forwardedAuth = headerValue(calls[0].init.headers, "authorization") || "";
    const forwardedCorrelation = headerValue(calls[0].init.headers, "x-correlation-id");
    assert.equal(forwardedAuth, "Bearer bridge-secret");
    assert.equal(forwardedCorrelation, requestId);
    assert.equal(headerValue(calls[0].init.headers, "x-request-id"), null);
    assert.equal(calls[0].init.method, "POST");
  });

  test("paper execution route fails closed before bridge when dashboard execution flag is disabled", async () => {
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    const { POST } = await importRoute<{
      POST: (request: Request) => Promise<Response> | Response;
    }>("apps/dashboard/app/api/paper/execute/confirm/route.ts");

    const response = await POST(new Request("http://localhost/api/paper/execute/confirm", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer dashboard-admin-secret"
      },
      body: JSON.stringify({
        riskProfile: "aggressive",
        optionsEnabled: true,
        maxCandidates: 10,
        assetClass: "all"
      })
    }));
    const payload = (await response.json()) as {
      ok: false;
      error: { code: string; message: string };
      checks: { paperExecutionEnabled: boolean; liveTradingEnabled: boolean };
      failedChecks: string[];
    };

    assert.equal(response.status, 403);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "RUNTIME_PREFLIGHT_FAILED");
    assert.equal(payload.error.message, "Runtime state does not permit this action.");
    assert.equal(payload.checks.paperExecutionEnabled, false);
    assert.equal(payload.checks.liveTradingEnabled, false);
    assert.deepEqual(payload.failedChecks, ["paperExecutionEnabled"]);
    assert.equal(calls.length, 0);
  });

  test("new paper actions route proxies to fixed VPS action path", async () => {
    setMockFetchResponse({
      ok: true,
      status: "success",
      action: "paper.actions.options.discover",
      requestId: "vps-options-action",
      correlationId: "client-options-action",
      summary: { selected: 1 },
      data: { status: "success", summary: { selected: 1 } }
    });

    const { POST } = await importRoute<{
      POST: (request: Request) => Promise<Response> | Response;
    }>("apps/dashboard/app/api/paper/actions/options/discover/route.ts");

    const response = await POST(new Request("http://localhost/api/paper/actions/options/discover", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer dashboard-admin-secret",
        "x-correlation-id": "client-options-action"
      },
      body: JSON.stringify({
        underlying: "SPY",
        dte: 0
      })
    }));
    const payload = (await response.json()) as { ok: true; requestId: string };

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.requestId, "vps-options-action");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://vps.internal:4100/api/v1/actions/options/discover");
    assert.equal(headerValue(calls[0].init.headers, "authorization"), "Bearer bridge-secret");
    assert.equal(headerValue(calls[0].init.headers, "x-correlation-id"), "client-options-action");
  });

  test("authenticated hedge review route proxies to the fixed VPS hedge path", async () => {
    process.env.HEDGE_DASHBOARD_MUTATIONS_ENABLED = "true";
    setMockFetchResponse({ ok: true, action: "hedge.review", data: { status: "current" } });

    const { POST } = await importRoute<{
      POST: (request: Request) => Promise<Response> | Response;
    }>("apps/dashboard/app/api/paper/hedge/review/route.ts");
    const response = await POST(new Request("http://localhost/api/paper/hedge/review", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer dashboard-admin-secret",
        "x-correlation-id": "hedge-review-correlation"
      },
      body: JSON.stringify({})
    }));

    assert.equal(response.status, 200);
    assert.equal(calls[0].url, "https://vps.internal:4100/api/v1/hedge/review");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(headerValue(calls[0].init.headers, "x-correlation-id"), "hedge-review-correlation");
  });

  test("hedge execution route requires paper confirmation and both paper option flags", async () => {
    process.env.HEDGE_DASHBOARD_MUTATIONS_ENABLED = "true";
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    setMockFetchResponse({ ok: true, action: "hedge.execute", data: { status: "blocked" } });

    const { POST } = await importRoute<{
      POST: (request: Request) => Promise<Response> | Response;
    }>("apps/dashboard/app/api/paper/hedge/execute/route.ts");
    const response = await POST(new Request("http://localhost/api/paper/hedge/execute", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer dashboard-admin-secret"
      },
      body: JSON.stringify({ reviewId: "hedge-review-1", confirmPaper: true })
    }));

    assert.equal(response.status, 200);
    assert.equal(calls[0].url, "https://vps.internal:4100/api/v1/hedge/execute");
    assert.equal(calls[0].init.method, "POST");
    const body = JSON.parse(String(calls[0].init.body)) as { reviewId: string; confirmPaper: boolean };
    assert.equal(body.reviewId, "hedge-review-1");
    assert.equal(body.confirmPaper, true);
  });

  test("bridge preserves structured VPS safety guard responses", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    setMockFetchResponse({
      ok: false,
      action: "execute.confirm",
      requestId: "vps-request-id-guard",
      correlationId: "client-correlation-id-guard",
      error: {
        code: "PAPER_ORDER_EXECUTION_DISABLED",
        message: "Blocked by safety guard: paper order execution is disabled."
      },
      guard: {
        paperOnly: true,
        liveTradingEnabled: false,
        mutationAllowed: false,
        paperOrderExecutionEnabled: false,
        paperOptionsExecutionEnabled: true
      }
    }, 403);

    const { POST } = await importRoute<{
      POST: (request: Request) => Promise<Response> | Response;
    }>("apps/dashboard/app/api/paper/execute/confirm/route.ts");

    const response = await POST(new Request("http://localhost/api/paper/execute/confirm", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer dashboard-admin-secret",
        "x-correlation-id": "client-correlation-id-guard"
      },
      body: JSON.stringify({
        riskProfile: "aggressive",
        optionsEnabled: true,
        maxCandidates: 10,
        assetClass: "all"
      })
    }));
    const payload = (await response.json()) as {
      ok: false;
      requestId: string;
      correlationId: string;
      error: { code: string; message: string };
      guard: { paperOrderExecutionEnabled: boolean; mutationAllowed: boolean };
    };

    assert.equal(response.status, 403);
    assert.equal(payload.ok, false);
    assert.equal(payload.requestId, "vps-request-id-guard");
    assert.equal(payload.correlationId, "client-correlation-id-guard");
    assert.equal(payload.error.code, "PAPER_ORDER_EXECUTION_DISABLED");
    assert.equal(payload.error.message, "Blocked by safety guard: paper order execution is disabled.");
    assert.equal(payload.guard.paperOrderExecutionEnabled, false);
    assert.equal(payload.guard.mutationAllowed, false);
  });

  test("action panel formats safety guard reason and flags", async () => {
    const { describeActionFailure } = await importRoute<{
      describeActionFailure: (
        payload: {
          ok: false;
          error: { code: string; message: string };
          guard: {
            paperOnly: boolean;
            liveTradingEnabled: boolean;
            mutationAllowed: boolean;
            paperOrderExecutionEnabled: boolean;
            paperOptionsExecutionEnabled: boolean;
          };
        },
        responseStatus: number,
        actionLabel: string
      ) => { message: string; summary: string; details: string[] };
    }>("apps/dashboard/app/components/ActionPanel.tsx");

    const failure = describeActionFailure({
      ok: false,
      error: {
        code: "PAPER_ORDER_EXECUTION_DISABLED",
        message: "Blocked by safety guard: paper order execution is disabled."
      },
      guard: {
        paperOnly: true,
        liveTradingEnabled: false,
        mutationAllowed: false,
        paperOrderExecutionEnabled: false,
        paperOptionsExecutionEnabled: true
      }
    }, 403, "Submit to Alpaca Paper Account");

    assert.equal(failure.message, "Blocked by safety guard: paper order execution is disabled.");
    assert.equal(failure.summary, "403: Blocked by safety guard: paper order execution is disabled.");
    assert.deepEqual(failure.details, [
      "paperOnly=true",
      "liveTradingEnabled=false",
      "mutationAllowed=false",
      "PAPER_ORDER_EXECUTION_ENABLED=false",
      "PAPER_OPTIONS_EXECUTION_ENABLED=true"
    ]);
  });
});
