import { getDb, queryAll, queryOne } from "../lib/db.js";
import {
  getAccount,
  listPaperAccountActivities,
  listPaperPositions,
  listRecentPaperOrders,
  type AlpacaAccountActivityRaw,
  type AlpacaAccountRaw,
  type AlpacaApiResponse,
  type AlpacaPositionRaw,
  type AlpacaSubmittedOrder
} from "./alpacaClient.js";
import {
  getLatestSuccessfulPaperExecutionCreatedAt,
  listSuccessfulPaperExecutionLedgerEntriesSince,
  type PaperExecutionLedgerEntry
} from "./paperExecutionLedgerService.js";
import { executionStateProjectionService } from "./executionStateProjectionService.js";
import { getTradingSafetyState } from "./tradingSafetyService.js";

export type PaperAccountReconciliationStatus = "ok" | "warning" | "blocked";
export type PaperReconciliationEventType =
  | "PAPER_POSITION_SYNC_PENDING"
  | "PAPER_POSITION_SYNC_RESTORED"
  | "PAPER_SYNC_POSITION_REMOVAL";

export interface PaperReconciliationEvent {
  type: PaperReconciliationEventType;
  symbol: string;
  expectedQuantity: string | null;
  recentBuyFillOrderIds: string[];
  ageMinutes: number | null;
  explanation: string;
}

export interface PaperAccountReconciliationReport {
  status: PaperAccountReconciliationStatus;
  reconciliationStatus: PaperAccountReconciliationStatus;
  code: "ACCOUNT_RECONCILIATION_MISMATCH" | null;
  mutationAttempted: false;
  since: string;
  reconciliationEvents: PaperReconciliationEvent[];
  paperSyncRemovedSymbols: string[];
  paperSyncPendingSymbols: string[];
  paperSyncRestoredSymbols: string[];
  missingSymbols: string[];
  expectedQuantities: Record<string, string | null>;
  recentBuyFillOrderIds: string[];
  sellFillsFound: boolean;
  nonFillAdjustmentActivitiesFound: boolean;
  accountCash: string | null;
  accountEquity: string | null;
  accountPositionMarketValue: string | null;
  sumPositionsMarketValue: number;
  alpacaRequestIds: {
    account?: string;
    positions?: string;
    orders?: string;
    activities?: string;
  };
  marketValueMismatch: boolean;
  accountMathMismatch: boolean;
  warnings: string[];
}

export interface PaperAccountReconciliationSnapshot {
  account: AlpacaAccountRaw;
  positions: AlpacaPositionRaw[];
  report: PaperAccountReconciliationReport;
}

export interface PaperAccountReconciliationDeps {
  getAccount?: typeof getAccount;
  listPaperPositions?: typeof listPaperPositions;
  listRecentPaperOrders?: typeof listRecentPaperOrders;
  listPaperAccountActivities?: typeof listPaperAccountActivities;
  now?: () => string;
}

interface ExpectedPosition {
  quantity: number;
  quantityKnown: boolean;
  recentBuyFillOrderIds: Set<string>;
  buyFillTimes: string[];
}

interface PriorReconciliationEventRow {
  symbol: string;
  event_type: PaperReconciliationEventType;
  created_at: string;
}

const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_SYNC_FRESHNESS_MINUTES = 36 * 60;
const MIN_MARKET_VALUE_TOLERANCE = 0.01;
const DEFAULT_POSITION_MARKET_VALUE_TOLERANCE_DOLLARS = 2;
const DEFAULT_POSITION_MARKET_VALUE_TOLERANCE_PCT = 0.0025;

const numericField = (value: unknown): number | null => {
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

const formatQuantity = (entry: ExpectedPosition): string | null => {
  if (!entry.quantityKnown) {
    return null;
  }
  const fixed = entry.quantity.toFixed(6);
  return fixed.replace(/\.?0+$/g, "") || "0";
};

const parsePositiveInteger = (value: string | undefined, fallback: number, max: number): number => {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(max, parsed);
};

const parsePositiveNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseFloat(value || "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseLookbackDays = (value: string | undefined): number | null => {
  const parsed = Number.parseFloat(value || "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const dateMinusDays = (isoDate: string, days: number): string => {
  const parsed = new Date(isoDate);
  const base = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  base.setUTCDate(base.getUTCDate() - days);
  return base.toISOString();
};

const normalizeIso = (value: string | undefined | null): string | null => {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const minutesBetween = (laterIso: string, earlierIso: string | null): number | null => {
  if (!earlierIso) {
    return null;
  }
  const later = new Date(laterIso).getTime();
  const earlier = new Date(earlierIso).getTime();
  if (Number.isNaN(later) || Number.isNaN(earlier)) {
    return null;
  }
  return Math.max(0, Math.round((later - earlier) / 60000));
};

const resolveReconciliationSince = (nowIso: string, postgresAuthority: boolean): string => {
  const explicitAfter =
    process.env.PAPER_RECONCILIATION_AFTER ||
    process.env.PAPER_ACCOUNT_RECONCILIATION_AFTER;
  if (explicitAfter && !Number.isNaN(new Date(explicitAfter).getTime())) {
    return new Date(explicitAfter).toISOString();
  }

  const configuredLookback = parseLookbackDays(process.env.PAPER_RECONCILIATION_LOOKBACK_DAYS);
  if (configuredLookback !== null) {
    return dateMinusDays(nowIso, configuredLookback);
  }

  if (!postgresAuthority) {
    const latestSuccessfulPaperRun = getLatestSuccessfulPaperExecutionCreatedAt();
    if (latestSuccessfulPaperRun && !Number.isNaN(new Date(latestSuccessfulPaperRun).getTime())) {
      return new Date(latestSuccessfulPaperRun).toISOString();
    }
  }

  return dateMinusDays(nowIso, DEFAULT_LOOKBACK_DAYS);
};

const syncFreshnessMinutes = () =>
  parsePositiveNumber(
    process.env.PAPER_POSITION_SYNC_FRESHNESS_MINUTES ||
      process.env.PAPER_RECONCILIATION_SYNC_FRESHNESS_MINUTES,
    DEFAULT_SYNC_FRESHNESS_MINUTES
  );

const ensureExpectedPosition = (
  expected: Map<string, ExpectedPosition>,
  symbol: string
): ExpectedPosition => {
  const existing = expected.get(symbol);
  if (existing) {
    return existing;
  }
  const created: ExpectedPosition = {
    quantity: 0,
    quantityKnown: true,
    recentBuyFillOrderIds: new Set(),
    buyFillTimes: []
  };
  expected.set(symbol, created);
  return created;
};

const addExpectedPosition = (
  expected: Map<string, ExpectedPosition>,
  symbol: string,
  quantity: number | null,
  orderId?: string,
  fillTime?: string | null
) => {
  if (!symbol) {
    return;
  }
  const entry = ensureExpectedPosition(expected, symbol);
  if (quantity === null) {
    entry.quantityKnown = false;
  } else {
    entry.quantity += quantity;
  }
  if (orderId) {
    entry.recentBuyFillOrderIds.add(orderId);
  }
  if (fillTime) {
    entry.buyFillTimes.push(fillTime);
  }
};

const subtractExpectedPosition = (
  expected: Map<string, ExpectedPosition>,
  symbol: string,
  quantity: number | null
) => {
  if (!symbol) {
    return;
  }
  const entry = ensureExpectedPosition(expected, symbol);
  if (quantity === null) {
    entry.quantityKnown = false;
  } else {
    entry.quantity -= quantity;
  }
};

const activityType = (activity: AlpacaAccountActivityRaw): string =>
  String(activity.activity_type || activity.type || "").trim().toUpperCase();

const activityOrderId = (activity: AlpacaAccountActivityRaw): string | undefined =>
  activity.order_id || activity.id;

const activityTime = (activity: AlpacaAccountActivityRaw): string | null =>
  normalizeIso(activity.transaction_time || activity.date || null);

const orderKey = (order: AlpacaSubmittedOrder): string | undefined =>
  order.id || order.client_order_id;

const orderTime = (order: AlpacaSubmittedOrder): string | null =>
  normalizeIso(order.filled_at || order.updated_at || order.submitted_at || order.created_at || null);

const orderIsFilled = (order: AlpacaSubmittedOrder): boolean => {
  const status = normalizeText(order.status);
  const filledQty = numericField(order.filled_qty) ?? 0;
  return status === "filled" || status === "partially_filled" || filledQty > 0;
};

const orderCanExplainClosure = (order: AlpacaSubmittedOrder): boolean => {
  if (normalizeText(order.side) !== "sell") {
    return false;
  }
  const status = normalizeText(order.status);
  return !["canceled", "expired", "rejected", "stopped"].includes(status);
};

const ledgerEntryCanImplyOpenPosition = (
  entry: PaperExecutionLedgerEntry,
  matchingOrder: AlpacaSubmittedOrder | undefined,
  countedOrderIds: Set<string>
): boolean => {
  const side = normalizeText(entry.side);
  if (side === "sell" && entry.assetClass !== "option") {
    return false;
  }
  if (side !== "buy" && !(entry.assetClass === "option" && side === "sell")) {
    return false;
  }
  if (!matchingOrder) {
    return true;
  }
  const key = orderKey(matchingOrder);
  if (key && countedOrderIds.has(key)) {
    return false;
  }
  return orderIsFilled(matchingOrder);
};

const sumPositionMarketValue = (positions: AlpacaPositionRaw[]): number =>
  Number(
    positions
      .reduce((total, position) => total + (numericField(position.market_value) ?? 0), 0)
      .toFixed(2)
  );

const positionMarketValueTolerance = (
  accountPositionMarketValue: number | null,
  sumPositionsMarketValue: number
): number => {
  const dollars = parsePositiveNumber(
    process.env.PAPER_POSITION_MARKET_VALUE_TOLERANCE_DOLLARS,
    DEFAULT_POSITION_MARKET_VALUE_TOLERANCE_DOLLARS
  );
  const pct = parsePositiveNumber(
    process.env.PAPER_POSITION_MARKET_VALUE_TOLERANCE_PCT,
    DEFAULT_POSITION_MARKET_VALUE_TOLERANCE_PCT
  );
  const basis = Math.max(Math.abs(accountPositionMarketValue ?? 0), Math.abs(sumPositionsMarketValue));
  return Math.max(MIN_MARKET_VALUE_TOLERANCE, dollars, basis * pct);
};

const materialAccountMathMismatch = (
  account: AlpacaAccountRaw,
  accountPositionMarketValue: number | null,
  sumPositionsMarketValue: number
): boolean => {
  const cash = numericField(account.cash);
  const equity = numericField(account.equity) ?? numericField(account.portfolio_value);
  if (accountPositionMarketValue === null || equity === null) {
    return true;
  }
  if (accountPositionMarketValue < -MIN_MARKET_VALUE_TOLERANCE || sumPositionsMarketValue < -MIN_MARKET_VALUE_TOLERANCE) {
    return true;
  }
  if (equity < -MIN_MARKET_VALUE_TOLERANCE) {
    return true;
  }
  if (cash !== null) {
    const impliedEquity = cash + accountPositionMarketValue;
    const tolerance = Math.max(1, Math.abs(equity) * 0.02);
    if (Math.abs(impliedEquity - equity) > tolerance) {
      return true;
    }
  }
  return false;
};

const latestPriorReconciliationEventsBySymbol = (): Map<string, PriorReconciliationEventRow> => {
  const rows = queryAll<PriorReconciliationEventRow>(`
    SELECT symbol, event_type, created_at
    FROM paper_reconciliation_events
    WHERE event_type IN (
      'PAPER_POSITION_SYNC_PENDING',
      'PAPER_SYNC_POSITION_REMOVAL'
    )
    ORDER BY created_at DESC, id DESC
  `);
  const latest = new Map<string, PriorReconciliationEventRow>();
  for (const row of rows) {
    if (!latest.has(row.symbol)) {
      latest.set(row.symbol, row);
    }
  }
  return latest;
};

const recordReconciliationEvent = (input: {
  event: PaperReconciliationEvent;
  status: PaperAccountReconciliationStatus;
  accountCash: string | null;
  accountEquity: string | null;
  accountPositionMarketValue: string | null;
  sumPositionsMarketValue: number;
  alpacaRequestIds: PaperAccountReconciliationReport["alpacaRequestIds"];
  sellFillsFound: boolean;
  nonFillAdjustmentActivitiesFound: boolean;
}) => {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT INTO paper_reconciliation_events(
        created_at,
        updated_at,
        symbol,
        event_type,
        status,
        expected_qty,
        recent_buy_fill_order_ids_json,
        sell_fills_found,
        non_fill_adjustment_activities_found,
        account_cash,
        account_equity,
        account_position_market_value,
        sum_positions_market_value,
        alpaca_request_ids_json,
        details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      now,
      now,
      input.event.symbol,
      input.event.type,
      input.status,
      input.event.expectedQuantity,
      JSON.stringify(input.event.recentBuyFillOrderIds),
      input.sellFillsFound ? 1 : 0,
      input.nonFillAdjustmentActivitiesFound ? 1 : 0,
      input.accountCash,
      input.accountEquity,
      input.accountPositionMarketValue,
      input.sumPositionsMarketValue,
      JSON.stringify(input.alpacaRequestIds),
      JSON.stringify(input.event)
    );
};

const oldestBuyFillTime = (entry: ExpectedPosition): string | null => {
  const sorted = entry.buyFillTimes
    .map(normalizeIso)
    .filter((value): value is string => Boolean(value))
    .sort();
  return sorted[0] ?? null;
};

export const reconcilePaperAccountBeforeExecution = async (
  deps: PaperAccountReconciliationDeps = {}
): Promise<PaperAccountReconciliationSnapshot> => {
  const now = deps.now?.() || new Date().toISOString();
  const state = getTradingSafetyState();
  const postgresAuthority = executionStateProjectionService.isAuthorityActive();
  const since = resolveReconciliationSince(now, postgresAuthority);
  const freshnessMinutes = syncFreshnessMinutes();
  const orderLimit = parsePositiveInteger(process.env.PAPER_RECONCILIATION_ORDER_LIMIT, 500, 500);
  const activityLimit = parsePositiveInteger(
    process.env.PAPER_RECONCILIATION_ACTIVITY_LIMIT,
    500,
    500
  );

  const getAccountFn = deps.getAccount ?? getAccount;
  const listPositionsFn = deps.listPaperPositions ?? listPaperPositions;
  const listOrdersFn = deps.listRecentPaperOrders ?? listRecentPaperOrders;
  const listActivitiesFn = deps.listPaperAccountActivities ?? listPaperAccountActivities;

  const [accountResponse, positionsResponse, ordersResponse, activitiesResponse] =
    await Promise.all([
      getAccountFn(),
      listPositionsFn(),
      listOrdersFn({ after: since, limit: orderLimit }),
      listActivitiesFn({ after: since, limit: activityLimit })
    ]) as [
      AlpacaApiResponse<AlpacaAccountRaw>,
      AlpacaApiResponse<AlpacaPositionRaw[]>,
      AlpacaApiResponse<AlpacaSubmittedOrder[]>,
      AlpacaApiResponse<AlpacaAccountActivityRaw[]>
    ];

  const account = accountResponse.data;
  const positions = Array.isArray(positionsResponse.data) ? positionsResponse.data : [];
  const orders = Array.isArray(ordersResponse.data) ? ordersResponse.data : [];
  const activities = Array.isArray(activitiesResponse.data) ? activitiesResponse.data : [];
  const expected = new Map<string, ExpectedPosition>();
  const sellClosureSymbols = new Set<string>();
  const sellFillSymbols = new Set<string>();
  const nonFillAdjustmentSymbols = new Set<string>();
  let globalNonFillAdjustmentFound = false;

  const fillActivityOrderIds = new Set<string>();
  for (const activity of activities) {
    const symbol = normalizeSymbol(activity.symbol);
    const type = activityType(activity);
    const side = normalizeText(activity.side);
    const quantity = numericField(activity.qty);
    const id = activityOrderId(activity);

    if (type !== "FILL") {
      if (type) {
        globalNonFillAdjustmentFound = globalNonFillAdjustmentFound || !symbol;
        if (symbol) {
          nonFillAdjustmentSymbols.add(symbol);
        }
      }
      continue;
    }

    if (id) {
      fillActivityOrderIds.add(id);
    }
    if (side === "buy") {
      addExpectedPosition(expected, symbol, quantity, id, activityTime(activity));
    }
    if (side === "sell") {
      subtractExpectedPosition(expected, symbol, quantity);
      sellClosureSymbols.add(symbol);
      sellFillSymbols.add(symbol);
    }
  }

  for (const order of orders) {
    const symbol = normalizeSymbol(order.symbol);
    const key = orderKey(order);
    const side = normalizeText(order.side);
    const quantity = numericField(order.filled_qty) ?? numericField(order.qty);

    if (side === "buy" && orderIsFilled(order) && (!key || !fillActivityOrderIds.has(key))) {
      addExpectedPosition(expected, symbol, quantity, key, orderTime(order));
    }
    if (orderCanExplainClosure(order)) {
      sellClosureSymbols.add(symbol);
    }
  }

  const ordersByClientId = new Map(
    orders
      .filter((order) => order.client_order_id)
      .map((order) => [String(order.client_order_id), order])
  );
  const ordersById = new Map(
    orders
      .filter((order) => order.id)
      .map((order) => [String(order.id), order])
  );

  if (!postgresAuthority) {
    for (const ledgerEntry of listSuccessfulPaperExecutionLedgerEntriesSince(since)) {
      const symbol = normalizeSymbol(ledgerEntry.symbol);
      const matchingOrder =
        (ledgerEntry.clientOrderId ? ordersByClientId.get(ledgerEntry.clientOrderId) : undefined) ||
        (ledgerEntry.alpacaOrderId ? ordersById.get(ledgerEntry.alpacaOrderId) : undefined);
      if (!ledgerEntryCanImplyOpenPosition(ledgerEntry, matchingOrder, fillActivityOrderIds)) {
        continue;
      }
      addExpectedPosition(
        expected,
        symbol,
        numericField(ledgerEntry.qty),
        ledgerEntry.alpacaOrderId || undefined,
        ledgerEntry.createdAt
      );
    }
  }

  const positionSymbols = new Set(
    positions
      .filter((position) => {
        const qty = numericField(position.qty);
        return qty === null || Math.abs(qty) > 0;
      })
      .map((position) => normalizeSymbol(position.symbol))
      .filter(Boolean)
  );
  const expectedQuantities: Record<string, string | null> = {};
  const missingSymbols: string[] = [];
  const events: PaperReconciliationEvent[] = [];
  const priorEvents = postgresAuthority
    ? new Map<string, PriorReconciliationEventRow>()
    : latestPriorReconciliationEventsBySymbol();

  for (const [symbol, entry] of [...expected.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    expectedQuantities[symbol] = formatQuantity(entry);
    const expectsOpenPosition = !entry.quantityKnown || entry.quantity > 0;
    const buyFillIds = [...entry.recentBuyFillOrderIds].sort();
    const oldestFillTime = oldestBuyFillTime(entry);
    const ageMinutes = minutesBetween(now, oldestFillTime);

    if (!expectsOpenPosition) {
      continue;
    }

    if (positionSymbols.has(symbol)) {
      if (priorEvents.has(symbol)) {
        events.push({
          type: "PAPER_POSITION_SYNC_RESTORED",
          symbol,
          expectedQuantity: formatQuantity(entry),
          recentBuyFillOrderIds: buyFillIds,
          ageMinutes,
          explanation:
            "A previously missing Alpaca paper position is now present in /v2/positions."
        });
      }
      continue;
    }

    if (sellClosureSymbols.has(symbol)) {
      continue;
    }

    missingSymbols.push(symbol);
    if (state.alpacaEnv !== "paper") {
      continue;
    }

    if (ageMinutes === null || ageMinutes <= freshnessMinutes) {
      events.push({
        type: "PAPER_POSITION_SYNC_PENDING",
        symbol,
        expectedQuantity: formatQuantity(entry),
        recentBuyFillOrderIds: buyFillIds,
        ageMinutes,
        explanation:
          "Recent Alpaca paper buy fill evidence exists, but /v2/positions has not synchronized the symbol yet."
      });
      continue;
    }

    if (!globalNonFillAdjustmentFound && !nonFillAdjustmentSymbols.has(symbol)) {
      events.push({
        type: "PAPER_SYNC_POSITION_REMOVAL",
        symbol,
        expectedQuantity: formatQuantity(entry),
        recentBuyFillOrderIds: buyFillIds,
        ageMinutes,
        explanation:
          "Stale Alpaca paper buy fill evidence is absent from /v2/positions after the sync window; current paper account state is trusted without inventing a sell."
      });
    }
  }

  const sumPositionsMarketValue = sumPositionMarketValue(positions);
  const accountPositionMarketValue = numericField(account.position_market_value);
  const marketValueMismatch =
    accountPositionMarketValue !== null &&
    Math.abs(accountPositionMarketValue - sumPositionsMarketValue) >
      positionMarketValueTolerance(accountPositionMarketValue, sumPositionsMarketValue);
  const accountMathMismatch = materialAccountMathMismatch(
    account,
    accountPositionMarketValue,
    sumPositionsMarketValue
  );
  const liveMissingMismatch = state.alpacaEnv !== "paper" && missingSymbols.length > 0;
  const blocked = marketValueMismatch || accountMathMismatch || liveMissingMismatch;
  const alpacaRequestIds = {
    account: accountResponse.requestId,
    positions: positionsResponse.requestId,
    orders: ordersResponse.requestId,
    activities: activitiesResponse.requestId
  };
  const paperSyncRemovedSymbols = events
    .filter((event) => event.type === "PAPER_SYNC_POSITION_REMOVAL")
    .map((event) => event.symbol);
  const paperSyncPendingSymbols = events
    .filter((event) => event.type === "PAPER_POSITION_SYNC_PENDING")
    .map((event) => event.symbol);
  const paperSyncRestoredSymbols = events
    .filter((event) => event.type === "PAPER_POSITION_SYNC_RESTORED")
    .map((event) => event.symbol);
  const recentBuyFillOrderIds = [...new Set(
    [...expected.values()].flatMap((entry) => [...entry.recentBuyFillOrderIds])
  )].sort();
  const warnings = [
    ...events.map((event) => `${event.type}: ${event.symbol}`),
    ...(marketValueMismatch
      ? [
          `account.position_market_value=${account.position_market_value} does not equal sum(/v2/positions.market_value)=${sumPositionsMarketValue.toFixed(2)}.`
        ]
      : []),
    ...(accountMathMismatch
      ? ["Account cash/equity/position_market_value failed internal consistency checks."]
      : []),
    ...(liveMissingMismatch
      ? ["Live account reconciliation found missing expected positions."]
      : [])
  ];
  const status: PaperAccountReconciliationStatus = blocked
    ? "blocked"
    : events.length || warnings.length
      ? "warning"
      : "ok";

  const report: PaperAccountReconciliationReport = {
    status,
    reconciliationStatus: status,
    code: blocked ? "ACCOUNT_RECONCILIATION_MISMATCH" : null,
    mutationAttempted: false,
    since,
    reconciliationEvents: events,
    paperSyncRemovedSymbols,
    paperSyncPendingSymbols,
    paperSyncRestoredSymbols,
    missingSymbols,
    expectedQuantities,
    recentBuyFillOrderIds,
    sellFillsFound: sellFillSymbols.size > 0,
    nonFillAdjustmentActivitiesFound:
      globalNonFillAdjustmentFound || nonFillAdjustmentSymbols.size > 0,
    accountCash: account.cash ?? null,
    accountEquity: account.equity ?? account.portfolio_value ?? null,
    accountPositionMarketValue: account.position_market_value ?? null,
    sumPositionsMarketValue,
    alpacaRequestIds,
    marketValueMismatch,
    accountMathMismatch,
    warnings
  };

  for (const event of events) {
    recordReconciliationEvent({
      event,
      status,
      accountCash: report.accountCash,
      accountEquity: report.accountEquity,
      accountPositionMarketValue: report.accountPositionMarketValue,
      sumPositionsMarketValue,
      alpacaRequestIds,
      sellFillsFound: report.sellFillsFound,
      nonFillAdjustmentActivitiesFound: report.nonFillAdjustmentActivitiesFound
    });
  }

  return {
    account,
    positions,
    report
  };
};

export const getLatestPaperReconciliationEventForTests = (
  symbol: string
): { eventType: string; detailsJson: string } | null => {
  const row = queryOne<{ event_type: string; details_json: string }>(
    `
    SELECT event_type, details_json
    FROM paper_reconciliation_events
    WHERE symbol = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    `,
    [normalizeSymbol(symbol)]
  );
  return row ? { eventType: row.event_type, detailsJson: row.details_json } : null;
};
