export interface PaperHedgeOptionOrderInput {
  environment: string;
  liveTradingEnabled: boolean;
  optionsExecutionEnabled: boolean;
  symbol: string;
  underlying: string;
  quantity: number;
  limitPrice: number;
  bid: number | null;
  ask: number | null;
  delta: number | null;
  dte: number;
  quoteTimestamp: string | null;
  asOf: string;
  maxQuoteAgeSeconds: number;
  maxSpreadPct: number;
  maxQuantity: number;
  maxPremium: number;
  maxPortfolioAllocation: number;
  portfolioEquity: number;
  buyingPower: number;
  optionApprovalLevel: number;
  structure: "long_put" | "put_spread" | string;
  targetAbsDeltaMin?: number;
  targetAbsDeltaMax?: number;
  minDte?: number;
  maxDte?: number;
}

export interface PaperHedgeOptionOrderValidation {
  valid: boolean;
  blockers: string[];
  warnings: string[];
  premium: number | null;
  spreadPct: number | null;
  quoteAgeSeconds: number | null;
}

const unique = (values: string[]) => [...new Set(values)];

export const validatePaperHedgeOptionOrder = (
  input: PaperHedgeOptionOrderInput
): PaperHedgeOptionOrderValidation => {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (input.environment !== "paper") blockers.push("HEDGE_ENVIRONMENT_NOT_PAPER");
  if (input.liveTradingEnabled) blockers.push("HEDGE_LIVE_TRADING_ENABLED");
  if (!input.optionsExecutionEnabled) blockers.push("HEDGE_OPTIONS_EXECUTION_DISABLED");
  if (input.structure !== "long_put") blockers.push("MULTI_LEG_EXECUTION_UNSUPPORTED");
  if (!input.symbol.trim() || !input.underlying.trim()) blockers.push("HEDGE_CONTRACT_IDENTITY_INVALID");
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > input.maxQuantity) {
    blockers.push("HEDGE_QUANTITY_CAP_EXCEEDED");
  }
  if (!Number.isFinite(input.limitPrice) || input.limitPrice <= 0) blockers.push("HEDGE_LIMIT_PRICE_INVALID");
  if (!Number.isInteger(input.dte) || input.dte < (input.minDte ?? 1) || input.dte > (input.maxDte ?? 10_000)) {
    blockers.push("HEDGE_DTE_INVALID");
  }
  if (!Number.isFinite(input.delta)) {
    blockers.push("HEDGE_DELTA_UNAVAILABLE");
  } else {
    const absDelta = Math.abs(input.delta as number);
    if (absDelta < (input.targetAbsDeltaMin ?? 0.2) || absDelta > (input.targetAbsDeltaMax ?? 0.4)) {
      blockers.push("HEDGE_DELTA_OUT_OF_RANGE");
    }
  }
  const premium = Number.isFinite(input.quantity) && Number.isFinite(input.limitPrice)
    ? input.quantity * input.limitPrice * 100
    : null;
  if (premium !== null) {
    const portfolioCap = Math.max(0, input.portfolioEquity * input.maxPortfolioAllocation);
    if (premium > input.maxPremium || premium > portfolioCap) blockers.push("HEDGE_PREMIUM_CAP_EXCEEDED");
    if (premium > input.buyingPower) blockers.push("HEDGE_BUYING_POWER_INSUFFICIENT");
  }
  const spreadPct = input.bid !== null && input.ask !== null && input.bid >= 0 && input.ask >= input.bid && input.bid + input.ask > 0
    ? (input.ask - input.bid) / ((input.ask + input.bid) / 2)
    : null;
  if (spreadPct === null) blockers.push("HEDGE_SPREAD_UNAVAILABLE");
  else if (spreadPct > input.maxSpreadPct) blockers.push("HEDGE_SPREAD_TOO_WIDE");
  const quoteAgeSeconds = input.quoteTimestamp
    ? (Date.parse(input.asOf) - Date.parse(input.quoteTimestamp)) / 1000
    : null;
  if (quoteAgeSeconds === null || !Number.isFinite(quoteAgeSeconds) || quoteAgeSeconds < 0 || quoteAgeSeconds > input.maxQuoteAgeSeconds) {
    blockers.push("HEDGE_QUOTE_STALE");
  }
  if (!Number.isFinite(input.optionApprovalLevel) || input.optionApprovalLevel < 1) {
    blockers.push("HEDGE_OPTION_APPROVAL_REQUIRED");
  }
  return {
    valid: blockers.length === 0,
    blockers: unique(blockers),
    warnings: unique(warnings),
    premium,
    spreadPct,
    quoteAgeSeconds
  };
};
