import assert from "node:assert/strict";
import test from "node:test";

import { targetIdentity } from "../src/services/targetIdentityService.js";

test("option identity binds its lane and exact contract", () => {
  assert.deepEqual(targetIdentity({
    strategyFamily: "zero_dte_spy",
    preferredExpression: "long_call",
    optionSymbol: "SPY260803C00630000"
  }), {
    strategyFamily: "zero_dte_spy",
    expressionId: "option:SPY260803C00630000"
  });
});

test("equity identity binds the explicit expression", () => {
  assert.deepEqual(targetIdentity({
    strategyFamily: "equity",
    preferredExpression: "shares",
    optionSymbol: null
  }), {
    strategyFamily: "equity",
    expressionId: "equity:shares"
  });
});

test("an option lane without an option symbol fails closed", () => {
  assert.throws(() => targetIdentity({
    strategyFamily: "leaps",
    preferredExpression: "long_call",
    optionSymbol: null
  }), /TARGET_OPTION_EXPRESSION_ID_REQUIRED/);
});

test("portfolio hedge identity binds its lane and exact option contract", () => {
  assert.deepEqual(targetIdentity({
    strategyFamily: "portfolio_hedge",
    preferredExpression: "protective_put",
    optionSymbol: "SPY260803P00570000"
  }), {
    strategyFamily: "portfolio_hedge",
    expressionId: "option:SPY260803P00570000"
  });
});

test("identity normalizes expression and option contract whitespace", () => {
  assert.deepEqual(targetIdentity({
    strategyFamily: "standard_option",
    preferredExpression: "  Long_Call  ",
    optionSymbol: " spy260803c00630000 "
  }), {
    strategyFamily: "standard_option",
    expressionId: "option:SPY260803C00630000"
  });

  assert.deepEqual(targetIdentity({
    strategyFamily: "equity",
    preferredExpression: "  Shares  ",
    optionSymbol: null
  }), {
    strategyFamily: "equity",
    expressionId: "equity:shares"
  });
});

test("unknown and legacy strategy families fail closed at runtime", () => {
  assert.throws(() => targetIdentity({
    strategyFamily: "unknown" as never,
    preferredExpression: "shares",
    optionSymbol: null
  }), /TARGET_STRATEGY_FAMILY_INVALID/);

  assert.throws(() => targetIdentity({
    strategyFamily: "legacy_default" as never,
    preferredExpression: "shares",
    optionSymbol: null
  }), /TARGET_STRATEGY_FAMILY_INVALID/);
});
