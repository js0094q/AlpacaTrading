import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

process.env.RESEARCH_DB_PATH = join(mkdtempSync(join(tmpdir(), "hedge-learning-")), "research.db");

import {
  evaluateHedgeLearning,
  listHedgeLearningEvents,
  recordHedgeLearningEvent
} from "../src/services/hedgeLearningLifecycleService.js";

test("records idempotent hedge lifecycle events with separate quality dimensions", () => {
  const first = recordHedgeLearningEvent({
    eventId: "hedge-event-1",
    reviewId: "hedge-review-1",
    eventType: "submit",
    createdAt: "2026-07-13T14:00:00.000Z",
    evidence: { clientOrderId: "hedge-entry-1", requestId: "request-1", secret: "must-not-persist" }
  });
  const second = recordHedgeLearningEvent({
    eventId: "hedge-event-1",
    reviewId: "hedge-review-1",
    eventType: "submit",
    createdAt: "2026-07-13T14:00:00.000Z",
    evidence: { clientOrderId: "hedge-entry-1", requestId: "request-1" }
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(listHedgeLearningEvents("hedge-review-1").length, 1);
  assert.equal(JSON.stringify(listHedgeLearningEvents("hedge-review-1")).includes("must-not-persist"), false);

  for (const eventType of ["decision", "selection", "sizing", "fill", "protection", "exit", "outcome"] as const) {
    recordHedgeLearningEvent({
      eventId: `hedge-${eventType}`,
      reviewId: "hedge-review-1",
      eventType,
      evidence: { quality: "observed" }
    });
  }
  const evaluation = evaluateHedgeLearning("hedge-review-1");
  assert.equal(evaluation.paperOnly, true);
  assert.equal(evaluation.eventCount, 8);
  assert.deepEqual(evaluation.qualityDimensions, {
    decision: "observed",
    selection: "observed",
    sizing: "observed",
    execution: "observed",
    protection: "observed",
    exit: "observed"
  });
});
