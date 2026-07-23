export type PostgresQueryTelemetry = {
  connectionAcquisitionMs: number;
  poolWaitMs: number;
  queryDurationMs: number;
  poolTotalConnections?: number;
  poolIdleConnections?: number;
  poolWaitingRequests?: number;
};

type TelemetryCarrier = {
  postgresTelemetry?: Partial<PostgresQueryTelemetry>;
};

const finiteNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export const readPostgresQueryTelemetry = (
  value: unknown
): PostgresQueryTelemetry => {
  const telemetry = (value as TelemetryCarrier | null)?.postgresTelemetry;
  return {
    connectionAcquisitionMs: finiteNumber(telemetry?.connectionAcquisitionMs),
    poolWaitMs: finiteNumber(telemetry?.poolWaitMs),
    queryDurationMs: finiteNumber(telemetry?.queryDurationMs),
    ...(typeof telemetry?.poolTotalConnections === "number"
      ? { poolTotalConnections: telemetry.poolTotalConnections }
      : {}),
    ...(typeof telemetry?.poolIdleConnections === "number"
      ? { poolIdleConnections: telemetry.poolIdleConnections }
      : {}),
    ...(typeof telemetry?.poolWaitingRequests === "number"
      ? { poolWaitingRequests: telemetry.poolWaitingRequests }
      : {})
  };
};

export const attachPostgresQueryTelemetry = <T>(
  value: T,
  telemetry: PostgresQueryTelemetry
): T => {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    try {
      Object.assign(value as object, { postgresTelemetry: telemetry });
    } catch {
      // Telemetry must never replace the original PostgreSQL result or error.
    }
  }
  return value;
};

const nullableText = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export const postgresErrorTelemetry = (
  error: unknown,
  context: {
    failingStatement: string;
    batchNumber: number | null;
    symbol: string | null;
  }
) => {
  const record = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  return {
    event: "postgres_query_error",
    sqlState: nullableText(record.code),
    message: nullableText(record.message) ?? "PostgreSQL operation failed.",
    detail: nullableText(record.detail),
    hint: nullableText(record.hint),
    constraint: nullableText(record.constraint),
    schema: nullableText(record.schema),
    table: nullableText(record.table),
    index: nullableText(record.index),
    failingStatement: context.failingStatement,
    batchNumber: context.batchNumber,
    symbol: context.symbol,
    ...readPostgresQueryTelemetry(error)
  };
};
