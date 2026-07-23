import { canonicalJsonHash } from "../../lib/canonicalJson.js";
import { queryAll } from "../../lib/db.js";
import type {
  AlpacaPositionRaw,
  AlpacaSubmittedOrder
} from "../alpacaClient.js";
import { parseOptionSymbol } from "../optionSymbolService.js";
import { classifyBrokerOrderStatus } from "../brokerOrderStatusService.js";

const OPTION_MULTIPLIER = 100;

const OPEN_LEDGER_STATUSES = new Set([
  "new",
  "accepted",
  "pending_new",
  "partially_filled",
  "accepted_for_bidding",
  "pending_replace",
  "pending_cancel",
  "held",
  "reserved",
  "submitted",
  "partial",
  "attempted",
  "intended"
]);

const COUNTABLE_ENTRY_STATUSES = new Set([
  ...OPEN_LEDGER_STATUSES,
  "filled",
  "open",
  "closed",
  "exited"
]);

export interface ZeroDteLedgerActivityRow {
  id: number | string;
  createdAt: string;
  assetClass: string;
  symbol: string;
  side: string | null;
  status: string;
  quantity: string | number | null;
  limitPrice: string | number | null;
  estimatedPremium: number | string | null;
  clientOrderId: string | null;
  brokerOrderId: string | null;
  rawResponse: unknown;
}

export interface ZeroDteLevel2ActivityRow {
  paperTradeId: string;
  sourceLedgerId: number | null;
  tradingDate: string;
  optionSymbol: string;
  status: string;
  quantity: number | null;
  entryPremium: number | null;
  realizedPnl: number | null;
  clientOrderId: string | null;
  brokerOrderId: string | null;
  requestedAt: string | null;
  filledAt: string | null;
  exitedAt: string | null;
}

export interface ZeroDteGenericPositionActivityRow {
  positionLifecycleId: string;
  optionSymbol: string;
  status: string;
  brokerEntryOrderId: string | null;
  entryClientOrderId: string | null;
  openedAt: string;
  closedAt: string | null;
  entryQuantity: number | string | null;
  entryPrice: number | string | null;
  realizedPnl: number | string | null;
  outcomeCompletenessStatus: string | null;
  latestOutcomeRevisionJson: string | null;
}

export interface ZeroDteActivityEvidenceInput {
  tradingDate: string;
  asOf: string;
  positions: AlpacaPositionRaw[];
  orders: AlpacaSubmittedOrder[];
}

export interface ZeroDteActivityEvidence {
  tradingDate: string;
  asOf: string;
  complete: boolean;
  dailyTradeCount: number | null;
  dailyPremium: number | null;
  dailyRealizedLoss: number | null;
  openPositionCount: number | null;
  openOrderCount: number | null;
  openExposureCount: number | null;
  blockers: string[];
  warnings: string[];
  evidenceFingerprint: string;
}

export interface ZeroDteActivityEvidenceSources {
  listLedgerActivity?: (
    input: Pick<ZeroDteActivityEvidenceInput, "tradingDate" | "asOf">
  ) => ZeroDteLedgerActivityRow[];
  listLevel2Activity?: (
    input: Pick<ZeroDteActivityEvidenceInput, "tradingDate" | "asOf">
  ) => ZeroDteLevel2ActivityRow[];
  listGenericPositionActivity?: (
    input: Pick<ZeroDteActivityEvidenceInput, "tradingDate" | "asOf">
  ) => ZeroDteGenericPositionActivityRow[];
}

interface ActivityFragment {
  source: "broker_order" | "broker_position" | "ledger" | "level2" | "position";
  sourceId: string;
  aliases: string[];
  symbol: string;
  status: string;
  entryAt: string | null;
  closedAt: string | null;
  countEntry: boolean;
  openOrder: boolean;
  openPosition: boolean;
  actualPremium: number | null;
  reservedPremium: number | null;
  completeFillPremium: boolean;
  realizedPnl: number | null;
  realizedOutcomeRequired: boolean;
  realizedOutcomeComplete: boolean;
}

const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const positive = (value: unknown): number | null => {
  const parsed = finite(value);
  return parsed !== null && parsed > 0 ? parsed : null;
};

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const normalizedSymbol = (value: unknown) => String(value || "").trim().toUpperCase();
const normalizedStatus = (value: unknown) => String(value || "").trim().toLowerCase();
const roundMoney = (value: number) => Math.round(value * 100) / 100;
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

const newYorkDate = (value: string | null): string | null => {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
};

const isTradingDateOption = (symbol: string, tradingDate: string) => {
  const parsed = parseOptionSymbol(symbol);
  return parsed.ok && parsed.expirationDate === tradingDate;
};

const identity = (kind: string, value: unknown): string | null => {
  const normalized = text(value);
  return normalized ? `${kind}:${normalized}` : null;
};

const aliases = (...values: Array<string | null>) => unique(values.filter((value): value is string => Boolean(value)));

const parsedObject = (value: unknown): Record<string, unknown> | null => {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

const ledgerRows = (): ZeroDteLedgerActivityRow[] =>
  queryAll<{
    id: number;
    created_at: string;
    asset_class: string;
    symbol: string;
    side: string | null;
    status: string;
    qty: string | null;
    limit_price: string | null;
    estimated_premium: number | null;
    client_order_id: string | null;
    alpaca_order_id: string | null;
    raw_response_json: string | null;
  }>(
    `SELECT id, created_at, asset_class, symbol, side, status, qty,
            limit_price, estimated_premium, client_order_id,
            alpaca_order_id, raw_response_json
     FROM paper_execution_ledger
     WHERE LOWER(asset_class) IN ('option', 'us_option')`
  ).map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    assetClass: row.asset_class,
    symbol: row.symbol,
    side: row.side,
    status: row.status,
    quantity: row.qty,
    limitPrice: row.limit_price,
    estimatedPremium: row.estimated_premium,
    clientOrderId: row.client_order_id,
    brokerOrderId: row.alpaca_order_id,
    rawResponse: parsedObject(row.raw_response_json)
  }));

const level2Rows = (tradingDate: string): ZeroDteLevel2ActivityRow[] =>
  queryAll<{
    paper_trade_id: string;
    source_ledger_id: number | null;
    trading_date: string;
    option_symbol: string;
    status: string;
    quantity: number | null;
    entry_premium: number | null;
    realized_pnl: number | null;
    client_order_id: string | null;
    broker_order_id: string | null;
    requested_at: string | null;
    filled_at: string | null;
    exited_at: string | null;
  }>(
    `SELECT paper_trade_id, source_ledger_id, trading_date, option_symbol,
            status, quantity, entry_premium, realized_pnl, client_order_id,
            broker_order_id, requested_at, filled_at, exited_at
     FROM zero_dte_paper_trades
     WHERE trading_date = ?
        OR LOWER(status) IN ('intended', 'submitted', 'partially_filled', 'open')`,
    [tradingDate]
  ).map((row) => ({
    paperTradeId: row.paper_trade_id,
    sourceLedgerId: row.source_ledger_id,
    tradingDate: row.trading_date,
    optionSymbol: row.option_symbol,
    status: row.status,
    quantity: row.quantity,
    entryPremium: row.entry_premium,
    realizedPnl: row.realized_pnl,
    clientOrderId: row.client_order_id,
    brokerOrderId: row.broker_order_id,
    requestedAt: row.requested_at,
    filledAt: row.filled_at,
    exitedAt: row.exited_at
  }));

const genericPositionRows = (): ZeroDteGenericPositionActivityRow[] =>
  queryAll<{
    position_lifecycle_id: string;
    option_symbol: string;
    status: string;
    broker_entry_order_id: string | null;
    entry_client_order_id: string | null;
    opened_at: string;
    closed_at: string | null;
    entry_quantity: number | null;
    entry_price: number | null;
    realized_pnl: number | null;
    completeness_status: string | null;
    corrected_fields_json: string | null;
  }>(
    `SELECT p.position_lifecycle_id, COALESCE(p.option_symbol, p.symbol) AS option_symbol, p.status,
            p.broker_entry_order_id, p.entry_client_order_id, p.opened_at,
            p.closed_at, p.entry_quantity, p.entry_price, o.realized_pnl,
            o.completeness_status,
            (SELECT r.corrected_fields_json
             FROM paper_position_outcome_revisions r
             WHERE r.outcome_id = o.outcome_id
             ORDER BY r.revision_number DESC
             LIMIT 1) AS corrected_fields_json
     FROM paper_positions p
     LEFT JOIN paper_position_outcomes o
       ON o.position_lifecycle_id = p.position_lifecycle_id
     WHERE LOWER(p.asset_class) IN ('option', 'us_option')`
  ).map((row) => ({
    positionLifecycleId: row.position_lifecycle_id,
    optionSymbol: row.option_symbol,
    status: row.status,
    brokerEntryOrderId: row.broker_entry_order_id,
    entryClientOrderId: row.entry_client_order_id,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    entryQuantity: row.entry_quantity,
    entryPrice: row.entry_price,
    realizedPnl: row.realized_pnl,
    outcomeCompletenessStatus: row.completeness_status,
    latestOutcomeRevisionJson: row.corrected_fields_json
  }));

const brokerOrderFragment = (
  row: AlpacaSubmittedOrder,
  index: number,
  tradingDate: string,
  blockers: string[]
): ActivityFragment | null => {
  const symbol = normalizedSymbol(row.symbol);
  const optionMaterial = normalizedStatus(row.asset_class) === "us_option" || parseOptionSymbol(symbol).ok;
  if (!optionMaterial) return null;
  const parsed = parseOptionSymbol(symbol);
  if (!parsed.ok) {
    blockers.push("ZERO_DTE_OPTION_IDENTITY_EVIDENCE_REQUIRED");
    return null;
  }
  if (parsed.expirationDate !== tradingDate) return null;
  const side = normalizedStatus(row.side);
  const intent = normalizedStatus(row.position_intent);
  if (side && side !== "buy") return null;
  if (intent && intent !== "buy_to_open") return null;
  const status = normalizedStatus(row.status);
  const statusClassification = classifyBrokerOrderStatus(status);
  if (!statusClassification.normalized || !statusClassification.known) {
    blockers.push("ZERO_DTE_ORDER_STATUS_EVIDENCE_REQUIRED");
  }
  const quantity = positive(row.qty);
  const filledQuantity = finite(row.filled_qty);
  const limitPrice = positive(row.limit_price);
  const fillPrice = positive(row.filled_avg_price);
  const hasFill = filledQuantity !== null && filledQuantity > 0;
  const countEntry = statusClassification.active || status === "filled" || hasFill;
  const actualPremium = hasFill && fillPrice !== null
    ? roundMoney(filledQuantity * fillPrice * OPTION_MULTIPLIER)
    : null;
  const reservedPremium = quantity !== null && limitPrice !== null
    ? roundMoney(quantity * limitPrice * OPTION_MULTIPLIER)
    : null;
  const completeFillPremium = actualPremium !== null && (
    status === "filled" || (quantity !== null && filledQuantity !== null && filledQuantity >= quantity)
  );
  const remaining = quantity === null || filledQuantity === null || filledQuantity < quantity;
  return {
    source: "broker_order",
    sourceId: text(row.id) ?? text(row.client_order_id) ?? `broker-order-${index}`,
    aliases: aliases(identity("broker", row.id), identity("client", row.client_order_id)),
    symbol,
    status,
    entryAt: text(row.created_at ?? row.submitted_at ?? row.filled_at),
    closedAt: null,
    countEntry,
    openOrder: statusClassification.active && remaining,
    openPosition: false,
    actualPremium,
    reservedPremium,
    completeFillPremium,
    realizedPnl: null,
    realizedOutcomeRequired: false,
    realizedOutcomeComplete: true
  };
};

const brokerPositionFragment = (
  row: AlpacaPositionRaw,
  index: number,
  tradingDate: string,
  blockers: string[]
): ActivityFragment | null => {
  const symbol = normalizedSymbol(row.symbol);
  const optionMaterial = normalizedStatus(row.asset_class) === "us_option" || parseOptionSymbol(symbol).ok;
  if (!optionMaterial) return null;
  const parsed = parseOptionSymbol(symbol);
  if (!parsed.ok) {
    blockers.push("ZERO_DTE_OPTION_IDENTITY_EVIDENCE_REQUIRED");
    return null;
  }
  const quantity = finite(row.qty);
  if (parsed.expirationDate !== tradingDate || quantity === null || quantity <= 0) return null;
  return {
    source: "broker_position",
    sourceId: `broker-position-${index}:${symbol}`,
    aliases: [],
    symbol,
    status: "open",
    entryAt: null,
    closedAt: null,
    countEntry: false,
    openOrder: false,
    openPosition: true,
    actualPremium: null,
    reservedPremium: null,
    completeFillPremium: false,
    realizedPnl: null,
    realizedOutcomeRequired: false,
    realizedOutcomeComplete: true
  };
};

const ledgerFragment = (
  row: ZeroDteLedgerActivityRow,
  tradingDate: string,
  blockers: string[]
): ActivityFragment | null => {
  const symbol = normalizedSymbol(row.symbol);
  if (!isTradingDateOption(symbol, tradingDate)) {
    if (normalizedStatus(row.assetClass).includes("option") && !parseOptionSymbol(symbol).ok) {
      blockers.push("ZERO_DTE_OPTION_IDENTITY_EVIDENCE_REQUIRED");
    }
    return null;
  }
  const side = normalizedStatus(row.side);
  if (side && side !== "buy" && side !== "buy_to_open") return null;
  const status = normalizedStatus(row.status);
  const raw = parsedObject(row.rawResponse);
  const rawStatus = normalizedStatus(raw?.status);
  const filledQuantity = finite(raw?.filled_qty);
  const fillPrice = positive(raw?.filled_avg_price);
  const quantity = positive(row.quantity);
  const limitPrice = positive(row.limitPrice);
  const hasFill = filledQuantity !== null && filledQuantity > 0;
  const effectiveStatus = rawStatus || status;
  const countEntry = COUNTABLE_ENTRY_STATUSES.has(effectiveStatus) || hasFill;
  const actualPremium = hasFill && fillPrice !== null
    ? roundMoney(filledQuantity * fillPrice * OPTION_MULTIPLIER)
    : null;
  const calculatedReservation = quantity !== null && limitPrice !== null
    ? quantity * limitPrice * OPTION_MULTIPLIER
    : null;
  const estimated = positive(row.estimatedPremium);
  const reservedPremium = estimated !== null || calculatedReservation !== null
    ? roundMoney(Math.max(estimated ?? 0, calculatedReservation ?? 0))
    : null;
  const completeFillPremium = actualPremium !== null && (
    effectiveStatus === "filled" || (quantity !== null && filledQuantity !== null && filledQuantity >= quantity)
  );
  const remaining = quantity === null || filledQuantity === null || filledQuantity < quantity;
  return {
    source: "ledger",
    sourceId: String(row.id),
    aliases: aliases(
      identity("ledger", row.id),
      identity("broker", row.brokerOrderId),
      identity("client", row.clientOrderId)
    ),
    symbol,
    status: effectiveStatus,
    entryAt: text(row.createdAt),
    closedAt: null,
    countEntry,
    openOrder: OPEN_LEDGER_STATUSES.has(effectiveStatus) && remaining,
    openPosition: false,
    actualPremium,
    reservedPremium,
    completeFillPremium,
    realizedPnl: null,
    realizedOutcomeRequired: false,
    realizedOutcomeComplete: true
  };
};

const level2Fragment = (
  row: ZeroDteLevel2ActivityRow,
  tradingDate: string,
  blockers: string[]
): ActivityFragment | null => {
  const symbol = normalizedSymbol(row.optionSymbol);
  if (!isTradingDateOption(symbol, tradingDate) || row.tradingDate !== tradingDate) {
    if (!parseOptionSymbol(symbol).ok) blockers.push("ZERO_DTE_OPTION_IDENTITY_EVIDENCE_REQUIRED");
    return null;
  }
  const status = normalizedStatus(row.status);
  const quantity = positive(row.quantity);
  const entryPrice = positive(row.entryPremium);
  const entryPremium = quantity !== null && entryPrice !== null
    ? roundMoney(quantity * entryPrice * OPTION_MULTIPLIER)
    : null;
  const closedAt = text(row.exitedAt);
  const outcomeRequired = ["closed", "exited"].includes(status) && newYorkDate(closedAt) === tradingDate;
  const realizedPnl = finite(row.realizedPnl);
  return {
    source: "level2",
    sourceId: row.paperTradeId,
    aliases: aliases(
      identity("level2", row.paperTradeId),
      identity("ledger", row.sourceLedgerId),
      identity("broker", row.brokerOrderId),
      identity("client", row.clientOrderId)
    ),
    symbol,
    status,
    entryAt: text(row.requestedAt ?? row.filledAt),
    closedAt,
    countEntry: COUNTABLE_ENTRY_STATUSES.has(status),
    openOrder: ["intended", "submitted", "partially_filled"].includes(status),
    openPosition: ["partially_filled", "open"].includes(status),
    actualPremium: ["partially_filled", "open", "closed", "exited"].includes(status)
      ? entryPremium
      : null,
    reservedPremium: entryPremium,
    completeFillPremium: ["open", "closed", "exited"].includes(status) && entryPremium !== null,
    realizedPnl,
    realizedOutcomeRequired: outcomeRequired,
    realizedOutcomeComplete: !outcomeRequired || realizedPnl !== null
  };
};

const genericPositionFragment = (
  row: ZeroDteGenericPositionActivityRow,
  tradingDate: string,
  blockers: string[]
): ActivityFragment | null => {
  const symbol = normalizedSymbol(row.optionSymbol);
  if (!isTradingDateOption(symbol, tradingDate)) {
    if (!parseOptionSymbol(symbol).ok) blockers.push("ZERO_DTE_OPTION_IDENTITY_EVIDENCE_REQUIRED");
    return null;
  }
  const status = normalizedStatus(row.status);
  const quantity = positive(row.entryQuantity);
  const price = positive(row.entryPrice);
  const entryPremium = quantity !== null && price !== null
    ? roundMoney(quantity * price * OPTION_MULTIPLIER)
    : null;
  const closedAt = text(row.closedAt);
  const outcomeRequired = status === "closed" && newYorkDate(closedAt) === tradingDate;
  let realizedPnl = finite(row.realizedPnl);
  let completeness = normalizedStatus(row.outcomeCompletenessStatus);
  if (row.latestOutcomeRevisionJson) {
    const revision = parsedObject(row.latestOutcomeRevisionJson);
    if (!revision) {
      blockers.push("ZERO_DTE_REALIZED_LOSS_EVIDENCE_REQUIRED");
      completeness = "";
      realizedPnl = null;
    } else {
      if ("realizedPnl" in revision || "realized_pnl" in revision) {
        realizedPnl = finite(revision.realizedPnl ?? revision.realized_pnl);
      }
      if ("completenessStatus" in revision || "completeness_status" in revision) {
        completeness = normalizedStatus(revision.completenessStatus ?? revision.completeness_status);
      }
    }
  }
  const outcomeComplete = !outcomeRequired || (
    realizedPnl !== null && completeness === "complete"
  );
  return {
    source: "position",
    sourceId: row.positionLifecycleId,
    aliases: aliases(
      identity("position", row.positionLifecycleId),
      identity("broker", row.brokerEntryOrderId),
      identity("client", row.entryClientOrderId)
    ),
    symbol,
    status,
    entryAt: text(row.openedAt),
    closedAt,
    countEntry: ["open", "closed"].includes(status),
    openOrder: false,
    openPosition: status === "open",
    actualPremium: entryPremium,
    reservedPremium: entryPremium,
    completeFillPremium: entryPremium !== null,
    realizedPnl,
    realizedOutcomeRequired: outcomeRequired,
    realizedOutcomeComplete: outcomeComplete
  };
};

const groupedFragments = (fragments: ActivityFragment[]): ActivityFragment[][] => {
  const parents = fragments.map((_, index) => index);
  const root = (index: number): number => {
    let value = index;
    while (parents[value] !== value) {
      parents[value] = parents[parents[value]];
      value = parents[value];
    }
    return value;
  };
  const join = (left: number, right: number) => {
    const leftRoot = root(left);
    const rightRoot = root(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const aliasOwner = new Map<string, number>();
  fragments.forEach((fragment, index) => {
    for (const alias of fragment.aliases) {
      const owner = aliasOwner.get(alias);
      if (owner === undefined) aliasOwner.set(alias, index);
      else join(index, owner);
    }
  });
  const groups = new Map<number, ActivityFragment[]>();
  fragments.forEach((fragment, index) => {
    const key = root(index);
    groups.set(key, [...(groups.get(key) ?? []), fragment]);
  });
  return [...groups.values()];
};

const groupPremium = (group: ActivityFragment[]): number | null => {
  const completeActual = group
    .filter((fragment) => fragment.completeFillPremium)
    .map((fragment) => fragment.actualPremium)
    .filter((value): value is number => value !== null);
  if (completeActual.length) return roundMoney(Math.max(...completeActual));
  const conservative = group
    .flatMap((fragment) => [fragment.actualPremium, fragment.reservedPremium])
    .filter((value): value is number => value !== null);
  return conservative.length ? roundMoney(Math.max(...conservative)) : null;
};

const sourceFailure = (
  input: ZeroDteActivityEvidenceInput,
  blockers: string[]
): ZeroDteActivityEvidence => {
  const resolvedBlockers = unique([
    ...blockers,
    "ZERO_DTE_ACTIVITY_SOURCE_UNAVAILABLE",
    "ZERO_DTE_ACTIVITY_EVIDENCE_INCOMPLETE"
  ]);
  const counters = {
    dailyTradeCount: null,
    dailyPremium: null,
    dailyRealizedLoss: null,
    openPositionCount: null,
    openOrderCount: null,
    openExposureCount: null
  };
  return {
    tradingDate: input.tradingDate,
    asOf: input.asOf,
    complete: false,
    ...counters,
    blockers: resolvedBlockers,
    warnings: [],
    evidenceFingerprint: canonicalJsonHash({
      schema: "zero-dte-activity-evidence-v1",
      tradingDate: input.tradingDate,
      asOf: input.asOf,
      counters,
      blockers: resolvedBlockers
    })
  };
};

export const buildZeroDteActivityEvidence = (
  input: ZeroDteActivityEvidenceInput,
  sources: ZeroDteActivityEvidenceSources = {}
): ZeroDteActivityEvidence => {
  const blockers: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.tradingDate) || !newYorkDate(input.asOf)) {
    return sourceFailure(input, ["ZERO_DTE_TRADING_DATE_EVIDENCE_REQUIRED"]);
  }
  let ledger: ZeroDteLedgerActivityRow[];
  let level2: ZeroDteLevel2ActivityRow[];
  let positions: ZeroDteGenericPositionActivityRow[];
  try {
    const sourceInput = { tradingDate: input.tradingDate, asOf: input.asOf };
    ledger = (sources.listLedgerActivity ?? (() => ledgerRows()))(sourceInput);
    level2 = (sources.listLevel2Activity ?? ((value) => level2Rows(value.tradingDate)))(sourceInput);
    positions = (sources.listGenericPositionActivity ?? (() => genericPositionRows()))(sourceInput);
    if (!Array.isArray(ledger) || !Array.isArray(level2) || !Array.isArray(positions)) {
      throw new Error("ZERO_DTE_ACTIVITY_SOURCE_INVALID");
    }
  } catch {
    return sourceFailure(input, blockers);
  }

  const fragments: ActivityFragment[] = [];
  input.orders.forEach((row, index) => {
    const fragment = brokerOrderFragment(row, index, input.tradingDate, blockers);
    if (fragment) fragments.push(fragment);
  });
  input.positions.forEach((row, index) => {
    const fragment = brokerPositionFragment(row, index, input.tradingDate, blockers);
    if (fragment) fragments.push(fragment);
  });
  for (const row of ledger) {
    const fragment = ledgerFragment(row, input.tradingDate, blockers);
    if (fragment) fragments.push(fragment);
  }
  for (const row of level2) {
    const fragment = level2Fragment(row, input.tradingDate, blockers);
    if (fragment) fragments.push(fragment);
  }
  for (const row of positions) {
    const fragment = genericPositionFragment(row, input.tradingDate, blockers);
    if (fragment) fragments.push(fragment);
  }

  const groups = groupedFragments(fragments);
  let dateEvidenceComplete = true;
  let premiumEvidenceComplete = true;
  let realizedLossEvidenceComplete = true;
  let dailyTradeCount = 0;
  let dailyPremium = 0;
  let dailyRealizedLoss = 0;
  const openPositionSymbols = new Set<string>();
  const openOrderGroups: string[] = [];
  const openExposureSymbols = new Set<string>();

  groups.forEach((group, groupIndex) => {
    const openPositions = group.filter((fragment) => fragment.openPosition);
    const openOrders = group.filter((fragment) => fragment.openOrder);
    for (const fragment of openPositions) {
      openPositionSymbols.add(fragment.symbol);
      openExposureSymbols.add(fragment.symbol);
    }
    if (openOrders.length) {
      openOrderGroups.push(String(groupIndex));
      for (const fragment of openOrders) openExposureSymbols.add(fragment.symbol);
    }

    const countable = group.filter((fragment) => fragment.countEntry);
    if (!countable.length) return;
    const dates = countable.map((fragment) => newYorkDate(fragment.entryAt));
    if (dates.some((date) => date === null)) {
      dateEvidenceComplete = false;
      return;
    }
    if (!dates.includes(input.tradingDate)) return;
    dailyTradeCount += 1;
    const premium = groupPremium(countable);
    if (premium === null) premiumEvidenceComplete = false;
    else dailyPremium = roundMoney(dailyPremium + premium);

    const outcomeRequired = group.some((fragment) => fragment.realizedOutcomeRequired);
    if (outcomeRequired) {
      const outcomes = group.filter(
        (fragment) => fragment.realizedOutcomeRequired &&
          fragment.realizedOutcomeComplete &&
          fragment.realizedPnl !== null
      );
      if (!outcomes.length) {
        realizedLossEvidenceComplete = false;
      } else {
        const groupLoss = Math.max(
          0,
          ...outcomes.map((fragment) => Math.max(0, -(fragment.realizedPnl ?? 0)))
        );
        dailyRealizedLoss = roundMoney(dailyRealizedLoss + groupLoss);
      }
    }
  });

  if (!dateEvidenceComplete) blockers.push("ZERO_DTE_TRADING_DATE_EVIDENCE_REQUIRED");
  if (!premiumEvidenceComplete) blockers.push("ZERO_DTE_DAILY_PREMIUM_EVIDENCE_REQUIRED");
  if (!realizedLossEvidenceComplete) blockers.push("ZERO_DTE_REALIZED_LOSS_EVIDENCE_REQUIRED");
  if (blockers.length) blockers.push("ZERO_DTE_ACTIVITY_EVIDENCE_INCOMPLETE");
  const resolvedBlockers = unique(blockers);
  const counters = {
    dailyTradeCount: dateEvidenceComplete ? dailyTradeCount : null,
    dailyPremium: dateEvidenceComplete && premiumEvidenceComplete ? dailyPremium : null,
    dailyRealizedLoss: dateEvidenceComplete && realizedLossEvidenceComplete
      ? dailyRealizedLoss
      : null,
    openPositionCount: openPositionSymbols.size,
    openOrderCount: openOrderGroups.length,
    openExposureCount: openExposureSymbols.size
  };
  const fingerprintPayload = {
    schema: "zero-dte-activity-evidence-v1",
    tradingDate: input.tradingDate,
    asOf: input.asOf,
    counters,
    blockers: resolvedBlockers,
    groups: groups.map((group) => group.map((fragment) => ({
      source: fragment.source,
      sourceId: fragment.sourceId,
      aliases: [...fragment.aliases].sort(),
      symbol: fragment.symbol,
      status: fragment.status,
      entryAt: fragment.entryAt,
      closedAt: fragment.closedAt,
      countEntry: fragment.countEntry,
      openOrder: fragment.openOrder,
      openPosition: fragment.openPosition,
      actualPremium: fragment.actualPremium,
      reservedPremium: fragment.reservedPremium,
      realizedPnl: fragment.realizedPnl,
      realizedOutcomeComplete: fragment.realizedOutcomeComplete
    })).sort((left, right) => `${left.source}:${left.sourceId}`.localeCompare(`${right.source}:${right.sourceId}`)))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  };
  return {
    tradingDate: input.tradingDate,
    asOf: input.asOf,
    complete: resolvedBlockers.length === 0,
    ...counters,
    blockers: resolvedBlockers,
    warnings: [],
    evidenceFingerprint: canonicalJsonHash(fingerprintPayload)
  };
};
