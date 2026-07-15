import { hostname } from "node:os";

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
  transactionDurationMs: number;
  retryCount: number;
  processIdentity: string;
  runId: string | null;
  correlationId: string | null;
  errorCode?: string | number | null;
  errorMessage?: string | null;
}

export interface SqliteBusyRetryOptions extends SqliteContentionContext {
  idempotent: boolean;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => void;
  emit?: (event: SqliteContentionTelemetry) => void;
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_DELAY_MS = 25;

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
  const code = typeof candidate?.code === "string" || typeof candidate?.code === "number"
    ? candidate.code
    : typeof candidate?.errcode === "number"
      ? candidate.errcode
      : typeof candidate?.errno === "number"
        ? candidate.errno
        : null;
  return { code, message };
};

export const isSqliteBusyError = (error: unknown): boolean => {
  const details = errorDetails(error);
  const numericCode = typeof details.code === "number" ? details.code & 0xff : null;
  if (numericCode === SQLITE_LOCKED) return false;
  if (numericCode === SQLITE_BUSY) return true;
  if (typeof details.code === "string" && /SQLITE_BUSY/i.test(details.code)) return true;
  if (/SQLITE_LOCKED|table is locked/i.test(details.message)) return false;
  return /database is locked|database busy|SQLITE_BUSY/i.test(details.message);
};

const defaultEmit = (event: SqliteContentionTelemetry) => {
  console.warn(JSON.stringify(event));
};

const emitTelemetry = (
  options: SqliteBusyRetryOptions,
  outcome: SqliteContentionTelemetry["outcome"],
  retryCount: number,
  startedAt: number,
  error?: unknown
) => {
  const details = error === undefined ? null : errorDetails(error);
  (options.emit || defaultEmit)({
    event: "sqlite_contention",
    operation: options.operation,
    transaction: options.transaction || null,
    outcome,
    transactionDurationMs: Math.max(0, Date.now() - startedAt),
    retryCount,
    processIdentity: `${hostname()}:${process.pid}`,
    runId: options.runId || null,
    correlationId: options.correlationId || null,
    ...(details
      ? { errorCode: details.code, errorMessage: details.message.slice(0, 240) }
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
  const sleep = options.sleep || sleepSync;
  const startedAt = Date.now();
  let retryCount = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = operation();
      if (retryCount > 0) {
        emitTelemetry(options, "success", retryCount, startedAt);
      }
      return result;
    } catch (error) {
      const busy = isSqliteBusyError(error);
      const canRetry = busy && options.idempotent && attempt < maxAttempts;
      if (!canRetry) {
        if (busy) {
          emitTelemetry(
            options,
            options.idempotent ? "failed" : "not_retried",
            retryCount,
            startedAt,
            error
          );
        }
        throw error;
      }
      retryCount += 1;
      emitTelemetry(options, "retry", retryCount, startedAt, error);
      sleep(retryDelayMs);
    }
  }

  throw new Error("SQLITE_BUSY retry exhausted without a terminal result");
};

export const sqliteBusyRetryDefaults = {
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  retryDelayMs: DEFAULT_RETRY_DELAY_MS
} as const;
