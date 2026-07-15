import { hostname } from "node:os";

import { redactSensitiveText } from "./securityRedaction.js";

export interface SqliteContentionContext {
  operation: string;
  transaction?: string;
  runId?: string | null;
  correlationId?: string | null;
}

export interface SqliteContentionTelemetry {
  event: "sqlite_contention";
  operation: string;
  transaction: string | null;
  outcome: "retry" | "success" | "failed" | "not_retried";
  contentionClass: SqliteContentionClass;
  transactionDurationMs: number;
  retryCount: number;
  delayMs: number | null;
  deadlineAtMs: number;
  remainingDeadlineMs: number;
  processIdentity: string;
  runId: string | null;
  correlationId: string | null;
  errorCode?: string | number | null;
  errorMessage?: string | null;
}

export interface SqliteBusyRetryOptions extends SqliteContentionContext {
  idempotent: boolean;
  transactionallySafe?: boolean;
  maxAttempts?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  jitterRatio?: number;
  retryDeadlineMs?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number) => void;
  emit?: (event: SqliteContentionTelemetry) => void;
}

export type SqliteContentionClass = "busy" | "locked" | null;

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_DELAY_MS = 25;
const DEFAULT_MAX_RETRY_DELAY_MS = 1_000;
const DEFAULT_JITTER_RATIO = 0.2;
const DEFAULT_RETRY_DEADLINE_MS = 5_000;

const boundedInteger = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
) => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
};

const configuredMaxAttempts = () => boundedInteger(
  Number.parseInt(process.env.SQLITE_BUSY_RETRY_MAX_ATTEMPTS || "", 10),
  DEFAULT_MAX_ATTEMPTS,
  1,
  8
);

const configuredRetryDelayMs = () => boundedInteger(
  Number.parseInt(process.env.SQLITE_BUSY_RETRY_DELAY_MS || "", 10),
  DEFAULT_RETRY_DELAY_MS,
  0,
  1_000
);

const configuredRetryDeadlineMs = () => boundedInteger(
  Number.parseInt(process.env.SQLITE_BUSY_RETRY_DEADLINE_MS || "", 10),
  DEFAULT_RETRY_DEADLINE_MS,
  0,
  30_000
);

const sleepSync = (milliseconds: number) => {
  if (milliseconds <= 0) return;
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, milliseconds);
};

const errorDetails = (error: unknown) => {
  const candidate = error as {
    code?: unknown;
    errcode?: unknown;
    errno?: unknown;
    message?: unknown;
  };
  const message = error instanceof Error
    ? error.message
    : typeof candidate?.message === "string"
      ? candidate.message
      : String(error);
  const codes = [candidate?.code, candidate?.errcode, candidate?.errno].filter(
    (value): value is string | number => typeof value === "string" || typeof value === "number"
  );
  const code = typeof candidate?.code === "string" || typeof candidate?.code === "number"
    ? candidate.code
    : typeof candidate?.errcode === "number"
      ? candidate.errcode
      : typeof candidate?.errno === "number"
        ? candidate.errno
        : null;
  return { code, codes, message };
};

export const classifySqliteContentionError = (
  error: unknown
): SqliteContentionClass => {
  const details = errorDetails(error);
  for (const code of details.codes) {
    if (typeof code === "number") {
      const numericCode = code & 0xff;
      if (numericCode === SQLITE_BUSY) return "busy";
      if (numericCode === SQLITE_LOCKED) return "locked";
      continue;
    }
    if (/\bSQLITE_BUSY(?:_[A-Z0-9_]+)?\b/i.test(code)) return "busy";
    if (/\bSQLITE_LOCKED(?:_[A-Z0-9_]+)?\b/i.test(code)) return "locked";
  }
  if (/\bSQLITE_BUSY\b|database is locked|database busy/i.test(details.message)) {
    return "busy";
  }
  if (/\bSQLITE_LOCKED\b|table is locked/i.test(details.message)) return "locked";
  return null;
};

export const isSqliteBusyError = (error: unknown): boolean =>
  classifySqliteContentionError(error) === "busy";

export const isSqliteLockedError = (error: unknown): boolean =>
  classifySqliteContentionError(error) === "locked";

const defaultEmit = (event: SqliteContentionTelemetry) => {
  console.warn(JSON.stringify(event));
};

const emitTelemetry = (
  options: SqliteBusyRetryOptions,
  outcome: SqliteContentionTelemetry["outcome"],
  retryCount: number,
  startedAt: number,
  deadlineAtMs: number,
  now: () => number,
  contentionClass: SqliteContentionClass,
  delayMs: number | null,
  error?: unknown
) => {
  const details = error === undefined ? null : errorDetails(error);
  const redactedErrorMessage = details === null
    ? null
    : redactSensitiveText(details.message).slice(0, 240);
  const emittedAt = now();
  (options.emit || defaultEmit)({
    event: "sqlite_contention",
    operation: options.operation,
    transaction: options.transaction || null,
    outcome,
    contentionClass,
    transactionDurationMs: Math.max(0, emittedAt - startedAt),
    retryCount,
    delayMs,
    deadlineAtMs,
    remainingDeadlineMs: Math.max(0, deadlineAtMs - emittedAt),
    processIdentity: `${hostname()}:${process.pid}`,
    runId: options.runId || null,
    correlationId: options.correlationId || null,
    ...(details
      ? { errorCode: details.code, errorMessage: redactedErrorMessage }
      : {})
  });
};

export const runWithSqliteBusyRetry = <T>(
  operation: () => T,
  options: SqliteBusyRetryOptions
): T => {
  const maxAttempts = boundedInteger(
    options.maxAttempts,
    configuredMaxAttempts(),
    1,
    8
  );
  const retryDelayMs = boundedInteger(
    options.retryDelayMs,
    configuredRetryDelayMs(),
    0,
    1_000
  );
  const maxRetryDelayMs = boundedInteger(
    options.maxRetryDelayMs,
    Math.max(retryDelayMs, DEFAULT_MAX_RETRY_DELAY_MS),
    retryDelayMs,
    10_000
  );
  const jitterRatio = Math.min(
    1,
    Math.max(0, Number.isFinite(options.jitterRatio) ? options.jitterRatio as number : DEFAULT_JITTER_RATIO)
  );
  const retryDeadlineMs = boundedInteger(
    options.retryDeadlineMs,
    configuredRetryDeadlineMs(),
    0,
    30_000
  );
  const sleep = options.sleep || sleepSync;
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  const startedAt = now();
  const deadlineAtMs = startedAt + retryDeadlineMs;
  let retryCount = 0;
  let finalError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1 && finalError !== undefined && now() >= deadlineAtMs) {
      const contentionClass = classifySqliteContentionError(finalError);
      if (contentionClass !== null) {
        emitTelemetry(
          options,
          "failed",
          retryCount,
          startedAt,
          deadlineAtMs,
          now,
          contentionClass,
          null,
          finalError
        );
      }
      throw finalError;
    }
    try {
      const result = operation();
      if (retryCount > 0) {
        emitTelemetry(
          options,
          "success",
          retryCount,
          startedAt,
          deadlineAtMs,
          now,
          null,
          null
        );
      }
      return result;
    } catch (error) {
      finalError = error;
      const contentionClass = classifySqliteContentionError(error);
      const retrySafe = options.idempotent === true || options.transactionallySafe === true;
      const remainingDeadlineMs = Math.max(0, deadlineAtMs - now());
      const mayScheduleRetry = contentionClass !== null &&
        retrySafe &&
        attempt < maxAttempts;
      const delayMs = mayScheduleRetry
        ? Math.round(
          Math.min(maxRetryDelayMs, retryDelayMs * (2 ** retryCount)) *
          (1 + ((Math.min(1, Math.max(0, random())) * 2) - 1) * jitterRatio)
        )
        : null;
      const canRetry = mayScheduleRetry &&
        remainingDeadlineMs > 0 &&
        delayMs !== null &&
        delayMs <= remainingDeadlineMs;
      if (!canRetry) {
        if (contentionClass !== null) {
          emitTelemetry(
            options,
            retrySafe ? "failed" : "not_retried",
            retryCount,
            startedAt,
            deadlineAtMs,
            now,
            contentionClass,
            delayMs,
            error
          );
        }
        throw error;
      }
      retryCount += 1;
      emitTelemetry(
        options,
        "retry",
        retryCount,
        startedAt,
        deadlineAtMs,
        now,
        contentionClass,
        delayMs,
        error
      );
      sleep(delayMs);
    }
  }

  throw finalError;
};

export const sqliteBusyRetryDefaults = {
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  retryDelayMs: DEFAULT_RETRY_DELAY_MS,
  maxRetryDelayMs: DEFAULT_MAX_RETRY_DELAY_MS,
  jitterRatio: DEFAULT_JITTER_RATIO,
  retryDeadlineMs: DEFAULT_RETRY_DEADLINE_MS
} as const;
