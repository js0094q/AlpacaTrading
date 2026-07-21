import type { PreferredExpression, StrategySelectorResult } from "../types.js";
import { percent } from "../lib/utils.js";

export interface StrategySelectionInput {
  symbol: string;
  asOf: string;
  direction: "long" | "short" | "neutral";
  confidence: number;
  expectedReturn: number | null;
  atr: number | null;
  trend: string;
  iv: number | null;
  liquidityScore: number;
  spreadPct: number | null;
  hasOptionsData: boolean;
}

export const selectExpressionWithPolicy = (
  input: StrategySelectionInput,
  isAggressiveAllowed: boolean
): StrategySelectorResult => {
  const rationale: string[] = [];
  const alternatives: PreferredExpression[] = ["shares"];
  let preferred: PreferredExpression = "shares";

  if (input.direction === "neutral" || input.confidence < 0.35) {
    rationale.push("Insufficient directional confidence for a high-conviction signal");
    return {
      symbol: input.symbol,
      asOf: input.asOf,
      direction: input.direction,
      preferredExpression: "none",
      alternatives,
      rationale
    };
  }

  const hasGoodSpread = input.spreadPct === null ? true : input.spreadPct <= 0.08;
  const hasStrongLiquidity = input.liquidityScore >= 0.5;
  const longBias = input.direction === "long";
  const shortBias = input.direction === "short";
  const expected = input.expectedReturn ?? 0;
  const volatility = input.atr ?? 0;
  const expectedMagnitude = expected * 100;
  const iv = input.iv ?? 0;

  if (input.hasOptionsData && hasStrongLiquidity) {
    if (longBias && input.confidence >= 0.5 && expectedMagnitude >= 1) {
      if (isAggressiveAllowed && iv > 0.25 && hasGoodSpread && input.confidence > 0.7) {
        preferred = "long_call";
        alternatives.unshift("call_spread", "shares", "protective_put");
        rationale.push("Expected upside and liquidity justify a convex long-call expression");
      } else {
        preferred = "shares";
        alternatives.unshift("long_call", "cash_secured_put");
        rationale.push("Long directional signal is strong; default to shares with optional long call");
      }
    } else if (shortBias && expectedMagnitude <= -1 && isAggressiveAllowed && input.confidence > 0.7) {
      if (iv > 0.22 && hasGoodSpread) {
        preferred = "long_put";
        alternatives.unshift("put_spread", "shares");
        rationale.push("Short conviction with adequate spread quality points to long put structure");
      } else {
        preferred = "shares";
        alternatives.unshift("long_put", "cash_secured_put");
        rationale.push("Short directional signal present, but spread quality suggests share exposure");
      }
    }
  }

  if (input.hasOptionsData && hasStrongLiquidity && isAggressiveAllowed) {
    if (Math.abs(input.confidence) >= 0.8 && percent(volatility, input.atr ?? 0) > 0) {
      if (longBias && expectedMagnitude >= 1.5) {
        preferred = "call_spread";
        alternatives.unshift("long_call", "shares");
        rationale.push("Defined-risk long call spread selected for elevated asymmetric expectation");
      }
      if (shortBias && expectedMagnitude <= -1.5) {
        preferred = "put_spread";
        alternatives.unshift("long_put", "shares");
        rationale.push("Defined-risk put spread selected for elevated asymmetric expectation");
      }
    }
  }

  if (!rationale.length) {
    rationale.push(`Direction ${input.direction} has insufficient options-structure edge; shares are default`);
  }
  const optionsCandidate = hasStrongLiquidity
    ? {
        optionSymbol: `${input.symbol}_C_MID`,
        expirationDate: undefined,
        strike: undefined,
        type: longBias ? "call" as const : "put" as const,
        estimatedEntryPrice: input.liquidityScore,
        maxLoss: null,
        maxProfit: null,
        breakeven: null,
        liquidityScore: input.liquidityScore
      }
    : undefined;
  return {
    symbol: input.symbol,
    asOf: input.asOf,
    direction: input.direction,
    preferredExpression: preferred,
    alternatives: alternatives.filter((entry) => entry !== preferred),
    rationale,
    optionsCandidate
  };
};
