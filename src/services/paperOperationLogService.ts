import { randomUUID } from "node:crypto";
import { getDb, queryAll } from "../lib/db.js";

export type PaperOperationTriggerSource = "dashboard" | "scheduler" | "cli";
export type PaperOperationStatus =
  | "idle"
  | "running"
  | "success"
  | "warning"
  | "failed"
  | "blocked";

export interface PaperOperationLogEntry {
  id: string;
  actionType: string;
  triggerSource: PaperOperationTriggerSource;
  startedAt: string;
  finishedAt: string | null;
  status: PaperOperationStatus;
  requestId: string | null;
  correlationId: string | null;
  command: string | null;
  summary: Record<string, unknown> | null;
  warnings: string[];
  blockers: string[];
  errorMessage: string | null;
}

interface PaperOperationRow {
  id: string;
  action_type: string;
  trigger_source: PaperOperationTriggerSource;
  started_at: string;
  finished_at: string | null;
  status: PaperOperationStatus;
  request_id: string | null;
  correlation_id: string | null;
  command: string | null;
  summary_json: string | null;
  warnings_json: string | null;
  blockers_json: string | null;
  error_message: string | null;
}

const parseJson = <T>(value: string | null, fallback: T): T => {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const mapRow = (row: PaperOperationRow): PaperOperationLogEntry => ({
  id: row.id,
  actionType: row.action_type,
  triggerSource: row.trigger_source,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  status: row.status,
  requestId: row.request_id,
  correlationId: row.correlation_id,
  command: row.command,
  summary: parseJson<Record<string, unknown> | null>(row.summary_json, null),
  warnings: parseJson<string[]>(row.warnings_json, []),
  blockers: parseJson<string[]>(row.blockers_json, []),
  errorMessage: row.error_message
});

export const startPaperOperation = (input: {
  id?: string;
  actionType: string;
  triggerSource: PaperOperationTriggerSource;
  requestId?: string | null;
  correlationId?: string | null;
  command?: string | null;
  startedAt?: string;
}): PaperOperationLogEntry => {
  const startedAt = input.startedAt ?? new Date().toISOString();
  const id = input.id ?? `pop_${randomUUID()}`;
  getDb()
    .prepare(
      `
      INSERT INTO paper_operation_log(
        id,
        action_type,
        trigger_source,
        started_at,
        finished_at,
        status,
        request_id,
        correlation_id,
        command,
        summary_json,
        warnings_json,
        blockers_json,
        error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      id,
      input.actionType,
      input.triggerSource,
      startedAt,
      null,
      "running",
      input.requestId ?? null,
      input.correlationId ?? null,
      input.command ?? null,
      null,
      JSON.stringify([]),
      JSON.stringify([]),
      null
    );
  return {
    id,
    actionType: input.actionType,
    triggerSource: input.triggerSource,
    startedAt,
    finishedAt: null,
    status: "running",
    requestId: input.requestId ?? null,
    correlationId: input.correlationId ?? null,
    command: input.command ?? null,
    summary: null,
    warnings: [],
    blockers: [],
    errorMessage: null
  };
};

export const finishPaperOperation = (input: {
  id: string;
  status: PaperOperationStatus;
  finishedAt?: string;
  summary?: Record<string, unknown> | null;
  warnings?: string[];
  blockers?: string[];
  errorMessage?: string | null;
}): PaperOperationLogEntry | null => {
  const finishedAt = input.finishedAt ?? new Date().toISOString();
  getDb()
    .prepare(
      `
      UPDATE paper_operation_log
      SET finished_at = ?,
          status = ?,
          summary_json = ?,
          warnings_json = ?,
          blockers_json = ?,
          error_message = ?
      WHERE id = ?
      `
    )
    .run(
      finishedAt,
      input.status,
      input.summary ? JSON.stringify(input.summary) : null,
      JSON.stringify(input.warnings ?? []),
      JSON.stringify(input.blockers ?? []),
      input.errorMessage ?? null,
      input.id
    );
  return getPaperOperation(input.id);
};

export const recordPaperOperation = (input: {
  actionType: string;
  triggerSource: PaperOperationTriggerSource;
  status: PaperOperationStatus;
  requestId?: string | null;
  correlationId?: string | null;
  command?: string | null;
  startedAt?: string;
  finishedAt?: string;
  summary?: Record<string, unknown> | null;
  warnings?: string[];
  blockers?: string[];
  errorMessage?: string | null;
}) => {
  const operation = startPaperOperation(input);
  return finishPaperOperation({
    id: operation.id,
    status: input.status,
    finishedAt: input.finishedAt,
    summary: input.summary,
    warnings: input.warnings,
    blockers: input.blockers,
    errorMessage: input.errorMessage
  });
};

export const getPaperOperation = (id: string): PaperOperationLogEntry | null => {
  const row = getDb()
    .prepare(
      `
      SELECT *
      FROM paper_operation_log
      WHERE id = ?
      `
    )
    .get(id) as PaperOperationRow | undefined;
  return row ? mapRow(row) : null;
};

export const listPaperOperations = (limit = 25): PaperOperationLogEntry[] =>
  queryAll<PaperOperationRow>(
    `
    SELECT *
    FROM paper_operation_log
    ORDER BY started_at DESC
    LIMIT ?
    `,
    [Math.min(100, Math.max(1, Math.floor(limit)))]
  ).map(mapRow);
