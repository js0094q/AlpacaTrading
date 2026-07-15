export type PostgresRetryClass = "serialization" | "deadlock" | "connection" | null;

export type PostgresRetryTelemetry = {
  event: "postgres_retry";
  operation: string;
  outcome: "retry" | "success" | "failed" | "not_retried";
  retryClass: PostgresRetryClass;
  retryCount: number;
  delayMs: number | null;
  remainingDeadlineMs: number;
};

export type PostgresRetryOptions = {
  operation: string;
  idempotent: boolean;
  transactionallySafe: boolean;
  maxAttempts?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  jitterRatio?: number;
  retryDeadlineMs?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  emit?: (event: PostgresRetryTelemetry) => void;
};

const transactionRetryCodes = new Map<string, "serialization" | "deadlock">([
  ["40001", "serialization"],
  ["40P01", "deadlock"]
]);
const connectionRetryCodes = new Set([
  "08001",
  "08003",
  "08004",
  "08006",
  "57P01",
  "57P02",
  "57P03",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE"
]);

export const classifyPostgresRetryableError = (error: unknown): PostgresRetryClass => {
  const code = (error as { code?: unknown })?.code;
  if (typeof code !== "string") return null;
  return transactionRetryCodes.get(code) || (connectionRetryCodes.has(code) ? "connection" : null);
};

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export const runWithPostgresRetry = async <T>(
  operation: () => Promise<T>,
  options: PostgresRetryOptions
): Promise<T> => {
  const maxAttempts = Math.min(5, Math.max(1, Math.floor(options.maxAttempts ?? 3)));
  const retryDelayMs = Math.min(5_000, Math.max(0, Math.floor(options.retryDelayMs ?? 50)));
  const maxRetryDelayMs = Math.min(
    10_000,
    Math.max(retryDelayMs, Math.floor(options.maxRetryDelayMs ?? 1_000))
  );
  const jitterRatio = Math.min(1, Math.max(0, options.jitterRatio ?? 0.2));
  const retryDeadlineMs = Math.min(
    30_000,
    Math.max(0, Math.floor(options.retryDeadlineMs ?? 5_000))
  );
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  const sleep = options.sleep || delay;
  const emit = options.emit || (() => undefined);
  const deadlineAt = now() + retryDeadlineMs;
  let retryCount = 0;
  let finalError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1 && finalError !== undefined && now() >= deadlineAt) {
      emit({
        event: "postgres_retry",
        operation: options.operation,
        outcome: "failed",
        retryClass: classifyPostgresRetryableError(finalError),
        retryCount,
        delayMs: null,
        remainingDeadlineMs: 0
      });
      throw finalError;
    }
    try {
      const result = await operation();
      if (retryCount > 0) {
        emit({
          event: "postgres_retry",
          operation: options.operation,
          outcome: "success",
          retryClass: null,
          retryCount,
          delayMs: null,
          remainingDeadlineMs: Math.max(0, deadlineAt - now())
        });
      }
      return result;
    } catch (error) {
      finalError = error;
      const retryClass = classifyPostgresRetryableError(error);
      const safe = retryClass === "connection"
        ? options.idempotent
        : retryClass !== null && options.transactionallySafe;
      const remaining = Math.max(0, deadlineAt - now());
      const proposedDelay = Math.round(
        Math.min(maxRetryDelayMs, retryDelayMs * (2 ** retryCount)) *
        (1 + ((Math.min(1, Math.max(0, random())) * 2) - 1) * jitterRatio)
      );
      const canRetry = safe && attempt < maxAttempts && remaining > 0 && proposedDelay <= remaining;
      if (!canRetry) {
        if (retryClass !== null) {
          emit({
            event: "postgres_retry",
            operation: options.operation,
            outcome: safe ? "failed" : "not_retried",
            retryClass,
            retryCount,
            delayMs: proposedDelay,
            remainingDeadlineMs: remaining
          });
        }
        throw error;
      }
      retryCount += 1;
      emit({
        event: "postgres_retry",
        operation: options.operation,
        outcome: "retry",
        retryClass,
        retryCount,
        delayMs: proposedDelay,
        remainingDeadlineMs: remaining
      });
      await sleep(proposedDelay);
    }
  }

  throw finalError;
};
