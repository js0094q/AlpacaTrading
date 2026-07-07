import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Server } from "node:http";

type CommandCall = {
  script: string;
  args: string[];
  timeoutMs: number;
  requestId: string;
  action: string;
  env?: Record<string, string>;
};

type ActionConfig = {
  method: "GET" | "POST";
  timeoutMs: number;
  requireAdminToken: boolean;
  requireMutationPrecheck: boolean;
  action: string;
  handler: (input: unknown, requestId: string) => Promise<unknown>;
};

type ControlCommandRunner = (
  script: string,
  args: string[],
  timeoutMs: number,
  requestId: string,
  action: string,
  options?: { env?: Record<string, string> }
) => Promise<unknown>;

type ServerModule = {
  ACTION_HANDLERS: Record<string, ActionConfig>;
  createControlServer: () => Server;
  setControlCommandRunner: (runner: null | ControlCommandRunner) => void;
  setOpenOrdersFetcher: (fetcher: null | (() => Promise<unknown>)) => void;
  resetControlTestHooks: () => void;
};

type ControlResponse = {
  ok: boolean;
  action?: string;
  requestId?: string;
  correlationId?: string;
  error?: { code?: string; message?: string };
  data?: unknown;
};

const DASHBOARD_TOKEN = "vps-control-token";

const getServerModule = async (): Promise<ServerModule> => {
  const url = pathToFileURL(`${process.cwd()}/server/dashboard-control/server.ts`);
  return import(`${url.href}?control-test=${Date.now()}`) as Promise<ServerModule>;
};

const safeHealthPayload = {
  paperOnly: true,
  liveTradingEnabled: false,
  mutationAllowed: false,
  accountStatus: "ACTIVE"
};

let module: ServerModule;
let server: Server | null = null;
let port = 0;

const configureDefaultRuntime = () => {
  process.env.VPS_CONTROL_TOKEN = DASHBOARD_TOKEN;
  process.env.VPS_CONTROL_BIND_HOST = "127.0.0.1";
  process.env.VPS_CONTROL_PORT = "0";
  process.env.ENABLE_AGGRESSIVE_PAPER_STRATEGIES = "true";
  process.env.PAPER_ORDER_EXECUTION_ENABLED = "false";
  process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
  process.env.ALPACA_ENV = "paper";
  process.env.TRADING_MODE = "paper";
  process.env.LIVE_TRADING_ENABLED = "false";
};

const defaultRequest = {
  body: {
    riskProfile: "aggressive",
    optionsEnabled: true,
    maxCandidates: 25,
    assetClass: "all"
  }
};

const callControl = async (
  path: string,
  method: "GET" | "POST",
  body?: unknown,
  token: string | null = DASHBOARD_TOKEN
): Promise<{ status: number; payload: ControlResponse; text: string }> => {
  const headers: Record<string, string> = {
    "x-correlation-id": "request-correlation-1"
  };
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  const parsed: ControlResponse = text
    ? (JSON.parse(text) as ControlResponse)
    : { ok: false };
  return { status: response.status, payload: parsed, text };
};

let commandCalls: CommandCall[] = [];

const setMockCommandRunner = (options?: {
  onCommand?: (
    script: string,
    args: string[],
    timeoutMs: number,
    requestId: string,
    action: string
  ) => unknown;
}) => {
  const onCommand = options?.onCommand;
  commandCalls = [];
  module.setControlCommandRunner(async (script, args, timeoutMs, requestId, action, options) => {
    commandCalls.push({
      script,
      args: [...args],
      timeoutMs,
      requestId,
      action,
      env: options?.env ? { ...options.env } : undefined
    });
    const override = onCommand?.(script, args, timeoutMs, requestId, action);
    if (typeof override !== "undefined") {
      return override;
    }
    if (script === "alpaca:health") {
      return safeHealthPayload;
    }
    return {};
  });
};

let openOrderCalls = 0;

const setMockOpenOrdersFetcher = () => {
  openOrderCalls = 0;
  module.setOpenOrdersFetcher(async () => {
    openOrderCalls += 1;
    return [];
  });
};

before(async () => {
  process.env.DASHBOARD_CONTROL_NO_START = "1";
  module = await getServerModule();
  server = module.createControlServer();

  await new Promise<void>((resolve, reject) => {
    server?.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      if (typeof address === "string" || !address) {
        reject(new Error("Unable to start dashboard control server."));
        return;
      }
      port = address.port;
      resolve();
    });
  });
});

beforeEach(() => {
  configureDefaultRuntime();
  module.resetControlTestHooks();
  setMockOpenOrdersFetcher();
  setMockCommandRunner();
});

afterEach(() => {
  module.resetControlTestHooks();
  delete process.env.VPS_CONTROL_AUDIT_PATH;
});

after(async () => {
  await new Promise<void>((resolve) => {
    server?.close(() => resolve());
  });
  module.resetControlTestHooks();
});

describe("VPS dashboard control API", () => {
  test("exports the expected action allowlist", () => {
    const paths = Object.keys(module.ACTION_HANDLERS).sort();
    const expected = [
      "/api/v1/account",
      "/api/v1/actions/execute",
      "/api/v1/actions/history",
      "/api/v1/actions/learn/run",
      "/api/v1/actions/options/discover",
      "/api/v1/actions/portfolio/review",
      "/api/v1/actions/research/run",
      "/api/v1/actions/review",
      "/api/v1/execute/confirm",
      "/api/v1/execute/dry-run",
      "/api/v1/execute/dry-run/latest",
      "/api/v1/health",
      "/api/v1/orders",
      "/api/v1/positions",
      "/api/v1/plan/latest",
      "/api/v1/plan/run",
      "/api/v1/refresh",
      "/api/v1/research/latest",
      "/api/v1/research/run",
      "/api/v1/review/latest",
      "/api/v1/review/run",
      "/api/v1/summary",
      "/api/v1/executions"
    ].sort();

    assert.deepEqual(paths, expected);
  });

  test("mutating endpoint rejects missing admin token", async () => {
    const response = await callControl("/api/v1/research/run", "POST", defaultRequest.body, null);

    assert.equal(response.status, 401);
    assert.equal(response.payload.ok, false);
    assert.equal(response.payload.error?.code, "CONTROL_TOKEN_INVALID");
  });

  test("mutating endpoint rejects invalid admin token", async () => {
    const response = await callControl("/api/v1/research/run", "POST", defaultRequest.body, "wrong");

    assert.equal(response.status, 401);
    assert.equal(response.payload.ok, false);
    assert.equal(response.payload.error?.code, "CONTROL_TOKEN_INVALID");
  });

  test("unknown action returns 404", async () => {
    const response = await callControl("/api/v1/does-not-exist", "GET");
    const payload = response.payload;

    assert.equal(response.status, 404);
    assert.equal(payload.ok, false);
    assert.equal(payload.error?.message, "Unknown control action.");
  });

  test("execute.confirm enforces aggressive + options-enabled guardrails", async () => {
    const responseModerate = await callControl("/api/v1/execute/confirm", "POST", {
      ...defaultRequest.body,
      riskProfile: "moderate"
    });

    assert.equal(responseModerate.status, 500);
    assert.equal(responseModerate.payload.ok, false);
    assert.match(responseModerate.payload.error?.message || "", /aggressive risk profile/);

    const responseNoOptions = await callControl("/api/v1/execute/confirm", "POST", {
      ...defaultRequest.body,
      optionsEnabled: false
    });

    assert.equal(responseNoOptions.status, 500);
    assert.equal(responseNoOptions.payload.ok, false);
    assert.match(responseNoOptions.payload.error?.message || "", /optionsEnabled=true/);
  });

  test("execute.confirm uses fixed confirm-paper command and prefetches open orders", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    let confirmActionArgs: string[] | null = null;
    setMockCommandRunner({
      onCommand: (_script, args) => {
        if (_script === "paper:execute") {
          confirmActionArgs = args;
          return {
            submitted: [],
            blocked: [],
            summary: {
              eligiblePayloads: 0,
              submitted: 0,
              blocked: 0,
              errors: 0
            }
          };
        }
      }
    });

    const response = await callControl("/api/v1/execute/confirm", "POST", {
      ...defaultRequest.body,
      maxCandidates: 17,
      assetClass: "all",
      riskProfile: "aggressive"
    });

    assert.equal(response.status, 200, `unexpected response status ${response.status}: ${response.text}`);
    assert.equal(response.payload.ok, true);
    assert.equal(response.payload.action, "execute.confirm");

    const scripts = commandCalls.map((entry) => entry.script);
    assert.deepEqual(scripts, ["alpaca:health", "paper:execute"]);
    assert.equal(openOrderCalls, 1);
    assert.ok(confirmActionArgs !== null);
    assert.deepEqual(confirmActionArgs, [
      "--confirmPaper",
      "--riskProfile=aggressive",
      "--optionsEnabled=true",
      "--maxCandidates=10",
      "--assetClass=all",
      "--format=json"
    ]);
  });

  test("unsafe health state blocks mutating commands and prevents execution", async () => {
    setMockCommandRunner({
      onCommand: (script) => {
        if (script === "alpaca:health") {
          return {
            paperOnly: true,
            liveTradingEnabled: true,
            mutationAllowed: false,
            accountStatus: "ACTIVE"
          };
        }
        return {};
      }
    });

    const response = await callControl("/api/v1/research/run", "POST", {
      riskProfile: "aggressive",
      optionsEnabled: true,
      maxCandidates: 10,
      assetClass: "all"
    });

    assert.equal(response.status, 403);
    assert.equal(response.payload.ok, false);
    assert.equal(response.payload.error?.code, "LIVE_TRADING_MUST_BE_DISABLED");
    assert.match(response.payload.error?.message || "", /live trading is enabled/);
    assert.equal(commandCalls.length, 1);
    assert.equal(commandCalls[0].script, "alpaca:health");
  });

  test("refresh is read-only and does not run mutation precheck", async () => {
    const response = await callControl("/api/v1/refresh", "POST", {
      riskProfile: "aggressive",
      optionsEnabled: true,
      maxCandidates: 10,
      assetClass: "all"
    });

    assert.equal(response.status, 200);
    assert.equal(response.payload.ok, true);
    assert.equal(commandCalls.length, 1);
    assert.equal(commandCalls[0].script, "paper:runtime");
  });

  test("summary returns cached dashboard state without dispatching commands", async () => {
    const response = await callControl("/api/v1/summary", "GET");
    const data = response.payload.data as {
      paperOnly?: boolean;
      mode?: string;
      liveTradingEnabled?: boolean;
      plan?: { ok?: boolean };
      review?: { ok?: boolean };
      dryRun?: { ok?: boolean };
    };

    assert.equal(response.status, 200, `unexpected response status ${response.status}: ${response.text}`);
    assert.equal(response.payload.ok, true);
    assert.equal(response.payload.action, "summary");
    assert.equal(data.paperOnly, true);
    assert.equal(data.liveTradingEnabled, false);
    assert.equal(data.mode, "vps-cached-summary");
    assert.equal(typeof data.plan?.ok, "boolean");
    assert.equal(typeof data.review?.ok, "boolean");
    assert.equal(typeof data.dryRun?.ok, "boolean");
    assert.equal(commandCalls.length, 0);
  });

  test("execute.confirm returns structured paper order guard when disabled", async () => {
    const response = await callControl("/api/v1/execute/confirm", "POST", {
      ...defaultRequest.body,
      riskProfile: "aggressive",
      optionsEnabled: true,
      assetClass: "all"
    });
    const payload = response.payload as ControlResponse & {
      guard?: {
        paperOnly?: boolean;
        liveTradingEnabled?: boolean;
        mutationAllowed?: boolean;
        paperOrderExecutionEnabled?: boolean;
      };
    };

    assert.equal(response.status, 403);
    assert.equal(payload.ok, false);
    assert.equal(payload.error?.code, "PAPER_ORDER_EXECUTION_DISABLED");
    assert.equal(payload.error?.message, "Blocked by safety guard: paper order execution is disabled.");
    assert.equal(payload.correlationId, "request-correlation-1");
    assert.equal(payload.guard?.paperOnly, true);
    assert.equal(payload.guard?.liveTradingEnabled, false);
    assert.equal(payload.guard?.mutationAllowed, false);
    assert.equal(payload.guard?.paperOrderExecutionEnabled, false);
    assert.equal(commandCalls.length, 0);
  });

  test("reviewed execute action requires explicit confirmPaper flag before command dispatch", async () => {
    const response = await callControl("/api/v1/actions/execute", "POST", {
      ...defaultRequest.body,
      confirmPaper: false
    });

    assert.equal(response.status, 200);
    assert.equal(response.payload.ok, true);
    assert.equal((response.payload.data as { status?: string }).status, "blocked");
    assert.equal(commandCalls.length, 0);
  });

  test("mutating command endpoints map to allowlisted scripts", async () => {
    const cases: Array<{ path: string; script: string }> = [
      { path: "/api/v1/actions/research/run", script: "paper:research" },
      { path: "/api/v1/actions/learn/run", script: "paper:learn" },
      { path: "/api/v1/actions/portfolio/review", script: "paper:portfolio:review" },
      { path: "/api/v1/actions/options/discover", script: "paper:options:discover" },
      { path: "/api/v1/actions/review", script: "paper:ops:review" },
      { path: "/api/v1/research/run", script: "research:daily" },
      { path: "/api/v1/review/run", script: "paper:review" },
      { path: "/api/v1/plan/run", script: "paper:plan" },
      { path: "/api/v1/execute/dry-run", script: "paper:execute" },
      { path: "/api/v1/refresh", script: "paper:runtime" },
      { path: "/api/v1/health", script: "alpaca:health" }
    ];

    for (const entry of cases) {
      const response = await callControl(entry.path, entry.path === "/api/v1/health" ? "GET" : "POST", entry.path === "/api/v1/health" ? undefined : defaultRequest.body);

    assert.equal(response.status, 200);
    const finalCall = commandCalls[commandCalls.length - 1];
    assert.equal(finalCall.script, entry.script);
    }
  });

  test("research run uses bounded Alpaca request profile", async () => {
    const response = await callControl("/api/v1/research/run", "POST", defaultRequest.body);

    assert.equal(response.status, 200);
    const finalCall = commandCalls[commandCalls.length - 1];
    assert.equal(finalCall.script, "research:daily");
    assert.deepEqual(finalCall.env, {
      ALPACA_REQUEST_TIMEOUT_MS: "10000",
      ALPACA_MAX_RETRIES: "0"
    });
    assert.ok(finalCall.args.includes("--barLookbackDays=120"));
  });

  test("execute.dry-run latest endpoint is available as GET and uses fixed dry-run command", async () => {
    const response = await callControl("/api/v1/execute/dry-run/latest", "GET");
    assert.equal(response.status, 200);
    assert.equal(response.payload.ok, true);
    const finalCall = commandCalls[commandCalls.length - 1];
    assert.equal(finalCall.script, "paper:execute");
    assert.deepEqual(finalCall.args, [
      "--dryRun",
      "--riskProfile=aggressive",
      "--optionsEnabled=true",
      "--maxCandidates=10",
      "--assetClass=all",
      "--format=json"
    ]);
  });

  test("audit log does not include control secrets", async () => {
    const auditPath = join(mkdtempSync(join(tmpdir(), "alpaca-dashboard-audit-")), "audit.log");
    process.env.VPS_CONTROL_AUDIT_PATH = auditPath;

    const response = await callControl("/api/v1/health", "GET");

    assert.equal(response.status, 200);
    assert.equal(response.payload.ok, true);

    const raw = readFileSync(auditPath, "utf8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    assert.equal(lines.length > 0, true);
    const last = JSON.parse(lines[lines.length - 1] as string) as {
      action: string;
      method: string;
      params: unknown;
    };
    assert.equal(last.action, "health");
    assert.equal(last.method, "GET");
    assert.equal(last.params && typeof last.params === "object" ? true : false, true);
    assert.equal(raw.includes(DASHBOARD_TOKEN), false);
  });

  test("mutating audit logs include request and method context", async () => {
    const auditPath = join(mkdtempSync(join(tmpdir(), "alpaca-dashboard-audit-")), "audit-mutate.log");
    process.env.VPS_CONTROL_AUDIT_PATH = auditPath;

    const response = await callControl("/api/v1/research/run", "POST", defaultRequest.body);

    assert.equal(response.status, 200);

    const raw = readFileSync(auditPath, "utf8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    assert.equal(lines.length > 0, true);
    const last = JSON.parse(lines[lines.length - 1] as string) as {
      action: string;
      method: string;
      requestId: string;
      correlationId: string;
      status: string;
      durationMs: number;
      resultSummary: string;
      error?: string;
      params: Record<string, unknown>;
    };

    assert.equal(last.action, "research.run");
    assert.equal(last.method, "POST");
    assert.equal(typeof last.requestId, "string");
    assert.equal(typeof last.correlationId, "string");
    assert.equal(last.status, "success");
    assert.equal(typeof last.durationMs, "number");
    assert.equal(typeof last.resultSummary, "string");
    assert.equal(typeof last.params, "object");
    assert.equal(raw.includes(DASHBOARD_TOKEN), false);
  });
});
