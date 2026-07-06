import { queryAll } from "../lib/db.js";
import { dedupeSymbols, normalizeSymbol } from "../lib/utils.js";
import { getTradingSafetyState } from "./tradingSafetyService.js";
import {
  buildOptionContractsEndpoint,
  fetchOptionContracts,
  fetchOptionQuotes,
  fetchOptionSnapshots,
  type OptionChainFilters,
  type OptionContractRaw
} from "./providers/alpaca.js";

interface OptionsDiagnosticInput {
  underlyings?: string[];
  asOfDate?: string;
  leapsMinDte?: number;
  leapsMaxDte?: number;
  sampleSize?: number;
}

interface ProviderCheck {
  label: string;
  ok: boolean;
  provider: "alpaca";
  endpoint: string | null;
  contractsReturned: number;
  contractsByUnderlying: Record<string, number>;
  sampleContractSymbols: string[];
  zeroReason: string | null;
  error?: string | null;
}

interface QuoteAvailabilityReport {
  sampleSymbols: string[];
  samples: Array<{
    symbol: string;
    latestQuoteAvailable: boolean;
    snapshotAvailable: boolean;
    bid: number | null;
    ask: number | null;
    quoteTimestamp: string | null;
  }>;
  error: string | null;
}

export interface OptionsDiagnosticReport {
  paperOnly: boolean;
  nonMutating: true;
  generatedAt: string;
  provider: "alpaca";
  underlyings: string[];
  asOfDate: string;
  leapsRange: {
    minDte: number;
    maxDte: number;
  };
  localCache: {
    table: "option_contracts";
    queriedUnderlyings: string[];
    counts: Array<{
      underlying: string;
      contracts: number;
      firstExpiration: string | null;
      lastExpiration: string | null;
    }>;
  };
  providerChecks: ProviderCheck[];
  sameDaySpy: {
    date: string;
    contractsReturned: number;
    sampleContractSymbols: string[];
  };
  leaps: {
    minDte: number;
    maxDte: number;
    contractsByUnderlying: Record<string, number>;
    sampleContractSymbols: string[];
  };
  quoteAvailability: QuoteAvailabilityReport;
  zeroContractsReason: string | null;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const todayIsoDate = () => new Date().toISOString().slice(0, 10);

const parseIntegerEnv = (name: string, fallback: number) => {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const validDateOnly = (value: string) => {
  if (!ISO_DATE_RE.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const utc = Date.UTC(year!, month! - 1, day!);
  return !Number.isNaN(utc) && new Date(utc).toISOString().slice(0, 10) === value;
};

const sanitizeError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 220 ? `${message.slice(0, 220)}...` : message;
};

const contractSymbol = (contract: OptionContractRaw) => normalizeSymbol(contract.symbol || "");

const byUnderlying = (contracts: OptionContractRaw[]) => {
  const counts: Record<string, number> = {};
  contracts.forEach((contract) => {
    const underlying = normalizeSymbol(contract.underlying_symbol || "");
    if (!underlying) {
      return;
    }
    counts[underlying] = (counts[underlying] || 0) + 1;
  });
  return counts;
};

const sampleSymbols = (contracts: OptionContractRaw[], sampleSize: number) =>
  Array.from(new Set(contracts.map(contractSymbol).filter(Boolean))).slice(0, sampleSize);

const localCacheCounts = (underlyings: string[]) => {
  if (!underlyings.length) {
    return [];
  }
  return queryAll<{
    underlying: string;
    contracts: number;
    firstExpiration: string | null;
    lastExpiration: string | null;
  }>(
    `
    SELECT
      underlying_symbol AS underlying,
      COUNT(*) AS contracts,
      MIN(expiration_date) AS firstExpiration,
      MAX(expiration_date) AS lastExpiration
    FROM option_contracts
    WHERE underlying_symbol IN (${underlyings.map(() => "?").join(",")})
    GROUP BY underlying_symbol
    ORDER BY underlying_symbol ASC
    `,
    underlyings
  );
};

const providerCheck = async (
  label: string,
  filters: OptionChainFilters,
  sampleSize: number
): Promise<{ check: ProviderCheck; contracts: OptionContractRaw[] }> => {
  let endpoint: string | null = null;
  try {
    endpoint = buildOptionContractsEndpoint(filters);
    const contracts = await fetchOptionContracts(filters);
    return {
      check: {
        label,
        ok: true,
        provider: "alpaca",
        endpoint,
        contractsReturned: contracts.length,
        contractsByUnderlying: byUnderlying(contracts),
        sampleContractSymbols: sampleSymbols(contracts, sampleSize),
        zeroReason: contracts.length === 0 ? "PROVIDER_RETURNED_ZERO_CONTRACTS" : null
      },
      contracts
    };
  } catch (error) {
    return {
      check: {
        label,
        ok: false,
        provider: "alpaca",
        endpoint,
        contractsReturned: 0,
        contractsByUnderlying: {},
        sampleContractSymbols: [],
        zeroReason: "PROVIDER_ERROR",
        error: sanitizeError(error)
      },
      contracts: []
    };
  }
};

const emptyQuoteAvailability = async (): Promise<QuoteAvailabilityReport> => ({
  sampleSymbols: [],
  samples: [],
  error: null
});

const quoteAvailability = async (symbols: string[]): Promise<QuoteAvailabilityReport> => {
  if (!symbols.length) {
    return emptyQuoteAvailability();
  }
  try {
    const [snapshots, quotes] = await Promise.all([
      fetchOptionSnapshots(symbols),
      fetchOptionQuotes(symbols)
    ]);
    const snapshotsBySymbol = new Map(snapshots.map((row) => [normalizeSymbol(row.symbol), row.raw]));
    const quotesBySymbol = new Map(quotes.map((row) => [normalizeSymbol(row.symbol), row.raw]));
    return {
      sampleSymbols: symbols,
      samples: symbols.map((symbol) => {
        const normalized = normalizeSymbol(symbol);
        const quote = quotesBySymbol.get(normalized);
        const snapshot = snapshotsBySymbol.get(normalized);
        return {
          symbol: normalized,
          latestQuoteAvailable: Boolean(quote),
          snapshotAvailable: Boolean(snapshot),
          bid: quote?.bp ?? quote?.b ?? snapshot?.latest_quote?.bp ?? snapshot?.latest_quote?.b ?? null,
          ask: quote?.ap ?? quote?.a ?? snapshot?.latest_quote?.ap ?? snapshot?.latest_quote?.a ?? null,
          quoteTimestamp: quote?.t ?? snapshot?.latest_quote?.t ?? snapshot?.latest_trade?.t ?? null
        };
      }),
      error: null
    };
  } catch (error) {
    return {
      sampleSymbols: symbols,
      samples: [],
      error: sanitizeError(error)
    };
  }
};

const emptySameDaySpy = (date: string) => ({
  date,
  contractsReturned: 0,
  sampleContractSymbols: []
});

const emptyLeaps = (minDte: number, maxDte: number) => ({
  minDte,
  maxDte,
  contractsByUnderlying: {},
  sampleContractSymbols: []
});

export const buildOptionsDiagnosticReport = async (
  input: OptionsDiagnosticInput = {}
): Promise<OptionsDiagnosticReport> => {
  const generatedAt = new Date().toISOString();
  const state = getTradingSafetyState();
  const underlyings = dedupeSymbols(input.underlyings?.length ? input.underlyings : ["SPY", "QQQ"]);
  const sampleSize = Math.max(1, input.sampleSize ?? 3);
  const asOfDate = input.asOfDate || todayIsoDate();
  const leapsMinDte = input.leapsMinDte ?? parseIntegerEnv("PAPER_LEAPS_MIN_DTE", 180);
  const leapsMaxDte = input.leapsMaxDte ?? parseIntegerEnv("PAPER_LEAPS_MAX_DTE", 730);
  const localCache = {
    table: "option_contracts" as const,
    queriedUnderlyings: underlyings,
    counts: localCacheCounts(underlyings)
  };
  const localCacheEmpty = localCache.counts.reduce((sum, row) => sum + row.contracts, 0) === 0;

  if (!state.paperOnly) {
    return {
      paperOnly: state.paperOnly,
      nonMutating: true,
      generatedAt,
      provider: "alpaca",
      underlyings,
      asOfDate,
      leapsRange: { minDte: leapsMinDte, maxDte: leapsMaxDte },
      localCache,
      providerChecks: [],
      sameDaySpy: emptySameDaySpy(asOfDate),
      leaps: emptyLeaps(leapsMinDte, leapsMaxDte),
      quoteAvailability: await emptyQuoteAvailability(),
      zeroContractsReason: "READ_ONLY_PAPER_ENV_REQUIRED"
    };
  }

  if (!validDateOnly(asOfDate)) {
    return {
      paperOnly: true,
      nonMutating: true,
      generatedAt,
      provider: "alpaca",
      underlyings,
      asOfDate,
      leapsRange: { minDte: leapsMinDte, maxDte: leapsMaxDte },
      localCache,
      providerChecks: [],
      sameDaySpy: emptySameDaySpy(asOfDate),
      leaps: emptyLeaps(leapsMinDte, leapsMaxDte),
      quoteAvailability: await emptyQuoteAvailability(),
      zeroContractsReason: `INVALID_DATE_FILTER: asOfDate=${asOfDate}; expected YYYY-MM-DD`
    };
  }

  if (leapsMinDte > leapsMaxDte) {
    return {
      paperOnly: true,
      nonMutating: true,
      generatedAt,
      provider: "alpaca",
      underlyings,
      asOfDate,
      leapsRange: { minDte: leapsMinDte, maxDte: leapsMaxDte },
      localCache,
      providerChecks: [],
      sameDaySpy: emptySameDaySpy(asOfDate),
      leaps: emptyLeaps(leapsMinDte, leapsMaxDte),
      quoteAvailability: await emptyQuoteAvailability(),
      zeroContractsReason: `INVALID_DTE_RANGE: minDte=${leapsMinDte} exceeds maxDte=${leapsMaxDte}`
    };
  }

  const defaultSpy = await providerCheck(
    "spy_contracts_default_window",
    { underlyingSymbols: ["SPY"] },
    sampleSize
  );
  const sameDaySpy = await providerCheck(
    "spy_same_day_contracts",
    { underlyingSymbols: ["SPY"], expirationDate: asOfDate },
    sampleSize
  );
  const leaps = await providerCheck(
    "leaps_contracts_configured_dte",
    {
      underlyingSymbols: underlyings,
      minDaysToExpiration: leapsMinDte,
      maxDaysToExpiration: leapsMaxDte
    },
    sampleSize
  );
  const providerChecks = [defaultSpy.check, sameDaySpy.check, leaps.check];
  const providerContractsAvailable = providerChecks.some((check) => check.contractsReturned > 0);
  const quoteSampleSymbols = Array.from(
    new Set([
      ...sameDaySpy.check.sampleContractSymbols.slice(0, 1),
      ...underlyings.flatMap((underlying) =>
        leaps.contracts
          .filter((contract) => normalizeSymbol(contract.underlying_symbol || "") === underlying)
          .map(contractSymbol)
          .filter(Boolean)
          .slice(0, 1)
      )
    ])
  ).slice(0, sampleSize);

  const zeroContractsReason =
    providerContractsAvailable
      ? localCacheEmpty
        ? "LOCAL_CACHE_EMPTY_PROVIDER_HAS_CONTRACTS"
        : null
      : providerChecks.every((check) => check.ok)
        ? "PROVIDER_RETURNED_ZERO_CONTRACTS_FOR_FILTERS"
        : "PROVIDER_ERROR";

  return {
    paperOnly: true,
    nonMutating: true,
    generatedAt,
    provider: "alpaca",
    underlyings,
    asOfDate,
    leapsRange: { minDte: leapsMinDte, maxDte: leapsMaxDte },
    localCache,
    providerChecks,
    sameDaySpy: {
      date: asOfDate,
      contractsReturned: sameDaySpy.check.contractsReturned,
      sampleContractSymbols: sameDaySpy.check.sampleContractSymbols
    },
    leaps: {
      minDte: leapsMinDte,
      maxDte: leapsMaxDte,
      contractsByUnderlying: leaps.check.contractsByUnderlying,
      sampleContractSymbols: leaps.check.sampleContractSymbols
    },
    quoteAvailability: await quoteAvailability(quoteSampleSymbols),
    zeroContractsReason
  };
};
