import assert from "node:assert/strict";
import { test } from "node:test";

import { loadZeroDteConfig } from "../src/services/zeroDte/zeroDteConfigService.js";
import { summarizeZeroDteSignal } from "../src/services/zeroDte/zeroDteSignalService.js";

const config = loadZeroDteConfig({});
const minimumMovement = config.minScoreMovement;

const observedAt = (offsetMinutes: number) =>
  `2026-07-13T13:${String(offsetMinutes).padStart(2, "0")}:00.000Z`;

test("strengthening requires meaningful movement and the configured confirmation count", () => {
  const unconfirmed = summarizeZeroDteSignal({
    scores: [
      { observedAt: observedAt(0), score: 100 },
      { observedAt: observedAt(1), score: 106 }
    ],
    previousState: "watching",
    minimumMovement,
    minimumConfirmationObservations: 3
  });
  const confirmed = summarizeZeroDteSignal({
    scores: [
      { observedAt: observedAt(0), score: 100 },
      { observedAt: observedAt(1), score: 106 },
      { observedAt: observedAt(2), score: 112 }
    ],
    previousState: "watching",
    minimumMovement,
    minimumConfirmationObservations: config.minConfirmationObservations
  });

  assert.equal(unconfirmed.state, "watching");
  assert.equal(confirmed.state, "strengthening");
  assert.equal(confirmed.scoreChange, 6);
  assert.equal(confirmed.shortSlope, 6);
  assert.equal(confirmed.mediumSlope, null);
  assert.equal(confirmed.strengtheningDurationMs, 120_000);
  assert.equal(confirmed.setupAgeMs, 120_000);
});

test("weakening uses a meaningful decline and reports drawdown from the peak", () => {
  const summary = summarizeZeroDteSignal({
    scores: [
      { observedAt: observedAt(0), score: 100 },
      { observedAt: observedAt(1), score: 110 },
      { observedAt: observedAt(2), score: 102 }
    ],
    previousState: "strengthening",
    minimumMovement,
    minimumConfirmationObservations: config.minConfirmationObservations
  });

  assert.equal(summary.state, "weakening");
  assert.equal(summary.scoreChange, -8);
  assert.equal(summary.peakScore, 110);
  assert.equal(summary.drawdownFromPeak, 8);
  assert.equal(summary.strengtheningDurationMs, 60_000);
  assert.equal(summary.weakeningDurationMs, 60_000);
});

test("insignificant movement remains stable even when observations are confirmed", () => {
  const summary = summarizeZeroDteSignal({
    scores: [
      { observedAt: observedAt(0), score: 100 },
      { observedAt: observedAt(1), score: 102 },
      { observedAt: observedAt(2), score: 103 }
    ],
    previousState: "watching",
    minimumMovement,
    minimumConfirmationObservations: config.minConfirmationObservations
  });

  assert.equal(summary.state, "stable");
  assert.equal(summary.scoreChange, 1);
  assert.equal(summary.peakScore, 103);
  assert.equal(summary.drawdownFromPeak, 0);
});

test("an expired setup that returns with meaningful strength is marked as reappeared", () => {
  const summary = summarizeZeroDteSignal({
    scores: [
      { observedAt: observedAt(0), score: 50 },
      { observedAt: observedAt(1), score: 56 }
    ],
    previousState: "expired",
    minimumMovement,
    minimumConfirmationObservations: config.minConfirmationObservations
  });

  assert.equal(summary.state, "strengthening");
  assert.equal(summary.reappeared, true);
});

test("slopes remain nullable until their configured observation windows are available", () => {
  const summary = summarizeZeroDteSignal({
    scores: [
      { observedAt: observedAt(1), score: 106 },
      { observedAt: observedAt(0), score: 100 }
    ],
    previousState: null,
    minimumMovement,
    minimumConfirmationObservations: config.minConfirmationObservations
  });

  assert.equal(summary.observationCount, 2);
  assert.equal(summary.shortSlope, null);
  assert.equal(summary.mediumSlope, null);
  assert.equal(summary.setupAgeMs, 60_000);
});

test("short and medium slopes use chronological linear windows", () => {
  const summary = summarizeZeroDteSignal({
    scores: [
      { observedAt: observedAt(4), score: 120 },
      { observedAt: observedAt(1), score: 105 },
      { observedAt: observedAt(3), score: 115 },
      { observedAt: observedAt(0), score: 100 },
      { observedAt: observedAt(2), score: 110 }
    ],
    previousState: "watching",
    minimumMovement,
    minimumConfirmationObservations: config.minConfirmationObservations
  });

  assert.equal(summary.shortSlope, 5);
  assert.equal(summary.mediumSlope, 5);
  assert.equal(summary.scoreChange, 5);
});
