export interface OperationDeadline {
  startedAtMs: number;
  deadlineAtMs: number;
  timeoutMs: number;
  completionMarginMs: number;
  now: () => number;
}

export interface OperationDeadlineMetadata {
  timedOut: boolean;
  timeoutMs: number;
  completionMarginMs: number;
  remainingMs: number;
}

export class AlpacaOperationDeadlineError extends Error {
  code: "ALPACA_OPERATION_DEADLINE_EXCEEDED" | "ALPACA_OPERATION_ABORTED";
  metadata: OperationDeadlineMetadata;

  constructor(
    code: "ALPACA_OPERATION_DEADLINE_EXCEEDED" | "ALPACA_OPERATION_ABORTED",
    deadline: OperationDeadline
  ) {
    super(
      code === "ALPACA_OPERATION_ABORTED"
        ? "Alpaca operation aborted."
        : "Alpaca operation deadline exceeded."
    );
    this.name = "AlpacaOperationDeadlineError";
    this.code = code;
    this.metadata = {
      timedOut: code === "ALPACA_OPERATION_DEADLINE_EXCEEDED",
      timeoutMs: deadline.timeoutMs,
      completionMarginMs: deadline.completionMarginMs,
      remainingMs: Math.max(0, Math.floor(deadline.deadlineAtMs - deadline.now()))
    };
  }
}

export const createOperationDeadline = (input: {
  timeoutMs: number;
  completionMarginMs: number;
  now?: () => number;
}): OperationDeadline => {
  const now = input.now || (() => performance.now());
  const timeoutMs = Math.max(1, Math.floor(input.timeoutMs));
  const completionMarginMs = Math.max(
    0,
    Math.min(Math.floor(input.completionMarginMs), timeoutMs - 1)
  );
  const startedAtMs = now();
  return {
    startedAtMs,
    deadlineAtMs: startedAtMs + timeoutMs,
    timeoutMs,
    completionMarginMs,
    now
  };
};

export const getRemainingNetworkBudgetMs = (deadline: OperationDeadline): number =>
  Math.max(
    0,
    Math.floor(deadline.deadlineAtMs - deadline.now() - deadline.completionMarginMs)
  );

export const getRequestTimeoutMs = (
  deadline: OperationDeadline,
  configuredTimeoutMs: number
): number => {
  const remaining = getRemainingNetworkBudgetMs(deadline);
  if (remaining <= 0) {
    throw new AlpacaOperationDeadlineError(
      "ALPACA_OPERATION_DEADLINE_EXCEEDED",
      deadline
    );
  }
  return Math.max(1, Math.min(Math.floor(configuredTimeoutMs), remaining));
};

export const getRetryDelayMs = (
  deadline: OperationDeadline,
  proposedDelayMs: number,
  minimumAttemptMs: number
): number | null => {
  const remaining = getRemainingNetworkBudgetMs(deadline);
  const delay = Math.max(0, Math.floor(proposedDelayMs));
  const minimumAttempt = Math.max(1, Math.floor(minimumAttemptMs));
  return remaining >= delay + minimumAttempt ? delay : null;
};

export const waitForRetry = async (
  delayMs: number,
  input: { deadline?: OperationDeadline; signal?: AbortSignal } = {}
): Promise<void> => {
  if (input.signal?.aborted) {
    if (input.deadline) {
      throw new AlpacaOperationDeadlineError("ALPACA_OPERATION_ABORTED", input.deadline);
    }
    throw new DOMException("aborted", "AbortError");
  }
  if (delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      input.signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(
        input.deadline
          ? new AlpacaOperationDeadlineError("ALPACA_OPERATION_ABORTED", input.deadline)
          : new DOMException("aborted", "AbortError")
      );
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
  });
};
