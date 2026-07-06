export type OptionQuoteStatus = "valid" | "missing" | "invalid" | "stale";

export type OptionExecutablePriceSource = "midpoint" | "ask" | "askFallback" | "last";

export interface RawOptionQuoteInput {
  optionSymbol: string;
  bid?: number | string | null;
  ask?: number | string | null;
  midpoint?: number | string | null;
  last?: number | string | null;
  timestamp?: string | Date | null;
}

export interface NormalizedOptionQuote {
  optionSymbol: string;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  last: number | null;
  quoteTimestamp: string | null;
  quoteStatus: OptionQuoteStatus;
  executable: boolean;
  executablePrice: number | null;
  executablePriceSource: OptionExecutablePriceSource | null;
  rejectionReason: string | null;
}

export interface NormalizeOptionQuoteOptions {
  allowLastPriceFallback?: boolean;
}

const parseBoolean = (value: string | undefined) => value === "true" || value === "1";

const parsePositiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const optionsQuoteConfig = () => ({
  maxAgeMs: parsePositiveInteger(process.env.OPTIONS_QUOTE_MAX_AGE_MS, 15 * 60 * 1000),
  allowLastPriceFallback: parseBoolean(process.env.ALLOW_OPTIONS_LAST_PRICE_FALLBACK),
  allow0DteOptions:
    process.env.ALLOW_0DTE_OPTIONS !== undefined
      ? parseBoolean(process.env.ALLOW_0DTE_OPTIONS)
      : process.env.PAPER_OPTIONS_ALLOW_0DTE !== undefined
        ? parseBoolean(process.env.PAPER_OPTIONS_ALLOW_0DTE)
        : false
});

const finitePositiveOrNull = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const parseTimestamp = (value: string | Date | null | undefined): Date | null => {
  if (!value) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const roundOptionLimitPrice = (price: number): number =>
  Math.round(price * 100) / 100;

const rejectedQuote = (
  base: Omit<NormalizedOptionQuote, "quoteStatus" | "executable" | "executablePrice" | "executablePriceSource" | "rejectionReason">,
  quoteStatus: Exclude<OptionQuoteStatus, "valid">,
  rejectionReason: string
): NormalizedOptionQuote => ({
  ...base,
  quoteStatus,
  executable: false,
  executablePrice: null,
  executablePriceSource: null,
  rejectionReason
});

const validQuote = (
  base: Omit<NormalizedOptionQuote, "quoteStatus" | "executable" | "executablePrice" | "executablePriceSource" | "rejectionReason">,
  executablePrice: number,
  executablePriceSource: OptionExecutablePriceSource
): NormalizedOptionQuote => ({
  ...base,
  quoteStatus: "valid",
  executable: true,
  executablePrice: roundOptionLimitPrice(executablePrice),
  executablePriceSource,
  rejectionReason: null
});

export const normalizeOptionQuote = (
  input: RawOptionQuoteInput,
  now: Date = new Date(),
  maxAgeMs = optionsQuoteConfig().maxAgeMs,
  options: NormalizeOptionQuoteOptions = {}
): NormalizedOptionQuote => {
  const bid = finitePositiveOrNull(input.bid);
  const ask = finitePositiveOrNull(input.ask);
  const last = finitePositiveOrNull(input.last);
  const quotedMidpoint = finitePositiveOrNull(input.midpoint);
  const timestamp = parseTimestamp(input.timestamp);
  const midpoint =
    bid !== null && ask !== null && ask >= bid
      ? roundOptionLimitPrice((bid + ask) / 2)
      : quotedMidpoint === null
        ? null
        : roundOptionLimitPrice(quotedMidpoint);
  const base = {
    optionSymbol: input.optionSymbol,
    bid,
    ask,
    midpoint,
    last,
    quoteTimestamp: timestamp ? timestamp.toISOString() : null
  };

  if (!timestamp) {
    return rejectedQuote(base, "missing", "quote_timestamp_missing");
  }

  if (now.getTime() - timestamp.getTime() > maxAgeMs) {
    return rejectedQuote(base, "stale", "quote_stale");
  }

  if (bid !== null && ask !== null && ask < bid) {
    return rejectedQuote(
      {
        ...base,
        midpoint: quotedMidpoint === null ? null : roundOptionLimitPrice(quotedMidpoint)
      },
      "invalid",
      "crossed_quote"
    );
  }

  if (bid !== null && ask !== null) {
    return validQuote(base, (bid + ask) / 2, "midpoint");
  }

  if (ask !== null) {
    return validQuote(base, ask, "askFallback");
  }

  if (last !== null && options.allowLastPriceFallback === true) {
    return validQuote(base, last, "last");
  }

  return rejectedQuote(base, "missing", "quote_unavailable");
};
