import assert from "node:assert/strict";
import test from "node:test";

import {
  runAutonomousPostgresExecutionCommand,
  validateAutonomousExecutionEvidence,
  type AutonomousExecutionIntentRow
} from "../src/services/autonomousPostgresExecutionService.js";

const intent = (overrides: Partial<AutonomousExecutionIntentRow> = {}): AutonomousExecutionIntentRow => ({
  order_intent_id: "intent-1",
  account_id: "account-1",
  broker_account_id: "broker-account-1",
  account_snapshot_fingerprint: "portfolio-fingerprint",
  review_account_fingerprint: "structural-fingerprint",
  reservation_id: "reservation-1",
  execution_review_id: "review-1",
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
  const transaction = async <T>(
    operation: (query: { query: (sql: string, values?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }> }) => Promise<T>
  ) => operation({
    query: async (sql: string) => {
      transactionSql.push(sql);
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
  let submitCalls = 0;
  const transaction = async <T>(operation: (query: {
    query: (sql: string) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
  }) => Promise<T>) => operation({
    query: async (sql: string) => {
      statements.push(sql);
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
});
