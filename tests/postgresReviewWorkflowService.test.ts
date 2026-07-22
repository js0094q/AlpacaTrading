import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { Pool } from "pg";

import { loadDatabaseConfig } from "../src/lib/database/config.js";
import { createPostgresPool } from "../src/lib/database/postgres.js";
import { runPostgresMigrations } from "../src/lib/database/postgresMigrations.js";
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

test("entry review skips an existing candidate and account-snapshot review identity", async () => {
  let reviewCreated = false;
  let sourceReads = 0;
  const query = {
    query: async (statement: string) => {
      if (statement.includes("FROM candidates candidate")) {
        sourceReads += 1;
        const excludesExistingIdentity = statement.includes("FROM execution_reviews existing_review");
        if (reviewCreated && excludesExistingIdentity) return { rows: [], rowCount: 0 };
        return {
          rows: [{
            ...candidate,
            market_timestamp: sourceReads === 1
              ? "2026-07-20T21:59:30.000Z"
              : "2026-07-20T21:59:45.000Z"
          }],
          rowCount: 1
        };
      }
      if (statement.includes("INSERT INTO execution_reviews")) {
        if (reviewCreated) {
          throw new Error("duplicate key value violates unique constraint execution_reviews_client_order_idx");
        }
        reviewCreated = true;
      }
      return { rows: [], rowCount: 1 };
    }
  };

  const first = await runPostgresReviewWorkflow({
    command: "paper:review",
    query,
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:00.000Z")
  });
  assert.equal(first.reviewsCreated, 1);

  const second = await runPostgresReviewWorkflow({
    command: "paper:review",
    query,
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:10.000Z")
  });
  assert.equal(second.status, "no_op");
  assert.equal(second.reviewsCreated, 0);
  assert.equal(second.pendingIntentsCreated, 0);
  assert.equal(sourceReads, 2);
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

test("entry review skips held/open-order candidates and reviews the remaining candidates", async () => {
  const sql: string[] = [];
  const rows = [
    { ...candidate, candidate_id: "held-candidate", open_position_count: "1" },
    { ...candidate, candidate_id: "available-candidate", symbol: "QQQ" }
  ];
  const result = await runPostgresReviewWorkflow({
    command: "paper:review",
    query: {
      query: async (statement: string) => {
        sql.push(statement);
        if (statement.includes("FROM candidates candidate")) return { rows, rowCount: rows.length };
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
  assert.equal(result.skipped, 1);
  assert.equal(sql.filter((statement) => statement.includes("INSERT INTO execution_reviews")).length, 1);
  assert.equal(sql.filter((statement) => statement.includes("INSERT INTO order_intents")).length, 1);
});

test("stale evidence fails closed before any candidate review is persisted", async () => {
  const sql: string[] = [];
  await assert.rejects(
    runPostgresReviewWorkflow({
      command: "paper:review",
      query: {
        query: async (statement: string) => {
          sql.push(statement);
          if (statement.includes("FROM candidates candidate")) {
            return { rows: [candidate, { ...candidate, candidate_id: "stale-candidate", symbol: "QQQ", market_timestamp: "2026-07-15T20:00:00.000Z" }], rowCount: 2 };
          }
          return { rows: [], rowCount: 1 };
        }
      },
      fence,
      signingKey: "test-signing-key-with-sufficient-length",
      now: new Date("2026-07-20T22:00:00.000Z")
    }),
    /POSTGRES_REVIEW_MARKET_EVIDENCE_STALE:QQQ/
  );
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO execution_reviews")), false);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO order_intents")), false);
});

test("option capacity failure is detected before a preceding valid candidate is persisted", async () => {
  const sql: string[] = [];
  const rows = [
    { ...candidate, candidate_id: "available-candidate" },
    {
      ...candidate,
      candidate_id: "option-candidate",
      symbol: "SPY",
      asset_class: "option" as const,
      option_symbol: "SPY260821C00600000",
      preferred_expression: "option",
      market_price: "20"
    }
  ];
  await assert.rejects(
    runPostgresReviewWorkflow({
      command: "paper:review",
      query: {
        query: async (statement: string) => {
          sql.push(statement);
          if (statement.includes("FROM candidates candidate")) return { rows, rowCount: rows.length };
          return { rows: [], rowCount: 1 };
        }
      },
      fence,
      signingKey: "test-signing-key-with-sufficient-length",
      now: new Date("2026-07-20T22:00:00.000Z")
    }),
    /POSTGRES_REVIEW_OPTION_CAPACITY_INSUFFICIENT:SPY/
  );
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO execution_reviews")), false);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO order_intents")), false);
});

test("exhausted allocation capacity is a successful row-level no-op", async () => {
  const sql: string[] = [];
  const result = await runPostgresReviewWorkflow({
    command: "paper:review",
    query: {
      query: async (statement: string) => {
        sql.push(statement);
        if (statement.includes("FROM candidates candidate")) {
          return { rows: [{ ...candidate, reserved_amount: "5000" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "completed");
  assert.equal(result.code, "POSTGRES_REVIEW_CAPACITY_UNAVAILABLE");
  assert.equal(result.reviewsCreated, 0);
  assert.equal(result.pendingIntentsCreated, 0);
  assert.equal(result.capacityBlocked, 1);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO execution_reviews")), false);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO order_intents")), false);
});

for (const field of ["buying_power", "cash", "equity"] as const) {
  for (const missingValue of [null, "   ", "not-a-number"] as const) {
    test(`missing or malformed ${field} sizing evidence fails closed before persistence`, async () => {
      const sql: string[] = [];
      await assert.rejects(
        runPostgresReviewWorkflow({
          command: "paper:review",
          query: {
            query: async (statement: string) => {
              sql.push(statement);
              if (statement.includes("FROM candidates candidate")) {
                return { rows: [{ ...candidate, [field]: missingValue }], rowCount: 1 };
              }
              return { rows: [], rowCount: 1 };
            }
          },
          fence,
          signingKey: "test-signing-key-with-sufficient-length",
          now: new Date("2026-07-20T22:00:00.000Z")
        }),
        /POSTGRES_REVIEW_ACCOUNT_SIZING_EVIDENCE_MISSING/
      );
      assert.equal(sql.some((statement) => statement.includes("INSERT INTO execution_reviews")), false);
      assert.equal(sql.some((statement) => statement.includes("INSERT INTO order_intents")), false);
    });
  }

  test(`explicit zero ${field} evidence produces a completed capacity outcome`, async () => {
    const sql: string[] = [];
    const result = await runPostgresReviewWorkflow({
      command: "paper:review",
      query: {
        query: async (statement: string) => {
          sql.push(statement);
          if (statement.includes("FROM candidates candidate")) {
            return {
              rows: [{
                ...candidate,
                [field]: "0",
                ...(field === "equity" ? { cash_reserve_amount: "8000" } : {})
              }],
              rowCount: 1
            };
          }
          return { rows: [], rowCount: 1 };
        }
      },
      fence,
      signingKey: "test-signing-key-with-sufficient-length",
      now: new Date("2026-07-20T22:00:00.000Z")
    });
    assert.equal(result.status, "completed");
    assert.equal(result.code, "POSTGRES_REVIEW_CAPACITY_UNAVAILABLE");
    assert.equal(result.capacityBlocked, 1);
    assert.equal(sql.some((statement) => statement.includes("INSERT INTO execution_reviews")), false);
    assert.equal(sql.some((statement) => statement.includes("INSERT INTO order_intents")), false);
  });
}

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
        if (statement.includes("INSERT INTO execution_reviews")) {
          return { rows: [{ fence_held: true, inserted_count: 1 }], rowCount: 1 };
        }
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

const repeatedExitSource = (marketPrice: string, marketTimestamp: string) => ({
  position_id: "position-repeated-exit", candidate_id: null,
  symbol: "SPY", order_symbol: "SPY260722P00748000", asset_class: "option",
  side: "long", available_quantity: "1", average_entry_price: "1.15",
  strategy_key: "baseline", account_id: "account-repeated-exit",
  account_snapshot_id: "snapshot-repeated-exit", snapshot_fingerprint: "portfolio-fingerprint",
  structural_fingerprint: "structural-fingerprint", market_price: marketPrice,
  market_timestamp: marketTimestamp, market_request_id: "opra-request"
});

test("repeated exit evidence for one position and account snapshot is an idempotent row-level skip", async () => {
  let sourceReads = 0;
  let reviewInserts = 0;
  let intentInserts = 0;
  const query = {
    query: async (statement: string) => {
      if (statement.includes("FROM positions position")) {
        sourceReads += 1;
        return {
          rows: [sourceReads === 1
            ? repeatedExitSource("0.50", "2026-07-22T16:50:00.000Z")
            : repeatedExitSource("0.45", "2026-07-22T16:55:00.000Z")],
          rowCount: 1
        };
      }
      if (statement.includes("INSERT INTO execution_reviews")) {
        reviewInserts += 1;
        if (reviewInserts === 2) {
          if (!/ON CONFLICT \(account_id, client_order_id\)[\s\S]*DO NOTHING/.test(statement)) {
            const error = new Error(
              'duplicate key value violates unique constraint "execution_reviews_client_order_idx"'
            ) as Error & { code: string };
            error.code = "23505";
            throw error;
          }
          return { rows: [{ fence_held: true, inserted_count: 0 }], rowCount: 1 };
        }
        return { rows: [{ fence_held: true, inserted_count: 1 }], rowCount: 1 };
      }
      if (statement.includes("INSERT INTO order_intents")) {
        intentInserts += 1;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  };

  const first = await runPostgresReviewWorkflow({
    command: "paper:exit:review", query, fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-22T16:51:00.000Z")
  });
  const second = await runPostgresReviewWorkflow({
    command: "paper:exit:review", query, fence,
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-22T16:56:00.000Z")
  });

  assert.equal(first.reviewsCreated, 1);
  assert.equal(first.pendingIntentsCreated, 1);
  assert.equal(second.status, "completed");
  assert.equal(second.reviewsCreated, 0);
  assert.equal(second.pendingIntentsCreated, 0);
  assert.equal(second.skipped, 1);
  assert.equal(reviewInserts, 2);
  assert.equal(intentInserts, 1);
});

test("exit review fails closed when the scheduler fence is not held at insert time", async () => {
  let intentInserts = 0;
  await assert.rejects(
    runPostgresReviewWorkflow({
      command: "paper:exit:review",
      query: {
        query: async (statement: string) => {
          if (statement.includes("FROM positions position")) {
            return {
              rows: [repeatedExitSource("0.45", "2026-07-22T16:55:00.000Z")],
              rowCount: 1
            };
          }
          if (statement.includes("INSERT INTO execution_reviews")) {
            if (!statement.includes("inserted_review")) return { rows: [], rowCount: 0 };
            return { rows: [{ fence_held: false, inserted_count: 0 }], rowCount: 1 };
          }
          if (statement.includes("INSERT INTO order_intents")) intentInserts += 1;
          return { rows: [], rowCount: 0 };
        }
      },
      fence,
      signingKey: "test-signing-key-with-sufficient-length",
      now: new Date("2026-07-22T16:56:00.000Z")
    }),
    /SCHEDULER_FENCE_LOST/
  );
  assert.equal(intentInserts, 0);
});

test("real PostgreSQL preserves one exit review and intent across changing market evidence", {
  skip: process.env.POSTGRES_INTEGRATION_TEST_ENABLED !== "true"
}, async () => {
  const config = loadDatabaseConfig(
    {
      ...process.env,
      DATABASE_BACKEND: "postgres",
      POSTGRES_APPLICATION_NAME: "alpaca-exit-review-integration-test"
    },
    { runtime: "test", purpose: "migration" }
  );
  const schema = `exit_review_test_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const adminPool = createPostgresPool(config, "direct");
  let schemaPool: Pool | undefined;
  const integrationFence = {
    jobName: "exit-review", workstream: "exit_review",
    ownerId: "integration-owner", runId: "integration-run", fencingToken: "91"
  };
  let sourceReads = 0;

  try {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    schemaPool = createPostgresPool(config, "direct", {
      sessionOptions: `-c search_path=${schema}`
    });
    await runPostgresMigrations(schemaPool, config);
    const now = new Date();
    const schedulerExpiry = new Date(now.getTime() + 60 * 60_000).toISOString();
    await schemaPool.query(
      `INSERT INTO accounts(id, broker_account_id, environment, status, created_at, updated_at)
       VALUES ('account-repeated-exit', 'broker-repeated-exit', 'paper', 'active', $1, $1)`,
      [now.toISOString()]
    );
    await schemaPool.query(
      `INSERT INTO scheduler_leases(
         job_name, workstream, owner_id, run_id, fencing_token, status,
         acquired_at, heartbeat_at, expires_at, created_at, updated_at
       ) VALUES (
         'exit-review', 'exit_review', 'integration-owner', 'integration-run', 91,
         'held', $1, $1, $2, $1, $1
       )`,
      [now.toISOString(), schedulerExpiry]
    );

    const query = {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("FROM positions position")) {
          sourceReads += 1;
          return {
            rows: [sourceReads === 1
              ? repeatedExitSource("0.50", new Date(now.getTime() - 60_000).toISOString())
              : repeatedExitSource("0.45", new Date(now.getTime() - 30_000).toISOString())],
            rowCount: 1
          };
        }
        return schemaPool!.query(statement, values ? [...values] : []);
      }
    };

    const first = await runPostgresReviewWorkflow({
      command: "paper:exit:review", query, fence: integrationFence,
      signingKey: "test-signing-key-with-sufficient-length", now
    });
    const second = await runPostgresReviewWorkflow({
      command: "paper:exit:review", query, fence: integrationFence,
      signingKey: "test-signing-key-with-sufficient-length",
      now: new Date(now.getTime() + 30_000)
    });
    const counts = await schemaPool.query(
      `SELECT
         (SELECT COUNT(*)::integer FROM execution_reviews) AS review_count,
         (SELECT COUNT(*)::integer FROM order_intents) AS intent_count`
    );

    assert.equal(first.reviewsCreated, 1);
    assert.equal(first.pendingIntentsCreated, 1);
    assert.equal(second.status, "completed");
    assert.equal(second.reviewsCreated, 0);
    assert.equal(second.pendingIntentsCreated, 0);
    assert.equal(second.skipped, 1);
    assert.deepEqual(counts.rows[0], { review_count: 1, intent_count: 1 });
  } finally {
    await schemaPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  }
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
