import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyPostgresRetryableError,
  runWithPostgresRetry
} from "../src/lib/database/postgresRetry.js";

test("classifies only serialization, deadlock, and safe transient connection failures", () => {
  assert.equal(classifyPostgresRetryableError({ code: "40001" }), "serialization");
  assert.equal(classifyPostgresRetryableError({ code: "40P01" }), "deadlock");
  assert.equal(classifyPostgresRetryableError({ code: "08006" }), "connection");
  assert.equal(classifyPostgresRetryableError({ code: "ECONNRESET" }), "connection");
  assert.equal(classifyPostgresRetryableError({ code: "23505" }), null);
  assert.equal(classifyPostgresRetryableError(new Error("validation failed")), null);
});

test("retries a transactionally safe serialization failure with bounded exponential jitter", async () => {
  const serialization = Object.assign(new Error("serialization"), { code: "40001" });
  let attempts = 0;
  let now = 1_000;
  const sleeps: number[] = [];
  const events: string[] = [];
  const result = await runWithPostgresRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw serialization;
      return "complete";
    },
    {
      operation: "test.serialization",
      transactionallySafe: true,
      idempotent: false,
      maxAttempts: 4,
      retryDelayMs: 10,
      maxRetryDelayMs: 25,
      jitterRatio: 0,
      retryDeadlineMs: 100,
      now: () => now,
      sleep: async (delay) => {
        sleeps.push(delay);
        now += delay;
      },
      emit: (event) => events.push(`${event.outcome}:${event.retryCount}`)
    }
  );

  assert.equal(result, "complete");
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [10, 20]);
  assert.deepEqual(events, ["retry:1", "retry:2", "success:2"]);
});

test("does not retry connection failures unless the operation is explicitly idempotent", async () => {
  const connection = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
  let attempts = 0;

  await assert.rejects(
    () =>
      runWithPostgresRetry(
        async () => {
          attempts += 1;
          throw connection;
        },
        {
          operation: "test.non_idempotent_connection",
          idempotent: false,
          transactionallySafe: true,
          maxAttempts: 4
        }
      ),
    (error) => error === connection
  );
  assert.equal(attempts, 1);
});

test("stops at the total deadline and preserves the final causal error", async () => {
  const deadlock = Object.assign(new Error("deadlock"), { code: "40P01" });
  let attempts = 0;
  let now = 50;

  await assert.rejects(
    () =>
      runWithPostgresRetry(
        async () => {
          attempts += 1;
          throw deadlock;
        },
        {
          operation: "test.deadline",
          transactionallySafe: true,
          idempotent: false,
          maxAttempts: 5,
          retryDelayMs: 10,
          retryDeadlineMs: 10,
          jitterRatio: 0,
          now: () => now,
          sleep: async (delay) => {
            now += delay;
          }
        }
      ),
    (error) => error === deadlock
  );
  assert.equal(attempts, 1);
});
