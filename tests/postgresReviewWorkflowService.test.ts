import assert from "node:assert/strict";
import test from "node:test";

import { runPostgresReviewWorkflow } from "../src/services/postgresReviewWorkflowService.js";

const fence = {
  jobName: "allocation", workstream: "allocation", ownerId: "worker",
  runId: "run", fencingToken: "9"
};

const candidate = {
  candidate_id: "candidate-1", symbol: "SPY", asset_class: "equity",
  option_symbol: null, preferred_expression: "shares", direction: "long",
  confidence: "0.9", candidate_as_of: "2026-07-20T20:00:00.000Z",
  account_id: "account-1", account_snapshot_id: "snapshot-1",
  snapshot_fingerprint: "portfolio-fingerprint",
  structural_fingerprint: "structural-fingerprint", buying_power: "10000",
  cash: "8000", equity: "20000", strategy_key: "baseline",
  allocation_amount: "5000", allocation_ratio: null, reserved_amount: "0",
  deployed_amount: "0", max_position_notional: "2000",
  max_symbol_notional: "2000", max_deployment_amount: "10000",
  cash_reserve_amount: "1000", cash_reserve_ratio: null,
  market_price: "555", market_timestamp: "2026-07-20T21:59:30.000Z",
  market_request_id: "sip-request", open_position_count: "0",
  open_order_count: "0"
};

test("entry review persists signed PostgreSQL review and unconfirmed pending intent", async () => {
  const sql: string[] = [];
  const result = await runPostgresReviewWorkflow({
    command: "paper:review",
    query: {
      query: async (statement: string) => {
        sql.push(statement);
        if (statement.includes("FROM candidates candidate")) return { rows: [candidate], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "completed");
  assert.equal(result.reviewsCreated, 1);
  assert.equal(result.pendingIntentsCreated, 1);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO execution_reviews")), true);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO order_intents")), true);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO confirmation_evidence")), false);
  assert.equal(sql.some((statement) => /'created'/.test(statement) && statement.includes("order_intents")), true);
});

test("review fails closed before persistence when market evidence is stale", async () => {
  const sql: string[] = [];
  await assert.rejects(
    runPostgresReviewWorkflow({
      command: "paper:review",
      query: {
        query: async (statement: string) => {
          sql.push(statement);
          if (statement.includes("FROM candidates candidate")) {
            return { rows: [{ ...candidate, market_timestamp: "2026-07-15T20:00:00.000Z" }], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        }
      },
      fence,
      signingKey: "test-signing-key-with-sufficient-length",
      now: new Date("2026-07-20T22:00:00.000Z")
    }),
    /POSTGRES_REVIEW_MARKET_EVIDENCE_STALE:SPY/
  );
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO execution_reviews")), false);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO order_intents")), false);
});

test("exit review evaluates existing thresholds against PostgreSQL position and market evidence", async () => {
  const sql: string[] = [];
  const result = await runPostgresReviewWorkflow({
    command: "paper:exit:review",
    query: {
      query: async (statement: string) => {
        sql.push(statement);
        if (statement.includes("FROM positions position")) return {
          rows: [{
            position_id: "position-1", candidate_id: "candidate-1",
            symbol: "SPY", order_symbol: "SPY", asset_class: "equity",
            side: "long", available_quantity: "2", average_entry_price: "500",
            strategy_key: "baseline", account_id: "account-1",
            account_snapshot_id: "snapshot-1", snapshot_fingerprint: "portfolio-fingerprint",
            structural_fingerprint: "structural-fingerprint", market_price: "550",
            market_timestamp: "2026-07-20T21:59:30.000Z", market_request_id: "sip-request"
          }],
          rowCount: 1
        };
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "completed");
  assert.equal(result.reviewsCreated, 1);
  assert.equal(sql.some((statement) => statement.includes("'exit'")), true);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO order_intents")), true);
});

test("0DTE discovery scopes PostgreSQL candidates to the requested underlying and expiry", async () => {
  let sourceSql = "";
  let sourceValues: readonly unknown[] = [];
  const result = await runPostgresReviewWorkflow({
    command: "paper:options:discover",
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("FROM candidates candidate")) {
          sourceSql = statement;
          sourceValues = values ?? [];
        }
        return { rows: [], rowCount: 0 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    underlying: "SPY",
    dte: 0,
    now: new Date("2026-07-20T18:00:00.000Z")
  });
  assert.equal(result.status, "no_op");
  assert.match(sourceSql, /JOIN option_contracts/);
  assert.match(sourceSql, /contract\.expiration_date/);
  assert.deepEqual(sourceValues, ["SPY", "2026-07-20T18:00:00.000Z", 0]);
});
