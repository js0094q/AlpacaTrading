import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";

const dbDir = mkdtempSync(join(tmpdir(), "alpaca-deadline-"));
process.env.RESEARCH_DB_PATH = join(dbDir, "research.db");
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_ENV = "paper";
process.env.ALPACA_PAPER_API_KEY = "paper-key";
process.env.ALPACA_PAPER_SECRET_KEY = "paper-secret";

const [deadlineModule, alpacaClient, libDb] = await Promise.all([
  import("../src/services/operationDeadline.js"),
  import("../src/services/alpacaClient.js"),
  import("../src/lib/db.js")
]);

const {
  AlpacaOperationDeadlineError,
  createOperationDeadline,
  getRequestTimeoutMs,
  getRetryDelayMs
} = deadlineModule;
const { getAlpacaPaperEndpoint } = alpacaClient;
const { closeDbForTests } = libDb;

after(() => {
  closeDbForTests();
  rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.ALPACA_PAPER_API_KEY = "paper-key";
  process.env.ALPACA_PAPER_SECRET_KEY = "paper-secret";
});

describe("Alpaca shared operation deadline", () => {
  test("two sequential calls derive request timeouts from one total monotonic budget", () => {
    let now = 1_000;
    const deadline = createOperationDeadline({
      timeoutMs: 10_000,
      completionMarginMs: 750,
      now: () => now
    });

    assert.equal(getRequestTimeoutMs(deadline, 15_000), 9_250);
    now += 4_000;
    assert.equal(getRequestTimeoutMs(deadline, 15_000), 5_250);
    now += 5_000;
    assert.equal(getRequestTimeoutMs(deadline, 15_000), 250);
  });

  test("retry delay never consumes the remaining request and completion budget", () => {
    let now = 0;
    const deadline = createOperationDeadline({
      timeoutMs: 2_000,
      completionMarginMs: 750,
      now: () => now
    });

    assert.equal(getRetryDelayMs(deadline, 250, 100), 250);
    now = 1_100;
    assert.equal(getRetryDelayMs(deadline, 250, 100), null);
  });

  test("a shorter per-attempt timeout can retry within the shared deadline", async () => {
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls += 1;
      if (calls === 1) {
        const signal = init?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("attempt timeout", "AbortError")),
            { once: true }
          );
        });
      }
      return new Response(JSON.stringify({ status: "ACTIVE" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const deadline = createOperationDeadline({ timeoutMs: 1_000, completionMarginMs: 100 });

    const response = await getAlpacaPaperEndpoint<{ status: string }>("/v2/account", {
      deadline,
      timeoutMs: 20,
      maxRetries: 1,
      retryBaseDelayMs: 1
    });

    assert.equal(response.data.status, "ACTIVE");
    assert.equal(calls, 2);
  });

  test("outer abort cancels the in-flight request and leaves no pending fetch", async () => {
    let active = 0;
    let aborted = false;
    globalThis.fetch = async (_input, init) => {
      active += 1;
      const signal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            active -= 1;
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true }
        );
      });
    };
    const controller = new AbortController();
    const deadline = createOperationDeadline({ timeoutMs: 5_000, completionMarginMs: 250 });
    const request = getAlpacaPaperEndpoint("/v2/account", {
      deadline,
      signal: controller.signal,
      timeoutMs: 4_000,
      maxRetries: 2
    });

    controller.abort();
    await assert.rejects(
      request,
      (error) =>
        error instanceof AlpacaOperationDeadlineError &&
        error.code === "ALPACA_OPERATION_ABORTED" &&
        error.metadata.timedOut === false
    );
    assert.equal(aborted, true);
    assert.equal(active, 0);
  });

  test("deadline expiry aborts response work and returns structured timeout metadata", async () => {
    let active = 0;
    globalThis.fetch = async (_input, init) => {
      active += 1;
      const signal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            active -= 1;
            reject(new DOMException("deadline", "AbortError"));
          },
          { once: true }
        );
      });
    };
    const deadline = createOperationDeadline({ timeoutMs: 40, completionMarginMs: 10 });

    await assert.rejects(
      () =>
        getAlpacaPaperEndpoint("/v2/clock", {
          deadline,
          timeoutMs: 5_000,
          maxRetries: 1
        }),
      (error) =>
        error instanceof AlpacaOperationDeadlineError &&
        error.code === "ALPACA_OPERATION_DEADLINE_EXCEEDED" &&
        error.metadata.timedOut === true &&
        error.metadata.completionMarginMs === 10
    );
    assert.equal(active, 0);
  });
});
