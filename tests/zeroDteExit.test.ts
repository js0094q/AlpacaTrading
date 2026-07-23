import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dbDir = mkdtempSync(join(tmpdir(), "zero-dte-level-2-exit-"));
process.env.RESEARCH_DB_PATH = join(dbDir, "research.db");

import { closeDbForTests, getDb } from "../src/lib/db.js";
import {
  reconcileZeroDteExitOrders,
  reviewZeroDteExits,
  type ZeroDteExitProvider
} from "../src/services/zeroDte/zeroDteExitService.js";
import type { PaperExitExecutionResult, PaperExitReviewResult } from "../src/types/paperExit.js";
import { withExecutionAuthority } from "./helpers/executionAuthorityRuntime.js";

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

const execution = (status = "accepted"): PaperExitExecutionResult => ({
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
    status
  }],
  skipped: [],
  review: review()
});

const seedPaperTrade = () => {
  const db = getDb();
  db.exec(`
    DELETE FROM zero_dte_terminal_outcomes;
    DELETE FROM zero_dte_lifecycle_events;
    DELETE FROM zero_dte_position_marks;
    DELETE FROM zero_dte_paper_trades;
    DELETE FROM zero_dte_decisions;
    DELETE FROM zero_dte_playbook_evaluations;
    DELETE FROM zero_dte_candidate_observations;
    DELETE FROM zero_dte_candidates;
    DELETE FROM zero_dte_engine_runs;
    DELETE FROM zero_dte_configuration_versions;
    DELETE FROM paper_execution_ledger;
  `);
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
       option_symbol, playbook, direction, status, quantity, entry_premium, filled_at,
       created_at, updated_at)
     VALUES ('exit-trade', 'exit-decision', 'exit-candidate', '2026-07-13', 'SPY', ?,
       'trend_continuation', 'bullish', 'open', 1, 1.00, '2026-07-13T18:00:00.000Z', ?, ?)`
  ).run(optionSymbol, now, now);
};

const paperRuntime = {
  environment: "paper",
  tradingMode: "paper",
  paperOnly: true,
  liveTradingEnabled: false,
  engineEnabled: true,
  paperExecutionEnabled: true,
  paperOptionsExecutionEnabled: true,
  automatedPaperExecutionEnabled: false,
  paperAccountVerified: true,
  marketOpen: true,
  tradingDate: "2026-07-13"
};

const filledExitOrder = (overrides: Record<string, unknown> = {}) => ({
  data: {
    id: "exit-order-1",
    client_order_id: "paper-exit-0dte-1",
    symbol: optionSymbol,
    qty: "1",
    side: "sell",
    position_intent: "sell_to_close",
    status: "filled",
    filled_qty: "1",
    filled_avg_price: "0.45",
    filled_at: "2026-07-13T19:02:00.000Z",
    ...overrides
  },
  status: 200,
  url: "https://paper-api.alpaca.markets/v2/orders/exit-order-1",
  requestId: "exit-reconcile-request-1"
});

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
  const trade = getDb().prepare(
    "SELECT status, exit_premium FROM zero_dte_paper_trades WHERE paper_trade_id = 'exit-trade'"
  ).get() as { status: string; exit_premium: number | null };
  assert.equal(trade.status, "exit_requested");
  assert.equal(trade.exit_premium, null);
  const ledger = getDb().prepare(
    `SELECT mode, status, decision_id, decision_linkage_status
     FROM paper_execution_ledger
     WHERE client_order_id = 'paper-exit-0dte-1'`
  ).get() as {
    mode: string;
    status: string;
    decision_id: string | null;
    decision_linkage_status: string;
  };
  assert.equal(ledger.mode, "zero-dte-exit");
  assert.equal(ledger.status, "accepted");
  assert.equal(ledger.decision_id, "exit-decision");
  assert.equal(ledger.decision_linkage_status, "EXACT");
});

test("PostgreSQL execution authority does not mutate SQLite 0DTE exit state", async () => {
  seedPaperTrade();
  const result = await withExecutionAuthority(() =>
    reviewZeroDteExits({
      now,
      confirmPaper: true,
      provider: {
        review: async () => review(),
        execute: async () => execution()
      }
    })
  );

  assert.equal(result.status, "submitted");
  assert.equal(result.links[0]?.paperTradeId, null);
  assert.equal(
    (getDb().prepare(
      "SELECT status FROM zero_dte_paper_trades WHERE paper_trade_id = 'exit-trade'"
    ).get() as { status: string }).status,
    "open"
  );
  assert.equal(
    (getDb().prepare(
      "SELECT COUNT(*) AS count FROM paper_execution_ledger WHERE client_order_id = 'paper-exit-0dte-1'"
    ).get() as { count: number }).count,
    0
  );
  assert.equal(
    (getDb().prepare(
      "SELECT COUNT(*) AS count FROM zero_dte_lifecycle_events WHERE event_type IN ('exit_triggered', 'exit_order_requested')"
    ).get() as { count: number }).count,
    0
  );
});

test("PostgreSQL authority bypasses legacy SQLite exit reconciliation", async () => {
  seedPaperTrade();
  let brokerReads = 0;
  const counts = () => ({
    ledger: (getDb().prepare("SELECT COUNT(*) AS count FROM paper_execution_ledger").get() as { count: number }).count,
    trades: (getDb().prepare("SELECT COUNT(*) AS count FROM zero_dte_paper_trades").get() as { count: number }).count,
    lifecycle: (getDb().prepare("SELECT COUNT(*) AS count FROM zero_dte_lifecycle_events").get() as { count: number }).count
  });
  const before = counts();

  const result = await withExecutionAuthority(() => reconcileZeroDteExitOrders({
    now,
    provider: {
      runtime: paperRuntime,
      getOrder: async () => {
        brokerReads += 1;
        throw new Error("Legacy exit reconciliation must be bypassed.");
      }
    }
  }));

  assert.equal(brokerReads, 0);
  assert.equal(result.checked, 0);
  assert.deepEqual(counts(), before);
});

test("an immediate filled submission remains pending exact broker reconciliation", async () => {
  seedPaperTrade();
  const result = await reviewZeroDteExits({
    now,
    confirmPaper: true,
    provider: {
      review: async () => review(),
      execute: async () => execution("filled")
    }
  });
  assert.equal(result.status, "submitted");
  const trade = getDb().prepare(
    "SELECT status, exit_premium, exited_at FROM zero_dte_paper_trades WHERE paper_trade_id = 'exit-trade'"
  ).get() as { status: string; exit_premium: number | null; exited_at: string | null };
  assert.equal(trade.status, "exit_requested");
  assert.equal(trade.exit_premium, null);
  assert.equal(trade.exited_at, null);
});

test("exit reconciliation validates the exact broker fill and persists closure once", async () => {
  seedPaperTrade();
  await reviewZeroDteExits({
    now,
    confirmPaper: true,
    provider: {
      review: async () => review(),
      execute: async () => execution()
    }
  });
  getDb().prepare(
    "DELETE FROM paper_execution_ledger WHERE client_order_id = 'paper-exit-0dte-1'"
  ).run();

  const first = await reconcileZeroDteExitOrders({
    now: "2026-07-13T19:03:00.000Z",
    provider: {
      runtime: paperRuntime,
      getOrder: async () => filledExitOrder()
    }
  });
  assert.equal(first.checked, 1);
  assert.equal(first.updated, 1);
  assert.equal(first.filled, 1);
  assert.equal(first.linkageUpdated, 1);
  assert.equal(first.errors.length, 0);

  const trade = getDb().prepare(
    `SELECT status, exit_premium, exited_at, realized_pnl, return_pct, terminal_state
     FROM zero_dte_paper_trades
     WHERE paper_trade_id = 'exit-trade'`
  ).get() as {
    status: string;
    exit_premium: number;
    exited_at: string;
    realized_pnl: number;
    return_pct: number;
    terminal_state: string;
  };
  assert.equal(trade.status, "closed");
  assert.equal(trade.exit_premium, 0.45);
  assert.equal(trade.exited_at, "2026-07-13T19:02:00.000Z");
  assert.equal(trade.realized_pnl, -55);
  assert.equal(trade.return_pct, -55);
  assert.equal(trade.terminal_state, "closed");

  const ledger = getDb().prepare(
    `SELECT status, alpaca_status, decision_id, decision_linkage_status
     FROM paper_execution_ledger
     WHERE client_order_id = 'paper-exit-0dte-1'`
  ).get() as {
    status: string;
    alpaca_status: string;
    decision_id: string;
    decision_linkage_status: string;
  };
  assert.equal(ledger.status, "filled");
  assert.equal(ledger.alpaca_status, "filled");
  assert.equal(ledger.decision_id, "exit-decision");
  assert.equal(ledger.decision_linkage_status, "EXACT");

  const outcome = getDb().prepare(
    `SELECT outcome_type, terminal_state, terminal_price, realized_pnl,
            holding_minutes, completeness_status
     FROM zero_dte_terminal_outcomes
     WHERE paper_trade_id = 'exit-trade'`
  ).get() as {
    outcome_type: string;
    terminal_state: string;
    terminal_price: number;
    realized_pnl: number;
    holding_minutes: number;
    completeness_status: string;
  };
  assert.equal(outcome.outcome_type, "paper_trade");
  assert.equal(outcome.terminal_state, "closed");
  assert.equal(outcome.terminal_price, 0.45);
  assert.equal(outcome.realized_pnl, -55);
  assert.equal(outcome.holding_minutes, 62);
  assert.equal(outcome.completeness_status, "complete");

  const second = await reconcileZeroDteExitOrders({
    now: "2026-07-13T19:04:00.000Z",
    provider: {
      runtime: paperRuntime,
      getOrder: async () => filledExitOrder()
    }
  });
  assert.equal(second.checked, 0);
  assert.equal(
    (getDb().prepare("SELECT COUNT(*) AS count FROM zero_dte_lifecycle_events WHERE event_type = 'position_closed'").get() as { count: number }).count,
    1
  );
  assert.equal(
    (getDb().prepare("SELECT COUNT(*) AS count FROM zero_dte_lifecycle_events WHERE event_type = 'terminal_outcome_recorded'").get() as { count: number }).count,
    1
  );
  assert.equal(
    (getDb().prepare("SELECT COUNT(*) AS count FROM zero_dte_terminal_outcomes WHERE paper_trade_id = 'exit-trade'").get() as { count: number }).count,
    1
  );
});

test("exit reconciliation fails closed on broker identity mismatch", async () => {
  seedPaperTrade();
  await reviewZeroDteExits({
    now,
    confirmPaper: true,
    provider: {
      review: async () => review(),
      execute: async () => execution()
    }
  });

  const result = await reconcileZeroDteExitOrders({
    now: "2026-07-13T19:03:00.000Z",
    provider: {
      runtime: paperRuntime,
      getOrder: async () => filledExitOrder({ symbol: "QQQ260713C00500000" })
    }
  });
  assert.equal(result.checked, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.errors[0]?.code, "EXIT_ORDER_RECONCILIATION_FAILED");
  assert.equal(
    (getDb().prepare("SELECT status FROM zero_dte_paper_trades WHERE paper_trade_id = 'exit-trade'").get() as { status: string }).status,
    "exit_requested"
  );
  assert.equal(
    (getDb().prepare("SELECT COUNT(*) AS count FROM zero_dte_terminal_outcomes WHERE paper_trade_id = 'exit-trade'").get() as { count: number }).count,
    0
  );
});

test("exit reconciliation refuses to overwrite an existing ledger broker identity", async () => {
  seedPaperTrade();
  await reviewZeroDteExits({
    now,
    confirmPaper: true,
    provider: {
      review: async () => review(),
      execute: async () => execution()
    }
  });
  getDb().prepare(
    "UPDATE paper_execution_ledger SET alpaca_order_id = 'different-exit-order' WHERE client_order_id = 'paper-exit-0dte-1'"
  ).run();

  const result = await reconcileZeroDteExitOrders({
    now: "2026-07-13T19:03:00.000Z",
    provider: {
      runtime: paperRuntime,
      getOrder: async () => filledExitOrder()
    }
  });
  assert.equal(result.errors[0]?.message, "EXIT_LEDGER_BROKER_ORDER_ID_MISMATCH");
  const ledger = getDb().prepare(
    "SELECT status, alpaca_order_id FROM paper_execution_ledger WHERE client_order_id = 'paper-exit-0dte-1'"
  ).get() as { status: string; alpaca_order_id: string };
  assert.equal(ledger.status, "accepted");
  assert.equal(ledger.alpaca_order_id, "different-exit-order");
  assert.equal(
    (getDb().prepare("SELECT status FROM zero_dte_paper_trades WHERE paper_trade_id = 'exit-trade'").get() as { status: string }).status,
    "exit_requested"
  );
});

test("exit reconciliation refuses stale broker evidence after the exit request changes", async () => {
  seedPaperTrade();
  await reviewZeroDteExits({
    now,
    confirmPaper: true,
    provider: {
      review: async () => review(),
      execute: async () => execution()
    }
  });

  const result = await reconcileZeroDteExitOrders({
    now: "2026-07-13T19:03:00.000Z",
    provider: {
      runtime: paperRuntime,
      getOrder: async () => {
        const replacementAt = "2026-07-13T19:01:00.000Z";
        getDb().prepare(
          `INSERT INTO zero_dte_lifecycle_events
            (event_id, event_type, reason_code, engine_run_id, candidate_id,
             decision_id, decision_group_id, paper_trade_id, account_mode,
             strategy_version, configuration_version_id, occurred_at,
             details_json, created_at)
           VALUES ('replacement-exit-request', 'exit_order_requested',
             'ODTE_STOP_LOSS_50', 'exit-run', 'exit-candidate',
             'exit-decision', 'exit-group', 'exit-trade', 'paper',
             'zero-dte-level-2-v1', 'exit-config', ?,
             '{"brokerOrderId":"replacement-order","clientOrderId":"replacement-client","requestId":"replacement-request","status":"accepted"}', ?)`
        ).run(replacementAt, replacementAt);
        getDb().prepare(
          "UPDATE zero_dte_paper_trades SET exit_requested_at = ?, updated_at = ? WHERE paper_trade_id = 'exit-trade'"
        ).run(replacementAt, replacementAt);
        return filledExitOrder();
      }
    }
  });
  assert.equal(result.errors[0]?.message, "EXIT_ORDER_REQUEST_CHANGED");
  assert.equal(
    (getDb().prepare("SELECT status FROM zero_dte_paper_trades WHERE paper_trade_id = 'exit-trade'").get() as { status: string }).status,
    "exit_requested"
  );
  assert.equal(
    (getDb().prepare("SELECT COUNT(*) AS count FROM zero_dte_terminal_outcomes WHERE paper_trade_id = 'exit-trade'").get() as { count: number }).count,
    0
  );
});

test("exit reconciliation rejects chronologically impossible fill evidence", async () => {
  for (const [filledAt, expected] of [
    ["2026-07-13T18:59:59.000Z", "EXIT_BROKER_FILL_BEFORE_EXIT_REQUEST"],
    ["2026-07-13T19:04:00.000Z", "EXIT_BROKER_FILL_AFTER_RECONCILIATION"]
  ] as const) {
    seedPaperTrade();
    await reviewZeroDteExits({
      now,
      confirmPaper: true,
      provider: {
        review: async () => review(),
        execute: async () => execution()
      }
    });
    const result = await reconcileZeroDteExitOrders({
      now: "2026-07-13T19:03:00.000Z",
      provider: {
        runtime: paperRuntime,
        clock: () => "2026-07-13T19:03:00.000Z",
        getOrder: async () => filledExitOrder({ filled_at: filledAt })
      }
    });
    assert.equal(result.errors[0]?.message, expected);
    assert.equal(
      (getDb().prepare("SELECT status FROM zero_dte_paper_trades WHERE paper_trade_id = 'exit-trade'").get() as { status: string }).status,
      "exit_requested"
    );
  }
});

test("exit reconciliation rejects a conflicting terminal outcome atomically", async () => {
  seedPaperTrade();
  await reviewZeroDteExits({
    now,
    confirmPaper: true,
    provider: {
      review: async () => review(),
      execute: async () => execution()
    }
  });
  getDb().prepare(
    `INSERT INTO zero_dte_terminal_outcomes
      (outcome_id, candidate_id, paper_trade_id, decision_id, trading_date,
       outcome_type, horizon_minutes, terminal_state, terminal_price,
       realized_pnl, return_pct, holding_minutes, exit_reason_code,
       completeness_status, evaluated_at, evidence_json, created_at)
     VALUES ('conflicting-exit-outcome', 'exit-candidate', 'exit-trade',
       'exit-decision', '2026-07-13', 'paper_trade', NULL, 'closed', 9.99,
       899, 899, 1, 'ODTE_STOP_LOSS_50', 'complete', ?, '{}', ?)`
  ).run(now, now);

  const result = await reconcileZeroDteExitOrders({
    now: "2026-07-13T19:03:00.000Z",
    provider: {
      runtime: paperRuntime,
      getOrder: async () => filledExitOrder()
    }
  });
  assert.equal(result.errors[0]?.message, "EXIT_TERMINAL_OUTCOME_MISMATCH");
  assert.equal(
    (getDb().prepare("SELECT status FROM zero_dte_paper_trades WHERE paper_trade_id = 'exit-trade'").get() as { status: string }).status,
    "exit_requested"
  );
  assert.equal(
    (getDb().prepare("SELECT status FROM paper_execution_ledger WHERE client_order_id = 'paper-exit-0dte-1'").get() as { status: string }).status,
    "accepted"
  );
});

test("exit reconciliation reopens a zero-fill terminal exit without inventing a close", async () => {
  seedPaperTrade();
  await reviewZeroDteExits({
    now,
    confirmPaper: true,
    provider: {
      review: async () => review(),
      execute: async () => execution()
    }
  });

  const result = await reconcileZeroDteExitOrders({
    now: "2026-07-13T19:03:00.000Z",
    provider: {
      runtime: paperRuntime,
      getOrder: async () => filledExitOrder({
        status: "canceled",
        filled_qty: "0",
        filled_avg_price: null,
        filled_at: null
      })
    }
  });
  assert.equal(result.terminal, 1);
  assert.equal(result.filled, 0);
  assert.equal(result.errors.length, 0);
  const trade = getDb().prepare(
    `SELECT status, exit_premium, exited_at, terminal_state
     FROM zero_dte_paper_trades
     WHERE paper_trade_id = 'exit-trade'`
  ).get() as {
    status: string;
    exit_premium: number | null;
    exited_at: string | null;
    terminal_state: string | null;
  };
  assert.equal(trade.status, "open");
  assert.equal(trade.exit_premium, null);
  assert.equal(trade.exited_at, null);
  assert.equal(trade.terminal_state, null);
  assert.equal(
    (getDb().prepare("SELECT status FROM paper_execution_ledger WHERE client_order_id = 'paper-exit-0dte-1'").get() as { status: string }).status,
    "canceled"
  );
  assert.equal(
    (getDb().prepare("SELECT COUNT(*) AS count FROM zero_dte_terminal_outcomes WHERE paper_trade_id = 'exit-trade'").get() as { count: number }).count,
    0
  );
});

test("exit reconciliation never reads a broker order outside the paper-only runtime", async () => {
  seedPaperTrade();
  await reviewZeroDteExits({
    now,
    confirmPaper: true,
    provider: {
      review: async () => review(),
      execute: async () => execution()
    }
  });
  let brokerReads = 0;
  const result = await reconcileZeroDteExitOrders({
    now: "2026-07-13T19:03:00.000Z",
    provider: {
      runtime: { ...paperRuntime, environment: "live", paperOnly: false },
      getOrder: async () => {
        brokerReads += 1;
        return filledExitOrder();
      }
    }
  });
  assert.equal(result.errors[0]?.code, "ACCOUNT_NOT_PAPER");
  assert.equal(brokerReads, 0);
  assert.equal(
    (getDb().prepare("SELECT status FROM zero_dte_paper_trades WHERE paper_trade_id = 'exit-trade'").get() as { status: string }).status,
    "exit_requested"
  );
});

test("exit reconciliation rejects a broker response below prior verified exit fill progress", async () => {
  seedPaperTrade();
  await reviewZeroDteExits({
    now,
    confirmPaper: true,
    provider: {
      review: async () => review(),
      execute: async () => execution()
    }
  });
  getDb().prepare(
    `INSERT INTO zero_dte_lifecycle_events
      (event_id, event_type, reason_code, engine_run_id, candidate_id,
       decision_id, decision_group_id, paper_trade_id, account_mode,
       strategy_version, configuration_version_id, occurred_at,
       details_json, created_at)
     VALUES ('prior-exit-partial', 'paper_order_partially_filled',
       'EXIT_ORDER_PARTIALLY_FILLED', 'exit-run', 'exit-candidate',
       'exit-decision', 'exit-group', 'exit-trade', 'paper',
       'zero-dte-level-2-v1', 'exit-config', ?,
       '{"action":"exit","filledQuantity":1}', ?)`
  ).run(now, now);

  const result = await reconcileZeroDteExitOrders({
    now: "2026-07-13T19:03:00.000Z",
    provider: {
      runtime: paperRuntime,
      getOrder: async () => filledExitOrder({
        status: "canceled",
        filled_qty: "0",
        filled_avg_price: null,
        filled_at: null
      })
    }
  });
  assert.equal(result.errors[0]?.code, "EXIT_ORDER_RECONCILIATION_FAILED");
  assert.equal(result.errors[0]?.message, "EXIT_BROKER_FILL_QUANTITY_REGRESSION");
  assert.equal(
    (getDb().prepare("SELECT status FROM zero_dte_paper_trades WHERE paper_trade_id = 'exit-trade'").get() as { status: string }).status,
    "exit_requested"
  );
});
