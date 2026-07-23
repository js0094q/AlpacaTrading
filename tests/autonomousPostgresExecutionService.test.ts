import assert from "node:assert/strict";
import test from "node:test";

import {
  promoteNextConfirmedPostgresIntent,
  runAutonomousPostgresExecutionCommand,
  validateAutonomousExecutionEvidence,
  type AutonomousExecutionIntentRow
} from "../src/services/autonomousPostgresExecutionService.js";

const intent = (overrides: Partial<AutonomousExecutionIntentRow> = {}): AutonomousExecutionIntentRow => ({
  order_intent_id: "intent-1",
  candidate_id: "candidate-1",
  account_id: "account-1",
  broker_account_id: "broker-account-1",
  account_snapshot_fingerprint: "portfolio-fingerprint",
  review_account_fingerprint: "structural-fingerprint",
  reservation_id: "reservation-1",
  execution_review_id: "review-1",
  review_type: "entry",
  confirmation_evidence_id: "confirmation-1",
  client_order_id: "worker-order-1",
  strategy_key: "baseline",
  symbol: "AAPL",
  asset_class: "equity",
  side: "buy",
  order_type: "limit",
  time_in_force: "day",
  quantity: "1",
  notional: null,
  limit_price: "200",
  stop_price: null,
  intent_version: "2",
  market_evidence: [{ symbol: "AAPL", referencePrice: 200, timestamp: "2026-07-20T21:59:30.000Z" }],
  ...overrides
});

const broker = {
  capturedAt: "2026-07-20T22:00:00.000Z",
  accountIdentityHash: "account-identity",
  brokerAccountId: "broker-account-1",
  portfolioFingerprint: "portfolio-fingerprint",
  structuralPortfolioFingerprint: "structural-fingerprint"
};

test("the execution gate rejects missing current market timestamp before submission", () => {
  assert.throws(
    () => validateAutonomousExecutionEvidence(
      intent({ market_evidence: [{ symbol: "AAPL", referencePrice: 200 }] }),
      broker,
      new Date("2026-07-20T22:00:00.000Z"),
      60
    ),
    /POSTGRES_MARKET_EVIDENCE_TIMESTAMP_MISSING/
  );
});

test("the execution gate rejects broker and PostgreSQL portfolio disagreement", () => {
  assert.throws(
    () => validateAutonomousExecutionEvidence(
      intent(),
      { ...broker, portfolioFingerprint: "different" },
      new Date("2026-07-20T22:00:00.000Z"),
      60
    ),
    /POSTGRES_BROKER_PORTFOLIO_EVIDENCE_CONFLICT/
  );
});

test("the execution gate accepts complete fresh paper evidence without synthesizing fields", () => {
  const payload = validateAutonomousExecutionEvidence(
    intent(),
    broker,
    new Date("2026-07-20T22:00:00.000Z"),
    60
  );
  assert.deepEqual(payload, {
    symbol: "AAPL",
    qty: "1",
    side: "buy",
    type: "limit",
    time_in_force: "day",
    limit_price: "200",
    client_order_id: "worker-order-1"
  });
});

test("the execution gate compares the persisted broker identity hash without hashing it twice", () => {
  const payload = validateAutonomousExecutionEvidence(
    intent({ broker_account_id: "account-identity" }),
    { ...broker, brokerAccountId: undefined },
    new Date("2026-07-20T22:00:00.000Z"),
    60
  );
  assert.equal(payload.symbol, "AAPL");
});

test("the execution gate emits supported option sell-to-close semantics", () => {
  const payload = validateAutonomousExecutionEvidence(
    intent({
      asset_class: "option",
      side: "sell_to_close",
      symbol: "SPY260720P00555000",
      notional: null,
      quantity: "1",
      limit_price: "1.05",
      market_evidence: [{
        symbol: "SPY260720P00555000",
        referencePrice: 1.05,
        timestamp: "2026-07-20T21:59:30.000Z"
      }]
    }),
    broker,
    new Date("2026-07-20T22:00:00.000Z"),
    60
  );
  assert.equal(payload.side, "sell");
  assert.equal(payload.position_intent, "sell_to_close");
});

test("confirmation promotion atomically readies an entry intent with a buying-power reservation", async () => {
  const statements: string[] = [];
  const values: Array<readonly unknown[]> = [];
  const result = await promoteNextConfirmedPostgresIntent({
    command: "paper:execute:reviewed",
    query: {
      query: async (sql: string, parameters?: readonly unknown[]) => {
        statements.push(sql);
        values.push(parameters ?? []);
        if (sql.includes("intent.status = 'created'")) {
          return {
            rows: [{
              order_intent_id: "intent-created",
              candidate_id: "candidate-1",
              account_id: "account-1",
              account_snapshot_id: "snapshot-1",
              strategy_key: "baseline",
              symbol: "AAPL",
              asset_class: "equity",
              side: "buy",
              max_risk: "100",
              execution_review_id: "review-1",
              review_type: "entry",
              review_payload_fingerprint: "review-payload",
              review_signature: "review-signature",
              review_expires_at: "2026-07-20T22:15:00.000Z"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("AS buying_power_allowed")) {
          return {
            rows: [{
              buying_power_allowed: true,
              deployment_allowed: true,
              strategy_allowed: true,
              symbol_allowed: true,
              position_count_allowed: true,
              order_count_allowed: true
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence: {
      jobName: "paper-execution",
      workstream: "paper_execution",
      ownerId: "owner",
      runId: "run",
      fencingToken: "10"
    },
    signingKey: "test-signing-key-with-sufficient-length",
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "promoted");
  assert.equal(result.orderIntentId, "intent-created");
  assert.equal(statements.some((sql) => sql.includes("INSERT INTO confirmation_evidence")), true);
  assert.equal(statements.some((sql) => sql.includes("INSERT INTO buying_power_reservations")), true);
  assert.equal(statements.some((sql) => sql.includes("UPDATE strategy_allocations")), true);
  assert.equal(
    statements.some((sql) =>
      sql.includes("SET confirmation_evidence_id") &&
      sql.includes("status = 'ready_for_submission'")
    ),
    true
  );
  const confirmationInsert = statements.findIndex((sql) => sql.includes("INSERT INTO confirmation_evidence"));
  assert.equal(values[confirmationInsert]?.[5], "autonomous_worker_confirm_paper");
});

test("paper execution promotes a confirmed created intent before broker submission", async () => {
  let countReads = 0;
  const transactionStatements: string[] = [];
  const result = await runAutonomousPostgresExecutionCommand({
    command: "paper:execute:reviewed",
    query: {
      query: async () => {
        countReads += 1;
        return {
          rows: [{
            ready_count: countReads === 1 ? "0" : "1",
            confirmable_count: countReads === 1 ? "1" : "0"
          }],
          rowCount: 1
        };
      }
    },
    transaction: async (operation) => operation({
      query: async (sql: string) => {
        transactionStatements.push(sql);
        if (sql.includes("intent.status = 'created'")) {
          return {
            rows: [{
              order_intent_id: "intent-created",
              candidate_id: "candidate-1",
              account_id: "account-1",
              account_snapshot_id: "snapshot-1",
              strategy_key: "baseline",
              symbol: "AAPL",
              asset_class: "equity",
              side: "buy",
              max_risk: "100",
              execution_review_id: "review-1",
              review_type: "entry",
              review_payload_fingerprint: "review-payload",
              review_signature: "review-signature",
              review_expires_at: "2026-07-20T22:15:00.000Z"
            }],
            rowCount: 1
          };
        }
        if (sql.includes("AS buying_power_allowed")) {
          return {
            rows: [{
              buying_power_allowed: true,
              deployment_allowed: true,
              strategy_allowed: true,
              symbol_allowed: true,
              position_count_allowed: true,
              order_count_allowed: true
            }],
            rowCount: 1
          };
        }
        if (sql.includes("FROM order_intents intent")) {
          return {
            rows: [intent({
              order_intent_id: "intent-created",
              confirmation_evidence_id: "confirmation-ready",
              reservation_id: "reservation-ready"
            }) as unknown as Record<string, unknown>],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    }),
    marketOpen: async () => true,
    captureBrokerSnapshot: async () => broker,
    submitOrder: async (payload) => ({
      data: {
        id: "broker-order-1",
        client_order_id: payload.client_order_id,
        status: "accepted",
        symbol: payload.symbol,
        side: payload.side,
        type: payload.type,
        time_in_force: payload.time_in_force,
        qty: payload.qty,
        submitted_at: "2026-07-20T22:00:00.000Z"
      },
      status: 200,
      url: "paper"
    }),
    safety: {
      environment: "paper",
      tradingMode: "paper",
      liveTradingEnabled: false,
      paperOrderExecutionEnabled: true,
      paperOptionsExecutionEnabled: true,
      quoteMaxAgeSeconds: 60
    },
    confirmPaper: true,
    confirmationSigningKey: "test-signing-key-with-sufficient-length",
    fence: {
      jobName: "paper-execution",
      workstream: "paper_execution",
      ownerId: "owner",
      runId: "run",
      fencingToken: "10"
    },
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  assert.equal(result.status, "completed");
  assert.equal(result.submittedOrderCount, 1);
  assert.equal(transactionStatements.some((sql) => sql.includes("INSERT INTO confirmation_evidence")), true);
});

test("an execution command with no ready PostgreSQL intent makes no broker call", async () => {
  let brokerCalls = 0;
  const result = await runAutonomousPostgresExecutionCommand({
    command: "paper:execute:reviewed",
    query: {
      query: async () => ({ rows: [{ ready_count: "0" }], rowCount: 1 })
    },
    transaction: async () => { throw new Error("transaction must not run"); },
    captureBrokerSnapshot: async () => {
      brokerCalls += 1;
      throw new Error("broker must not run");
    },
    submitOrder: async () => { throw new Error("submit must not run"); },
    safety: {
      environment: "paper",
      tradingMode: "paper",
      liveTradingEnabled: false,
      paperOrderExecutionEnabled: true,
      paperOptionsExecutionEnabled: true,
      quoteMaxAgeSeconds: 60
    },
    confirmPaper: true,
    fence: {
      jobName: "paper-execution",
      workstream: "paper_execution",
      ownerId: "owner",
      runId: "run",
      fencingToken: "10"
    }
  });
  assert.equal(result.status, "no_op");
  assert.equal(result.submittedOrderCount, 0);
  assert.equal(brokerCalls, 0);
});

test("reviewed execution rejects a mismatched persisted review artifact", async () => {
  const transaction = async <T>(operation: (query: {
    query: (sql: string) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
  }) => Promise<T>) => operation({
    query: async (sql: string) => sql.includes("FROM order_intents intent")
      ? {
          rows: [intent({
            review_signature: "persisted-signature",
            payload_fingerprint: "persisted-payload"
          }) as unknown as Record<string, unknown>],
          rowCount: 1
        }
      : { rows: [], rowCount: 1 }
  });

  await assert.rejects(
    runAutonomousPostgresExecutionCommand({
      command: "paper:execute:reviewed",
      query: { query: async () => ({ rows: [{ ready_count: "1" }], rowCount: 1 }) },
      transaction,
      marketOpen: async () => true,
      captureBrokerSnapshot: async () => broker,
      submitOrder: async () => { throw new Error("must not submit"); },
      safety: {
        environment: "paper",
        tradingMode: "paper",
        liveTradingEnabled: false,
        paperOrderExecutionEnabled: true,
        paperOptionsExecutionEnabled: true,
        quoteMaxAgeSeconds: 60
      },
      confirmPaper: true,
      expectedPayloadSignature: "different-signature",
      fence: {
        jobName: "paper-execution",
        workstream: "paper_execution",
        ownerId: "owner",
        runId: "run",
        fencingToken: "10"
      },
      now: new Date("2026-07-20T22:00:00.000Z")
    }),
    /PAPER_REVIEW_ARTIFACT_MISMATCH/
  );
});

test("live flags block before querying PostgreSQL or Alpaca", async () => {
  const previous = process.env.LIVE_TRADING_ENABLED;
  process.env.LIVE_TRADING_ENABLED = "true";
  try {
    await assert.rejects(
      runAutonomousPostgresExecutionCommand({
        command: "paper:execute:reviewed",
        query: { query: async () => { throw new Error("must not query"); } },
        transaction: async () => { throw new Error("must not transact"); },
        captureBrokerSnapshot: async () => { throw new Error("must not read broker"); },
        submitOrder: async () => { throw new Error("must not submit"); },
        safety: {
          environment: "paper",
          tradingMode: "paper",
          liveTradingEnabled: true,
          paperOrderExecutionEnabled: true,
          paperOptionsExecutionEnabled: true,
          quoteMaxAgeSeconds: 60
        },
        confirmPaper: true,
        fence: {
          jobName: "paper-execution",
          workstream: "paper_execution",
          ownerId: "owner",
          runId: "run",
          fencingToken: "10"
        }
      }),
      /LIVE_TRADING_MUST_BE_DISABLED/
    );
  } finally {
    if (previous === undefined) delete process.env.LIVE_TRADING_ENABLED;
    else process.env.LIVE_TRADING_ENABLED = previous;
  }
});

test("a closed paper market blocks a ready intent without account sync or submission", async () => {
  let snapshotCalls = 0;
  let submitCalls = 0;
  const result = await runAutonomousPostgresExecutionCommand({
    command: "paper:execute:reviewed",
    query: { query: async () => ({ rows: [{ ready_count: "1" }], rowCount: 1 }) },
    transaction: async () => { throw new Error("transaction must not run"); },
    marketOpen: async () => false,
    captureBrokerSnapshot: async () => {
      snapshotCalls += 1;
      throw new Error("snapshot must not run");
    },
    submitOrder: async () => {
      submitCalls += 1;
      throw new Error("submit must not run");
    },
    safety: {
      environment: "paper",
      tradingMode: "paper",
      liveTradingEnabled: false,
      paperOrderExecutionEnabled: true,
      paperOptionsExecutionEnabled: true,
      quoteMaxAgeSeconds: 60
    },
    confirmPaper: true,
    fence: {
      jobName: "paper-execution",
      workstream: "paper_execution",
      ownerId: "owner",
      runId: "run",
      fencingToken: "11"
    }
  });
  assert.equal(result.status, "no_op");
  assert.equal(result.code, "PAPER_MARKET_CLOSED");
  assert.equal(snapshotCalls, 0);
  assert.equal(submitCalls, 0);
});

test("an uncertain broker submission is persisted as ambiguous before the command fails", async () => {
  const transactionSql: string[] = [];
  const transactionValues: Array<readonly unknown[]> = [];
  const transaction = async <T>(
    operation: (query: { query: (sql: string, values?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }> }) => Promise<T>
  ) => operation({
    query: async (sql: string, values?: readonly unknown[]) => {
      transactionSql.push(sql);
      transactionValues.push(values ?? []);
      if (sql.includes("FROM order_intents intent")) {
        return { rows: [intent() as unknown as Record<string, unknown>], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
  });

  await assert.rejects(
    runAutonomousPostgresExecutionCommand({
      command: "paper:execute:reviewed",
      query: { query: async () => ({ rows: [{ ready_count: "1" }], rowCount: 1 }) },
      transaction,
      marketOpen: async () => true,
      captureBrokerSnapshot: async () => broker,
      submitOrder: async () => { throw new Error("socket closed before response"); },
      safety: {
        environment: "paper",
        tradingMode: "paper",
        liveTradingEnabled: false,
        paperOrderExecutionEnabled: true,
        paperOptionsExecutionEnabled: true,
        quoteMaxAgeSeconds: 60
      },
      confirmPaper: true,
      fence: {
        jobName: "paper-execution",
        workstream: "paper_execution",
        ownerId: "owner",
        runId: "run",
        fencingToken: "12"
      },
      now: new Date("2026-07-20T22:00:00.000Z")
    }),
    /POSTGRES_BROKER_SUBMISSION_AMBIGUOUS/
  );

  assert.equal(transactionSql.some((sql) => /SET status = 'ambiguous'/.test(sql)), true);
  assert.equal(transactionSql.some((sql) => /INSERT INTO broker_events/.test(sql)), true);
  const candidateUpdate = transactionSql.findIndex((sql) => sql.includes("UPDATE candidates"));
  assert.notEqual(candidateUpdate, -1);
  assert.equal(transactionValues[candidateUpdate]?.[1], "execution_ambiguous");
  assert.equal(transactionValues[candidateUpdate]?.[2], "POSTGRES_BROKER_SUBMISSION_AMBIGUOUS");
});

test("claiming an unreserved intent does not lock the nullable reservation join", async () => {
  const statements: string[] = [];
  const transaction = async <T>(operation: (query: {
    query: (sql: string) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
  }) => Promise<T>) => operation({
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes("FROM order_intents intent")) {
        return { rows: [intent({ reservation_id: null }) as unknown as Record<string, unknown>], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
  });
  await assert.rejects(
    runAutonomousPostgresExecutionCommand({
      command: "paper:execute:reviewed",
      query: { query: async () => ({ rows: [{ ready_count: "1" }], rowCount: 1 }) },
      transaction,
      marketOpen: async () => true,
      captureBrokerSnapshot: async () => broker,
      submitOrder: async () => { throw new Error("ambiguous"); },
      safety: {
        environment: "paper", tradingMode: "paper", liveTradingEnabled: false,
        paperOrderExecutionEnabled: true, paperOptionsExecutionEnabled: true,
        quoteMaxAgeSeconds: 60
      },
      confirmPaper: true,
      fence: { jobName: "execution", workstream: "execution", ownerId: "owner", runId: "run", fencingToken: "13" },
      now: new Date("2026-07-20T22:00:00.000Z")
    }),
    /POSTGRES_BROKER_SUBMISSION_AMBIGUOUS/
  );
  const select = statements.find((sql) => sql.includes("FROM order_intents intent"))!;
  assert.doesNotMatch(select, /FOR UPDATE OF[^\n]*reservation/);
});

test("a deterministic pre-submit rejection releases the claimed intent without broker submission", async () => {
  const statements: string[] = [];
  const statementValues: Array<readonly unknown[]> = [];
  let submitCalls = 0;
  const transaction = async <T>(operation: (query: {
    query: (sql: string) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
  }) => Promise<T>) => operation({
    query: async (sql: string, values?: readonly unknown[]) => {
      statements.push(sql);
      statementValues.push(values ?? []);
      if (sql.includes("FROM order_intents intent")) {
        return {
          rows: [intent({ asset_class: "option", side: "buy_to_open", symbol: "SPY260720C00625000" }) as unknown as Record<string, unknown>],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 1 };
    }
  });
  await assert.rejects(
    runAutonomousPostgresExecutionCommand({
      command: "paper:execute:reviewed",
      query: { query: async () => ({ rows: [{ ready_count: "1" }], rowCount: 1 }) },
      transaction,
      marketOpen: async () => true,
      captureBrokerSnapshot: async () => broker,
      submitOrder: async () => { submitCalls += 1; throw new Error("must not submit"); },
      safety: {
        environment: "paper", tradingMode: "paper", liveTradingEnabled: false,
        paperOrderExecutionEnabled: true, paperOptionsExecutionEnabled: false,
        quoteMaxAgeSeconds: 60
      },
      confirmPaper: true,
      fence: { jobName: "execution", workstream: "execution", ownerId: "owner", runId: "run", fencingToken: "14" },
      now: new Date("2026-07-20T22:00:00.000Z")
    }),
    /PAPER_OPTIONS_EXECUTION_DISABLED/
  );
  assert.equal(submitCalls, 0);
  assert.equal(statements.some((sql) => /SET status = 'ready_for_submission'/.test(sql)), true);
  assert.equal(statements.some((sql) => /SET status = 'ambiguous'/.test(sql)), false);
  const candidateUpdate = statements.findIndex((sql) => sql.includes("UPDATE candidates"));
  assert.notEqual(candidateUpdate, -1);
  assert.equal(statementValues[candidateUpdate]?.[1], "execution_deferred");
  assert.equal(statementValues[candidateUpdate]?.[2], "PAPER_OPTIONS_EXECUTION_DISABLED");
});

test("equity short submission fails closed unless Alpaca reports shortable and easy to borrow", async () => {
  const statements: string[] = [];
  let submitCalls = 0;
  await assert.rejects(
    runAutonomousPostgresExecutionCommand({
      command: "paper:execute:reviewed",
      query: {
        query: async () => ({
          rows: [{ ready_count: "1", confirmable_count: "0" }],
          rowCount: 1
        })
      },
      transaction: async (operation) => operation({
        query: async (sql: string) => {
          statements.push(sql);
          if (sql.includes("FROM order_intents intent")) {
            return {
              rows: [intent({
                side: "sell",
                order_type: "market",
                quantity: "1",
                notional: null,
                limit_price: null
              }) as unknown as Record<string, unknown>],
              rowCount: 1
            };
          }
          return { rows: [], rowCount: 1 };
        }
      }),
      marketOpen: async () => true,
      captureBrokerSnapshot: async () => broker,
      checkAsset: async () => ({
        symbol: "AAPL",
        tradable: true,
        asset: {
          symbol: "AAPL",
          status: "active",
          tradable: true,
          shortable: true,
          easyToBorrow: false
        }
      }),
      submitOrder: async () => {
        submitCalls += 1;
        throw new Error("must not submit");
      },
      safety: {
        environment: "paper",
        tradingMode: "paper",
        liveTradingEnabled: false,
        paperOrderExecutionEnabled: true,
        paperOptionsExecutionEnabled: true,
        quoteMaxAgeSeconds: 60
      },
      confirmPaper: true,
      fence: {
        jobName: "execution",
        workstream: "execution",
        ownerId: "owner",
        runId: "run",
        fencingToken: "15"
      },
      now: new Date("2026-07-20T22:00:00.000Z")
    }),
    /POSTGRES_SHORT_ASSET_INELIGIBLE/
  );
  assert.equal(submitCalls, 0);
  assert.equal(
    statements.some((sql) => /SET status = 'ready_for_submission'/.test(sql)),
    true
  );
});
