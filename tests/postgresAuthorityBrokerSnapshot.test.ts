import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStructuralPortfolioFingerprint,
  capturePostgresAuthorityBrokerSnapshot,
  type AuthorityBrokerOrder,
  type AuthorityBrokerPosition
} from "../src/services/postgresAuthorityBrokerSnapshot.js";

const account = {
  status: "ACTIVE",
  currency: "USD",
  cash: 10_000,
  equity: 20_000,
  buyingPower: 30_000,
  optionsBuyingPower: 15_000,
  optionsApprovalLevel: 3,
  tradingBlocked: false,
  accountBlocked: false
};

const position: AuthorityBrokerPosition = {
  brokerPositionKey: "equity:AAPL",
  symbol: "AAPL",
  underlyingSymbol: null,
  optionSymbol: null,
  assetClass: "equity",
  side: "long",
  quantity: 1,
  availableQuantity: 1,
  averageEntryPrice: 200,
  currentPrice: 201,
  marketValue: 201,
  costBasis: 200,
  unrealizedPnl: 1
};

const orders: AuthorityBrokerOrder[] = [];

test("structural authorization identity ignores quote-driven valuation drift", () => {
  const original = buildStructuralPortfolioFingerprint(
    "account-identity",
    account,
    [position],
    orders
  );
  const drifted = buildStructuralPortfolioFingerprint(
    "account-identity",
    {
      ...account,
      equity: 20_500,
      buyingPower: 30_500,
      optionsBuyingPower: 15_500
    },
    [{
      ...position,
      currentPrice: 206,
      marketValue: 206,
      unrealizedPnl: 6
    }],
    orders
  );

  assert.equal(original, drifted);
});

test("structural authorization identity changes for cash, position, or order mutations", () => {
  const original = buildStructuralPortfolioFingerprint(
    "account-identity",
    account,
    [position],
    orders
  );
  const cashChanged = buildStructuralPortfolioFingerprint(
    "account-identity",
    { ...account, cash: 9_000 },
    [position],
    orders
  );
  const positionChanged = buildStructuralPortfolioFingerprint(
    "account-identity",
    account,
    [{ ...position, quantity: 2, availableQuantity: 2 }],
    orders
  );
  const orderChanged = buildStructuralPortfolioFingerprint(
    "account-identity",
    account,
    [position],
    [{
      brokerOrderId: "broker-order-1",
      clientOrderId: "client-order-1",
      symbol: "AAPL",
      assetClass: "equity",
      side: "buy",
      orderType: "limit",
      timeInForce: "day",
      status: "accepted",
      quantity: 1,
      notional: null,
      limitPrice: 199
    }]
  );

  assert.notEqual(original, cashChanged);
  assert.notEqual(original, positionChanged);
  assert.notEqual(original, orderChanged);
});

test("authenticated capture records account identity, endpoint request IDs, open orders, and bounded recent orders", async () => {
  let recentInput: number | { limit?: number; after?: string } | undefined;
  const snapshot = await capturePostgresAuthorityBrokerSnapshot(
    "2026-08-05T14:00:00.000Z",
    {
      getAccount: async () => ({
        id: "paper-account-1",
        status: "ACTIVE",
        currency: "USD",
        cash: "10000",
        equity: "20000",
        buyingPower: "30000",
        optionsBuyingPower: "15000",
        optionsApprovedLevel: 3,
        tradingBlocked: false,
        accountBlocked: false,
        requestId: "request-account"
      }),
      listPositions: async () => ({
        requestId: "request-positions",
        positions: [{
          symbol: "AAPL270115C00200000",
          assetClass: "us_option",
          qty: "2",
          qtyAvailable: "2",
          averageEntryPrice: "7",
          currentPrice: "8",
          marketValue: "1600",
          costBasis: "1400",
          unrealizedPl: "200"
        }]
      }),
      listOpenOrders: async () => ({
        requestId: "request-open-orders",
        orders: [{
          id: "broker-open-1",
          clientOrderId: "pg-leaps-open",
          symbol: "MSFT270115C00500000",
          assetClass: "us_option",
          qty: "1",
          limitPrice: "10",
          positionIntent: "buy_to_open",
          type: "limit",
          timeInForce: "day",
          status: "accepted"
        }]
      }),
      getMarketClock: async () => ({
        timestamp: "2026-08-05T13:59:59.000Z",
        isOpen: true,
        nextClose: "2026-08-05T20:00:00.000Z",
        requestId: "request-clock"
      }),
      listRecentOrders: async (input) => {
        recentInput = input;
        return {
          status: 200,
          url: "paper/orders",
          requestId: "request-recent-orders",
          data: [{
            id: "broker-recent-1",
            client_order_id: "pg-0dte-filled",
            symbol: "SPY260805P00450000",
            asset_class: "us_option",
            qty: "1",
            filled_qty: "1",
            limit_price: "1.25",
            position_intent: "buy_to_open",
            type: "limit",
            time_in_force: "day",
            status: "filled",
            submitted_at: "2026-08-05T13:30:00.000Z"
          }]
        };
      }
    }
  );

  assert.deepEqual(recentInput, {
    limit: 500,
    after: "2026-08-05T00:00:00.000Z"
  });
  assert.equal(snapshot.accountId, "paper-account-1");
  assert.deepEqual(snapshot.sourceRequestIds, {
    account: "request-account",
    positions: "request-positions",
    openOrders: "request-open-orders",
    recentOrders: "request-recent-orders",
    marketClock: "request-clock"
  });
  assert.deepEqual(snapshot.marketClock, {
    observedAt: "2026-08-05T13:59:59.000Z",
    isOpen: true
  });
  assert.equal(snapshot.positions[0]?.optionSymbol, "AAPL270115C00200000");
  assert.equal(snapshot.orders[0]?.brokerOrderId, "broker-open-1");
  assert.deepEqual(snapshot.recentOrders, [{
    brokerOrderId: "broker-recent-1",
    clientOrderId: "pg-0dte-filled",
    symbol: "SPY260805P00450000",
    assetClass: "option",
    side: "buy_to_open",
    orderType: "limit",
    timeInForce: "day",
    status: "filled",
    quantity: 1,
    notional: null,
    limitPrice: 1.25,
    filledQuantity: 1,
    submittedAt: "2026-08-05T13:30:00.000Z"
  }]);
});
