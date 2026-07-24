import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStructuralPortfolioFingerprint,
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
