import assert from "node:assert/strict";
import test from "node:test";

import {
  runAutonomousPostgresCommand,
  type AutonomousPostgresQueryExecutor
} from "../src/services/autonomousPostgresCommandService.js";

const completeEvidence = {
  account_count: "1",
  snapshot_count: "1",
  risk_limit_count: "1",
  allocation_count: "1",
  exposure_count: "1",
  active_reservation_count: "0",
  pending_intent_count: "0",
  open_order_count: "0",
  open_position_count: "2",
  completed_research_count: "1",
  eligible_candidate_count: "0",
  valid_review_count: "0",
  reconciliable_order_count: "0"
};

const executor = (row: Record<string, unknown>, calls: string[] = []): AutonomousPostgresQueryExecutor => ({
  query: async (sql: string) => {
    calls.push(sql);
    return { rows: [row], rowCount: 1 };
  }
});

test("research performs a PostgreSQL evidence evaluation and returns a legitimate no-trade result", async () => {
  const calls: string[] = [];
  const result = await runAutonomousPostgresCommand({
    command: "research:daily",
    query: executor(completeEvidence, calls),
    fence: {
      jobName: "research",
      workstream: "research",
      ownerId: "owner",
      runId: "run",
      fencingToken: "4"
    },
    now: new Date("2026-07-20T22:00:00.000Z")
  });
  assert.equal(result.status, "no_op");
  assert.equal(result.code, "NO_ELIGIBLE_POSTGRES_CANDIDATES");
  assert.equal(result.evidence.completedResearchCount, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /FROM accounts/);
  assert.match(calls[0]!, /FROM candidates/);
});

test("every command fails closed when current PostgreSQL authority evidence is incomplete", async () => {
  await assert.rejects(
    runAutonomousPostgresCommand({
      command: "paper:review",
      query: executor({ ...completeEvidence, risk_limit_count: "0" }),
      fence: {
        jobName: "allocation",
        workstream: "allocation",
        ownerId: "owner",
        runId: "run",
        fencingToken: "8"
      }
    }),
    /POSTGRES_RISK_LIMIT_EVIDENCE_MISSING/
  );
});

test("system recovery performs bounded fenced PostgreSQL recovery before evaluating evidence", async () => {
  const calls: string[] = [];
  const query: AutonomousPostgresQueryExecutor = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes("UPDATE research_runs")) return { rows: [], rowCount: 1 };
      if (sql.includes("UPDATE buying_power_reservations")) return { rows: [], rowCount: 2 };
      if (sql.includes("UPDATE execution_reviews")) return { rows: [], rowCount: 3 };
      if (sql.includes("UPDATE confirmation_evidence")) return { rows: [], rowCount: 4 };
      return { rows: [completeEvidence], rowCount: 1 };
    }
  };
  const result = await runAutonomousPostgresCommand({
    command: "system:recover",
    query,
    fence: {
      jobName: "autonomous-recovery",
      workstream: "autonomous_recovery",
      ownerId: "owner",
      runId: "run",
      fencingToken: "9"
    },
    now: new Date("2026-07-20T22:00:00.000Z")
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.recovery, {
    researchRuns: 1,
    reservations: 2,
    reviews: 3,
    confirmations: 4
  });
  assert.equal(calls.length, 5);
  for (const sql of calls.slice(0, 4)) assert.match(sql, /scheduler_leases/);
});
