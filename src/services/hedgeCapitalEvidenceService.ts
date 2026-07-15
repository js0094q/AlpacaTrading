import { canonicalJsonHash } from "../lib/canonicalJson.js";
import { parseOptionSymbol } from "./optionSymbolService.js";
import { classifyBrokerOrderStatus } from "./brokerOrderStatusService.js";

const OPTION_MULTIPLIER = 100;

const ACTIVE_LEDGER_STATUSES = new Set([
  "new",
  "accepted",
  "pending_new",
  "partially_filled",
  "accepted_for_bidding",
  "pending_replace",
  "pending_cancel",
  "held",
  "reserved",
  "attempted",
  "submitted",
  "partial"
]);

const FILLED_STATUSES = new Set(["filled", "partially_filled", "partial"]);

export interface HedgeCapitalPositionInput {
  symbol?: string;
  assetClass?: string;
  asset_class?: string;
  optionType?: string | null;
  quantity?: number | string | null;
  qty?: number | string | null;
  marketValue?: number | string | null;
  market_value?: number | string | null;
  costBasis?: number | string | null;
  cost_basis?: number | string | null;
}

export interface HedgeCapitalOrderInput {
  brokerOrderId?: string | null;
  id?: string | null;
  clientOrderId?: string | null;
  client_order_id?: string | null;
  symbol?: string;
  assetClass?: string;
  asset_class?: string;
  side?: string | null;
  positionIntent?: string | null;
  position_intent?: string | null;
  status?: string | null;
  quantity?: number | string | null;
  qty?: number | string | null;
  limitPrice?: number | string | null;
  limit_price?: number | string | null;
  filledQuantity?: number | string | null;
  filled_qty?: number | string | null;
  filledAveragePrice?: number | string | null;
  filled_avg_price?: number | string | null;
  createdAt?: string | null;
  created_at?: string | null;
  filledAt?: string | null;
  filled_at?: string | null;
}

export interface HedgeCapitalLedgerInput {
  ledgerId?: number | string;
  id?: number | string;
  mode?: string | null;
  strategy?: string | null;
  symbol?: string;
  side?: string | null;
  status?: string | null;
  quantity?: number | string | null;
  qty?: number | string | null;
  limitPrice?: number | string | null;
  estimatedPremium?: number | string | null;
  clientOrderId?: string | null;
  brokerOrderId?: string | null;
  alpacaOrderId?: string | null;
  createdAt?: string | null;
  rawResponse?: unknown;
  rawResponseJson?: string | null;
}

export interface HedgeCapitalEvidence {
  existingHedgeExposure: number | null;
  existingHedgePremium: number | null;
  reservedHedgePremium: number | null;
  dailyHedgePremiumUsed: number | null;
  completedHedgePremium: number | null;
  openHedgeOrderCount: number | null;
  complete: boolean;
  blockers: string[];
  fingerprint: string;
}

export interface HedgeCapitalEvidenceInput {
  asOf: string;
  allowedUnderlyings: string[];
  positions: HedgeCapitalPositionInput[];
  orders: HedgeCapitalOrderInput[];
  ledger: HedgeCapitalLedgerInput[];
  sourcesAvailable?: boolean;
}

interface HedgeEntryFragment {
  source: "broker" | "ledger";
  sourceId: string;
  aliases: string[];
  symbol: string;
  status: string;
  createdAt: string | null;
  filledAt: string | null;
  open: boolean;
  reservedPremium: number | null;
  actualPremium: number | null;
  fillObserved: boolean;
}

const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const nonNegative = (value: unknown): number | null => {
  const parsed = finite(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
};

const positive = (value: unknown): number | null => {
  const parsed = finite(value);
  return parsed !== null && parsed > 0 ? parsed : null;
};

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const normalized = (value: unknown) => String(value || "").trim().toLowerCase();
const symbolOf = (value: unknown) => String(value || "").trim().toUpperCase();
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

const parsedRecord = (value: unknown): Record<string, unknown> | null => {
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

const allowedPut = (
  symbol: string,
  allowedUnderlyings: Set<string>
) => {
  const parsed = parseOptionSymbol(symbol);
  return parsed.ok && parsed.optionType === "put" && allowedUnderlyings.has(parsed.underlying);
};

const identity = (kind: string, value: unknown): string | null => {
  const resolved = value === null || value === undefined ? null : String(value).trim();
  return resolved ? `${kind}:${resolved}` : null;
};

const aliases = (...values: Array<string | null>) =>
  unique(values.filter((value): value is string => Boolean(value)));

const remainingPremium = (input: {
  quantity: number | null;
  filledQuantity: number | null;
  limitPrice: number | null;
  estimatedPremium?: number | null;
  active: boolean;
}) => {
  if (!input.active) return 0;
  if (input.quantity !== null && input.limitPrice !== null) {
    const remainingQuantity = Math.max(0, input.quantity - Math.max(0, input.filledQuantity ?? 0));
    return roundMoney(remainingQuantity * input.limitPrice * OPTION_MULTIPLIER);
  }
  return input.estimatedPremium ?? null;
};

const brokerFragment = (
  row: HedgeCapitalOrderInput,
  index: number,
  allowedUnderlyings: Set<string>,
  blockers: string[]
): HedgeEntryFragment | null => {
  const symbol = symbolOf(row.symbol);
  const explicitOption = normalized(row.assetClass ?? row.asset_class).includes("option");
  const parsed = parseOptionSymbol(symbol);
  if (!parsed.ok) {
    if (explicitOption) blockers.push("HEDGE_CONTRACT_IDENTITY_EVIDENCE_REQUIRED");
    return null;
  }
  if (!allowedPut(symbol, allowedUnderlyings)) return null;
  const side = normalized(row.side);
  const intent = normalized(row.positionIntent ?? row.position_intent);
  if (!side) {
    blockers.push("HEDGE_ORDER_SIDE_EVIDENCE_REQUIRED");
    return null;
  }
  if (side !== "buy") return null;
  if (!intent) {
    blockers.push("HEDGE_ORDER_INTENT_EVIDENCE_REQUIRED");
    return null;
  }
  if (intent !== "buy_to_open") return null;
  const status = normalized(row.status);
  if (!status) {
    blockers.push("HEDGE_ORDER_STATUS_EVIDENCE_REQUIRED");
    return null;
  }
  const statusClassification = classifyBrokerOrderStatus(status);
  if (!statusClassification.known) {
    blockers.push("HEDGE_ORDER_STATUS_EVIDENCE_REQUIRED");
  }
  const quantity = positive(row.quantity ?? row.qty);
  const filledQuantity = nonNegative(row.filledQuantity ?? row.filled_qty);
  const limitPrice = positive(row.limitPrice ?? row.limit_price);
  const fillPrice = positive(row.filledAveragePrice ?? row.filled_avg_price);
  const fillObserved =
    FILLED_STATUSES.has(status) ||
    (filledQuantity !== null && filledQuantity > 0);
  const actualPremium =
    filledQuantity !== null && filledQuantity > 0 && fillPrice !== null
    ? roundMoney(filledQuantity * fillPrice * OPTION_MULTIPLIER)
    : null;
  const open = statusClassification.active && (
    quantity === null || filledQuantity === null || filledQuantity < quantity
  );
  return {
    source: "broker",
    sourceId: text(row.brokerOrderId ?? row.id) ?? text(row.clientOrderId ?? row.client_order_id) ?? `broker-${index}`,
    aliases: aliases(
      identity("broker", row.brokerOrderId ?? row.id),
      identity("client", row.clientOrderId ?? row.client_order_id)
    ),
    symbol,
    status,
    createdAt: text(row.createdAt ?? row.created_at),
    filledAt: text(row.filledAt ?? row.filled_at),
    open,
    reservedPremium: remainingPremium({
      quantity,
      filledQuantity,
      limitPrice,
      active: open
    }),
    actualPremium,
    fillObserved
  };
};

const ledgerFragment = (
  row: HedgeCapitalLedgerInput,
  allowedUnderlyings: Set<string>,
  blockers: string[]
): HedgeEntryFragment | null => {
  if (normalized(row.mode) !== "hedge-entry") return null;
  const symbol = symbolOf(row.symbol);
  if (!parseOptionSymbol(symbol).ok) {
    blockers.push("HEDGE_CONTRACT_IDENTITY_EVIDENCE_REQUIRED");
    return null;
  }
  if (!allowedPut(symbol, allowedUnderlyings)) return null;
  const side = normalized(row.side);
  if (!side) {
    blockers.push("HEDGE_ORDER_SIDE_EVIDENCE_REQUIRED");
    return null;
  }
  if (side !== "buy") return null;
  const raw = parsedRecord(row.rawResponse ?? row.rawResponseJson);
  const status = normalized(raw?.status ?? row.status);
  if (!status) {
    blockers.push("HEDGE_ORDER_STATUS_EVIDENCE_REQUIRED");
    return null;
  }
  const quantity = positive(row.quantity ?? row.qty);
  const filledQuantity = nonNegative(raw?.filled_qty);
  const limitPrice = positive(row.limitPrice);
  const estimatedPremium = positive(row.estimatedPremium);
  const fillPrice = positive(raw?.filled_avg_price);
  const fillObserved =
    FILLED_STATUSES.has(status) ||
    (filledQuantity !== null && filledQuantity > 0);
  const actualPremium =
    filledQuantity !== null && filledQuantity > 0 && fillPrice !== null
    ? roundMoney(filledQuantity * fillPrice * OPTION_MULTIPLIER)
    : null;
  const open = ACTIVE_LEDGER_STATUSES.has(status) && (
    quantity === null || filledQuantity === null || filledQuantity < quantity
  );
  return {
    source: "ledger",
    sourceId: String(row.ledgerId ?? row.id ?? "unknown"),
    aliases: aliases(
      identity("ledger", row.ledgerId ?? row.id),
      identity("broker", row.brokerOrderId ?? row.alpacaOrderId),
      identity("client", row.clientOrderId)
    ),
    symbol,
    status,
    createdAt: text(row.createdAt),
    filledAt: text(raw?.filled_at),
    open,
    reservedPremium: remainingPremium({
      quantity,
      filledQuantity,
      limitPrice,
      estimatedPremium,
      active: open
    }),
    actualPremium,
    fillObserved
  };
};

const grouped = (fragments: HedgeEntryFragment[]): HedgeEntryFragment[][] => {
  const parents = fragments.map((_, index) => index);
  const root = (index: number): number => {
    let value = index;
    while (parents[value] !== value) {
      parents[value] = parents[parents[value]];
      value = parents[value];
    }
    return value;
  };
  const union = (left: number, right: number) => {
    const leftRoot = root(left);
    const rightRoot = root(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const owners = new Map<string, number>();
  fragments.forEach((fragment, index) => {
    fragment.aliases.forEach((alias) => {
      const owner = owners.get(alias);
      if (owner === undefined) owners.set(alias, index);
      else union(index, owner);
    });
  });
  const results = new Map<number, HedgeEntryFragment[]>();
  fragments.forEach((fragment, index) => {
    const key = root(index);
    results.set(key, [...(results.get(key) ?? []), fragment]);
  });
  return [...results.values()];
};

const unavailableEvidence = (input: HedgeCapitalEvidenceInput): HedgeCapitalEvidence => {
  const blockers = ["HEDGE_CAPITAL_SOURCE_UNAVAILABLE", "HEDGE_CAPITAL_EVIDENCE_INCOMPLETE"];
  const counters = {
    existingHedgeExposure: null,
    existingHedgePremium: null,
    reservedHedgePremium: null,
    dailyHedgePremiumUsed: null,
    completedHedgePremium: null,
    openHedgeOrderCount: null
  };
  return {
    ...counters,
    complete: false,
    blockers,
    fingerprint: canonicalJsonHash({
      schema: "hedge-capital-evidence-v1",
      tradingDate: newYorkDate(input.asOf),
      counters,
      blockers
    })
  };
};

export const buildHedgeCapitalEvidence = (
  input: HedgeCapitalEvidenceInput
): HedgeCapitalEvidence => {
  if (
    input.sourcesAvailable === false ||
    !Array.isArray(input.positions) ||
    !Array.isArray(input.orders) ||
    !Array.isArray(input.ledger)
  ) {
    return unavailableEvidence(input);
  }
  const tradingDate = newYorkDate(input.asOf);
  if (!tradingDate) return unavailableEvidence(input);
  const allowedUnderlyings = new Set(input.allowedUnderlyings.map(symbolOf).filter(Boolean));
  const blockers: string[] = [];
  const normalizedPositions: Array<{
    symbol: string;
    quantity: number;
    marketValue: number | null;
    costBasis: number | null;
  }> = [];
  let positionExposureComplete = true;
  let positionPremiumComplete = true;
  for (const position of input.positions) {
    const symbol = symbolOf(position.symbol);
    const explicitOption = normalized(position.assetClass ?? position.asset_class).includes("option");
    const parsed = parseOptionSymbol(symbol);
    if (!parsed.ok) {
      if (explicitOption) blockers.push("HEDGE_CONTRACT_IDENTITY_EVIDENCE_REQUIRED");
      continue;
    }
    if (
      parsed.optionType !== "put" ||
      !allowedUnderlyings.has(parsed.underlying) ||
      (position.optionType && normalized(position.optionType) !== "put")
    ) {
      continue;
    }
    const quantity = finite(position.quantity ?? position.qty);
    if (quantity === null) {
      blockers.push("HEDGE_POSITION_QUANTITY_EVIDENCE_REQUIRED");
      positionExposureComplete = false;
      positionPremiumComplete = false;
      continue;
    }
    if (quantity <= 0) continue;
    const marketValue = nonNegative(position.marketValue ?? position.market_value);
    const costBasis = nonNegative(position.costBasis ?? position.cost_basis);
    if (marketValue === null) positionExposureComplete = false;
    if (costBasis === null) positionPremiumComplete = false;
    normalizedPositions.push({ symbol, quantity, marketValue, costBasis });
  }

  const fragments: HedgeEntryFragment[] = [];
  input.orders.forEach((order, index) => {
    const fragment = brokerFragment(order, index, allowedUnderlyings, blockers);
    if (fragment) fragments.push(fragment);
  });
  for (const row of input.ledger) {
    const fragment = ledgerFragment(row, allowedUnderlyings, blockers);
    if (fragment) fragments.push(fragment);
  }
  const groups = grouped(fragments);
  let reservationComplete = true;
  let dailyComplete = true;
  let completedComplete = true;
  let reservedHedgePremium = 0;
  let dailyHedgePremiumUsed = 0;
  let completedHedgePremium = 0;
  let openHedgeOrderCount = 0;
  const unmaterializedFills = new Map<string, number>();
  const positionSymbols = new Set(normalizedPositions.map((position) => position.symbol));

  for (const group of groups) {
    const open = group.some((fragment) => fragment.open);
    const reservationValues = group
      .filter((fragment) => fragment.open)
      .map((fragment) => fragment.reservedPremium)
      .filter((value): value is number => value !== null);
    if (open) {
      openHedgeOrderCount += 1;
      if (!reservationValues.length) reservationComplete = false;
      else reservedHedgePremium = roundMoney(reservedHedgePremium + Math.max(...reservationValues));
    }
    const fillObserved = group.some((fragment) => fragment.fillObserved);
    const actualValues = group
      .filter((fragment) => fragment.fillObserved)
      .map((fragment) => fragment.actualPremium)
      .filter((value): value is number => value !== null);
    const actualPremium = actualValues.length ? Math.max(...actualValues) : null;
    if (fillObserved && actualPremium === null) completedComplete = false;
    if (actualPremium !== null) {
      const fillDate = group
        .map((fragment) => newYorkDate(fragment.filledAt ?? fragment.createdAt))
        .find((value) => value !== null) ?? null;
      if (fillDate === null) {
        completedComplete = false;
        dailyComplete = false;
      } else if (fillDate === tradingDate) {
        completedHedgePremium = roundMoney(completedHedgePremium + actualPremium);
      }
      const symbol = group[0]?.symbol ?? "";
      if (symbol && !positionSymbols.has(symbol)) {
        unmaterializedFills.set(
          symbol,
          roundMoney((unmaterializedFills.get(symbol) ?? 0) + actualPremium)
        );
      }
    }
    const createdDates = group.map((fragment) => newYorkDate(fragment.createdAt));
    const dailyReservation = open
      ? (reservationValues.length ? Math.max(...reservationValues) : null)
      : 0;
    const dailyActual = actualPremium ?? (fillObserved ? null : 0);
    if (open || fillObserved) {
      if (createdDates.every((value) => value === null)) dailyComplete = false;
      if (dailyReservation === null || dailyActual === null) dailyComplete = false;
      else if (open || createdDates.includes(tradingDate)) {
        dailyHedgePremiumUsed = roundMoney(
          dailyHedgePremiumUsed + dailyReservation + dailyActual
        );
      }
    }
  }

  if (!positionExposureComplete) blockers.push("HEDGE_EXISTING_EXPOSURE_EVIDENCE_REQUIRED");
  if (!positionPremiumComplete) blockers.push("HEDGE_EXISTING_PREMIUM_EVIDENCE_REQUIRED");
  if (!reservationComplete) blockers.push("HEDGE_RESERVED_PREMIUM_EVIDENCE_REQUIRED");
  if (!dailyComplete) blockers.push("HEDGE_DAILY_PREMIUM_EVIDENCE_REQUIRED");
  if (!completedComplete) blockers.push("HEDGE_COMPLETED_PREMIUM_EVIDENCE_REQUIRED");
  if (blockers.length) blockers.push("HEDGE_CAPITAL_EVIDENCE_INCOMPLETE");
  const resolvedBlockers = unique(blockers);
  const unmaterializedPremium = [...unmaterializedFills.values()].reduce((sum, value) => sum + value, 0);
  const positionExposure = normalizedPositions.reduce((sum, position) => sum + (position.marketValue ?? 0), 0);
  const positionPremium = normalizedPositions.reduce((sum, position) => sum + (position.costBasis ?? 0), 0);
  const counters = {
    existingHedgeExposure: positionExposureComplete
      ? roundMoney(positionExposure + unmaterializedPremium)
      : null,
    existingHedgePremium: positionPremiumComplete
      ? roundMoney(positionPremium + unmaterializedPremium)
      : null,
    reservedHedgePremium: reservationComplete ? reservedHedgePremium : null,
    dailyHedgePremiumUsed: dailyComplete && completedComplete && reservationComplete
      ? dailyHedgePremiumUsed
      : null,
    completedHedgePremium: completedComplete ? completedHedgePremium : null,
    openHedgeOrderCount
  };
  const fingerprintPayload = {
    schema: "hedge-capital-evidence-v1",
    tradingDate,
    allowedUnderlyings: [...allowedUnderlyings].sort(),
    counters,
    blockers: resolvedBlockers,
    positions: normalizedPositions
      .map((position) => ({ ...position }))
      .sort((left, right) => left.symbol.localeCompare(right.symbol)),
    entryGroups: groups
      .map((group) => group.map((fragment) => ({
        source: fragment.source,
        sourceId: fragment.sourceId,
        aliases: [...fragment.aliases].sort(),
        symbol: fragment.symbol,
        status: fragment.status,
        createdAt: fragment.createdAt,
        filledAt: fragment.filledAt,
        open: fragment.open,
        reservedPremium: fragment.reservedPremium,
        actualPremium: fragment.actualPremium,
        fillObserved: fragment.fillObserved
      })).sort((left, right) => `${left.source}:${left.sourceId}`.localeCompare(`${right.source}:${right.sourceId}`)))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  };
  return {
    ...counters,
    complete: resolvedBlockers.length === 0,
    blockers: resolvedBlockers,
    fingerprint: canonicalJsonHash(fingerprintPayload)
  };
};
