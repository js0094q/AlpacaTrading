import { redactSensitiveText } from "../securityRedaction.js";

export type SanitizedDatabaseError = {
  code: string | null;
  message: string;
};

export const sanitizeDatabaseError = (error: unknown): SanitizedDatabaseError => {
  const candidate = error as { code?: unknown; message?: unknown };
  const code =
    typeof candidate?.code === "string" || typeof candidate?.code === "number"
      ? String(candidate.code)
      : null;
  const message =
    error instanceof Error
      ? error.message
      : typeof candidate?.message === "string"
        ? candidate.message
        : "Database operation failed.";
  return {
    code,
    message: redactSensitiveText(message).slice(0, 500)
  };
};
