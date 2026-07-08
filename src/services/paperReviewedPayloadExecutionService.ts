import {
  AlpacaApiError,
  getAccount,
  submitPaperOrder,
  type AlpacaPaperOrderRequest,
  type AlpacaSubmittedOrder,
  type AlpacaApiResponse
} from "./alpacaClient.js";
import {
  findPaperExecutionByDedupeKey,
  insertPaperExecutionLedgerEntry,
  updatePaperExecutionLedgerEntry
} from "./paperExecutionLedgerService.js";
import {
  isPaperReviewArtifactFresh,
  isReviewedPayloadSectionName,
  latestPaperReviewArtifact,
  type PaperReviewArtifact,
  type ReviewedPayloadSectionName
} from "./paperReviewArtifactService.js";
import { getTradingSafetyState } from "./tradingSafetyService.js";

export type PaperReviewedExecutionStatus =
  | "submitted"
  | "partial"
  | "blocked"
  | "warning"
  | "no_op";

export interface PaperReviewedExecutionReport {
  paperOnly: true;
  environment: "paper" | "live";
  generatedAt: string;
  mode: "reviewedConfirmPaper";
  status: PaperReviewedExecutionStatus;
  reason: string | null;
  artifactId: string | null;
  payloadSignature: string | null;
  submitted: Array<{
    section: ReviewedPayloadSectionName;
    assetClass: "equity" | "option";
    symbol: string;
    side: "buy" | "sell";
    type: "market" | "limit";
    qty?: string;
    notional?: string;
    limitPrice?: string;
    clientOrderId: string;
    alpacaOrderId?: string;
    status: string;
    requestId?: string;
  }>;
  blocked: Array<{
    section?: ReviewedPayloadSectionName;
    symbol?: string;
    reason: string;
    explanation?: string;
    clientOrderId?: string;
  }>;
  errors: Array<{
    symbol?: string;
    reason: string;
    message?: string;
    requestId?: string;
  }>;
  summary: {
    reviewedPayloads: number;
    eligiblePayloads: number;
    submitted: number;
    blocked: number;
    errors: number;
  };
}

interface PaperReviewedExecutionInput {
  confirmPaper?: boolean;
  expectedPayloadSignature?: string;
  sections?: ReviewedPayloadSectionName[];
}

interface NormalizedReviewedPayload {
  section: ReviewedPayloadSectionName;
  assetClass: "equity" | "option";
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  timeInForce: "day";
  qty?: string;
  notional?: string;
  limitPrice?: string;
  positionIntent?: "buy_to_open" | "sell_to_close" | "sell_to_open" | "buy_to_close";
  clientOrderId: string;
  dedupeKey: string;
  sourceReviewId?: string;
  sourceCandidateId?: string;
  raw: Record<string, unknown>;
}

interface PaperReviewedExecutionDeps {
  getAccount?: typeof getAccount;
  submitPaperOrder?: typeof submitPaperOrder;
  latestArtifact?: typeof latestPaperReviewArtifact;
  now?: () => string;
}

const parseBoolean = (name: string) =>
  process.env[name] === "true" || process.env[name] === "1";

const parseFalse = (name: string) =>
  process.env[name] === "false" || process.env[name] === "0";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object");

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const normalizeType = (value: unknown): "market" | "limit" =>
  value === "limit" ? "limit" : "market";

const normalizeSide = (value: unknown): "buy" | "sell" | null =>
  value === "buy" || value === "sell" ? value : null;

const safeIdPart = (value: string | undefined, fallback: string) =>
  (value || fallback)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56) || fallback;

const normalizePayload = (
  artifact: PaperReviewArtifact,
  section: ReviewedPayloadSectionName,
  payload: unknown,
  index: number
): NormalizedReviewedPayload | { blocked: PaperReviewedExecutionReport["blocked"][number] } => {
  if (!isRecord(payload)) {
    return {
      blocked: {
        section,
        reason: "REVIEW_PAYLOAD_INVALID",
        explanation: "Reviewed payload is not an object."
      }
    };
  }

  const rawAssetClass = stringField(payload.assetClass) || stringField(payload.asset_class);
  const assetClass = rawAssetClass === "option" ? "option" : "equity";
  const symbol = stringField(payload.symbol);
  const side = normalizeSide(payload.side);
  const type = normalizeType(payload.type ?? payload.order_type);
  const timeInForce = payload.time_in_force === "day" || payload.timeInForce === "day" ? "day" : "day";
  const clientOrderId =
    stringField(payload.client_order_id) ||
    stringField(payload.clientOrderId) ||
    `paper-reviewed-${safeIdPart(section, "section")}-${safeIdPart(symbol, "symbol")}-${safeIdPart(artifact.id, "artifact")}-${index + 1}`.slice(0, 128);

  if (!symbol || !side) {
    return {
      blocked: {
        section,
        symbol,
        clientOrderId,
        reason: "REVIEW_PAYLOAD_INVALID",
        explanation: "Reviewed payload is missing symbol or side."
      }
    };
  }

  return {
    section,
    assetClass,
    symbol,
    side,
    type,
    timeInForce,
    qty: stringField(payload.qty),
    notional: stringField(payload.notional),
    limitPrice: stringField(payload.limit_price) || stringField(payload.limitPrice),
    positionIntent: stringField(payload.position_intent) as NormalizedReviewedPayload["positionIntent"],
    clientOrderId,
    dedupeKey:
      stringField(payload.dedupeKey) ||
      `paper-reviewed:${artifact.id}:${section}:${symbol}:${clientOrderId}`,
    sourceReviewId: stringField(payload.sourceReviewId) || artifact.id,
    sourceCandidateId: stringField(payload.sourceCandidateId),
    raw: payload
  };
};

const allArtifactPayloads = (artifact: PaperReviewArtifact) =>
  (Object.entries(artifact.artifact.payloadSections) as Array<[ReviewedPayloadSectionName, unknown[]]>)
    .flatMap(([section, rows]) => rows.map((row, index) => ({ section, row, index })));

const requestedSections = (sections: ReviewedPayloadSectionName[] | undefined) => {
  const normalized = (sections ?? []).filter(isReviewedPayloadSectionName);
  return normalized.length ? new Set(normalized) : null;
};

const isLeapsSellToCloseExit = (payload: NormalizedReviewedPayload) => {
  if (
    payload.section !== "optionSellToCloseExits" ||
    payload.assetClass !== "option" ||
    payload.positionIntent !== "sell_to_close"
  ) {
    return false;
  }
  const raw = payload.raw;
  const reason = stringField(raw.reason);
  const reasonCodes = Array.isArray(raw.reasonCodes)
    ? raw.reasonCodes
    : Array.isArray(raw.reasons)
      ? raw.reasons
      : [];
  return Boolean(
    isRecord(raw.leapsExitEvaluation) ||
    reason?.startsWith("LEAPS_") ||
    reasonCodes.some((entry) => typeof entry === "string" && entry.startsWith("LEAPS_"))
  );
};

const toAlpacaPayload = (payload: NormalizedReviewedPayload): AlpacaPaperOrderRequest => ({
  symbol: payload.symbol,
  qty: payload.qty,
  notional: payload.assetClass === "equity" ? payload.notional : undefined,
  side: payload.side,
  type: payload.type,
  time_in_force: payload.timeInForce,
  limit_price: payload.limitPrice,
  client_order_id: payload.clientOrderId,
  position_intent: payload.assetClass === "option" ? payload.positionIntent : undefined
});

const emptyReport = (input: {
  generatedAt: string;
  environment: "paper" | "live";
  status: PaperReviewedExecutionStatus;
  reason: string | null;
  artifact?: PaperReviewArtifact | null;
  blocked?: PaperReviewedExecutionReport["blocked"];
  errors?: PaperReviewedExecutionReport["errors"];
  reviewedPayloads?: number;
}): PaperReviewedExecutionReport => ({
  paperOnly: true,
  environment: input.environment,
  generatedAt: input.generatedAt,
  mode: "reviewedConfirmPaper",
  status: input.status,
  reason: input.reason,
  artifactId: input.artifact?.id ?? null,
  payloadSignature: input.artifact?.payloadSignature ?? null,
  submitted: [],
  blocked: input.blocked ?? [],
  errors: input.errors ?? [],
  summary: {
    reviewedPayloads: input.reviewedPayloads ?? input.artifact?.payloadCount ?? 0,
    eligiblePayloads: 0,
    submitted: 0,
    blocked: input.blocked?.length ?? 0,
    errors: input.errors?.length ?? 0
  }
});

export const buildPaperReviewedPayloadExecutionReport = async (
  input: PaperReviewedExecutionInput = {},
  deps: PaperReviewedExecutionDeps = {}
): Promise<PaperReviewedExecutionReport> => {
  const generatedAt = deps.now?.() || new Date().toISOString();
  const state = getTradingSafetyState();
  const artifact = (deps.latestArtifact ?? latestPaperReviewArtifact)();

  if (input.confirmPaper !== true) {
    return emptyReport({
      generatedAt,
      environment: state.alpacaEnv,
      status: "blocked",
      reason: "PAPER_CONFIRMATION_REQUIRED",
      artifact,
      blocked: [{ reason: "PAPER_CONFIRMATION_REQUIRED" }]
    });
  }
  if (state.alpacaEnv !== "paper" || process.env.TRADING_MODE !== "paper") {
    return emptyReport({
      generatedAt,
      environment: state.alpacaEnv,
      status: "blocked",
      reason: "PAPER_RUNTIME_REQUIRED",
      artifact,
      blocked: [{ reason: "PAPER_RUNTIME_REQUIRED" }]
    });
  }
  if (
    state.liveTradingEnabled ||
    !parseFalse("ALPACA_LIVE_TRADE") ||
    !parseFalse("LIVE_TRADING_ENABLED")
  ) {
    return emptyReport({
      generatedAt,
      environment: state.alpacaEnv,
      status: "blocked",
      reason: "LIVE_TRADING_DISABLED_REQUIRED",
      artifact,
      blocked: [{ reason: "LIVE_TRADING_DISABLED_REQUIRED" }]
    });
  }
  if (!parseBoolean("PAPER_ORDER_EXECUTION_ENABLED")) {
    return emptyReport({
      generatedAt,
      environment: state.alpacaEnv,
      status: "blocked",
      reason: "PAPER_EXECUTION_FLAG_REQUIRED",
      artifact,
      blocked: [{ reason: "PAPER_EXECUTION_FLAG_REQUIRED" }]
    });
  }
  if (!artifact) {
    return emptyReport({
      generatedAt,
      environment: state.alpacaEnv,
      status: "blocked",
      reason: "NO_REVIEW_ARTIFACT",
      artifact
    });
  }
  if (!isPaperReviewArtifactFresh(artifact, generatedAt)) {
    return emptyReport({
      generatedAt,
      environment: state.alpacaEnv,
      status: "warning",
      reason: "REVIEW_STALE_OR_PAYLOAD_CHANGED",
      artifact
    });
  }
  if (
    input.expectedPayloadSignature &&
    input.expectedPayloadSignature !== artifact.payloadSignature
  ) {
    return emptyReport({
      generatedAt,
      environment: state.alpacaEnv,
      status: "warning",
      reason: "REVIEW_STALE_OR_PAYLOAD_CHANGED",
      artifact
    });
  }
  if (artifact.payloadCount <= 0) {
    return emptyReport({
      generatedAt,
      environment: state.alpacaEnv,
      status: "no_op",
      reason: "NO_ELIGIBLE_REVIEWED_PAYLOADS",
      artifact
    });
  }

  const sectionFilter = requestedSections(input.sections);
  const reviewedPayloadRows = sectionFilter
    ? allArtifactPayloads(artifact).filter(({ section }) => sectionFilter.has(section))
    : allArtifactPayloads(artifact);
  const normalized: NormalizedReviewedPayload[] = [];
  const blocked: PaperReviewedExecutionReport["blocked"] = [];
  for (const { section, row, index } of reviewedPayloadRows) {
    const result = normalizePayload(artifact, section, row, index);
    if ("blocked" in result) {
      blocked.push(result.blocked);
      continue;
    }
    if (result.assetClass === "option" && !parseBoolean("PAPER_OPTIONS_EXECUTION_ENABLED")) {
      blocked.push({
        section: result.section,
        symbol: result.symbol,
        clientOrderId: result.clientOrderId,
        reason: "PAPER_OPTIONS_EXECUTION_FLAG_REQUIRED",
        explanation: "Option paper execution requires PAPER_OPTIONS_EXECUTION_ENABLED=true."
      });
      continue;
    }
    if (
      result.assetClass === "option" &&
      result.positionIntent !== "buy_to_open" &&
      result.positionIntent !== "sell_to_close"
    ) {
      blocked.push({
        section: result.section,
        symbol: result.symbol,
        clientOrderId: result.clientOrderId,
        reason: "OPTION_POSITION_INTENT_INVALID",
        explanation: "Reviewed option payload must be buy_to_open or sell_to_close."
      });
      continue;
    }
    if (isLeapsSellToCloseExit(result) && !parseBoolean("AUTOMATED_PAPER_EXECUTION_ENABLED")) {
      blocked.push({
        section: result.section,
        symbol: result.symbol,
        clientOrderId: result.clientOrderId,
        reason: "AUTOMATED_PAPER_EXECUTION_FLAG_REQUIRED",
        explanation: "LEAPS sell-to-close execution requires AUTOMATED_PAPER_EXECUTION_ENABLED=true."
      });
      continue;
    }
    normalized.push(result);
  }

  if (!normalized.length) {
    return emptyReport({
      generatedAt,
      environment: state.alpacaEnv,
      status: blocked.length ? "blocked" : "no_op",
      reason: blocked[0]?.reason ?? "NO_ELIGIBLE_REVIEWED_PAYLOADS",
      artifact,
      blocked,
      reviewedPayloads: reviewedPayloadRows.length
    });
  }

  const account = await (deps.getAccount ?? getAccount)();
  if (account.data.status && account.data.status !== "ACTIVE") {
    return emptyReport({
      generatedAt,
      environment: state.alpacaEnv,
      status: "blocked",
      reason: "PAPER_ACCOUNT_NOT_ACTIVE",
      artifact,
      blocked: [{ reason: "PAPER_ACCOUNT_NOT_ACTIVE" }],
      reviewedPayloads: reviewedPayloadRows.length
    });
  }

  const submitted: PaperReviewedExecutionReport["submitted"] = [];
  const errors: PaperReviewedExecutionReport["errors"] = [];
  const submit = deps.submitPaperOrder ?? submitPaperOrder;

  for (const payload of normalized) {
    const existingExecution = findPaperExecutionByDedupeKey(payload.dedupeKey);
    if (
      existingExecution &&
      existingExecution.status !== "blocked" &&
      existingExecution.status !== "duplicate_blocked"
    ) {
      blocked.push({
        section: payload.section,
        symbol: payload.symbol,
        clientOrderId: payload.clientOrderId,
        reason: "DUPLICATE_PAPER_ORDER_BLOCKED",
        explanation: `A prior ${existingExecution.status} ledger row exists for this reviewed payload.`
      });
      continue;
    }

    const ledger = insertPaperExecutionLedgerEntry({
      mode: "reviewedConfirmPaper",
      assetClass: payload.assetClass,
      symbol: payload.symbol,
      side: payload.side,
      orderType: payload.type,
      timeInForce: payload.timeInForce,
      qty: payload.qty ?? null,
      notional: payload.notional ?? null,
      limitPrice: payload.limitPrice ?? null,
      dedupeKey: payload.dedupeKey,
      clientOrderId: payload.clientOrderId,
      status: "attempted",
      sourcePlanId: artifact.id,
      sourceCandidateId: payload.sourceCandidateId ?? null,
      payload: payload.raw,
      rawPayload: toAlpacaPayload(payload)
    });

    try {
      const response: AlpacaApiResponse<AlpacaSubmittedOrder> = await submit(toAlpacaPayload(payload));
      const order = response.data;
      const status = order.status || "submitted";
      const ledgerStatus = status === "accepted" ? "accepted" : status === "rejected" ? "rejected" : "submitted";
      updatePaperExecutionLedgerEntry(ledger.id, {
        status: ledgerStatus,
        alpacaOrderId: order.id,
        alpacaStatus: status,
        requestId: response.requestId,
        reason: null,
        rawResponse: order
      });
      submitted.push({
        section: payload.section,
        assetClass: payload.assetClass,
        symbol: payload.symbol,
        side: payload.side,
        type: payload.type,
        qty: payload.qty,
        notional: payload.notional,
        limitPrice: payload.limitPrice,
        clientOrderId: payload.clientOrderId,
        alpacaOrderId: order.id,
        status,
        requestId: response.requestId
      });
    } catch (error) {
      const requestId = error instanceof AlpacaApiError ? error.requestId : undefined;
      updatePaperExecutionLedgerEntry(ledger.id, {
        status: "failed",
        requestId,
        reason: "ALPACA_PAPER_ORDER_SUBMISSION_FAILED",
        errorMessage:
          error instanceof Error ? error.message : "Alpaca paper order submission failed.",
        rawResponse: error instanceof AlpacaApiError ? error.responseBody : undefined
      });
      blocked.push({
        section: payload.section,
        symbol: payload.symbol,
        clientOrderId: payload.clientOrderId,
        reason: "ALPACA_PAPER_ORDER_SUBMISSION_FAILED",
        explanation: error instanceof Error ? error.message : "Alpaca paper order submission failed."
      });
      errors.push({
        symbol: payload.symbol,
        reason: "ALPACA_PAPER_ORDER_SUBMISSION_FAILED",
        message: error instanceof Error ? error.message : "Alpaca paper order submission failed.",
        requestId
      });
    }
  }

  return {
    paperOnly: true,
    environment: state.alpacaEnv,
    generatedAt,
    mode: "reviewedConfirmPaper",
    status: submitted.length
      ? blocked.length || errors.length
        ? "partial"
        : "submitted"
      : blocked.length || errors.length
        ? "blocked"
        : "no_op",
    reason: errors[0]?.reason ?? blocked[0]?.reason ?? null,
    artifactId: artifact.id,
    payloadSignature: artifact.payloadSignature,
    submitted,
    blocked,
    errors,
    summary: {
      reviewedPayloads: reviewedPayloadRows.length,
      eligiblePayloads: normalized.length,
      submitted: submitted.length,
      blocked: blocked.length,
      errors: errors.length
    }
  };
};
