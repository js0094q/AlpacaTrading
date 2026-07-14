import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dbDir = mkdtempSync(join(tmpdir(), "zero-dte-level-2-exit-"));
process.env.RESEARCH_DB_PATH = join(dbDir, "research.db");

import { closeDbForTests, getDb } from "../src/lib/db.js";
import {
  reviewZeroDteExits,
  type ZeroDteExitProvider
} from "../src/services/zeroDte/zeroDteExitService.js";
import type { PaperExitExecutionResult, PaperExitReviewResult } from "../src/types/paperExit.js";

const now = "2026-07-13T19:00:00.000Z";
const optionSymbol = "SPY260713C00500000";

const review = (): PaperExitReviewResult => ({
  status: "ok",
  environment: "paper",
  mutationAttempted: false,
  generatedAt: now,
  account: { cash: 10_000, equity: 10_000, buyingPower: 10_000, positionMarketValue: 100 },
  reconciliation: { status: "ok", sumPositionsMarketValue: 100, accountPositionMarketValue: 100, events: [] },
  exitCandidates: [
    {
      symbol: optionSymbol,
      assetClass: "us_option",
      positionClass: "option_0dte",
      qty: "1",
      qtyAvailable: "1",
      avgEntryPrice: 1,
      currentPrice: 0.5,
      marketValue: 50,
      unrealizedPl: -50,
      unrealizedPlpc: -0.5,
      reason: "ODTE_STOP_LOSS_50",
      orderPayload: {
        symbol: optionSymbol,
        assetClass: "us_option",
        side: "sell",
        positionIntent: "sell_to_close",
        qty: "1",
        orderType: "limit",
        timeInForce: "day",
        reason: "ODTE_STOP_LOSS_50",
        limitPrice: "0.50",
        clientOrderId: "paper-exit-0dte-1"
      }
    },
    {
      symbol: "SPY260918C00500000",
      assetClass: "us_option",
      positionClass: "option_leaps",
      qty: "1",
      qtyAvailable: "1",
      avgEntryPrice: 1,
      currentPrice: 1,
      marketValue: 100,
      unrealizedPl: 0,
      unrealizedPlpc: 0,
      reason: "LEAPS_STOP",
      orderPayload: {
        symbol: "SPY260918C00500000",
        assetClass: "us_option",
        side: "sell",
        positionIntent: "sell_to_close",
        qty: "1",
        orderType: "limit",
        timeInForce: "day",
        reason: "LEAPS_STOP",
        limitPrice: "1.00",
        clientOrderId: "paper-exit-leaps-1"
      }
    }
  ],
  skipped: [],
  alpacaRequestIds: {}
});

const execution = (): PaperExitExecutionResult => ({
  status: "ok",
  environment: "paper",
  mutationAttempted: true,
  submittedOrders: [{
    symbol: optionSymbol,
    side: "sell",
    qty: "1",
    assetClass: "us_option",
    positionIntent: "sell_to_close",
    reason: "ODTE_STOP_LOSS_50",
    alpacaOrderId: "exit-order-1",
    clientOrderId: "paper-exit-0dte-1",
    alpacaRequestId: "exit-request-1",
    status: "accepted"
  }],
  skipped: [],
  review: review()
});

const seedPaperTrade = () => {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_configuration_versions
      (configuration_version_id, strategy_version, configuration_hash, configuration_json, created_at)
     VALUES ('exit-config', 'zero-dte-level-2-v1', 'exit-hash', '{}', ?)`
  ).run(now);
  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_engine_runs
      (run_id, trading_date, mode, account_mode, status, strategy_version,
       configuration_version_id, started_at, created_at)
     VALUES ('exit-run', '2026-07-13', 'test', 'paper', 'running', 'zero-dte-level-2-v1', 'exit-config', ?, ?)`
  ).run(now, now);
  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_candidates
      (candidate_id, trading_date, underlying_symbol, option_symbol, playbook, direction,
       expiration_date, strike, state, first_seen_at, last_seen_at, state_changed_at,
       created_at, updated_at)
     VALUES ('exit-candidate', '2026-07-13', 'SPY', ?, 'trend_continuation', 'bullish',
       '2026-07-13', 500, 'executed', ?, ?, ?, ?, ?)`
  ).run(optionSymbol, now, now, now, now, now);
  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_decisions
      (decision_id, decision_group_id, engine_run_id, candidate_id, trading_date, action,
       account_mode, strategy_version, configuration_version_id, decided_at, created_at)
     VALUES ('exit-decision', 'exit-group', 'exit-run', 'exit-candidate', '2026-07-13',
       'execute', 'paper', 'zero-dte-level-2-v1', 'exit-config', ?, ?)`
  ).run(now, now);
  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_paper_trades
      (paper_trade_id, decision_id, candidate_id, trading_date, underlying_symbol,
       option_symbol, playbook, direction, status, quantity, entry_premium, created_at, updated_at)
     VALUES ('exit-trade', 'exit-decision', 'exit-candidate', '2026-07-13', 'SPY', ?,
       'trend_continuation', 'bullish', 'open', 1, 1.00, ?, ?)`
  ).run(optionSymbol, now, now);
};

after(() => {
  closeDbForTests();
  rmSync(dbDir, { recursive: true, force: true });
});

test("exit review delegates approved policy and excludes non-0DTE positions", async () => {
  seedPaperTrade();
  let reviewedInput: Record<string, unknown> | null = null;
  let executionCalls = 0;
  const provider: ZeroDteExitProvider = {
    review: async (input) => {
      reviewedInput = input as unknown as Record<string, unknown>;
      return review();
    },
    execute: async () => {
      executionCalls += 1;
      return execution();
    }
  };

  const result = await reviewZeroDteExits({ now, confirmPaper: false, provider });
  assert.equal(result.status, "review_only");
  assert.equal(result.review.exitCandidates.length, 1);
  assert.equal(result.review.exitCandidates[0]?.positionClass, "option_0dte");
  const captured: Record<string, unknown> = reviewedInput ?? {};
  assert.equal(captured.include0DTE, true);
  assert.equal(captured.includeLEAPS, false);
  assert.equal(captured.includeEquities, false);
  assert.equal(executionCalls, 0);
});

test("confirmed exit links the submitted result to the Level 2 trade", async () => {
  seedPaperTrade();
  const provider: ZeroDteExitProvider = {
    review: async () => review(),
    execute: async () => execution()
  };

  const result = await reviewZeroDteExits({ now, confirmPaper: true, provider });
  assert.equal(result.status, "submitted");
  assert.equal(result.execution?.submittedOrders.length, 1);
  assert.equal(result.links[0]?.paperTradeId, "exit-trade");
  assert.equal(
    (getDb().prepare("SELECT COUNT(*) AS count FROM zero_dte_lifecycle_events WHERE event_type = 'exit_order_requested'").get() as { count: number }).count,
    1
  );
});
