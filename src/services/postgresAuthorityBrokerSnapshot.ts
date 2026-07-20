import { canonicalJsonHash } from "../lib/canonicalJson.js";
import { getAlpacaAccountSnapshot } from "./alpacaAccountService.js";
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

export type PostgresAuthorityBrokerSnapshot = {
  capturedAt: string;
  accountIdentityHash: string;
  account: {
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
  configuration: PaperSubmitConfiguration;
  configurationFingerprint: string;
  positions: AuthorityBrokerPosition[];
  orders: AuthorityBrokerOrder[];
  structuralPortfolioFingerprint: string;
  portfolioFingerprint: string;
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

export const capturePostgresAuthorityBrokerSnapshot = async (
  capturedAt = new Date().toISOString()
): Promise<PostgresAuthorityBrokerSnapshot> => {
  const configuration = paperSubmitConfiguration();
  if (
    configuration.environment !== "paper" ||
    configuration.tradingMode !== "paper" ||
    configuration.liveTradingEnabled
  ) {
    throw new Error("PAPER_RUNTIME_REQUIRED");
  }

  const [accountResult, positionResult, orderResult] = await Promise.all([
    getAlpacaAccountSnapshot(),
    listAlpacaPositions(),
    listAlpacaOpenOrders()
  ]);
  const accountId = requiredText(accountResult.id, "CURRENT_PAPER_ACCOUNT_ID_MISSING");
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

  const accountIdentityHash = canonicalJsonHash({ accountId });
  const structuralState = {
    accountIdentityHash,
    accountStatus: account.status,
    accountBlocked: account.accountBlocked,
    tradingBlocked: account.tradingBlocked,
    positions: positions.map(({ brokerPositionKey, quantity }) => ({
      brokerPositionKey,
      quantity
    })),
    openOrders: orders
  };
  const portfolioState = { ...structuralState, account, positions };
  return {
    capturedAt,
    accountIdentityHash,
    account,
    configuration,
    configurationFingerprint: canonicalJsonHash(configuration),
    positions,
    orders,
    structuralPortfolioFingerprint: canonicalJsonHash(structuralState),
    portfolioFingerprint: canonicalJsonHash(portfolioState)
  };
};
