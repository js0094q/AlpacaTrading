import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const controlDbDir = mkdtempSync(join(tmpdir(), "alpaca-dashboard-control-"));
process.env.RESEARCH_DB_PATH = join(controlDbDir, "research.db");
process.env.PAPER_REVIEW_SIGNING_KEY = "dashboard-control-review-key";

const getServerModule = async (): Promise<ServerModule> => {
  const url = pathToFileURL(`${process.cwd()}/server/dashboard-control/server.ts`);
  return import(`${url.href}?control-test=${Date.now()}`) as Promise<ServerModule>;
};

const safeHealthPayload = {
  paperOnly: true,
  environment: "paper",
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
  process.env.HEDGE_DASHBOARD_MUTATIONS_ENABLED = "false";
  process.env.AUTOMATED_PAPER_EXECUTION_ENABLED = "false";
  process.env.ALPACA_ENV = "paper";
  process.env.TRADING_MODE = "paper";
  process.env.LIVE_TRADING_ENABLED = "false";
  process.env.ALPACA_LIVE_TRADE = "false";
  process.env.ALPACA_PAPER_BASE_URL = "https://paper-api.alpaca.markets";
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

const seedReadyReviewArtifact = async () => {
  const { createPaperReviewArtifact } = await import(
    "../src/services/paperReviewArtifactService.js"
  );
  return createPaperReviewArtifact({
    sourceAction: "paper.ops.review",
    status: "success",
    payloadSections: {
      equityBuys: [{
        assetClass: "equity",
        symbol: "AAPL",
        side: "buy",
        type: "market",
        time_in_force: "day",
        notional: "100.00",
        client_order_id: "dashboard-control-aapl",
        sourceCandidateId: "dashboard-control-candidate"
      }],
      equityAdds: [],
      equitySells: [],
      optionBuys: [],
      optionSellToCloseExits: []
    },
    summary: {},
    createdAt: new Date().toISOString()
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

beforeEach(async () => {
  configureDefaultRuntime();
  process.env.PAPER_REVIEW_SIGNING_KEY = "dashboard-control-review-key";
  const { getDb } = await import("../src/lib/db.js");
  getDb().exec(`
    DELETE FROM paper_review_decisions;
    DELETE FROM decision_lifecycle_events;
    DELETE FROM decision_snapshots;
    DELETE FROM paper_review_artifacts;
  `);
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
  const { closeDbForTests } = await import("../src/lib/db.js");
  closeDbForTests();
  rmSync(controlDbDir, { recursive: true, force: true });
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
      "/api/v1/hedge/execute",
      "/api/v1/hedge/execution",
      "/api/v1/hedge/exit/execute",
      "/api/v1/hedge/exit/review",
      "/api/v1/hedge/learning",
      "/api/v1/hedge/risk",
      "/api/v1/hedge/regime",
      "/api/v1/hedge/recommendation",
      "/api/v1/hedge/review",
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
      "/api/v1/zero-dte/summary",
      "/api/v1/executions"
    ].sort();

    assert.deepEqual(paths, expected);
  });

  test("hedge risk GET is cached, paper-only, and does not call commands or orders", async () => {
    const route = module.ACTION_HANDLERS["/api/v1/hedge/risk"];
    const payload = await route.handler({}, "hedge-risk-read") as {
      paperOnly: boolean;
      environment: string;
      liveTradingEnabled: boolean;
    };

    assert.equal(route.method, "GET");
    assert.equal(route.requireMutationPrecheck, false);
    assert.equal(payload.paperOnly, true);
    assert.equal(payload.environment, "paper");
    assert.equal(payload.liveTradingEnabled, false);
    assert.equal(commandCalls.length, 0);
    assert.equal(openOrderCalls, 0);
  });

  test("hedge mutation routes require the explicit dashboard mutation flag", async () => {
    const response = await callControl("/api/v1/hedge/review", "POST", defaultRequest.body);

    assert.equal(response.status, 403);
    assert.equal(response.payload.ok, false);
    assert.equal(response.payload.error?.code, "HEDGE_DASHBOARD_MUTATIONS_DISABLED");
    assert.equal(commandCalls.length, 0);
  });

  test("authenticated hedge review dispatches only the fixed paper review command", async () => {
    process.env.HEDGE_DASHBOARD_MUTATIONS_ENABLED = "true";
    const response = await callControl("/api/v1/hedge/review", "POST", defaultRequest.body);

    assert.equal(response.status, 200, response.text);
    assert.equal(response.payload.action, "hedge.review");
    assert.deepEqual(commandCalls.map((entry) => entry.script), ["alpaca:health", "hedge:review"]);
    assert.equal(commandCalls.at(-1)?.args.at(-1), "--format=json");
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

  test("mutating endpoint rejects empty configured control token without throwing", async () => {
    process.env.VPS_CONTROL_TOKEN = "";
    const response = await callControl("/api/v1/research/run", "POST", defaultRequest.body, "x");

    assert.equal(response.status, 401);
    assert.equal(response.payload.ok, false);
    assert.equal(response.payload.error?.code, "CONTROL_TOKEN_INVALID");
    assert.equal(commandCalls.length, 0);
  });

  test("unknown action returns 404", async () => {
    const response = await callControl("/api/v1/does-not-exist", "GET");
    const payload = response.payload;

    assert.equal(response.status, 404);
    assert.equal(payload.ok, false);
    assert.equal(payload.error?.message, "Unknown control action.");
  });

  test("execute.confirm requires explicit confirmPaper before reviewed dispatch", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    const response = await callControl("/api/v1/execute/confirm", "POST", {
      ...defaultRequest.body,
      confirmPaper: false
    });

    assert.equal(response.status, 403);
    assert.equal(response.payload.ok, false);
    assert.equal(response.payload.error?.code, "RUNTIME_PREFLIGHT_FAILED");
    assert.deepEqual(
      (response.payload as { failedChecks?: string[] }).failedChecks,
      ["confirmPaper"]
    );
    assert.equal(commandCalls.map((entry) => entry.script).includes("paper:execute"), false);
    assert.equal(
      commandCalls.map((entry) => entry.script).includes("paper:execute:reviewed"),
      false
    );
    assert.equal(openOrderCalls, 0);
  });

  test("execute.confirm dispatches reviewed execution with the latest exact signature", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    const artifact = await seedReadyReviewArtifact();
    let reviewedActionArgs: string[] | null = null;
    setMockCommandRunner({
      onCommand: (_script, args) => {
        if (_script === "paper:execute:reviewed") {
          reviewedActionArgs = args;
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
      confirmPaper: true
    });

    assert.equal(response.status, 200, `unexpected response status ${response.status}: ${response.text}`);
    assert.equal(response.payload.ok, true);
    assert.equal(response.payload.action, "execute.confirm");

    const scripts = commandCalls.map((entry) => entry.script);
    assert.deepEqual(scripts, ["alpaca:health", "paper:execute:reviewed"]);
    assert.equal(openOrderCalls, 1);
    assert.ok(reviewedActionArgs !== null);
    assert.deepEqual(reviewedActionArgs, [
      "--confirmPaper",
      `--expectedPayloadSignature=${artifact.payloadSignature}`,
      "--format=json"
    ]);
  });

  test("execute.confirm requires paper-only runtime even when paper flags are enabled", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    setMockCommandRunner({
      onCommand: (script) => {
        if (script === "alpaca:health") {
          return {
            paperOnly: false,
            liveTradingEnabled: false,
            mutationAllowed: false,
            accountStatus: "ACTIVE"
          };
        }
        return {};
      }
    });

    const response = await callControl("/api/v1/execute/confirm", "POST", {
      ...defaultRequest.body,
      confirmPaper: true,
      riskProfile: "aggressive",
      optionsEnabled: true,
      assetClass: "all"
    });
    const payload = response.payload as ControlResponse & {
      guard?: { paperOnly?: boolean; liveTradingEnabled?: boolean };
    };

    assert.equal(response.status, 403);
    assert.equal(payload.ok, false);
    assert.equal(payload.error?.code, "RUNTIME_PREFLIGHT_FAILED");
    assert.equal(payload.guard?.paperOnly, false);
    assert.equal(payload.guard?.liveTradingEnabled, false);
    assert.equal(commandCalls.map((entry) => entry.script).includes("paper:execute"), false);
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
    assert.equal(response.payload.error?.code, "RUNTIME_PREFLIGHT_FAILED");
    assert.equal(response.payload.error?.message, "Runtime state does not permit this action.");
    assert.deepEqual((response.payload as { failedChecks?: string[] }).failedChecks, ["paperOnly", "liveTradingEnabled"]);
    assert.equal(commandCalls.length, 1);
    assert.equal(commandCalls[0].script, "alpaca:health");
  });

  test("refresh requires paper preflight but not paper execution enablement", async () => {
    const response = await callControl("/api/v1/refresh", "POST", {
      riskProfile: "aggressive",
      optionsEnabled: true,
      maxCandidates: 10,
      assetClass: "all"
    });

    assert.equal(response.status, 200);
    assert.equal(response.payload.ok, true);
    assert.deepEqual(commandCalls.map((entry) => entry.script), ["alpaca:health", "paper:runtime"]);
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
      confirmPaper: true,
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
    assert.equal(payload.error?.code, "RUNTIME_PREFLIGHT_FAILED");
    assert.equal(payload.error?.message, "Runtime state does not permit this action.");
    assert.equal(payload.correlationId, "request-correlation-1");
    assert.equal(payload.guard?.paperOnly, true);
    assert.equal(payload.guard?.liveTradingEnabled, false);
    assert.equal(payload.guard?.mutationAllowed, false);
    assert.equal(payload.guard?.paperOrderExecutionEnabled, false);
    assert.deepEqual((payload as { failedChecks?: string[] }).failedChecks, ["paperExecutionEnabled"]);
    assert.equal(commandCalls.length, 1);
    assert.equal(commandCalls[0].script, "alpaca:health");
  });

  test("reviewed execute action requires explicit confirmPaper flag before command dispatch", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    const response = await callControl("/api/v1/actions/execute", "POST", {
      ...defaultRequest.body,
      confirmPaper: false
    });

    assert.equal(response.status, 403);
    assert.equal(response.payload.ok, false);
    assert.equal(response.payload.error?.code, "RUNTIME_PREFLIGHT_FAILED");
    assert.deepEqual((response.payload as { failedChecks?: string[] }).failedChecks, ["confirmPaper"]);
    assert.equal(commandCalls.length, 1);
    assert.equal(commandCalls[0].script, "alpaca:health");
    assert.equal(openOrderCalls, 0);
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

  test("control errors redact secret-like command output in responses and audit logs", async () => {
    const auditPath = join(mkdtempSync(join(tmpdir(), "alpaca-dashboard-audit-")), "audit-redact.log");
    process.env.VPS_CONTROL_AUDIT_PATH = auditPath;
    process.env.DASHBOARD_ADMIN_TOKEN = "dashboard-admin-secret-for-redaction";
    const secretText =
      "Bearer bridge-secret-12345 sk-proj-abcdefghijklmnopqrstuvwxyz123456 APCA_API_SECRET_KEY=super-secret-value -----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----";

    setMockCommandRunner({
      onCommand: (script) => {
        if (script === "alpaca:health") {
          return safeHealthPayload;
        }
        if (script === "research:daily") {
          throw new Error(`command leaked ${secretText}`);
        }
      }
    });

    const response = await callControl("/api/v1/research/run", "POST", defaultRequest.body);

    assert.equal(response.status, 500);
    assert.equal(response.payload.ok, false);
    assert.equal(response.payload.error?.code, "CONTROL_ACTION_ERROR");
    assert.equal(response.text.includes("bridge-secret-12345"), false);
    assert.equal(response.text.includes("sk-proj-abcdefghijklmnopqrstuvwxyz123456"), false);
    assert.equal(response.text.includes("super-secret-value"), false);
    assert.equal(response.text.includes("BEGIN PRIVATE KEY"), false);

    const raw = readFileSync(auditPath, "utf8");
    assert.equal(raw.includes("bridge-secret-12345"), false);
    assert.equal(raw.includes("sk-proj-abcdefghijklmnopqrstuvwxyz123456"), false);
    assert.equal(raw.includes("super-secret-value"), false);
    assert.equal(raw.includes("BEGIN PRIVATE KEY"), false);
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
