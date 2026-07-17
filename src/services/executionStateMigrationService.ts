import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";

import { canonicalJsonHash } from "../lib/canonicalJson.js";
import type { DatabaseConfig } from "../lib/database/config.js";
import {
  withCheckedOutPostgresTransaction,
  withPostgresTransaction
} from "../lib/database/postgresTransaction.js";
import type {
  BrokerResultInput,
  ExecutionAccountProjection,
  ExecutionEvidenceInput,
  ExecutionReservationIntentInput
} from "../repositories/contracts/executionStateRepository.js";
import type { HedgeExecutionReview } from "./hedgeExecutionReviewService.js";
import type { PaperExecutionLedgerEntry } from "./paperExecutionLedgerService.js";
import type { PaperReviewArtifact } from "./paperReviewArtifactService.js";
import type { PaperSubmitStateAttestation } from "./paperSubmitStateService.js";
import type { ZeroDteSubmitAttestation } from "./zeroDte/zeroDteSubmitAttestationService.js";
import {
  asDecisionId,
  asPositionLifecycleId,
  isDecisionId
} from "./marketDecisionIdentityService.js";
import {
  mapHedgeReviewToExecutionEvidence,
  mapPaperExecutionLedgerToBrokerResult,
  mapPaperExecutionLedgerToReservationIntent,
  mapPaperReviewArtifactToExecutionEvidence,
  mapPaperSubmitStateToExecutionProjection,
  mapZeroDteAttestationToExecutionEvidence
} from "./executionStateProjectionService.js";
import {
  canonicalizePostgresNumeric,
  enableSqliteDefensiveModeIfSupported,
  inspectSqliteSnapshot
} from "./controlPlaneMigrationService.js";

const EXECUTION_STATE_MAPPING_VERSION = "release-4-v1";
const MIGRATION_LOCK_KEY = "alpaca:execution-state-backfill:v1";

type SqliteRow = Readonly<Record<string, unknown>>;
type TargetRow = Readonly<Record<string, unknown>>;

interface TargetPositionRow extends TargetRow {
  readonly id: string;
  readonly account_id: string;
  readonly candidate_id: string | null;
  readonly opening_order_id: string | null;
  readonly closing_order_id: string | null;
  readonly broker_position_key: string;
  readonly symbol: string;
  readonly underlying_symbol: string | null;
  readonly option_symbol: string | null;
  readonly asset_class: "equity" | "option";
  readonly side: "long" | "short";
  readonly status: "open" | "closing" | "closed";
  readonly quantity: string;
  readonly available_quantity: string | null;
  readonly average_entry_price: string | null;
  readonly current_price: string | null;
  readonly market_value: string | null;
  readonly cost_basis: string | null;
  readonly unrealized_pnl: string | null;
  readonly realized_pnl: string | null;
  readonly source_account_snapshot_id: string;
  readonly opened_at: string;
  readonly closed_at: string | null;
  readonly last_reconciled_at: string;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ExecutionStateSnapshotData {
  readonly snapshotSha256: string;
  readonly observedAt: string;
  readonly sourceCounts: Record<string, number>;
  readonly sourceIssues: readonly string[];
  readonly accountId: string | null;
  readonly rows: ReadonlyMap<string, readonly TargetRow[]>;
}

interface TableSpec {
  readonly table: string;
  readonly key: string;
  readonly columns: readonly string[];
  readonly jsonColumns?: readonly string[];
  readonly accountColumn?: string;
}

type NumericDefinition = Readonly<{ precision: number; scale: number }>;

const money = { precision: 28, scale: 8 } as const;
const quantity = { precision: 28, scale: 12 } as const;
const ratio = { precision: 12, scale: 10 } as const;

const numericColumnsByTable: Readonly<Record<string, Readonly<Record<string, NumericDefinition>>>> = {
  account_snapshots: {
    cash: money,
    portfolio_value: money,
    equity: money,
    buying_power: money,
    options_buying_power: money
  },
  risk_limits: {
    cash_reserve_amount: money,
    cash_reserve_ratio: ratio,
    max_deployment_amount: money,
    max_deployment_ratio: ratio,
    max_gross_exposure: money,
    max_net_exposure: money,
    max_open_order_exposure: money,
    max_position_notional: money,
    max_symbol_notional: money
  },
  strategy_allocations: {
    allocation_amount: money,
    allocation_ratio: ratio,
    reserved_amount: money,
    deployed_amount: money
  },
  portfolio_exposure: {
    gross_exposure: money,
    net_exposure: money,
    long_exposure: money,
    short_exposure: money,
    open_order_exposure: money,
    active_reservation_amount: money,
    deployed_amount: money,
    cash_reserve_amount: money,
    available_buying_power: money
  },
  buying_power_reservations: { amount: money },
  order_intents: {
    quantity,
    notional: money,
    limit_price: money,
    stop_price: money,
    estimated_premium: money,
    max_risk: money
  },
  orders: {
    quantity,
    notional: money,
    limit_price: money,
    stop_price: money,
    filled_quantity: quantity,
    filled_average_price: money
  },
  positions: {
    quantity,
    available_quantity: quantity,
    average_entry_price: money,
    current_price: money,
    market_value: money,
    cost_basis: money,
    unrealized_pnl: money,
    realized_pnl: money
  }
};

const tableSpecs: readonly TableSpec[] = [
  {
    table: "accounts",
    key: "id",
    columns: [
      "id", "broker", "broker_account_id", "environment", "status", "currency",
      "version", "created_at", "updated_at"
    ]
  },
  {
    table: "account_snapshots",
    key: "id",
    accountColumn: "account_id",
    jsonColumns: ["evidence"],
    columns: [
      "id", "account_id", "observed_at", "source", "request_id",
      "account_status", "currency", "cash", "portfolio_value", "equity",
      "buying_power", "options_buying_power", "options_approved_level",
      "trading_blocked", "account_blocked", "snapshot_fingerprint", "evidence",
      "created_at"
    ]
  },
  {
    table: "risk_limits",
    key: "id",
    accountColumn: "account_id",
    columns: [
      "id", "account_id", "scope_type", "scope_key", "status", "currency",
      "cash_reserve_amount", "cash_reserve_ratio", "max_deployment_amount",
      "max_deployment_ratio", "max_gross_exposure", "max_net_exposure",
      "max_open_order_exposure", "max_position_notional", "max_symbol_notional",
      "max_position_count", "max_order_count", "config_version",
      "config_fingerprint", "effective_from", "effective_to", "version",
      "created_at", "updated_at"
    ]
  },
  {
    table: "strategy_allocations",
    key: "id",
    accountColumn: "account_id",
    columns: [
      "id", "account_id", "strategy_key", "status", "currency",
      "allocation_amount", "allocation_ratio", "reserved_amount",
      "deployed_amount", "config_version", "config_fingerprint",
      "effective_from", "effective_to", "version", "created_at", "updated_at"
    ]
  },
  {
    table: "portfolio_exposure",
    key: "id",
    accountColumn: "account_id",
    jsonColumns: ["evidence"],
    columns: [
      "id", "account_id", "account_snapshot_id", "scope_type", "scope_key",
      "currency", "gross_exposure", "net_exposure", "long_exposure",
      "short_exposure", "open_order_exposure", "active_reservation_amount",
      "deployed_amount", "cash_reserve_amount", "available_buying_power",
      "position_count", "open_order_count", "exposure_fingerprint", "evidence",
      "observed_at", "created_at"
    ]
  },
  {
    table: "execution_reviews",
    key: "id",
    accountColumn: "account_id",
    jsonColumns: ["order_intent", "market_evidence", "portfolio_evidence", "warnings", "blockers"],
    columns: [
      "id", "account_id", "candidate_id", "review_type", "environment",
      "paper_only", "live_trading_enabled", "status", "client_order_id",
      "account_fingerprint", "source_recommendation_id", "source_snapshot_id",
      "configuration_fingerprint", "payload_fingerprint", "signature_algorithm",
      "signature", "order_intent", "market_evidence", "portfolio_evidence",
      "warnings", "blockers", "request_id", "correlation_id", "expires_at",
      "consumed_at", "version", "created_at", "updated_at"
    ]
  },
  {
    table: "confirmation_evidence",
    key: "id",
    accountColumn: "account_id",
    jsonColumns: ["evidence"],
    columns: [
      "id", "execution_review_id", "account_id", "candidate_id", "evidence_type",
      "confirmation_method", "status", "paper_only", "payload_fingerprint",
      "signature_algorithm", "signature", "evidence", "confirmed_at", "expires_at",
      "consumed_at", "revoked_at", "version", "created_at", "updated_at"
    ]
  },
  {
    table: "buying_power_reservations",
    key: "id",
    accountColumn: "account_id",
    columns: [
      "id", "account_id", "candidate_id", "strategy_key", "symbol", "asset_class",
      "currency", "amount", "status", "idempotency_key", "reservation_fingerprint",
      "account_snapshot_id", "scheduler_job_name", "scheduler_fencing_token",
      "expires_at", "committed_at", "released_at", "release_reason", "version",
      "created_at", "updated_at"
    ]
  },
  {
    table: "order_intents",
    key: "id",
    accountColumn: "account_id",
    jsonColumns: ["request_payload"],
    columns: [
      "id", "account_id", "candidate_id", "reservation_id", "execution_review_id",
      "confirmation_evidence_id", "environment", "client_order_id", "idempotency_key",
      "strategy_key", "symbol", "underlying_symbol", "asset_class", "side",
      "order_type", "time_in_force", "quantity", "notional", "limit_price",
      "stop_price", "estimated_premium", "max_risk", "status", "intent_fingerprint",
      "lifecycle_fingerprint", "request_payload", "request_id", "correlation_id",
      "ready_at", "submitted_at", "terminal_at", "version", "created_at", "updated_at"
    ]
  },
  {
    table: "orders",
    key: "id",
    accountColumn: "account_id",
    jsonColumns: ["raw_status"],
    columns: [
      "id", "account_id", "order_intent_id", "broker", "broker_order_id",
      "client_order_id", "parent_order_id", "replacement_order_id", "environment",
      "symbol", "asset_class", "side", "order_type", "time_in_force", "status",
      "quantity", "notional", "limit_price", "stop_price", "filled_quantity",
      "filled_average_price", "broker_request_id", "submitted_at", "accepted_at",
      "filled_at", "cancelled_at", "expired_at", "last_broker_update_at",
      "raw_status", "version", "created_at", "updated_at"
    ]
  },
  {
    table: "positions",
    key: "id",
    accountColumn: "account_id",
    columns: [
      "id", "account_id", "candidate_id", "opening_order_id", "closing_order_id",
      "broker_position_key", "symbol", "underlying_symbol", "option_symbol",
      "asset_class", "side", "status", "quantity", "available_quantity",
      "average_entry_price", "current_price", "market_value", "cost_basis",
      "unrealized_pnl", "realized_pnl", "source_account_snapshot_id", "opened_at",
      "closed_at", "last_reconciled_at", "version", "created_at", "updated_at"
    ]
  },
  {
    table: "broker_events",
    key: "event_id",
    accountColumn: "account_id",
    jsonColumns: ["response_payload"],
    columns: [
      "event_id", "account_id", "order_id", "order_intent_id", "broker",
      "broker_event_id", "broker_order_id", "client_order_id", "event_type",
      "event_status", "request_id", "http_status", "error_classification",
      "retryable", "response_payload", "response_fingerprint", "occurred_at",
      "received_at", "created_at"
    ]
  },
  {
    table: "lifecycle_fingerprints",
    key: "id",
    accountColumn: "account_id",
    jsonColumns: ["evidence"],
    columns: [
      "id", "account_id", "candidate_id", "order_intent_id", "entity_type",
      "entity_id", "lifecycle_stage", "fingerprint", "algorithm", "payload_version",
      "evidence", "request_id", "correlation_id", "captured_at", "created_at"
    ]
  }
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const parseJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  return JSON.parse(value) as unknown;
};

const stringValue = (value: unknown, code: string) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value;
};

const nullableString = (value: unknown) =>
  value === null || value === undefined ? null : String(value);

const timestamp = (value: unknown, code: string) => {
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new Error(code);
  return new Date(parsed).toISOString();
};

const numericValue = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("EXECUTION_SOURCE_NUMERIC_INVALID");
  return parsed;
};

const jsonString = (value: unknown) => JSON.stringify(value ?? null);

const hashFile = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });

const migrationDecisionIdentity = (
  row: SqliteRow,
  knownDecisionIds: ReadonlySet<string>,
  candidateIds: ReadonlySet<string>
) => {
  const rawDecisionId = nullableString(row.decision_id);
  if (!rawDecisionId) {
    return { decisionId: null, linkageStatus: "LEGACY_UNLINKED" as const };
  }
  if (isDecisionId(rawDecisionId)) {
    return {
      decisionId: asDecisionId(rawDecisionId),
      linkageStatus: (nullableString(row.decision_linkage_status) ??
        "EXACT") as PaperExecutionLedgerEntry["decisionLinkageStatus"]
    };
  }
  const candidateId = nullableString(row.source_candidate_id);
  if (
    knownDecisionIds.has(rawDecisionId) ||
    (candidateId && candidateIds.has(candidateId))
  ) {
    throw new Error("EXECUTION_LEDGER_DECISION_ID_INVALID");
  }
  return { decisionId: null, linkageStatus: "LEGACY_UNLINKED" as const };
};

const mapLedgerRow = (
  row: SqliteRow,
  knownDecisionIds: ReadonlySet<string>,
  candidateIds: ReadonlySet<string>
): PaperExecutionLedgerEntry => {
  const decision = migrationDecisionIdentity(row, knownDecisionIds, candidateIds);
  return {
    id: Number(row.id),
    createdAt: timestamp(row.created_at, "EXECUTION_LEDGER_CREATED_AT_INVALID"),
    updatedAt: timestamp(row.updated_at, "EXECUTION_LEDGER_UPDATED_AT_INVALID"),
    mode: stringValue(row.mode, "EXECUTION_LEDGER_MODE_REQUIRED"),
    assetClass: stringValue(row.asset_class, "EXECUTION_LEDGER_ASSET_CLASS_REQUIRED"),
    symbol: stringValue(row.symbol, "EXECUTION_LEDGER_SYMBOL_REQUIRED"),
    underlyingSymbol: nullableString(row.underlying_symbol),
    strategy: nullableString(row.strategy),
    side: nullableString(row.side),
    orderType: nullableString(row.order_type),
    timeInForce: nullableString(row.time_in_force),
    qty: nullableString(row.qty),
    notional: nullableString(row.notional),
    limitPrice: nullableString(row.limit_price),
    estimatedPremium: numericValue(row.estimated_premium),
    maxRisk: numericValue(row.max_risk),
    dedupeKey: stringValue(row.dedupe_key, "EXECUTION_LEDGER_DEDUPE_REQUIRED"),
    clientOrderId: stringValue(
      row.client_order_id,
      "EXECUTION_LEDGER_CLIENT_ORDER_REQUIRED"
    ),
    alpacaOrderId: nullableString(row.alpaca_order_id),
    alpacaStatus: nullableString(row.alpaca_status),
    requestId: nullableString(row.request_id),
    sourcePlanId: nullableString(row.source_plan_id),
    sourceCandidateId: nullableString(row.source_candidate_id),
    decisionId: decision.decisionId,
    positionLifecycleId:
      row.position_lifecycle_id === null || row.position_lifecycle_id === undefined
        ? null
        : asPositionLifecycleId(String(row.position_lifecycle_id)),
    decisionLinkageStatus: decision.linkageStatus,
    status: stringValue(
      row.status,
      "EXECUTION_LEDGER_STATUS_REQUIRED"
    ) as PaperExecutionLedgerEntry["status"],
    reason: nullableString(row.reason),
    blockedReason: nullableString(row.blocked_reason),
    errorMessage: nullableString(row.error_message),
    payloadJson: stringValue(
      row.payload_json,
      "EXECUTION_LEDGER_PAYLOAD_REQUIRED"
    ),
    rawPayloadJson: nullableString(row.raw_payload_json),
    rawResponseJson: nullableString(row.raw_response_json)
  };
};

const historicalAccountProjection = (state: PaperSubmitStateAttestation) => {
  const staleMarketEvidenceOnly =
    !state.complete &&
    state.blockers.length > 0 &&
    state.blockers.every((blocker) => blocker === "SUBMIT_MARKET_EVIDENCE_STALE");
  return mapPaperSubmitStateToExecutionProjection(
    staleMarketEvidenceOnly ? { ...state, complete: true, blockers: [] } : state
  );
};

const openReadOnlySnapshot = (path: string) => {
  const database = new DatabaseSync(path, { readOnly: true });
  enableSqliteDefensiveModeIfSupported(database);
  database.exec("PRAGMA query_only = ON; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;");
  return database;
};

const paperArtifact = (row: SqliteRow): PaperReviewArtifact | null => {
  const body = parseJson(row.artifact_json);
  if (!isRecord(body) || body.recordType !== "paper_review_artifact") return null;
  return {
    id: stringValue(row.id, "EXECUTION_ARTIFACT_ID_REQUIRED"),
    createdAt: timestamp(row.created_at, "EXECUTION_ARTIFACT_CREATED_AT_INVALID"),
    expiresAt: timestamp(row.expires_at, "EXECUTION_ARTIFACT_EXPIRES_AT_INVALID"),
    sourceAction: stringValue(row.source_action, "EXECUTION_ARTIFACT_SOURCE_REQUIRED"),
    status: stringValue(row.status, "EXECUTION_ARTIFACT_STATUS_REQUIRED"),
    payloadSignature: stringValue(row.payload_signature, "EXECUTION_ARTIFACT_SIGNATURE_REQUIRED"),
    payloadCount: Number(row.payload_count),
    artifact: body as unknown as PaperReviewArtifact["artifact"]
  };
};

const hedgeReview = (row: SqliteRow): HedgeExecutionReview | null => {
  const value = parseJson(row.review_json);
  if (!isRecord(value) || value.recordType !== "hedge_execution_review") return null;
  return value as unknown as HedgeExecutionReview;
};

const zeroDteAttestation = (ledger: PaperExecutionLedgerEntry) => {
  try {
    const payload = parseJson(ledger.payloadJson);
    if (!isRecord(payload)) return null;
    const value = payload.attestation;
    if (!isRecord(value) || value.recordType !== "zero_dte_submit_attestation") return null;
    return value as unknown as ZeroDteSubmitAttestation;
  } catch {
    return null;
  }
};

const brokerResultRequired = (ledger: PaperExecutionLedgerEntry) =>
  Boolean(
    ledger.alpacaOrderId || ledger.requestId || ledger.rawResponseJson ||
    ledger.errorMessage ||
    ["submitted", "accepted", "rejected", "failed", "filled", "partial", "canceled"]
      .includes(ledger.status)
  );

const intentStatus = (ledger: PaperExecutionLedgerEntry, activeReservation: boolean) => {
  if (activeReservation || ledger.status === "built") return "ready_for_submission";
  if (ledger.status === "attempted") return "submission_pending";
  if (["submitted", "accepted", "filled", "partial"].includes(ledger.status)) return "submitted";
  if (ledger.errorMessage && /timeout|timed out|connection reset|network/i.test(ledger.errorMessage)) {
    return "ambiguous";
  }
  if (["canceled", "expired", "released"].includes(ledger.status)) return "cancelled";
  return "failed";
};

const reservationStatus = (
  ledger: PaperExecutionLedgerEntry,
  expiresAt: string,
  observedAt: string
) => {
  if (["submitted", "accepted", "filled", "partial"].includes(ledger.status)) return "committed";
  if (["canceled"].includes(ledger.status)) return "cancelled";
  if (ledger.status === "expired" || Date.parse(expiresAt) <= Date.parse(observedAt)) return "expired";
  if (["reserved", "attempted", "built"].includes(ledger.status)) return "active";
  return "released";
};

const consumedStatus = (ledger: PaperExecutionLedgerEntry) =>
  ["attempted", "submitted", "accepted", "rejected", "failed", "filled", "partial", "canceled"]
    .includes(ledger.status);

const normalizeJsonColumn = (row: TargetRow, spec: TableSpec) => {
  const json = new Set(spec.jsonColumns ?? []);
  const numerics = numericColumnsByTable[spec.table] ?? {};
  return Object.fromEntries(spec.columns.map((column) => [
    column,
    json.has(column)
      ? jsonString(row[column])
      : numerics[column]
        ? canonicalizePostgresNumeric(
            (row[column] ?? null) as number | string | null,
            numerics[column]!.precision,
            numerics[column]!.scale
          )
        : row[column] ?? null
  ]));
};

const evidenceRows = (input: ExecutionEvidenceInput, ledger: PaperExecutionLedgerEntry) => {
  const consumed = consumedStatus(ledger);
  return {
    review: {
      id: input.review.id,
      account_id: input.accountId,
      candidate_id: input.candidateId,
      review_type: input.review.reviewType,
      environment: "paper",
      paper_only: true,
      live_trading_enabled: false,
      status: consumed ? "consumed" : input.review.status,
      client_order_id: input.review.clientOrderId,
      account_fingerprint: input.review.accountFingerprint,
      source_recommendation_id: input.review.sourceRecommendationId,
      source_snapshot_id: input.review.sourceSnapshotId,
      configuration_fingerprint: input.review.configurationFingerprint,
      payload_fingerprint: input.review.payloadFingerprint,
      signature_algorithm: input.review.signatureAlgorithm,
      signature: input.review.signature,
      order_intent: input.review.orderIntent,
      market_evidence: input.review.marketEvidence,
      portfolio_evidence: input.review.portfolioEvidence,
      warnings: input.review.warnings,
      blockers: input.review.blockers,
      request_id: input.review.requestId,
      correlation_id: input.review.correlationId,
      expires_at: input.review.expiresAt,
      consumed_at: consumed ? ledger.createdAt : null,
      version: 1,
      created_at: input.review.createdAt,
      updated_at: consumed ? ledger.createdAt : input.review.createdAt
    },
    confirmation: {
      id: input.confirmation.id,
      execution_review_id: input.review.id,
      account_id: input.accountId,
      candidate_id: input.candidateId,
      evidence_type: input.confirmation.evidenceType,
      confirmation_method: input.confirmation.confirmationMethod,
      status: consumed ? "consumed" : input.confirmation.status,
      paper_only: true,
      payload_fingerprint: input.confirmation.payloadFingerprint,
      signature_algorithm: input.confirmation.signatureAlgorithm,
      signature: input.confirmation.signature,
      evidence: input.confirmation.evidence,
      confirmed_at: input.confirmation.confirmedAt,
      expires_at: input.confirmation.expiresAt,
      consumed_at: consumed ? ledger.createdAt : null,
      revoked_at: null,
      version: 1,
      created_at: input.confirmation.confirmedAt,
      updated_at: consumed ? ledger.createdAt : input.confirmation.confirmedAt
    },
    fingerprint: {
      id: input.lifecycleFingerprint.id,
      account_id: input.accountId,
      candidate_id: input.candidateId,
      order_intent_id: null,
      entity_type: input.lifecycleFingerprint.entityType,
      entity_id: input.lifecycleFingerprint.entityId,
      lifecycle_stage: input.lifecycleFingerprint.lifecycleStage,
      fingerprint: input.lifecycleFingerprint.fingerprint,
      algorithm: "sha256",
      payload_version: input.lifecycleFingerprint.payloadVersion,
      evidence: input.lifecycleFingerprint.evidence,
      request_id: input.lifecycleFingerprint.requestId,
      correlation_id: input.lifecycleFingerprint.correlationId,
      captured_at: input.lifecycleFingerprint.capturedAt,
      created_at: input.lifecycleFingerprint.capturedAt
    }
  };
};

const reservationRow = (
  intent: ExecutionReservationIntentInput,
  ledger: PaperExecutionLedgerEntry,
  observedAt: string
) => {
  if (!intent.reservationRequired || !intent.reservationId) return null;
  const status = reservationStatus(ledger, intent.expiresAt, observedAt);
  const terminalAt = status === "active" ? null : ledger.updatedAt;
  return {
    id: intent.reservationId,
    account_id: intent.accountId,
    candidate_id: intent.candidateId,
    strategy_key: intent.strategyKey,
    symbol: intent.symbol,
    asset_class: intent.assetClass,
    currency: "USD",
    amount: intent.amount,
    status,
    idempotency_key: intent.idempotencyKey,
    reservation_fingerprint: intent.reservationFingerprint,
    account_snapshot_id: intent.accountSnapshotId,
    scheduler_job_name: null,
    scheduler_fencing_token: null,
    expires_at: intent.expiresAt,
    committed_at: status === "committed" ? ledger.updatedAt : null,
    released_at: ["released", "expired", "cancelled"].includes(status) ? terminalAt : null,
    release_reason: ["released", "expired", "cancelled"].includes(status)
      ? ledger.reason ?? ledger.blockedReason ?? `SOURCE_${status.toUpperCase()}`
      : null,
    version: 1,
    created_at: intent.createdAt,
    updated_at: ledger.updatedAt
  };
};

const intentRow = (
  intent: ExecutionReservationIntentInput,
  ledger: PaperExecutionLedgerEntry,
  evidenceIds: ReadonlySet<string>,
  activeReservation: boolean
) => {
  const status = intentStatus(ledger, activeReservation);
  const submitted = ["submitted", "ambiguous", "reconciled"].includes(status);
  const terminal = ["failed", "cancelled"].includes(status);
  return {
    id: intent.orderIntentId,
    account_id: intent.accountId,
    candidate_id: intent.candidateId,
    reservation_id: intent.reservationId,
    execution_review_id: intent.executionReviewId && evidenceIds.has(intent.executionReviewId)
      ? intent.executionReviewId
      : null,
    confirmation_evidence_id:
      intent.confirmationEvidenceId && evidenceIds.has(intent.confirmationEvidenceId)
        ? intent.confirmationEvidenceId
        : null,
    environment: "paper",
    client_order_id: intent.clientOrderId,
    idempotency_key: intent.idempotencyKey,
    strategy_key: intent.strategyKey,
    symbol: intent.symbol,
    underlying_symbol: intent.underlyingSymbol ?? null,
    asset_class: intent.assetClass,
    side: intent.side,
    order_type: intent.orderType,
    time_in_force: intent.timeInForce,
    quantity: intent.quantity,
    notional: intent.notional,
    limit_price: intent.limitPrice,
    stop_price: intent.stopPrice,
    estimated_premium: intent.estimatedPremium,
    max_risk: intent.maxRisk,
    status,
    intent_fingerprint: intent.intentFingerprint,
    lifecycle_fingerprint: intent.lifecycleFingerprint,
    request_payload: intent.requestPayload,
    request_id: intent.requestId,
    correlation_id: intent.correlationId,
    ready_at: intent.createdAt,
    submitted_at: submitted ? ledger.updatedAt : null,
    terminal_at: terminal ? ledger.updatedAt : null,
    version: 1,
    created_at: intent.createdAt,
    updated_at: ledger.updatedAt
  };
};

const brokerRows = (
  result: BrokerResultInput,
  ledger: PaperExecutionLedgerEntry,
  accountId: string
) => {
  const status = result.status.toLowerCase();
  const raw = (() => {
    try {
      return parseJson(ledger.rawResponseJson) ?? result.responsePayload;
    } catch {
      return result.responsePayload;
    }
  })();
  const filledAt = isRecord(raw) && raw.filled_at
    ? timestamp(raw.filled_at, "EXECUTION_BROKER_FILLED_AT_INVALID")
    : null;
  return {
    order: {
      id: result.orderId,
      account_id: accountId,
      order_intent_id: result.orderIntentId,
      broker: "alpaca",
      broker_order_id: result.brokerOrderId,
      client_order_id: result.clientOrderId,
      parent_order_id: null,
      replacement_order_id: null,
      environment: "paper",
      symbol: result.symbol,
      asset_class: result.assetClass,
      side: result.side,
      order_type: result.orderType,
      time_in_force: result.timeInForce,
      status: result.status,
      quantity: result.quantity,
      notional: result.notional,
      limit_price: result.limitPrice,
      stop_price: result.stopPrice,
      filled_quantity: result.filledQuantity,
      filled_average_price: result.filledAveragePrice,
      broker_request_id: result.requestId,
      submitted_at: ledger.updatedAt,
      accepted_at: ["accepted", "filled", "partially_filled"].includes(status)
        ? ledger.updatedAt
        : null,
      filled_at: status === "filled" ? filledAt ?? ledger.updatedAt : null,
      cancelled_at: ["cancelled", "canceled"].includes(status) ? ledger.updatedAt : null,
      expired_at: status === "expired" ? ledger.updatedAt : null,
      last_broker_update_at: ledger.updatedAt,
      raw_status: result.responsePayload,
      version: 1,
      created_at: ledger.createdAt,
      updated_at: ledger.updatedAt
    },
    event: {
      event_id: result.eventId,
      account_id: accountId,
      order_id: result.orderId,
      order_intent_id: result.orderIntentId,
      broker: "alpaca",
      broker_event_id: null,
      broker_order_id: result.brokerOrderId,
      client_order_id: result.clientOrderId,
      event_type: "order_response",
      event_status: result.status,
      request_id: result.requestId,
      http_status: result.httpStatus,
      error_classification: result.errorClassification,
      retryable: result.retryable,
      response_payload: result.responsePayload,
      response_fingerprint: result.responseFingerprint,
      occurred_at: result.occurredAt,
      received_at: result.receivedAt,
      created_at: result.receivedAt
    }
  };
};

const accountRows = (
  projections: readonly ExecutionAccountProjection[],
  latest: ExecutionAccountProjection
) => {
  const first = projections[0]!;
  return {
    account: {
      id: latest.accountId,
      broker: "alpaca",
      broker_account_id: latest.brokerAccountId,
      environment: "paper",
      status: latest.accountStatus,
      currency: latest.currency,
      version: 1,
      created_at: first.observedAt,
      updated_at: latest.observedAt
    },
    snapshots: projections.map((projection) => ({
      id: projection.accountSnapshotId,
      account_id: projection.accountId,
      observed_at: projection.observedAt,
      source: "alpaca",
      request_id: null,
      account_status: projection.accountStatus,
      currency: projection.currency,
      cash: projection.cash,
      portfolio_value: projection.portfolioValue,
      equity: projection.equity,
      buying_power: projection.buyingPower,
      options_buying_power: projection.optionsBuyingPower,
      options_approved_level: projection.optionsApprovedLevel,
      trading_blocked: projection.tradingBlocked,
      account_blocked: projection.accountBlocked,
      snapshot_fingerprint: projection.snapshotFingerprint,
      evidence: projection.evidence,
      created_at: projection.observedAt
    })),
    riskLimit: {
      id: latest.riskLimit.id,
      account_id: latest.accountId,
      scope_type: "portfolio",
      scope_key: "portfolio",
      status: "active",
      currency: latest.currency,
      cash_reserve_amount: latest.riskLimit.cashReserveAmount,
      cash_reserve_ratio: latest.riskLimit.cashReserveRatio,
      max_deployment_amount: latest.riskLimit.maxDeploymentAmount,
      max_deployment_ratio: latest.riskLimit.maxDeploymentRatio,
      max_gross_exposure: latest.riskLimit.maxGrossExposure,
      max_net_exposure: latest.riskLimit.maxNetExposure,
      max_open_order_exposure: latest.riskLimit.maxOpenOrderExposure,
      max_position_notional: latest.riskLimit.maxPositionNotional,
      max_symbol_notional: latest.riskLimit.maxSymbolNotional,
      max_position_count: latest.riskLimit.maxPositionCount,
      max_order_count: latest.riskLimit.maxOrderCount,
      config_version: latest.riskLimit.configVersion,
      config_fingerprint: latest.riskLimit.configFingerprint,
      effective_from: latest.observedAt,
      effective_to: null,
      version: 1,
      created_at: latest.observedAt,
      updated_at: latest.observedAt
    },
    allocation: {
      id: latest.strategyAllocation.id,
      account_id: latest.accountId,
      strategy_key: latest.strategyAllocation.strategyKey,
      status: "active",
      currency: latest.currency,
      allocation_amount: latest.strategyAllocation.allocationAmount,
      allocation_ratio: latest.strategyAllocation.allocationRatio,
      reserved_amount: latest.exposure.activeReservationAmount,
      deployed_amount: latest.exposure.deployedAmount,
      config_version: latest.strategyAllocation.configVersion,
      config_fingerprint: latest.strategyAllocation.configFingerprint,
      effective_from: latest.observedAt,
      effective_to: null,
      version: 1,
      created_at: latest.observedAt,
      updated_at: latest.observedAt
    },
    exposures: projections.map((projection) => ({
      id: projection.exposure.id,
      account_id: projection.accountId,
      account_snapshot_id: projection.accountSnapshotId,
      scope_type: "portfolio",
      scope_key: "portfolio",
      currency: projection.currency,
      gross_exposure: projection.exposure.grossExposure,
      net_exposure: projection.exposure.netExposure,
      long_exposure: projection.exposure.longExposure,
      short_exposure: projection.exposure.shortExposure,
      open_order_exposure: projection.exposure.openOrderExposure,
      active_reservation_amount: projection.exposure.activeReservationAmount,
      deployed_amount: projection.exposure.deployedAmount,
      cash_reserve_amount: projection.exposure.cashReserveAmount,
      available_buying_power: projection.exposure.availableBuyingPower,
      position_count: projection.exposure.positionCount,
      open_order_count: projection.exposure.openOrderCount,
      exposure_fingerprint: projection.exposure.fingerprint,
      evidence: projection.exposure.evidence,
      observed_at: projection.observedAt,
      created_at: projection.observedAt
    }))
  };
};

const projectedPositions = (
  latest: ExecutionAccountProjection,
  sourceRows: readonly SqliteRow[],
  decisionCandidates: ReadonlyMap<string, string | null>,
  orderIdByClient: ReadonlyMap<string, string>
) => {
  const rows = new Map<string, TargetPositionRow>();
  for (const position of latest.positions) {
    rows.set(position.brokerPositionKey, {
      id: position.id,
      account_id: latest.accountId,
      candidate_id: position.candidateId,
      opening_order_id: position.openingOrderId,
      closing_order_id: position.closingOrderId,
      broker_position_key: position.brokerPositionKey,
      symbol: position.symbol,
      underlying_symbol: position.underlyingSymbol,
      option_symbol: position.optionSymbol,
      asset_class: position.assetClass,
      side: position.side,
      status: "open",
      quantity: position.quantity,
      available_quantity: position.availableQuantity,
      average_entry_price: position.averageEntryPrice,
      current_price: position.currentPrice,
      market_value: position.marketValue,
      cost_basis: position.costBasis,
      unrealized_pnl: position.unrealizedPnl,
      realized_pnl: position.realizedPnl,
      source_account_snapshot_id: latest.accountSnapshotId,
      opened_at: position.openedAt,
      closed_at: null,
      last_reconciled_at: latest.observedAt,
      version: 1,
      created_at: position.openedAt,
      updated_at: latest.observedAt
    });
  }
  for (const source of sourceRows) {
    const assetClass = String(source.asset_class).toLowerCase().includes("option")
      ? "option" as const
      : "equity" as const;
    const brokerSymbol = assetClass === "option"
      ? nullableString(source.option_symbol) ?? stringValue(source.symbol, "EXECUTION_POSITION_SYMBOL_REQUIRED")
      : stringValue(source.symbol, "EXECUTION_POSITION_SYMBOL_REQUIRED");
    const key = `${assetClass}:${brokerSymbol}`;
    const existing = rows.get(key);
    const localStatus = String(source.status ?? "").toLowerCase();
    const status = localStatus === "open"
      ? "open" as const
      : localStatus === "closing"
        ? "closing" as const
        : "closed" as const;
    const openedAt = timestamp(source.opened_at, "EXECUTION_POSITION_OPENED_AT_INVALID");
    const updatedAt = timestamp(source.updated_at, "EXECUTION_POSITION_UPDATED_AT_INVALID");
    const closedAt = status === "closed"
      ? timestamp(source.closed_at ?? source.updated_at, "EXECUTION_POSITION_CLOSED_AT_INVALID")
      : null;
    const candidateId = decisionCandidates.get(String(source.entry_decision_id)) ?? null;
    const openingOrderId = orderIdByClient.get(String(source.entry_client_order_id)) ?? null;
    if (existing) {
      rows.set(key, {
        ...existing,
        candidate_id: candidateId ?? existing.candidate_id,
        opening_order_id: openingOrderId ?? existing.opening_order_id,
        average_entry_price: existing.average_entry_price ??
          (numericValue(source.entry_price) === null
            ? null
            : String(numericValue(source.entry_price))),
        opened_at: openedAt,
        created_at: openedAt
      });
      continue;
    }
    const quantity = status === "closed" ? "0.000000000000" :
      String(numericValue(source.entry_quantity) ?? 0);
    rows.set(key, {
      id: `position_${canonicalJsonHash({ accountId: latest.accountId, brokerPositionKey: key })}`,
      account_id: latest.accountId,
      candidate_id: candidateId,
      opening_order_id: openingOrderId,
      closing_order_id: null,
      broker_position_key: key,
      symbol: stringValue(source.symbol, "EXECUTION_POSITION_SYMBOL_REQUIRED"),
      underlying_symbol: assetClass === "option" ? String(source.symbol) : null,
      option_symbol: assetClass === "option" ? brokerSymbol : null,
      asset_class: assetClass,
      side: String(source.side).toLowerCase() === "short" ? "short" : "long",
      status,
      quantity,
      available_quantity: status === "closed" ? "0.000000000000" : quantity,
      average_entry_price: numericValue(source.entry_price) === null
        ? null
        : String(numericValue(source.entry_price)),
      current_price: null,
      market_value: null,
      cost_basis: null,
      unrealized_pnl: null,
      realized_pnl: null,
      source_account_snapshot_id: latest.accountSnapshotId,
      opened_at: openedAt,
      closed_at: closedAt,
      last_reconciled_at: latest.observedAt,
      version: 1,
      created_at: openedAt,
      updated_at: updatedAt
    });
  }
  return [...rows.values()].sort((left, right) => left.id.localeCompare(right.id));
};

export const readExecutionStateSnapshot = async (
  snapshotPath: string
): Promise<ExecutionStateSnapshotData> => {
  const inspection = await inspectSqliteSnapshot(snapshotPath);
  if (inspection.integrityCheck.length !== 1 || inspection.integrityCheck[0]?.toLowerCase() !== "ok") {
    throw new Error("SQLITE_SNAPSHOT_INTEGRITY_CHECK_FAILED");
  }
  if (inspection.foreignKeyViolationCount > 0) {
    throw new Error("SQLITE_SNAPSHOT_FOREIGN_KEY_CHECK_FAILED");
  }
  const requiredTables = [
    "paper_review_artifacts", "hedge_execution_reviews", "paper_execution_ledger",
    "paper_positions", "decision_snapshots", "paper_trade_candidates"
  ];
  for (const table of requiredTables) {
    if (!(table in inspection.tableCounts)) {
      throw new Error(`SQLITE_SNAPSHOT_TABLE_REQUIRED:${table}`);
    }
  }

  const database = openReadOnlySnapshot(snapshotPath);
  try {
    const artifactRows = database.prepare(
      "SELECT * FROM paper_review_artifacts ORDER BY created_at, id"
    ).all() as SqliteRow[];
    const hedgeRows = database.prepare(
      "SELECT * FROM hedge_execution_reviews ORDER BY created_at, review_id"
    ).all() as SqliteRow[];
    const ledgerRows = database.prepare(
      "SELECT * FROM paper_execution_ledger ORDER BY created_at, id"
    ).all() as SqliteRow[];
    const positionRows = database.prepare(
      "SELECT * FROM paper_positions ORDER BY updated_at, position_lifecycle_id"
    ).all() as SqliteRow[];
    const decisionRows = database.prepare(
      "SELECT decision_id, candidate_id FROM decision_snapshots ORDER BY decision_id"
    ).all() as SqliteRow[];
    const candidateRows = database.prepare(
      "SELECT id FROM paper_trade_candidates ORDER BY id"
    ).all() as SqliteRow[];
    const sourceIssues: string[] = [];

    const artifacts: PaperReviewArtifact[] = [];
    for (const row of artifactRows) {
      try {
        const value = paperArtifact(row);
        if (value) artifacts.push(value);
      } catch {
        sourceIssues.push("EXECUTION_ARTIFACT_MAPPING_INVALID");
      }
    }
    const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
    const hedges: HedgeExecutionReview[] = [];
    for (const row of hedgeRows) {
      try {
        const value = hedgeReview(row);
        if (value) hedges.push(value);
      } catch {
        sourceIssues.push("EXECUTION_HEDGE_REVIEW_MAPPING_INVALID");
      }
    }
    const hedgeById = new Map(hedges.map((review) => [review.reviewId, review]));
    const candidateIds = new Set(candidateRows.map((row) => String(row.id)));
    const knownDecisionIds = new Set(decisionRows.map((row) => String(row.decision_id)));
    const ledgers: PaperExecutionLedgerEntry[] = [];
    for (const row of ledgerRows) {
      try {
        ledgers.push(mapLedgerRow(row, knownDecisionIds, candidateIds));
      } catch {
        sourceIssues.push("EXECUTION_LEDGER_MAPPING_INVALID");
      }
    }

    const projectionByFingerprint = new Map<string, ExecutionAccountProjection>();
    for (const artifact of artifacts) {
      const submitState = artifact.artifact.submitState;
      if (!submitState) continue;
      try {
        const projection = historicalAccountProjection(
          submitState as PaperSubmitStateAttestation
        );
        const key = `${projection.accountId}:${projection.snapshotFingerprint}`;
        const prior = projectionByFingerprint.get(key);
        if (!prior || prior.observedAt < projection.observedAt) {
          projectionByFingerprint.set(key, projection);
        }
      } catch {
        sourceIssues.push("EXECUTION_ACCOUNT_PROJECTION_INVALID");
      }
    }
    const projections = [...projectionByFingerprint.values()]
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt));
    const accountIds = new Set(projections.map((projection) => projection.accountId));
    if (accountIds.size > 1) sourceIssues.push("EXECUTION_MULTIPLE_ACCOUNT_IDENTITIES");
    if (!projections.length && (ledgers.length || positionRows.length)) {
      sourceIssues.push("EXECUTION_ACCOUNT_SOURCE_MISSING");
    }
    const latest = projections.at(-1) ?? null;
    const rows = new Map<string, TargetRow[]>(tableSpecs.map((spec) => [spec.table, []]));
    if (latest) {
      const account = accountRows(projections, latest);
      rows.get("accounts")!.push(account.account);
      rows.get("account_snapshots")!.push(...account.snapshots);
      rows.get("risk_limits")!.push(account.riskLimit);
      rows.get("strategy_allocations")!.push(account.allocation);
      rows.get("portfolio_exposure")!.push(...account.exposures);

      const evidenceReviewIds = new Set<string>();
      const evidenceConfirmationIds = new Set<string>();
      const evidenceFingerprints: TargetRow[] = [];
      const intents: Array<{ ledger: PaperExecutionLedgerEntry; intent: ExecutionReservationIntentInput }> = [];
      const brokerResults: Array<{ ledger: PaperExecutionLedgerEntry; result: BrokerResultInput }> = [];
      const accountReference = {
        accountId: latest.accountId,
        accountSnapshotId: latest.accountSnapshotId,
        strategyKey: latest.strategyAllocation.strategyKey
      };

      for (const ledger of ledgers) {
        let intent: ExecutionReservationIntentInput;
        try {
          intent = mapPaperExecutionLedgerToReservationIntent(ledger, accountReference);
        } catch {
          sourceIssues.push("EXECUTION_INTENT_MAPPING_INVALID");
          continue;
        }
        let evidence: ExecutionEvidenceInput | null = null;
        const artifact = ledger.sourcePlanId ? artifactById.get(ledger.sourcePlanId) : null;
        const hedge = ledger.sourcePlanId ? hedgeById.get(ledger.sourcePlanId) : null;
        const attestation = zeroDteAttestation(ledger);
        try {
          if (artifact) {
            evidence = mapPaperReviewArtifactToExecutionEvidence(artifact, ledger, latest.accountId);
          } else if (hedge) {
            evidence = mapHedgeReviewToExecutionEvidence(hedge, ledger, latest.accountId);
          } else if (attestation) {
            evidence = mapZeroDteAttestationToExecutionEvidence(attestation, ledger, latest.accountId);
          }
        } catch {
          sourceIssues.push("EXECUTION_EVIDENCE_MAPPING_INVALID");
        }
        if (evidence) {
          const mapped = evidenceRows(evidence, ledger);
          rows.get("execution_reviews")!.push(mapped.review);
          rows.get("confirmation_evidence")!.push(mapped.confirmation);
          evidenceFingerprints.push(mapped.fingerprint);
          evidenceReviewIds.add(evidence.review.id);
          evidenceConfirmationIds.add(evidence.confirmation.id);
        }
        intents.push({ ledger, intent });
        if (brokerResultRequired(ledger)) {
          try {
            brokerResults.push({
              ledger,
              result: mapPaperExecutionLedgerToBrokerResult(ledger, latest.accountId)
            });
          } catch {
            sourceIssues.push("EXECUTION_BROKER_RESULT_MAPPING_INVALID");
          }
        }
      }

      const canonicalIntents = new Map<
        string,
        { ledger: PaperExecutionLedgerEntry; intent: ExecutionReservationIntentInput }
      >();
      const logicalIntentIdentity = (intent: ExecutionReservationIntentInput) =>
        canonicalJsonHash({
          strategyKey: intent.strategyKey,
          symbol: intent.symbol,
          underlyingSymbol: intent.underlyingSymbol,
          assetClass: intent.assetClass,
          sideClass: intent.side === "buy" || intent.side === "buy_to_open" ? "entry" : "exit"
        });
      for (const entry of intents) {
        const key = `${entry.intent.accountId}:${entry.intent.idempotencyKey}`;
        const prior = canonicalIntents.get(key);
        if (prior && logicalIntentIdentity(prior.intent) !== logicalIntentIdentity(entry.intent)) {
          sourceIssues.push("EXECUTION_SOURCE_DUPLICATE_CONFLICT:order_intents");
        }
        if (!prior || prior.ledger.updatedAt < entry.ledger.updatedAt) {
          canonicalIntents.set(key, entry);
        } else if (
          prior.ledger.updatedAt === entry.ledger.updatedAt &&
          canonicalJsonHash(prior.intent) !== canonicalJsonHash(entry.intent)
        ) {
          sourceIssues.push("EXECUTION_SOURCE_DUPLICATE_CONFLICT:order_intents");
        }
      }
      const canonicalIntentIdBySourceId = new Map<string, string>();
      for (const entry of intents) {
        const key = `${entry.intent.accountId}:${entry.intent.idempotencyKey}`;
        canonicalIntentIdBySourceId.set(
          entry.intent.orderIntentId,
          canonicalIntents.get(key)!.intent.orderIntentId
        );
      }

      for (const { ledger, intent } of canonicalIntents.values()) {
        const mappedReservation = reservationRow(intent, ledger, latest.observedAt);
        if (mappedReservation) {
          rows.get("buying_power_reservations")!.push(mappedReservation);
        }
        const reservation = rows.get("buying_power_reservations")!
          .find((row) => row.id === intent.reservationId);
        const linkedEvidence = new Set([
          ...evidenceReviewIds,
          ...evidenceConfirmationIds
        ]);
        rows.get("order_intents")!.push(intentRow(
          intent,
          ledger,
          linkedEvidence,
          reservation?.status === "active"
        ));
        rows.get("lifecycle_fingerprints")!.push({
          id: `${intent.orderIntentId}:ready`,
          account_id: latest.accountId,
          candidate_id: intent.candidateId,
          order_intent_id: intent.orderIntentId,
          entity_type: "order_intent",
          entity_id: intent.orderIntentId,
          lifecycle_stage: "ready_for_submission",
          fingerprint: intent.lifecycleFingerprint,
          algorithm: "sha256",
          payload_version: 1,
          evidence: { intentFingerprint: intent.intentFingerprint },
          request_id: intent.requestId,
          correlation_id: intent.correlationId,
          captured_at: intent.createdAt,
          created_at: intent.createdAt
        });
      }
      rows.get("lifecycle_fingerprints")!.push(...evidenceFingerprints);

      const orderIdByClient = new Map<string, string>();
      const latestOrders = new Map<string, TargetRow>();
      for (const { ledger, result } of brokerResults) {
        const mapped = brokerRows({
          ...result,
          orderIntentId: canonicalIntentIdBySourceId.get(result.orderIntentId) ??
            result.orderIntentId
        }, ledger, latest.accountId);
        const prior = latestOrders.get(mapped.order.id);
        const priorUpdatedAt = String(prior?.updated_at ?? "");
        if (!prior || priorUpdatedAt < mapped.order.updated_at) {
          latestOrders.set(mapped.order.id, mapped.order);
        } else if (
          priorUpdatedAt === mapped.order.updated_at &&
          canonicalJsonHash(prior) !== canonicalJsonHash(mapped.order)
        ) {
          sourceIssues.push("EXECUTION_SOURCE_DUPLICATE_CONFLICT:orders");
        }
        rows.get("broker_events")!.push(mapped.event);
        orderIdByClient.set(result.clientOrderId, result.orderId);
      }
      rows.get("orders")!.push(...latestOrders.values());
      const decisionCandidates = new Map(decisionRows.map((row) => [
        String(row.decision_id),
        candidateIds.has(String(row.candidate_id)) ? String(row.candidate_id) : null
      ]));
      rows.get("positions")!.push(...projectedPositions(
        latest,
        positionRows,
        decisionCandidates,
        orderIdByClient
      ));
    }

    for (const spec of tableSpecs) {
      const uniqueRows = new Map<string, TargetRow>();
      for (const row of rows.get(spec.table) ?? []) {
        const candidateId = "candidate_id" in row && row.candidate_id !== null &&
          !candidateIds.has(String(row.candidate_id))
          ? null
          : row.candidate_id;
        const target = "candidate_id" in row ? { ...row, candidate_id: candidateId } : row;
        const key = String(target[spec.key]);
        const prior = uniqueRows.get(key);
        if (prior && canonicalJsonHash(prior) !== canonicalJsonHash(target)) {
          sourceIssues.push(`EXECUTION_SOURCE_DUPLICATE_CONFLICT:${spec.table}`);
        } else {
          uniqueRows.set(key, normalizeJsonColumn(target, spec));
        }
      }
      rows.set(spec.table, [...uniqueRows.values()].sort((left, right) =>
        String(left[spec.key]).localeCompare(String(right[spec.key]))
      ));
    }

    const finalInspection = await inspectSqliteSnapshot(snapshotPath);
    if (finalInspection.sha256 !== inspection.sha256) {
      throw new Error("SQLITE_SNAPSHOT_CHANGED_DURING_READ");
    }
    return {
      snapshotSha256: inspection.sha256,
      observedAt: latest?.observedAt ?? new Date(0).toISOString(),
      sourceCounts: {
        paperReviewArtifacts: artifactRows.length,
        hedgeExecutionReviews: hedgeRows.length,
        paperExecutionLedger: ledgerRows.length,
        paperPositions: positionRows.length,
        accountProjections: projections.length
      },
      sourceIssues: sourceIssues.sort(),
      accountId: latest?.accountId ?? null,
      rows
    };
  } finally {
    database.close();
  }
};

const parameter = (spec: TableSpec, column: string, index: number) =>
  `${`$${index}`}${spec.jsonColumns?.includes(column) ? "::jsonb" : ""}`;

const rowValues = (spec: TableSpec, row: TargetRow) =>
  spec.columns.map((column) => row[column] ?? null);

const insertTargetRow = async (
  client: PoolClient,
  spec: TableSpec,
  row: TargetRow
) => {
  const values = rowValues(spec, row);
  const write = await client.query(
    `INSERT INTO ${spec.table}(${spec.columns.join(", ")})
     VALUES (${spec.columns.map((column, index) => parameter(spec, column, index + 1)).join(", ")})
     ON CONFLICT (${spec.key}) DO NOTHING`,
    values
  );
  if ((write.rowCount ?? 0) === 1) return 1;
  const replay = await client.query<{ matches: boolean }>(
    `SELECT (${spec.columns.map((column, index) =>
      `${column} IS NOT DISTINCT FROM ${parameter(spec, column, index + 1)}`
    ).join(" AND ")}) AS matches
     FROM ${spec.table}
     WHERE ${spec.key} = $${spec.columns.length + 1}`,
    [...values, row[spec.key]]
  );
  if (replay.rows[0]?.matches !== true) {
    throw new Error(`EXECUTION_STATE_BACKFILL_CONFLICT:${spec.table}`);
  }
  return 0;
};

const parseRecord = (value: unknown): Record<string, unknown> | null => {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const batchCheckpointId = (input: {
  snapshotSha256: string;
  table: string;
  offset: number;
  rowCount: number;
}) => `execution-backfill-${createHash("sha256")
  .update([
    input.snapshotSha256,
    EXECUTION_STATE_MAPPING_VERSION,
    input.table,
    String(input.offset),
    String(input.rowCount)
  ].join(":"))
  .digest("hex")}`;

const writeBatchCheckpoint = async (input: {
  client: PoolClient;
  snapshotSha256: string;
  table: string;
  offset: number;
  rowCount: number;
  tableRowCount: number;
  observedAt: string;
}) => {
  const id = batchCheckpointId(input);
  const cursor = {
    postgresMigrationVersion: 2,
    mappingVersion: EXECUTION_STATE_MAPPING_VERSION,
    table: input.table,
    offset: input.offset,
    rowCount: input.rowCount
  };
  const existing = await input.client.query<{
    status: string;
    source_checksum: string | null;
    source_row_count: number | string | null;
    target_row_count: number | string | null;
    discrepancy_count: number | string;
    cursor_value: unknown;
  }>(
    `SELECT status, source_checksum, source_row_count, target_row_count,
            discrepancy_count, cursor_value
     FROM reconciliation_checkpoints WHERE id = $1`,
    [id]
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (
      row.status !== "passed" ||
      row.source_checksum !== input.snapshotSha256 ||
      Number(row.source_row_count) !== input.rowCount ||
      Number(row.target_row_count) !== input.rowCount ||
      Number(row.discrepancy_count) !== 0 ||
      canonicalJsonHash(parseRecord(row.cursor_value)) !== canonicalJsonHash(cursor)
    ) {
      throw new Error("EXECUTION_STATE_BACKFILL_CHECKPOINT_IMMUTABLE");
    }
    return 0;
  }
  const write = await input.client.query(
    `INSERT INTO reconciliation_checkpoints(
       id, workstream, checkpoint_key, source_name, target_name, status,
       source_checksum, source_row_count, target_row_count, discrepancy_count,
       cursor_value, source_aggregates, target_aggregates, discrepancy_report,
       started_at, completed_at, version, created_at, updated_at
     ) VALUES (
       $1, 'execution_state_backfill', $1, 'sqlite_snapshot', $2, 'passed',
       $3, $4, $4, 0, $5::jsonb, $6::jsonb, $6::jsonb, $7::jsonb,
       $8, $8, 1, $8, $8
     ) ON CONFLICT (id) DO NOTHING`,
    [
      id,
      `postgres_${input.table}`,
      input.snapshotSha256,
      input.rowCount,
      JSON.stringify(cursor),
      JSON.stringify({ tableRows: input.tableRowCount }),
      JSON.stringify({ discrepancyCategories: {} }),
      input.observedAt
    ]
  );
  if ((write.rowCount ?? 0) !== 1) {
    throw new Error("EXECUTION_STATE_BACKFILL_CHECKPOINT_IMMUTABLE");
  }
  return 1;
};

export interface ExecutionStateBackfillResult {
  readonly operation: "execution_state_backfill";
  readonly status: "completed";
  readonly snapshotSha256: string;
  readonly postgresMigrationVersion: 2;
  readonly mappingVersion: string;
  readonly sourceRows: Readonly<Record<string, number>>;
  readonly insertedRows: Readonly<Record<string, number>>;
  readonly batchCount: number;
  readonly rowMutationCount: number;
  readonly checkpointMutationCount: number;
  readonly mutationCount: number;
  readonly idempotentReplay: boolean;
}

export const backfillExecutionStateSnapshot = async (input: {
  readonly snapshotPath: string;
  readonly pool: Pool;
  readonly config: DatabaseConfig;
  readonly batchSize?: number;
  readonly observedAt?: string;
}): Promise<ExecutionStateBackfillResult> => {
  if (input.config.backend !== "postgres" || input.config.purpose !== "migration") {
    throw new Error("EXECUTION_STATE_BACKFILL_MIGRATION_CONFIG_REQUIRED");
  }
  const batchSize = input.batchSize ?? 100;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new Error("EXECUTION_STATE_BACKFILL_BATCH_SIZE_INVALID");
  }
  const observedAt = input.observedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new Error("EXECUTION_STATE_BACKFILL_TIMESTAMP_INVALID");
  }
  const source = await readExecutionStateSnapshot(input.snapshotPath);
  if (source.sourceIssues.length > 0) {
    throw new Error(`EXECUTION_STATE_SOURCE_RECONCILIATION_BLOCKED:${[
      ...new Set(source.sourceIssues)
    ].join(",")}`);
  }
  const insertedRows: Record<string, number> = {};
  let checkpointMutationCount = 0;
  let batchCount = 0;
  const client = await input.pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK_KEY]);
    locked = true;
    for (const spec of tableSpecs) {
      const rows = source.rows.get(spec.table) ?? [];
      insertedRows[spec.table] = 0;
      const offsets = rows.length === 0
        ? [0]
        : Array.from({ length: Math.ceil(rows.length / batchSize) }, (_, index) => index * batchSize);
      for (const offset of offsets) {
        batchCount += 1;
        if (await hashFile(input.snapshotPath) !== source.snapshotSha256) {
          throw new Error("SQLITE_SNAPSHOT_CHANGED_DURING_BACKFILL");
        }
        const batch = rows.slice(offset, offset + batchSize);
        const mutations = await withCheckedOutPostgresTransaction(
          client,
          input.config,
          async (transaction) => {
            await transaction.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
              `${MIGRATION_LOCK_KEY}:${spec.table}`
            ]);
            let inserted = 0;
            for (const row of batch) inserted += await insertTargetRow(transaction, spec, row);
            const checkpoint = await writeBatchCheckpoint({
              client: transaction,
              snapshotSha256: source.snapshotSha256,
              table: spec.table,
              offset,
              rowCount: batch.length,
              tableRowCount: rows.length,
              observedAt
            });
            return { inserted, checkpoint };
          }
        );
        insertedRows[spec.table] += mutations.inserted;
        checkpointMutationCount += mutations.checkpoint;
      }
    }
    if (await hashFile(input.snapshotPath) !== source.snapshotSha256) {
      throw new Error("SQLITE_SNAPSHOT_CHANGED_DURING_BACKFILL");
    }
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK_KEY])
        .catch(() => undefined);
    }
    client.release();
  }
  const sourceRows = Object.fromEntries(tableSpecs.map((spec) => [
    spec.table,
    source.rows.get(spec.table)?.length ?? 0
  ]));
  const rowMutationCount = Object.values(insertedRows).reduce((sum, count) => sum + count, 0);
  const mutationCount = rowMutationCount + checkpointMutationCount;
  return {
    operation: "execution_state_backfill",
    status: "completed",
    snapshotSha256: source.snapshotSha256,
    postgresMigrationVersion: 2,
    mappingVersion: EXECUTION_STATE_MAPPING_VERSION,
    sourceRows,
    insertedRows,
    batchCount,
    rowMutationCount,
    checkpointMutationCount,
    mutationCount,
    idempotentReplay: mutationCount === 0
  };
};

export interface ExecutionTableComparison {
  readonly source: number;
  readonly target: number;
  readonly exact: number;
  readonly missing: number;
  readonly mismatch: number;
  readonly unexpected: number;
}

interface AggregateDiscrepancy {
  readonly domain: string;
  readonly type: string;
  readonly count: number;
}

const countResult = (value: unknown, code: string) => {
  const count = Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(code);
  return count;
};

const compareTargetTable = async (
  client: PoolClient,
  spec: TableSpec,
  expectedRows: readonly TargetRow[],
  accountId: string | null
): Promise<ExecutionTableComparison> => {
  let exact = 0;
  let missing = 0;
  let mismatch = 0;
  let present = 0;
  for (const row of expectedRows) {
    const values = rowValues(spec, row);
    const result = await client.query<{ matches: boolean }>(
      `SELECT (${spec.columns.map((column, index) =>
        `${column} IS NOT DISTINCT FROM ${parameter(spec, column, index + 1)}`
      ).join(" AND ")}) AS matches
       FROM ${spec.table}
       WHERE ${spec.key} = $${spec.columns.length + 1}`,
      [...values, row[spec.key]]
    );
    if (!result.rows[0]) {
      missing += 1;
      continue;
    }
    present += 1;
    if (result.rows[0].matches) exact += 1;
    else mismatch += 1;
  }
  const scope = spec.table === "accounts"
    ? accountId === null ? "" : " WHERE id = $1"
    : spec.accountColumn && accountId !== null
      ? ` WHERE ${spec.accountColumn} = $1`
      : "";
  const count = await client.query<{ count: number | string }>(
    `SELECT COUNT(*) AS count FROM ${spec.table}${scope}`,
    scope ? [accountId] : []
  );
  const target = countResult(
    count.rows[0]?.count,
    `EXECUTION_STATE_TARGET_COUNT_INVALID:${spec.table}`
  );
  return {
    source: expectedRows.length,
    target,
    exact,
    missing,
    mismatch,
    unexpected: Math.max(0, target - present)
  };
};

const duplicateChecks = [
  {
    name: "account_snapshots",
    sql: `SELECT COALESCE(SUM(row_count - 1), 0) AS count FROM (
      SELECT COUNT(*) AS row_count FROM account_snapshots
      WHERE ($1::text IS NULL OR account_id = $1)
      GROUP BY account_id, snapshot_fingerprint HAVING COUNT(*) > 1
    ) duplicate_rows`
  },
  {
    name: "execution_reviews",
    sql: `SELECT COALESCE(SUM(row_count - 1), 0) AS count FROM (
      SELECT COUNT(*) AS row_count FROM execution_reviews
      WHERE ($1::text IS NULL OR account_id = $1)
      GROUP BY account_id, payload_fingerprint HAVING COUNT(*) > 1
    ) duplicate_rows`
  },
  {
    name: "reservations",
    sql: `SELECT COALESCE(SUM(row_count - 1), 0) AS count FROM (
      SELECT COUNT(*) AS row_count FROM buying_power_reservations
      WHERE ($1::text IS NULL OR account_id = $1)
      GROUP BY account_id, idempotency_key HAVING COUNT(*) > 1
    ) duplicate_rows`
  },
  {
    name: "order_intents",
    sql: `SELECT COALESCE(SUM(row_count - 1), 0) AS count FROM (
      SELECT COUNT(*) AS row_count FROM order_intents
      WHERE ($1::text IS NULL OR account_id = $1)
      GROUP BY account_id, client_order_id HAVING COUNT(*) > 1
    ) duplicate_rows`
  },
  {
    name: "orders",
    sql: `SELECT COALESCE(SUM(row_count - 1), 0) AS count FROM (
      SELECT COUNT(*) AS row_count FROM orders
      WHERE ($1::text IS NULL OR account_id = $1)
      GROUP BY account_id, client_order_id HAVING COUNT(*) > 1
    ) duplicate_rows`
  },
  {
    name: "broker_events",
    sql: `SELECT COALESCE(SUM(row_count - 1), 0) AS count FROM (
      SELECT COUNT(*) AS row_count FROM broker_events
      WHERE ($1::text IS NULL OR account_id = $1)
        AND broker_event_id IS NOT NULL
      GROUP BY broker, broker_event_id HAVING COUNT(*) > 1
    ) duplicate_rows`
  },
  {
    name: "lifecycle_fingerprints",
    sql: `SELECT COALESCE(SUM(row_count - 1), 0) AS count FROM (
      SELECT COUNT(*) AS row_count FROM lifecycle_fingerprints
      WHERE ($1::text IS NULL OR account_id = $1)
      GROUP BY entity_type, entity_id, lifecycle_stage, fingerprint HAVING COUNT(*) > 1
    ) duplicate_rows`
  }
] as const;

const orphanChecks = [
  {
    name: "account_snapshots",
    sql: `SELECT COUNT(*) AS count FROM account_snapshots child
      LEFT JOIN accounts parent ON parent.id = child.account_id
      WHERE ($1::text IS NULL OR child.account_id = $1) AND parent.id IS NULL`
  },
  {
    name: "positions",
    sql: `SELECT COUNT(*) AS count FROM positions child
      LEFT JOIN accounts account ON account.id = child.account_id
      LEFT JOIN account_snapshots snapshot ON snapshot.id = child.source_account_snapshot_id
      LEFT JOIN orders opening_order ON opening_order.id = child.opening_order_id
      LEFT JOIN orders closing_order ON closing_order.id = child.closing_order_id
      LEFT JOIN candidates candidate ON candidate.id = child.candidate_id
      WHERE ($1::text IS NULL OR child.account_id = $1) AND (
        account.id IS NULL OR
        (child.source_account_snapshot_id IS NOT NULL AND snapshot.id IS NULL) OR
        (child.opening_order_id IS NOT NULL AND opening_order.id IS NULL) OR
        (child.closing_order_id IS NOT NULL AND closing_order.id IS NULL) OR
        (child.candidate_id IS NOT NULL AND candidate.id IS NULL)
      )`
  },
  {
    name: "order_intents",
    sql: `SELECT COUNT(*) AS count FROM order_intents child
      LEFT JOIN accounts account ON account.id = child.account_id
      LEFT JOIN buying_power_reservations reservation ON reservation.id = child.reservation_id
      LEFT JOIN execution_reviews review ON review.id = child.execution_review_id
      LEFT JOIN confirmation_evidence confirmation ON confirmation.id = child.confirmation_evidence_id
      LEFT JOIN candidates candidate ON candidate.id = child.candidate_id
      WHERE ($1::text IS NULL OR child.account_id = $1) AND (
        account.id IS NULL OR
        (child.reservation_id IS NOT NULL AND reservation.id IS NULL) OR
        (child.execution_review_id IS NOT NULL AND review.id IS NULL) OR
        (child.confirmation_evidence_id IS NOT NULL AND confirmation.id IS NULL) OR
        (child.candidate_id IS NOT NULL AND candidate.id IS NULL)
      )`
  },
  {
    name: "orders",
    sql: `SELECT COUNT(*) AS count FROM orders child
      LEFT JOIN accounts account ON account.id = child.account_id
      LEFT JOIN order_intents intent ON intent.id = child.order_intent_id
      WHERE ($1::text IS NULL OR child.account_id = $1)
        AND (account.id IS NULL OR intent.id IS NULL)`
  },
  {
    name: "broker_events",
    sql: `SELECT COUNT(*) AS count FROM broker_events child
      LEFT JOIN accounts account ON account.id = child.account_id
      LEFT JOIN orders broker_order ON broker_order.id = child.order_id
      LEFT JOIN order_intents intent ON intent.id = child.order_intent_id
      WHERE ($1::text IS NULL OR child.account_id = $1) AND (
        account.id IS NULL OR
        (child.order_id IS NOT NULL AND broker_order.id IS NULL) OR
        (child.order_intent_id IS NOT NULL AND intent.id IS NULL)
      )`
  },
  {
    name: "reservations",
    sql: `SELECT COUNT(*) AS count FROM buying_power_reservations child
      LEFT JOIN accounts account ON account.id = child.account_id
      LEFT JOIN account_snapshots snapshot ON snapshot.id = child.account_snapshot_id
      LEFT JOIN candidates candidate ON candidate.id = child.candidate_id
      WHERE ($1::text IS NULL OR child.account_id = $1) AND (
        account.id IS NULL OR snapshot.id IS NULL OR
        (child.candidate_id IS NOT NULL AND candidate.id IS NULL)
      )`
  },
  {
    name: "execution_evidence",
    sql: `SELECT COUNT(*) AS count FROM confirmation_evidence child
      LEFT JOIN execution_reviews review ON review.id = child.execution_review_id
      LEFT JOIN accounts account ON account.id = child.account_id
      WHERE ($1::text IS NULL OR child.account_id = $1)
        AND (review.id IS NULL OR account.id IS NULL)`
  },
  {
    name: "lifecycle_fingerprints",
    sql: `SELECT COUNT(*) AS count FROM lifecycle_fingerprints child
      LEFT JOIN accounts account ON account.id = child.account_id
      LEFT JOIN order_intents intent ON intent.id = child.order_intent_id
      LEFT JOIN candidates candidate ON candidate.id = child.candidate_id
      WHERE ($1::text IS NULL OR child.account_id = $1) AND (
        (child.account_id IS NOT NULL AND account.id IS NULL) OR
        (child.order_intent_id IS NOT NULL AND intent.id IS NULL) OR
        (child.candidate_id IS NOT NULL AND candidate.id IS NULL)
      )`
  }
] as const;

const integrityChecks = [
  {
    name: "lifecycle_ordering",
    sql: `SELECT COUNT(*) AS count FROM (
      SELECT id FROM order_intents
       WHERE ($1::text IS NULL OR account_id = $1) AND (
         (submitted_at IS NOT NULL AND submitted_at < created_at) OR
         (terminal_at IS NOT NULL AND terminal_at < created_at)
       )
      UNION ALL
      SELECT id FROM orders
       WHERE ($1::text IS NULL OR account_id = $1) AND (
         (accepted_at IS NOT NULL AND submitted_at IS NOT NULL AND accepted_at < submitted_at) OR
         (filled_at IS NOT NULL AND submitted_at IS NOT NULL AND filled_at < submitted_at) OR
         (cancelled_at IS NOT NULL AND submitted_at IS NOT NULL AND cancelled_at < submitted_at) OR
         (expired_at IS NOT NULL AND submitted_at IS NOT NULL AND expired_at < submitted_at)
       )
      UNION ALL
      SELECT id FROM positions
       WHERE ($1::text IS NULL OR account_id = $1)
         AND closed_at IS NOT NULL AND closed_at < opened_at
      UNION ALL
      SELECT event_id FROM broker_events
       WHERE ($1::text IS NULL OR account_id = $1) AND received_at < occurred_at
      UNION ALL
      SELECT id FROM execution_reviews
       WHERE ($1::text IS NULL OR account_id = $1)
         AND consumed_at IS NOT NULL AND consumed_at < created_at
    ) invalid_rows`
  },
  {
    name: "reservation_allocation",
    sql: `SELECT COUNT(*) AS count FROM strategy_allocations allocation
      WHERE ($1::text IS NULL OR allocation.account_id = $1)
        AND allocation.status = 'active' AND allocation.effective_to IS NULL
        AND allocation.reserved_amount IS DISTINCT FROM (
          SELECT COALESCE(SUM(reservation.amount), 0)
          FROM buying_power_reservations reservation
          WHERE reservation.account_id = allocation.account_id
            AND reservation.strategy_key = allocation.strategy_key
            AND reservation.status = 'active'
            AND reservation.expires_at > statement_timestamp()
        )`
  },
  {
    name: "reservation_intent_linkage",
    sql: `SELECT COUNT(*) AS count FROM order_intents intent
      WHERE ($1::text IS NULL OR intent.account_id = $1) AND (
        (intent.side IN ('buy', 'buy_to_open') AND intent.reservation_id IS NULL) OR
        (intent.side IN ('sell', 'sell_to_close') AND intent.reservation_id IS NOT NULL)
      )`
  }
] as const;

const runCountChecks = async (
  client: PoolClient,
  checks: ReadonlyArray<{ readonly name: string; readonly sql: string }>,
  accountId: string | null,
  code: string
) => {
  const counts: Record<string, number> = {};
  for (const check of checks) {
    const result = await client.query<{ count: number | string }>(check.sql, [accountId]);
    counts[check.name] = countResult(result.rows[0]?.count, `${code}:${check.name}`);
  }
  return counts;
};

export interface ExecutionStateReconciliationResult {
  readonly operation: "execution_state_reconciliation";
  readonly checkpointId: string;
  readonly status: "passed" | "blocked";
  readonly authorityAllowed: boolean;
  readonly snapshotSha256: string;
  readonly postgresMigrationVersion: 2;
  readonly mappingVersion: string;
  readonly tableComparisons: Readonly<Record<string, ExecutionTableComparison>>;
  readonly sourceAggregates: Readonly<Record<string, unknown>>;
  readonly targetAggregates: Readonly<Record<string, unknown>>;
  readonly discrepancyCategories: Readonly<Record<string, number>>;
  readonly discrepancyCount: number;
  readonly duplicateCount: number;
  readonly orphanCount: number;
  readonly lifecycleOrderingCount: number;
  readonly reservationAllocationInvariantCount: number;
  readonly rowMutationCount: 0;
  readonly checkpointMutationCount: number;
  readonly discrepancyMutationCount: number;
  readonly mutationCount: number;
  readonly idempotentReplay: boolean;
  readonly dryRun: boolean;
  readonly completedAt: string;
}

interface ExecutionCheckpointRow {
  readonly status: string;
  readonly source_checksum: string | null;
  readonly discrepancy_count: number | string;
  readonly cursor_value: unknown;
  readonly source_aggregates: unknown;
  readonly target_aggregates: unknown;
  readonly discrepancy_report: unknown;
  readonly completed_at: Date | string | null;
}

export const assertDurableExecutionStateCheckpoint = (
  row: ExecutionCheckpointRow | undefined,
  expected: ExecutionStateReconciliationResult
) => {
  const cursor = parseRecord(row?.cursor_value);
  const sourceAggregates = parseRecord(row?.source_aggregates);
  const targetAggregates = parseRecord(row?.target_aggregates);
  const discrepancyReport = parseRecord(row?.discrepancy_report);
  let completedAt: string | null = null;
  try {
    completedAt = row?.completed_at === null || row?.completed_at === undefined
      ? null
      : new Date(row.completed_at).toISOString();
  } catch {
    throw new Error("EXECUTION_STATE_DURABLE_CHECKPOINT_VERIFICATION_FAILED");
  }
  if (
    row?.status !== expected.status ||
    row.source_checksum !== expected.snapshotSha256 ||
    Number(row.discrepancy_count) !== expected.discrepancyCount ||
    cursor?.postgresMigrationVersion !== expected.postgresMigrationVersion ||
    cursor?.mappingVersion !== expected.mappingVersion ||
    cursor?.snapshotSha256 !== expected.snapshotSha256 ||
    !sourceAggregates ||
    canonicalJsonHash(sourceAggregates) !== canonicalJsonHash(expected.sourceAggregates) ||
    !targetAggregates ||
    canonicalJsonHash(targetAggregates) !== canonicalJsonHash(expected.targetAggregates) ||
    !discrepancyReport ||
    canonicalJsonHash(discrepancyReport) !== canonicalJsonHash({
      discrepancyCategories: expected.discrepancyCategories
    }) ||
    completedAt !== expected.completedAt
  ) {
    throw new Error("EXECUTION_STATE_DURABLE_CHECKPOINT_VERIFICATION_FAILED");
  }
  return true;
};

const sortedCounts = (counts: Readonly<Record<string, number>>) =>
  Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));

const sumCounts = (counts: Readonly<Record<string, number>>) =>
  Object.values(counts).reduce((sum, count) => sum + count, 0);

export const reconcileExecutionStateSnapshot = async (input: {
  readonly snapshotPath: string;
  readonly pool: Pool;
  readonly config: DatabaseConfig;
  readonly checkpointId?: string;
  readonly observedAt?: string;
  readonly dryRun?: boolean;
}): Promise<ExecutionStateReconciliationResult> => {
  if (input.config.backend !== "postgres" || input.config.purpose !== "migration") {
    throw new Error("EXECUTION_STATE_RECONCILIATION_MIGRATION_CONFIG_REQUIRED");
  }
  if (input.checkpointId !== undefined && !input.checkpointId.trim()) {
    throw new Error("EXECUTION_STATE_CHECKPOINT_ID_REQUIRED");
  }
  const observedAt = input.observedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new Error("EXECUTION_STATE_RECONCILIATION_TIMESTAMP_INVALID");
  }
  const source = await readExecutionStateSnapshot(input.snapshotPath);
  return withPostgresTransaction(
    input.pool,
    input.config,
    async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${MIGRATION_LOCK_KEY}:reconcile`
      ]);
      if (!input.dryRun) {
        await client.query("LOCK TABLE reconciliation_checkpoints IN SHARE ROW EXCLUSIVE MODE");
      }
      const tableComparisons: Record<string, ExecutionTableComparison> = {};
      for (const spec of tableSpecs) {
        tableComparisons[spec.table] = await compareTargetTable(
          client,
          spec,
          source.rows.get(spec.table) ?? [],
          source.accountId
        );
      }
      const duplicateCounts = await runCountChecks(
        client,
        duplicateChecks,
        source.accountId,
        "EXECUTION_STATE_DUPLICATE_COUNT_INVALID"
      );
      const orphanCounts = await runCountChecks(
        client,
        orphanChecks,
        source.accountId,
        "EXECUTION_STATE_ORPHAN_COUNT_INVALID"
      );
      const integrityCounts = await runCountChecks(
        client,
        integrityChecks,
        source.accountId,
        "EXECUTION_STATE_INVARIANT_COUNT_INVALID"
      );
      const discrepancyRecords: AggregateDiscrepancy[] = [];
      for (const [table, comparison] of Object.entries(tableComparisons)) {
        if (comparison.missing > 0) {
          discrepancyRecords.push({ domain: table, type: "MISSING", count: comparison.missing });
        }
        if (comparison.mismatch > 0) {
          discrepancyRecords.push({ domain: table, type: "MISMATCH", count: comparison.mismatch });
        }
        if (comparison.unexpected > 0) {
          discrepancyRecords.push({
            domain: table,
            type: "UNEXPECTED",
            count: comparison.unexpected
          });
        }
      }
      const sourceIssueCounts: Record<string, number> = {};
      for (const issue of source.sourceIssues) {
        sourceIssueCounts[issue] = (sourceIssueCounts[issue] ?? 0) + 1;
      }
      for (const [type, count] of Object.entries(sourceIssueCounts)) {
        discrepancyRecords.push({ domain: "sqlite_source", type, count });
      }
      for (const [domain, count] of Object.entries(duplicateCounts)) {
        if (count > 0) discrepancyRecords.push({ domain, type: "DUPLICATE", count });
      }
      for (const [domain, count] of Object.entries(orphanCounts)) {
        if (count > 0) discrepancyRecords.push({ domain, type: "ORPHAN", count });
      }
      for (const [domain, count] of Object.entries(integrityCounts)) {
        if (count > 0) discrepancyRecords.push({ domain, type: "INVARIANT", count });
      }
      const discrepancyCategories = sortedCounts(discrepancyRecords.reduce<Record<string, number>>(
        (counts, discrepancy) => {
          const key = `${discrepancy.domain}:${discrepancy.type}`;
          counts[key] = (counts[key] ?? 0) + discrepancy.count;
          return counts;
        },
        {}
      ));
      const discrepancyCount = sumCounts(discrepancyCategories);
      const status = discrepancyCount === 0 ? "passed" as const : "blocked" as const;
      const checkpointId = input.checkpointId?.trim() || (status === "passed"
        ? `execution-state-passed-${createHash("sha256")
          .update(`${source.snapshotSha256}:${EXECUTION_STATE_MAPPING_VERSION}`)
          .digest("hex")}`
        : `execution-state-blocked-${observedAt.replace(/[^0-9]/g, "")}`);
      const sourceTables = Object.fromEntries(Object.entries(tableComparisons).map(
        ([table, comparison]) => [table, comparison.source]
      ));
      const targetTables = Object.fromEntries(Object.entries(tableComparisons).map(
        ([table, comparison]) => [table, comparison.target]
      ));
      const sourceAggregates = {
        tables: sortedCounts(sourceTables),
        sourceIssues: sortedCounts(sourceIssueCounts),
        sourceTableCounts: source.sourceCounts
      };
      const targetAggregates = {
        tables: sortedCounts(targetTables),
        duplicates: sortedCounts(duplicateCounts),
        orphans: sortedCounts(orphanCounts),
        invariants: sortedCounts(integrityCounts)
      };
      const duplicateCount = sumCounts(duplicateCounts);
      const orphanCount = sumCounts(orphanCounts);
      const lifecycleOrderingCount = integrityCounts.lifecycle_ordering ?? 0;
      const reservationAllocationInvariantCount =
        (integrityCounts.reservation_allocation ?? 0) +
        (integrityCounts.reservation_intent_linkage ?? 0);
      const baseResult = (
        checkpointMutationCount: number,
        discrepancyMutationCount: number,
        idempotentReplay: boolean,
        completedAt: string
      ): ExecutionStateReconciliationResult => ({
        operation: "execution_state_reconciliation",
        checkpointId,
        status,
        authorityAllowed: status === "passed" && input.dryRun !== true,
        snapshotSha256: source.snapshotSha256,
        postgresMigrationVersion: 2,
        mappingVersion: EXECUTION_STATE_MAPPING_VERSION,
        tableComparisons,
        sourceAggregates,
        targetAggregates,
        discrepancyCategories,
        discrepancyCount,
        duplicateCount,
        orphanCount,
        lifecycleOrderingCount,
        reservationAllocationInvariantCount,
        rowMutationCount: 0,
        checkpointMutationCount,
        discrepancyMutationCount,
        mutationCount: checkpointMutationCount + discrepancyMutationCount,
        idempotentReplay,
        dryRun: input.dryRun === true,
        completedAt
      });
      const existing = await client.query<ExecutionCheckpointRow>(
        `SELECT status, source_checksum, discrepancy_count, cursor_value,
                source_aggregates, target_aggregates, discrepancy_report, completed_at
         FROM reconciliation_checkpoints WHERE id = $1`,
        [checkpointId]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].completed_at === null) {
          throw new Error("EXECUTION_STATE_CHECKPOINT_COMPLETION_REQUIRED");
        }
        const replay = baseResult(
          0,
          0,
          true,
          new Date(existing.rows[0].completed_at).toISOString()
        );
        try {
          assertDurableExecutionStateCheckpoint(existing.rows[0], replay);
        } catch {
          throw new Error("EXECUTION_STATE_CHECKPOINT_IMMUTABLE");
        }
        return replay;
      }
      if (input.dryRun) return baseResult(0, 0, false, observedAt);
      const sourceRowCount = Object.values(sourceTables).reduce((sum, count) => sum + count, 0);
      const targetRowCount = Object.values(targetTables).reduce((sum, count) => sum + count, 0);
      const cursor = {
        snapshotSha256: source.snapshotSha256,
        postgresMigrationVersion: 2,
        mappingVersion: EXECUTION_STATE_MAPPING_VERSION
      };
      const lastEventOccurredAt = (source.rows.get("broker_events") ?? [])
        .map((row) => nullableString(row.occurred_at))
        .filter((value): value is string => value !== null)
        .sort()
        .at(-1) ?? null;
      const checkpointWrite = await client.query(
        `INSERT INTO reconciliation_checkpoints(
           id, workstream, checkpoint_key, source_name, target_name, status,
           source_checksum, source_row_count, target_row_count, discrepancy_count,
           cursor_value, source_aggregates, target_aggregates, discrepancy_report,
           last_event_occurred_at, started_at, completed_at, version, created_at, updated_at
         ) VALUES (
           $1, 'execution_state', $1, 'sqlite_snapshot', 'postgres_execution_state', $2,
           $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
           $11, $12, $12, 1, $12, $12
         ) ON CONFLICT (id) DO NOTHING`,
        [
          checkpointId,
          status,
          source.snapshotSha256,
          sourceRowCount,
          targetRowCount,
          discrepancyCount,
          JSON.stringify(cursor),
          JSON.stringify(sourceAggregates),
          JSON.stringify(targetAggregates),
          JSON.stringify({ discrepancyCategories }),
          lastEventOccurredAt,
          observedAt
        ]
      );
      if ((checkpointWrite.rowCount ?? 0) !== 1) {
        throw new Error("EXECUTION_STATE_CHECKPOINT_IMMUTABLE");
      }
      let discrepancyMutationCount = 0;
      for (const discrepancy of discrepancyRecords) {
        const id = `execution-discrepancy-${canonicalJsonHash({
          checkpointId,
          domain: discrepancy.domain,
          type: discrepancy.type
        })}`;
        const write = await client.query(
          `INSERT INTO reconciliation_discrepancies(
             id, checkpoint_id, domain, entity_id, discrepancy_type,
             expected, actual, observed_at, created_at
           ) VALUES ($1, $2, $3, NULL, $4, $5::jsonb, $6::jsonb, $7, $7)
           ON CONFLICT (id) DO NOTHING`,
          [
            id,
            checkpointId,
            discrepancy.domain,
            discrepancy.type,
            JSON.stringify({ count: 0 }),
            JSON.stringify({ count: discrepancy.count }),
            observedAt
          ]
        );
        discrepancyMutationCount += write.rowCount ?? 0;
      }
      return baseResult(1, discrepancyMutationCount, false, observedAt);
    },
    {
      isolationLevel: "repeatable read",
      readOnly: input.dryRun === true
    }
  );
};
