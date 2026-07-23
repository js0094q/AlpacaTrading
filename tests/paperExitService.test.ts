import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildPaperExitReviewResult
} from "../src/services/paperExitReviewService.js";
import {
  buildPaperExitExecutionResult
} from "../src/services/paperExitExecutionService.js";
import type {
  AlpacaAccountRaw,
  AlpacaOptionSnapshotRaw,
  AlpacaPaperOrderRequest,
  AlpacaPositionRaw,
  AlpacaSubmittedOrder
} from "../src/services/alpacaClient.js";
import type {
  PaperExitReviewCandidate,
  PaperExitReviewResult
} from "../src/types/paperExit.js";
import type {
  PaperAccountReconciliationReport,
  PaperReconciliationEventType
} from "../src/services/paperAccountReconciliationService.js";
import { withExecutionAuthority } from "./helpers/executionAuthorityRuntime.js";
import type { StockPriceBatchResponse } from "../src/services/stockMarketDataAccessor.js";

const generatedAt = "2026-07-07T15:00:00.000Z";
const eodAt = "2026-07-07T18:30:00.000Z";
const forceAt = "2026-07-07T19:40:00.000Z";

const response = <T>(data: T, requestId: string) => ({
  data,
  requestId,
  status: 200,
  url: "https://paper-api.alpaca.markets/mock"
});

const account = (positions: AlpacaPositionRaw[] = []): AlpacaAccountRaw => {
  const positionMarketValue = positions
    .reduce((total, position) => total + Number(position.market_value || 0), 0)
    .toFixed(2);
  const cash = 100000 - Number(positionMarketValue);
  return {
    cash: cash.toFixed(2),
    equity: "100000.00",
    portfolio_value: "100000.00",
    buying_power: "100000.00",
    position_market_value: positionMarketValue,
    options_buying_power: "100000.00"
  };
};

const optionPosition = (values: Partial<AlpacaPositionRaw> = {}): AlpacaPositionRaw => ({
  symbol: "SPY260707C00750000",
  asset_class: "us_option",
  side: "long",
  qty: "1",
  qty_available: "1",
  avg_entry_price: "1.00",
  current_price: "0.50",
  market_value: "50.00",
  unrealized_pl: "-50.00",
  unrealized_plpc: "-0.50",
  ...values
});

const equityPosition = (values: Partial<AlpacaPositionRaw> = {}): AlpacaPositionRaw => ({
  symbol: "AAPL",
  asset_class: "us_equity",
  side: "long",
  qty: "10",
  qty_available: "10",
  avg_entry_price: "100.00",
  current_price: "94.00",
  market_value: "940.00",
  unrealized_pl: "-60.00",
  unrealized_plpc: "-0.06",
  ...values
});

const optionSnapshot = (
  symbol: string,
  bid = 0.50,
  ask = 0.54,
  timestamp = generatedAt
): AlpacaOptionSnapshotRaw => ({
  symbol,
  underlying_symbol: "SPY",
  latest_quote: {
    t: timestamp,
    bp: bid,
    ap: ask
  },
  latest_trade: {
    t: timestamp,
    p: (bid + ask) / 2
  }
});

const order = (values: Partial<AlpacaSubmittedOrder> = {}): AlpacaSubmittedOrder => ({
  id: "order-1",
  symbol: "AAPL",
  side: "sell",
  status: "new",
  qty: "1",
  ...values
});

type MockReconciliationEvent = {
  type: PaperReconciliationEventType;
  symbol: string;
  explanation: string;
};

const reconciliationReport = (
  positions: AlpacaPositionRaw[],
  values: {
    status?: "ok" | "warning" | "blocked";
    missingSymbols?: string[];
    events?: MockReconciliationEvent[];
    marketValueMismatch?: boolean;
    accountMathMismatch?: boolean;
  } = {}
): PaperAccountReconciliationReport => {
  const sum = positions.reduce((total, position) => total + Number(position.market_value || 0), 0);
  const status = values.status || "ok";
  const missingSymbols = values.missingSymbols || [];
  return {
    status,
    reconciliationStatus: status,
    code: status === "blocked" ? "ACCOUNT_RECONCILIATION_MISMATCH" as const : null,
    mutationAttempted: false as const,
    since: "2026-07-07T00:00:00.000Z",
    reconciliationEvents: (values.events || []).map((event) => ({
      type: event.type,
      symbol: event.symbol,
      expectedQuantity: "1",
      recentBuyFillOrderIds: ["buy-1"],
      ageMinutes: 10,
      explanation: event.explanation
    })),
    paperSyncRemovedSymbols: (values.events || [])
      .filter((event) => event.type === "PAPER_SYNC_POSITION_REMOVAL")
      .map((event) => event.symbol),
    paperSyncPendingSymbols: (values.events || [])
      .filter((event) => event.type === "PAPER_POSITION_SYNC_PENDING")
      .map((event) => event.symbol),
    paperSyncRestoredSymbols: (values.events || [])
      .filter((event) => event.type === "PAPER_POSITION_SYNC_RESTORED")
      .map((event) => event.symbol),
    missingSymbols,
    expectedQuantities: Object.fromEntries(missingSymbols.map((symbol) => [symbol, "1"])),
    recentBuyFillOrderIds: missingSymbols.length ? ["buy-1"] : [],
    sellFillsFound: false,
    nonFillAdjustmentActivitiesFound: false,
    accountCash: "100000.00",
    accountEquity: "100000.00",
    accountPositionMarketValue: sum.toFixed(2),
    sumPositionsMarketValue: sum,
    alpacaRequestIds: {
      account: "reconcile-account-id",
      positions: "reconcile-positions-id",
      orders: "reconcile-orders-id",
      activities: "reconcile-activities-id"
    },
    marketValueMismatch: values.marketValueMismatch || false,
    accountMathMismatch: values.accountMathMismatch || false,
    warnings: []
  };
};

const reviewWith = async (
  positions: AlpacaPositionRaw[],
  values: {
    now?: string;
    orders?: AlpacaSubmittedOrder[];
    account?: AlpacaAccountRaw;
    optionSnapshots?: Record<string, AlpacaOptionSnapshotRaw>;
    stockPrices?: (symbols: string[]) => Promise<StockPriceBatchResponse>;
    reconcile?: ReturnType<typeof reconciliationReport>;
    knownLeapsOptionSymbols?: string[] | Set<string>;
    input?: Parameters<typeof buildPaperExitReviewResult>[0];
  } = {}
) => {
  const now = values.now || generatedAt;
  const acct = values.account || account(positions);
  const optionSnapshots = values.optionSnapshots || Object.fromEntries(
    positions
      .filter((position) => position.asset_class === "us_option")
      .map((position) => [String(position.symbol), optionSnapshot(String(position.symbol), 0.50, 0.54, now)])
  );
  return buildPaperExitReviewResult(values.input || {}, {
    now: () => now,
    getMarketClock: async () => ({
      timestamp: now,
      isOpen: true,
      nextClose: "2026-07-07T20:00:00.000Z",
      requestId: "clock-request-id"
    }),
    getAccount: async () => response(acct, "account-request-id"),
    listPaperPositions: async () => response(positions, "positions-request-id"),
    listRecentPaperOrders: async () => response(values.orders || [], "orders-request-id"),
    listPaperAccountActivities: async () => response([], "activities-request-id"),
    getLatestStockSnapshots: async (symbols: string[]) => ({
      data: Object.fromEntries(symbols.map((symbol) => [
        symbol,
        { latestTrade: { p: 100, t: now } }
      ])),
      requestIds: symbols.length ? ["stock-snapshot-request-id"] : [],
      status: 200,
      urls: []
    }),
    ...(values.stockPrices ? { getLatestStockPrices: values.stockPrices } : {}),
    getLatestOptionSnapshots: async () => ({
      data: optionSnapshots,
      requestIds: Object.keys(optionSnapshots).length ? ["option-snapshot-request-id"] : [],
      status: 200,
      urls: []
    }),
    getKnownLeapsOptionSymbols: async () => values.knownLeapsOptionSymbols || [],
    reconcilePaperAccountBeforeExecution: async () => ({
      account: acct,
      positions,
      report: values.reconcile || reconciliationReport(positions)
    })
  });
};

const executionCandidate = (
  values: Partial<PaperExitReviewCandidate> = {}
): PaperExitReviewCandidate => ({
  symbol: "SPY260707C00750000",
  assetClass: "us_option",
  positionClass: "option_0dte",
  qty: "1",
  qtyAvailable: "1",
  avgEntryPrice: 1,
  currentPrice: 0.5,
  marketValue: 50,
  unrealizedPl: -50,
  unrealizedPlpc: -0.5,
  reason: "ODTE_STOP_LOSS_50",
  orderPayload: {
    symbol: "SPY260707C00750000",
    assetClass: "us_option",
    side: "sell",
    positionIntent: "sell_to_close",
    qty: "1",
    orderType: "limit",
    timeInForce: "day",
    reason: "ODTE_STOP_LOSS_50",
    limitPrice: "0.50",
    clientOrderId: "paper-exit-option-SPY260707C00750000-20260707150000-1"
  },
  ...values
});

const reviewResult = (
  values: Partial<PaperExitReviewResult> = {}
): PaperExitReviewResult => ({
  status: "ok",
  environment: "paper",
  mutationAttempted: false,
  generatedAt,
  account: {
    cash: 99950,
    equity: 100000,
    buyingPower: 100000,
    positionMarketValue: 50
  },
  reconciliation: {
    status: "ok",
    sumPositionsMarketValue: 50,
    accountPositionMarketValue: 50,
    events: []
  },
  exitCandidates: [executionCandidate()],
  skipped: [],
  alpacaRequestIds: {
    account: "account-request-id",
    positions: "positions-request-id",
    orders: "orders-request-id",
    activities: "activities-request-id",
    optionSnapshots: "option-snapshot-request-id"
  },
  ...values
});

beforeEach(() => {
  process.env.TRADING_MODE = "paper";
  process.env.ALPACA_ENV = "paper";
  process.env.ALPACA_LIVE_TRADE = "false";
  process.env.LIVE_TRADING_ENABLED = "false";
  process.env.PAPER_ORDER_EXECUTION_ENABLED = "false";
  delete process.env.OPTIONS_QUOTE_MAX_AGE_MS;
});

describe("paper exit review 0DTE options", () => {
  test("0DTE call down more than 50% outside EOD creates sell-to-close", async () => {
    const result = await reviewWith([optionPosition({ unrealized_plpc: "-0.51" })]);
    assert.equal(result.exitCandidates[0]?.reason, "ODTE_STOP_LOSS_50");
    assert.equal(result.exitCandidates[0]?.orderPayload.positionIntent, "sell_to_close");
    assert.equal(result.exitCandidates[0]?.orderPayload.side, "sell");
  });

  test("0DTE put up more than 50% outside EOD creates sell-to-close", async () => {
    const result = await reviewWith([
      optionPosition({
        symbol: "SPY260707P00745000",
        unrealized_pl: "55.00",
        unrealized_plpc: "0.55"
      })
    ]);
    assert.equal(result.exitCandidates[0]?.reason, "ODTE_TAKE_PROFIT_50");
    assert.equal(result.exitCandidates[0]?.symbol, "SPY260707P00745000");
  });

  test("0DTE exits accept Alpaca camelCase option snapshot quotes", async () => {
    const symbol = "SPY260707C00750000";
    const result = await reviewWith([
      optionPosition({ symbol, unrealized_plpc: "-0.51" })
    ], {
      optionSnapshots: {
        [symbol]: {
          symbol,
          latestQuote: {
            t: generatedAt,
            bp: 0.31,
            ap: 0.36
          },
          latestTrade: {
            t: generatedAt,
            p: 0.35
          }
        }
      }
    });
    assert.equal(result.exitCandidates[0]?.reason, "ODTE_STOP_LOSS_50");
    assert.equal(result.exitCandidates[0]?.orderPayload.limitPrice, "0.31");
  });

  test("0DTE call down more than 25% inside last 2 hours creates sell-to-close", async () => {
    const result = await reviewWith([
      optionPosition({ unrealized_plpc: "-0.26" })
    ], { now: eodAt });
    assert.equal(result.exitCandidates[0]?.reason, "ODTE_EOD_STOP_LOSS_25");
  });

  test("0DTE put up more than 25% inside last 2 hours creates sell-to-close", async () => {
    const result = await reviewWith([
      optionPosition({
        symbol: "SPY260707P00745000",
        unrealized_pl: "30.00",
        unrealized_plpc: "0.30"
      })
    ], { now: eodAt });
    assert.equal(result.exitCandidates[0]?.reason, "ODTE_EOD_TAKE_PROFIT_25");
  });

  test("0DTE inside final 30 minutes creates force-exit if value is sellable", async () => {
    const result = await reviewWith([
      optionPosition({ unrealized_plpc: "0.01" })
    ], { now: forceAt });
    assert.equal(result.exitCandidates[0]?.reason, "ODTE_FORCE_EXIT_BEFORE_CLOSE");
  });

  test("0DTE below min sellable value is skipped", async () => {
    const symbol = "SPY260707C00750000";
    const result = await reviewWith([
      optionPosition({ symbol, current_price: "0.01", market_value: "1.00", unrealized_plpc: "-0.99" })
    ], {
      optionSnapshots: {
        [symbol]: optionSnapshot(symbol, 0.01, 0.02)
      }
    });
    assert.equal(result.exitCandidates.length, 0);
    assert.equal(result.skipped[0]?.reason, "ODTE_BELOW_MIN_SELLABLE_VALUE");
  });

  test("LEAPS are skipped by default", async () => {
    const result = await reviewWith([
      optionPosition({ symbol: "SPY270115C00810000", unrealized_plpc: "-0.90" })
    ]);
    assert.equal(result.exitCandidates.length, 0);
    assert.equal(result.skipped[0]?.positionClass, "option_leaps");
    assert.equal(result.skipped[0]?.reason, "LEAPS_SKIPPED_BY_DEFAULT");
  });

  test("LEAPS are not sold by 0DTE rules", async () => {
    const result = await reviewWith([
      optionPosition({ symbol: "SPY270115C00810000", unrealized_plpc: "0.60" })
    ], { input: { includeLEAPS: true } });
    assert.equal(result.exitCandidates.length, 0);
    assert.equal(result.skipped[0]?.reason, "NO_EXIT_RULE_TRIGGERED");
  });

  test("LEAPS stop loss creates sell-to-close when explicitly enabled", async () => {
    const result = await reviewWith([
      optionPosition({ symbol: "SPY270115C00810000", unrealized_plpc: "-0.36" })
    ], { input: { includeLEAPS: true } });
    assert.equal(result.exitCandidates.length, 1);
    assert.equal(result.exitCandidates[0]?.reason, "LEAPS_STOP_LOSS_35");
    assert.equal(result.exitCandidates[0]?.orderPayload.positionIntent, "sell_to_close");
    assert.equal(result.exitCandidates[0]?.orderPayload.orderType, "limit");
  });

  test("LEAPS take profit creates sell-to-close when explicitly enabled", async () => {
    const result = await reviewWith([
      optionPosition({ symbol: "SPY270115C00810000", unrealized_plpc: "0.76" })
    ], { input: { includeLEAPS: true } });
    assert.equal(result.exitCandidates.length, 1);
    assert.equal(result.exitCandidates[0]?.reason, "LEAPS_TAKE_PROFIT_75");
  });

  test("LEAPS DTE decay exit creates sell-to-close for known LEAPS", async () => {
    const symbol = "SPY261001C00810000";
    const result = await reviewWith([
      optionPosition({ symbol, unrealized_plpc: "0.05" })
    ], {
      input: { includeLEAPS: true },
      knownLeapsOptionSymbols: [symbol]
    });
    assert.equal(result.exitCandidates.length, 1);
    assert.equal(result.exitCandidates[0]?.positionClass, "option_leaps");
    assert.equal(result.exitCandidates[0]?.reason, "LEAPS_DTE_DECAY_EXIT");
  });

  test("PostgreSQL authority does not use SQLite-derived LEAPS classification", async () => {
    const symbol = "SPY261001C00810000";
    const result = await withExecutionAuthority(() => reviewWith([
      optionPosition({ symbol, unrealized_plpc: "0.05" })
    ], {
      input: { includeLEAPS: true },
      knownLeapsOptionSymbols: {
        [Symbol.iterator]() {
          throw new Error("SQLite-derived LEAPS evidence must not be read");
        }
      } as unknown as Set<string>
    }));

    assert.equal(result.exitCandidates.length, 0);
    assert.equal(result.skipped[0]?.positionClass, "option_short_dated");
  });

  test("LEAPS below min sellable value is skipped", async () => {
    const symbol = "SPY270115C00810000";
    const result = await reviewWith([
      optionPosition({ symbol, current_price: "0.01", market_value: "1.00", unrealized_plpc: "-0.36" })
    ], {
      input: { includeLEAPS: true },
      optionSnapshots: {
        [symbol]: optionSnapshot(symbol, 0.01, 0.02)
      }
    });
    assert.equal(result.exitCandidates.length, 0);
    assert.equal(result.skipped[0]?.reason, "LEAPS_BELOW_MIN_SELLABLE_VALUE");
  });

  test("LEAPS existing open sell order causes skip", async () => {
    const symbol = "SPY270115C00810000";
    const result = await reviewWith([
      optionPosition({ symbol, unrealized_plpc: "-0.36" })
    ], {
      input: { includeLEAPS: true },
      orders: [order({ symbol, side: "sell", status: "pending_new" })]
    });
    assert.equal(result.exitCandidates.length, 0);
    assert.equal(result.skipped[0]?.reason, "EXIT_ORDER_ALREADY_OPEN");
  });

  test("LEAPS with no quote is skipped", async () => {
    const symbol = "SPY270115C00810000";
    const result = await reviewWith([
      optionPosition({ symbol, unrealized_plpc: "-0.36" })
    ], {
      input: { includeLEAPS: true },
      optionSnapshots: {}
    });
    assert.equal(result.exitCandidates.length, 0);
    assert.equal(result.skipped[0]?.reason, "LEAPS_QUOTE_UNAVAILABLE");
  });

  test("existing open sell order causes skip", async () => {
    const result = await reviewWith([
      optionPosition()
    ], {
      orders: [order({ symbol: "SPY260707C00750000", side: "sell", status: "accepted" })]
    });
    assert.equal(result.exitCandidates.length, 0);
    assert.equal(result.skipped[0]?.reason, "EXIT_ORDER_ALREADY_OPEN");
  });
});

describe("paper exit review equities", () => {
  test("fresh SIP stream price is used for the current equity price", async () => {
    const result = await reviewWith(
      [equityPosition({ unrealized_plpc: "-0.06", current_price: "94.00" })],
      {
        stockPrices: async () => ({
          data: {
            AAPL: {
              symbol: "AAPL",
              price: 101.25,
              timestamp: generatedAt,
              receivedAt: generatedAt,
              feed: "sip",
              source: "alpaca_sip_stream",
              sourceTimestamp: generatedAt
            }
          },
          requestIds: []
        })
      }
    );

    assert.equal(result.exitCandidates[0]?.currentPrice, 101.25);
  });

  test("equity down more than 5% creates sell payload", async () => {
    const result = await reviewWith([equityPosition({ unrealized_plpc: "-0.06" })]);
    assert.equal(result.exitCandidates[0]?.reason, "EQUITY_STOP_LOSS_5");
    assert.equal(result.exitCandidates[0]?.orderPayload.orderType, "market");
  });

  test("equity up more than 8% creates sell payload", async () => {
    const result = await reviewWith([
      equityPosition({ unrealized_pl: "90.00", unrealized_plpc: "0.09", current_price: "109.00", market_value: "1090.00" })
    ]);
    assert.equal(result.exitCandidates[0]?.reason, "EQUITY_TAKE_PROFIT_8");
  });

  test("equity within thresholds is skipped", async () => {
    const result = await reviewWith([
      equityPosition({ unrealized_pl: "10.00", unrealized_plpc: "0.01" })
    ]);
    assert.equal(result.exitCandidates.length, 0);
    assert.equal(result.skipped[0]?.reason, "NO_EXIT_RULE_TRIGGERED");
  });

  test("fractional quantity uses qty_available", async () => {
    const result = await reviewWith([
      equityPosition({ qty: "1.234567", qty_available: "0.234567", unrealized_plpc: "-0.07" })
    ]);
    assert.equal(result.exitCandidates[0]?.qtyAvailable, "0.234567");
    assert.equal(result.exitCandidates[0]?.orderPayload.qty, "0.234567");
  });

  test("equity with existing open sell order is skipped", async () => {
    const result = await reviewWith([
      equityPosition({ symbol: "AAPL" })
    ], {
      orders: [order({ symbol: "AAPL", side: "sell", status: "pending_new" })]
    });
    assert.equal(result.exitCandidates.length, 0);
    assert.equal(result.skipped[0]?.reason, "EXIT_ORDER_ALREADY_OPEN");
  });
});

describe("paper exit reconciliation", () => {
  test("matching account and positions passes", async () => {
    const result = await reviewWith([equityPosition({ unrealized_plpc: "-0.06" })]);
    assert.equal(result.reconciliation.status, "ok");
    assert.equal(result.status, "ok");
    assert.equal(result.exitCandidates.length, 1);
  });

  test("account position market value mismatch blocks", async () => {
    const positions = [equityPosition({ unrealized_plpc: "-0.06" })];
    const result = await reviewWith(positions, {
      reconcile: reconciliationReport(positions, {
        status: "blocked",
        marketValueMismatch: true
      })
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.blockReason, "ACCOUNT_RECONCILIATION_MISMATCH");
    assert.equal(result.exitCandidates.length, 0);
  });

  test("missing local-only paper position returns sync pending and no sell payload", async () => {
    const result = await reviewWith([], {
      reconcile: reconciliationReport([], {
        status: "warning",
        missingSymbols: ["HRB"],
        events: [{
          type: "PAPER_POSITION_SYNC_PENDING",
          symbol: "HRB",
          explanation: "Pending paper sync."
        }]
      })
    });
    assert.equal(result.exitCandidates.length, 0);
    assert.equal(result.skipped[0]?.symbol, "HRB");
    assert.equal(result.skipped[0]?.reason, "PAPER_POSITION_SYNC_PENDING");
  });

  test("reappeared paper position returns sync restored event", async () => {
    const positions = [equityPosition({ symbol: "HRB", unrealized_plpc: "-0.06" })];
    const result = await reviewWith(positions, {
      reconcile: reconciliationReport(positions, {
        status: "warning",
        events: [{
          type: "PAPER_POSITION_SYNC_RESTORED",
          symbol: "HRB",
          explanation: "Restored paper sync."
        }]
      })
    });
    assert.equal(result.reconciliation.events[0]?.code, "PAPER_POSITION_SYNC_RESTORED");
    assert.equal(result.exitCandidates[0]?.symbol, "HRB");
  });

  test("paper sync position removal is classified without a synthetic sell", async () => {
    const result = await reviewWith([], {
      reconcile: reconciliationReport([], {
        status: "warning",
        missingSymbols: ["HRB"],
        events: [{
          type: "PAPER_SYNC_POSITION_REMOVAL",
          symbol: "HRB",
          explanation: "Trusted removed paper sync position."
        }]
      })
    });
    assert.equal(result.exitCandidates.length, 0);
    assert.equal(result.skipped[0]?.reason, "PAPER_SYNC_POSITION_REMOVAL");
  });

  test("live missing position hard fails before review fetch", async () => {
    process.env.ALPACA_ENV = "live";
    const result = await buildPaperExitReviewResult({}, { now: () => generatedAt });
    assert.equal(result.status, "blocked");
    assert.equal(result.blockReason, "LIVE_TRADING_BLOCKED");
  });
});

describe("paper exit execution guardrails", () => {
  test("execution without confirmPaper blocks after review", async () => {
    let reviewCalled = false;
    const result = await buildPaperExitExecutionResult({}, {
      buildReview: async () => {
        reviewCalled = true;
        return reviewResult();
      }
    });
    assert.equal(reviewCalled, true);
    assert.equal(result.status, "blocked");
    assert.equal(result.blockedReason, "CONFIRM_PAPER_REQUIRED");
    assert.equal(result.mutationAttempted, false);
  });

  test("live environment blocks execution", async () => {
    process.env.ALPACA_ENV = "live";
    const result = await buildPaperExitExecutionResult({ confirmPaper: true }, {
      buildReview: async () => reviewResult()
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.blockedReason, "LIVE_TRADING_BLOCKED");
  });

  test("review command never mutates", async () => {
    const result = await reviewWith([optionPosition({ unrealized_plpc: "-0.51" })]);
    assert.equal(result.mutationAttempted, false);
    assert.equal(result.exitCandidates.length, 1);
  });

  test("execution only submits candidates from review", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    const submitted: AlpacaPaperOrderRequest[] = [];
    const result = await buildPaperExitExecutionResult({ confirmPaper: true }, {
      buildReview: async () => reviewResult({
        skipped: [{
          symbol: "AAPL",
          assetClass: "us_equity",
          positionClass: "equity",
          reason: "NO_EXIT_RULE_TRIGGERED"
        }]
      }),
      submitPaperOrder: async (payload) => {
        submitted.push(payload);
        return response({
          id: "exit-order-1",
          client_order_id: payload.client_order_id,
          status: "accepted"
        }, "submit-request-id");
      }
    });
    assert.equal(result.status, "ok");
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0]?.symbol, "SPY260707C00750000");
    assert.equal(submitted[0]?.position_intent, "sell_to_close");
  });

  test("execution never sells LEAPS unless includeLEAPS is explicit", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    let submitCalls = 0;
    const result = await buildPaperExitExecutionResult({ confirmPaper: true }, {
      buildReview: async () => reviewResult({
        exitCandidates: [executionCandidate({
          symbol: "SPY270115C00810000",
          positionClass: "option_leaps",
          orderPayload: {
            ...executionCandidate().orderPayload,
            symbol: "SPY270115C00810000",
            clientOrderId: "paper-exit-option-SPY270115C00810000-20260707150000-1"
          }
        })]
      }),
      submitPaperOrder: async (payload) => {
        submitCalls += 1;
        return response({ id: "should-not-submit", status: "accepted", client_order_id: payload.client_order_id }, "submit-request-id");
      }
    });
    assert.equal(submitCalls, 0);
    assert.equal(result.status, "error");
    assert.equal(result.errors?.[0]?.reason, "LEAPS_SKIPPED_BY_DEFAULT");
  });

  test("execution submits LEAPS candidates when includeLEAPS is explicit", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    const submitted: AlpacaPaperOrderRequest[] = [];
    const result = await buildPaperExitExecutionResult({ confirmPaper: true, includeLEAPS: true }, {
      buildReview: async () => reviewResult({
        exitCandidates: [executionCandidate({
          symbol: "SPY270115C00810000",
          positionClass: "option_leaps",
          reason: "LEAPS_STOP_LOSS_35",
          orderPayload: {
            ...executionCandidate().orderPayload,
            symbol: "SPY270115C00810000",
            reason: "LEAPS_STOP_LOSS_35",
            clientOrderId: "paper-exit-option-SPY270115C00810000-20260707150000-1"
          }
        })]
      }),
      submitPaperOrder: async (payload) => {
        submitted.push(payload);
        return response({
          id: "leaps-exit-order-1",
          client_order_id: payload.client_order_id,
          status: "accepted"
        }, "submit-request-id");
      }
    });
    assert.equal(result.status, "ok");
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0]?.symbol, "SPY270115C00810000");
    assert.equal(submitted[0]?.position_intent, "sell_to_close");
  });

  test("Alpaca request IDs are surfaced", async () => {
    process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
    const result = await buildPaperExitExecutionResult({ confirmPaper: true }, {
      buildReview: async () => reviewResult(),
      submitPaperOrder: async (payload) => response({
        id: "exit-order-1",
        client_order_id: payload.client_order_id,
        status: "accepted"
      }, "exit-submit-request-id")
    });
    assert.equal(result.review.alpacaRequestIds.account, "account-request-id");
    assert.equal(result.submittedOrders[0]?.alpacaRequestId, "exit-submit-request-id");
  });
});
