import assert from "node:assert/strict";
import test from "node:test";

import { runInvestmentOrchestrator } from "../src/services/investmentOrchestratorService.js";
import type { WorkstreamLane } from "../src/services/canonicalWorkstreamResult.js";

type SharedContext = { readonly cycleMarker: string };
type Proposal = { readonly id: string };
const orderedLanes = [
  "equity", "options_0dte", "options_leaps"
] as const satisfies readonly WorkstreamLane[];

test("invokes each enabled lane once with one shared context and skips disabled lanes", async () => {
  const context = { cycleMarker: "shared-cycle-context" };
  const invocations: WorkstreamLane[] = [];
  const receivedContexts: SharedContext[] = [];
  let contextLoads = 0, disabledInvocations = 0;
  const result = await runInvestmentOrchestrator<SharedContext, Proposal>({
    cycleId: "cycle-enabled",
    loadSharedContext: async () => (contextLoads += 1, context),
    lanes: [
      {
        lane: "equity", enabled: true,
        execute: async (shared) => {
          invocations.push("equity"); receivedContexts.push(shared);
          return { proposals: [{ id: "equity-proposal" }] };
        }
      },
      {
        lane: "options_0dte", enabled: false,
        execute: async () => {
          disabledInvocations += 1;
          return { proposals: [{ id: "disabled-proposal" }] };
        }
      },
      {
        lane: "options_leaps", enabled: true,
        execute: async (shared) => {
          invocations.push("options_leaps"); receivedContexts.push(shared);
          return { proposals: [{ id: "leaps-proposal" }] };
        }
      }
    ]
  });

  assert.equal(contextLoads, 1);
  assert.equal(disabledInvocations, 0);
  assert.deepEqual(invocations, ["equity", "options_leaps"]);
  assert.equal(receivedContexts.every((received) => received === context), true);
  assert.deepEqual(result.enabledLanes, ["equity", "options_leaps"]);
  assert.deepEqual(result.workstreamResults.map(({ lane }) => lane), invocations);
  assert.deepEqual(result.proposals.map(({ id }) => id), [
    "equity-proposal", "leaps-proposal"
  ]);
});

for (const scenario of [
  ["equity failure", "equity", "EQUITY_EVALUATION_FAILED"],
  ["0DTE failure", "options_0dte", "ZERO_DTE_EVALUATION_FAILED"],
  ["lane timeout", "options_0dte", "WORKSTREAM_TIMEOUT"]
] as const) {
  test(`${scenario[0]} does not suppress later enabled lanes or successful proposals`, async () => {
    const invocations: WorkstreamLane[] = [];
    const result = await runInvestmentOrchestrator<SharedContext, Proposal>({
      cycleId: "cycle-isolation",
      loadSharedContext: async () => ({ cycleMarker: "shared" }),
      lanes: orderedLanes.map((lane) => ({
        lane,
        enabled: true,
        execute: async () => {
          invocations.push(lane);
          if (lane === scenario[1]) throw new Error(scenario[2]);
          return { proposals: [{ id: `${lane}-proposal` }] };
        }
      }))
    });
    assert.deepEqual(invocations, orderedLanes);
    assert.equal(result.workstreamResults.length, 3);
    assert.equal(
      result.workstreamResults.find(({ lane }) => lane === scenario[1])?.outcome,
      "error"
    );
    assert.equal(
      result.proposals.some(({ id }) => id === `${scenario[1]}-proposal`),
      false
    );
    assert.equal(result.proposals.length, orderedLanes.length - 1);
  });
}

test("no_action and bounded readiness results preserve proposals from later lanes", async () => {
  const invocations: WorkstreamLane[] = [];
  const evaluations = {
    equity: { proposals: [], reason_codes: ["NO_ELIGIBLE_POSTGRES_CANDIDATES"] },
    options_0dte: { proposals: [], reason_codes: ["POSTGRES_STOCK_SNAPSHOT_STALE"] },
    options_leaps: { proposals: [{ id: "preserved-leaps-proposal" }] }
  } satisfies Record<WorkstreamLane, object>;
  const result = await runInvestmentOrchestrator<SharedContext, Proposal>({
    cycleId: "cycle-bounded",
    loadSharedContext: async () => ({ cycleMarker: "shared" }),
    lanes: orderedLanes.map((lane) => ({
      lane, enabled: true, execute: async () => (invocations.push(lane), evaluations[lane])
    }))
  });
  assert.deepEqual(invocations, orderedLanes);
  assert.deepEqual(result.workstreamResults.map(({ outcome }) => outcome),
    ["no_action", "no_action", "success"]
  );
  assert.deepEqual(result.workstreamResults[1]?.reason_codes, ["POSTGRES_STOCK_SNAPSHOT_STALE"]);
  assert.deepEqual(result.proposals, [{ id: "preserved-leaps-proposal" }]);
});

test("shared pre-lane failure remains fatal and does not fabricate lane results", async () => {
  let laneInvocations = 0;
  await assert.rejects(
    runInvestmentOrchestrator<SharedContext, Proposal>({
      cycleId: "cycle-context-failed",
      loadSharedContext: async () => { throw new Error("POSTGRES_SHARED_CONTEXT_UNAVAILABLE"); },
      lanes: [{
        lane: "equity", enabled: true,
        execute: async () => {
          laneInvocations += 1;
          return { proposals: [] };
        }
      }]
    }),
    /POSTGRES_SHARED_CONTEXT_UNAVAILABLE/
  );
  assert.equal(laneInvocations, 0);
});
