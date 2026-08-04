export type TradingRuntimeEnvironment = "paper" | "live";
export type TradingRuntimeConfirmation = TradingRuntimeEnvironment | null;

export type TradingRuntimeAuthorityInput = {
  readonly environment: string;
  readonly tradingMode: string;
  readonly liveTradingEnabled: boolean;
  readonly paperOrderExecutionEnabled: boolean;
  readonly paperOptionsExecutionEnabled: boolean;
  readonly liveOrderExecutionEnabled: boolean;
  readonly liveOptionsExecutionEnabled: boolean;
  readonly killSwitchEngaged: boolean;
  readonly confirmation: TradingRuntimeConfirmation;
  readonly assetClass: "equity" | "option";
  readonly brokerAccountId?: string;
  readonly authorizedBrokerAccountId?: string;
  readonly runningReleaseSha?: string;
  readonly authorizedReleaseSha?: string;
  readonly liveAuthorizationId?: string;
  readonly liveAuthorizationExpiresAt?: string;
  readonly liveCanaryEnabled?: boolean;
  readonly estimatedOrderNotionalUsd?: number;
  readonly maxOrderNotionalUsd?: number;
  readonly dailyRealizedPnlUsd?: number;
  readonly dailyLossLimitUsd?: number;
  readonly now: Date;
};

export type TradingRuntimeAuthorityDecision = {
  readonly authorized: boolean;
  readonly environment: TradingRuntimeEnvironment | null;
  readonly blockers: readonly string[];
};

const SHA_1 = /^[0-9a-f]{40}$/i;
const CANONICAL_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const parseCanonicalUtcInstant = (value: string | undefined): number | null => {
  if (!value || !CANONICAL_UTC_INSTANT.test(value)) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString() === value ? timestamp : null;
};

export const evaluateTradingRuntimeAuthority = (
  input: TradingRuntimeAuthorityInput
): TradingRuntimeAuthorityDecision => {
  const environment = input.environment === "paper" || input.environment === "live"
    ? input.environment
    : null;
  const blockers: string[] = [];
  const nowTimestamp = input.now.getTime();

  if (!environment) {
    return {
      authorized: false,
      environment: null,
      blockers: ["TRADING_RUNTIME_ENVIRONMENT_INVALID"]
    };
  }
  if (!Number.isFinite(nowTimestamp)) blockers.push("TRADING_RUNTIME_CLOCK_INVALID");
  if (input.killSwitchEngaged) blockers.push("TRADING_KILL_SWITCH_ENGAGED");

  if (environment === "paper") {
    if (input.tradingMode !== "paper") blockers.push("PAPER_TRADING_MODE_REQUIRED");
    if (
      input.liveTradingEnabled ||
      input.liveOrderExecutionEnabled ||
      input.liveOptionsExecutionEnabled
    ) {
      blockers.push("PAPER_LIVE_EXECUTION_MUST_BE_DISABLED");
    }
    if (!input.paperOrderExecutionEnabled) {
      blockers.push("PAPER_ORDER_EXECUTION_DISABLED");
    }
    if (input.assetClass === "option" && !input.paperOptionsExecutionEnabled) {
      blockers.push("PAPER_OPTIONS_EXECUTION_DISABLED");
    }
    if (input.confirmation !== "paper") blockers.push("PAPER_CONFIRMATION_REQUIRED");
  } else {
    if (input.tradingMode !== "live") blockers.push("LIVE_TRADING_MODE_REQUIRED");
    if (!input.liveTradingEnabled) blockers.push("LIVE_TRADING_NOT_ENABLED");
    if (input.paperOrderExecutionEnabled || input.paperOptionsExecutionEnabled) {
      blockers.push("LIVE_PAPER_EXECUTION_MUST_BE_DISABLED");
    }
    if (!input.liveOrderExecutionEnabled) blockers.push("LIVE_ORDER_EXECUTION_DISABLED");
    if (input.assetClass === "option" && !input.liveOptionsExecutionEnabled) {
      blockers.push("LIVE_OPTIONS_EXECUTION_DISABLED");
    }
    if (input.confirmation !== "live") blockers.push("LIVE_CONFIRMATION_REQUIRED");
    if (!input.liveAuthorizationId?.trim()) blockers.push("LIVE_AUTHORIZATION_REQUIRED");

    const authorizationExpiry = parseCanonicalUtcInstant(input.liveAuthorizationExpiresAt);
    if (
      authorizationExpiry === null ||
      !Number.isFinite(nowTimestamp) ||
      authorizationExpiry <= nowTimestamp
    ) {
      blockers.push("LIVE_AUTHORIZATION_EXPIRED");
    }
    if (!input.liveCanaryEnabled) blockers.push("LIVE_CANARY_REQUIRED");

    if (
      !input.brokerAccountId?.trim() ||
      !input.authorizedBrokerAccountId?.trim() ||
      input.brokerAccountId !== input.authorizedBrokerAccountId
    ) {
      blockers.push("LIVE_BROKER_ACCOUNT_MISMATCH");
    }
    if (
      !input.runningReleaseSha ||
      !input.authorizedReleaseSha ||
      !SHA_1.test(input.runningReleaseSha) ||
      !SHA_1.test(input.authorizedReleaseSha) ||
      input.runningReleaseSha !== input.authorizedReleaseSha
    ) {
      blockers.push("LIVE_RELEASE_SHA_MISMATCH");
    }

    if (
      !Number.isFinite(input.maxOrderNotionalUsd) ||
      Number(input.maxOrderNotionalUsd) <= 0 ||
      !Number.isFinite(input.estimatedOrderNotionalUsd) ||
      Number(input.estimatedOrderNotionalUsd) <= 0
    ) {
      blockers.push("LIVE_ORDER_NOTIONAL_INVALID");
    } else if (
      Number(input.estimatedOrderNotionalUsd) > Number(input.maxOrderNotionalUsd)
    ) {
      blockers.push("LIVE_ORDER_NOTIONAL_EXCEEDS_LIMIT");
    }

    if (
      !Number.isFinite(input.dailyLossLimitUsd) ||
      Number(input.dailyLossLimitUsd) <= 0 ||
      !Number.isFinite(input.dailyRealizedPnlUsd)
    ) {
      blockers.push("LIVE_DAILY_LOSS_LIMIT_INVALID");
    } else if (
      Number(input.dailyRealizedPnlUsd) <= -Number(input.dailyLossLimitUsd)
    ) {
      blockers.push("LIVE_DAILY_LOSS_LIMIT_BREACHED");
    }
  }

  return {
    authorized: blockers.length === 0,
    environment,
    blockers
  };
};
