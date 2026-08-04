import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateTradingRuntimeAuthority,
  type TradingRuntimeAuthorityInput
} from "../src/services/tradingRuntimeAuthority.js";

const paperInput = (
  overrides: Partial<TradingRuntimeAuthorityInput> = {}
): TradingRuntimeAuthorityInput => ({
  environment: "paper",
  tradingMode: "paper",
  liveTradingEnabled: false,
  paperOrderExecutionEnabled: true,
  paperOptionsExecutionEnabled: true,
  liveOrderExecutionEnabled: false,
  liveOptionsExecutionEnabled: false,
  killSwitchEngaged: false,
  confirmation: "paper",
  assetClass: "equity",
  now: new Date("2026-08-04T13:00:00.000Z"),
  ...overrides
});

const liveInput = (
  overrides: Partial<TradingRuntimeAuthorityInput> = {}
): TradingRuntimeAuthorityInput => ({
  environment: "live",
  tradingMode: "live",
  liveTradingEnabled: true,
  paperOrderExecutionEnabled: false,
  paperOptionsExecutionEnabled: false,
  liveOrderExecutionEnabled: true,
  liveOptionsExecutionEnabled: true,
  killSwitchEngaged: false,
  confirmation: "live",
  assetClass: "equity",
  brokerAccountId: "live-account-1",
  authorizedBrokerAccountId: "live-account-1",
  runningReleaseSha: "1111111111111111111111111111111111111111",
  authorizedReleaseSha: "1111111111111111111111111111111111111111",
  liveAuthorizationId: "approval-2026-08-04-a",
  liveAuthorizationExpiresAt: "2026-08-04T14:00:00.000Z",
  liveCanaryEnabled: true,
  estimatedOrderNotionalUsd: 250,
  maxOrderNotionalUsd: 500,
  dailyRealizedPnlUsd: -50,
  dailyLossLimitUsd: 1_000,
  now: new Date("2026-08-04T13:00:00.000Z"),
  ...overrides
});

test("authorizes an explicitly confirmed paper runtime without live gates", () => {
  assert.deepEqual(evaluateTradingRuntimeAuthority(paperInput()), {
    authorized: true,
    environment: "paper",
    blockers: []
  });
});

test("blocks paper when live execution is simultaneously armed", () => {
  assert.deepEqual(
    evaluateTradingRuntimeAuthority(paperInput({ liveOrderExecutionEnabled: true })),
    {
      authorized: false,
      environment: "paper",
      blockers: ["PAPER_LIVE_EXECUTION_MUST_BE_DISABLED"]
    }
  );
});

test("authorizes live only when its complete bounded authority is present", () => {
  assert.deepEqual(evaluateTradingRuntimeAuthority(liveInput()), {
    authorized: true,
    environment: "live",
    blockers: []
  });
});

test("blocks live when paper execution is armed or identity evidence disagrees", () => {
  assert.deepEqual(
    evaluateTradingRuntimeAuthority(liveInput({
      paperOrderExecutionEnabled: true,
      brokerAccountId: "unexpected-live-account",
      runningReleaseSha: "2222222222222222222222222222222222222222"
    })),
    {
      authorized: false,
      environment: "live",
      blockers: [
        "LIVE_PAPER_EXECUTION_MUST_BE_DISABLED",
        "LIVE_BROKER_ACCOUNT_MISMATCH",
        "LIVE_RELEASE_SHA_MISMATCH"
      ]
    }
  );
});

test("blocks live options after a kill switch, risk breach, or missing option gate", () => {
  assert.deepEqual(
    evaluateTradingRuntimeAuthority(liveInput({
      assetClass: "option",
      liveOptionsExecutionEnabled: false,
      killSwitchEngaged: true,
      estimatedOrderNotionalUsd: 750,
      dailyRealizedPnlUsd: -1_000
    })),
    {
      authorized: false,
      environment: "live",
      blockers: [
        "TRADING_KILL_SWITCH_ENGAGED",
        "LIVE_OPTIONS_EXECUTION_DISABLED",
        "LIVE_ORDER_NOTIONAL_EXCEEDS_LIMIT",
        "LIVE_DAILY_LOSS_LIMIT_BREACHED"
      ]
    }
  );
});

test("blocks expired or missing live approval and canary evidence", () => {
  assert.deepEqual(
    evaluateTradingRuntimeAuthority(liveInput({
      liveAuthorizationId: "",
      liveAuthorizationExpiresAt: "2026-08-04T12:59:59.999Z",
      liveCanaryEnabled: false,
      confirmation: null
    })),
    {
      authorized: false,
      environment: "live",
      blockers: [
        "LIVE_CONFIRMATION_REQUIRED",
        "LIVE_AUTHORIZATION_REQUIRED",
        "LIVE_AUTHORIZATION_EXPIRED",
        "LIVE_CANARY_REQUIRED"
      ]
    }
  );
});

test("blocks live authority when the current clock is invalid", () => {
  const decision = evaluateTradingRuntimeAuthority(liveInput({
    now: new Date("invalid"),
    liveAuthorizationExpiresAt: "2020-01-01T00:00:00.000Z"
  }));

  assert.equal(decision.authorized, false);
  assert.ok(decision.blockers.includes("TRADING_RUNTIME_CLOCK_INVALID"));
});

test("blocks an impossible live authorization expiry instead of normalizing it", () => {
  const decision = evaluateTradingRuntimeAuthority(liveInput({
    now: new Date("2026-02-28T12:00:00.000Z"),
    liveAuthorizationExpiresAt: "2026-02-30T12:00:00.000Z"
  }));

  assert.equal(decision.authorized, false);
  assert.ok(decision.blockers.includes("LIVE_AUTHORIZATION_EXPIRED"));
});

test("blocks live authority at the exact authorization-expiry boundary", () => {
  const decision = evaluateTradingRuntimeAuthority(liveInput({
    now: new Date("2026-08-04T14:00:00.000Z"),
    liveAuthorizationExpiresAt: "2026-08-04T14:00:00.000Z"
  }));

  assert.equal(decision.authorized, false);
  assert.ok(decision.blockers.includes("LIVE_AUTHORIZATION_EXPIRED"));
});

test("accepts a canonical UTC expiry strictly after a valid current time", () => {
  assert.deepEqual(
    evaluateTradingRuntimeAuthority(liveInput({
      now: new Date("2026-08-04T13:59:59.999Z"),
      liveAuthorizationExpiresAt: "2026-08-04T14:00:00.000Z"
    })),
    {
      authorized: true,
      environment: "live",
      blockers: []
    }
  );
});
