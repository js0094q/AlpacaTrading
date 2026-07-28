import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLaneResearchInfluence,
  evaluateResearchSignalState,
  normalizeResearchImport,
  researchSignalConfiguration
} from "../src/services/researchSignalAdapterService.js";

const ingestedAt = new Date("2026-07-28T14:00:00.000Z");

const validSignal = {
  provider: "Analyst-Export",
  provider_signal_id: "signal-001",
  symbol: "spy",
  as_of: "2026-07-28T12:00:00.000Z",
  horizon: "long_term",
  thesis_summary: "Earnings durability supports the long-duration thesis.",
  thesis_direction: "bullish",
  confidence: 0.72,
  catalysts: ["Investor day"],
  catalyst_dates: ["2026-07-28T15:00:00.000Z"],
  risks: ["Margin compression"],
  invalidation_conditions: ["Guidance falls below the stated range"],
  contradiction_status: "not_contradicted",
  valuation_summary: "Valuation remains below the imported base-case range.",
  source_references: ["research://analyst-export/signal-001"],
  expires_or_review_at: "2026-08-15T12:00:00.000Z"
};

test("normalizes explicit research fields without inventing unavailable values", () => {
  const result = normalizeResearchImport({
    schema_version: 1,
    signals: [{
      provider: validSignal.provider,
      symbol: validSignal.symbol,
      as_of: validSignal.as_of,
      horizon: "short_term",
      source_references: validSignal.source_references
    }]
  }, { ingestedAt });

  assert.equal(result.rejected.length, 0);
  assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.accepted[0], {
    id: result.accepted[0]?.id,
    provider: "analyst-export",
    providerSignalId: null,
    symbol: "SPY",
    asOf: "2026-07-28T12:00:00.000Z",
    horizon: "short_term",
    thesisSummary: null,
    thesisDirection: null,
    confidence: null,
    catalysts: [],
    catalystDates: [],
    risks: [],
    invalidationConditions: [],
    contradictionStatus: null,
    contradictionReason: null,
    valuationSummary: null,
    sourceReferences: ["research://analyst-export/signal-001"],
    expiresOrReviewAt: null,
    ingestionTimestamp: "2026-07-28T14:00:00.000Z",
    contentHash: result.accepted[0]?.contentHash,
    schemaVersion: 1
  });
  assert.match(result.accepted[0]!.id, /^research_signal_[a-f0-9]{64}$/);
  assert.match(result.accepted[0]!.contentHash, /^[a-f0-9]{64}$/);
});

test("keeps identity and content hash deterministic while ingestion time remains distinct", () => {
  const first = normalizeResearchImport(
    { schema_version: 1, signals: [validSignal] },
    { ingestedAt }
  ).accepted[0]!;
  const replay = normalizeResearchImport(
    { schema_version: 1, signals: [validSignal] },
    { ingestedAt: new Date("2026-07-29T14:00:00.000Z") }
  ).accepted[0]!;

  assert.equal(first.id, replay.id);
  assert.equal(first.contentHash, replay.contentHash);
  assert.notEqual(first.ingestionTimestamp, replay.ingestionTimestamp);
  assert.equal(first.asOf, "2026-07-28T12:00:00.000Z");
  assert.equal(first.expiresOrReviewAt, "2026-08-15T12:00:00.000Z");
  assert.equal(first.ingestionTimestamp, "2026-07-28T14:00:00.000Z");
  assert.deepEqual(first.sourceReferences, ["research://analyst-export/signal-001"]);
});

test("rejects invalid records independently and blocks broker execution fields", () => {
  const result = normalizeResearchImport({
    schema_version: 1,
    signals: [
      validSignal,
      { ...validSignal, provider_signal_id: "bad-symbol", symbol: "../SPY" },
      { ...validSignal, provider_signal_id: "non-finite", confidence: Number.NaN },
      { ...validSignal, provider_signal_id: "broker-shape", quantity: 3 },
      { ...validSignal, provider_signal_id: "missing-source", source_references: [] }
    ]
  }, { ingestedAt });

  assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.rejected.map(({ reasonCode }) => reasonCode), [
    "RESEARCH_SYMBOL_INVALID",
    "RESEARCH_CONFIDENCE_INVALID",
    "RESEARCH_EXECUTION_FIELD_FORBIDDEN",
    "RESEARCH_SOURCE_REFERENCES_REQUIRED"
  ]);
  assert.equal(result.rejected.every(({ message }) => message.length <= 240), true);
});

test("rejects unsupported top-level import fields instead of interpreting them", () => {
  const result = normalizeResearchImport({
    schema_version: 1,
    signals: [validSignal],
    broker_payload: { side: "buy" }
  }, { ingestedAt });

  assert.equal(result.accepted.length, 0);
  assert.deepEqual(result.rejected.map(({ reasonCode }) => reasonCode), [
    "RESEARCH_IMPORT_FIELD_UNSUPPORTED"
  ]);
});

test("enforces bounded strings, arrays, enums, and timestamps", () => {
  const result = normalizeResearchImport({
    schema_version: 1,
    signals: [
      { ...validSignal, provider_signal_id: "long-summary", thesis_summary: "x".repeat(4_001) },
      { ...validSignal, provider_signal_id: "many-risks", risks: Array(21).fill("risk") },
      { ...validSignal, provider_signal_id: "bad-horizon", horizon: "whenever" },
      { ...validSignal, provider_signal_id: "future", as_of: "2026-07-29T14:00:00.000Z" },
      {
        ...validSignal,
        provider_signal_id: "bad-expiration",
        expires_or_review_at: "2026-07-27T12:00:00.000Z"
      }
    ]
  }, { ingestedAt });

  assert.deepEqual(result.rejected.map(({ reasonCode }) => reasonCode), [
    "RESEARCH_TEXT_TOO_LONG",
    "RESEARCH_ARRAY_TOO_LARGE",
    "RESEARCH_HORIZON_INVALID",
    "RESEARCH_AS_OF_FUTURE",
    "RESEARCH_EXPIRATION_BEFORE_AS_OF"
  ]);
});

test("derives current, expired, and contradicted states from explicit evidence", () => {
  const normalized = normalizeResearchImport(
    { schema_version: 1, signals: [validSignal] },
    { ingestedAt }
  ).accepted[0]!;
  const config = researchSignalConfiguration({});

  assert.deepEqual(
    evaluateResearchSignalState(
      normalized,
      new Date("2026-07-28T14:30:00.000Z"),
      config
    ),
    { state: "current", reasonCodes: ["RESEARCH_CURRENT"] }
  );
  assert.deepEqual(
    evaluateResearchSignalState(
      normalized,
      new Date("2026-08-16T14:30:00.000Z"),
      config
    ),
    { state: "expired", reasonCodes: ["RESEARCH_EXPIRES_OR_REVIEW_AT_PASSED"] }
  );
  assert.deepEqual(
    evaluateResearchSignalState(
      { ...normalized, contradictionStatus: "contradicted", contradictionReason: "New filing conflicts." },
      new Date("2026-07-28T14:30:00.000Z"),
      config
    ),
    { state: "contradicted", reasonCodes: ["RESEARCH_CONTRADICTED"] }
  );
  assert.deepEqual(
    evaluateResearchSignalState(
      { ...normalized, asOf: "not-a-timestamp" },
      new Date("2026-07-28T14:30:00.000Z"),
      config
    ),
    { state: "invalid", reasonCodes: ["RESEARCH_AS_OF_INVALID"] }
  );
});

test("uses conservative configurable recency and score bounds", () => {
  const config = researchSignalConfiguration({
    RESEARCH_INTRADAY_MAX_AGE_DAYS: "2",
    RESEARCH_SHORT_TERM_MAX_AGE_DAYS: "14",
    RESEARCH_MEDIUM_TERM_MAX_AGE_DAYS: "45",
    RESEARCH_LONG_TERM_MAX_AGE_DAYS: "120",
    RESEARCH_DIRECTION_SCORE_ADJUSTMENT: "4"
  });

  assert.deepEqual(config, {
    maxAgeDaysByHorizon: {
      intraday: 2,
      short_term: 14,
      medium_term: 45,
      long_term: 120
    },
    directionScoreAdjustment: 4
  });
  assert.equal(
    researchSignalConfiguration({
      RESEARCH_DIRECTION_SCORE_ADJUSTMENT: "999"
    }).directionScoreAdjustment,
    3
  );
});

test("current directional research adjusts equity and LEAPS scores without exceeding the cap", () => {
  const signal = normalizeResearchImport(
    { schema_version: 1, signals: [validSignal] },
    { ingestedAt }
  ).accepted[0]!;
  const config = researchSignalConfiguration({
    RESEARCH_DIRECTION_SCORE_ADJUSTMENT: "3"
  });
  const now = new Date("2026-07-28T14:30:00.000Z");

  const equity = buildLaneResearchInfluence({
    signals: [signal],
    lane: "equity",
    targetDirection: "long",
    now,
    config
  });
  const leaps = buildLaneResearchInfluence({
    signals: [signal],
    lane: "options_leaps",
    targetDirection: "long",
    now,
    config
  });
  const opposed = buildLaneResearchInfluence({
    signals: [signal],
    lane: "equity",
    targetDirection: "short",
    now,
    config
  });

  assert.equal(equity.scoreAdjustment, 3);
  assert.equal(leaps.scoreAdjustment, 3);
  assert.equal(opposed.scoreAdjustment, -3);
  assert.equal(equity.signalId, signal.id);
  assert.equal(equity.provider, "analyst-export");
  assert.deepEqual(equity.sourceReferences, signal.sourceReferences);
  assert.equal(equity.state, "current");
  assert.ok(equity.reasonCodes.includes("RESEARCH_DIRECTION_ALIGNED"));
});

test("0DTE uses only a current-session catalyst and never long-form thesis or valuation", () => {
  const signal = normalizeResearchImport(
    { schema_version: 1, signals: [validSignal] },
    { ingestedAt }
  ).accepted[0]!;
  const config = researchSignalConfiguration({});
  const now = new Date("2026-07-28T14:30:00.000Z");

  const catalyst = buildLaneResearchInfluence({
    signals: [signal],
    lane: "options_0dte",
    targetDirection: "long",
    now,
    config
  });
  const noCatalyst = buildLaneResearchInfluence({
    signals: [{ ...signal, catalystDates: [] }],
    lane: "options_0dte",
    targetDirection: "long",
    now,
    config
  });

  assert.equal(catalyst.scoreAdjustment, 0);
  assert.equal(catalyst.signalId, signal.id);
  assert.deepEqual(catalyst.reasonCodes, [
    "RESEARCH_CURRENT",
    "RESEARCH_CURRENT_SESSION_CATALYST"
  ]);
  assert.equal("thesisSummary" in catalyst, false);
  assert.equal("valuationSummary" in catalyst, false);
  assert.deepEqual(noCatalyst, {
    signalId: null,
    provider: null,
    asOf: null,
    horizon: null,
    sourceReferences: [],
    state: "unavailable",
    scoreAdjustment: 0,
    reasonCodes: ["RESEARCH_0DTE_NO_CURRENT_SESSION_CATALYST"]
  });
});

test("unavailable, expired, and contradicted research remain lane-scoped no-research results", () => {
  const signal = normalizeResearchImport(
    { schema_version: 1, signals: [validSignal] },
    { ingestedAt }
  ).accepted[0]!;
  const config = researchSignalConfiguration({});

  const unavailable = buildLaneResearchInfluence({
    signals: [],
    lane: "equity",
    targetDirection: "long",
    now: ingestedAt,
    config
  });
  const expired = buildLaneResearchInfluence({
    signals: [signal],
    lane: "equity",
    targetDirection: "long",
    now: new Date("2026-08-16T14:30:00.000Z"),
    config
  });
  const contradicted = buildLaneResearchInfluence({
    signals: [{ ...signal, contradictionStatus: "contradicted" }],
    lane: "options_leaps",
    targetDirection: "long",
    now: ingestedAt,
    config
  });

  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.scoreAdjustment, 0);
  assert.equal(expired.state, "expired");
  assert.equal(expired.scoreAdjustment, 0);
  assert.equal(expired.signalId, signal.id);
  assert.equal(contradicted.state, "contradicted");
  assert.equal(contradicted.scoreAdjustment, 0);
});
