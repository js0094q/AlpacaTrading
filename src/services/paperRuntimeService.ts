import { getTradingSafetyState, type TradingSafetyState } from "./tradingSafetyService.js";
import { queryAll, queryOne } from "../lib/db.js";
import { getAlpacaAccountSnapshot } from "./alpacaAccountService.js";
import { listAlpacaOpenOrders } from "./alpacaOrderReadService.js";
import { listAlpacaPositions } from "./alpacaPositionService.js";
import {
  checkAlpacaSymbolTradability,
  type AlpacaAssetTradabilityResult
} from "./alpacaAssetService.js";
import { normalizeSymbol } from "../lib/utils.js";

export type RuntimeDecision = "candidate" | "skip" | "watch";

export interface PaperRuntimeCandidate {
  symbol: string;
  latestRank: number | null;
  recommendation: string | null;
  assetTradable: boolean;
  alreadyHeld: boolean;
  currentQty: number;
  openOrderExists: boolean;
  estimatedNotional: number | null;
  runtimeDecision: RuntimeDecision;
  skipReason?: string;
}

export interface PaperRuntimeReport {
  paperOnly: true;
  environment: TradingSafetyState["alpacaEnv"];
  account: {
    status: string;
    equity: number | null;
    buyingPower: number | null;
    cash: number | null;
    daytradeCount?: number | null;
  };
  candidates: PaperRuntimeCandidate[];
}

export interface PaperRuntimeInput {
  riskProfile?: string;
  optionsEnabled?: boolean;
  maxCandidates?: number;
}

interface ResearchRunRow {
  id: string;
  risk_profile: string;
  options_enabled: number;
  status: string;
}

interface CandidateRow {
  symbol: string;
  rank: number;
  direction: string;
  preferred_expression: string;
  estimated_max_loss: number | null;
  estimated_max_profit: number | null;
}

const normalizeInteger = (value: number | undefined) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 10;
  }
  return Math.floor(parsed);
};

const toNullableNumber = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" && value.trim() === "") {
    return null;
  }
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  return num;
};

const buildAccountProfile = (account: {
  status?: string;
  equity?: string;
  buyingPower?: string;
  cash?: string;
  daytradeCount?: number;
}) => ({
  status: account.status || "unknown",
  equity: toNullableNumber(account.equity),
  buyingPower: toNullableNumber(account.buyingPower),
  cash: toNullableNumber(account.cash),
  daytradeCount: account.daytradeCount ?? null
});

export const listLatestRunCandidates = (input: { runId: string; maxCandidates?: number }): CandidateRow[] => {
  const maxCandidates = normalizeInteger(input.maxCandidates);
  return queryAll<CandidateRow>(
    `
    SELECT
      symbol,
      rank,
      direction,
      preferred_expression,
      estimated_max_loss,
      estimated_max_profit
    FROM paper_trade_candidates
    WHERE research_run_id = ? AND decision = 'selected'
    ORDER BY rank ASC
    LIMIT ?
    `,
    [input.runId, maxCandidates]
  );
};

const latestRunForFilters = (riskProfile?: string, optionsEnabled?: boolean): ResearchRunRow | null => {
  const clauses = ["status = 'completed'"];
  const params: Array<string | number> = [];

  if (riskProfile) {
    clauses.push("risk_profile = ?");
    params.push(riskProfile);
  }

  if (optionsEnabled !== undefined) {
    clauses.push("options_enabled = ?");
    params.push(optionsEnabled ? 1 : 0);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  return queryOne<ResearchRunRow>(
    `
    SELECT id, risk_profile, options_enabled, status
    FROM research_runs
    ${where}
    ORDER BY started_at DESC
    LIMIT 1
    `,
    params
  );
};

const decideRuntimeCandidate = (
  candidate: CandidateRow,
  assetTradable: boolean,
  alreadyHeld: boolean,
  openOrderExists: boolean,
  currentQty: number,
  estimatedNotional: number | null,
  buyingPower: number | null
): PaperRuntimeCandidate => {
  const symbol = candidate.symbol;
  const recommendation = `${candidate.direction} ${candidate.preferred_expression}`;

  if (!assetTradable) {
    return {
      symbol,
      latestRank: candidate.rank,
      recommendation,
      assetTradable: false,
      alreadyHeld,
      currentQty,
      openOrderExists,
      estimatedNotional,
      runtimeDecision: "skip",
      skipReason: "symbol is not tradable"
    };
  }

  if (openOrderExists) {
    return {
      symbol,
      latestRank: candidate.rank,
      recommendation,
      assetTradable: true,
      alreadyHeld,
      currentQty,
      openOrderExists,
      estimatedNotional,
      runtimeDecision: "skip",
      skipReason: "open order already exists for symbol"
    };
  }

  if (alreadyHeld) {
    return {
      symbol,
      latestRank: candidate.rank,
      recommendation,
      assetTradable: true,
      alreadyHeld,
      currentQty,
      openOrderExists,
      estimatedNotional,
      runtimeDecision: "watch",
      skipReason: "already held in account"
    };
  }

  if (estimatedNotional === null) {
    return {
      symbol,
      latestRank: candidate.rank,
      recommendation,
      assetTradable: true,
      alreadyHeld,
      currentQty,
      openOrderExists,
      estimatedNotional,
      runtimeDecision: "watch",
      skipReason: "estimated notional unavailable"
    };
  }

  if (buyingPower === null) {
    return {
      symbol,
      latestRank: candidate.rank,
      recommendation,
      assetTradable: true,
      alreadyHeld,
      currentQty,
      openOrderExists,
      estimatedNotional,
      runtimeDecision: "watch",
      skipReason: "buying power unavailable"
    };
  }

  if (estimatedNotional > buyingPower) {
    return {
      symbol,
      latestRank: candidate.rank,
      recommendation,
      assetTradable: true,
      alreadyHeld,
      currentQty,
      openOrderExists,
      estimatedNotional,
      runtimeDecision: "watch",
      skipReason: "insufficient buying power"
    };
  }

  return {
    symbol,
    latestRank: candidate.rank,
    recommendation,
    assetTradable: true,
    alreadyHeld,
    currentQty,
    openOrderExists,
    estimatedNotional,
    runtimeDecision: "candidate"
  };
};

export const buildPaperRuntimeReport = async (
  input: PaperRuntimeInput = {}
): Promise<PaperRuntimeReport> => {
  const state = getTradingSafetyState();
  const account = await getAlpacaAccountSnapshot();
  const accountProfile = buildAccountProfile(account);

  const [openOrders, positions] = await Promise.all([
    listAlpacaOpenOrders(),
    listAlpacaPositions()
  ]);

  const openOrderBySymbol = new Set<string>(
    (openOrders.orders || [])
      .map((order) => normalizeSymbol(order.symbol))
      .filter(Boolean)
  );

  const heldQtyBySymbol = new Map<string, number>();
  for (const position of positions.positions || []) {
    const symbol = normalizeSymbol(position.symbol);
    const qty = Number(position.qty);
    if (symbol) {
      heldQtyBySymbol.set(symbol, Number.isFinite(qty) ? qty : 0);
    }
  }

  const latestRun = latestRunForFilters(input.riskProfile, input.optionsEnabled);

  if (!latestRun) {
    return {
      paperOnly: true,
      environment: state.alpacaEnv,
      account: accountProfile,
      candidates: []
    };
  }

  const candidates = listLatestRunCandidates({
    runId: latestRun.id,
    maxCandidates: normalizeInteger(input.maxCandidates)
  });

  const tradabilityCache = new Map<string, AlpacaAssetTradabilityResult>();
  const candidateReports: PaperRuntimeCandidate[] = [];

  for (const candidate of candidates) {
    const symbol = normalizeSymbol(candidate.symbol);
    if (!symbol) {
      continue;
    }

    let tradability = tradabilityCache.get(symbol);
    if (!tradability) {
      tradability = await checkAlpacaSymbolTradability(symbol);
      tradabilityCache.set(symbol, tradability);
    }

    const alreadyHeld = (heldQtyBySymbol.get(symbol) || 0) > 0;
    const currentQty = heldQtyBySymbol.get(symbol) || 0;
    const openOrderExists = openOrderBySymbol.has(symbol);
    const estimatedNotional = toNullableNumber(
      candidate.estimated_max_loss ?? candidate.estimated_max_profit
    );

    candidateReports.push(
      decideRuntimeCandidate(
        candidate,
        tradability.tradable,
        alreadyHeld,
        openOrderExists,
        currentQty,
        estimatedNotional,
        accountProfile.buyingPower
      )
    );
  }

  return {
    paperOnly: true,
    environment: state.alpacaEnv,
    account: accountProfile,
    candidates: candidateReports
  };
};

const stateText = (paperOnly: boolean) => (paperOnly ? "true" : "false");

const padCell = (value: string, width: number, alignRight = false) => {
  const text = value ?? "";
  return alignRight ? text.padStart(width, " ") : text.padEnd(width, " ");
};

export const formatPaperRuntimeReportAsTable = (report: PaperRuntimeReport) => {
  const toAccountNumber = (value: number | null | undefined) =>
    value === null || value === undefined ? "" : value;

  if (!report.candidates.length) {
    return [
      `Paper Runtime Check (environment ${report.environment})`,
      `Paper Only: ${stateText(report.paperOnly)}`,
      `Account status: ${report.account.status}`,
      `Equity: ${toAccountNumber(report.account.equity)}`,
      `Buying power: ${toAccountNumber(report.account.buyingPower)}`,
      `Cash: ${toAccountNumber(report.account.cash)}`,
      `Daytrade count: ${report.account.daytradeCount ?? ""}`,
      ""
    ].join("\n");
  }

  const lines: string[] = [];
  lines.push(`Paper Runtime Check (environment ${report.environment})`);
  lines.push(`Paper Only: ${stateText(report.paperOnly)}`);
  lines.push(`Account status: ${report.account.status}`);
  lines.push(`Equity: ${toAccountNumber(report.account.equity)}`);
  lines.push(`Buying Power: ${toAccountNumber(report.account.buyingPower)}`);
  lines.push(`Cash: ${toAccountNumber(report.account.cash)}`);
  lines.push(`Daytrade count: ${report.account.daytradeCount ?? ""}`);
  lines.push("");

  const header = [
    padCell("Symbol", 8),
    padCell("Rank", 6, true),
    padCell("Recommendation", 20),
    padCell("Tradable", 9),
    padCell("Held", 6),
    padCell("Qty", 10, true),
    padCell("OpenOrder", 10),
    padCell("Notional", 12, true),
    padCell("Decision", 10),
    padCell("Reason", 35)
  ].join(" ");

  lines.push(header);
  for (const candidate of report.candidates) {
    lines.push([
      padCell(candidate.symbol, 8),
      padCell(String(candidate.latestRank ?? ""), 6, true),
      padCell(candidate.recommendation || "", 20),
      padCell(candidate.assetTradable ? "true" : "false", 9),
      padCell(candidate.alreadyHeld ? "yes" : "no", 6),
      padCell(String(candidate.currentQty), 10, true),
      padCell(candidate.openOrderExists ? "yes" : "no", 10),
      padCell(candidate.estimatedNotional === null ? "" : String(candidate.estimatedNotional), 12, true),
      padCell(candidate.runtimeDecision, 10),
      padCell(candidate.skipReason || "", 35)
    ].join(" "));
  }

  return lines.join("\n");
};
