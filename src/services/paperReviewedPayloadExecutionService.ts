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
  listActivePaperNewRiskReservations,
  reserveReviewedPaperExecutions,
  type PaperExecutionLedgerEntry,
  updatePaperExecutionLedgerEntry
} from "./paperExecutionLedgerService.js";
import {
  findPaperReviewPayloadDecision,
  isReviewedPayloadSectionName,
  latestPaperReviewArtifact,
  verifyPaperReviewArtifact,
  type PaperReviewArtifact,
  type ReviewedPayloadSectionName
} from "./paperReviewArtifactService.js";
import { appendDecisionLifecycleEvent } from "./marketDecisionEvidenceService.js";
import {
  closePaperPositionFromFill,
  persistPaperPositionOutcome,
  reconcilePaperEntryFill
} from "./paperPositionLifecycleService.js";
import type { DecisionId, PositionLifecycleId } from "../types.js";
import { getTradingSafetyState } from "./tradingSafetyService.js";
import {
  capturePaperSubmitState,
  normalizePaperSubmitReservations,
  paperSubmitReservationFingerprint,
  validatePaperSubmitState,
  validatePaperSubmitReservationHeadroom,
  type PaperSubmitStateAttestation,
  type PaperSubmitStateValidation
} from "./paperSubmitStateService.js";

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
  payloadIndex: number;
  decisionId: DecisionId | null;
  positionLifecycleId: PositionLifecycleId | null;
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
  captureSubmitState?: typeof capturePaperSubmitState;
  now?: () => string;
}

const ENTRY_SECTIONS = new Set<ReviewedPayloadSectionName>([
  "equityBuys",
  "equityAdds",
  "optionBuys"
]);

const parseBoolean = (name: string) =>
  process.env[name] === "true" || process.env[name] === "1";

const parseFalse = (name: string) =>
  process.env[name] === "false" || process.env[name] === "0";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object");

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const numberField = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const isPaperSubmitStateAttestation = (
  value: unknown
): value is PaperSubmitStateAttestation =>
  isRecord(value) &&
  value.version === "paper-submit-state-v1" &&
  Array.isArray(value.payloadIntents) &&
  Array.isArray(value.positions) &&
  Array.isArray(value.openOrders) &&
  Array.isArray(value.reservations) &&
  Array.isArray(value.marketEvidence) &&
  isRecord(value.allocationAttestation) &&
  value.allocationAttestation.identity === "baseline-v1" &&
  value.allocationAttestation.allocatorControlled === false;

const isEntryPayload = (payload: NormalizedReviewedPayload) =>
  ENTRY_SECTIONS.has(payload.section);

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

  const reviewDecision = findPaperReviewPayloadDecision({
    artifactId: artifact.id,
    section,
    payloadIndex: index
  });

  return {
    section,
    payloadIndex: index,
    decisionId: reviewDecision?.decision_id ?? null,
    positionLifecycleId: reviewDecision?.position_lifecycle_id ?? null,
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
  const artifactVerification = verifyPaperReviewArtifact({
    artifact,
    asOf: generatedAt
  });
  if (!artifactVerification.valid) {
    const verificationBlockers = artifactVerification.blockers.map((reason) => ({
      reason
    }));
    return emptyReport({
      generatedAt,
      environment: state.alpacaEnv,
      status: "blocked",
      reason: artifactVerification.blockers[0] ?? "REVIEW_ARTIFACT_SIGNATURE_INVALID",
      artifact,
      blocked: verificationBlockers
    });
  }
  if (
    input.expectedPayloadSignature &&
    input.expectedPayloadSignature !== artifact.payloadSignature
  ) {
    return emptyReport({
      generatedAt,
      environment: state.alpacaEnv,
      status: "blocked",
      reason: "REVIEW_STALE_OR_PAYLOAD_CHANGED",
      artifact,
      blocked: [{ reason: "REVIEW_STALE_OR_PAYLOAD_CHANGED" }]
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
    if (
      isEntryPayload(result) &&
      (!(["success", "warning"] as string[]).includes(artifact.status) ||
        artifact.artifact.blockers.length > 0)
    ) {
      blocked.push({
        section: result.section,
        symbol: result.symbol,
        clientOrderId: result.clientOrderId,
        reason: "REVIEW_ARTIFACT_ENTRY_BLOCKED",
        explanation:
          artifact.artifact.blockers.join(", ") ||
          `Signed review artifact status is ${artifact.status}.`
      });
      continue;
    }
    if (
      isEntryPayload(result) &&
      (result.side !== "buy" || !result.sourceCandidateId || !result.decisionId)
    ) {
      blocked.push({
        section: result.section,
        symbol: result.symbol,
        clientOrderId: result.clientOrderId,
        reason: "REVIEW_ENTRY_SOURCE_IDENTITY_MISSING",
        explanation:
          "Reviewed new-risk payloads require exact candidate and decision linkage."
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

  let eligiblePayloads = normalized;
  let submitValidation: PaperSubmitStateValidation | null = null;
  let currentSubmitState: PaperSubmitStateAttestation | null = null;
  const entryPayloads = normalized.filter(isEntryPayload);
  if (entryPayloads.length) {
    const reviewedSubmitState = artifact.artifact.submitState;
    let stateBlockers: string[] = [];
    if (!isPaperSubmitStateAttestation(reviewedSubmitState)) {
      stateBlockers = [
        "REVIEW_SUBMIT_STATE_MISSING",
        "FRESH_REVIEW_REQUIRED"
      ];
    } else {
      try {
        const capture =
          deps.captureSubmitState ??
          ((captureInput: Parameters<typeof capturePaperSubmitState>[0]) =>
            capturePaperSubmitState(captureInput, {
              getAccount: deps.getAccount
            }));
        currentSubmitState = await capture({
          capturedAt: generatedAt,
          payloadSections: artifact.artifact.payloadSections
        });
        submitValidation = validatePaperSubmitState({
          reviewed: reviewedSubmitState,
          current: currentSubmitState,
          sections: [
            ...new Set(entryPayloads.map((payload) => payload.section))
          ]
        });
        stateBlockers = submitValidation.blockers;
      } catch {
        stateBlockers = [
          "SUBMIT_STATE_CAPTURE_FAILED",
          "FRESH_REVIEW_REQUIRED"
        ];
      }
    }
    if (stateBlockers.length) {
      const explanation = [...new Set(stateBlockers)].join(", ");
      for (const payload of entryPayloads) {
        blocked.push({
          section: payload.section,
          symbol: payload.symbol,
          clientOrderId: payload.clientOrderId,
          reason: "FRESH_REVIEW_REQUIRED",
          explanation
        });
      }
      eligiblePayloads = normalized.filter((payload) => !isEntryPayload(payload));
    }
  }

  if (!eligiblePayloads.length) {
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

  const reservedEntriesByClient = new Map<string, PaperExecutionLedgerEntry>();
  const entryPayloadsToReserve = eligiblePayloads.filter(isEntryPayload);
  if (entryPayloadsToReserve.length) {
    if (!currentSubmitState) {
      for (const payload of entryPayloadsToReserve) {
        blocked.push({
          section: payload.section,
          symbol: payload.symbol,
          clientOrderId: payload.clientOrderId,
          reason: "FRESH_REVIEW_REQUIRED",
          explanation: "SUBMIT_STATE_CAPTURE_FAILED"
        });
      }
      eligiblePayloads = eligiblePayloads.filter((payload) => !isEntryPayload(payload));
    } else {
      const expectedReservationFingerprint = paperSubmitReservationFingerprint(
        currentSubmitState.reservations
      );
      const reservation = reserveReviewedPaperExecutions({
        inputs: entryPayloadsToReserve.map((payload) => ({
          assetClass: payload.assetClass,
          symbol: payload.symbol,
          side: "buy" as const,
          orderType: payload.type,
          timeInForce: payload.timeInForce,
          qty: payload.qty ?? null,
          notional: payload.notional ?? null,
          limitPrice: payload.limitPrice ?? null,
          estimatedPremium: numberField(payload.raw.estimatedPremium),
          maxRisk: numberField(payload.raw.maxRisk),
          dedupeKey: payload.dedupeKey,
          clientOrderId: payload.clientOrderId,
          sourcePlanId: artifact.id,
          sourceCandidateId: payload.sourceCandidateId!,
          decisionId: payload.decisionId!,
          section: payload.section,
          payloadIndex: payload.payloadIndex,
          payload: {
            reviewedPayload: payload.raw,
            submitValidation
          },
          rawPayload: toAlpacaPayload(payload)
        })),
        validateBeforeInsert: () => {
          const currentReservations = normalizePaperSubmitReservations(
            listActivePaperNewRiskReservations()
          );
          if (
            paperSubmitReservationFingerprint(currentReservations) !==
            expectedReservationFingerprint
          ) {
            return [
              "SUBMIT_RESERVATION_STATE_DRIFT",
              "FRESH_REVIEW_REQUIRED"
            ];
          }
          const headroomBlockers = validatePaperSubmitReservationHeadroom({
            state: currentSubmitState!,
            sections: [
              ...new Set(entryPayloadsToReserve.map((payload) => payload.section))
            ],
            reservations: currentReservations
          });
          return headroomBlockers.length
            ? [...headroomBlockers, "FRESH_REVIEW_REQUIRED"]
            : [];
        }
      });
      if (!reservation.reserved) {
        const reason = reservation.blockers[0] ?? "SUBMIT_RESERVATION_FAILED";
        for (const payload of entryPayloadsToReserve) {
          blocked.push({
            section: payload.section,
            symbol: payload.symbol,
            clientOrderId: payload.clientOrderId,
            reason,
            explanation: reservation.blockers.join(", ")
          });
        }
        eligiblePayloads = eligiblePayloads.filter((payload) => !isEntryPayload(payload));
      } else {
        reservation.entries.forEach((entry) => {
          reservedEntriesByClient.set(entry.clientOrderId, entry);
        });
      }
    }
  }

  const submitted: PaperReviewedExecutionReport["submitted"] = [];
  const errors: PaperReviewedExecutionReport["errors"] = [];
  const submit = deps.submitPaperOrder ?? submitPaperOrder;

  for (const payload of eligiblePayloads) {
    const existingExecution = findPaperExecutionByDedupeKey(payload.dedupeKey);
    if (
      !isEntryPayload(payload) &&
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

    let ledger: PaperExecutionLedgerEntry;
    if (isEntryPayload(payload)) {
      const reservedEntry = reservedEntriesByClient.get(payload.clientOrderId);
      if (!reservedEntry) {
        blocked.push({
          section: payload.section,
          symbol: payload.symbol,
          clientOrderId: payload.clientOrderId,
          reason: "SUBMIT_RESERVATION_FAILED",
          explanation: "Atomic reviewed reservation was not available."
        });
        continue;
      }
      ledger = reservedEntry;
      updatePaperExecutionLedgerEntry(ledger.id, {
        status: "attempted",
        reason: null,
        blockedReason: null
      });
    } else {
      ledger = insertPaperExecutionLedgerEntry({
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
        decisionId: payload.decisionId,
        decisionLinkageStatus: payload.decisionId ? "EXACT" : "LEGACY_UNLINKED",
        payload: {
          artifactId: artifact.id,
          section: payload.section,
          payloadIndex: payload.payloadIndex,
          reviewedPayload: payload.raw
        },
        rawPayload: toAlpacaPayload(payload)
      });
    }

    if (payload.decisionId) {
      appendDecisionLifecycleEvent({
        decisionId: payload.decisionId,
        status: "PAPER_ELIGIBLE",
        reasonCodes: ["REVIEWED_PAYLOAD_ELIGIBLE"],
        sourceType: "paper_review_artifact",
        sourceId: `${artifact.id}:${payload.section}:${payload.payloadIndex}:eligible`,
        evidence: { artifactId: artifact.id, ledgerId: ledger.id }
      });
    }

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
      if (payload.decisionId) {
        appendDecisionLifecycleEvent({
          decisionId: payload.decisionId,
          status: status === "filled" ? "FILLED" : "SUBMITTED",
          reasonCodes: [
            status === "filled" ? "BROKER_CONFIRMED_FILL" : "BROKER_ORDER_ACCEPTED"
          ],
          sourceType: "paper_execution_ledger",
          sourceId: String(ledger.id),
          evidence: {
            alpacaOrderId: order.id,
            alpacaStatus: status,
            requestId: response.requestId ?? null
          }
        });
      }
      if (["filled", "partially_filled"].includes(status)) {
        try {
          const brokerOrderId = stringField(order.id);
          const filledQuantity = Number.parseFloat(order.filled_qty ?? "");
          const filledAveragePrice = Number.parseFloat(order.filled_avg_price ?? "");
          if (
            !brokerOrderId ||
            !Number.isFinite(filledQuantity) ||
            !Number.isFinite(filledAveragePrice)
          ) {
            throw new Error("BROKER_FILL_EVIDENCE_INCOMPLETE");
          }
          const observedAt = order.filled_at ?? generatedAt;
          if (
            payload.section === "equitySells" ||
            payload.section === "optionSellToCloseExits"
          ) {
            if (!payload.decisionId || !payload.positionLifecycleId) {
              throw new Error("BROKER_EXIT_LINEAGE_NOT_EXACT");
            }
            closePaperPositionFromFill({
              positionLifecycleId: payload.positionLifecycleId,
              exitDecisionId: payload.decisionId,
              brokerOrderId,
              status,
              filledQuantity,
              filledAveragePrice,
              observedAt,
              exitReasonCode:
                stringField(payload.raw.reason) ?? "BROKER_CONFIRMED_EXIT",
              brokerRequestId: response.requestId ?? null,
              underlyingPrice:
                typeof payload.raw.underlyingPrice === "number"
                  ? payload.raw.underlyingPrice
                  : null
            });
            persistPaperPositionOutcome({
              positionLifecycleId: payload.positionLifecycleId,
              exitReasonCode:
                stringField(payload.raw.reason) ?? "BROKER_CONFIRMED_EXIT"
            });
          } else {
            reconcilePaperEntryFill({
              ledgerId: ledger.id,
              brokerOrderId,
              clientOrderId: payload.clientOrderId,
              status,
              filledQuantity,
              filledAveragePrice,
              observedAt,
              brokerRequestId: response.requestId ?? null,
              underlyingPrice:
                typeof payload.raw.underlyingPrice === "number"
                  ? payload.raw.underlyingPrice
                  : null
            });
          }
        } catch (reconciliationError) {
          errors.push({
            symbol: payload.symbol,
            reason: "ANALYTICAL_RECONCILIATION_FAILED",
            message:
              reconciliationError instanceof Error
                ? reconciliationError.message
                : "Analytical fill reconciliation failed.",
            requestId: response.requestId
          });
        }
      }
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
      eligiblePayloads: eligiblePayloads.length,
      submitted: submitted.length,
      blocked: blocked.length,
      errors: errors.length
    }
  };
};
