import { after, describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "alpaca-paper-execute-test-"));

process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_ENV = "paper";
process.env.ENABLE_AGGRESSIVE_PAPER_STRATEGIES = "true";
process.env.RESEARCH_DB_PATH = join(tempDir, "research.db");

import {
  submitPaperOrder,
  type AlpacaAccountRaw,
  type AlpacaOptionContractRaw,
  type AlpacaPaperOrderRequest,
  type AlpacaPositionRaw,
  type AlpacaSubmittedOrder
} from "../src/services/alpacaClient.js";
import {
  buildPaperExecuteConfirmPaperReport,
  buildPaperExecuteDryRunReport,
  formatPaperExecuteConfirmReportAsTable,
  formatPaperExecuteDryRunReportAsTable
} from "../src/services/paperExecuteDryRunService.js";
import { getDb } from "../src/lib/db.js";
import type { PaperPlanCandidate, PaperPlanReport } from "../src/services/paperPlanService.js";
import type { PaperReviewReport } from "../src/services/paperReviewService.js";

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const now = "2026-07-02T21:45:30.000Z";

const plannedCandidate = (
  values: Partial<PaperPlanCandidate> = {}
): PaperPlanCandidate => ({
  symbol: "AAPL",
  side: "buy",
  assetClass: "us_equity",
  orderType: "market",
  timeInForce: "day",
  latestRank: 1,
  recommendation: "long shares",
  estimatedPrice: 100,
  estimatedQty: 1,
  estimatedNotional: 100,
  decision: "planned",
  reasonCodes: [
    "TRADABLE",
    "BUYING_POWER_OK",
    "WITHIN_POSITION_CAP",
    "QTY_ESTIMATED",
    "PAPER_ENV_CONFIRMED",
    "LIVE_TRADING_DISABLED",
    "PLAN_ONLY_NO_MUTATION"
  ],
  explanation: "Planned",
  ...values
});

const futureDate = (daysFromNow: number) => {
  const date = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
};

const optionCandidate = (
  strategy: "long_call" | "long_put" | "cash_secured_put" | "covered_call" = "long_call",
  values: Partial<PaperPlanCandidate> = {}
): PaperPlanCandidate => {
  const side = strategy === "long_call" || strategy === "long_put" ? "buy" : "sell";
  const symbol =
    strategy === "long_put" || strategy === "cash_secured_put"
      ? "AAPL260814P00100000"
      : "AAPL260814C00100000";
  return plannedCandidate({
    symbol,
    side,
    assetClass: "option",
    orderType: "limit",
    underlyingSymbol: "AAPL",
    optionSymbol: symbol,
    strategy,
    limitPrice: 0.75,
    maxRisk: strategy === "cash_secured_put" ? 75 : 75,
    expirationDate: futureDate(30),
    strike: 100,
    contracts: 1,
    bidAskSpreadPct: 10,
    quoteStatus: "valid",
    executable: true,
    executablePrice: 0.75,
    executablePriceSource: "midpoint",
    rejectionReason: null,
    quoteTimestamp: now,
    recommendation: `long ${strategy}`,
    estimatedPrice: 0.75,
    estimatedQty: 1,
    estimatedNotional: 75,
    ...values
  });
};

const mockAccount = (values: Partial<AlpacaAccountRaw> = {}): AlpacaAccountRaw => ({
  status: "ACTIVE",
  cash: "100000",
  equity: "100000",
  portfolio_value: "100000",
  buying_power: "100000",
  options_buying_power: "100000",
  options_approved_level: 2,
  options_trading_level: 2,
  ...values
});

const mockContract = (
  symbol: string,
  values: Partial<AlpacaOptionContractRaw> = {}
): AlpacaOptionContractRaw => ({
  symbol,
  status: "active",
  tradable: true,
  underlying_symbol: "AAPL",
  expiration_date: futureDate(30),
  type: symbol.includes("P") ? "put" : "call",
  strike_price: 100,
  multiplier: 100,
  ...values
});

const mockPosition = (values: Partial<AlpacaPositionRaw> = {}): AlpacaPositionRaw => ({
  symbol: "AAPL",
  asset_class: "us_equity",
  qty: "100",
  qty_available: "100",
  ...values
});

const mockSubmitSuccess = async (
  payload: AlpacaPaperOrderRequest
): Promise<{
  data: AlpacaSubmittedOrder;
  requestId: string;
  status: number;
  url: string;
}> => ({
  data: {
    id: `order-${payload.symbol}`,
    client_order_id: payload.client_order_id,
    symbol: payload.symbol,
    status: "accepted"
  },
  requestId: `request-${payload.symbol}`,
  status: 200,
  url: "https://paper-api.alpaca.markets/v2/orders"
});

const confirmWith = async (
  planValues: Partial<PaperPlanReport> = {},
  reviewValues: Partial<PaperReviewReport> = {},
  input: Parameters<typeof buildPaperExecuteConfirmPaperReport>[0] = { confirmPaper: true },
  deps: NonNullable<Parameters<typeof buildPaperExecuteConfirmPaperReport>[1]> = {}
) => {
  const plan = basePlan(planValues);
  return buildPaperExecuteConfirmPaperReport(input, {
    now: () => now,
    buildPlan: async () => plan,
    buildReview: async () => baseReview(plan, reviewValues),
    getAccount: async () => ({
      data: mockAccount(),
      requestId: "account-request-id",
      status: 200,
      url: "https://paper-api.alpaca.markets/v2/account"
    }),
    getOptionContract: async (symbolOrId: string) => ({
      data: mockContract(symbolOrId),
      requestId: "contract-request-id",
      status: 200,
      url: `https://paper-api.alpaca.markets/v2/options/contracts/${symbolOrId}`
    }),
    listPaperPositions: async () => ({
      data: [mockPosition()],
      requestId: "positions-request-id",
      status: 200,
      url: "https://paper-api.alpaca.markets/v2/positions"
    }),
    submitPaperOrder: mockSubmitSuccess,
    ...deps
  });
};

const basePlan = (values: Partial<PaperPlanReport> = {}): PaperPlanReport => {
  const plan = values.plan || [plannedCandidate()];
  return {
    paperOnly: true,
    environment: "paper",
    generatedAt: now,
    dryRun: true,
    nonMutating: true,
    config: {
      riskProfile: "moderate",
      optionsEnabled: false,
      maxCandidates: 5,
      maxNewPositions: 3,
      maxPositionNotional: 100,
      maxTotalPlanNotional: 300,
      minBuyingPowerReservePct: 20,
      equityNotionalPerOrder: 1000,
      equityMaxNotionalPerOrder: 5000,
      equityMaxPortfolioDeployPct: 50,
      equityMaxPositionPct: 10,
      equityMinCashReservePct: 20
    },
    account: {
      status: "ACTIVE",
      equity: 1000,
      cash: 1000,
      buyingPower: 800,
      reservedBuyingPower: 160,
      deployableBuyingPower: 640
    },
    summary: {
      candidatesEvaluated: plan.length,
      plannedOrders: plan.filter((candidate) => candidate.decision === "planned").length,
      watched: plan.filter((candidate) => candidate.decision === "watch").length,
      skipped: plan.filter((candidate) => candidate.decision === "skip").length,
      estimatedTotalNotional: plan
        .filter((candidate) => candidate.decision === "planned")
        .reduce((total, candidate) => total + (candidate.estimatedNotional || 0), 0),
      remainingDeployableBuyingPower: 540
    },
    plan,
    source: {
      snapshotRunId: "research_abc12345-0000-0000-0000-000000000000",
      recommendationTimestamp: "2026-07-02T04:00:00.000Z",
      runtimeTimestamp: now
    },
    diagnostics: {
      latestSnapshotAvailable: true,
      latestSnapshotRunId: "research_abc12345-0000-0000-0000-000000000000",
      latestSnapshotTimestamp: now,
      filtersMatchedSnapshots: true,
      runtimeCandidatesAvailable: true,
      emptyReason: null
    },
    ...values
  };
};

const baseReview = (
  plan: PaperPlanReport,
  values: Partial<PaperReviewReport> = {}
): PaperReviewReport => ({
  paperOnly: true,
  environment: "paper",
  generatedAt: now,
  reviewOnly: true,
  nonMutating: true,
  config: {
    riskProfile: plan.config.riskProfile,
    optionsEnabled: plan.config.optionsEnabled,
    maxCandidates: plan.config.maxCandidates,
    maxNewPositions: plan.config.maxNewPositions,
    maxPositionNotional: plan.config.maxPositionNotional,
    maxTotalPlanNotional: plan.config.maxTotalPlanNotional,
    minBuyingPowerReservePct: plan.config.minBuyingPowerReservePct,
    maxPlanAgeMinutes: 30,
    maxBuyingPowerUsePct: 50
  },
  planSummary: {
    candidatesEvaluated: plan.summary.candidatesEvaluated,
    plannedOrders: plan.summary.plannedOrders,
    watched: plan.summary.watched,
    skipped: plan.summary.skipped,
    estimatedTotalNotional: plan.summary.estimatedTotalNotional,
    buyingPowerUsePct: 10,
    remainingDeployableBuyingPower: plan.summary.remainingDeployableBuyingPower
  },
  review: {
    status: "ready_for_dry_run_execution",
    blockers: [],
    warnings: [],
    confirmationsRequired: []
  },
  risk: {
    concentrationWarnings: [],
    duplicateExposureWarnings: [],
    staleDataWarnings: [],
    aggressiveModeWarnings: [],
    optionsWarnings: [],
    buyingPowerWarnings: []
  },
  candidateCounts: {
    inputCandidates: plan.summary.candidatesEvaluated,
    plannedOrders: plan.summary.plannedOrders,
    eligiblePayloads: plan.plan.filter((candidate) => candidate.decision === "planned").length,
    skippedAlreadyHeld: plan.plan.filter((candidate) =>
      candidate.decision !== "planned" &&
      (
        candidate.reasonCodes.includes("ALREADY_HELD") ||
        candidate.reasonCodes.includes("ALREADY_HELD_EQUITY") ||
        candidate.reasonCodes.includes("ALREADY_HELD_OPTION_CONTRACT")
      )
    ).length,
    skippedAlreadyHeldEquity: plan.plan.filter((candidate) =>
      candidate.decision !== "planned" &&
      candidate.assetClass === "us_equity" &&
      (
        candidate.reasonCodes.includes("ALREADY_HELD") ||
        candidate.reasonCodes.includes("ALREADY_HELD_EQUITY")
      )
    ).length,
    skippedAlreadyHeldOptionContract: plan.plan.filter((candidate) =>
      candidate.decision !== "planned" &&
      candidate.assetClass === "option" &&
      candidate.reasonCodes.includes("ALREADY_HELD_OPTION_CONTRACT")
    ).length,
    skippedUnderlyingEquityHeldForOption: plan.plan.filter((candidate) =>
      candidate.decision !== "planned" &&
      candidate.assetClass === "option" &&
      candidate.reasonCodes.includes("ALREADY_HELD_EQUITY")
    ).length,
    skippedDuplicateOpenEquityOrder: plan.plan.filter((candidate) =>
      candidate.decision !== "planned" &&
      candidate.assetClass === "us_equity" &&
      (
        candidate.reasonCodes.includes("OPEN_ORDER_EXISTS") ||
        candidate.reasonCodes.includes("DUPLICATE_OPEN_EQUITY_ORDER")
      )
    ).length,
    skippedDuplicateOpenOptionOrder: plan.plan.filter((candidate) =>
      candidate.decision !== "planned" &&
      candidate.assetClass === "option" &&
      candidate.reasonCodes.includes("DUPLICATE_OPEN_OPTION_ORDER")
    ).length,
    skippedQuoteUnavailable: plan.plan.filter((candidate) =>
      candidate.decision !== "planned" && candidate.rejectionReason === "quote_unavailable"
    ).length
  },
  topSkipReasons: [
    ...new Set(
      plan.plan
        .filter((candidate) => candidate.decision !== "planned")
        .map((candidate) =>
          candidate.reasonCodes.includes("ALREADY_HELD_EQUITY")
            ? "ALREADY_HELD_EQUITY"
            : candidate.reasonCodes.includes("ALREADY_HELD_OPTION_CONTRACT")
              ? "ALREADY_HELD_OPTION_CONTRACT"
              : candidate.reasonCodes.includes("ALREADY_HELD")
                ? "ALREADY_HELD"
                : candidate.rejectionReason || candidate.reasonCodes[0] || candidate.decision
        )
    )
  ],
  plan: plan.plan.map((candidate) => ({
    symbol: candidate.symbol,
    decision: candidate.decision,
    estimatedNotional: candidate.estimatedNotional,
    estimatedQty: candidate.estimatedQty,
    reasonCodes: candidate.reasonCodes,
    reviewFlags: []
  })),
  source: {
    snapshotRunId: plan.source.snapshotRunId,
    recommendationTimestamp: plan.source.recommendationTimestamp,
    runtimeTimestamp: plan.source.runtimeTimestamp,
    planTimestamp: plan.generatedAt
  },
  diagnostics: plan.diagnostics,
  ...values
});

const runWith = async (
  planValues: Partial<PaperPlanReport> = {},
  reviewValues: Partial<PaperReviewReport> = {},
  input: Parameters<typeof buildPaperExecuteDryRunReport>[0] = { dryRun: true }
) => {
  const plan = basePlan(planValues);
  return buildPaperExecuteDryRunReport(input, {
    now: () => now,
    buildPlan: async () => plan,
    buildReview: async () => baseReview(plan, reviewValues)
  });
};

beforeEach(() => {
  process.env.ALPACA_ENV = "paper";
  process.env.LIVE_TRADING_ENABLED = "false";
  process.env.ALPACA_LIVE_TRADE = "false";
  process.env.ALPACA_PAPER_API_KEY = "paper-key";
  process.env.ALPACA_PAPER_SECRET_KEY = "paper-secret";
  process.env.ALPACA_PAPER_BASE_URL = "https://paper-api.alpaca.markets";
  process.env.PAPER_ORDER_EXECUTION_ENABLED = "false";
  process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "false";
  process.env.PAPER_OPTIONS_MAX_PREMIUM_PER_ORDER = "1000";
  process.env.PAPER_OPTIONS_MAX_CONTRACTS = "5";
  process.env.PAPER_OPTIONS_MIN_DTE = "0";
  process.env.PAPER_OPTIONS_MAX_DTE = "90";
  delete process.env.PAPER_OPTIONS_ALLOW_0DTE;
  delete process.env.ALLOW_0DTE_OPTIONS;
  delete process.env.OPTIONS_QUOTE_MAX_AGE_MS;
  delete process.env.ALLOW_OPTIONS_LAST_PRICE_FALLBACK;
  process.env.PAPER_OPTIONS_ALLOW_MARKET_ORDERS = "false";
  process.env.PAPER_OPTIONS_MAX_SPREAD_PCT = "50";
  process.env.PAPER_OPTIONS_MAX_PORTFOLIO_RISK_PCT = "20";
  process.env.PAPER_OPTIONS_MAX_POSITION_RISK_PCT = "5";
  delete process.env.PAPER_RUNTIME_DUPLICATE_RECONCILIATION_ENABLED;
  getDb().exec("DELETE FROM paper_execution_ledger;");
});

describe("paper execute dry-run service guardrails", () => {
  test("fails if dry-run flag is missing", async () => {
    const report = await buildPaperExecuteDryRunReport({}, { now: () => now });
    assert.equal(report.reviewStatus, "blocked");
    assert.equal(report.blockers.includes("DRY_RUN_OR_CONFIRM_PAPER_REQUIRED"), true);
    assert.equal(report.wouldSubmit.length, 0);
  });

  test("fails if Alpaca environment is not paper", async () => {
    process.env.ALPACA_ENV = "live";
    const report = await buildPaperExecuteDryRunReport({ dryRun: true }, { now: () => now });
    assert.equal(report.blockers.includes("NON_PAPER_ENVIRONMENT"), true);
    assert.equal(report.wouldSubmit.length, 0);
  });

  test("fails if live trading is enabled", async () => {
    process.env.LIVE_TRADING_ENABLED = "true";
    const report = await buildPaperExecuteDryRunReport({ dryRun: true }, { now: () => now });
    assert.equal(report.blockers.includes("LIVE_TRADING_ENABLED"), true);
    assert.equal(report.wouldSubmit.length, 0);
  });

  test("fails if review status is blocked", async () => {
    const report = await runWith({}, {
      review: {
        status: "blocked",
        blockers: ["NO_PLANNED_ORDERS"],
        warnings: [],
        confirmationsRequired: ["Resolve blockers."]
      }
    });
    assert.equal(report.blockers.includes("REVIEW_BLOCKED"), true);
    assert.equal(report.wouldSubmit.length, 0);
  });

  test("returns no-op if plan has no planned orders", async () => {
    const report = await runWith({
      plan: [
        plannedCandidate({
          symbol: "MSFT",
          decision: "watch",
          estimatedNotional: null,
          estimatedQty: null,
          reasonCodes: ["ALREADY_HELD_EQUITY"],
          explanation: "Watch"
        })
      ]
    });
    assert.equal(report.status, "no_op");
    assert.equal(report.reason, "NO_ELIGIBLE_PAPER_PAYLOADS");
    assert.equal(report.blockers.length, 0);
    assert.equal(report.candidateCounts?.skippedAlreadyHeld, 1);
    assert.equal(report.candidateCounts?.skippedAlreadyHeldEquity, 1);
    assert.deepEqual(report.topSkipReasons, ["ALREADY_HELD_EQUITY"]);
    assert.equal(report.wouldSubmit.length, 0);
  });

  test("empty plan produces clean no-op instead of ambiguous failure", async () => {
    const report = await runWith({
      plan: [],
      summary: {
        candidatesEvaluated: 0,
        plannedOrders: 0,
        watched: 0,
        skipped: 0,
        estimatedTotalNotional: 0,
        remainingDeployableBuyingPower: 800
      },
      diagnostics: {
        latestSnapshotAvailable: true,
        latestSnapshotRunId: "run-empty",
        latestSnapshotTimestamp: now,
        filtersMatchedSnapshots: true,
        runtimeCandidatesAvailable: false,
        emptyReason: "NO_RUNTIME_CANDIDATES"
      }
    }, {
      review: {
        status: "blocked",
        blockers: ["NO_RUNTIME_CANDIDATES"],
        warnings: [],
        confirmationsRequired: ["No runtime candidates."]
      }
    });

    assert.equal(report.status, "no_op");
    assert.equal(report.reason, "NO_ELIGIBLE_PAPER_PAYLOADS");
    assert.equal(report.summary.wouldSubmitCount, 0);
    assert.equal(report.blockers.length, 0);
  });

  test("fails if plan is not dry-run", async () => {
    const report = await runWith({ dryRun: false as true });
    assert.equal(report.blockers.includes("PLAN_NOT_DRY_RUN"), true);
  });

  test("fails if plan is not non-mutating", async () => {
    const report = await runWith({ nonMutating: false as true });
    assert.equal(report.blockers.includes("PLAN_NOT_NON_MUTATING"), true);
  });

  test("fails if review is not review-only", async () => {
    const report = await runWith({}, { reviewOnly: false as true });
    assert.equal(report.blockers.includes("REVIEW_NOT_REVIEW_ONLY"), true);
  });

  test("fails if review is not non-mutating", async () => {
    const report = await runWith({}, { nonMutating: false as true });
    assert.equal(report.blockers.includes("REVIEW_NOT_NON_MUTATING"), true);
  });

  test("does not call Alpaca mutation methods directly", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      const method = String(init?.method || "GET").toUpperCase();
      assert.equal(method, "GET");
      throw new Error("executor should not fetch when plan/review are provided");
    };

    try {
      const report = await runWith();
      assert.equal(report.wouldSubmit.length, 1);
      assert.equal(report.confirmations.includes("NO_MUTATION_PERFORMED"), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("paper execute dry-run payload construction", () => {
  test("constructs one notional payload per planned candidate and ignores watch/skip", async () => {
    const report = await runWith(
      {
        plan: [
          plannedCandidate({ symbol: "AAPL", estimatedNotional: 100 }),
          plannedCandidate({ symbol: "MSFT", latestRank: 2, estimatedNotional: 75 }),
          plannedCandidate({
            symbol: "NVDA",
            decision: "watch",
            estimatedNotional: null,
            estimatedQty: null,
            reasonCodes: ["PRICE_UNKNOWN"],
            explanation: "Watch"
          }),
          plannedCandidate({
            symbol: "TSLA",
            decision: "skip",
            estimatedNotional: null,
            estimatedQty: null,
            reasonCodes: ["OPEN_ORDER_EXISTS"],
            explanation: "Skip"
          })
        ]
      },
      {
        review: {
          status: "warning",
          blockers: [],
          warnings: ["SKIPPED_CANDIDATES_PRESENT"],
          confirmationsRequired: ["Review warning."]
        }
      }
    );

    assert.equal(report.reviewStatus, "warning");
    assert.equal(report.summary.plannedOrdersFromPlan, 2);
    assert.equal(report.summary.payloadsConstructed, 2);
    assert.equal(report.summary.wouldSubmitCount, report.wouldSubmit.length);
    assert.deepEqual(report.wouldSubmit.map((payload) => payload.symbol), ["AAPL", "MSFT"]);
    assert.equal(report.wouldSubmit.every((payload) => payload.notional && !payload.qty), true);
    assert.equal(report.warnings.includes("SKIPPED_CANDIDATES_PRESENT"), true);
  });

  test("blocks option candidate payloads when option limit data is missing", async () => {
    const report = await runWith({
      plan: [
        plannedCandidate({
          symbol: "AAPL250117C00100000",
          assetClass: "option",
          recommendation: "long long_call",
          estimatedNotional: 100
        })
      ]
    });

    assert.equal(report.wouldSubmit.length, 0);
    assert.equal(report.blockedPayloads.length, 1);
    assert.equal(report.blockedPayloads[0]?.reasonCodes.includes("OPTION_LIMIT_PRICE_REQUIRED"), true);
    assert.equal(report.blockers.includes("OPTION_LIMIT_PRICE_REQUIRED"), true);
  });

  test("blocks option candidate payloads when quote status is not executable", async () => {
    const report = await runWith({
      plan: [
        optionCandidate("long_call", {
          limitPrice: 0.75,
          quoteStatus: "missing",
          executable: false,
          executablePrice: null,
          executablePriceSource: null,
          rejectionReason: "quote_unavailable"
        })
      ]
    });

    assert.equal(report.wouldSubmit.length, 0);
    assert.equal(report.blockedPayloads.length, 1);
    assert.equal(report.blockedPayloads[0]?.reasonCodes.includes("OPTION_LIMIT_PRICE_UNAVAILABLE"), true);
    assert.match(report.blockedPayloads[0]?.explanation || "", /quote_unavailable/);
  });

  test("includes valid client order ids", async () => {
    const report = await runWith();
    const id = report.wouldSubmit[0]?.client_order_id || "";
    assert.match(id, /^paper-equity-AAPL-[A-Za-z0-9_-]+-20260702214530-1$/);
    assert.equal(id.length <= 128, true);
  });

  test("returns stable JSON shape", async () => {
    const report = await runWith();
    assert.equal(report.paperOnly, true);
    assert.equal(report.environment, "paper");
    assert.equal(report.dryRun, true);
    assert.equal(report.nonMutating, true);
    assert.equal(report.executionMode, "dryRun");
    assert.equal(Array.isArray(report.wouldSubmit), true);
    assert.equal(Array.isArray(report.blockedPayloads), true);
    assert.equal(report.wouldSubmit.length, report.summary.wouldSubmitCount);
  });

  test("renders table output without throwing", async () => {
    const report = await runWith();
    const output = formatPaperExecuteDryRunReportAsTable(report);
    assert.equal(output.includes("Paper Execute, dry-run only"), true);
    assert.equal(output.includes("Dry-run only. No orders were submitted."), true);
    assert.equal(output.includes("paper-equity-"), true);
  });
});

describe("paper execute confirm-paper guardrails", () => {
  test("requires confirmPaper flag", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    const report = await buildPaperExecuteConfirmPaperReport({}, { now: () => now });
    assert.equal(report.errors[0]?.reason, "DRY_RUN_OR_CONFIRM_PAPER_REQUIRED");
    assert.equal(report.submitted.length, 0);
  });

  test("requires ALPACA_ENV=paper", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.ALPACA_ENV = "live";
    const report = await confirmWith();
    assert.equal(report.errors.some((error) => error.reason === "PAPER_ENV_REQUIRED"), true);
    assert.equal(report.submitted.length, 0);
  });

  test("rejects live trading enabled", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.LIVE_TRADING_ENABLED = "true";
    const report = await confirmWith();
    assert.equal(report.errors.some((error) => error.reason === "LIVE_TRADING_MUST_BE_DISABLED"), true);
    assert.equal(report.submitted.length, 0);
  });

  test("requires PAPER_ORDER_EXECUTION_ENABLED=true", async () => {
    const report = await confirmWith();
    assert.equal(report.errors.some((error) => error.reason === "PAPER_ORDER_EXECUTION_DISABLED"), true);
    assert.equal(report.submitted.length, 0);
  });

  test("submits eligible equity payload in paper mode", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    const report = await confirmWith();
    assert.equal(report.errors.length, 0);
    assert.equal(report.submitted.length, 1);
    assert.equal(report.submitted[0]?.assetClass, "equity");
    assert.equal(report.submitted[0]?.status, "accepted");
    assert.equal(JSON.stringify(report).includes("paper-secret"), false);
  });

  test("blocked review prevents equity submission", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    const report = await confirmWith(
      {},
      {
        review: {
          status: "blocked",
          blockers: ["NO_PLANNED_ORDERS"],
          warnings: [],
          confirmationsRequired: ["Resolve blockers."]
        }
      }
    );
    assert.equal(report.errors.some((error) => error.reason === "PAPER_REVIEW_BLOCKED"), true);
    assert.equal(report.submitted.length, 0);
  });

  test("empty payload set returns no-op without confirm-paper errors", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    const report = await confirmWith({
      plan: [
        plannedCandidate({
          decision: "watch",
          estimatedNotional: null,
          estimatedQty: null,
          reasonCodes: ["PRICE_UNKNOWN"],
          explanation: "Watch"
        })
      ]
    });
    assert.equal(report.status, "no_op");
    assert.equal(report.reason, "NO_ELIGIBLE_PAPER_PAYLOADS");
    assert.equal(report.errors.length, 0);
    assert.equal(report.submitted.length, 0);
  });

  test("submission failure returns structured error", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    const report = await confirmWith({}, {}, { confirmPaper: true }, {
      submitPaperOrder: async () => {
        throw new Error("submission failed");
      }
    });
    assert.equal(report.errors.some((error) => error.reason === "ALPACA_PAPER_ORDER_SUBMISSION_FAILED"), true);
    assert.equal(report.blocked[0]?.reason, "ALPACA_PAPER_ORDER_SUBMISSION_FAILED");
    assert.equal(report.submitted.length, 0);
  });

  test("duplicate payloads are blocked via execution ledger", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    const first = await confirmWith();
    const second = await confirmWith();

    assert.equal(first.submitted.length, 1);
    assert.equal(first.errors.length, 0);
    assert.equal(second.submitted.length, 0);
    assert.equal(second.blocked.some((entry) => entry.reason === "DUPLICATE_PAPER_ORDER_BLOCKED"), true);
    const statuses = getDb()
      .prepare("SELECT status FROM paper_execution_ledger ORDER BY id ASC")
      .all() as Array<{ status: string }>;
    assert.deepEqual(statuses.map((row) => row.status), ["accepted", "duplicate_blocked"]);
  });

  test("options disabled does not block eligible equities when assetClass=all", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    const report = await confirmWith({
      plan: [
        plannedCandidate({ symbol: "AAPL", estimatedNotional: 100 }),
        optionCandidate("long_call")
      ]
    });
    assert.equal(report.submitted.map((entry) => entry.assetClass).includes("equity"), true);
    assert.equal(report.blocked.some((entry) => entry.reason === "PAPER_OPTIONS_EXECUTION_DISABLED"), true);
  });
});

describe("paper execute confirm-paper options", () => {
  test("long call paper payload submits when all gates pass", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    const submittedPayloads: AlpacaPaperOrderRequest[] = [];
    const report = await confirmWith({ plan: [optionCandidate("long_call", {
      limitPrice: 1.25,
      executablePrice: 1.25,
      executablePriceSource: "midpoint",
      estimatedPremium: 125,
      maxRisk: 125,
      estimatedNotional: 125
    })] }, {}, { confirmPaper: true }, {
      submitPaperOrder: async (payload) => {
        submittedPayloads.push(payload);
        return mockSubmitSuccess(payload);
      }
    });
    assert.equal(report.errors.length, 0);
    assert.equal(report.submitted.length, 1);
    assert.equal(report.submitted[0]?.assetClass, "option");
    assert.equal(report.submitted[0]?.strategy, "long_call");
    assert.equal(report.submitted[0]?.limitPrice, "1.25");
    const submittedPayload = submittedPayloads[0];
    assert.equal(submittedPayload?.symbol, "AAPL260814C00100000");
    assert.equal(submittedPayload?.type, "limit");
    assert.equal(submittedPayload?.limit_price, "1.25");
    assert.equal(submittedPayload?.position_intent, "buy_to_open");
  });

  test("long put paper payload submits when all gates pass", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    const report = await confirmWith({ plan: [optionCandidate("long_put")] });
    assert.equal(report.errors.length, 0);
    assert.equal(report.submitted.length, 1);
    assert.equal(report.submitted[0]?.strategy, "long_put");
  });

  test("options require PAPER_OPTIONS_EXECUTION_ENABLED=true", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    const report = await confirmWith({ plan: [optionCandidate("long_call")] });
    assert.equal(report.blocked[0]?.reason, "PAPER_OPTIONS_EXECUTION_DISABLED");
    assert.equal(report.submitted.length, 0);
  });

  test("confirm-paper does not submit option payloads with rejected quote status", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    let submitCalls = 0;
    const report = await confirmWith({ plan: [
      optionCandidate("long_call", {
        limitPrice: 0.75,
        quoteStatus: "missing",
        executable: false,
        executablePrice: null,
        executablePriceSource: null,
        rejectionReason: "quote_unavailable"
      })
    ] }, {}, { confirmPaper: true }, {
      submitPaperOrder: async (payload) => {
        submitCalls += 1;
        return mockSubmitSuccess(payload);
      }
    });

    assert.equal(submitCalls, 0);
    assert.equal(report.submitted.length, 0);
    assert.equal(report.blocked.some((entry) => entry.reason === "OPTION_LIMIT_PRICE_UNAVAILABLE"), true);
  });

  test("option without limit price is blocked", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    const report = await confirmWith({
      plan: [optionCandidate("long_call", { limitPrice: null, orderType: "market" })]
    });
    assert.equal(report.blocked[0]?.reason, "OPTION_LIMIT_PRICE_REQUIRED");
    assert.equal(report.submitted.length, 0);
  });

  test("inactive or expired option contract is blocked", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    const report = await confirmWith({ plan: [optionCandidate("long_call")] }, {}, { confirmPaper: true }, {
      getOptionContract: async (symbolOrId: string) => ({
        data: mockContract(symbolOrId, { status: "inactive", tradable: false }),
        requestId: "contract-request-id",
        status: 200,
        url: `https://paper-api.alpaca.markets/v2/options/contracts/${symbolOrId}`
      })
    });
    assert.equal(report.blocked[0]?.reason, "OPTION_CONTRACT_NOT_TRADABLE");
    assert.equal(report.submitted.length, 0);
  });

  test("insufficient options approval is blocked", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    const report = await confirmWith({ plan: [optionCandidate("long_call")] }, {}, { confirmPaper: true }, {
      getAccount: async () => ({
        data: mockAccount({ options_approved_level: 1, options_trading_level: 1 }),
        requestId: "account-request-id",
        status: 200,
        url: "https://paper-api.alpaca.markets/v2/account"
      })
    });
    assert.equal(report.blocked[0]?.reason, "OPTIONS_APPROVAL_LEVEL_INSUFFICIENT");
    assert.equal(report.submitted.length, 0);
  });

  test("option risk above cap is blocked", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    const report = await confirmWith({
      plan: [optionCandidate("long_call", { maxRisk: 6000 })]
    });
    assert.equal(report.blocked[0]?.reason, "OPTION_RISK_LIMIT_EXCEEDED");
    assert.equal(report.submitted.length, 0);
  });

  test("max option contracts respects env cap", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_MAX_CONTRACTS = "2";
    const report = await confirmWith({
      plan: [optionCandidate("long_call", { contracts: 3, estimatedQty: 3, maxRisk: 225 })]
    });
    assert.equal(report.blocked[0]?.reason, "OPTION_RISK_LIMIT_EXCEEDED");
    assert.equal(report.submitted.length, 0);
  });

  test("naked short call is blocked by covered-call share requirement", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    const report = await confirmWith({ plan: [optionCandidate("covered_call", { maxRisk: 0 })] }, {}, { confirmPaper: true }, {
      listPaperPositions: async () => ({
        data: [],
        requestId: "positions-request-id",
        status: 200,
        url: "https://paper-api.alpaca.markets/v2/positions"
      })
    });
    assert.equal(report.blocked[0]?.reason, "UNSUPPORTED_OPTION_STRATEGY");
    assert.equal(report.submitted.length, 0);
  });

  test("covered call submits only when sufficient shares exist", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    const report = await confirmWith({ plan: [optionCandidate("covered_call", { maxRisk: 0 })] });
    assert.equal(report.errors.length, 0);
    assert.equal(report.submitted.length, 1);
    assert.equal(report.submitted[0]?.strategy, "covered_call");
  });

  test("cash-secured put requires sufficient computed buying power", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_MAX_PREMIUM_PER_ORDER = "20000";
    const report = await confirmWith({ plan: [optionCandidate("cash_secured_put")] }, {}, { confirmPaper: true }, {
      getAccount: async () => ({
        data: mockAccount({ options_buying_power: "100" }),
        requestId: "account-request-id",
        status: 200,
        url: "https://paper-api.alpaca.markets/v2/account"
      })
    });
    assert.equal(report.blocked[0]?.reason, "OPTION_RISK_LIMIT_EXCEEDED");
    assert.equal(report.submitted.length, 0);
  });

  test("market option order is blocked by default", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    const report = await confirmWith({
      plan: [optionCandidate("long_call", { orderType: "market" })]
    });
    assert.equal(report.blocked[0]?.reason, "OPTION_LIMIT_PRICE_REQUIRED");
    assert.equal(report.submitted.length, 0);
  });

  test("market option order is allowed only when explicitly configured", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_ALLOW_MARKET_ORDERS = "true";
    const report = await confirmWith({
      plan: [optionCandidate("long_call", { orderType: "market", limitPrice: null })]
    });
    assert.equal(report.errors.length, 0);
    assert.equal(report.submitted.length, 1);
    assert.equal(report.submitted[0]?.type, "market");
    assert.equal(report.submitted[0]?.limitPrice, undefined);
  });

  test("0DTE option is blocked by default for paper options", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    const report = await confirmWith({ plan: [optionCandidate("long_call")] }, {}, { confirmPaper: true }, {
      getOptionContract: async (symbolOrId: string) => ({
        data: mockContract(symbolOrId, { expiration_date: new Date().toISOString().slice(0, 10) }),
        requestId: "contract-request-id",
        status: 200,
        url: `https://paper-api.alpaca.markets/v2/options/contracts/${symbolOrId}`
      })
    });
    assert.equal(report.blocked[0]?.reason, "OPTION_0DTE_NOT_ENABLED");
    assert.equal(report.submitted.length, 0);
  });

  test("0DTE option is allowed only when explicitly enabled", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
    process.env.ALLOW_0DTE_OPTIONS = "true";
    const report = await confirmWith({ plan: [optionCandidate("long_call")] }, {}, { confirmPaper: true }, {
      getOptionContract: async (symbolOrId: string) => ({
        data: mockContract(symbolOrId, { expiration_date: new Date().toISOString().slice(0, 10) }),
        requestId: "contract-request-id",
        status: 200,
        url: `https://paper-api.alpaca.markets/v2/options/contracts/${symbolOrId}`
      })
    });
    assert.equal(report.errors.length, 0);
    assert.equal(report.submitted.length, 1);
  });

  test("renders confirm table output without throwing", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    const report = await confirmWith();
    const output = formatPaperExecuteConfirmReportAsTable(report);
    assert.equal(output.includes("Paper Execute, confirm-paper"), true);
    assert.equal(output.includes("Submitted:"), true);
  });
});

describe("paper execute endpoint safety", () => {
  test("submitPaperOrder uses paper endpoint even when ALPACA_PAPER_BASE_URL is misconfigured", async () => {
    process.env.ALPACA_PAPER_BASE_URL = "https://api.alpaca.markets";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input).startsWith("https://paper-api.alpaca.markets/v2/orders"), true);
      assert.equal(String(init?.method || "").toUpperCase(), "POST");
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => name.toLowerCase() === "x-request-id" ? "paper-request-id" : null
        },
        text: async () => JSON.stringify({ id: "paper-order", status: "accepted" })
      } as unknown as Response;
    };

    try {
      const result = await submitPaperOrder({
        symbol: "AAPL",
        side: "buy",
        type: "market",
        time_in_force: "day",
        notional: "100.00",
        client_order_id: "paper-equity-AAPL-test-20260702214530-1"
      });
      assert.equal(result.requestId, "paper-request-id");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
