import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSqliteTestDb } from "./helpers/sqliteTestDb.js";

const dbDir = mkdtempSync(join(tmpdir(), "alpaca-reviewed-exec-"));
process.env.RESEARCH_DB_PATH = join(dbDir, "research.db");
process.env.ALPACA_ENV = "paper";
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
process.env.AUTOMATED_PAPER_EXECUTION_ENABLED = "true";

import { closeDbForTests, getDb } from "../src/lib/db.js";
import { createPaperReviewArtifact } from "../src/services/paperReviewArtifactService.js";
import { buildPaperReviewedPayloadExecutionReport } from "../src/services/paperReviewedPayloadExecutionService.js";

const resetDatabase = () => {
  resetSqliteTestDb(getDb(), `
    DELETE FROM paper_position_outcome_revisions;
    DELETE FROM paper_position_outcomes;
    DELETE FROM paper_position_observation_links;
    DELETE FROM paper_position_observations;
    DELETE FROM paper_positions;
    DELETE FROM paper_review_decisions;
    DELETE FROM decision_lifecycle_events;
    DELETE FROM decision_snapshots;
    DELETE FROM paper_review_artifacts;
    DELETE FROM paper_execution_ledger;
  `);
};

beforeEach(() => {
  process.env.ALPACA_ENV = "paper";
  process.env.TRADING_MODE = "paper";
  process.env.ALPACA_LIVE_TRADE = "false";
  process.env.LIVE_TRADING_ENABLED = "false";
  process.env.PAPER_ORDER_EXECUTION_ENABLED = "true";
  process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "true";
  process.env.AUTOMATED_PAPER_EXECUTION_ENABLED = "true";
  resetDatabase();
});

after(() => {
  closeDbForTests();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("reviewed payload execution", () => {
  const createLeapsExitArtifact = () =>
    createPaperReviewArtifact({
      id: "review-leaps-exit",
      sourceAction: "paper.ops.review",
      status: "success",
      createdAt: "2026-07-08T14:00:00.000Z",
      maxAgeMinutes: 60,
      payloadSections: {
        equityBuys: [],
        equityAdds: [],
        equitySells: [],
        optionBuys: [],
        optionSellToCloseExits: [
          {
            assetClass: "option",
            symbol: "SPY270115C00600000",
            side: "sell",
            type: "limit",
            time_in_force: "day",
            qty: "1",
            limit_price: "8.40",
            position_intent: "sell_to_close",
            client_order_id: "leaps-exit-spy",
            dedupeKey: "leaps-exit-spy",
            reason: "LEAPS_DTE_EXIT_WINDOW",
            reasonCodes: ["LEAPS_DTE_EXIT_WINDOW"],
            leapsExitEvaluation: {
              classification: "LEAPS",
              hardExit: true,
              executable: true
            }
          }
        ]
      },
      summary: {}
    });

  test("executes only requested reviewed payload sections", async () => {
    createPaperReviewArtifact({
      id: "review-filter-test",
      sourceAction: "paper.ops.review",
      status: "success",
      createdAt: "2026-07-08T14:00:00.000Z",
      maxAgeMinutes: 60,
      payloadSections: {
        equityBuys: [
          {
            assetClass: "equity",
            symbol: "AAPL",
            side: "buy",
            type: "market",
            time_in_force: "day",
            notional: "100.00",
            client_order_id: "entry-aapl",
            dedupeKey: "entry-aapl"
          }
        ],
        equityAdds: [],
        equitySells: [
          {
            assetClass: "equity",
            symbol: "MSFT",
            side: "sell",
            type: "market",
            time_in_force: "day",
            qty: "1",
            client_order_id: "exit-msft",
            dedupeKey: "exit-msft"
          }
        ],
        optionBuys: [],
        optionSellToCloseExits: []
      },
      summary: {}
    });

    const submittedSymbols: string[] = [];
    const report = await buildPaperReviewedPayloadExecutionReport(
      {
        confirmPaper: true,
        sections: ["equitySells"]
      },
      {
        now: () => "2026-07-08T14:05:00.000Z",
        getAccount: async () => ({
          data: { status: "ACTIVE" },
          status: 200,
          url: "https://paper-api.alpaca.markets/v2/account"
        }),
        submitPaperOrder: async (payload) => {
          submittedSymbols.push(payload.symbol);
          return {
            data: {
              id: `order-${payload.symbol}`,
              symbol: payload.symbol,
              status: "accepted"
            },
            status: 200,
            url: "https://paper-api.alpaca.markets/v2/orders"
          };
        }
      }
    );

    assert.equal(report.status, "submitted");
    assert.equal(report.summary.reviewedPayloads, 1);
    assert.deepEqual(submittedSymbols, ["MSFT"]);
    assert.equal(report.submitted[0]?.section, "equitySells");
  });

  test("creates an analytical lifecycle from an immediate exact entry fill", async () => {
    createPaperReviewArtifact({
      id: "review-filled-entry",
      sourceAction: "paper.ops.review",
      status: "success",
      createdAt: "2026-07-08T14:00:00.000Z",
      maxAgeMinutes: 60,
      payloadSections: {
        equityBuys: [
          {
            assetClass: "equity",
            symbol: "AAPL",
            side: "buy",
            type: "market",
            time_in_force: "day",
            qty: "2",
            client_order_id: "filled-entry-aapl",
            dedupeKey: "filled-entry-aapl"
          }
        ],
        equityAdds: [],
        equitySells: [],
        optionBuys: [],
        optionSellToCloseExits: []
      },
      summary: {}
    });

    const report = await buildPaperReviewedPayloadExecutionReport(
      { confirmPaper: true, sections: ["equityBuys"] },
      {
        now: () => "2026-07-08T14:05:00.000Z",
        getAccount: async () => ({
          data: { status: "ACTIVE" },
          status: 200,
          url: "https://paper-api.alpaca.markets/v2/account"
        }),
        submitPaperOrder: async () => ({
          data: {
            id: "broker-filled-entry",
            status: "filled",
            filled_qty: "2",
            filled_avg_price: "201.25",
            filled_at: "2026-07-08T14:05:01.000Z"
          },
          requestId: "fill-request-1",
          status: 200,
          url: "https://paper-api.alpaca.markets/v2/orders"
        })
      }
    );

    assert.equal(report.status, "submitted");
    const lifecycle = getDb().prepare(`
      SELECT p.entry_decision_id, p.entry_quantity, p.entry_price,
             l.position_lifecycle_id, p.linkage_status
      FROM paper_positions p
      JOIN paper_execution_ledger l
        ON l.position_lifecycle_id = p.position_lifecycle_id
      WHERE p.entry_client_order_id = 'filled-entry-aapl'
    `).get() as Record<string, unknown>;
    assert.equal(lifecycle.entry_quantity, 2);
    assert.equal(lifecycle.entry_price, 201.25);
    assert.equal(lifecycle.linkage_status, "EXACT");
    assert.equal(lifecycle.position_lifecycle_id !== null, true);
    assert.equal(lifecycle.entry_decision_id !== null, true);
  });

  test("live trading enabled blocks reviewed LEAPS execution", async () => {
    createLeapsExitArtifact();
    process.env.LIVE_TRADING_ENABLED = "true";

    const report = await buildPaperReviewedPayloadExecutionReport({
      confirmPaper: true,
      sections: ["optionSellToCloseExits"]
    }, {
      now: () => "2026-07-08T14:05:00.000Z"
    });

    assert.equal(report.status, "blocked");
    assert.equal(report.reason, "LIVE_TRADING_DISABLED_REQUIRED");
  });

  test("non-paper runtime blocks reviewed LEAPS execution", async () => {
    createLeapsExitArtifact();
    process.env.ALPACA_ENV = "live";

    const report = await buildPaperReviewedPayloadExecutionReport({
      confirmPaper: true,
      sections: ["optionSellToCloseExits"]
    }, {
      now: () => "2026-07-08T14:05:00.000Z"
    });

    assert.equal(report.status, "blocked");
    assert.equal(report.reason, "PAPER_RUNTIME_REQUIRED");
  });

  test("missing --confirmPaper blocks reviewed LEAPS execution", async () => {
    createLeapsExitArtifact();

    const report = await buildPaperReviewedPayloadExecutionReport({
      sections: ["optionSellToCloseExits"]
    });

    assert.equal(report.status, "blocked");
    assert.equal(report.reason, "PAPER_CONFIRMATION_REQUIRED");
  });

  test("missing paper options flag blocks reviewed LEAPS execution", async () => {
    createLeapsExitArtifact();
    process.env.PAPER_OPTIONS_EXECUTION_ENABLED = "false";

    const report = await buildPaperReviewedPayloadExecutionReport({
      confirmPaper: true,
      sections: ["optionSellToCloseExits"]
    }, {
      now: () => "2026-07-08T14:05:00.000Z"
    });

    assert.equal(report.status, "blocked");
    assert.equal(report.reason, "PAPER_OPTIONS_EXECUTION_FLAG_REQUIRED");
  });

  test("missing automated paper execution flag blocks reviewed LEAPS execution", async () => {
    createLeapsExitArtifact();
    process.env.AUTOMATED_PAPER_EXECUTION_ENABLED = "false";

    const report = await buildPaperReviewedPayloadExecutionReport({
      confirmPaper: true,
      sections: ["optionSellToCloseExits"]
    }, {
      now: () => "2026-07-08T14:05:00.000Z"
    });

    assert.equal(report.status, "blocked");
    assert.equal(report.reason, "AUTOMATED_PAPER_EXECUTION_FLAG_REQUIRED");
  });
});
