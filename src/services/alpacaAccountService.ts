import {
  getAlpacaPaperEndpoint,
  type AlpacaApiResponse,
  type AlpacaRequestContext
} from "./alpacaClient.js";

export interface AlpacaAccountSnapshot {
  id?: string;
  status?: string;
  currency?: string;
  cash?: string;
  portfolioValue?: string;
  equity?: string;
  lastEquity?: string;
  buyingPower?: string;
  regtBuyingPower?: string;
  daytradingBuyingPower?: string;
  nonMarginableBuyingPower?: string;
  optionsBuyingPower?: string;
  optionsApprovedLevel?: number | string;
  optionsTradingLevel?: number | string;
  patternDayTrader?: boolean;
  daytradeCount?: number;
  tradingBlocked?: boolean;
  transfersBlocked?: boolean;
  accountBlocked?: boolean;
  createdAt?: string;
  requestId?: string;
}

type ApiAccountPayload = {
  id?: string;
  status?: string;
  currency?: string;
  cash?: string;
  portfolio_value?: string;
  equity?: string;
  last_equity?: string;
  buying_power?: string;
  regt_buying_power?: string;
  daytrading_buying_power?: string;
  non_marginable_buying_power?: string;
  options_buying_power?: string;
  options_approved_level?: number | string;
  options_trading_level?: number | string;
  pattern_day_trader?: boolean;
  daytrade_count?: number;
  trading_blocked?: boolean;
  transfers_blocked?: boolean;
  account_blocked?: boolean;
  created_at?: string;
};

const mapAccount = (row: ApiAccountPayload): AlpacaAccountSnapshot => ({
  id: row.id,
  status: row.status,
  currency: row.currency,
  cash: row.cash,
  portfolioValue: row.portfolio_value,
  equity: row.equity,
  lastEquity: row.last_equity,
  buyingPower: row.buying_power,
  regtBuyingPower: row.regt_buying_power,
  daytradingBuyingPower: row.daytrading_buying_power,
  nonMarginableBuyingPower: row.non_marginable_buying_power,
  optionsBuyingPower: row.options_buying_power,
  optionsApprovedLevel: row.options_approved_level,
  optionsTradingLevel: row.options_trading_level,
  patternDayTrader: row.pattern_day_trader,
  daytradeCount: row.daytrade_count,
  tradingBlocked: row.trading_blocked,
  transfersBlocked: row.transfers_blocked,
  accountBlocked: row.account_blocked,
  createdAt: row.created_at
});

export const getAlpacaAccountSnapshot = async (
  context: AlpacaRequestContext = {}
): Promise<AlpacaAccountSnapshot> => {
  const response: AlpacaApiResponse<ApiAccountPayload> =
    await getAlpacaPaperEndpoint<ApiAccountPayload>("/v2/account", context);
  const account = mapAccount(response.data);
  if (response.requestId) {
    account.requestId = response.requestId;
  }
  return account;
};
