import { paperLeapsExitConfig } from "../config.js";
import { queryAll, queryOne } from "../lib/db.js";
import { normalizeSymbol } from "../lib/utils.js";
import { sma } from "./indicators.js";
import { optionDaysToExpiration, parseOptionSymbol } from "./optionSymbolService.js";
import type { AlpacaPositionSnapshot } from "./alpacaPositionService.js";

export type LeapsExitReasonCode =
  | "LEAPS_CLASSIFICATION_INFERRED"
  | "LEAPS_HARD_STOP_LOSS"
  | "LEAPS_FULL_PROFIT_TAKE"
  | "LEAPS_DTE_EXIT_WINDOW"
  | "LEAPS_SEVERE_TREND_BREAK"
  | "LEAPS_REVIEW_LOSS_WARNING"
  | "LEAPS_PARTIAL_PROFIT_REVIEW"
  | "LEAPS_TREND_REVIEW"
  | "LEAPS_DELTA_DETERIORATION"
  | "LEAPS_DELTA_UNAVAILABLE"
  | "LEAPS_PERIODIC_REVIEW_DUE"
  | "LIMIT_EXIT_REQUIRED"
  | "LEAPS_QUOTE_UNAVAILABLE";

export interface LeapsExitEvaluation {
  symbol: string;
  contractSymbol: string;
  classification: "LEAPS" | "NOT_LEAPS";
  classificationInferred: boolean;
  entryDte: number | null;
  currentDte: number | null;
  unrealizedPlPct: number | null;
  delta: number | null;
  bidAskSpreadPct: number | null;
  hardExit: boolean;
  reviewOnly: boolean;
  executable: boolean;
  section?: "optionSellToCloseExits";
  reasons: LeapsExitReasonCode[];
  underlyingClose: number | null;
  trendReviewSma: number | null;
  severeTrendExitSma: number | null;
  limitPrice: number | null;
  exitQuantity: number | null;
  partialExitCandidate: {
    supported: boolean;
    quantity: number;
    reason: "LEAPS_PARTIAL_PROFIT_REVIEW";
  } | null;
  lastReviewAt: string | null;
}

interface OptionMetadata {
  underlyingSymbol: string;
  contractSymbol: string;
  expirationDate: string | null;
  type: "call" | "put" | "unknown";
  multiplier: number;
}

interface LatestOptionSnapshotRow {
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  last: number | null;
  delta: number | null;
  timestamp: string;
  quote_timestamp: string | null;
}

interface EntryRecord {
  createdAt: string;
  entryDte: number | null;
  source: "learning" | "execution";
}

interface ReviewArtifactRow {
  created_at: string;
  artifact_json: string;
}

export interface LeapsExitReviewDeps {
  now?: () => string;
  optionMetadataForSymbol?: (contractSymbol: string) => OptionMetadata | null;
  latestOptionSnapshotForSymbol?: (contractSymbol: string) => LatestOptionSnapshotRow | null;
  entryRecordForSymbol?: (contractSymbol: string, expirationDate: string | null) => EntryRecord | null;
  lastReviewAtForSymbol?: (contractSymbol: string) => string | null;
  closesForSymbol?: (symbol: string, asOf: string, limit: number) => number[];
}

const unique = <T extends string>(values: T[]) => [...new Set(values)];

const numeric = (value: string | number | undefined | null): number | null => {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const pctFromPosition = (value: string | number | undefined | null): number | null => {
  const parsed = numeric(value);
  if (parsed === null) {
    return null;
  }
  return Math.abs(parsed) <= 10 ? parsed * 100 : parsed;
};

const roundMoney = (value: number) => Math.round(value * 100) / 100;
const roundPct = (value: number) => Math.round(value * 100) / 100;

export const daysToExpiration = (asOf: string, expirationDate: string | null): number | null => {
  if (!expirationDate) {
    return null;
  }
  const dte = optionDaysToExpiration(expirationDate, asOf);
  return dte === null ? null : Math.max(0, dte);
};

const occMetadata = (contractSymbol: string): OptionMetadata | null => {
  const parsed = parseOptionSymbol(contractSymbol);
  if (!parsed.ok) {
    return null;
  }
  return {
    underlyingSymbol: parsed.underlying,
    contractSymbol: parsed.normalizedSymbol,
    expirationDate: parsed.expirationDate,
    type: parsed.optionType,
    multiplier: 100
  };
};

export const optionMetadataForSymbol = (contractSymbol: string): OptionMetadata | null => {
  const normalized = contractSymbol.toUpperCase();
  const row = queryOne<{
    underlying_symbol: string;
    option_symbol: string;
    type: string;
    expiration_date: string;
    multiplier: number | null;
  }>(
    `
    SELECT underlying_symbol, option_symbol, type, expiration_date, multiplier
    FROM option_contracts
    WHERE option_symbol = ?
    LIMIT 1
    `,
    [normalized]
  );
  if (row) {
    return {
      underlyingSymbol: normalizeSymbol(row.underlying_symbol),
      contractSymbol: row.option_symbol.toUpperCase(),
      expirationDate: row.expiration_date,
      type: row.type === "call" || row.type === "put" ? row.type : "unknown",
      multiplier: numeric(row.multiplier) ?? 100
    };
  }
  return occMetadata(normalized);
};

const safeParse = <T>(value: string | null | undefined): T | null => {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

export const entryRecordForSymbol = (
  contractSymbol: string,
  expirationDate: string | null
): EntryRecord | null => {
  const normalized = contractSymbol.toUpperCase();
  const learning = queryOne<{
    created_at: string;
    option_metadata_json: string | null;
  }>(
    `
    SELECT created_at, option_metadata_json
    FROM paper_learning_records
    WHERE option_symbol = ?
      AND decision = 'submitted'
    ORDER BY created_at ASC
    LIMIT 1
    `,
    [normalized]
  );
  if (learning) {
    const metadata = safeParse<{ dte?: unknown; expirationDate?: string }>(learning.option_metadata_json);
    const metadataDte =
      typeof metadata?.dte === "string" || typeof metadata?.dte === "number"
        ? numeric(metadata.dte)
        : null;
    return {
      createdAt: learning.created_at,
      entryDte: metadataDte ?? daysToExpiration(learning.created_at, metadata?.expirationDate ?? expirationDate),
      source: "learning"
    };
  }

  const execution = queryOne<{
    created_at: string;
  }>(
    `
    SELECT created_at
    FROM paper_execution_ledger
    WHERE symbol = ?
      AND asset_class = 'option'
      AND side = 'buy'
      AND status IN ('attempted', 'submitted', 'accepted')
    ORDER BY created_at ASC, id ASC
    LIMIT 1
    `,
    [normalized]
  );
  if (!execution) {
    return null;
  }
  return {
    createdAt: execution.created_at,
    entryDte: daysToExpiration(execution.created_at, expirationDate),
    source: "execution"
  };
};

export const latestOptionSnapshotForSymbol = (
  contractSymbol: string
): LatestOptionSnapshotRow | null => {
  const row = queryOne<LatestOptionSnapshotRow>(
    `
    SELECT bid, ask, midpoint, last, delta, timestamp, quote_timestamp
    FROM option_snapshots
    WHERE option_symbol = ?
    ORDER BY timestamp DESC
    LIMIT 1
    `,
    [contractSymbol.toUpperCase()]
  );
  return row ?? null;
};

export const closesForSymbol = (
  symbol: string,
  asOf: string,
  limit: number
): number[] => {
  const rows = queryAll<{ close: number }>(
    `
    SELECT close
    FROM market_bars
    WHERE symbol = ?
      AND timeframe = '1Day'
      AND timestamp <= ?
    ORDER BY timestamp DESC
    LIMIT ?
    `,
    [normalizeSymbol(symbol), asOf, Math.max(1, limit)]
  );
  return rows.map((row) => row.close).reverse();
};

const artifactContainsSymbol = (artifactJson: string, contractSymbol: string): boolean => {
  const artifact = safeParse<{
    details?: {
      portfolioReview?: {
        leapsExitEvaluations?: Array<{ contractSymbol?: string }>;
        recommendations?: Array<{ symbol?: string; reason?: string; leapsExitEvaluation?: unknown }>;
      };
    };
  }>(artifactJson);
  const review = artifact?.details?.portfolioReview;
  if (!review) {
    return false;
  }
  if (
    review.leapsExitEvaluations?.some(
      (entry) => entry.contractSymbol?.toUpperCase() === contractSymbol
    )
  ) {
    return true;
  }
  return Boolean(
    review.recommendations?.some(
      (entry) =>
        entry.symbol?.toUpperCase() === contractSymbol &&
        (entry.leapsExitEvaluation || entry.reason?.startsWith("LEAPS_"))
    )
  );
};

export const lastReviewAtForSymbol = (contractSymbol: string): string | null => {
  const normalized = contractSymbol.toUpperCase();
  const rows = queryAll<ReviewArtifactRow>(
    `
    SELECT created_at, artifact_json
    FROM paper_review_artifacts
    WHERE source_action IN ('paper.ops.review', 'paper.ops.late_day', 'paper.portfolio.review')
    ORDER BY created_at DESC
    LIMIT 200
    `
  );
  const match = rows.find((row) => artifactContainsSymbol(row.artifact_json, normalized));
  return match?.created_at ?? null;
};

const bidAskSpreadPct = (bid: number | null, ask: number | null): number | null => {
  if (bid === null || ask === null || bid <= 0 || ask <= 0 || ask < bid) {
    return null;
  }
  const mid = (bid + ask) / 2;
  return mid > 0 ? roundPct(((ask - bid) / mid) * 100) : null;
};

const quoteLimitPrice = (snapshot: LatestOptionSnapshotRow | null): number | null => {
  if (!snapshot) {
    return null;
  }
  const bid = numeric(snapshot.bid);
  const ask = numeric(snapshot.ask);
  if (bid !== null && ask !== null && bid > 0 && ask > 0 && ask >= bid) {
    return roundMoney((bid + ask) / 2);
  }
  const midpoint = numeric(snapshot.midpoint);
  return midpoint !== null && midpoint > 0 ? roundMoney(midpoint) : null;
};

const daysSince = (from: string | null, to: string): number | null => {
  if (!from) {
    return null;
  }
  const days = optionDaysToExpiration(to.slice(0, 10), from);
  return days === null ? null : Math.max(0, days);
};

const classifyLeaps = (input: {
  entryDte: number | null;
  currentDte: number | null;
  minDteAtEntry: number;
}): { classification: "LEAPS" | "NOT_LEAPS"; inferred: boolean; entryDte: number | null } => {
  if (input.entryDte !== null) {
    return {
      classification: input.entryDte >= input.minDteAtEntry ? "LEAPS" : "NOT_LEAPS",
      inferred: false,
      entryDte: input.entryDte
    };
  }
  if (input.currentDte !== null && input.currentDte >= input.minDteAtEntry) {
    return {
      classification: "LEAPS",
      inferred: true,
      entryDte: input.currentDte
    };
  }
  return {
    classification: "NOT_LEAPS",
    inferred: false,
    entryDte: null
  };
};

export const classifyLeapsOptionPosition = (
  input: {
    contractSymbol: string;
    asOf?: string;
    minDteAtEntry?: number;
  },
  deps: LeapsExitReviewDeps = {}
) => {
  const asOf = input.asOf ?? deps.now?.() ?? new Date().toISOString();
  const metadata = (deps.optionMetadataForSymbol ?? optionMetadataForSymbol)(input.contractSymbol);
  const currentDte = daysToExpiration(asOf, metadata?.expirationDate ?? null);
  const entryRecord = (deps.entryRecordForSymbol ?? entryRecordForSymbol)(
    input.contractSymbol,
    metadata?.expirationDate ?? null
  );
  return classifyLeaps({
    entryDte: entryRecord?.entryDte ?? null,
    currentDte,
    minDteAtEntry: input.minDteAtEntry ?? paperLeapsExitConfig().minDteAtEntry
  });
};

export const evaluateLeapsExit = (
  position: AlpacaPositionSnapshot,
  deps: LeapsExitReviewDeps = {}
): LeapsExitEvaluation | null => {
  const generatedAt = deps.now?.() ?? new Date().toISOString();
  const cfg = paperLeapsExitConfig();
  const contractSymbol = position.symbol.toUpperCase();
  const metadata = (deps.optionMetadataForSymbol ?? optionMetadataForSymbol)(contractSymbol);
  if (!metadata) {
    return null;
  }

  const currentDte = daysToExpiration(generatedAt, metadata.expirationDate);
  const entryRecord = (deps.entryRecordForSymbol ?? entryRecordForSymbol)(
    contractSymbol,
    metadata.expirationDate
  );
  const classification = classifyLeaps({
    entryDte: entryRecord?.entryDte ?? null,
    currentDte,
    minDteAtEntry: cfg.minDteAtEntry
  });
  if (classification.classification !== "LEAPS") {
    return {
      symbol: metadata.underlyingSymbol,
      contractSymbol,
      classification: "NOT_LEAPS",
      classificationInferred: classification.inferred,
      entryDte: classification.entryDte,
      currentDte,
      unrealizedPlPct: pctFromPosition(position.unrealizedPlpc),
      delta: null,
      bidAskSpreadPct: null,
      hardExit: false,
      reviewOnly: false,
      executable: false,
      reasons: [],
      underlyingClose: null,
      trendReviewSma: null,
      severeTrendExitSma: null,
      limitPrice: null,
      exitQuantity: null,
      partialExitCandidate: null,
      lastReviewAt: null
    };
  }

  const snapshot = (deps.latestOptionSnapshotForSymbol ?? latestOptionSnapshotForSymbol)(contractSymbol);
  const bid = numeric(snapshot?.bid);
  const ask = numeric(snapshot?.ask);
  const spreadPct = bidAskSpreadPct(bid, ask);
  const delta = numeric(snapshot?.delta);
  const unrealizedPlPct = pctFromPosition(position.unrealizedPlpc) ??
    (() => {
      const marketValue = numeric(position.marketValue);
      const costBasis = numeric(position.costBasis);
      return marketValue !== null && costBasis !== null && costBasis !== 0
        ? ((marketValue - costBasis) / Math.abs(costBasis)) * 100
        : null;
    })();
  const qty = Math.max(0, Math.floor(Math.abs(numeric(position.qty) ?? 0)));
  const closes = (deps.closesForSymbol ?? closesForSymbol)(
    metadata.underlyingSymbol,
    generatedAt,
    Math.max(cfg.trendReviewSma, cfg.severeTrendExitSma)
  );
  const underlyingClose = closes.length ? closes[closes.length - 1]! : null;
  const reviewSma = sma(closes, cfg.trendReviewSma);
  const severeSma = sma(closes, cfg.severeTrendExitSma);
  const lastReviewAt = (deps.lastReviewAtForSymbol ?? lastReviewAtForSymbol)(contractSymbol);
  const reasons: LeapsExitReasonCode[] = [];

  if (classification.inferred) {
    reasons.push("LEAPS_CLASSIFICATION_INFERRED");
  }
  if (unrealizedPlPct !== null && unrealizedPlPct <= cfg.hardStopLossPct) {
    reasons.push("LEAPS_HARD_STOP_LOSS");
  }
  if (unrealizedPlPct !== null && unrealizedPlPct >= cfg.fullProfitTakePct) {
    reasons.push("LEAPS_FULL_PROFIT_TAKE");
  }
  if (currentDte !== null && currentDte <= cfg.dteExitThreshold) {
    reasons.push("LEAPS_DTE_EXIT_WINDOW");
  }
  if (underlyingClose !== null && severeSma !== null) {
    if (metadata.type === "call" && underlyingClose < severeSma) {
      reasons.push("LEAPS_SEVERE_TREND_BREAK");
    }
    if (metadata.type === "put" && underlyingClose > severeSma) {
      reasons.push("LEAPS_SEVERE_TREND_BREAK");
    }
  }
  if (unrealizedPlPct !== null && unrealizedPlPct <= cfg.reviewLossPct) {
    reasons.push("LEAPS_REVIEW_LOSS_WARNING");
  }
  if (unrealizedPlPct !== null && unrealizedPlPct >= cfg.partialProfitTakePct) {
    reasons.push("LEAPS_PARTIAL_PROFIT_REVIEW");
  }
  if (underlyingClose !== null && reviewSma !== null) {
    if (metadata.type === "call" && underlyingClose < reviewSma) {
      reasons.push("LEAPS_TREND_REVIEW");
    }
    if (metadata.type === "put" && underlyingClose > reviewSma) {
      reasons.push("LEAPS_TREND_REVIEW");
    }
  }
  if (delta === null) {
    reasons.push("LEAPS_DELTA_UNAVAILABLE");
  } else if (Math.abs(delta) < cfg.minDeltaReview) {
    reasons.push("LEAPS_DELTA_DETERIORATION");
  }
  const reviewAgeDays = daysSince(lastReviewAt, generatedAt);
  if (lastReviewAt === null || (reviewAgeDays !== null && reviewAgeDays >= cfg.reviewIntervalDays)) {
    reasons.push("LEAPS_PERIODIC_REVIEW_DUE");
  }

  const hardReasons: LeapsExitReasonCode[] = [
    "LEAPS_HARD_STOP_LOSS",
    "LEAPS_FULL_PROFIT_TAKE",
    "LEAPS_DTE_EXIT_WINDOW",
    "LEAPS_SEVERE_TREND_BREAK"
  ];
  const hardExit = reasons.some((reason) => hardReasons.includes(reason));
  const reviewOnly = !hardExit && reasons.length > 0;
  const limitPrice = quoteLimitPrice(snapshot);

  if (hardExit) {
    if (spreadPct === null || limitPrice === null) {
      reasons.push("LEAPS_QUOTE_UNAVAILABLE");
    } else if (spreadPct > cfg.maxBidAskSpreadPct) {
      reasons.push("LIMIT_EXIT_REQUIRED");
    }
  }

  const executable =
    hardExit &&
    qty > 0 &&
    limitPrice !== null &&
    spreadPct !== null &&
    spreadPct <= cfg.maxBidAskSpreadPct;

  const partialQty = Math.max(1, Math.floor(qty / 2));
  const partialExitCandidate =
    reasons.includes("LEAPS_PARTIAL_PROFIT_REVIEW") && qty > 1
      ? {
          supported: true,
          quantity: partialQty,
          reason: "LEAPS_PARTIAL_PROFIT_REVIEW" as const
        }
      : null;

  return {
    symbol: metadata.underlyingSymbol,
    contractSymbol,
    classification: "LEAPS",
    classificationInferred: classification.inferred,
    entryDte: classification.entryDte,
    currentDte,
    unrealizedPlPct: unrealizedPlPct === null ? null : roundPct(unrealizedPlPct),
    delta,
    bidAskSpreadPct: spreadPct,
    hardExit,
    reviewOnly,
    executable,
    ...(executable ? { section: "optionSellToCloseExits" as const } : {}),
    reasons: unique(reasons),
    underlyingClose,
    trendReviewSma: reviewSma,
    severeTrendExitSma: severeSma,
    limitPrice: executable ? limitPrice : null,
    exitQuantity: executable ? qty : null,
    partialExitCandidate,
    lastReviewAt
  };
};
