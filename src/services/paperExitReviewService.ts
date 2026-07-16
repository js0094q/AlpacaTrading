import {
  getAccount,
  getLatestOptionSnapshots,
  getLatestStockSnapshots,
  listPaperAccountActivities,
  listPaperPositions,
  listRecentPaperOrders,
  type AlpacaAccountActivityRaw,
  type AlpacaAccountRaw,
  type AlpacaApiResponse,
  type AlpacaBatchedSnapshotResponse,
  type AlpacaOptionSnapshotRaw,
  type AlpacaPositionRaw,
  type AlpacaStockSnapshotRaw,
  type AlpacaSubmittedOrder
} from "./alpacaClient.js";
import { getAlpacaMarketClock, type AlpacaMarketClockSnapshot } from "./alpacaMarketClockService.js";
import {
  reconcilePaperAccountBeforeExecution,
  type PaperAccountReconciliationReport
} from "./paperAccountReconciliationService.js";
import { normalizeOptionQuote, roundOptionLimitPrice } from "./optionQuoteNormalizer.js";
import { getTradingSafetyState } from "./tradingSafetyService.js";
import { queryAll } from "../lib/db.js";
import { executionStateProjectionService } from "./executionStateProjectionService.js";
import type {
  PaperExitAssetClass,
  PaperExitOrderPayload,
  PaperExitReconciliationEvent,
  PaperExitReviewCandidate,
  PaperExitReviewResult,
  PaperExitSkippedPosition,
  PaperExitStatus,
  PaperPositionClass
} from "../types/paperExit.js";

export const DEFAULT_0DTE_EXIT_RULES = {
  stopLossPct: 0.50,
  takeProfitPct: 0.50,
  eodWindowMinutes: 120,
  eodStopLossPct: 0.25,
  eodTakeProfitPct: 0.25,
  forceExitMinutesBeforeClose: 30,
  minSellableOptionValue: 0.05
};

export const DEFAULT_EQUITY_EXIT_RULES = {
  stopLossPct: 0.05,
  takeProfitPct: 0.08,
  trailingStopPct: null,
  maxHoldDays: null,
  minPositionMarketValue: 1,
  enabled: true
};

export const DEFAULT_LEAPS_EXIT_RULES = {
  enabled: false,
  stopLossPct: 0.35,
  takeProfitPct: 0.75,
  minDteForLeaps: 180,
  decayExitDte: 120,
  maxHoldDays: null as number | null,
  minSellableOptionValue: 0.05
};

export interface PaperExitReviewInput {
  includeEquities?: boolean;
  includeOptions?: boolean;
  include0DTE?: boolean;
  includeLEAPS?: boolean;
  optionStopLossPct?: number;
  optionTakeProfitPct?: number;
  optionEodWindowMinutes?: number;
  optionEodStopLossPct?: number;
  optionEodTakeProfitPct?: number;
  optionForceExitMinutesBeforeClose?: number;
  minSellableOptionValue?: number;
  equityStopLossPct?: number;
  equityTakeProfitPct?: number;
  leapsStopLossPct?: number;
  leapsTakeProfitPct?: number;
  leapsMinDteForLeaps?: number;
  leapsDecayExitDte?: number;
  leapsMaxHoldDays?: number | null;
  leapsMinSellableOptionValue?: number;
  format?: "json" | "table";
}

interface PaperExitReviewDeps {
  getAccount?: typeof getAccount;
  listPaperPositions?: typeof listPaperPositions;
  listRecentPaperOrders?: typeof listRecentPaperOrders;
  listPaperAccountActivities?: typeof listPaperAccountActivities;
  getMarketClock?: typeof getAlpacaMarketClock;
  getLatestStockSnapshots?: typeof getLatestStockSnapshots;
  getLatestOptionSnapshots?: typeof getLatestOptionSnapshots;
  reconcilePaperAccountBeforeExecution?: typeof reconcilePaperAccountBeforeExecution;
  getKnownLeapsOptionSymbols?: () => Set<string> | string[] | Promise<Set<string> | string[]>;
  now?: () => string;
}

interface OptionSymbolMetadata {
  expirationDate: string | null;
}

const ACTIVE_EXIT_ORDER_STATUSES = new Set([
  "new",
  "accepted",
  "pending_new",
  "partially_filled",
  "accepted_for_bidding",
  "pending_replace"
]);

const numberField = (value: unknown, fallback = 0): number => {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const optionalNumberField = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeSymbol = (value: string | undefined | null): string =>
  String(value || "").trim().toUpperCase();

const normalizeText = (value: string | undefined | null): string =>
  String(value || "").trim().toLowerCase();

const dateOnly = (value: string): string => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return parsed.toISOString().slice(0, 10);
};

const currentDayStart = (tradingDate: string): string => `${tradingDate}T00:00:00.000Z`;

const daysBetweenDateOnly = (fromDate: string, toDate: string): number | null => {
  const from = Date.parse(`${fromDate}T00:00:00.000Z`);
  const to = Date.parse(`${toDate}T00:00:00.000Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return null;
  }
  return Math.floor((to - from) / (24 * 60 * 60 * 1000));
};

const parseOccOptionSymbol = (symbol: string): OptionSymbolMetadata => {
  const match = normalizeSymbol(symbol).match(/^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/);
  if (!match) {
    return { expirationDate: null };
  }
  const value = match[2]!;
  const year = Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  const fullYear = 2000 + year;
  const expirationDate = [
    String(fullYear).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0")
  ].join("-");
  if (Number.isNaN(Date.parse(`${expirationDate}T00:00:00.000Z`))) {
    return { expirationDate: null };
  }
  return { expirationDate };
};

const listKnownLeapsOptionSymbols = (): Set<string> => {
  const rows = queryAll<{ option_symbol: string | null }>(
    `
    SELECT DISTINCT option_symbol
    FROM paper_learning_records
    WHERE strategy_family = 'leaps'
      AND decision = 'submitted'
      AND option_symbol IS NOT NULL
    `,
    []
  );
  return new Set(rows.map((row) => normalizeSymbol(row.option_symbol)).filter(Boolean));
};

const classifyPosition = (
  position: AlpacaPositionRaw,
  tradingDate: string,
  input: {
    minDteForLeaps?: number;
    knownLeapsOptionSymbols?: Set<string>;
  } = {}
): PaperPositionClass => {
  const assetClass = normalizeText(position.asset_class);
  if (assetClass === "us_equity" || assetClass === "equity") {
    return "equity";
  }
  if (assetClass !== "us_option" && assetClass !== "option") {
    return "unknown";
  }

  const qty = numberField(position.qty);
  const side = normalizeText(position.side || (qty >= 0 ? "long" : "short"));
  const metadata = parseOccOptionSymbol(String(position.symbol || ""));
  if (!metadata.expirationDate) {
    return "option_other";
  }
  if (metadata.expirationDate === tradingDate && qty > 0 && side === "long") {
    return "option_0dte";
  }
  const dte = daysBetweenDateOnly(tradingDate, metadata.expirationDate);
  if (dte !== null && dte > 0 && input.knownLeapsOptionSymbols?.has(normalizeSymbol(position.symbol))) {
    return "option_leaps";
  }
  if (dte !== null && dte >= (input.minDteForLeaps ?? DEFAULT_LEAPS_EXIT_RULES.minDteForLeaps)) {
    return "option_leaps";
  }
  if (dte !== null && dte >= 0) {
    return "option_short_dated";
  }
  return "option_other";
};

const qtyString = (value: number): string => {
  const fixed = value.toFixed(6);
  return fixed.replace(/\.?0+$/g, "") || "0";
};

const moneyString = (value: number): string => value.toFixed(2);

const avgEntryPrice = (position: AlpacaPositionRaw, qty: number): number => {
  const explicit = optionalNumberField(position.avg_entry_price);
  if (explicit !== null) {
    return explicit;
  }
  const costBasis = optionalNumberField(position.cost_basis);
  if (costBasis !== null && qty !== 0) {
    return Math.abs(costBasis / qty);
  }
  return 0;
};

const marketValue = (position: AlpacaPositionRaw): number => numberField(position.market_value);

const isActiveSellOrderFor = (orders: AlpacaSubmittedOrder[], symbol: string): boolean => {
  const normalized = normalizeSymbol(symbol);
  return orders.some((order) =>
    normalizeSymbol(order.symbol) === normalized &&
    normalizeText(order.side) === "sell" &&
    ACTIVE_EXIT_ORDER_STATUSES.has(normalizeText(order.status))
  );
};

const snapshotRequestId = (response: AlpacaBatchedSnapshotResponse<unknown>): string | undefined =>
  response.requestIds.length ? response.requestIds.join(",") : undefined;

const stockSnapshotPrice = (snapshot: AlpacaStockSnapshotRaw | undefined): number | null => {
  if (!snapshot) {
    return null;
  }
  const trade = optionalNumberField(snapshot.latestTrade?.p);
  if (trade !== null && trade > 0) {
    return trade;
  }
  const bid = optionalNumberField(snapshot.latestQuote?.bp);
  const ask = optionalNumberField(snapshot.latestQuote?.ap);
  if (bid !== null && ask !== null && bid > 0 && ask > 0 && ask >= bid) {
    return Number(((bid + ask) / 2).toFixed(4));
  }
  return (
    optionalNumberField(snapshot.minuteBar?.c) ??
    optionalNumberField(snapshot.dailyBar?.c) ??
    optionalNumberField(snapshot.prevDailyBar?.c)
  );
};

const optionQuoteInput = (symbol: string, snapshot: AlpacaOptionSnapshotRaw | undefined) => ({
  optionSymbol: symbol,
  bid: snapshot?.latest_quote?.bp ?? snapshot?.latest_quote?.b ?? snapshot?.latestQuote?.bp ?? snapshot?.latestQuote?.b ?? null,
  ask: snapshot?.latest_quote?.ap ?? snapshot?.latest_quote?.a ?? snapshot?.latestQuote?.ap ?? snapshot?.latestQuote?.a ?? null,
  midpoint: null,
  last: snapshot?.latest_trade?.p ?? snapshot?.latestTrade?.p ?? snapshot?.latest_quote?.p ?? snapshot?.latestQuote?.p ?? null,
  timestamp: snapshot?.latest_quote?.t ?? snapshot?.latestQuote?.t ?? snapshot?.latest_trade?.t ?? snapshot?.latestTrade?.t ?? null
});

const optionCurrentPrice = (
  position: AlpacaPositionRaw,
  snapshot: AlpacaOptionSnapshotRaw | undefined,
  qty: number
): number => {
  const quote = optionQuoteInput(String(position.symbol || ""), snapshot);
  const bid = optionalNumberField(quote.bid);
  const ask = optionalNumberField(quote.ask);
  if (bid !== null && ask !== null && bid > 0 && ask > 0 && ask >= bid) {
    return Number(((bid + ask) / 2).toFixed(4));
  }
  const last = optionalNumberField(quote.last);
  if (last !== null && last > 0) {
    return last;
  }
  const explicit = optionalNumberField(position.current_price);
  if (explicit !== null) {
    return explicit;
  }
  const value = marketValue(position);
  return qty > 0 ? Math.abs(value / qty / 100) : 0;
};

const equityCurrentPrice = (
  position: AlpacaPositionRaw,
  snapshot: AlpacaStockSnapshotRaw | undefined,
  qty: number
): number => {
  const explicit = optionalNumberField(position.current_price);
  if (explicit !== null) {
    return explicit;
  }
  const snapshotPrice = stockSnapshotPrice(snapshot);
  if (snapshotPrice !== null) {
    return snapshotPrice;
  }
  const value = marketValue(position);
  return qty > 0 ? Math.abs(value / qty) : 0;
};

const safeClientIdPart = (value: string): string =>
  value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");

const clientOrderTimestamp = (iso: string): string => {
  const parsed = new Date(iso);
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const pad = (input: number) => String(input).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds())
  ].join("");
};

const buildClientOrderId = (
  assetClass: PaperExitAssetClass,
  symbol: string,
  generatedAt: string,
  index: number
): string =>
  `paper-exit-${assetClass === "us_option" ? "option" : "equity"}-${safeClientIdPart(symbol).slice(0, 42)}-${clientOrderTimestamp(generatedAt)}-${index + 1}`.slice(0, 128);

const minutesUntilClose = (
  clock: AlpacaMarketClockSnapshot,
  generatedAt: string
): number | null => {
  if (!clock.nextClose) {
    return null;
  }
  const reference = Date.parse(clock.timestamp || generatedAt);
  const close = Date.parse(clock.nextClose);
  if (!Number.isFinite(reference) || !Number.isFinite(close)) {
    return null;
  }
  return Math.round((close - reference) / 60000);
};

const inFinalMinutes = (minutes: number | null, threshold: number): boolean =>
  minutes !== null && minutes >= 0 && minutes <= threshold;

const resolve0DteReason = (
  unrealizedPlpc: number,
  minutesToClose: number | null,
  rules: typeof DEFAULT_0DTE_EXIT_RULES
): string | null => {
  if (inFinalMinutes(minutesToClose, rules.forceExitMinutesBeforeClose)) {
    return "ODTE_FORCE_EXIT_BEFORE_CLOSE";
  }
  if (inFinalMinutes(minutesToClose, rules.eodWindowMinutes)) {
    if (unrealizedPlpc <= -rules.eodStopLossPct) {
      return "ODTE_EOD_STOP_LOSS_25";
    }
    if (unrealizedPlpc >= rules.eodTakeProfitPct) {
      return "ODTE_EOD_TAKE_PROFIT_25";
    }
    return null;
  }
  if (unrealizedPlpc <= -rules.stopLossPct) {
    return "ODTE_STOP_LOSS_50";
  }
  if (unrealizedPlpc >= rules.takeProfitPct) {
    return "ODTE_TAKE_PROFIT_50";
  }
  return null;
};

const resolveEquityReason = (
  unrealizedPlpc: number,
  rules: typeof DEFAULT_EQUITY_EXIT_RULES
): string | null => {
  if (!rules.enabled) {
    return null;
  }
  if (unrealizedPlpc <= -rules.stopLossPct) {
    return "EQUITY_STOP_LOSS_5";
  }
  if (unrealizedPlpc >= rules.takeProfitPct) {
    return "EQUITY_TAKE_PROFIT_8";
  }
  return null;
};

const resolveLeapsReason = (
  unrealizedPlpc: number,
  dte: number | null,
  rules: typeof DEFAULT_LEAPS_EXIT_RULES
): string | null => {
  if (!rules.enabled) {
    return null;
  }
  if (unrealizedPlpc <= -rules.stopLossPct) {
    return "LEAPS_STOP_LOSS_35";
  }
  if (unrealizedPlpc >= rules.takeProfitPct) {
    return "LEAPS_TAKE_PROFIT_75";
  }
  if (dte !== null && dte < rules.decayExitDte) {
    return "LEAPS_DTE_DECAY_EXIT";
  }
  return null;
};

const emptyReview = (input: {
  generatedAt: string;
  environment: "paper" | "live";
  status: PaperExitStatus;
  blockReason?: string;
  events?: Array<{ code: string; symbol?: string; message: string }>;
}): PaperExitReviewResult => ({
  status: input.status,
  environment: input.environment,
  mutationAttempted: false,
  generatedAt: input.generatedAt,
  blockReason: input.blockReason,
  account: {
    cash: 0,
    equity: 0,
    buyingPower: 0,
    positionMarketValue: 0
  },
  reconciliation: {
    status: input.status,
    sumPositionsMarketValue: 0,
    accountPositionMarketValue: 0,
    events: input.events || []
  },
  exitCandidates: [],
  skipped: [],
  alpacaRequestIds: {}
});

const reconciliationEvents = (
  report: PaperAccountReconciliationReport,
  accountPositionMarketValue: number,
  sumPositionsMarketValue: number
): PaperExitReconciliationEvent[] => {
  const events: PaperExitReconciliationEvent[] = report.reconciliationEvents.map((event) => ({
    code: event.type,
    symbol: event.symbol,
    message: event.explanation
  }));
  if (report.marketValueMismatch) {
    events.push({
      code: "ACCOUNT_RECONCILIATION_MISMATCH",
      message: `account.position_market_value=${accountPositionMarketValue.toFixed(2)} differs from sum(/v2/positions.market_value)=${sumPositionsMarketValue.toFixed(2)}.`
    });
  }
  if (report.accountMathMismatch) {
    events.push({
      code: "ACCOUNT_RECONCILIATION_MISMATCH",
      message: "Account cash/equity/position_market_value failed internal consistency checks."
    });
  }
  return events;
};

const skippedFromReconciliation = (
  report: PaperAccountReconciliationReport
): PaperExitSkippedPosition[] => {
  const bySymbol = new Map<string, string>();
  for (const event of report.reconciliationEvents) {
    bySymbol.set(event.symbol, event.type);
  }
  return report.missingSymbols.map((symbol) => ({
    symbol,
    assetClass: "unknown",
    positionClass: "unknown",
    reason: bySymbol.get(symbol) || "PAPER_POSITION_SYNC_PENDING",
    details: {
      expectedQuantity: report.expectedQuantities[symbol] ?? null,
      source: "/v2/positions"
    }
  }));
};

const buildOrderPayload = (input: {
  assetClass: PaperExitAssetClass;
  symbol: string;
  qty: string;
  orderType: "market" | "limit";
  reason: string;
  generatedAt: string;
  index: number;
  limitPrice?: string;
}): PaperExitOrderPayload => ({
  symbol: input.symbol,
  assetClass: input.assetClass,
  side: "sell",
  positionIntent: input.assetClass === "us_option" ? "sell_to_close" : undefined,
  qty: input.qty,
  orderType: input.orderType,
  timeInForce: "day",
  reason: input.reason,
  limitPrice: input.limitPrice,
  clientOrderId: buildClientOrderId(input.assetClass, input.symbol, input.generatedAt, input.index)
});

const orderPayloadToCandidate = (input: {
  position: AlpacaPositionRaw;
  assetClass: PaperExitAssetClass;
  positionClass: PaperPositionClass;
  qty: number;
  qtyAvailable: number;
  avgEntryPrice: number;
  currentPrice: number;
  reason: string;
  orderPayload: PaperExitOrderPayload;
}): PaperExitReviewCandidate => ({
  symbol: normalizeSymbol(input.position.symbol),
  assetClass: input.assetClass,
  positionClass: input.positionClass,
  qty: qtyString(input.qty),
  qtyAvailable: qtyString(input.qtyAvailable),
  avgEntryPrice: Number(input.avgEntryPrice.toFixed(4)),
  currentPrice: Number(input.currentPrice.toFixed(4)),
  marketValue: Number(marketValue(input.position).toFixed(2)),
  unrealizedPl: Number(numberField(input.position.unrealized_pl).toFixed(2)),
  unrealizedPlpc: Number(numberField(input.position.unrealized_plpc).toFixed(6)),
  reason: input.reason,
  orderPayload: input.orderPayload
});

export const buildPaperExitReviewResult = async (
  input: PaperExitReviewInput = {},
  deps: PaperExitReviewDeps = {}
): Promise<PaperExitReviewResult> => {
  const generatedAt = deps.now?.() || new Date().toISOString();
  const state = getTradingSafetyState();
  if (state.alpacaEnv !== "paper" || state.liveTradingEnabled) {
    return emptyReview({
      generatedAt,
      environment: state.alpacaEnv,
      status: "blocked",
      blockReason: "LIVE_TRADING_BLOCKED",
      events: [
        {
          code: "LIVE_TRADING_BLOCKED",
          message: "Paper exit review is disabled unless ALPACA_ENV=paper and live trading is disabled."
        }
      ]
    });
  }

  const includeEquities = input.includeEquities !== false;
  const includeOptions = input.includeOptions !== false;
  const include0DTE = input.include0DTE !== false;
  const includeLEAPS = input.includeLEAPS === true;
  const optionRules = {
    stopLossPct: input.optionStopLossPct ?? DEFAULT_0DTE_EXIT_RULES.stopLossPct,
    takeProfitPct: input.optionTakeProfitPct ?? DEFAULT_0DTE_EXIT_RULES.takeProfitPct,
    eodWindowMinutes: input.optionEodWindowMinutes ?? DEFAULT_0DTE_EXIT_RULES.eodWindowMinutes,
    eodStopLossPct: input.optionEodStopLossPct ?? DEFAULT_0DTE_EXIT_RULES.eodStopLossPct,
    eodTakeProfitPct: input.optionEodTakeProfitPct ?? DEFAULT_0DTE_EXIT_RULES.eodTakeProfitPct,
    forceExitMinutesBeforeClose:
      input.optionForceExitMinutesBeforeClose ?? DEFAULT_0DTE_EXIT_RULES.forceExitMinutesBeforeClose,
    minSellableOptionValue:
      input.minSellableOptionValue ?? DEFAULT_0DTE_EXIT_RULES.minSellableOptionValue
  };
  const equityRules = {
    ...DEFAULT_EQUITY_EXIT_RULES,
    stopLossPct: input.equityStopLossPct ?? DEFAULT_EQUITY_EXIT_RULES.stopLossPct,
    takeProfitPct: input.equityTakeProfitPct ?? DEFAULT_EQUITY_EXIT_RULES.takeProfitPct
  };
  const leapsRules = {
    enabled: includeLEAPS,
    stopLossPct: input.leapsStopLossPct ?? DEFAULT_LEAPS_EXIT_RULES.stopLossPct,
    takeProfitPct: input.leapsTakeProfitPct ?? DEFAULT_LEAPS_EXIT_RULES.takeProfitPct,
    minDteForLeaps: input.leapsMinDteForLeaps ?? DEFAULT_LEAPS_EXIT_RULES.minDteForLeaps,
    decayExitDte: input.leapsDecayExitDte ?? DEFAULT_LEAPS_EXIT_RULES.decayExitDte,
    maxHoldDays: input.leapsMaxHoldDays ?? DEFAULT_LEAPS_EXIT_RULES.maxHoldDays,
    minSellableOptionValue:
      input.leapsMinSellableOptionValue ??
      input.minSellableOptionValue ??
      DEFAULT_LEAPS_EXIT_RULES.minSellableOptionValue
  };

  const getClockFn = deps.getMarketClock ?? getAlpacaMarketClock;
  const clock = await getClockFn();
  const tradingDate = dateOnly(clock.timestamp || generatedAt);
  const after = currentDayStart(tradingDate);

  const getAccountFn = deps.getAccount ?? getAccount;
  const listPositionsFn = deps.listPaperPositions ?? listPaperPositions;
  const listOrdersFn = deps.listRecentPaperOrders ?? listRecentPaperOrders;
  const listActivitiesFn = deps.listPaperAccountActivities ?? listPaperAccountActivities;
  const getStockSnapshotsFn = deps.getLatestStockSnapshots ?? getLatestStockSnapshots;
  const getOptionSnapshotsFn = deps.getLatestOptionSnapshots ?? getLatestOptionSnapshots;
  const reconcileFn = deps.reconcilePaperAccountBeforeExecution ?? reconcilePaperAccountBeforeExecution;

  const [accountResponse, positionsResponse, ordersResponse, activitiesResponse, reconciliationSnapshot] =
    await Promise.all([
      getAccountFn(),
      listPositionsFn(),
      listOrdersFn({ after, limit: 500 }),
      listActivitiesFn({ after, limit: 500 }),
      reconcileFn({
        getAccount: getAccountFn,
        listPaperPositions: listPositionsFn,
        listRecentPaperOrders: listOrdersFn,
        listPaperAccountActivities: listActivitiesFn,
        now: deps.now
      })
    ]) as [
      AlpacaApiResponse<AlpacaAccountRaw>,
      AlpacaApiResponse<AlpacaPositionRaw[]>,
      AlpacaApiResponse<AlpacaSubmittedOrder[]>,
      AlpacaApiResponse<AlpacaAccountActivityRaw[]>,
      Awaited<ReturnType<typeof reconcilePaperAccountBeforeExecution>>
    ];

  const account = accountResponse.data;
  const positions = Array.isArray(positionsResponse.data) ? positionsResponse.data : [];
  const orders = Array.isArray(ordersResponse.data) ? ordersResponse.data : [];
  const sumPositionsMarketValue = Number(
    positions.reduce((total, position) => total + numberField(position.market_value), 0).toFixed(2)
  );
  const accountPositionMarketValue = numberField(account.position_market_value);
  const events = reconciliationEvents(
    reconciliationSnapshot.report,
    accountPositionMarketValue,
    sumPositionsMarketValue
  );
  const skipped: PaperExitSkippedPosition[] = skippedFromReconciliation(reconciliationSnapshot.report);
  const alpacaRequestIds: Record<string, string> = {
    ...(accountResponse.requestId ? { account: accountResponse.requestId } : {}),
    ...(positionsResponse.requestId ? { positions: positionsResponse.requestId } : {}),
    ...(ordersResponse.requestId ? { orders: ordersResponse.requestId } : {}),
    ...(activitiesResponse.requestId ? { activities: activitiesResponse.requestId } : {}),
    ...(clock.requestId ? { clock: clock.requestId } : {})
  };

  const reconciliationStatus = reconciliationSnapshot.report.reconciliationStatus;
  const knownLeapsSymbolsValue = executionStateProjectionService.isAuthorityActive()
    ? new Set<string>()
    : await (
        deps.getKnownLeapsOptionSymbols?.() ?? Promise.resolve(listKnownLeapsOptionSymbols())
      );
  const knownLeapsOptionSymbols = knownLeapsSymbolsValue instanceof Set
    ? knownLeapsSymbolsValue
    : new Set(knownLeapsSymbolsValue.map(normalizeSymbol).filter(Boolean));
  const classify = (position: AlpacaPositionRaw) =>
    classifyPosition(position, tradingDate, {
      minDteForLeaps: leapsRules.minDteForLeaps,
      knownLeapsOptionSymbols
    });

  if (reconciliationStatus === "blocked") {
    return {
      status: "blocked",
      environment: "paper",
      mutationAttempted: false,
      generatedAt,
      blockReason: "ACCOUNT_RECONCILIATION_MISMATCH",
      account: {
        cash: numberField(account.cash),
        equity: numberField(account.equity ?? account.portfolio_value),
        buyingPower: numberField(account.buying_power),
        positionMarketValue: accountPositionMarketValue
      },
      reconciliation: {
        status: "blocked",
        sumPositionsMarketValue,
        accountPositionMarketValue,
        events
      },
      exitCandidates: [],
      skipped: [
        ...skipped,
        ...positions.map((position) => ({
          symbol: normalizeSymbol(position.symbol),
          assetClass: String(position.asset_class || "unknown"),
          positionClass: classify(position),
          reason: "ACCOUNT_RECONCILIATION_MISMATCH"
        }))
      ],
      alpacaRequestIds
    };
  }

  const equitySymbols = positions
    .filter((position) => classify(position) === "equity")
    .map((position) => normalizeSymbol(position.symbol));
  const optionSymbols = positions
    .filter((position) => String(position.asset_class || "").toLowerCase() === "us_option")
    .map((position) => normalizeSymbol(position.symbol));

  let stockSnapshots: Record<string, AlpacaStockSnapshotRaw> = {};
  let optionSnapshots: Record<string, AlpacaOptionSnapshotRaw> = {};
  try {
    const stockResponse = await getStockSnapshotsFn(equitySymbols);
    stockSnapshots = stockResponse.data;
    const requestId = snapshotRequestId(stockResponse as AlpacaBatchedSnapshotResponse<unknown>);
    if (requestId) {
      alpacaRequestIds.stockSnapshots = requestId;
    }
  } catch (error) {
    events.push({
      code: "STOCK_SNAPSHOT_UNAVAILABLE",
      message: error instanceof Error ? error.message : "Latest stock snapshots were unavailable."
    });
  }
  try {
    const optionResponse = await getOptionSnapshotsFn(optionSymbols);
    optionSnapshots = optionResponse.data;
    const requestId = snapshotRequestId(optionResponse as AlpacaBatchedSnapshotResponse<unknown>);
    if (requestId) {
      alpacaRequestIds.optionSnapshots = requestId;
    }
  } catch (error) {
    events.push({
      code: "OPTION_SNAPSHOT_UNAVAILABLE",
      message: error instanceof Error ? error.message : "Latest option snapshots were unavailable."
    });
  }

  const minutesToClose = minutesUntilClose(clock, generatedAt);
  const candidates: PaperExitReviewCandidate[] = [];

  for (const position of positions) {
    const symbol = normalizeSymbol(position.symbol);
    const positionClass = classify(position);
    const optionMetadata = parseOccOptionSymbol(symbol);
    const dte = optionMetadata.expirationDate
      ? daysBetweenDateOnly(tradingDate, optionMetadata.expirationDate)
      : null;
    const rawAssetClass = normalizeText(position.asset_class);
    const assetClass: PaperExitAssetClass | null =
      positionClass === "equity"
        ? "us_equity"
        : rawAssetClass === "us_option" || rawAssetClass === "option"
          ? "us_option"
          : null;
    const qty = Math.abs(numberField(position.qty));
    const qtyAvailable = Math.max(0, numberField(position.qty_available, qty));
    const unrealizedPlpc = numberField(position.unrealized_plpc);

    if (!assetClass) {
      skipped.push({
        symbol,
        assetClass: String(position.asset_class || "unknown"),
        positionClass,
        reason: "UNSUPPORTED_ASSET_CLASS"
      });
      continue;
    }

    if (qty <= 0 || qtyAvailable <= 0) {
      skipped.push({
        symbol,
        assetClass,
        positionClass,
        reason: "NO_QTY_AVAILABLE",
        details: { qty: position.qty ?? null, qtyAvailable: position.qty_available ?? null }
      });
      continue;
    }

    if (isActiveSellOrderFor(orders, symbol)) {
      skipped.push({
        symbol,
        assetClass,
        positionClass,
        reason: "EXIT_ORDER_ALREADY_OPEN"
      });
      continue;
    }

    if (assetClass === "us_equity") {
      if (!includeEquities) {
        skipped.push({ symbol, assetClass, positionClass, reason: "EQUITY_EXIT_DISABLED" });
        continue;
      }
      const currentPrice = equityCurrentPrice(position, stockSnapshots[symbol], qty);
      const value = Math.abs(marketValue(position));
      if (value < equityRules.minPositionMarketValue) {
        skipped.push({
          symbol,
          assetClass,
          positionClass,
          reason: "EQUITY_BELOW_MIN_POSITION_MARKET_VALUE",
          details: { marketValue: value }
        });
        continue;
      }
      const reason = resolveEquityReason(unrealizedPlpc, equityRules);
      if (!reason) {
        skipped.push({ symbol, assetClass, positionClass, reason: "NO_EXIT_RULE_TRIGGERED" });
        continue;
      }
      const orderPayload = buildOrderPayload({
        assetClass,
        symbol,
        qty: qtyString(qtyAvailable),
        orderType: "market",
        reason,
        generatedAt,
        index: candidates.length
      });
      candidates.push(
        orderPayloadToCandidate({
          position,
          assetClass,
          positionClass,
          qty,
          qtyAvailable,
          avgEntryPrice: avgEntryPrice(position, qty),
          currentPrice,
          reason,
          orderPayload
        })
      );
      continue;
    }

    if (!includeOptions) {
      skipped.push({ symbol, assetClass, positionClass, reason: "OPTION_EXIT_DISABLED" });
      continue;
    }
    if (positionClass === "option_leaps") {
      if (!includeLEAPS) {
        skipped.push({
          symbol,
          assetClass,
          positionClass,
          reason: "LEAPS_SKIPPED_BY_DEFAULT"
        });
        continue;
      }

      const optionSnapshot = optionSnapshots[symbol];
      const currentPrice = optionCurrentPrice(position, optionSnapshot, qty);
      if (currentPrice < leapsRules.minSellableOptionValue) {
        skipped.push({
          symbol,
          assetClass,
          positionClass,
          reason: "LEAPS_BELOW_MIN_SELLABLE_VALUE",
          details: {
            currentPrice,
            minSellableOptionValue: leapsRules.minSellableOptionValue
          }
        });
        continue;
      }

      const reason = resolveLeapsReason(unrealizedPlpc, dte, leapsRules);
      if (!reason) {
        skipped.push({ symbol, assetClass, positionClass, reason: "NO_EXIT_RULE_TRIGGERED" });
        continue;
      }

      const quote = normalizeOptionQuote(optionQuoteInput(symbol, optionSnapshot), new Date(generatedAt));
      if (quote.quoteStatus !== "valid" || quote.bid === null || quote.bid <= 0) {
        skipped.push({
          symbol,
          assetClass,
          positionClass,
          reason: "LEAPS_QUOTE_UNAVAILABLE",
          details: { triggerReason: reason, quoteStatus: quote.quoteStatus, rejectionReason: quote.rejectionReason }
        });
        continue;
      }

      const limitPrice = moneyString(roundOptionLimitPrice(quote.bid));
      const orderPayload = buildOrderPayload({
        assetClass,
        symbol,
        qty: qtyString(qtyAvailable),
        orderType: "limit",
        reason,
        generatedAt,
        index: candidates.length,
        limitPrice
      });
      candidates.push(
        orderPayloadToCandidate({
          position,
          assetClass,
          positionClass,
          qty,
          qtyAvailable,
          avgEntryPrice: avgEntryPrice(position, qty),
          currentPrice,
          reason,
          orderPayload
        })
      );
      continue;
    }
    if (positionClass !== "option_0dte") {
      skipped.push({
        symbol,
        assetClass,
        positionClass,
        reason: "OPTION_EXIT_RULE_NOT_CONFIGURED"
      });
      continue;
    }
    if (!include0DTE) {
      skipped.push({ symbol, assetClass, positionClass, reason: "ODTE_EXIT_DISABLED" });
      continue;
    }

    const optionSnapshot = optionSnapshots[symbol];
    const currentPrice = optionCurrentPrice(position, optionSnapshot, qty);
    if (currentPrice < optionRules.minSellableOptionValue) {
      skipped.push({
        symbol,
        assetClass,
        positionClass,
        reason: "ODTE_BELOW_MIN_SELLABLE_VALUE",
        details: {
          currentPrice,
          minSellableOptionValue: optionRules.minSellableOptionValue
        }
      });
      continue;
    }

    const reason = resolve0DteReason(unrealizedPlpc, minutesToClose, optionRules);
    if (!reason) {
      skipped.push({ symbol, assetClass, positionClass, reason: "NO_EXIT_RULE_TRIGGERED" });
      continue;
    }

    const quote = normalizeOptionQuote(optionQuoteInput(symbol, optionSnapshot), new Date(generatedAt));
    if (quote.quoteStatus === "stale") {
      skipped.push({
        symbol,
        assetClass,
        positionClass,
        reason: "OPTION_QUOTE_STALE",
        details: { triggerReason: reason, quoteTimestamp: quote.quoteTimestamp }
      });
      continue;
    }
    if (quote.quoteStatus !== "valid" || quote.bid === null || quote.bid <= 0) {
      skipped.push({
        symbol,
        assetClass,
        positionClass,
        reason: "OPTION_QUOTE_UNAVAILABLE",
        details: { triggerReason: reason, quoteStatus: quote.quoteStatus, rejectionReason: quote.rejectionReason }
      });
      continue;
    }

    const limitPrice = moneyString(roundOptionLimitPrice(quote.bid));
    const orderPayload = buildOrderPayload({
      assetClass,
      symbol,
      qty: qtyString(qtyAvailable),
      orderType: "limit",
      reason,
      generatedAt,
      index: candidates.length,
      limitPrice
    });
    candidates.push(
      orderPayloadToCandidate({
        position,
        assetClass,
        positionClass,
        qty,
        qtyAvailable,
        avgEntryPrice: avgEntryPrice(position, qty),
        currentPrice,
        reason,
        orderPayload
      })
    );
  }

  const status: PaperExitStatus =
    reconciliationStatus === "warning" || events.length > 0 || skipped.length > 0 ? "warning" : "ok";

  return {
    status,
    environment: "paper",
    mutationAttempted: false,
    generatedAt,
    account: {
      cash: numberField(account.cash),
      equity: numberField(account.equity ?? account.portfolio_value),
      buyingPower: numberField(account.buying_power),
      positionMarketValue: accountPositionMarketValue
    },
    reconciliation: {
      status: reconciliationStatus,
      sumPositionsMarketValue,
      accountPositionMarketValue,
      events
    },
    exitCandidates: candidates,
    skipped,
    alpacaRequestIds
  };
};

const pad = (value: string, width: number, right = false) =>
  right ? value.padStart(width, " ") : value.padEnd(width, " ");

export const formatPaperExitReviewAsTable = (result: PaperExitReviewResult): string => {
  const lines: string[] = [];
  lines.push("Paper Exit Review");
  lines.push(`Environment: ${result.environment}`);
  lines.push(`Status: ${result.status}`);
  if (result.blockReason) {
    lines.push(`Block reason: ${result.blockReason}`);
  }
  lines.push(`Mutation attempted: ${String(result.mutationAttempted)}`);
  lines.push(`Position market value: account=${result.reconciliation.accountPositionMarketValue.toFixed(2)} positions=${result.reconciliation.sumPositionsMarketValue.toFixed(2)}`);
  lines.push("Exit candidates:");
  lines.push(
    [
      pad("Class", 18),
      pad("Symbol", 24),
      pad("Qty", 10, true),
      pad("P/L %", 10, true),
      pad("Order", 8),
      pad("Limit", 10, true),
      "Reason"
    ].join(" ")
  );
  if (!result.exitCandidates.length) {
    lines.push("- None");
  } else {
    for (const candidate of result.exitCandidates) {
      lines.push(
        [
          pad(candidate.positionClass, 18),
          pad(candidate.symbol, 24),
          pad(candidate.qtyAvailable, 10, true),
          pad(`${(candidate.unrealizedPlpc * 100).toFixed(2)}%`, 10, true),
          pad(candidate.orderPayload.orderType, 8),
          pad(candidate.orderPayload.limitPrice ? `$${candidate.orderPayload.limitPrice}` : "-", 10, true),
          candidate.reason
        ].join(" ")
      );
    }
  }
  if (result.skipped.length) {
    lines.push("Skipped:");
    for (const skipped of result.skipped) {
      lines.push(`- ${skipped.symbol || "unknown"}: ${skipped.reason}`);
    }
  }
  if (result.reconciliation.events.length) {
    lines.push("Reconciliation events:");
    for (const event of result.reconciliation.events) {
      lines.push(`- ${event.symbol ? `${event.symbol}: ` : ""}${event.code}`);
    }
  }
  lines.push("Review only. No orders were submitted.");
  return lines.join("\n");
};
