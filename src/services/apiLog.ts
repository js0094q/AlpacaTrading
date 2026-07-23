export interface ApiRequestLogInput {
  provider: string;
  endpoint: string;
  method: string;
  status: number;
  requestId?: string | null;
}

// Runtime SQLite request logging was retired with the PostgreSQL-only cutover.
// Broker request evidence continues to be returned to callers through request IDs;
// a future durable request-log sink must be PostgreSQL-backed before it is enabled.
export const recordApiRequest = (_input: ApiRequestLogInput) => undefined;
