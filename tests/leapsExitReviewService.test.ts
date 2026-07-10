import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.LEAPS_MIN_DTE_AT_ENTRY = "270";
process.env.LEAPS_DTE_EXIT_THRESHOLD = "180";
process.env.LEAPS_REVIEW_LOSS_PCT = "-20";
process.env.LEAPS_HARD_STOP_LOSS_PCT = "-35";
process.env.LEAPS_PARTIAL_PROFIT_TAKE_PCT = "75";
process.env.LEAPS_FULL_PROFIT_TAKE_PCT = "125";
process.env.LEAPS_TREND_REVIEW_SMA = "100";
process.env.LEAPS_SEVERE_TREND_EXIT_SMA = "200";
process.env.LEAPS_MAX_BID_ASK_SPREAD_PCT = "20";
process.env.LEAPS_MIN_DELTA_REVIEW = "0.45";
process.env.LEAPS_REVIEW_INTERVAL_DAYS = "30";

import {
  classifyLeapsOptionPosition,
  evaluateLeapsExit,
  type LeapsExitReviewDeps
} from "../src/services/leapsExitReviewService.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const asOf = "2026-07-08T14:00:00.000Z";
const contractSymbol = "SPY270115C00600000";

type TestMetadata = {
  underlyingSymbol: string;
  contractSymbol: string;
  expirationDate: string;
  type: "call" | "put" | "unknown";
  multiplier: number;
};

type TestSnapshot = {
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  last: number | null;
  delta: number | null;
  timestamp: string;
  quote_timestamp: string | null;
};

const metadata = (overrides: Partial<TestMetadata> = {}): TestMetadata => ({
  underlyingSymbol: "SPY",
  contractSymbol,
  expirationDate: "2027-01-15",
  type: "call" as const,
  multiplier: 100,
  ...overrides
});

const snapshot = (overrides: Partial<TestSnapshot> = {}): TestSnapshot => ({
  bid: 8,
  ask: 8.8,
  midpoint: 8.4,
  last: 8.5,
  delta: 0.61,
  timestamp: asOf,
  quote_timestamp: asOf,
  ...overrides
});

const position = (overrides: Record<string, string> = {}) => ({
  symbol: contractSymbol,
  assetClass: "us_option",
  qty: "1",
  marketValue: "840",
  costBasis: "800",
  unrealizedPl: "40",
  unrealizedPlpc: "0.05",
  currentPrice: "8.4",
  ...overrides
});

const baseDeps = (overrides: LeapsExitReviewDeps = {}): LeapsExitReviewDeps => ({
  now: () => asOf,
  optionMetadataForSymbol: () => metadata(),
  entryRecordForSymbol: () => ({ createdAt: "2025-07-24T14:00:00.000Z", entryDte: 540, source: "learning" }),
  latestOptionSnapshotForSymbol: () => snapshot(),
  closesForSymbol: () => Array(200).fill(500),
  lastReviewAtForSymbol: () => "2026-07-01T14:00:00.000Z",
  ...overrides
});

describe("LEAPS exit review service", () => {
  test("classifies option with entry DTE >= 270 as LEAPS", () => {
    const result = classifyLeapsOptionPosition({ contractSymbol }, baseDeps());
    assert.equal(result.classification, "LEAPS");
    assert.equal(result.entryDte, 540);
    assert.equal(result.inferred, false);
  });

  test("does not classify option with entry DTE < 270 as LEAPS", () => {
    const result = classifyLeapsOptionPosition(
      { contractSymbol },
      baseDeps({
        entryRecordForSymbol: () => ({ createdAt: "2026-03-10T14:00:00.000Z", entryDte: 120, source: "learning" })
      })
    );
    assert.equal(result.classification, "NOT_LEAPS");
  });

  test("uses current DTE fallback only when entry DTE is missing and marks inferred", () => {
    const result = classifyLeapsOptionPosition(
      { contractSymbol },
      baseDeps({
        optionMetadataForSymbol: () => metadata({ expirationDate: "2027-07-08" }),
        entryRecordForSymbol: () => null
      })
    );
    assert.equal(result.classification, "LEAPS");
    assert.equal(result.inferred, true);

    const evaluation = evaluateLeapsExit(
      position(),
      baseDeps({
        optionMetadataForSymbol: () => metadata({ expirationDate: "2027-07-08" }),
        entryRecordForSymbol: () => null
      })
    );
    assert.equal(evaluation?.reasons.includes("LEAPS_CLASSIFICATION_INFERRED"), true);
  });

  test("-35% contract P/L creates hard sell-to-close review", () => {
    const evaluation = evaluateLeapsExit(position({ unrealizedPlpc: "-0.35" }), baseDeps());
    assert.equal(evaluation?.hardExit, true);
    assert.equal(evaluation?.executable, true);
    assert.equal(evaluation?.section, "optionSellToCloseExits");
    assert.equal(evaluation?.reasons.includes("LEAPS_HARD_STOP_LOSS"), true);
  });

  test("+125% contract P/L creates hard sell-to-close review", () => {
    const evaluation = evaluateLeapsExit(position({ unrealizedPlpc: "1.25" }), baseDeps());
    assert.equal(evaluation?.hardExit, true);
    assert.equal(evaluation?.executable, true);
    assert.equal(evaluation?.reasons.includes("LEAPS_FULL_PROFIT_TAKE"), true);
  });

  test("current DTE <= 180 creates hard sell-to-close review", () => {
    const evaluation = evaluateLeapsExit(
      position(),
      baseDeps({
        optionMetadataForSymbol: () => metadata({ expirationDate: "2027-01-01" })
      })
    );
    assert.equal(evaluation?.currentDte, 177);
    assert.equal(evaluation?.hardExit, true);
    assert.equal(evaluation?.reasons.includes("LEAPS_DTE_EXIT_WINDOW"), true);
  });

  test("bullish call below 200-day SMA creates hard sell-to-close review", () => {
    const evaluation = evaluateLeapsExit(
      position(),
      baseDeps({
        closesForSymbol: () => [...Array(199).fill(500), 400]
      })
    );
    assert.equal(evaluation?.hardExit, true);
    assert.equal(evaluation?.reasons.includes("LEAPS_SEVERE_TREND_BREAK"), true);
  });

  test("-20% contract P/L creates review warning only", () => {
    const evaluation = evaluateLeapsExit(position({ unrealizedPlpc: "-0.2" }), baseDeps());
    assert.equal(evaluation?.hardExit, false);
    assert.equal(evaluation?.reviewOnly, true);
    assert.equal(evaluation?.executable, false);
    assert.equal(evaluation?.reasons.includes("LEAPS_REVIEW_LOSS_WARNING"), true);
  });

  test("+75% contract P/L creates review warning with partial candidate when contracts are available", () => {
    const evaluation = evaluateLeapsExit(position({ qty: "3", unrealizedPlpc: "0.75" }), baseDeps());
    assert.equal(evaluation?.hardExit, false);
    assert.equal(evaluation?.reviewOnly, true);
    assert.equal(evaluation?.executable, false);
    assert.equal(evaluation?.partialExitCandidate?.supported, true);
    assert.equal(evaluation?.partialExitCandidate?.quantity, 1);
    assert.equal(evaluation?.reasons.includes("LEAPS_PARTIAL_PROFIT_REVIEW"), true);
  });

  test("underlying below 100-day SMA creates review warning only", () => {
    const evaluation = evaluateLeapsExit(
      position(),
      baseDeps({
        closesForSymbol: () => [...Array(100).fill(400), ...Array(99).fill(500), 450]
      })
    );
    assert.equal(evaluation?.hardExit, false);
    assert.equal(evaluation?.reviewOnly, true);
    assert.equal(evaluation?.reasons.includes("LEAPS_TREND_REVIEW"), true);
  });

  test("delta below 0.45 creates review warning only", () => {
    const evaluation = evaluateLeapsExit(
      position(),
      baseDeps({
        latestOptionSnapshotForSymbol: () => snapshot({ delta: 0.4 })
      })
    );
    assert.equal(evaluation?.hardExit, false);
    assert.equal(evaluation?.reviewOnly, true);
    assert.equal(evaluation?.reasons.includes("LEAPS_DELTA_DETERIORATION"), true);
  });

  test("periodic 30-day review creates review warning only", () => {
    const evaluation = evaluateLeapsExit(
      position(),
      baseDeps({
        lastReviewAtForSymbol: () => "2026-06-01T14:00:00.000Z"
      })
    );
    assert.equal(evaluation?.hardExit, false);
    assert.equal(evaluation?.reviewOnly, true);
    assert.equal(evaluation?.reasons.includes("LEAPS_PERIODIC_REVIEW_DUE"), true);
  });

  test("spread above 20% blocks marketable execution", () => {
    const evaluation = evaluateLeapsExit(
      position({ unrealizedPlpc: "1.3" }),
      baseDeps({
        latestOptionSnapshotForSymbol: () => snapshot({ bid: 5, ask: 7, midpoint: 6 })
      })
    );
    assert.equal(evaluation?.hardExit, true);
    assert.equal(evaluation?.executable, false);
    assert.equal(evaluation?.reasons.includes("LIMIT_EXIT_REQUIRED"), true);
  });

  test("missing bid/ask blocks marketable execution", () => {
    const evaluation = evaluateLeapsExit(
      position({ unrealizedPlpc: "1.3" }),
      baseDeps({
        latestOptionSnapshotForSymbol: () => snapshot({ bid: null, ask: null, midpoint: null })
      })
    );
    assert.equal(evaluation?.hardExit, true);
    assert.equal(evaluation?.executable, false);
    assert.equal(evaluation?.reasons.includes("LEAPS_QUOTE_UNAVAILABLE"), true);
  });

  test("acceptable spread allows reviewed hard exit to become executable", () => {
    const evaluation = evaluateLeapsExit(position({ unrealizedPlpc: "1.3" }), baseDeps());
    assert.equal(evaluation?.hardExit, true);
    assert.equal(evaluation?.executable, true);
    assert.equal(evaluation?.limitPrice, 8.4);
    assert.equal(evaluation?.bidAskSpreadPct, 9.52);
  });

  test("service does not reference order submission or enabled execution commands", () => {
    const source = readFileSync(join(__dirname, "../src/services/leapsExitReviewService.ts"), "utf8");
    assert.doesNotMatch(source, /submitPaperOrder|paper:execute|ALPACA_LIVE|LIVE_TRADING/);
  });
});
