import { canonicalJsonHash } from "../../lib/canonicalJson.js";
import {
  ZERO_DTE_STRATEGY_VERSION,
  type ZeroDteConfig
} from "./zeroDteTypes.js";

const DEFAULT_UNDERLYINGS = ["SPY", "QQQ", "IWM"];
const DEFAULT_OUTCOME_HORIZONS_MINUTES = [5, 15, 30, 60];

const readValue = (env: NodeJS.ProcessEnv, name: string) => env[name];

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  switch (value.trim().toLowerCase()) {
    case "true":
    case "1":
      return true;
    case "false":
    case "0":
      return false;
    default:
      return fallback;
  }
};

const parseNonNegativeNumber = (value: string | undefined, fallback: number) => {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const parseNonNegativeInteger = (value: string | undefined, fallback: number) => {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const parseString = (value: string | undefined, fallback: string) => {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
};

const parseSymbolList = (value: string | undefined, fallback: string[]) => {
  if (value === undefined || value.trim() === "") {
    return [...fallback];
  }
  const normalized = Array.from(
    new Set(
      value
        .split(",")
        .map((entry) => entry.trim().toUpperCase())
        .filter(Boolean)
    )
  );
  return normalized.length ? normalized : [...fallback];
};

const parseOutcomeHorizons = (value: string | undefined) => {
  if (value === undefined || value.trim() === "") {
    return [...DEFAULT_OUTCOME_HORIZONS_MINUTES];
  }

  const parsed = value.split(",").map((entry) => Number(entry.trim()));
  if (
    parsed.length === 0 ||
    parsed.some((entry) => !Number.isInteger(entry) || entry < 0)
  ) {
    return [...DEFAULT_OUTCOME_HORIZONS_MINUTES];
  }
  return Array.from(new Set(parsed)).sort((left, right) => left - right);
};

export const loadZeroDteConfig = (env: NodeJS.ProcessEnv = process.env): ZeroDteConfig => {
  const normalized = {
    enabled: parseBoolean(readValue(env, "ZERO_DTE_ENGINE_ENABLED"), true),
    paperExecutionEnabled: parseBoolean(
      readValue(env, "ZERO_DTE_PAPER_EXECUTION_ENABLED"),
      true
    ),
    shadowEnabled: parseBoolean(readValue(env, "ZERO_DTE_SHADOW_ENABLED"), true),
    underlyings: parseSymbolList(readValue(env, "ZERO_DTE_UNDERLYINGS"), DEFAULT_UNDERLYINGS),
    discoveryStartEt: parseString(
      readValue(env, "ZERO_DTE_DISCOVERY_START_ET"),
      "09:35"
    ),
    newEntryCutoffEt: parseString(
      readValue(env, "ZERO_DTE_NEW_ENTRY_CUTOFF_ET"),
      "15:15"
    ),
    forceExitEt: parseString(readValue(env, "ZERO_DTE_FORCE_EXIT_ET"), "15:50"),
    engineIntervalSeconds: parseNonNegativeInteger(
      readValue(env, "ZERO_DTE_ENGINE_INTERVAL_SECONDS"),
      60
    ),
    queueMaxActive: parseNonNegativeInteger(
      readValue(env, "ZERO_DTE_QUEUE_MAX_ACTIVE"),
      100
    ),
    queueTopN: parseNonNegativeInteger(readValue(env, "ZERO_DTE_QUEUE_TOP_N"), 20),
    executionTopN: parseNonNegativeInteger(
      readValue(env, "ZERO_DTE_EXECUTION_TOP_N"),
      3
    ),
    maxStrikesEachSide: parseNonNegativeInteger(
      readValue(env, "ZERO_DTE_MAX_STRIKES_EACH_SIDE"),
      5
    ),
    minOptionVolume: parseNonNegativeInteger(
      readValue(env, "ZERO_DTE_MIN_OPTION_VOLUME"),
      100
    ),
    minOpenInterest: parseNonNegativeInteger(
      readValue(env, "ZERO_DTE_MIN_OPEN_INTEREST"),
      250
    ),
    maxSpreadPct: parseNonNegativeNumber(readValue(env, "ZERO_DTE_MAX_SPREAD_PCT"), 15),
    minPremium: parseNonNegativeNumber(readValue(env, "ZERO_DTE_MIN_PREMIUM"), 0.1),
    maxPremium: parseNonNegativeNumber(readValue(env, "ZERO_DTE_MAX_PREMIUM"), 5),
    signalShortWindow: parseNonNegativeInteger(
      readValue(env, "ZERO_DTE_SIGNAL_SHORT_WINDOW"),
      3
    ),
    signalMediumWindow: parseNonNegativeInteger(
      readValue(env, "ZERO_DTE_SIGNAL_MEDIUM_WINDOW"),
      5
    ),
    minConfirmationObservations: parseNonNegativeInteger(
      readValue(env, "ZERO_DTE_MIN_CONFIRMATION_OBSERVATIONS"),
      2
    ),
    maxContractsPerTrade: parseNonNegativeInteger(
      readValue(env, "ZERO_DTE_MAX_CONTRACTS_PER_TRADE"),
      1
    ),
    maxOpenPositions: parseNonNegativeInteger(
      readValue(env, "ZERO_DTE_MAX_OPEN_POSITIONS"),
      3
    ),
    maxTradesPerDay: parseNonNegativeInteger(
      readValue(env, "ZERO_DTE_MAX_TRADES_PER_DAY"),
      3
    ),
    maxPremiumPerTrade: parseNonNegativeNumber(
      readValue(env, "ZERO_DTE_MAX_PREMIUM_PER_TRADE"),
      250
    ),
    maxDailyPremium: parseNonNegativeNumber(
      readValue(env, "ZERO_DTE_MAX_DAILY_PREMIUM"),
      750
    ),
    maxDailyRealizedLoss: parseNonNegativeNumber(
      readValue(env, "ZERO_DTE_MAX_DAILY_REALIZED_LOSS"),
      250
    ),
    outcomeHorizonsMinutes: parseOutcomeHorizons(
      readValue(env, "ZERO_DTE_OUTCOME_HORIZONS_MINUTES")
    ),
    strategyVersion: parseString(
      readValue(env, "ZERO_DTE_STRATEGY_VERSION"),
      ZERO_DTE_STRATEGY_VERSION
    )
  };

  return {
    ...normalized,
    configurationVersionId: canonicalJsonHash(normalized)
  };
};
