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
process.env.PAPER_REVIEW_SIGNING_KEY = "paper-reviewed-execution-test-key";

import { closeDbForTests, getDb } from "../src/lib/db.js";
import { createPaperReviewArtifact } from "../src/services/paperReviewArtifactService.js";
import { insertPaperExecutionLedgerEntry } from "../src/services/paperExecutionLedgerService.js";
import { buildPaperReviewedPayloadExecutionReport } from "../src/services/paperReviewedPayloadExecutionService.js";
import type { PaperSubmitStateAttestation } from "../src/services/paperSubmitStateService.js";

const entrySubmitState = (
  overrides: Partial<PaperSubmitStateAttestation> = {}
): PaperSubmitStateAttestation => ({
  version: "paper-submit-state-v1",
  capturedAt: "2026-07-08T14:00:00.000Z",
  accountIdentityHash: "paper-account-hash",
  accountState: {
    status: "ACTIVE",
    cash: 100_000,
    equity: 100_000,
    buyingPower: 100_000,
    optionsBuyingPower: 100_000,
    optionsApprovalLevel: 3,
    tradingBlocked: false,
    accountBlocked: false
  },
  configuration: {
    environment: "paper",
    tradingMode: "paper",
    liveTradingEnabled: false,
    paperOrderExecutionEnabled: true,
    paperOptionsExecutionEnabled: true,
    maxPositionNotional: 5_000,
    maxTotalPlanNotional: 50_000,
    equityMaxNotionalPerOrder: 5_000,
    equityMaxPortfolioDeployPct: 50,
    equityMaxPositionPct: 10,
    equityMinCashReservePct: 20,
    optionMaxOrderNotional: 2_000,
    optionMaxContracts: 1,
    optionMaxPortfolioRiskPct: 20,
    optionMaxPositionRiskPct: 5,
    quoteMaxAgeSeconds: 600,
    maxPriceDriftPct: 10
  },
  configurationFingerprint: "config-v1",
  positions: [],
  openOrders: [],
  reservations: [],
  marketEvidence: [
    {
      symbol: "AAPL",
      assetClass: "equity",
      referencePrice: 200,
      bid: 199.9,
      ask: 200.1,
      timestamp: "2026-07-08T14:00:00.000Z",
      complete: true
    }
  ],
  payloadIntents: [
    {
      section: "equityBuys",
      payloadIndex: 0,
      assetClass: "equity",
      symbol: "AAPL",
      side: "buy",
      orderType: "market",
      quantity: 2,
      notional: null,
      limitPrice: null,
      estimatedPremium: null,
      positionIntent: null,
      sourceCandidateId: "candidate-aapl",
      sourceReviewId: null,
      clientOrderIdHash: "filled-entry-client-hash"
    }
  ],
  structuralPortfolioFingerprint: "structure-v1",
  portfolioFingerprint: "portfolio-v1",
  marketEvidenceFingerprint: "market-v1",
  allocationAttestation: {
    mode: "baseline",
    identity: "baseline-v1",
    allocatorControlled: false
  },
  complete: true,
  blockers: [],
  warnings: [],
  ...overrides
});

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
  process.env.PAPER_REVIEW_SIGNING_KEY = "paper-reviewed-execution-test-key";
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
    const reviewedState = entrySubmitState();
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
            sourceCandidateId: "candidate-aapl",
            dedupeKey: "filled-entry-aapl"
          }
        ],
        equityAdds: [],
        equitySells: [],
        optionBuys: [],
        optionSellToCloseExits: []
      },
      submitState: reviewedState,
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
        captureSubmitState: async () =>
          entrySubmitState({
            capturedAt: "2026-07-08T14:05:00.000Z",
            marketEvidence: [
              {
                ...reviewedState.marketEvidence[0]!,
                timestamp: "2026-07-08T14:05:00.000Z"
              }
            ]
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
    const reservation = getDb().prepare(`
      SELECT source_plan_id, source_candidate_id, decision_id,
             decision_linkage_status, payload_json
      FROM paper_execution_ledger
      WHERE client_order_id = 'filled-entry-aapl'
    `).get() as Record<string, unknown>;
    assert.equal(reservation.source_plan_id, "review-filled-entry");
    assert.equal(reservation.source_candidate_id, "candidate-aapl");
    assert.equal(reservation.decision_linkage_status, "EXACT");
    assert.equal(reservation.decision_id !== null, true);
    assert.match(String(reservation.payload_json), /submitValidation/);
  });

  test("rejects a tampered signed artifact before any broker call", async () => {
    const artifact = createPaperReviewArtifact({
      id: "review-tampered-entry",
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
            client_order_id: "tampered-entry-aapl",
            sourceCandidateId: "candidate-aapl",
            dedupeKey: "tampered-entry-aapl"
          }
        ],
        equityAdds: [],
        equitySells: [],
        optionBuys: [],
        optionSellToCloseExits: []
      },
      submitState: entrySubmitState(),
      summary: {}
    });
    const tampered = structuredClone(artifact);
    (tampered.artifact.payloadSections.equityBuys[0] as Record<string, unknown>).symbol = "TSLA";
    let brokerCalls = 0;

    const report = await buildPaperReviewedPayloadExecutionReport(
      { confirmPaper: true },
      {
        now: () => "2026-07-08T14:05:00.000Z",
        latestArtifact: () => tampered,
        submitPaperOrder: async () => {
          brokerCalls += 1;
          throw new Error("unexpected broker call");
        }
      }
    );

    assert.equal(report.status, "blocked");
    assert.equal(brokerCalls, 0);
    assert.ok(
      ["REVIEW_ARTIFACT_PAYLOAD_CHANGED", "REVIEW_ARTIFACT_SIGNATURE_INVALID"].includes(
        String(report.reason)
      )
    );
  });

  test("blocks a drifted entry and requests a fresh review without submitting", async () => {
    createPaperReviewArtifact({
      id: "review-drift-entry",
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
            client_order_id: "drift-entry-aapl",
            sourceCandidateId: "candidate-aapl",
            dedupeKey: "drift-entry-aapl"
          }
        ],
        equityAdds: [],
        equitySells: [],
        optionBuys: [],
        optionSellToCloseExits: []
      },
      submitState: entrySubmitState(),
      summary: {}
    });
    let brokerCalls = 0;

    const report = await buildPaperReviewedPayloadExecutionReport(
      { confirmPaper: true, sections: ["equityBuys"] },
      {
        now: () => "2026-07-08T14:05:00.000Z",
        captureSubmitState: async () =>
          entrySubmitState({
            capturedAt: "2026-07-08T14:05:00.000Z",
            structuralPortfolioFingerprint: "structure-drifted"
          }),
        submitPaperOrder: async () => {
          brokerCalls += 1;
          throw new Error("unexpected broker call");
        }
      }
    );

    assert.equal(report.status, "blocked");
    assert.equal(brokerCalls, 0);
    assert.ok(report.blocked.some((row) => row.reason === "FRESH_REVIEW_REQUIRED"));
    assert.match(
      report.blocked.find((row) => row.reason === "FRESH_REVIEW_REQUIRED")?.explanation ?? "",
      /SUBMIT_PORTFOLIO_STATE_DRIFT/
    );
  });

  test("blocks a reviewed entry without exact source candidate identity", async () => {
    createPaperReviewArtifact({
      id: "review-missing-source-entry",
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
            client_order_id: "missing-source-aapl",
            dedupeKey: "missing-source-aapl"
          }
        ],
        equityAdds: [],
        equitySells: [],
        optionBuys: [],
        optionSellToCloseExits: []
      },
      submitState: entrySubmitState(),
      summary: {}
    });
    let brokerCalls = 0;

    const report = await buildPaperReviewedPayloadExecutionReport(
      { confirmPaper: true },
      {
        now: () => "2026-07-08T14:05:00.000Z",
        submitPaperOrder: async () => {
          brokerCalls += 1;
          throw new Error("unexpected broker call");
        }
      }
    );

    assert.equal(report.status, "blocked");
    assert.equal(report.reason, "REVIEW_ENTRY_SOURCE_IDENTITY_MISSING");
    assert.equal(brokerCalls, 0);
  });

  test("atomically blocks a reservation collision that appears after state capture", async () => {
    const reviewedState = entrySubmitState();
    createPaperReviewArtifact({
      id: "review-reservation-race",
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
            client_order_id: "reservation-race-aapl",
            sourceCandidateId: "candidate-aapl",
            dedupeKey: "reservation-race-aapl"
          }
        ],
        equityAdds: [],
        equitySells: [],
        optionBuys: [],
        optionSellToCloseExits: []
      },
      submitState: reviewedState,
      summary: {}
    });
    insertPaperExecutionLedgerEntry({
      mode: "concurrentPaperReservation",
      assetClass: "equity",
      symbol: "AAPL",
      side: "buy",
      orderType: "market",
      timeInForce: "day",
      qty: "2",
      dedupeKey: "reservation-race-aapl",
      clientOrderId: "reservation-race-aapl",
      status: "reserved",
      sourcePlanId: "concurrent-review",
      sourceCandidateId: "candidate-aapl",
      payload: {}
    });
    let brokerCalls = 0;

    const report = await buildPaperReviewedPayloadExecutionReport(
      { confirmPaper: true },
      {
        now: () => "2026-07-08T14:05:00.000Z",
        captureSubmitState: async () =>
          entrySubmitState({ capturedAt: "2026-07-08T14:05:00.000Z" }),
        getAccount: async () => ({
          data: { status: "ACTIVE" },
          status: 200,
          url: "account"
        }),
        submitPaperOrder: async () => {
          brokerCalls += 1;
          throw new Error("unexpected broker call");
        }
      }
    );

    assert.equal(report.status, "blocked");
    assert.equal(brokerCalls, 0);
    assert.ok(
      report.blocked.some(
        (row) => row.reason === "SUBMIT_DUPLICATE_ORDER_OR_RESERVATION"
      )
    );
  });

  test("keeps a reviewed exit executable when fresh-state validation blocks an entry", async () => {
    createPaperReviewArtifact({
      id: "review-mixed-entry-exit",
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
            client_order_id: "mixed-entry-aapl",
            sourceCandidateId: "candidate-aapl",
            dedupeKey: "mixed-entry-aapl"
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
            client_order_id: "mixed-exit-msft",
            dedupeKey: "mixed-exit-msft"
          }
        ],
        optionBuys: [],
        optionSellToCloseExits: []
      },
      submitState: entrySubmitState(),
      summary: {}
    });
    const submittedSymbols: string[] = [];

    const report = await buildPaperReviewedPayloadExecutionReport(
      { confirmPaper: true },
      {
        now: () => "2026-07-08T14:05:00.000Z",
        captureSubmitState: async () =>
          entrySubmitState({
            capturedAt: "2026-07-08T14:05:00.000Z",
            complete: false,
            blockers: ["SUBMIT_CAP_EVIDENCE_INCOMPLETE"]
          }),
        getAccount: async () => ({
          data: { status: "ACTIVE" },
          status: 200,
          url: "account"
        }),
        submitPaperOrder: async (payload) => {
          submittedSymbols.push(payload.symbol);
          return {
            data: { id: `order-${payload.symbol}`, status: "accepted" },
            status: 200,
            url: "orders"
          };
        }
      }
    );

    assert.equal(report.status, "partial");
    assert.deepEqual(submittedSymbols, ["MSFT"]);
    assert.ok(report.blocked.some((row) => row.reason === "FRESH_REVIEW_REQUIRED"));
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
