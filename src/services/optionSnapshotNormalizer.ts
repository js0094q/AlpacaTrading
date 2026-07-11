import { parseOptionSymbol } from "./optionSymbolService.js";

export type NormalizedOptionGreeks = {
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
};

export type NormalizedOptionSnapshot = {
  symbol: string;
  underlying: string;
  expiration: string;
  strike: number;
  optionType: "call" | "put";
  latestQuote: {
    bidPrice: number | null;
    askPrice: number | null;
    bidSize: number | null;
    askSize: number | null;
    timestamp: string | null;
  } | null;
  latestTrade: {
    price: number | null;
    size: number | null;
    timestamp: string | null;
  } | null;
  impliedVolatility: number | null;
  greeks: NormalizedOptionGreeks;
  snapshotTimestamp: string | null;
  normalizationPath: "current" | "legacy" | "mixed" | "none";
};

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;

const hasOwn = (value: UnknownRecord, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

const finiteNumber = (value: unknown): number | null => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const finiteField = (
  current: UnknownRecord | null,
  currentKeys: string[],
  legacy: UnknownRecord | null,
  legacyKeys = currentKeys
) => {
  for (const [record, keys] of [[current, currentKeys], [legacy, legacyKeys]] as const) {
    if (!record) continue;
    for (const key of keys) {
      const parsed = finiteNumber(record[key]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
};

const ISO_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

const isoTimestamp = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const match = value.match(ISO_TIMESTAMP_RE);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day ||
    hour > 23 || minute > 59 || second > 59
  ) {
    return null;
  }
  if (zone !== "Z") {
    const [offsetHour, offsetMinute] = zone.slice(1).split(":").map(Number);
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }
  const milliseconds = fraction ? `.${fraction.slice(0, 3).padEnd(3, "0")}` : "";
  const parsed = Date.parse(
    `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}${milliseconds}${zone}`
  );
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const timestampField = (
  current: UnknownRecord | null,
  currentKeys: string[],
  legacy: UnknownRecord | null,
  legacyKeys = currentKeys
) => {
  for (const [record, keys] of [[current, currentKeys], [legacy, legacyKeys]] as const) {
    if (!record) continue;
    for (const key of keys) {
      const parsed = isoTimestamp(record[key]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
};

const newestTimestamp = (values: Array<string | null>) =>
  values.reduce<string | null>((newest, value) => {
    if (!value) return newest;
    return !newest || Date.parse(value) > Date.parse(newest) ? value : newest;
  }, null);

export const normalizeOptionSnapshot = (
  symbol: string,
  raw: unknown
): NormalizedOptionSnapshot => {
  const parsedSymbol = parseOptionSymbol(symbol);
  if (!parsedSymbol.ok) {
    throw new Error(`${parsedSymbol.code}: ${parsedSymbol.message}`);
  }

  const value = asRecord(raw) ?? {};
  const currentQuote = asRecord(value.latestQuote);
  const legacyQuote = asRecord(value.latest_quote);
  const currentTrade = asRecord(value.latestTrade);
  const legacyTrade = asRecord(value.latest_trade);
  const currentGreeks = asRecord(value.greeks);
  const legacyGreeks = asRecord(value.Greeks);

  const currentSeen = [
    "snapshotTimestamp",
    "latestQuote",
    "latestTrade",
    "impliedVolatility",
    "greeks"
  ].some((key) => hasOwn(value, key));
  const legacySeen = [
    "snapshot_timestamp",
    "timestamp",
    "latest_quote",
    "latest_trade",
    "implied_volatility",
    "Greeks"
  ].some((key) => hasOwn(value, key));

  const quote = {
    bidPrice: finiteField(currentQuote, ["bidPrice", "bp", "b"], legacyQuote, ["bid_price", "bp", "b"]),
    askPrice: finiteField(currentQuote, ["askPrice", "ap", "a"], legacyQuote, ["ask_price", "ap", "a"]),
    bidSize: finiteField(currentQuote, ["bidSize", "bs"], legacyQuote, ["bid_size", "bs"]),
    askSize: finiteField(currentQuote, ["askSize", "as"], legacyQuote, ["ask_size", "as"]),
    timestamp: timestampField(currentQuote, ["timestamp", "t"], legacyQuote, ["timestamp", "t"])
  };
  const latestQuote = Object.values(quote).some((field) => field !== null) ? quote : null;

  const trade = {
    price: finiteField(currentTrade, ["price", "p"], legacyTrade),
    size: finiteField(currentTrade, ["size", "s"], legacyTrade),
    timestamp: timestampField(currentTrade, ["timestamp", "t"], legacyTrade)
  };
  const latestTrade = Object.values(trade).some((field) => field !== null) ? trade : null;

  const topLevelSnapshotTimestamp = timestampField(
    value,
    ["snapshotTimestamp"],
    value,
    ["snapshot_timestamp", "timestamp"]
  );

  return {
    symbol: parsedSymbol.normalizedSymbol,
    underlying: parsedSymbol.underlying,
    expiration: parsedSymbol.expirationDate,
    strike: parsedSymbol.strikePrice,
    optionType: parsedSymbol.optionType,
    latestQuote,
    latestTrade,
    impliedVolatility: finiteField(
      value,
      ["impliedVolatility"],
      value,
      ["implied_volatility"]
    ),
    greeks: {
      delta: finiteField(currentGreeks, ["delta"], legacyGreeks),
      gamma: finiteField(currentGreeks, ["gamma"], legacyGreeks),
      theta: finiteField(currentGreeks, ["theta"], legacyGreeks),
      vega: finiteField(currentGreeks, ["vega"], legacyGreeks),
      rho: finiteField(currentGreeks, ["rho"], legacyGreeks)
    },
    snapshotTimestamp: newestTimestamp([
      topLevelSnapshotTimestamp,
      latestQuote?.timestamp ?? null,
      latestTrade?.timestamp ?? null
    ]),
    normalizationPath: currentSeen && legacySeen
      ? "mixed"
      : currentSeen
        ? "current"
        : legacySeen
          ? "legacy"
          : "none"
  };
};
