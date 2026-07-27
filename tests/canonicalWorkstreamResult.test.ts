import assert from "node:assert/strict";
import test from "node:test";

import {
  executeWorkstreamLanes,
  type WorkstreamLane
} from "../src/services/canonicalWorkstreamResult.js";

type Proposal = { id: string };

const lanes: WorkstreamLane[] = ["equity", "options_0dte", "options_leaps"];

const executeCycle = async (failedLane?: WorkstreamLane) => {
  const evaluated: WorkstreamLane[] = [];
  const results = await executeWorkstreamLanes<Proposal>({
    cycleId: "cycle-2",
    lanes: lanes.map((lane) => ({
      lane,
      execute: async () => {
        evaluated.push(lane);
        if (lane === failedLane) {
          throw new Error(`${lane.toUpperCase()}_EVALUATION_FAILED:${"x".repeat(300)}`);
        }
        return {
          proposals: [{ id: `${lane}-proposal` }],
          evidence_references: [`candidate:${lane}`],
          confidence: 0.8,
          reason_codes: ["PROPOSAL_READY"],
          diagnostic_summary: "Lane produced one proposal."
        };
      }
    }))
  });
  return { evaluated, results };
};

for (const failedLane of lanes) {
  test(`${failedLane} exception is isolated and remaining lanes still evaluate`, async () => {
    const { evaluated, results } = await executeCycle(failedLane);

    assert.deepEqual(evaluated, lanes);
    assert.equal(results.length, 3);
    assert.equal(results.filter((result) => result.lane === failedLane).length, 1);
    const failed = results.find((result) => result.lane === failedLane);
    assert.equal(failed?.outcome, "error");
    assert.deepEqual(failed?.proposals, []);
    assert.deepEqual(failed?.reason_codes, [`${failedLane.toUpperCase()}_EVALUATION_FAILED`]);
    assert.ok((failed?.diagnostic_summary.length ?? 0) <= 240);
    assert.deepEqual(
      results.filter((result) => result.lane !== failedLane).map((result) => result.outcome),
      ["success", "success"]
    );
  });
}

test("an empty lane result is a completed no_action outcome", async () => {
  const [result] = await executeWorkstreamLanes<Proposal>({
    cycleId: "cycle-empty",
    lanes: [{
      lane: "equity",
      execute: async () => ({
        proposals: [],
        evidence_references: ["research:run-empty"],
        reason_codes: ["NO_ELIGIBLE_CANDIDATES"]
      })
    }]
  });

  assert.equal(result?.cycle_id, "cycle-empty");
  assert.equal(result?.outcome, "no_action");
  assert.deepEqual(result?.proposals, []);
  assert.equal(result?.started_at.length, 24);
  assert.equal(result?.completed_at.length, 24);
});

test("the caller remains alive after a lane error", async () => {
  const { results } = await executeCycle("options_0dte");
  let continued = false;
  continued = true;

  assert.equal(continued, true);
  assert.equal(results[1]?.outcome, "error");
});
