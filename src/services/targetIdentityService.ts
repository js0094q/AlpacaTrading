export const TARGET_STRATEGY_FAMILIES = [
  "equity",
  "standard_option",
  "zero_dte_spy",
  "leaps",
  "portfolio_hedge",
  "legacy_default"
] as const;

export type TargetStrategyFamily =
  (typeof TARGET_STRATEGY_FAMILIES)[number];

export type TargetIdentity = {
  readonly strategyFamily: TargetStrategyFamily;
  readonly expressionId: string;
};

const isTargetStrategyFamily = (value: string): value is TargetStrategyFamily =>
  TARGET_STRATEGY_FAMILIES.includes(value as TargetStrategyFamily);

export const targetIdentity = (input: {
  readonly strategyFamily: Exclude<TargetStrategyFamily, "legacy_default">;
  readonly preferredExpression: string;
  readonly optionSymbol: string | null;
}): TargetIdentity => {
  const strategyFamily = input.strategyFamily as string;
  if (!isTargetStrategyFamily(strategyFamily) || strategyFamily === "legacy_default") {
    throw new Error("TARGET_STRATEGY_FAMILY_INVALID");
  }

  const expression = input.preferredExpression.trim().toLowerCase();
  if (!expression) throw new Error("TARGET_EXPRESSION_REQUIRED");
  if (strategyFamily === "equity") {
    return { strategyFamily, expressionId: `equity:${expression}` };
  }

  const optionSymbol = input.optionSymbol?.trim().toUpperCase();
  if (!optionSymbol) throw new Error("TARGET_OPTION_EXPRESSION_ID_REQUIRED");
  return { strategyFamily, expressionId: `option:${optionSymbol}` };
};
