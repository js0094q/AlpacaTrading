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

import { closeDbForTests, getDb } from "../src/lib/db.js";
import { createPaperReviewArtifact } from "../src/services/paperReviewArtifactService.js";
import { buildPaperReviewedPayloadExecutionReport } from "../src/services/paperReviewedPayloadExecutionService.js";

const resetDatabase = () => {
  resetSqliteTestDb(getDb(), `
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
  resetDatabase();
});

after(() => {
  closeDbForTests();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("reviewed payload execution", () => {
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
});
