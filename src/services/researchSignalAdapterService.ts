import { canonicalJsonHash } from "../lib/canonicalJson.js";
import { normalizeSymbol } from "../lib/utils.js";

export const RESEARCH_SIGNAL_SCHEMA_VERSION = 1;
export const RESEARCH_IMPORT_MAX_SIGNALS = 100;

export type ResearchHorizon =
  | "intraday"
  | "short_term"
  | "medium_term"
  | "long_term";
export type ResearchThesisDirection = "bullish" | "bearish" | "neutral";
export type ResearchContradictionStatus =
  | "not_contradicted"
  | "contradicted";
export type ResearchUsabilityState =
  | "current"
  | "expired"
  | "contradicted"
  | "invalid"
  | "unavailable";
export type ResearchDecisionLane =
  | "equity"
  | "options_0dte"
  | "options_leaps";

export interface NormalizedResearchSignal {
  readonly id: string;
  readonly provider: string;
  readonly providerSignalId: string | null;
  readonly symbol: string;
  readonly asOf: string;
  readonly horizon: ResearchHorizon;
  readonly thesisSummary: string | null;
  readonly thesisDirection: ResearchThesisDirection | null;
  readonly confidence: number | null;
  readonly catalysts: readonly string[];
  readonly catalystDates: readonly string[];
  readonly risks: readonly string[];
  readonly invalidationConditions: readonly string[];
  readonly contradictionStatus: ResearchContradictionStatus | null;
  readonly contradictionReason: string | null;
  readonly valuationSummary: string | null;
  readonly sourceReferences: readonly string[];
  readonly expiresOrReviewAt: string | null;
  readonly ingestionTimestamp: string;
  readonly contentHash: string;
  readonly schemaVersion: number;
}

export interface ResearchSignalRejection {
  readonly index: number | null;
  readonly reasonCode: string;
  readonly message: string;
}

export interface ResearchImportNormalizationResult {
  readonly schemaVersion: number | null;
  readonly accepted: readonly NormalizedResearchSignal[];
  readonly rejected: readonly ResearchSignalRejection[];
}

export interface ResearchSignalConfiguration {
  readonly maxAgeDaysByHorizon: Readonly<Record<ResearchHorizon, number>>;
  readonly directionScoreAdjustment: number;
}

export interface ResearchSignalState {
  readonly state: Exclude<ResearchUsabilityState, "unavailable">;
  readonly reasonCodes: readonly string[];
}

export interface LaneResearchInfluence {
  readonly signalId: string | null;
  readonly provider: string | null;
  readonly asOf: string | null;
  readonly horizon: ResearchHorizon | null;
  readonly sourceReferences: readonly string[];
  readonly state: ResearchUsabilityState;
  readonly scoreAdjustment: number;
  readonly reasonCodes: readonly string[];
}

const HORIZONS = new Set<ResearchHorizon>([
  "intraday",
  "short_term",
  "medium_term",
  "long_term"
]);
const DIRECTIONS = new Set<ResearchThesisDirection>([
  "bullish",
  "bearish",
  "neutral"
]);
const CONTRADICTION_STATUSES = new Set<ResearchContradictionStatus>([
  "not_contradicted",
  "contradicted"
]);
const ALLOWED_SIGNAL_FIELDS = new Set([
  "provider",
  "provider_signal_id",
  "symbol",
  "as_of",
  "horizon",
  "thesis_summary",
  "thesis_direction",
  "confidence",
  "catalysts",
  "catalyst_dates",
  "risks",
  "invalidation_conditions",
  "contradiction_status",
  "contradiction_reason",
  "valuation_summary",
  "source_references",
  "expires_or_review_at"
]);
const FORBIDDEN_EXECUTION_FIELDS = new Set([
  "quantity",
  "qty",
  "side",
  "order_type",
  "orderType",
  "limit_price",
  "limitPrice",
  "stop_price",
  "stopPrice",
  "client_order_id",
  "clientOrderId",
  "broker_payload",
  "brokerPayload",
  "execution_method",
  "executionMethod",
  "request_payload",
  "requestPayload",
  "position_intent",
  "positionIntent"
]);
const SYMBOL_PATTERN = /^[A-Z][A-Z.]{0,14}$/;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_TEXT_LENGTH = 4_000;
const MAX_ARRAY_LENGTH = 20;
const MAX_ARRAY_ITEM_LENGTH = 1_000;
const MAX_PROVIDER_SIGNAL_ID_LENGTH = 200;
const MAX_REASON_LENGTH = 1_000;
const MAX_REJECTION_MESSAGE_LENGTH = 240;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const rejection = (
  index: number | null,
  reasonCode: string,
  message: string
): ResearchSignalRejection => ({
  index,
  reasonCode,
  message: message.slice(0, MAX_REJECTION_MESSAGE_LENGTH)
});

const optionalText = (
  value: unknown,
  field: string,
  maximumLength = MAX_TEXT_LENGTH
): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`RESEARCH_TEXT_INVALID:${field}`);
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximumLength) {
    throw new Error(`RESEARCH_TEXT_TOO_LONG:${field}`);
  }
  return normalized;
};

const requiredText = (
  value: unknown,
  field: string,
  maximumLength: number
) => {
  const normalized = optionalText(value, field, maximumLength);
  if (!normalized) throw new Error(`RESEARCH_FIELD_REQUIRED:${field}`);
  return normalized;
};

const timestamp = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`RESEARCH_TIMESTAMP_REQUIRED:${field}`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`RESEARCH_TIMESTAMP_INVALID:${field}`);
  }
  return parsed.toISOString();
};

const optionalTimestamp = (value: unknown, field: string) =>
  value === undefined || value === null
    ? null
    : timestamp(value, field);

const textArray = (
  value: unknown,
  field: string,
  options: { required?: boolean; timestamps?: boolean } = {}
): string[] => {
  if (value === undefined || value === null) {
    if (options.required) throw new Error(`RESEARCH_SOURCE_REFERENCES_REQUIRED:${field}`);
    return [];
  }
  if (!Array.isArray(value)) throw new Error(`RESEARCH_ARRAY_INVALID:${field}`);
  if (value.length > MAX_ARRAY_LENGTH) {
    throw new Error(`RESEARCH_ARRAY_TOO_LARGE:${field}`);
  }
  const normalized = value.map((entry, itemIndex) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`RESEARCH_ARRAY_ITEM_INVALID:${field}:${itemIndex}`);
    }
    if (entry.trim().length > MAX_ARRAY_ITEM_LENGTH) {
      throw new Error(`RESEARCH_ARRAY_ITEM_TOO_LONG:${field}:${itemIndex}`);
    }
    return options.timestamps
      ? timestamp(entry, `${field}[${itemIndex}]`)
      : entry.trim();
  });
  if (options.required && normalized.length === 0) {
    throw new Error(`RESEARCH_SOURCE_REFERENCES_REQUIRED:${field}`);
  }
  return normalized;
};

const reasonCodeFromError = (error: unknown) => {
  const raw = error instanceof Error ? error.message : "RESEARCH_SIGNAL_INVALID";
  return raw.split(":", 1)[0] || "RESEARCH_SIGNAL_INVALID";
};

const normalizeSignal = (
  raw: unknown,
  index: number,
  ingestionTimestamp: string
): NormalizedResearchSignal => {
  if (!isRecord(raw)) throw new Error("RESEARCH_SIGNAL_OBJECT_REQUIRED");
  for (const field of Object.keys(raw)) {
    if (FORBIDDEN_EXECUTION_FIELDS.has(field)) {
      throw new Error(`RESEARCH_EXECUTION_FIELD_FORBIDDEN:${field}`);
    }
    if (!ALLOWED_SIGNAL_FIELDS.has(field)) {
      throw new Error(`RESEARCH_FIELD_UNSUPPORTED:${field}`);
    }
  }

  const provider = requiredText(raw.provider, "provider", 64).toLowerCase();
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new Error("RESEARCH_PROVIDER_INVALID");
  }
  const providerSignalId = optionalText(
    raw.provider_signal_id,
    "provider_signal_id",
    MAX_PROVIDER_SIGNAL_ID_LENGTH
  );
  const symbol = normalizeSymbol(requiredText(raw.symbol, "symbol", 15));
  if (!SYMBOL_PATTERN.test(symbol)) throw new Error("RESEARCH_SYMBOL_INVALID");
  const asOf = timestamp(raw.as_of, "as_of");
  if (Date.parse(asOf) > Date.parse(ingestionTimestamp)) {
    throw new Error("RESEARCH_AS_OF_FUTURE");
  }
  if (typeof raw.horizon !== "string" || !HORIZONS.has(raw.horizon as ResearchHorizon)) {
    throw new Error("RESEARCH_HORIZON_INVALID");
  }
  const horizon = raw.horizon as ResearchHorizon;
  const thesisSummary = optionalText(raw.thesis_summary, "thesis_summary");
  const thesisDirection = raw.thesis_direction === undefined ||
      raw.thesis_direction === null
    ? null
    : typeof raw.thesis_direction === "string" &&
        DIRECTIONS.has(raw.thesis_direction as ResearchThesisDirection)
      ? raw.thesis_direction as ResearchThesisDirection
      : (() => { throw new Error("RESEARCH_THESIS_DIRECTION_INVALID"); })();
  const confidence = raw.confidence === undefined || raw.confidence === null
    ? null
    : typeof raw.confidence === "number" &&
        Number.isFinite(raw.confidence) &&
        raw.confidence >= 0 &&
        raw.confidence <= 1
      ? raw.confidence
      : (() => { throw new Error("RESEARCH_CONFIDENCE_INVALID"); })();
  const catalysts = textArray(raw.catalysts, "catalysts");
  const catalystDates = textArray(raw.catalyst_dates, "catalyst_dates", {
    timestamps: true
  });
  const risks = textArray(raw.risks, "risks");
  const invalidationConditions = textArray(
    raw.invalidation_conditions,
    "invalidation_conditions"
  );
  const contradictionStatus =
    raw.contradiction_status === undefined || raw.contradiction_status === null
      ? null
      : typeof raw.contradiction_status === "string" &&
          CONTRADICTION_STATUSES.has(
            raw.contradiction_status as ResearchContradictionStatus
          )
        ? raw.contradiction_status as ResearchContradictionStatus
        : (() => { throw new Error("RESEARCH_CONTRADICTION_STATUS_INVALID"); })();
  const contradictionReason = optionalText(
    raw.contradiction_reason,
    "contradiction_reason",
    MAX_REASON_LENGTH
  );
  const valuationSummary = optionalText(raw.valuation_summary, "valuation_summary");
  const sourceReferences = textArray(
    raw.source_references,
    "source_references",
    { required: true }
  );
  const expiresOrReviewAt = optionalTimestamp(
    raw.expires_or_review_at,
    "expires_or_review_at"
  );
  if (
    expiresOrReviewAt !== null &&
    Date.parse(expiresOrReviewAt) < Date.parse(asOf)
  ) {
    throw new Error("RESEARCH_EXPIRATION_BEFORE_AS_OF");
  }

  const content = {
    provider,
    providerSignalId,
    symbol,
    asOf,
    horizon,
    thesisSummary,
    thesisDirection,
    confidence,
    catalysts,
    catalystDates,
    risks,
    invalidationConditions,
    contradictionStatus,
    contradictionReason,
    valuationSummary,
    sourceReferences,
    expiresOrReviewAt,
    schemaVersion: RESEARCH_SIGNAL_SCHEMA_VERSION
  };
  const contentHash = canonicalJsonHash(content);
  const identityHash = canonicalJsonHash({
    provider,
    symbol,
    sourceIdentity: providerSignalId ?? sourceReferences,
    asOf,
    contentHash
  });
  return {
    id: `research_signal_${identityHash}`,
    ...content,
    ingestionTimestamp,
    contentHash
  };
};

export const normalizeResearchImport = (
  payload: unknown,
  input: {
    readonly ingestedAt?: Date;
    readonly maxSignals?: number;
  } = {}
): ResearchImportNormalizationResult => {
  const ingestedAt = input.ingestedAt ?? new Date();
  const ingestionTimestamp = ingestedAt.toISOString();
  if (!isRecord(payload)) {
    return {
      schemaVersion: null,
      accepted: [],
      rejected: [
        rejection(null, "RESEARCH_IMPORT_OBJECT_REQUIRED", "Research import must be a JSON object.")
      ]
    };
  }
  if (
    Object.keys(payload).some(
      (field) => field !== "schema_version" && field !== "signals"
    )
  ) {
    return {
      schemaVersion:
        typeof payload.schema_version === "number" ? payload.schema_version : null,
      accepted: [],
      rejected: [
        rejection(
          null,
          "RESEARCH_IMPORT_FIELD_UNSUPPORTED",
          "Research import contains an unsupported top-level field."
        )
      ]
    };
  }
  if (payload.schema_version !== RESEARCH_SIGNAL_SCHEMA_VERSION) {
    return {
      schemaVersion:
        typeof payload.schema_version === "number" ? payload.schema_version : null,
      accepted: [],
      rejected: [
        rejection(
          null,
          "RESEARCH_SCHEMA_VERSION_UNSUPPORTED",
          `Only schema version ${RESEARCH_SIGNAL_SCHEMA_VERSION} is supported.`
        )
      ]
    };
  }
  if (!Array.isArray(payload.signals)) {
    return {
      schemaVersion: RESEARCH_SIGNAL_SCHEMA_VERSION,
      accepted: [],
      rejected: [
        rejection(null, "RESEARCH_SIGNALS_ARRAY_REQUIRED", "signals must be an array.")
      ]
    };
  }
  const maximum = input.maxSignals ?? RESEARCH_IMPORT_MAX_SIGNALS;
  if (payload.signals.length > maximum) {
    return {
      schemaVersion: RESEARCH_SIGNAL_SCHEMA_VERSION,
      accepted: [],
      rejected: [
        rejection(
          null,
          "RESEARCH_IMPORT_TOO_MANY_SIGNALS",
          `Research import exceeds the ${maximum} record limit.`
        )
      ]
    };
  }

  const accepted: NormalizedResearchSignal[] = [];
  const rejected: ResearchSignalRejection[] = [];
  payload.signals.forEach((raw, index) => {
    try {
      accepted.push(normalizeSignal(raw, index, ingestionTimestamp));
    } catch (error) {
      const reasonCode = reasonCodeFromError(error);
      rejected.push(rejection(
        index,
        reasonCode,
        `${reasonCode}: signal ${index} was rejected.`
      ));
    }
  });
  return {
    schemaVersion: RESEARCH_SIGNAL_SCHEMA_VERSION,
    accepted,
    rejected
  };
};

const configuredNumber = (
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
) => {
  if (raw === undefined || !raw.trim()) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
};

export const researchSignalConfiguration = (
  env: NodeJS.ProcessEnv = process.env
): ResearchSignalConfiguration => ({
  maxAgeDaysByHorizon: {
    intraday: configuredNumber(env.RESEARCH_INTRADAY_MAX_AGE_DAYS, 1, 0.01, 7),
    short_term: configuredNumber(
      env.RESEARCH_SHORT_TERM_MAX_AGE_DAYS,
      14,
      1,
      90
    ),
    medium_term: configuredNumber(
      env.RESEARCH_MEDIUM_TERM_MAX_AGE_DAYS,
      45,
      1,
      365
    ),
    long_term: configuredNumber(
      env.RESEARCH_LONG_TERM_MAX_AGE_DAYS,
      120,
      1,
      730
    )
  },
  directionScoreAdjustment: configuredNumber(
    env.RESEARCH_DIRECTION_SCORE_ADJUSTMENT,
    3,
    0,
    10
  )
});

export const evaluateResearchSignalState = (
  signal: NormalizedResearchSignal,
  now: Date,
  config: ResearchSignalConfiguration
): ResearchSignalState => {
  if (!Number.isFinite(Date.parse(signal.asOf)) || Date.parse(signal.asOf) > now.getTime()) {
    return { state: "invalid", reasonCodes: ["RESEARCH_AS_OF_INVALID"] };
  }
  if (signal.contradictionStatus === "contradicted") {
    return { state: "contradicted", reasonCodes: ["RESEARCH_CONTRADICTED"] };
  }
  if (
    signal.expiresOrReviewAt !== null &&
    Date.parse(signal.expiresOrReviewAt) < now.getTime()
  ) {
    return {
      state: "expired",
      reasonCodes: ["RESEARCH_EXPIRES_OR_REVIEW_AT_PASSED"]
    };
  }
  const ageDays = (now.getTime() - Date.parse(signal.asOf)) / 86_400_000;
  if (ageDays > config.maxAgeDaysByHorizon[signal.horizon]) {
    return {
      state: "expired",
      reasonCodes: ["RESEARCH_HORIZON_RECENCY_EXCEEDED"]
    };
  }
  return { state: "current", reasonCodes: ["RESEARCH_CURRENT"] };
};

const newYorkDate = (date: Date) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const signalReference = (
  signal: NormalizedResearchSignal,
  state: ResearchUsabilityState,
  scoreAdjustment: number,
  reasonCodes: readonly string[]
): LaneResearchInfluence => ({
  signalId: signal.id,
  provider: signal.provider,
  asOf: signal.asOf,
  horizon: signal.horizon,
  sourceReferences: signal.sourceReferences,
  state,
  scoreAdjustment,
  reasonCodes
});

const unavailableInfluence = (
  reasonCode: string
): LaneResearchInfluence => ({
  signalId: null,
  provider: null,
  asOf: null,
  horizon: null,
  sourceReferences: [],
  state: "unavailable",
  scoreAdjustment: 0,
  reasonCodes: [reasonCode]
});

const laneSignals = (
  signals: readonly NormalizedResearchSignal[],
  lane: ResearchDecisionLane
) => signals
  .filter((signal) =>
    lane !== "options_leaps" || signal.horizon === "long_term"
  )
  .sort((left, right) =>
    Date.parse(right.asOf) - Date.parse(left.asOf) ||
    left.provider.localeCompare(right.provider) ||
    left.id.localeCompare(right.id)
  );

export const buildLaneResearchInfluence = (input: {
  readonly signals: readonly NormalizedResearchSignal[];
  readonly lane: ResearchDecisionLane;
  readonly targetDirection: "long" | "short" | "neutral";
  readonly now: Date;
  readonly config: ResearchSignalConfiguration;
  readonly unavailableReasonCode?: string | null;
}): LaneResearchInfluence => {
  const applicable = laneSignals(input.signals, input.lane);
  const evaluated = applicable.map((signal) => ({
    signal,
    state: evaluateResearchSignalState(signal, input.now, input.config)
  }));
  const current = evaluated.filter(({ state }) => state.state === "current");

  if (input.lane === "options_0dte") {
    const tradingDate = newYorkDate(input.now);
    const catalyst = current.find(({ signal }) =>
      signal.catalystDates.some((date) => newYorkDate(new Date(date)) === tradingDate)
    );
    return catalyst
      ? signalReference(
          catalyst.signal,
          "current",
          0,
          [...catalyst.state.reasonCodes, "RESEARCH_CURRENT_SESSION_CATALYST"]
        )
      : unavailableInfluence(
          applicable.length === 0 && input.unavailableReasonCode
            ? input.unavailableReasonCode
            : "RESEARCH_0DTE_NO_CURRENT_SESSION_CATALYST"
        );
  }

  const selected = current[0];
  if (!selected) {
    const historical = evaluated[0];
    return historical
      ? signalReference(
          historical.signal,
          historical.state.state,
          0,
          historical.state.reasonCodes
        )
      : unavailableInfluence(
          input.unavailableReasonCode ?? "RESEARCH_UNAVAILABLE"
        );
  }

  const researchDirection = selected.signal.thesisDirection;
  const targetDirection = input.targetDirection;
  const aligned =
    (researchDirection === "bullish" && targetDirection === "long") ||
    (researchDirection === "bearish" && targetDirection === "short");
  const opposed =
    (researchDirection === "bullish" && targetDirection === "short") ||
    (researchDirection === "bearish" && targetDirection === "long");
  const scoreAdjustment = aligned
    ? input.config.directionScoreAdjustment
    : opposed
      ? -input.config.directionScoreAdjustment
      : 0;
  const directionReason = aligned
    ? "RESEARCH_DIRECTION_ALIGNED"
    : opposed
      ? "RESEARCH_DIRECTION_OPPOSED"
      : researchDirection === "neutral"
        ? "RESEARCH_DIRECTION_NEUTRAL"
        : "RESEARCH_DIRECTION_UNAVAILABLE";
  return signalReference(
    selected.signal,
    "current",
    scoreAdjustment,
    [...selected.state.reasonCodes, directionReason]
  );
};
