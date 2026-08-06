export const DEFAULT_LEAPS_MAX_ENTRY_CAPITAL_USD = 7_500;
export const MAX_LEAPS_ENTRY_CAPITAL_USD =
  DEFAULT_LEAPS_MAX_ENTRY_CAPITAL_USD;
export const LEAPS_CONTRACT_MULTIPLIER = 100;

export type LeapsEntryAllocationFailureReason =
  | "LEAPS_ENTRY_ALLOCATION_INVALID"
  | "LEAPS_PAPER_ONLY_REQUIRED";

export type LeapsEntryAllocationResolution =
  | {
      readonly ok: true;
      readonly maxEntryCapitalUsd: number;
      readonly source: "environment" | "paper_default";
      readonly reason: null;
    }
  | {
      readonly ok: false;
      readonly maxEntryCapitalUsd: null;
      readonly source: "invalid";
      readonly reason: LeapsEntryAllocationFailureReason;
    };

export type LeapsEntrySizingFailureReason =
  | "LEAPS_CONTRACT_COST_EXCEEDS_ALLOCATION"
  | "LEAPS_CONTRACT_MULTIPLIER_INVALID"
  | "LEAPS_ENTRY_ALLOCATION_INVALID"
  | "LEAPS_ENTRY_QUANTITY_INVALID"
  | "LEAPS_EXECUTABLE_PREMIUM_INVALID"
  | "LEAPS_VALIDATED_AVAILABLE_CAPITAL_INSUFFICIENT"
  | "LEAPS_VALIDATED_AVAILABLE_CAPITAL_INVALID";

export type LeapsEntrySizingInput = {
  readonly executablePremium: number;
  readonly contractMultiplier: number;
  readonly maxEntryCapitalUsd: number;
  readonly independentlyValidatedAvailableCapitalUsd: number;
};

export type LeapsEntrySizingResult = {
  readonly configuredPerEntryAllocationUsd: number;
  readonly executablePremium: number;
  readonly contractMultiplier: number;
  readonly contractCostUsd: number | null;
  readonly positionCostUsd: number;
  readonly independentlyValidatedAvailableCapitalUsd: number;
  readonly quantity: number;
  readonly reason: LeapsEntrySizingFailureReason | null;
};

const normalized = (value: string | undefined) =>
  value?.trim().toLowerCase();

const explicitlyPaperOnly = (env: NodeJS.ProcessEnv) =>
  normalized(env.ALPACA_ENV) === "paper" &&
  normalized(env.TRADING_MODE) === "paper" &&
  normalized(env.ALPACA_LIVE_TRADE) === "false" &&
  normalized(env.LIVE_TRADING_ENABLED) === "false";

const validAllocation = (value: number) =>
  Number.isFinite(value) &&
  value > 0 &&
  value <= MAX_LEAPS_ENTRY_CAPITAL_USD;

export const resolveLeapsEntryAllocation = (
  env: NodeJS.ProcessEnv = process.env
): LeapsEntryAllocationResolution => {
  if (!explicitlyPaperOnly(env)) {
    return {
      ok: false,
      maxEntryCapitalUsd: null,
      source: "invalid",
      reason: "LEAPS_PAPER_ONLY_REQUIRED"
    };
  }

  const configured = env.LEAPS_MAX_ENTRY_CAPITAL_USD;
  if (configured === undefined) {
    return {
      ok: true,
      maxEntryCapitalUsd: DEFAULT_LEAPS_MAX_ENTRY_CAPITAL_USD,
      source: "paper_default",
      reason: null
    };
  }

  if (configured.trim() === "") {
    return {
      ok: false,
      maxEntryCapitalUsd: null,
      source: "invalid",
      reason: "LEAPS_ENTRY_ALLOCATION_INVALID"
    };
  }

  const maxEntryCapitalUsd = Number(configured);
  if (!validAllocation(maxEntryCapitalUsd)) {
    return {
      ok: false,
      maxEntryCapitalUsd: null,
      source: "invalid",
      reason: "LEAPS_ENTRY_ALLOCATION_INVALID"
    };
  }

  return {
    ok: true,
    maxEntryCapitalUsd,
    source: "environment",
    reason: null
  };
};

const sizingResult = (
  input: LeapsEntrySizingInput,
  contractCostUsd: number | null,
  quantity: number,
  reason: LeapsEntrySizingFailureReason | null
): LeapsEntrySizingResult => ({
  configuredPerEntryAllocationUsd: input.maxEntryCapitalUsd,
  executablePremium: input.executablePremium,
  contractMultiplier: input.contractMultiplier,
  contractCostUsd,
  positionCostUsd:
    contractCostUsd === null ? 0 : contractCostUsd * quantity,
  independentlyValidatedAvailableCapitalUsd:
    input.independentlyValidatedAvailableCapitalUsd,
  quantity,
  reason
});

export const sizeLeapsEntry = (
  input: LeapsEntrySizingInput
): LeapsEntrySizingResult => {
  if (
    !Number.isFinite(input.executablePremium) ||
    input.executablePremium <= 0
  ) {
    return sizingResult(
      input,
      null,
      0,
      "LEAPS_EXECUTABLE_PREMIUM_INVALID"
    );
  }

  if (input.contractMultiplier !== LEAPS_CONTRACT_MULTIPLIER) {
    return sizingResult(
      input,
      null,
      0,
      "LEAPS_CONTRACT_MULTIPLIER_INVALID"
    );
  }

  const contractCostUsd =
    input.executablePremium * input.contractMultiplier;
  if (!Number.isFinite(contractCostUsd) || contractCostUsd <= 0) {
    return sizingResult(
      input,
      null,
      0,
      "LEAPS_EXECUTABLE_PREMIUM_INVALID"
    );
  }

  if (!validAllocation(input.maxEntryCapitalUsd)) {
    return sizingResult(
      input,
      contractCostUsd,
      0,
      "LEAPS_ENTRY_ALLOCATION_INVALID"
    );
  }

  if (
    !Number.isFinite(input.independentlyValidatedAvailableCapitalUsd) ||
    input.independentlyValidatedAvailableCapitalUsd < 0
  ) {
    return sizingResult(
      input,
      contractCostUsd,
      0,
      "LEAPS_VALIDATED_AVAILABLE_CAPITAL_INVALID"
    );
  }

  if (contractCostUsd > input.maxEntryCapitalUsd) {
    return sizingResult(
      input,
      contractCostUsd,
      0,
      "LEAPS_CONTRACT_COST_EXCEEDS_ALLOCATION"
    );
  }

  if (
    contractCostUsd >
    input.independentlyValidatedAvailableCapitalUsd
  ) {
    return sizingResult(
      input,
      contractCostUsd,
      0,
      "LEAPS_VALIDATED_AVAILABLE_CAPITAL_INSUFFICIENT"
    );
  }

  const quantity = Math.floor(
    Math.min(
      input.maxEntryCapitalUsd,
      input.independentlyValidatedAvailableCapitalUsd
    ) / contractCostUsd
  );
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    return sizingResult(
      input,
      contractCostUsd,
      0,
      "LEAPS_ENTRY_QUANTITY_INVALID"
    );
  }
  return sizingResult(input, contractCostUsd, quantity, null);
};
