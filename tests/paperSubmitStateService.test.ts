import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  capturePaperSubmitState,
  loadPaperSubmitSafetyConfig,
  validatePaperSubmitState,
  type PaperSubmitStateAttestation
} from "../src/services/paperSubmitStateService.js";

const capturedAt = "2026-07-14T14:00:00.000Z";

const paperEnv = {
  ALPACA_ENV: "paper",
  TRADING_MODE: "paper",
  ALPACA_LIVE_TRADE: "false",
  LIVE_TRADING_ENABLED: "false",
  PAPER_ORDER_EXECUTION_ENABLED: "true",
  PAPER_OPTIONS_EXECUTION_ENABLED: "true"
} as const;

const withPaperEnv = async <T>(callback: () => Promise<T>): Promise<T> => {
  const previous = Object.fromEntries(
    Object.keys(paperEnv).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, paperEnv);
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const state = (
  overrides: Partial<PaperSubmitStateAttestation> = {}
): PaperSubmitStateAttestation => ({
  version: "paper-submit-state-v1",
  capturedAt,
  accountIdentityHash: "account-identity-1",
  accountState: {
    status: "ACTIVE",
    cash: 100_000,
    equity: 100_000,
    buyingPower: 100_000,
    optionsBuyingPower: 100_000,
    optionsApprovalLevel: 3,
    tradingBlocked: false,
    accountBlocked: false
  },
  configuration: {
    environment: "paper",
    tradingMode: "paper",
    liveTradingEnabled: false,
    paperOrderExecutionEnabled: true,
    paperOptionsExecutionEnabled: true,
    maxPositionNotional: 5_000,
    maxTotalPlanNotional: 50_000,
    equityMaxNotionalPerOrder: 5_000,
    equityMaxPortfolioDeployPct: 50,
    equityMaxPositionPct: 10,
    equityMinCashReservePct: 20,
    optionMaxOrderNotional: 2_000,
    optionMaxContracts: 1,
    optionMaxPortfolioRiskPct: 20,
    optionMaxPositionRiskPct: 5,
    quoteMaxAgeSeconds: 60,
    maxPriceDriftPct: 10
  },
  configurationFingerprint: "config-1",
  positions: [],
  openOrders: [],
  reservations: [],
  marketEvidence: [
    {
      symbol: "AAPL",
      assetClass: "equity",
      referencePrice: 200,
      bid: 199.9,
      ask: 200.1,
      timestamp: capturedAt,
      complete: true
    }
  ],
  payloadIntents: [
    {
      section: "equityBuys",
      payloadIndex: 0,
      assetClass: "equity",
      symbol: "AAPL",
      side: "buy",
      orderType: "market",
      quantity: null,
      notional: 100,
      limitPrice: null,
      estimatedPremium: null,
      positionIntent: null,
      sourceCandidateId: "candidate-aapl",
      sourceReviewId: null,
      clientOrderIdHash: "client-order-aapl"
    }
  ],
  structuralPortfolioFingerprint: "structure-1",
  portfolioFingerprint: "portfolio-1",
  marketEvidenceFingerprint: "market-1",
  allocationAttestation: {
    mode: "baseline",
    identity: "baseline-v1",
    allocatorControlled: false
  },
  complete: true,
  blockers: [],
  warnings: [],
  ...overrides
});

describe("paper submit state validation", () => {
  test("does not apply positive new-risk state checks when no entry section is selected", () => {
    const empty = state({
      accountIdentityHash: null,
      accountState: {
        status: null,
        cash: null,
        equity: null,
        buyingPower: null,
        optionsBuyingPower: null,
        optionsApprovalLevel: null,
        tradingBlocked: null,
        accountBlocked: null
      },
      payloadIntents: [],
      complete: true
    });

    const result = validatePaperSubmitState({
      reviewed: empty,
      current: empty,
      sections: ["equitySells"]
    });

    assert.equal(result.valid, true);
    assert.deepEqual(result.blockers, []);
  });

  test("accepts unchanged complete state under current caps", () => {
    const reviewed = state();
    const current = state({ capturedAt: "2026-07-14T14:00:20.000Z" });

    const result = validatePaperSubmitState({
      reviewed,
      current,
      sections: ["equityBuys"]
    });

    assert.equal(result.valid, true);
    assert.deepEqual(result.blockers, []);
  });

  test("requires a fresh review for configuration, allocation, or structural drift", () => {
    const reviewed = state();
    const configDrift = validatePaperSubmitState({
      reviewed,
      current: state({ configurationFingerprint: "config-2" }),
      sections: ["equityBuys"]
    });
    const allocationDrift = validatePaperSubmitState({
      reviewed,
      current: state({
        allocationAttestation: {
          mode: "baseline",
          identity: "baseline-v2" as "baseline-v1",
          allocatorControlled: false
        }
      }),
      sections: ["equityBuys"]
    });
    const portfolioDrift = validatePaperSubmitState({
      reviewed,
      current: state({ structuralPortfolioFingerprint: "structure-2" }),
      sections: ["equityBuys"]
    });

    assert.ok(configDrift.blockers.includes("SUBMIT_CONFIGURATION_DRIFT"));
    assert.ok(allocationDrift.blockers.includes("SUBMIT_ALLOCATION_IDENTITY_DRIFT"));
    assert.ok(portfolioDrift.blockers.includes("SUBMIT_PORTFOLIO_STATE_DRIFT"));
    assert.ok(configDrift.blockers.includes("FRESH_REVIEW_REQUIRED"));
  });

  test("rejects account identity drift", () => {
    const result = validatePaperSubmitState({
      reviewed: state(),
      current: state({ accountIdentityHash: "different-paper-account" }),
      sections: ["equityBuys"]
    });

    assert.ok(result.blockers.includes("SUBMIT_ACCOUNT_STATE_DRIFT"));
    assert.ok(result.blockers.includes("FRESH_REVIEW_REQUIRED"));
  });

  test("blocks material price drift without changing the reviewed intent", () => {
    const current = state({
      marketEvidenceFingerprint: "market-2",
      marketEvidence: [
        {
          symbol: "AAPL",
          assetClass: "equity",
          referencePrice: 225,
          bid: 224.9,
          ask: 225.1,
          timestamp: "2026-07-14T14:00:20.000Z",
          complete: true
        }
      ]
    });

    const result = validatePaperSubmitState({
      reviewed: state(),
      current,
      sections: ["equityBuys"]
    });

    assert.ok(result.blockers.includes("SUBMIT_PRICE_DRIFT"));
    assert.ok(result.blockers.includes("FRESH_REVIEW_REQUIRED"));
    assert.equal(current.payloadIntents[0]?.notional, 100);
  });

  test("fails closed on missing material state or cap evidence", () => {
    const result = validatePaperSubmitState({
      reviewed: state(),
      current: state({
        complete: false,
        blockers: ["SUBMIT_ACCOUNT_EVIDENCE_UNAVAILABLE"],
        accountState: {
          ...state().accountState,
          cash: null
        }
      }),
      sections: ["equityBuys"]
    });

    assert.ok(result.blockers.includes("SUBMIT_CAP_EVIDENCE_INCOMPLETE"));
    assert.ok(result.blockers.includes("FRESH_REVIEW_REQUIRED"));
  });

  test("fails closed on missing current position quantity or value", () => {
    const current = state({
      positions: [
        {
          symbol: "MSFT",
          assetClass: "equity",
          quantity: null,
          marketValue: null,
          currentPrice: null
        }
      ]
    });
    const result = validatePaperSubmitState({
      reviewed: state(),
      current,
      sections: ["equityBuys"]
    });

    assert.ok(result.blockers.includes("SUBMIT_CAP_EVIDENCE_INCOMPLETE"));
  });

  test("rejects stale current market evidence", () => {
    const result = validatePaperSubmitState({
      reviewed: state(),
      current: state({
        capturedAt: "2026-07-14T14:02:00.000Z",
        marketEvidence: [
          {
            ...state().marketEvidence[0]!,
            timestamp: capturedAt
          }
        ]
      }),
      sections: ["equityBuys"]
    });

    assert.ok(result.blockers.includes("SUBMIT_MARKET_EVIDENCE_STALE"));
  });

  test("enforces cash reserve, buying power, and portfolio deployment caps", () => {
    const current = state({
      accountState: {
        ...state().accountState,
        cash: 20_050,
        buyingPower: 50,
        equity: 100_000
      },
      positions: [
        {
          symbol: "MSFT",
          assetClass: "equity",
          quantity: 10,
          marketValue: 49_950,
          currentPrice: 4_995
        }
      ],
      payloadIntents: [
        {
          ...state().payloadIntents[0]!,
          notional: 100
        }
      ]
    });

    const result = validatePaperSubmitState({
      reviewed: state(),
      current,
      sections: ["equityBuys"]
    });

    assert.ok(result.blockers.includes("SUBMIT_CASH_RESERVE_EXCEEDED"));
    assert.ok(result.blockers.includes("SUBMIT_BUYING_POWER_EXCEEDED"));
    assert.ok(result.blockers.includes("SUBMIT_PORTFOLIO_DEPLOYMENT_CAP_EXCEEDED"));
  });

  test("blocks same-symbol open orders and active reservations", () => {
    const current = state({
      openOrders: [
        {
          symbol: "AAPL",
          assetClass: "equity",
          side: "buy",
          status: "accepted",
          quantity: null,
          notional: 100,
          limitPrice: null,
          clientOrderIdHash: "existing-order"
        }
      ],
      reservations: [
        {
          symbol: "AAPL",
          assetClass: "equity",
          side: "buy",
          status: "reserved",
          quantity: null,
          notional: 100,
          estimatedPremium: null,
          limitPrice: null,
          clientOrderIdHash: "existing-reservation"
        }
      ]
    });

    const result = validatePaperSubmitState({
      reviewed: state(),
      current,
      sections: ["equityBuys"]
    });

    assert.ok(result.blockers.includes("SUBMIT_DUPLICATE_ORDER_OR_RESERVATION"));
  });

  test("counts other open buy orders against deployable capital", () => {
    const current = state({
      accountState: {
        ...state().accountState,
        cash: 250,
        equity: 1_000,
        buyingPower: 250
      },
      openOrders: [
        {
          symbol: "MSFT",
          assetClass: "equity",
          side: "buy",
          status: "accepted",
          quantity: null,
          notional: 200,
          limitPrice: null,
          clientOrderIdHash: "existing-msft-order"
        }
      ]
    });
    const result = validatePaperSubmitState({
      reviewed: state(),
      current,
      sections: ["equityBuys"]
    });

    assert.ok(result.blockers.includes("SUBMIT_BUYING_POWER_EXCEEDED"));
    assert.ok(result.blockers.includes("SUBMIT_CASH_RESERVE_EXCEEDED"));
  });

  test("enforces total-plan and option premium caps without resizing", () => {
    const totalPlan = state({
      configuration: {
        ...state().configuration,
        maxTotalPlanNotional: 50
      }
    });
    const totalPlanResult = validatePaperSubmitState({
      reviewed: totalPlan,
      current: totalPlan,
      sections: ["equityBuys"]
    });

    const option = state({
      configuration: {
        ...state().configuration,
        optionMaxOrderNotional: 2_000
      },
      marketEvidence: [
        {
          symbol: "SPY260714C00600000",
          assetClass: "option",
          referencePrice: 30,
          bid: 29.9,
          ask: 30.1,
          timestamp: capturedAt,
          complete: true
        }
      ],
      payloadIntents: [
        {
          section: "optionBuys",
          payloadIndex: 0,
          assetClass: "option",
          symbol: "SPY260714C00600000",
          side: "buy",
          orderType: "limit",
          quantity: 1,
          notional: null,
          limitPrice: 30,
          estimatedPremium: 3_000,
          positionIntent: "buy_to_open",
          sourceCandidateId: "discovery:zero_dte_spy:SPY260714C00600000",
          sourceReviewId: null,
          clientOrderIdHash: "option-client-order"
        }
      ]
    });
    const optionResult = validatePaperSubmitState({
      reviewed: option,
      current: option,
      sections: ["optionBuys"]
    });

    assert.ok(totalPlanResult.blockers.includes("SUBMIT_TOTAL_PLAN_CAP_EXCEEDED"));
    assert.ok(optionResult.blockers.includes("SUBMIT_OPTION_PREMIUM_CAP_EXCEEDED"));
    assert.equal(option.payloadIntents[0]?.quantity, 1);
    assert.equal(option.payloadIntents[0]?.limitPrice, 30);
  });

  test("normalizes the existing baseline caps without an allocator mode", () => {
    const config = loadPaperSubmitSafetyConfig({
      ALPACA_ENV: "paper",
      TRADING_MODE: "paper",
      ALPACA_LIVE_TRADE: "false",
      LIVE_TRADING_ENABLED: "false",
      PAPER_ORDER_EXECUTION_ENABLED: "true",
      PAPER_OPTIONS_EXECUTION_ENABLED: "true"
    });

    assert.equal(config.maxPositionNotional, 5_000);
    assert.equal(config.maxTotalPlanNotional, 50_000);
    assert.equal(config.equityMaxNotionalPerOrder, 5_000);
    assert.equal(config.equityMaxPortfolioDeployPct, 50);
    assert.equal(config.equityMaxPositionPct, 10);
    assert.equal(config.equityMinCashReservePct, 20);
    assert.equal(config.allocationIdentity, "baseline-v1");
  });

  test("captures complete fresh account, portfolio, reservation, source, and market evidence", async () => {
    const captured = await withPaperEnv(() =>
      capturePaperSubmitState(
        {
          capturedAt,
          payloadSections: {
            equityBuys: [
              {
                assetClass: "equity",
                symbol: "AAPL",
                side: "buy",
                type: "market",
                time_in_force: "day",
                notional: "100.00",
                sourceCandidateId: "candidate-aapl",
                client_order_id: "paper-entry-aapl"
              }
            ],
            equityAdds: [],
            equitySells: [],
            optionBuys: [],
            optionSellToCloseExits: []
          }
        },
        {
          getAccount: async () => ({
            data: {
              id: "paper-account-123",
              status: "ACTIVE",
              cash: "100000",
              equity: "100000",
              buying_power: "100000",
              options_buying_power: "100000",
              options_approved_level: 3,
              trading_blocked: false,
              account_blocked: false
            },
            status: 200,
            url: "https://paper-api.alpaca.markets/v2/account"
          }),
          listPositions: async () => ({
            data: [],
            status: 200,
            url: "https://paper-api.alpaca.markets/v2/positions"
          }),
          listOrders: async () => ({
            data: [],
            status: 200,
            url: "https://paper-api.alpaca.markets/v2/orders"
          }),
          listReservations: () => [],
          getMarketEvidence: async () => [
            {
              symbol: "AAPL",
              assetClass: "equity",
              referencePrice: 200,
              bid: 199.9,
              ask: 200.1,
              timestamp: capturedAt,
              complete: true
            }
          ],
          resolveSourceCandidate: (id) =>
            id === "candidate-aapl"
              ? { id, symbol: "AAPL", optionSymbol: null }
              : null
        }
      )
    );

    assert.equal(captured.complete, true);
    assert.deepEqual(captured.blockers, []);
    assert.notEqual(captured.accountIdentityHash, "paper-account-123");
    assert.notEqual(captured.payloadIntents[0]?.clientOrderIdHash, "paper-entry-aapl");
    assert.equal(captured.payloadIntents[0]?.sourceCandidateId, "candidate-aapl");
    assert.deepEqual(captured.allocationAttestation, {
      mode: "baseline",
      identity: "baseline-v1",
      allocatorControlled: false
    });
  });

  test("retains held and pending-cancel broker orders as active cap evidence", async () => {
    const captured = await withPaperEnv(() =>
      capturePaperSubmitState(
        {
          capturedAt,
          payloadSections: {
            equityBuys: [
              {
                assetClass: "equity",
                symbol: "AAPL",
                side: "buy",
                type: "market",
                time_in_force: "day",
                notional: "100.00",
                sourceCandidateId: "candidate-aapl",
                client_order_id: "paper-entry-aapl"
              }
            ],
            equityAdds: [],
            equitySells: [],
            optionBuys: [],
            optionSellToCloseExits: []
          }
        },
        {
          getAccount: async () => ({
            data: {
              id: "paper-account-123",
              status: "ACTIVE",
              cash: "100000",
              equity: "100000",
              buying_power: "100000",
              options_buying_power: "100000",
              options_approved_level: 3,
              trading_blocked: false,
              account_blocked: false
            },
            status: 200,
            url: "account"
          }),
          listPositions: async () => ({ data: [], status: 200, url: "positions" }),
          listOrders: async () => ({
            data: [
              {
                id: "held-order",
                symbol: "MSFT",
                asset_class: "us_equity",
                side: "buy",
                status: "held",
                notional: "100",
                client_order_id: "held-client"
              },
              {
                id: "pending-cancel-order",
                symbol: "NVDA",
                asset_class: "us_equity",
                side: "buy",
                status: "pending_cancel",
                notional: "100",
                client_order_id: "pending-cancel-client"
              }
            ],
            status: 200,
            url: "orders"
          }),
          listReservations: () => [],
          getMarketEvidence: async () => [
            {
              symbol: "AAPL",
              assetClass: "equity",
              referencePrice: 200,
              bid: 199.9,
              ask: 200.1,
              timestamp: capturedAt,
              complete: true
            }
          ],
          resolveSourceCandidate: (id) => ({
            id,
            symbol: "AAPL",
            optionSymbol: null
          })
        }
      )
    );

    assert.equal(captured.complete, true);
    assert.deepEqual(
      captured.openOrders.map((order) => order.status).sort(),
      ["held", "pending_cancel"]
    );
  });

  test("fails closed but retains an unrecognized open broker order status", async () => {
    const captured = await withPaperEnv(() =>
      capturePaperSubmitState(
        {
          capturedAt,
          payloadSections: {
            equityBuys: [{
              assetClass: "equity",
              symbol: "AAPL",
              side: "buy",
              type: "market",
              notional: "100",
              sourceCandidateId: "candidate-aapl",
              client_order_id: "paper-entry-aapl"
            }],
            equityAdds: [],
            equitySells: [],
            optionBuys: [],
            optionSellToCloseExits: []
          }
        },
        {
          getAccount: async () => ({
            data: {
              id: "paper-account-123",
              status: "ACTIVE",
              cash: "100000",
              equity: "100000",
              buying_power: "100000",
              options_buying_power: "100000",
              options_approved_level: 3,
              trading_blocked: false,
              account_blocked: false
            },
            status: 200,
            url: "account"
          }),
          listPositions: async () => ({ data: [], status: 200, url: "positions" }),
          listOrders: async () => ({
            data: [{
              id: "unknown-order",
              symbol: "MSFT",
              asset_class: "us_equity",
              side: "buy",
              status: "broker_future_state",
              notional: "100",
              client_order_id: "unknown-client"
            }],
            status: 200,
            url: "orders"
          }),
          listReservations: () => [],
          getMarketEvidence: async () => [{
            symbol: "AAPL",
            assetClass: "equity",
            referencePrice: 200,
            bid: 199.9,
            ask: 200.1,
            timestamp: capturedAt,
            complete: true
          }],
          resolveSourceCandidate: (id) => ({ id, symbol: "AAPL", optionSymbol: null })
        }
      )
    );

    assert.equal(captured.complete, false);
    assert.equal(captured.openOrders[0]?.status, "broker_future_state");
    assert.ok(captured.blockers.includes("SUBMIT_ORDER_STATUS_UNRECOGNIZED"));
  });

  test("captures authoritative cross-path 0DTE activity evidence", async () => {
    const symbol = "SPY260714C00600000";
    const captured = await withPaperEnv(() =>
      capturePaperSubmitState(
        {
          capturedAt,
          payloadSections: {
            equityBuys: [],
            equityAdds: [],
            equitySells: [],
            optionBuys: [{
              assetClass: "option",
              symbol,
              side: "buy",
              type: "limit",
              qty: "1",
              limit_price: "1",
              estimatedPremium: 100,
              position_intent: "buy_to_open",
              sourceCandidateId: `discovery:zero_dte_spy:${symbol}`,
              client_order_id: "zero-dte-reviewed-entry"
            }],
            optionSellToCloseExits: []
          }
        },
        {
          getAccount: async () => ({
            data: {
              id: "paper-account-123",
              status: "ACTIVE",
              cash: "100000",
              equity: "100000",
              buying_power: "100000",
              options_buying_power: "100000",
              options_approved_level: 3,
              trading_blocked: false,
              account_blocked: false
            },
            status: 200,
            url: "account"
          }),
          listPositions: async () => ({ data: [], status: 200, url: "positions" }),
          listOrders: async () => ({ data: [], status: 200, url: "orders" }),
          listReservations: () => [],
          getMarketEvidence: async () => [{
            symbol,
            assetClass: "option",
            referencePrice: 1,
            bid: 0.95,
            ask: 1.05,
            timestamp: capturedAt,
            complete: true
          }],
          resolveSourceCandidate: (id) => ({ id, symbol: "SPY", optionSymbol: symbol }),
          buildZeroDteActivityEvidence: (input) => ({
            tradingDate: input.tradingDate,
            asOf: input.asOf,
            complete: true,
            dailyTradeCount: 1,
            dailyPremium: 125,
            dailyRealizedLoss: 0,
            openPositionCount: 0,
            openOrderCount: 1,
            openExposureCount: 1,
            blockers: [],
            warnings: [],
            evidenceFingerprint: "activity-fingerprint"
          })
        }
      )
    );

    assert.equal(captured.complete, true);
    assert.equal(captured.zeroDteActivityEvidence?.dailyTradeCount, 1);
    assert.equal(captured.zeroDteActivityEvidence?.openExposureCount, 1);
  });

  test("fails closed when current market evidence is missing", async () => {
    const captured = await withPaperEnv(() =>
      capturePaperSubmitState(
        {
          capturedAt,
          payloadSections: {
            equityBuys: [
              {
                assetClass: "equity",
                symbol: "AAPL",
                side: "buy",
                type: "market",
                time_in_force: "day",
                notional: "100.00",
                sourceCandidateId: "candidate-aapl",
                client_order_id: "paper-entry-aapl"
              }
            ],
            equityAdds: [],
            equitySells: [],
            optionBuys: [],
            optionSellToCloseExits: []
          }
        },
        {
          getAccount: async () => ({
            data: {
              id: "paper-account-123",
              status: "ACTIVE",
              cash: "100000",
              equity: "100000",
              buying_power: "100000",
              options_buying_power: "100000",
              options_approved_level: 3,
              trading_blocked: false,
              account_blocked: false
            },
            status: 200,
            url: "https://paper-api.alpaca.markets/v2/account"
          }),
          listPositions: async () => ({ data: [], status: 200, url: "positions" }),
          listOrders: async () => ({ data: [], status: 200, url: "orders" }),
          listReservations: () => [],
          getMarketEvidence: async () => [],
          resolveSourceCandidate: (id) => ({ id, symbol: "AAPL", optionSymbol: null })
        }
      )
    );

    assert.equal(captured.complete, false);
    assert.ok(captured.blockers.includes("SUBMIT_MARKET_EVIDENCE_UNAVAILABLE"));
  });

  test("fails closed when the source candidate identity does not match the symbol", async () => {
    const captured = await withPaperEnv(() =>
      capturePaperSubmitState(
        {
          capturedAt,
          payloadSections: {
            equityBuys: [
              {
                assetClass: "equity",
                symbol: "AAPL",
                side: "buy",
                type: "market",
                time_in_force: "day",
                notional: "100.00",
                sourceCandidateId: "candidate-aapl",
                client_order_id: "paper-entry-aapl"
              }
            ],
            equityAdds: [],
            equitySells: [],
            optionBuys: [],
            optionSellToCloseExits: []
          }
        },
        {
          getAccount: async () => ({
            data: {
              id: "paper-account-123",
              status: "ACTIVE",
              cash: "100000",
              equity: "100000",
              buying_power: "100000",
              options_buying_power: "100000",
              options_approved_level: 3,
              trading_blocked: false,
              account_blocked: false
            },
            status: 200,
            url: "account"
          }),
          listPositions: async () => ({ data: [], status: 200, url: "positions" }),
          listOrders: async () => ({ data: [], status: 200, url: "orders" }),
          listReservations: () => [],
          getMarketEvidence: async () => [
            {
              symbol: "AAPL",
              assetClass: "equity",
              referencePrice: 200,
              bid: 199.9,
              ask: 200.1,
              timestamp: capturedAt,
              complete: true
            }
          ],
          resolveSourceCandidate: (id) => ({
            id,
            symbol: "MSFT",
            optionSymbol: null
          })
        }
      )
    );

    assert.equal(captured.complete, false);
    assert.ok(captured.blockers.includes("REVIEW_ENTRY_SOURCE_IDENTITY_MISMATCH"));
  });
});
