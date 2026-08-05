import { canonicalJsonHash } from "../lib/canonicalJson.js";
import { getAlpacaAccountSnapshot } from "./alpacaAccountService.js";
import {
  listRecentPaperOrders,
  type AlpacaSubmittedOrder
} from "./alpacaClient.js";
import { getAlpacaMarketClock } from "./alpacaMarketClockService.js";
import { listAlpacaOpenOrders } from "./alpacaOrderReadService.js";
import { listAlpacaPositions } from "./alpacaPositionService.js";
import {
  paperSubmitConfiguration,
  type PaperSubmitConfiguration
} from "./paperSubmitSafetyConfig.js";

export type AuthorityBrokerPosition = {
  brokerPositionKey: string;
  symbol: string;
  underlyingSymbol: string | null;
  optionSymbol: string | null;
  assetClass: "equity" | "option";
  side: "long" | "short";
  quantity: number;
  availableQuantity: number;
  averageEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  costBasis: number;
  unrealizedPnl: number;
};

export type AuthorityBrokerOrder = {
  brokerOrderId: string;
  clientOrderId: string;
  symbol: string;
  assetClass: "equity" | "option";
  side: string;
  orderType: string;
  timeInForce: string;
  status: string;
  quantity: number | null;
  notional: number | null;
  limitPrice: number | null;
};

export type AuthorityBrokerRecentOrder = AuthorityBrokerOrder & {
  filledQuantity: number | null;
  submittedAt: string | null;
};

export type AuthorityBrokerAccount = {
  status: string;
  currency: string;
  cash: number;
  equity: number;
  buyingPower: number;
  optionsBuyingPower: number;
  optionsApprovalLevel: number;
  tradingBlocked: boolean;
  accountBlocked: boolean;
};

export type PostgresAuthorityBrokerSnapshot = {
  capturedAt: string;
  accountId: string;
  accountIdentityHash: string;
  sourceRequestIds: {
    account: string;
    positions: string;
    openOrders: string;
    recentOrders: string;
    marketClock: string;
  };
  account: AuthorityBrokerAccount;
  configuration: PaperSubmitConfiguration;
  configurationFingerprint: string;
  positions: AuthorityBrokerPosition[];
  orders: AuthorityBrokerOrder[];
  recentOrders: AuthorityBrokerRecentOrder[];
  marketClock: {
    observedAt: string;
    isOpen: boolean;
  };
  structuralPortfolioFingerprint: string;
  portfolioFingerprint: string;
};

type BrokerSnapshotDependencies = {
  getAccount?: typeof getAlpacaAccountSnapshot;
  listPositions?: typeof listAlpacaPositions;
  listOpenOrders?: typeof listAlpacaOpenOrders;
  listRecentOrders?: typeof listRecentPaperOrders;
  getMarketClock?: typeof getAlpacaMarketClock;
};

const requiredText = (value: unknown, code: string) => {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(code);
  return normalized;
};

const requiredNumber = (value: unknown, code: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
};

const optionalNumber = (value: unknown, code: string) => {
  if (value === null || value === undefined || value === "") return null;
  return requiredNumber(value, code);
};

const assetClass = (value: unknown, symbol: string): "equity" | "option" =>
  String(value ?? "").toLowerCase().includes("option") ||
  /\d{6}[CP]\d{8}$/.test(symbol)
    ? "option"
    : "equity";

const optionUnderlying = (symbol: string) => {
  const matched = symbol.match(/^([A-Z.]+)\d{6}[CP]\d{8}$/);
  return matched?.[1] ?? null;
};

export const buildStructuralPortfolioFingerprint = (
  accountIdentityHash: string,
  account: AuthorityBrokerAccount,
  positions: readonly AuthorityBrokerPosition[],
  orders: readonly AuthorityBrokerOrder[]
) => canonicalJsonHash({
  accountIdentityHash,
  accountStatus: account.status,
  accountCurrency: account.currency,
  accountCash: account.cash,
  accountBlocked: account.accountBlocked,
  tradingBlocked: account.tradingBlocked,
  optionsApprovalLevel: account.optionsApprovalLevel,
  positions: positions.map((position) => ({
    brokerPositionKey: position.brokerPositionKey,
    side: position.side,
    quantity: position.quantity,
    availableQuantity: position.availableQuantity,
    averageEntryPrice: position.averageEntryPrice,
    costBasis: position.costBasis
  })),
  openOrders: orders
});

export const capturePostgresAuthorityBrokerSnapshot = async (
  capturedAt = new Date().toISOString(),
  dependencies: BrokerSnapshotDependencies = {}
): Promise<PostgresAuthorityBrokerSnapshot> => {
  const configuration = paperSubmitConfiguration();
  if (
    configuration.environment !== "paper" ||
    configuration.tradingMode !== "paper" ||
    configuration.liveTradingEnabled
  ) {
    throw new Error("PAPER_RUNTIME_REQUIRED");
  }

  const capturedDate = new Date(capturedAt);
  if (!Number.isFinite(capturedDate.getTime())) {
    throw new Error("CURRENT_BROKER_CAPTURE_TIMESTAMP_INVALID");
  }
  const recentAfter = `${capturedAt.slice(0, 10)}T00:00:00.000Z`;
  const [
    accountResult,
    positionResult,
    orderResult,
    recentOrderResult,
    marketClockResult
  ] = await Promise.all([
    (dependencies.getAccount ?? getAlpacaAccountSnapshot)(),
    (dependencies.listPositions ?? listAlpacaPositions)(),
    (dependencies.listOpenOrders ?? listAlpacaOpenOrders)(),
    (dependencies.listRecentOrders ?? listRecentPaperOrders)({
      limit: 500,
      after: recentAfter
    }),
    (dependencies.getMarketClock ?? getAlpacaMarketClock)()
  ]);
  const accountId = requiredText(accountResult.id, "CURRENT_PAPER_ACCOUNT_ID_MISSING");
  const sourceRequestIds = {
    account: requiredText(
      accountResult.requestId,
      "CURRENT_PAPER_ACCOUNT_REQUEST_ID_MISSING"
    ),
    positions: requiredText(
      positionResult.requestId,
      "CURRENT_BROKER_POSITIONS_REQUEST_ID_MISSING"
    ),
    openOrders: requiredText(
      orderResult.requestId,
      "CURRENT_BROKER_OPEN_ORDERS_REQUEST_ID_MISSING"
    ),
    recentOrders: requiredText(
      recentOrderResult.requestId,
      "CURRENT_BROKER_RECENT_ORDERS_REQUEST_ID_MISSING"
    ),
    marketClock: requiredText(
      marketClockResult.requestId,
      "CURRENT_BROKER_MARKET_CLOCK_REQUEST_ID_MISSING"
    )
  };
  const marketClock = {
    observedAt: requiredText(
      marketClockResult.timestamp,
      "CURRENT_BROKER_MARKET_CLOCK_TIMESTAMP_MISSING"
    ),
    isOpen: typeof marketClockResult.isOpen === "boolean"
      ? marketClockResult.isOpen
      : (() => { throw new Error("CURRENT_BROKER_MARKET_CLOCK_STATUS_MISSING"); })()
  };
  const account = {
    status: requiredText(accountResult.status, "CURRENT_PAPER_ACCOUNT_STATUS_MISSING"),
    currency: requiredText(accountResult.currency, "CURRENT_PAPER_ACCOUNT_CURRENCY_MISSING"),
    cash: requiredNumber(accountResult.cash, "CURRENT_PAPER_ACCOUNT_CASH_MISSING"),
    equity: requiredNumber(accountResult.equity, "CURRENT_PAPER_ACCOUNT_EQUITY_MISSING"),
    buyingPower: requiredNumber(
      accountResult.buyingPower,
      "CURRENT_PAPER_ACCOUNT_BUYING_POWER_MISSING"
    ),
    optionsBuyingPower: requiredNumber(
      accountResult.optionsBuyingPower,
      "CURRENT_PAPER_ACCOUNT_OPTIONS_BUYING_POWER_MISSING"
    ),
    optionsApprovalLevel: requiredNumber(
      accountResult.optionsApprovedLevel,
      "CURRENT_PAPER_ACCOUNT_OPTIONS_LEVEL_MISSING"
    ),
    tradingBlocked: Boolean(accountResult.tradingBlocked),
    accountBlocked: Boolean(accountResult.accountBlocked)
  };
  if (account.tradingBlocked || account.accountBlocked) {
    throw new Error("CURRENT_PAPER_ACCOUNT_BLOCKED");
  }

  const positions = positionResult.positions.map((raw) => {
    const symbol = requiredText(raw.symbol, "CURRENT_BROKER_POSITION_SYMBOL_MISSING").toUpperCase();
    const kind = assetClass(raw.assetClass, symbol);
    const quantity = requiredNumber(raw.qty, "CURRENT_BROKER_POSITION_QUANTITY_MISSING");
    const underlying = kind === "option" ? optionUnderlying(symbol) : null;
    if (kind === "option" && !underlying) {
      throw new Error("CURRENT_BROKER_OPTION_IDENTITY_INVALID");
    }
    return {
      brokerPositionKey: `${kind}:${symbol}`,
      symbol: kind === "option" ? underlying! : symbol,
      underlyingSymbol: underlying,
      optionSymbol: kind === "option" ? symbol : null,
      assetClass: kind,
      side: quantity < 0 ? "short" as const : "long" as const,
      quantity: Math.abs(quantity),
      availableQuantity: Math.abs(requiredNumber(
        raw.qtyAvailable,
        "CURRENT_BROKER_POSITION_AVAILABLE_QUANTITY_MISSING"
      )),
      averageEntryPrice: requiredNumber(
        raw.averageEntryPrice,
        "CURRENT_BROKER_POSITION_AVERAGE_ENTRY_MISSING"
      ),
      currentPrice: requiredNumber(raw.currentPrice, "CURRENT_BROKER_POSITION_PRICE_MISSING"),
      marketValue: requiredNumber(raw.marketValue, "CURRENT_BROKER_POSITION_VALUE_MISSING"),
      costBasis: requiredNumber(raw.costBasis, "CURRENT_BROKER_POSITION_COST_BASIS_MISSING"),
      unrealizedPnl: requiredNumber(
        raw.unrealizedPl,
        "CURRENT_BROKER_POSITION_UNREALIZED_PNL_MISSING"
      )
    };
  }).sort((left, right) => left.brokerPositionKey.localeCompare(right.brokerPositionKey));

  const orders = orderResult.orders.map((raw) => {
    const symbol = requiredText(raw.symbol, "CURRENT_BROKER_ORDER_SYMBOL_MISSING").toUpperCase();
    const kind = assetClass(raw.assetClass, symbol);
    return {
      brokerOrderId: requiredText(raw.id, "CURRENT_BROKER_ORDER_ID_MISSING"),
      clientOrderId: requiredText(raw.clientOrderId, "CURRENT_BROKER_CLIENT_ORDER_ID_MISSING"),
      symbol,
      assetClass: kind,
      side: requiredText(
        raw.positionIntent || raw.side,
        "CURRENT_BROKER_ORDER_SIDE_MISSING"
      ).toLowerCase(),
      orderType: requiredText(raw.type, "CURRENT_BROKER_ORDER_TYPE_MISSING").toLowerCase(),
      timeInForce: requiredText(
        raw.timeInForce,
        "CURRENT_BROKER_ORDER_TIME_IN_FORCE_MISSING"
      ).toLowerCase(),
      status: requiredText(raw.status, "CURRENT_BROKER_ORDER_STATUS_MISSING").toLowerCase(),
      quantity: optionalNumber(raw.qty, "CURRENT_BROKER_ORDER_QUANTITY_INVALID"),
      notional: optionalNumber(raw.notional, "CURRENT_BROKER_ORDER_NOTIONAL_INVALID"),
      limitPrice: optionalNumber(raw.limitPrice, "CURRENT_BROKER_ORDER_LIMIT_PRICE_INVALID")
    };
  }).sort((left, right) => left.brokerOrderId.localeCompare(right.brokerOrderId));

  if (!Array.isArray(recentOrderResult.data)) {
    throw new Error("CURRENT_BROKER_RECENT_ORDERS_RESPONSE_INVALID");
  }
  const recentOrders: AuthorityBrokerRecentOrder[] = recentOrderResult.data.map(
    (raw: AlpacaSubmittedOrder) => {
      const symbol = requiredText(
        raw.symbol,
        "CURRENT_BROKER_RECENT_ORDER_SYMBOL_MISSING"
      ).toUpperCase();
      const kind = assetClass(raw.asset_class, symbol);
      return {
        brokerOrderId: requiredText(
          raw.id,
          "CURRENT_BROKER_RECENT_ORDER_ID_MISSING"
        ),
        clientOrderId: requiredText(
          raw.client_order_id,
          "CURRENT_BROKER_RECENT_CLIENT_ORDER_ID_MISSING"
        ),
        symbol,
        assetClass: kind,
        side: requiredText(
          raw.position_intent || raw.side,
          "CURRENT_BROKER_RECENT_ORDER_SIDE_MISSING"
        ).toLowerCase(),
        orderType: requiredText(
          raw.type,
          "CURRENT_BROKER_RECENT_ORDER_TYPE_MISSING"
        ).toLowerCase(),
        timeInForce: requiredText(
          raw.time_in_force,
          "CURRENT_BROKER_RECENT_ORDER_TIME_IN_FORCE_MISSING"
        ).toLowerCase(),
        status: requiredText(
          raw.status,
          "CURRENT_BROKER_RECENT_ORDER_STATUS_MISSING"
        ).toLowerCase(),
        quantity: optionalNumber(
          raw.qty,
          "CURRENT_BROKER_RECENT_ORDER_QUANTITY_INVALID"
        ),
        notional: optionalNumber(
          raw.notional,
          "CURRENT_BROKER_RECENT_ORDER_NOTIONAL_INVALID"
        ),
        limitPrice: optionalNumber(
          raw.limit_price,
          "CURRENT_BROKER_RECENT_ORDER_LIMIT_PRICE_INVALID"
        ),
        filledQuantity: optionalNumber(
          raw.filled_qty,
          "CURRENT_BROKER_RECENT_ORDER_FILLED_QUANTITY_INVALID"
        ),
        submittedAt: raw.submitted_at
          ? requiredText(
              raw.submitted_at,
              "CURRENT_BROKER_RECENT_ORDER_SUBMITTED_AT_INVALID"
            )
          : null
      };
    }
  ).sort((left, right) => left.brokerOrderId.localeCompare(right.brokerOrderId));

  const accountIdentityHash = canonicalJsonHash({ accountId });
  const structuralPortfolioFingerprint = buildStructuralPortfolioFingerprint(
    accountIdentityHash,
    account,
    positions,
    orders
  );
  const portfolioState = {
    accountIdentityHash,
    account,
    positions,
    openOrders: orders
  };
  return {
    capturedAt,
    accountId,
    accountIdentityHash,
    sourceRequestIds,
    account,
    configuration,
    configurationFingerprint: canonicalJsonHash(configuration),
    positions,
    orders,
    recentOrders,
    marketClock,
    structuralPortfolioFingerprint,
    portfolioFingerprint: canonicalJsonHash(portfolioState)
  };
};
