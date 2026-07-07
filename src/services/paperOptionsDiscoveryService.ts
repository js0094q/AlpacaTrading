import { queryAll } from "../lib/db.js";
import { getTradingSafetyState } from "./tradingSafetyService.js";

export interface PaperOptionsDiscoveryCandidate {
  underlyingSymbol: string;
  expirationDate: string;
  currentSession0Dte: boolean;
  nextSessionPreparation: boolean;
  side: "call" | "put";
  strike: number;
  contractSymbol: string;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  spreadPercentage: number | null;
  volume: number | null;
  openInterest: number | null;
  impliedVolatility: number | null;
  delta: number | null;
  selected: boolean;
  reasonSelected: string | null;
  reasonSkipped: string | null;
}

export interface PaperOptionsDiscoveryReport {
  paperOnly: true;
  environment: "paper" | "live";
  generatedAt: string;
  reviewOnly: true;
  nonMutating: true;
  status: "success" | "warning" | "blocked";
  underlyingSymbols: string[];
  dte: number;
  currentExpirationDate: string;
  selectedExpirationDate: string | null;
  nextSessionPreparation: boolean;
  summary: {
    contractsEvaluated: number;
    selected: number;
    rejectedMissingQuote: number;
    rejectedWideSpread: number;
    rejectedPremiumCap: number;
  };
  candidates: PaperOptionsDiscoveryCandidate[];
  warnings: string[];
  blockers: string[];
}

interface OptionDiscoveryRow {
  underlying_symbol: string;
  option_symbol: string;
  type: "call" | "put";
  expiration_date: string;
  strike: number;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  quote_status: string | null;
  executable: number | null;
  rejection_reason: string | null;
  volume: number | null;
  open_interest: number | null;
  implied_volatility: number | null;
  delta: number | null;
}

const parseBoolean = (value: string | undefined, fallback = false) => {
  if (value === undefined) {
    return fallback;
  }
  return value === "true" || value === "1";
};

const parseNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseFloat(value || "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const parseSymbols = (value: string | undefined, fallback: string[]) =>
  Array.from(
    new Set(
      (value || fallback.join(","))
        .split(",")
        .map((entry) => entry.trim().toUpperCase())
        .filter(Boolean)
    )
  );

const dateOnlyEt = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(iso));

const latestRowsForExpiration = (underlyings: string[], expirationDate: string) =>
  queryAll<OptionDiscoveryRow>(
    `
    SELECT
      c.underlying_symbol,
      c.option_symbol,
      c.type,
      c.expiration_date,
      c.strike,
      s.bid,
      s.ask,
      s.midpoint,
      s.quote_status,
      s.executable,
      s.rejection_reason,
      s.volume,
      s.open_interest,
      s.implied_volatility,
      s.delta
    FROM option_contracts c
    LEFT JOIN option_snapshots s
      ON s.option_symbol = c.option_symbol
      AND s.timestamp = (
        SELECT MAX(timestamp)
        FROM option_snapshots
        WHERE option_symbol = c.option_symbol
      )
    WHERE c.underlying_symbol IN (${underlyings.map(() => "?").join(",")})
      AND c.expiration_date = ?
      AND c.tradable = 1
    ORDER BY c.underlying_symbol ASC, c.type ASC, c.strike ASC
    `,
    [...underlyings, expirationDate]
  );

const nextExpirationAfter = (underlyings: string[], date: string) => {
  const rows = queryAll<{ expiration_date: string }>(
    `
    SELECT DISTINCT expiration_date
    FROM option_contracts
    WHERE underlying_symbol IN (${underlyings.map(() => "?").join(",")})
      AND expiration_date > ?
      AND tradable = 1
    ORDER BY expiration_date ASC
    LIMIT 1
    `,
    [...underlyings, date]
  );
  return rows[0]?.expiration_date ?? null;
};

const spreadPct = (bid: number | null, ask: number | null, midpoint: number | null) => {
  if (bid === null || ask === null || midpoint === null || midpoint <= 0) {
    return null;
  }
  return ((ask - bid) / midpoint) * 100;
};

const quoteMidpoint = (row: OptionDiscoveryRow) => {
  if (typeof row.midpoint === "number" && row.midpoint > 0) {
    return row.midpoint;
  }
  if (
    typeof row.bid === "number" &&
    row.bid > 0 &&
    typeof row.ask === "number" &&
    row.ask >= row.bid
  ) {
    return (row.bid + row.ask) / 2;
  }
  return null;
};

const rejectionReason = (input: {
  row: OptionDiscoveryRow;
  spreadPercentage: number | null;
  maxSpreadPct: number;
  maxPremiumPerContract: number;
  hardSpreadCapEnabled: boolean;
}) => {
  const { row, spreadPercentage, maxSpreadPct, maxPremiumPerContract, hardSpreadCapEnabled } = input;
  if (
    typeof row.bid !== "number" ||
    typeof row.ask !== "number" ||
    row.bid <= 0 ||
    row.ask <= 0 ||
    row.ask < row.bid
  ) {
    return "MISSING_OR_INVALID_QUOTE";
  }
  if (
    spreadPercentage !== null &&
    spreadPercentage > maxSpreadPct &&
    hardSpreadCapEnabled
  ) {
    return "SPREAD_TOO_WIDE";
  }
  if (row.ask * 100 > maxPremiumPerContract) {
    return "PREMIUM_CAP_EXCEEDED";
  }
  if (row.quote_status === "missing" || row.rejection_reason === "quote_unavailable") {
    return "MISSING_OR_INVALID_QUOTE";
  }
  return null;
};

const candidateFromRow = (input: {
  row: OptionDiscoveryRow;
  today: string;
  nextSessionPreparation: boolean;
  selectedSymbolSet: Set<string>;
  maxSpreadPct: number;
  maxPremiumPerContract: number;
  hardSpreadCapEnabled: boolean;
}): PaperOptionsDiscoveryCandidate => {
  const midpoint = quoteMidpoint(input.row);
  const currentSpread = spreadPct(input.row.bid, input.row.ask, midpoint);
  const skipped = rejectionReason({
    row: input.row,
    spreadPercentage: currentSpread,
    maxSpreadPct: input.maxSpreadPct,
    maxPremiumPerContract: input.maxPremiumPerContract,
    hardSpreadCapEnabled: input.hardSpreadCapEnabled
  });
  const selected = input.selectedSymbolSet.has(input.row.option_symbol);
  return {
    underlyingSymbol: input.row.underlying_symbol,
    expirationDate: input.row.expiration_date,
    currentSession0Dte: input.row.expiration_date === input.today,
    nextSessionPreparation: input.nextSessionPreparation,
    side: input.row.type,
    strike: input.row.strike,
    contractSymbol: input.row.option_symbol,
    bid: input.row.bid,
    ask: input.row.ask,
    midpoint,
    spreadPercentage: currentSpread === null ? null : Number(currentSpread.toFixed(2)),
    volume: input.row.volume,
    openInterest: input.row.open_interest,
    impliedVolatility: input.row.implied_volatility,
    delta: input.row.delta,
    selected,
    reasonSelected: selected
      ? input.nextSessionPreparation
        ? "NEXT_SESSION_ELIGIBLE_0DTE_PREPARATION"
        : "CURRENT_SESSION_ELIGIBLE_0DTE"
      : null,
    reasonSkipped: selected ? null : skipped || "LOWER_RANKED_ALTERNATIVE"
  };
};

const selectCandidates = (rows: OptionDiscoveryRow[], input: {
  maxSpreadPct: number;
  maxPremiumPerContract: number;
  hardSpreadCapEnabled: boolean;
}) => {
  const selected = new Set<string>();
  for (const side of ["call", "put"] as const) {
    const eligible = rows
      .filter((row) => row.type === side)
      .filter((row) => {
        const midpoint = quoteMidpoint(row);
        return !rejectionReason({
          row,
          spreadPercentage: spreadPct(row.bid, row.ask, midpoint),
          maxSpreadPct: input.maxSpreadPct,
          maxPremiumPerContract: input.maxPremiumPerContract,
          hardSpreadCapEnabled: input.hardSpreadCapEnabled
        });
      })
      .sort((left, right) => {
        const leftSpread = spreadPct(left.bid, left.ask, quoteMidpoint(left)) ?? Number.MAX_SAFE_INTEGER;
        const rightSpread = spreadPct(right.bid, right.ask, quoteMidpoint(right)) ?? Number.MAX_SAFE_INTEGER;
        return leftSpread === rightSpread ? left.strike - right.strike : leftSpread - rightSpread;
      });
    if (eligible[0]) {
      selected.add(eligible[0].option_symbol);
    }
  }
  return selected;
};

export const buildPaperOptionsDiscoveryReport = async (input: {
  underlying?: string;
  underlyings?: string[];
  dte?: number;
  asOf?: string;
  allowNextSessionPreparation?: boolean;
} = {}): Promise<PaperOptionsDiscoveryReport> => {
  const generatedAt = input.asOf || new Date().toISOString();
  const today = dateOnlyEt(generatedAt);
  const state = getTradingSafetyState();
  const underlyings =
    input.underlyings?.length
      ? input.underlyings.map((entry) => entry.toUpperCase())
      : parseSymbols(input.underlying, ["SPY"]);
  const dte = input.dte ?? 0;
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!state.paperOnly) {
    blockers.push("PAPER_ENV_REQUIRED");
  }
  if (dte !== 0) {
    blockers.push("ONLY_0DTE_DISCOVERY_SUPPORTED");
  }
  if (!parseBoolean(process.env.PAPER_0DTE_DISCOVERY_ENABLED, false)) {
    blockers.push("PAPER_0DTE_DISCOVERY_DISABLED");
  }

  const maxSpreadPct = parseNumber(process.env.PAPER_0DTE_SPY_MAX_SPREAD_PCT, 20);
  const maxPremiumPerContract = parseNumber(
    process.env.PAPER_0DTE_SPY_MAX_PREMIUM_PER_CONTRACT,
    250
  );
  const hardSpreadCapEnabled = parseBoolean(
    process.env.PAPER_0DTE_SPY_HARD_SPREAD_CAP_ENABLED,
    parseBoolean(process.env.PAPER_OPTIONS_HARD_SPREAD_CAP_ENABLED, false)
  );

  let selectedExpirationDate: string | null = today;
  let nextSessionPreparation = false;
  let rows = blockers.length ? [] : latestRowsForExpiration(underlyings, today);
  let selected = selectCandidates(rows, {
    maxSpreadPct,
    maxPremiumPerContract,
    hardSpreadCapEnabled
  });

  if (!selected.size && input.allowNextSessionPreparation !== false && !blockers.length) {
    const nextExpiration = nextExpirationAfter(underlyings, today);
    if (nextExpiration) {
      selectedExpirationDate = nextExpiration;
      nextSessionPreparation = true;
      rows = latestRowsForExpiration(underlyings, nextExpiration);
      selected = selectCandidates(rows, {
        maxSpreadPct,
        maxPremiumPerContract,
        hardSpreadCapEnabled
      });
      warnings.push("CURRENT_SESSION_0DTE_UNAVAILABLE_NEXT_SESSION_PREPARED");
    }
  }

  const candidates = rows.map((row) =>
    candidateFromRow({
      row,
      today,
      nextSessionPreparation,
      selectedSymbolSet: selected,
      maxSpreadPct,
      maxPremiumPerContract,
      hardSpreadCapEnabled
    })
  );
  const rejectedMissingQuote = candidates.filter(
    (candidate) => candidate.reasonSkipped === "MISSING_OR_INVALID_QUOTE"
  ).length;
  const rejectedWideSpread = candidates.filter(
    (candidate) => candidate.reasonSkipped === "SPREAD_TOO_WIDE"
  ).length;
  const rejectedPremiumCap = candidates.filter(
    (candidate) => candidate.reasonSkipped === "PREMIUM_CAP_EXCEEDED"
  ).length;

  if (!blockers.length && !selected.size) {
    warnings.push("NO_ELIGIBLE_0DTE_OPTIONS_DISCOVERED");
  }

  return {
    paperOnly: true,
    environment: state.alpacaEnv,
    generatedAt,
    reviewOnly: true,
    nonMutating: true,
    status: blockers.length ? "blocked" : warnings.length ? "warning" : "success",
    underlyingSymbols: underlyings,
    dte,
    currentExpirationDate: today,
    selectedExpirationDate,
    nextSessionPreparation,
    summary: {
      contractsEvaluated: candidates.length,
      selected: candidates.filter((candidate) => candidate.selected).length,
      rejectedMissingQuote,
      rejectedWideSpread,
      rejectedPremiumCap
    },
    candidates,
    warnings,
    blockers
  };
};

export const formatPaperOptionsDiscoveryReportAsTable = (report: PaperOptionsDiscoveryReport) => {
  const lines: string[] = [];
  lines.push("Paper 0DTE Options Discovery");
  lines.push(`Status: ${report.status}`);
  lines.push(`Underlyings: ${report.underlyingSymbols.join(",")}`);
  lines.push(`Selected expiration: ${report.selectedExpirationDate || "none"}`);
  lines.push(`Next-session preparation: ${String(report.nextSessionPreparation)}`);
  if (report.blockers.length) {
    lines.push(`Blockers: ${report.blockers.join(", ")}`);
  }
  for (const candidate of report.candidates) {
    lines.push(
      [
        candidate.selected ? "SELECT" : "SKIP",
        candidate.contractSymbol,
        candidate.side,
        candidate.expirationDate,
        `strike=${candidate.strike}`,
        `bid=${candidate.bid ?? "-"}`,
        `ask=${candidate.ask ?? "-"}`,
        `spread=${candidate.spreadPercentage ?? "-"}`,
        candidate.reasonSelected || candidate.reasonSkipped || "reviewed"
      ].join(" | ")
    );
  }
  if (!report.candidates.length) {
    lines.push("No candidate contracts found.");
  }
  lines.push("Discovery-only. No orders were submitted.");
  return lines.join("\n");
};
