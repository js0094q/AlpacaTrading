const finite = (value: unknown): number | null => {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const nyParts = (value: Date) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${fields.year}-${fields.month}-${fields.day}`,
    minute: Number(fields.hour) * 60 + Number(fields.minute)
  };
};

export type ZeroDteDecisionInput = {
  readonly underlyingSymbol: string;
  readonly expirationDate: string;
  readonly optionType: "call" | "put";
  readonly direction: "long" | "short";
  readonly observedAt: string;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly volume: number | null;
  readonly openInterest: number | null;
  readonly moneyness: number | null;
  readonly liquidityScore: number | null;
};

export type ZeroDteDecisionConfig = {
  readonly entryStartMinute: number;
  readonly entryEndMinuteExclusive: number;
  readonly maximumSpreadPct: number;
  readonly minimumCombinedLiquidity: number;
  readonly maximumAbsoluteMoneyness: number;
  readonly minimumDecisionScore: number;
};

export const DEFAULT_ZERO_DTE_DECISION_CONFIG: ZeroDteDecisionConfig = {
  entryStartMinute: 9 * 60 + 35,
  entryEndMinuteExclusive: 15 * 60 + 15,
  maximumSpreadPct: 0.1,
  minimumCombinedLiquidity: 100,
  maximumAbsoluteMoneyness: 0.03,
  minimumDecisionScore: 0.45
};

const terminal = (blocker: string, inputsUsed: Record<string, unknown>) => ({
  eligible: false,
  action: "blocked" as const,
  score: 0,
  blockers: [blocker],
  greeksRequired: false as const,
  inputsUsed
});

export const evaluateZeroDteDecision = (
  input: ZeroDteDecisionInput,
  config: ZeroDteDecisionConfig = DEFAULT_ZERO_DTE_DECISION_CONFIG
) => {
  const observed = new Date(input.observedAt);
  const inputsUsed = {
    underlyingSymbol: input.underlyingSymbol.trim().toUpperCase(),
    expirationDate: input.expirationDate,
    optionType: input.optionType,
    direction: input.direction,
    observedAt: input.observedAt,
    bid: finite(input.bid),
    ask: finite(input.ask),
    volume: finite(input.volume),
    openInterest: finite(input.openInterest),
    moneyness: finite(input.moneyness),
    liquidityScore: finite(input.liquidityScore)
  };
  if (!Number.isFinite(observed.getTime())) {
    return terminal("ZERO_DTE_OBSERVATION_TIME_INVALID", inputsUsed);
  }
  const bid = inputsUsed.bid;
  const ask = inputsUsed.ask;
  if (bid === null || ask === null || bid <= 0 || ask <= 0 || ask < bid) {
    return terminal("ZERO_DTE_QUOTE_INVALID", inputsUsed);
  }

  const blockers: string[] = [];
  const ny = nyParts(observed);
  if (inputsUsed.underlyingSymbol !== "SPY") blockers.push("ZERO_DTE_SPY_ONLY");
  if (input.expirationDate !== ny.date) blockers.push("ZERO_DTE_EXPIRATION_MISMATCH");
  if (
    (input.direction === "long" && input.optionType !== "call") ||
    (input.direction === "short" && input.optionType !== "put")
  ) {
    blockers.push("ZERO_DTE_DIRECTION_OPTION_MISMATCH");
  }
  if (
    ny.minute < config.entryStartMinute ||
    ny.minute >= config.entryEndMinuteExclusive
  ) {
    blockers.push("ZERO_DTE_ENTRY_WINDOW_CLOSED");
  }

  const midpoint = (bid + ask) / 2;
  const spreadPct = (ask - bid) / midpoint;
  const volume = Math.max(0, inputsUsed.volume ?? 0);
  const openInterest = Math.max(0, inputsUsed.openInterest ?? 0);
  const moneyness = inputsUsed.moneyness;
  const liquidityScore = Math.max(0, Math.min(1, inputsUsed.liquidityScore ?? 0));
  if (spreadPct > config.maximumSpreadPct) blockers.push("ZERO_DTE_SPREAD_TOO_WIDE");
  if (volume + openInterest < config.minimumCombinedLiquidity) {
    blockers.push("ZERO_DTE_LIQUIDITY_INSUFFICIENT");
  }
  if (
    moneyness === null ||
    Math.abs(moneyness) > config.maximumAbsoluteMoneyness
  ) {
    blockers.push("ZERO_DTE_MONEYNESS_OUT_OF_RANGE");
  }

  const score = Math.max(0, Math.min(1,
    Math.max(0, 1 - spreadPct / config.maximumSpreadPct) * 0.3 +
    Math.min(1, volume / 1_000) * 0.2 +
    Math.min(1, openInterest / 5_000) * 0.2 +
    (moneyness === null
      ? 0
      : Math.max(0, 1 - Math.abs(moneyness) / config.maximumAbsoluteMoneyness)) * 0.15 +
    liquidityScore * 0.15
  ));
  if (score < config.minimumDecisionScore) {
    blockers.push("ZERO_DTE_DECISION_SCORE_TOO_LOW");
  }

  return {
    eligible: blockers.length === 0,
    action: blockers.length === 0 ? "eligible" as const : "blocked" as const,
    score,
    blockers,
    greeksRequired: false as const,
    components: {
      spreadPct,
      combinedLiquidity: volume + openInterest,
      absoluteMoneyness: moneyness === null ? null : Math.abs(moneyness),
      liquidityScore,
      newYorkMinute: ny.minute
    },
    inputsUsed
  };
};
