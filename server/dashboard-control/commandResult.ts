import { redactSensitiveText } from "../../src/lib/securityRedaction.js";

export const COMMAND_OUTPUT_LIMIT = 8_192;

export interface CommandFailureInput {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface GuardedCommandFailure {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  warnings: string[];
  error: {
    code: string;
    message: string;
  };
  diagnosticExcerpt: string;
}

const bound = (value: string): string => {
  const redacted = redactSensitiveText(value.trim());
  if (redacted.length <= COMMAND_OUTPUT_LIMIT) {
    return redacted;
  }
  const suffix = "...[truncated]";
  return `${redacted.slice(0, COMMAND_OUTPUT_LIMIT - suffix.length)}${suffix}`;
};

const parseJsonObject = (stdout: string): Record<string, unknown> | null => {
  const candidates = [
    stdout.trim(),
    ...stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse()
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next bounded output candidate.
    }
  }
  return null;
};

const inferErrorCode = (message: string): string =>
  /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message)
    ? "SQLITE_BUSY"
    : "COMMAND_FAILED";

const structuredError = (
  parsed: Record<string, unknown> | null
): { code: string; message: string } | null => {
  if (!parsed) {
    return null;
  }
  const rawError = parsed.error;
  if (typeof rawError === "string" && rawError.trim()) {
    const message = bound(rawError);
    const code =
      typeof parsed.code === "string" && parsed.code.trim()
        ? bound(parsed.code)
        : inferErrorCode(message);
    return { code, message };
  }
  if (rawError && typeof rawError === "object" && !Array.isArray(rawError)) {
    const nested = rawError as Record<string, unknown>;
    if (typeof nested.message === "string" && nested.message.trim()) {
      const message = bound(nested.message);
      const code =
        typeof nested.code === "string" && nested.code.trim()
          ? bound(nested.code)
          : typeof parsed.code === "string" && parsed.code.trim()
            ? bound(parsed.code)
            : inferErrorCode(message);
      return { code, message };
    }
  }
  return null;
};

const stderrWarnings = (stderr: string): string[] =>
  stderr
    .split("\n")
    .map((line) => bound(line))
    .filter((line) => line.length > 0 && /warning/i.test(line));

const stderrCausalLines = (stderr: string): string =>
  stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/warning/i.test(line))
    .join("\n");

export const normalizeCommandFailure = (
  input: CommandFailureInput
): GuardedCommandFailure => {
  const stdout = bound(input.stdout);
  const stderr = bound(input.stderr);
  const warnings = stderrWarnings(input.stderr);
  const parsedError = structuredError(parseJsonObject(input.stdout));

  let error: GuardedCommandFailure["error"];
  if (parsedError) {
    error = parsedError;
  } else if (input.timedOut) {
    error = { code: "COMMAND_TIMEOUT", message: "Command timed out." };
  } else if (input.signal) {
    error = {
      code: "COMMAND_SIGNALLED",
      message: `Command terminated by signal ${input.signal}.`
    };
  } else {
    const fallback = bound(stderrCausalLines(input.stderr) || input.stdout || "Command execution failed.");
    error = {
      code: inferErrorCode(fallback),
      message: fallback || "Command execution failed."
    };
  }

  return {
    exitCode: input.exitCode,
    signal: input.signal,
    timedOut: input.timedOut,
    stdout,
    stderr,
    warnings,
    error: {
      code: bound(error.code),
      message: bound(error.message)
    },
    diagnosticExcerpt: bound(
      [stdout ? `stdout: ${stdout}` : "", stderr ? `stderr: ${stderr}` : ""]
        .filter(Boolean)
        .join("\n") || error.message
    )
  };
};

export class GuardedCommandError extends Error {
  code: string;
  result: GuardedCommandFailure;

  constructor(action: string, result: GuardedCommandFailure) {
    super(`${action} command failed: ${result.error.message}`);
    this.name = "GuardedCommandError";
    this.code = result.error.code;
    this.result = result;
  }
}
