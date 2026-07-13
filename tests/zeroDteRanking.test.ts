import assert from "node:assert/strict";
import { test } from "node:test";

import {
  rankZeroDteQueue,
  selectZeroDteQueue,
  type ZeroDteQueueCandidate
} from "../src/services/zeroDte/zeroDteRankingService.js";

const candidate = (
  candidateId: string,
  overrides: Partial<ZeroDteQueueCandidate> = {}
): ZeroDteQueueCandidate => ({
  candidateId,
  eligible: false,
  totalScore: 0,
  shortSlope: null,
  liquidityScore: 0,
  freshnessScore: 0,
  spreadPct: 10,
  componentScores: { signal: 0, liquidity: 0 },
  blockers: ["BLOCKED"],
  rank: 99,
  ...overrides
});

test("ranking applies eligibility, score, slope, liquidity, freshness, spread, then ID", () => {
  const candidates = [
    candidate("zdt_ineligible-high", { eligible: false, totalScore: 999 }),
    candidate("zdt_score-high", { eligible: true, totalScore: 90 }),
    candidate("zdt_score-low", { eligible: true, totalScore: 80 }),
    candidate("zdt_slope-high", { eligible: true, totalScore: 50, shortSlope: 2 }),
    candidate("zdt_slope-low", { eligible: true, totalScore: 50, shortSlope: 1 }),
    candidate("zdt_liquidity-high", {
      eligible: true,
      totalScore: 50,
      shortSlope: 0,
      liquidityScore: 2
    }),
    candidate("zdt_liquidity-low", {
      eligible: true,
      totalScore: 50,
      shortSlope: 0,
      liquidityScore: 1
    }),
    candidate("zdt_freshness-high", {
      eligible: true,
      totalScore: 50,
      shortSlope: 0,
      liquidityScore: 0,
      freshnessScore: 2
    }),
    candidate("zdt_freshness-low", {
      eligible: true,
      totalScore: 50,
      shortSlope: 0,
      liquidityScore: 0,
      freshnessScore: 1
    }),
    candidate("zdt_spread-tight", {
      eligible: true,
      totalScore: 50,
      shortSlope: 0,
      liquidityScore: 0,
      freshnessScore: 0,
      spreadPct: 1
    }),
    candidate("zdt_spread-wide", {
      eligible: true,
      totalScore: 50,
      shortSlope: 0,
      liquidityScore: 0,
      freshnessScore: 0,
      spreadPct: 2
    }),
    candidate("zdt_b", {
      eligible: true,
      totalScore: 50,
      shortSlope: 0,
      liquidityScore: 0,
      freshnessScore: 0,
      spreadPct: 3
    }),
    candidate("zdt_a", {
      eligible: true,
      totalScore: 50,
      shortSlope: 0,
      liquidityScore: 0,
      freshnessScore: 0,
      spreadPct: 3
    })
  ];
  const ranked = rankZeroDteQueue(candidates);

  assert.deepEqual(ranked.map((entry) => entry.candidateId), [
    "zdt_score-high",
    "zdt_score-low",
    "zdt_slope-high",
    "zdt_slope-low",
    "zdt_liquidity-high",
    "zdt_liquidity-low",
    "zdt_freshness-high",
    "zdt_freshness-low",
    "zdt_spread-tight",
    "zdt_spread-wide",
    "zdt_a",
    "zdt_b",
    "zdt_ineligible-high"
  ]);
  assert.deepEqual(ranked.map((entry) => entry.rank), [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13
  ]);
  assert.deepEqual(ranked.at(-1)?.blockers, ["BLOCKED"]);
  assert.deepEqual(ranked.at(-1)?.componentScores, { signal: 0, liquidity: 0 });
});

test("queue and execution top-N selections remain separate slices", () => {
  const ranked = rankZeroDteQueue([
    candidate("zdt_ineligible-high", { eligible: false, totalScore: 100 }),
    candidate("zdt_eligible-one", { eligible: true, totalScore: 90 }),
    candidate("zdt_eligible-two", { eligible: true, totalScore: 80 }),
    candidate("zdt_eligible-three", { eligible: true, totalScore: 70 })
  ]);
  const slices = selectZeroDteQueue(ranked, {
    queueTopN: 2,
    executionTopN: 1
  });

  assert.deepEqual(slices.queue.map((entry) => entry.candidateId), [
    "zdt_eligible-one",
    "zdt_eligible-two"
  ]);
  assert.deepEqual(slices.execution.map((entry) => entry.candidateId), [
    "zdt_eligible-one"
  ]);
  assert.ok(slices.execution.every((entry) => entry.eligible));
  assert.notEqual(slices.queue, slices.execution);
});
