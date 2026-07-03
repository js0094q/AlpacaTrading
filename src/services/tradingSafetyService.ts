export type AlpacaEnvironment = "paper" | "live";

export interface TradingSafetyState {
  alpacaEnv: AlpacaEnvironment;
  liveTradingEnabled: boolean;
  paperOnly: boolean;
  mutationAllowed: boolean;
  liveMutationAllowed: boolean;
}

const parseBoolean = (value: string | undefined): boolean =>
  value === "true" || value === "1";

const parseAlpacaEnv = (): AlpacaEnvironment => {
  const value = String(process.env.ALPACA_ENV || "paper").toLowerCase();
  return value === "live" ? "live" : "paper";
};

export const getTradingSafetyState = (): TradingSafetyState => {
  const alpacaEnv = parseAlpacaEnv();
  const liveTradingEnabled = parseBoolean(process.env.LIVE_TRADING_ENABLED) || parseBoolean(process.env.ALPACA_LIVE_TRADE);

  return {
    alpacaEnv,
    liveTradingEnabled,
    paperOnly: alpacaEnv === "paper" && !liveTradingEnabled,
    mutationAllowed: false,
    liveMutationAllowed: false
  };
};

const buildGuardError = (message: string) => {
  return new Error(message);
};

export const assertReadOnlyAlpacaAccessAllowed = (): void => {
  const state = getTradingSafetyState();
  if (!state.paperOnly) {
    throw buildGuardError(
      "Alpaca read-only access is disabled. Configure ALPACA_ENV=paper and LIVE_TRADING_ENABLED=false."
    );
  }
};

export const assertNoTradingMutationsAllowed = (): void => {
  const state = getTradingSafetyState();
  if (!state.mutationAllowed) {
    throw buildGuardError("Trading mutation operations are disabled in this phase.");
  }
  if (state.liveMutationAllowed) {
    return;
  }
  throw buildGuardError("Live mutation operations are disabled in this phase.");
};

export const assertLiveTradingDisabled = (): void => {
  const state = getTradingSafetyState();
  if (state.liveTradingEnabled) {
    throw buildGuardError(
      "Live trading is disabled by default. Set LIVE_TRADING_ENABLED=true only for an explicitly enabled live phase."
    );
  }
};
