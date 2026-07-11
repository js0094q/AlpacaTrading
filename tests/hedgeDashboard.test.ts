import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  HedgePanel,
  type HedgeDashboardRecommendation
} from "../apps/dashboard/app/components/HedgePanel.js";

const dbDir = mkdtempSync(join(tmpdir(), "alpaca-hedge-dashboard-test-"));
process.env.RESEARCH_DB_PATH = join(dbDir, "research.db");
process.env.DASHBOARD_CONTROL_NO_START = "1";
process.env.ALPACA_ENV = "paper";
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.HEDGE_PAPER_EXECUTION_ENABLED = "false";

const routePaths = [
  "apps/dashboard/app/api/paper/hedge/risk/route.ts",
  "apps/dashboard/app/api/paper/hedge/regime/route.ts",
  "apps/dashboard/app/api/paper/hedge/recommendation/route.ts"
];

let serverModule: {
  ACTION_HANDLERS: Record<string, {
    method: string;
    requireAdminToken: boolean;
    requireMutationPrecheck: boolean;
    handler: (input: unknown, requestId: string) => Promise<unknown>;
  }>;
  setControlCommandRunner: (runner: (...args: unknown[]) => Promise<unknown>) => void;
  setOpenOrdersFetcher: (fetcher: () => Promise<unknown>) => void;
  resetControlTestHooks: () => void;
};

before(async () => {
  const url = pathToFileURL(join(process.cwd(), "server/dashboard-control/server.ts"));
  serverModule = await import(`${url.href}?hedge-dashboard=${Date.now()}`) as typeof serverModule;
});

after(async () => {
  serverModule.resetControlTestHooks();
  const { closeDbForTests } = await import("../src/lib/db.js");
  closeDbForTests();
  rmSync(dbDir, { recursive: true, force: true });
});

test("dashboard hedge route files expose GET only", () => {
  for (const path of routePaths) {
    const source = readFileSync(join(process.cwd(), path), "utf8");
    assert.match(source, /export const GET/);
    assert.doesNotMatch(source, /export const POST|guardedPost|hedge:execute/);
    assert.match(source, /runtime = "nodejs"/);
  }
});

test("control hedge routes are cached GET reads with no command or order calls", async () => {
  let commandCalls = 0;
  let orderCalls = 0;
  serverModule.setControlCommandRunner(async () => {
    commandCalls += 1;
    return {};
  });
  serverModule.setOpenOrdersFetcher(async () => {
    orderCalls += 1;
    return [];
  });

  for (const path of [
    "/api/v1/hedge/risk",
    "/api/v1/hedge/regime",
    "/api/v1/hedge/recommendation"
  ]) {
    const route = serverModule.ACTION_HANDLERS[path];
    assert.equal(route?.method, "GET");
    assert.equal(route?.requireAdminToken, false);
    assert.equal(route?.requireMutationPrecheck, false);
    await route.handler({}, "hedge-dashboard-request");
  }

  assert.equal(commandCalls, 0);
  assert.equal(orderCalls, 0);
});

test("expired recommendation remains expired through the Vercel bridge", async () => {
  const originalFetch = globalThis.fetch;
  process.env.VERCEL = "1";
  process.env.VPS_CONTROL_BASE_URL = "https://vps.internal:4100";
  process.env.VPS_CONTROL_TOKEN = "bridge-secret";
  let calledUrl = "";
  globalThis.fetch = async (input) => {
    calledUrl = String(input);
    return new Response(
      JSON.stringify({
        ok: true,
        data: {
          recommendationId: "expired-recommendation",
          effectiveStatus: "expired",
          generatedAt: "2026-07-10T13:00:00.000Z",
          expiresAt: "2026-07-10T13:30:00.000Z"
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const url = pathToFileURL(
      join(process.cwd(), "apps/dashboard/app/api/paper/hedge/recommendation/route.ts")
    );
    const { GET } = await import(`${url.href}?expired=${Date.now()}`) as {
      GET: (request?: Request) => Promise<Response> | Response;
    };
    const response = await GET(
      new Request("http://localhost/api/paper/hedge/recommendation")
    );
    const payload = await response.json() as {
      ok: true;
      data: { effectiveStatus: string };
    };

    assert.equal(response.status, 200);
    assert.equal(calledUrl, "https://vps.internal:4100/api/v1/hedge/recommendation");
    assert.equal(payload.data.effectiveStatus, "expired");
    assert.notEqual(payload.data.effectiveStatus, "current");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.VERCEL;
    delete process.env.VPS_CONTROL_BASE_URL;
    delete process.env.VPS_CONTROL_TOKEN;
  }
});

const dashboardRecommendation = (
  effectiveStatus: HedgeDashboardRecommendation["effectiveStatus"]
): HedgeDashboardRecommendation => ({
  recommendationId: "hedge-dashboard-recommendation",
  effectiveStatus,
  recommendationStatus: "current",
  generatedAt: "2026-07-10T14:00:00.000Z",
  expiresAt: "2026-07-10T14:30:00.000Z",
  environment: "paper",
  sourceSnapshotId: "portfolio-snapshot-dashboard",
  riskModelVersion: "portfolio-risk-v1",
  regimeModelVersion: "market-regime-v1",
  configurationFingerprint: "configuration-fingerprint",
  dataQualityStatus: "partial",
  reviewedPayloadHash: "reviewed-hash",
  decision: "trim_leaps_then_protect",
  risk: {
    portfolioBeta: 1.2,
    betaCoverage: 0.9,
    optionDataCoverage: {
      contractDeltaCoveragePct: 1,
      marketValueDeltaCoveragePct: 1,
      materialCoverageMissing: false
    },
    exposures: { grossExposurePct: 1.4, netExposurePct: 1.1 },
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
      coverage: Object.fromEntries(
        ["delta", "gamma", "theta", "vega", "rho", "impliedVolatility"].map((name) => [
          name,
          {
            positions: { total: 1, measured: 1, unmeasured: 0, coverageRatio: 1 },
            absoluteContracts: { total: 1, measured: 1, unmeasured: 0, coverageRatio: 1 },
            absoluteMarketValue: { total: 10000, measured: 10000, unmeasured: 0, coverageRatio: 1 },
            freshness: { current: 1, stale: 0, expired: 0, malformed: 0, total: 1 }
          }
        ])
      ),
      freshness: { current: 1, stale: 0, expired: 0, malformed: 0, total: 1 },
      groupings: {
        byUnderlying: {
          SPY: {
            positionCount: 1,
            absoluteContracts: 1,
            absoluteMarketValue: 10000,
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
            quality: "complete",
            missingMetrics: []
          }
        },
        byExpiration: { "2026-09-18": { positionCount: 1, quality: "complete" } },
        byOptionType: { call: { positionCount: 1, quality: "complete" } },
        byDteBucket: { "61-90": { positionCount: 1, quality: "complete" } }
      }
    },
    concentration: { largestUnderlyingWeight: 0.35, topFiveUnderlyingWeight: 0.8 },
    scenarios: [
      { benchmarkDeclinePct: 10, netModeledLoss: 100000, existingProtection: 25000 }
    ]
  },
  regime: { regime: "risk-off", selectedRule: "RISK_OFF_LONG_TREND_BREAK" },
  score: {
    total: 70,
    band: "high",
    measurementStatus: "measured",
    effectiveBand: "high"
  },
  sizing: {
    targetScenarioDeclinePct: 10,
    grossProtectionTarget: 60000,
    existingMeasuredProtection: 25000,
    netProtectionTarget: 35000,
    residualUnprotectedLoss: 25000
  },
  leaps: {
    profitFundedPremiumBudget: 2500,
    unrealizedGainFundingProxy: true,
    trimRecommendations: [{ symbol: "AAPL280120C00150000", quantityToTrim: 1 }]
  },
  candidates: [
    {
      candidateId: "spread-1",
      rank: 1,
      instrumentType: "put_spread",
      symbol: "SPY spread",
      expectedProtection: 10000,
      estimatedCost: 2000,
      units: 1,
      blockers: ["MULTI_LEG_EXECUTION_UNSUPPORTED"]
    }
  ],
  warnings: ["SECTOR_COVERAGE_PARTIAL"],
  blockers: [],
  integrityWarnings: []
});

test("dashboard labels expired hedge recommendations as not current", () => {
  const html = renderToStaticMarkup(
    createElement(HedgePanel, { recommendation: dashboardRecommendation("expired") })
  );

  assert.match(html, /EXPIRED/);
  assert.match(html, /This recommendation is not current/);
  assert.doesNotMatch(html, /Current recommendation/);
});

test("dashboard renders current risk, regime, LEAPS, sizing, and blocker details", () => {
  const html = renderToStaticMarkup(
    createElement(HedgePanel, { recommendation: dashboardRecommendation("current") })
  );

  assert.match(html, /Current recommendation/);
  assert.match(html, /Calculated risk score/);
  assert.match(html, /Calculated band/);
  assert.match(html, />70</);
  assert.match(html, />high</);
  assert.match(html, /risk-off/);
  assert.match(html, /10% decline/);
  assert.match(html, /Profit-funded premium budget/);
  assert.match(html, /AAPL280120C00150000/);
  assert.match(html, /MULTI_LEG_EXECUTION_UNSUPPORTED/);
});

test("dashboard presents incomplete low risk as indeterminate", () => {
  const recommendation = dashboardRecommendation("current");
  recommendation.recommendationStatus = "monitoring";
  recommendation.decision = "monitor";
  recommendation.dataQualityStatus = "monitoring";
  recommendation.score = {
    total: 4,
    band: "low",
    measurementStatus: "indeterminate",
    effectiveBand: "indeterminate"
  };
  recommendation.risk = {
    ...recommendation.risk,
    portfolioBeta: null,
    optionDataCoverage: {
      contractDeltaCoveragePct: 0.12,
      marketValueDeltaCoveragePct: 0.12,
      materialCoverageMissing: true
    }
  };
  recommendation.warnings = ["MATERIAL_OPTION_GREEKS_COVERAGE_INSUFFICIENT"];

  const html = renderToStaticMarkup(createElement(HedgePanel, { recommendation }));

  assert.match(html, /Calculated risk score/);
  assert.match(html, />4</);
  assert.match(html, /Calculated band/);
  assert.match(html, />low</);
  assert.match(html, /Measurement status/);
  assert.match(html, /indeterminate/i);
  assert.match(html, /Effective decision status/);
  assert.match(html, /monitoring/);
  assert.match(html, /Option delta contract coverage/);
  assert.match(html, /12\.0%/);
  assert.match(html, /Material option exposure could not be delta-measured/);
  assert.match(html, /MATERIAL_OPTION_GREEKS_COVERAGE_INSUFFICIENT/);
});

test("dashboard renders complete Greek units, IV, coverage, freshness, groupings, and paper state", () => {
  const html = renderToStaticMarkup(
    createElement(HedgePanel, { recommendation: dashboardRecommendation("current") })
  );

  for (const label of [
    "Delta shares",
    "Delta dollars",
    "Gamma shares per $1 underlying move",
    "Theta dollars per day",
    "Vega dollars per volatility point",
    "Rho dollars per rate point",
    "IV weighted by contracts",
    "IV weighted by market value",
    "IV weighted by vega",
    "Delta contract coverage",
    "Gamma market-value coverage",
    "Theta contract coverage",
    "Vega market-value coverage",
    "Rho contract coverage",
    "IV market-value coverage",
    "Greek freshness",
    "By underlying",
    "By expiration",
    "By option type",
    "By DTE bucket",
    "Paper only",
    "Live trading disabled"
  ]) {
    assert.match(html, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(html, /SPY/);
  assert.match(html, /61-90/);
  assert.match(html, /30\.0%/);
  assert.match(html, /current 1.*stale 0.*expired 0.*malformed 0/i);
});

test("dashboard renders missing Greek metrics as unavailable rather than zero", () => {
  const recommendation = dashboardRecommendation("current");
  recommendation.risk!.options!.gammaSharesPerDollar = null;
  const html = renderToStaticMarkup(createElement(HedgePanel, { recommendation }));

  assert.match(html, /Gamma shares per \$1 underlying move<\/span><strong>Unavailable/);
  assert.doesNotMatch(html, /Gamma shares per \$1 underlying move<\/span><strong>0/);
});
