import { isVercelRuntime } from "../lib/runtime.js";
import { nowIso } from "../lib/utils.js";

export interface ApiRequestLogInput {
  provider: string;
  endpoint: string;
  method: string;
  status: number;
  requestId?: string | null;
}

const dbModule = isVercelRuntime() ? null : await import("../lib/db.js");

export const recordApiRequest = (input: ApiRequestLogInput) => {
  if (isVercelRuntime()) {
    return;
  }

  const db = dbModule?.getDb();
  if (!db) {
    return;
  }

  db
    .prepare(
      `
      INSERT INTO api_request_log(
        provider,
        endpoint,
        method,
        status,
        request_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.provider,
      input.endpoint,
      input.method,
      input.status,
      input.requestId ?? null,
      nowIso()
    );
};
