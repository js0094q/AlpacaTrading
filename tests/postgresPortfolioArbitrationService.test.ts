import assert from "node:assert/strict";
import test from "node:test";

import type { SchedulerFence } from "../src/repositories/contracts/common.js";
import type { PortfolioArbitrationDecision } from "../src/services/portfolioResourceArbitrator.js";
import {
  persistPortfolioArbitrationDecisions
} from "../src/services/postgresPortfolioArbitrationService.js";

const fence: SchedulerFence = {
  jobName: "allocation",
  workstream: "allocation",
  ownerId: "worker",
  runId: "cycle-9",
  fencingToken: "9"
};

const decision = (
  proposalId: string,
  action: "approve" | "resize" | "skip",
  rank: number,
  lane?: PortfolioArbitrationDecision["lane"]
): PortfolioArbitrationDecision => ({
  arbitrationId: "arbitration-cycle-9",
  cycleId: "cycle-9",
  proposalId,
  lane: lane ?? (rank === 1 ? "equity" : rank === 2 ? "options_0dte" : "options_leaps"),
  rank,
  action,
  originalQuantity: action === "approve" ? null : 2,
  approvedQuantity: action === "resize" ? 1 : action === "approve" ? null : null,
  originalNotional: 200,
  approvedNotional: action === "skip" ? null : action === "resize" ? 100 : 200,
  originalResourceRequirement: 200,
  approvedResourceRequirement:
    action === "skip" ? null : action === "resize" ? 100 : 200,
  score: 90 - rank,
  confidence: 0.9,
  strategyPriority: rank - 1,
  deterministicTiebreak: `${rank}|${proposalId}`,
  conflictTypes: action === "skip" ? ["SHARED_RESOURCE_CAPACITY"] : [],
  reasonCodes: [
    action === "approve"
      ? "ARBITRATION_APPROVED"
      : action === "resize"
        ? "ARBITRATION_RESIZED_BUYING_POWER"
        : "ARBITRATION_SKIPPED_NO_VALID_RESIZE"
  ],
  relatedProposalIds: action === "skip" ? ["proposal-1"] : [],
  relatedPositionIds: [],
  relatedOpenOrderIds: [],
  sharedContextVersion: "portfolio-fingerprint-1",
  accountSnapshotAsOf: "2026-07-29T14:00:00.000Z",
  positionSnapshotAsOf: "2026-07-29T14:00:00.000Z",
  openOrderSnapshotAsOf: "2026-07-29T14:00:00.000Z"
});

test("persists every decision in one fenced, idempotent PostgreSQL batch", async () => {
  const queries: Array<{
    sql: string;
    values: readonly unknown[];
  }> = [];
  const decisions = [
    decision("proposal-1", "approve", 1),
    decision("proposal-2", "resize", 2),
    decision("proposal-3", "skip", 3),
    decision("proposal-4", "approve", 4, "options_standard")
  ];

  const result = await persistPortfolioArbitrationDecisions({
    query: {
      query: async (sql, values = []) => {
        queries.push({ sql, values });
        return {
          rows: [{
            fence_held: true,
            inserted_count: "4",
            matched_count: "4"
          }],
          rowCount: 1
        };
      }
    },
    fence,
    accountId: "account-1",
    accountSnapshotId: "snapshot-1",
    contextId: "snapshot-1",
    decisions,
    createdAt: "2026-07-29T14:01:00.000Z"
  });

  assert.deepEqual(result, {
    decisionCount: 4,
    insertedCount: 4,
    replayedCount: 0
  });
  assert.equal(queries.length, 1);
  assert.match(queries[0]!.sql, /INSERT INTO portfolio_arbitration_decisions/);
  assert.match(
    queries[0]!.sql,
    /ON CONFLICT \(arbitration_id, proposal_id\) DO NOTHING/
  );
  assert.match(queries[0]!.sql, /scheduler_leases/);
  assert.match(queries[0]!.sql, /fencing_token/);
  const payload = JSON.parse(String(queries[0]!.values[0])) as Array<
    Record<string, unknown>
  >;
  assert.equal(payload.length, 4);
  assert.deepEqual(
    payload.map(({ lane }) => lane),
    ["equity", "options_0dte", "options_leaps", "options_standard"]
  );
  assert.deepEqual(
    payload.map(({ action, original_quantity, approved_quantity }) => ({
      action,
      original_quantity,
      approved_quantity
    })),
    [
      { action: "approve", original_quantity: null, approved_quantity: null },
      { action: "resize", original_quantity: 2, approved_quantity: 1 },
      { action: "skip", original_quantity: 2, approved_quantity: null },
      { action: "approve", original_quantity: null, approved_quantity: null }
    ]
  );
  assert.equal(
    payload.every(({ decision_fingerprint }) =>
      /^[a-f0-9]{64}$/.test(String(decision_fingerprint))
    ),
    true
  );
  assert.equal(
    payload.every(({ shared_context_version }) =>
      shared_context_version === "portfolio-fingerprint-1"
    ),
    true
  );
});

test("an exact replay is accepted while a mismatched or unfenced replay fails closed", async () => {
  const decisions = [decision("proposal-1", "approve", 1)];
  const exactReplay = await persistPortfolioArbitrationDecisions({
    query: {
      query: async () => ({
        rows: [{
          fence_held: true,
          inserted_count: "0",
          matched_count: "1"
        }],
        rowCount: 1
      })
    },
    fence,
    accountId: "account-1",
    accountSnapshotId: "snapshot-1",
    contextId: "snapshot-1",
    decisions,
    createdAt: "2026-07-29T14:01:00.000Z"
  });
  assert.deepEqual(exactReplay, {
    decisionCount: 1,
    insertedCount: 0,
    replayedCount: 1
  });

  await assert.rejects(
    persistPortfolioArbitrationDecisions({
      query: {
        query: async () => ({
          rows: [{
            fence_held: true,
            inserted_count: "0",
            matched_count: "0"
          }],
          rowCount: 1
        })
      },
      fence,
      accountId: "account-1",
      accountSnapshotId: "snapshot-1",
      contextId: "snapshot-1",
      decisions,
      createdAt: "2026-07-29T14:01:00.000Z"
    }),
    /POSTGRES_PORTFOLIO_ARBITRATION_IDEMPOTENCY_CONFLICT/
  );

  await assert.rejects(
    persistPortfolioArbitrationDecisions({
      query: {
        query: async () => ({
          rows: [{
            fence_held: false,
            inserted_count: "0",
            matched_count: "0"
          }],
          rowCount: 1
        })
      },
      fence,
      accountId: "account-1",
      accountSnapshotId: "snapshot-1",
      contextId: "snapshot-1",
      decisions,
      createdAt: "2026-07-29T14:01:00.000Z"
    }),
    /POSTGRES_PORTFOLIO_ARBITRATION_FENCE_REJECTED/
  );
});
