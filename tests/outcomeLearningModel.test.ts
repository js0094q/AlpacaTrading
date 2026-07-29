import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHistoricalOutcomeAggregates,
  buildOutcomeLearningRecord,
  OUTCOME_LEARNING_SCHEMA_VERSION,
  PAPER_OUTCOME_LIMITATIONS,
  selectReferenceMarketObservation,
  type OutcomeLearningInput
} from "../src/services/outcomeLearningModel.js";

const exactInput = (): OutcomeLearningInput => ({
  calculatedAt: "2026-07-29T12:00:00.000Z",
  refreshRunId: "refresh-1",
  environment: "paper",
  candidate: {
    id: "candidate-1",
    cycleId: "cycle-1",
    symbol: "AAPL",
    underlyingSymbol: "AAPL",
    strategyFamily: "equity",
    timeHorizon: "short_term",
    score: 82,
    confidence: 0.76,
    decision: "selected",
    lifecycleStatus: "closed",
    asOf: "2026-07-28T14:29:00.000Z",
    reasonCodes: ["MOMENTUM_CONFIRMED"],
    researchSignalIds: ["signal-1"],
    researchHorizons: ["long_term"],
    catalysts: ["earnings"],
    spreadBps: 10,
    liquidityScore: 0.9
  },
  arbitrations: [{
    id: "arbitration-decision-1",
    proposalId: "candidate-1",
    cycleId: "cycle-1",
    schedulerRunId: "scheduler-run-1",
    lane: "equity",
    action: "approve",
    reasonCodes: ["PORTFOLIO_CAPACITY_AVAILABLE"],
    createdAt: "2026-07-28T14:29:10.000Z"
  }],
  reviews: [{
    id: "review-1",
    candidateId: "candidate-1",
    environment: "paper",
    status: "valid",
    createdAt: "2026-07-28T14:29:20.000Z",
    marketEvidenceIds: ["stock-snapshot-1"],
    reasonCodes: ["REVIEW_VALID"]
  }, {
    id: "review-exit-1",
    candidateId: "candidate-1",
    reviewType: "exit",
    environment: "paper",
    status: "valid",
    createdAt: "2026-07-28T19:59:20.000Z",
    marketEvidenceIds: [],
    reasonCodes: ["EXIT_REVIEW_VALID"]
  }],
  intents: [{
    id: "intent-1",
    candidateId: "candidate-1",
    reviewId: "review-1",
    clientOrderId: "client-1",
    status: "submitted",
    quantity: 2,
    createdAt: "2026-07-28T14:29:30.000Z",
    submittedAt: "2026-07-28T14:30:00.000Z"
  }, {
    id: "intent-exit-1",
    candidateId: "candidate-1",
    reviewId: "review-exit-1",
    clientOrderId: "client-exit-1",
    status: "submitted",
    quantity: 2,
    parentPositionId: "position-1",
    createdAt: "2026-07-28T19:59:30.000Z",
    submittedAt: "2026-07-28T20:00:00.000Z"
  }],
  orders: [{
    id: "order-1",
    intentId: "intent-1",
    clientOrderId: "client-1",
    brokerOrderId: "alpaca-order-1",
    status: "filled",
    side: "buy",
    requestedQuantity: 2,
    filledQuantity: 2,
    averageFillPrice: 101,
    submittedAt: "2026-07-28T14:30:00.000Z"
  }, {
    id: "order-exit-1",
    intentId: "intent-exit-1",
    clientOrderId: "client-exit-1",
    brokerOrderId: "alpaca-order-exit-1",
    status: "filled",
    side: "sell",
    requestedQuantity: 2,
    filledQuantity: 2,
    averageFillPrice: 110,
    submittedAt: "2026-07-28T20:00:00.000Z"
  }],
  brokerEvents: [{
    id: "broker-event-partial",
    brokerEventId: "activity-not-durable",
    orderId: "order-1",
    intentId: "intent-1",
    status: "partially_filled",
    filledQuantity: 1,
    occurredAt: "2026-07-28T14:30:02.000Z"
  }, {
    id: "broker-event-full",
    brokerEventId: "event-full-1",
    orderId: "order-1",
    intentId: "intent-1",
    status: "filled",
    filledQuantity: 2,
    occurredAt: "2026-07-28T14:30:05.000Z"
  }, {
    id: "broker-event-exit",
    brokerEventId: "event-exit-1",
    orderId: "order-exit-1",
    intentId: "intent-exit-1",
    status: "filled",
    filledQuantity: 2,
    occurredAt: "2026-07-28T20:00:03.000Z"
  }],
  positions: [{
    id: "position-1",
    candidateId: "candidate-1",
    openingOrderId: "order-1",
    closingOrderId: "order-exit-1",
    status: "closed",
    assetClass: "equity",
    quantity: 2,
    averageEntryPrice: 101,
    openedAt: "2026-07-28T14:30:05.000Z",
    closedAt: "2026-07-28T20:00:03.000Z",
    lastReconciledAt: "2026-07-28T20:01:00.000Z",
    sourceAccountSnapshotId: "account-snapshot-1"
  }],
  marketObservations: [{
    id: "stock-snapshot-1",
    instrument: "AAPL",
    observedAt: "2026-07-28T14:29:59.500Z",
    receivedAt: "2026-07-28T14:29:59.600Z",
    persistedAt: "2026-07-28T14:29:59.700Z",
    provider: "alpaca",
    feed: "iex",
    bid: 99,
    ask: 101,
    midpoint: 100,
    last: 100.2,
    requestId: "request-1"
  }],
  excursionObservations: [
    {
      id: "bar-1",
      instrument: "AAPL",
      observedAt: "2026-07-28T15:00:00.000Z",
      high: 112,
      low: 98,
      source: "market_bars",
      granularity: "1Day"
    },
    {
      id: "bar-2",
      instrument: "AAPL",
      observedAt: "2026-07-28T19:00:00.000Z",
      high: 108,
      low: 100,
      source: "market_bars",
      granularity: "1Day"
    }
  ]
});

test("builds one exact paper lineage through arbitration, review, intent, fills, position, and exit", () => {
  const record = buildOutcomeLearningRecord(exactInput());

  assert.equal(record.outcomeId, "outcome:v1:paper:candidate-1");
  assert.equal(record.environment, "paper");
  assert.equal(record.lane, "equity");
  assert.equal(record.timeHorizon, "short_term");
  assert.equal(record.candidateId, "candidate-1");
  assert.equal(record.proposalId, "candidate-1");
  assert.equal(record.arbitrationDecisionId, "arbitration-decision-1");
  assert.equal(record.reviewId, "review-1");
  assert.equal(record.intentId, "intent-1");
  assert.equal(record.clientOrderId, "client-1");
  assert.equal(record.alpacaOrderId, "alpaca-order-1");
  assert.equal(record.positionId, "position-1");
  assert.equal(record.exitReviewId, "review-exit-1");
  assert.equal(record.exitOrderId, "order-exit-1");
  assert.deepEqual(record.exitReasonCodes, ["EXIT_REVIEW_VALID"]);
  assert.deepEqual(record.researchSignalIds, ["signal-1"]);
  assert.deepEqual(record.researchHorizons, ["long_term"]);
  assert.equal(record.fillStatus, "fully_filled");
  assert.deepEqual(record.marketEvidenceIds, ["stock-snapshot-1"]);
  assert.deepEqual(record.brokerEventIds, [
    "broker-event-partial",
    "broker-event-full",
    "broker-event-exit"
  ]);
  assert.deepEqual(record.fillActivityIds, []);
  assert.equal(record.joinStatus, "exact");
  assert.equal(record.schemaVersion, OUTCOME_LEARNING_SCHEMA_VERSION);
  assert.match(record.contentHash, /^[a-f0-9]{64}$/);
  assert.ok(record.metricLimitations.includes("FILL_ACTIVITY_ID_NOT_PERSISTED"));
  assert.deepEqual(record.paperLimitations, PAPER_OUTCOME_LIMITATIONS);
});

test("records broker events only from the selected entry and exit lineage", () => {
  const input = exactInput();
  input.brokerEvents.push({
    id: "broker-event-unselected-retry",
    brokerEventId: "event-unselected-retry",
    orderId: "order-unselected-retry",
    intentId: "intent-unselected-retry",
    status: "canceled",
    filledQuantity: 0,
    occurredAt: "2026-07-28T23:59:59.000Z"
  });

  const record = buildOutcomeLearningRecord(input);

  assert.deepEqual(record.brokerEventIds, [
    "broker-event-partial",
    "broker-event-full",
    "broker-event-exit"
  ]);
  assert.ok(
    record.partialJoinReasons.includes(
      "ADDITIONAL_BROKER_EVENTS_NOT_SELECTED"
    )
  );
  assert.equal(record.joinStatus, "partial");
  assert.notEqual(
    record.sourceWatermark,
    "2026-07-28T23:59:59.000Z"
  );
});

test("uses authoritative broker event times and distinguishes partial and full fill", () => {
  const record = buildOutcomeLearningRecord(exactInput());

  assert.equal(record.submittedAt, "2026-07-28T14:30:00.000Z");
  assert.equal(record.firstFillAt, "2026-07-28T14:30:02.000Z");
  assert.equal(record.fullFillAt, "2026-07-28T14:30:05.000Z");
  assert.equal(record.timeToFirstFillMs, 2_000);
  assert.equal(record.timeToFullFillMs, 5_000);
  assert.equal(record.timeIntentToSubmissionMs, 30_000);
  assert.equal(record.timeProposalToSubmissionMs, 60_000);
  assert.equal(record.finalOrderStatus, "filled");

  const partial = exactInput();
  partial.orders[0]!.status = "partially_filled";
  partial.orders[0]!.filledQuantity = 1;
  partial.brokerEvents = partial.brokerEvents.filter(
    (event) => event.id !== "broker-event-full"
  );
  const partialRecord = buildOutcomeLearningRecord(partial);
  assert.equal(partialRecord.firstFillAt, "2026-07-28T14:30:02.000Z");
  assert.equal(partialRecord.fullFillAt, null);
  assert.equal(partialRecord.timeToFullFillMs, null);
});

test("uses exact or nearest prior market evidence and rejects future or stale observations", () => {
  const exact = exactInput();
  const exactRecord = buildOutcomeLearningRecord(exact);
  assert.equal(exactRecord.referenceLookupMethod, "exact_evidence");
  assert.equal(exactRecord.referenceMidpoint, 100);
  assert.equal(
    exactRecord.referenceReceivedAt,
    "2026-07-28T14:29:59.600Z"
  );
  assert.equal(
    exactRecord.referencePersistedAt,
    "2026-07-28T14:29:59.700Z"
  );
  assert.equal(exactRecord.fillVsBid, 2);
  assert.equal(exactRecord.fillVsAsk, 0);
  assert.equal(exactRecord.fillVsMidpoint, 1);
  assert.equal(exactRecord.fillVsLast, 0.8);
  assert.equal(exactRecord.spreadAtReferenceValue, 2);
  assert.equal(exactRecord.spreadAtReferenceBps, 200);
  assert.equal(exactRecord.slippageValue, 1);
  assert.equal(exactRecord.slippageBps, 100);
  assert.equal(exactRecord.slippageBasis, "midpoint");

  const nearestRecordInput = exactInput();
  nearestRecordInput.reviews[0]!.marketEvidenceIds = [];
  const nearestRecord = buildOutcomeLearningRecord(nearestRecordInput);
  assert.equal(nearestRecord.referenceLookupMethod, "nearest_prior_quote");
  assert.deepEqual(nearestRecord.marketEvidenceIds, ["stock-snapshot-1"]);

  const nearest = selectReferenceMarketObservation({
    instrument: "AAPL",
    eventAt: "2026-07-28T14:30:00.000Z",
    toleranceMs: 60_000,
    exactEvidenceIds: [],
    observations: [{
      id: "prior",
      instrument: "AAPL",
      observedAt: "2026-07-28T14:29:40.000Z",
      provider: "alpaca",
      feed: "iex",
      bid: 99,
      ask: 101,
      midpoint: 100,
      last: null
    }, {
      id: "future",
      instrument: "AAPL",
      observedAt: "2026-07-28T14:30:00.001Z",
      provider: "alpaca",
      feed: "iex",
      bid: 100,
      ask: 102,
      midpoint: 101,
      last: null
    }, {
      id: "stale",
      instrument: "AAPL",
      observedAt: "2026-07-28T14:28:00.000Z",
      provider: "alpaca",
      feed: "iex",
      bid: 98,
      ask: 100,
      midpoint: 99,
      last: null
    }]
  });
  assert.equal(nearest.observation?.id, "prior");
  assert.equal(nearest.method, "nearest_prior_quote");
  assert.equal(nearest.distanceMs, 20_000);

  const unavailable = selectReferenceMarketObservation({
    instrument: "AAPL",
    eventAt: "2026-07-28T14:30:00.000Z",
    toleranceMs: 10_000,
    exactEvidenceIds: [],
    observations: nearest.candidates
  });
  assert.equal(unavailable.observation, null);
  assert.equal(unavailable.method, "unavailable");
});

test("reports missing and ambiguous joins without zero-filled metrics or batch failure", () => {
  const missing = exactInput();
  missing.arbitrations = [];
  missing.orders = [];
  missing.brokerEvents = [];
  missing.positions = [];
  missing.marketObservations = [];
  const missingRecord = buildOutcomeLearningRecord(missing);

  assert.equal(missingRecord.joinStatus, "missing");
  assert.ok(missingRecord.missingJoinReasons.includes("ARBITRATION_DECISION_MISSING"));
  assert.ok(missingRecord.missingJoinReasons.includes("ORDER_MISSING"));
  assert.equal(missingRecord.filledQuantity, null);
  assert.equal(missingRecord.averageFillPrice, null);
  assert.equal(missingRecord.realizedReturn, null);
  assert.equal(missingRecord.referenceMidpoint, null);
  assert.equal(missingRecord.slippageBps, null);

  const missingPosition = exactInput();
  missingPosition.positions = [];
  missingPosition.intents = missingPosition.intents.filter(
    (entry) => !entry.parentPositionId
  );
  missingPosition.orders = missingPosition.orders.filter(
    (entry) => entry.id === "order-1"
  );
  const missingPositionRecord = buildOutcomeLearningRecord(missingPosition);
  assert.ok(
    missingPositionRecord.missingJoinReasons.includes("POSITION_MISSING")
  );
  assert.equal(missingPositionRecord.positionId, null);
  assert.equal(missingPositionRecord.realizedReturn, null);

  const missingExit = exactInput();
  missingExit.positions[0]!.closingOrderId = undefined;
  missingExit.intents = missingExit.intents.filter(
    (entry) => !entry.parentPositionId
  );
  missingExit.orders = missingExit.orders.filter(
    (entry) => entry.id === "order-1"
  );
  const missingExitRecord = buildOutcomeLearningRecord(missingExit);
  assert.ok(missingExitRecord.missingJoinReasons.includes("EXIT_INTENT_MISSING"));
  assert.ok(missingExitRecord.missingJoinReasons.includes("EXIT_ORDER_MISSING"));
  assert.equal(missingExitRecord.realizedReturn, null);

  const ambiguous = exactInput();
  ambiguous.intents.unshift({
    ...ambiguous.intents[0]!,
    id: "intent-competing",
    clientOrderId: "client-competing"
  });
  ambiguous.orders.unshift({
    ...ambiguous.orders[0]!,
    id: "order-competing",
    intentId: "intent-competing",
    clientOrderId: "client-competing",
    brokerOrderId: "alpaca-order-competing"
  });
  ambiguous.positions.unshift({
    ...ambiguous.positions[0]!,
    id: "position-competing",
    openingOrderId: "order-competing",
    closingOrderId: undefined,
    status: "open",
    closedAt: undefined
  });
  const ambiguousRecord = buildOutcomeLearningRecord(ambiguous);
  assert.equal(ambiguousRecord.joinStatus, "ambiguous");
  assert.ok(
    ambiguousRecord.ambiguousJoinReasons.includes(
      "MULTIPLE_POSITION_LINKED_ENTRY_ORDERS"
    )
  );
  assert.equal(ambiguousRecord.intentId, null);
  assert.equal(ambiguousRecord.alpacaOrderId, null);

  const unrelated = exactInput();
  unrelated.candidate.id = "candidate-2";
  unrelated.candidate.cycleId = "cycle-2";
  unrelated.arbitrations[0]!.proposalId = "candidate-2";
  unrelated.reviews.forEach((review) => {
    review.candidateId = "candidate-2";
  });
  unrelated.intents.forEach((intent) => {
    intent.candidateId = "candidate-2";
  });
  unrelated.positions[0]!.candidateId = "candidate-2";
  assert.equal(buildOutcomeLearningRecord(unrelated).candidateId, "candidate-2");
});

test("prefers a position-linked authoritative chain over unexecuted retry artifacts", () => {
  const input = exactInput();
  input.reviews.push({
    ...input.reviews[0]!,
    id: "review-retry",
    createdAt: "2026-07-28T14:29:25.000Z"
  });
  input.intents.unshift({
    ...input.intents[0]!,
    id: "intent-retry",
    reviewId: "review-retry",
    clientOrderId: "client-retry",
    status: "failed"
  });

  const record = buildOutcomeLearningRecord(input);

  assert.equal(record.intentId, "intent-1");
  assert.equal(record.reviewId, "review-1");
  assert.equal(record.orderRecordId, "order-1");
  assert.equal(record.positionId, "position-1");
  assert.equal(record.joinStatus, "partial");
  assert.ok(
    record.partialJoinReasons.includes("ADDITIONAL_ENTRY_INTENTS_NOT_SELECTED")
  );
  assert.ok(
    record.partialJoinReasons.includes("ADDITIONAL_ENTRY_REVIEWS_NOT_SELECTED")
  );
});

test("distinguishes submitted, rejected, canceled, partial-fill, and full-fill states", () => {
  for (const [status, filledQuantity, expectedFillState] of [
    ["submitted", 0, "missing"],
    ["rejected", 0, "terminal_unfilled"],
    ["canceled", 0, "terminal_unfilled"],
    ["partially_filled", 1, "partial"],
    ["filled", 2, "full"]
  ] as const) {
    const input = exactInput();
    input.orders[0]!.status = status;
    input.orders[0]!.filledQuantity = filledQuantity;
    input.positions = filledQuantity > 0 ? input.positions : [];
    input.intents = input.intents.filter((intent) => !intent.parentPositionId);
    input.orders = input.orders.filter((order) => order.id === "order-1");
    input.brokerEvents = status === "partially_filled"
      ? input.brokerEvents.filter((event) => event.id === "broker-event-partial")
      : status === "filled"
        ? input.brokerEvents.filter((event) =>
            ["broker-event-partial", "broker-event-full"].includes(event.id)
          )
        : [];

    const record = buildOutcomeLearningRecord(input);

    assert.equal(record.finalOrderStatus, status);
    assert.equal(
      record.missingJoinReasons.includes("FILL_MISSING"),
      expectedFillState === "missing",
      status
    );
    assert.equal(
      record.metricLimitations.includes("TERMINAL_ORDER_WITHOUT_FILL"),
      expectedFillState === "terminal_unfilled",
      status
    );
    assert.equal(
      record.fullFillAt !== null,
      expectedFillState === "full",
      status
    );
  }
});

test("uses authoritative order filled_at when no separate fill event timestamp exists", () => {
  const input = exactInput();
  input.brokerEvents = input.brokerEvents.filter(
    (event) => event.orderId !== "order-1"
  );
  input.orders[0]!.filledAt = "2026-07-28T14:30:06.000Z";

  const record = buildOutcomeLearningRecord(input);

  assert.equal(record.firstFillAt, "2026-07-28T14:30:06.000Z");
  assert.equal(record.fullFillAt, "2026-07-28T14:30:06.000Z");
  assert.equal(record.timeToFirstFillMs, 6_000);
  assert.equal(
    record.missingJoinReasons.includes("AUTHORITATIVE_FILL_TIMESTAMP_MISSING"),
    false
  );
});

test("calculates supported closed return, unrealized checkpoints, and bounded instrument excursion", () => {
  const closed = buildOutcomeLearningRecord(exactInput());
  assert.equal(closed.realizedPnl, 18);
  assert.equal(closed.realizedReturn, 18 / 202);
  assert.equal(closed.holdingPeriodMs, 19_798_000);
  assert.equal(closed.maximumFavorableExcursion, 11 / 101);
  assert.equal(closed.maximumAdverseExcursion, -3 / 101);
  assert.equal(closed.excursionSource, "market_bars:1Day:mark_to_market");

  const open = exactInput();
  open.candidate.lifecycleStatus = "open";
  open.positions[0] = {
    ...open.positions[0]!,
    status: "open",
    closingOrderId: undefined,
    closedAt: undefined,
    unrealizedPnl: 10,
    costBasis: 202,
    currentPrice: 106
  };
  open.intents = open.intents.filter((intent) => !intent.parentPositionId);
  open.orders = open.orders.filter((order) => order.id === "order-1");
  open.brokerEvents = open.brokerEvents.filter((event) => event.orderId === "order-1");
  const openRecord = buildOutcomeLearningRecord(open);
  assert.equal(openRecord.realizedPnl, null);
  assert.equal(openRecord.realizedReturn, null);
  assert.deepEqual(openRecord.unrealizedReturnCheckpoints, [{
    at: "2026-07-28T20:01:00.000Z",
    markSource: "position_reconciliation",
    markPrice: 106,
    unrealizedPnl: 10,
    unrealizedReturn: 10 / 202,
    sourceAccountSnapshotId: "account-snapshot-1"
  }]);

  const option = exactInput();
  option.candidate.symbol = "AAPL260731C00100000";
  option.candidate.optionContractId = "contract-1";
  option.candidate.strategyFamily = "options_0dte";
  option.positions[0]!.assetClass = "option";
  option.positions[0]!.contractMultiplier = 100;
  option.positions[0]!.averageEntryPrice = 1.01;
  option.orders[0]!.averageFillPrice = 1.01;
  option.orders[1]!.averageFillPrice = 1.1;
  option.marketObservations[0]!.instrument = "AAPL260731C00100000";
  option.excursionObservations = [];
  const optionWithoutContractMarks = buildOutcomeLearningRecord(option);
  assert.equal(optionWithoutContractMarks.maximumFavorableExcursion, null);
  assert.equal(optionWithoutContractMarks.maximumAdverseExcursion, null);
  assert.ok(
    optionWithoutContractMarks.metricLimitations.includes(
      "OPTION_CONTRACT_EXCURSION_EVIDENCE_UNAVAILABLE"
    )
  );

  option.positions[0]!.contractMultiplier = undefined;
  const optionWithoutMultiplier = buildOutcomeLearningRecord(option);
  assert.equal(optionWithoutMultiplier.realizedPnl, null);
  assert.equal(optionWithoutMultiplier.realizedReturn, null);
  assert.ok(
    optionWithoutMultiplier.metricLimitations.includes(
      "OPTION_CONTRACT_MULTIPLIER_UNAVAILABLE"
    )
  );

  const unsupportedAttribution = exactInput();
  unsupportedAttribution.orders[1]!.filledQuantity = 1;
  unsupportedAttribution.positions[0]!.realizedPnl = 9;
  const unsupportedRecord = buildOutcomeLearningRecord(unsupportedAttribution);
  assert.equal(unsupportedRecord.realizedPnl, 9);
  assert.equal(unsupportedRecord.realizedReturn, null);
  assert.ok(
    unsupportedRecord.metricLimitations.includes(
      "POSITION_LEVEL_REALIZED_PNL_ONLY"
    )
  );
  assert.ok(
    unsupportedRecord.metricLimitations.includes(
      "REALIZED_RETURN_ATTRIBUTION_UNSUPPORTED"
    )
  );
});

test("builds separate bounded lane and supported-dimension aggregates", () => {
  const equity = buildOutcomeLearningRecord(exactInput());
  const zeroDteInput = exactInput();
  zeroDteInput.candidate.id = "candidate-0dte";
  zeroDteInput.candidate.symbol = "SPY260728C00640000";
  zeroDteInput.candidate.underlyingSymbol = "SPY";
  zeroDteInput.candidate.optionContractId = "contract-0dte";
  zeroDteInput.candidate.strategyFamily = "options_0dte";
  zeroDteInput.marketObservations[0]!.instrument = zeroDteInput.candidate.symbol;
  zeroDteInput.excursionObservations.forEach((observation) => {
    observation.instrument = zeroDteInput.candidate.symbol;
  });
  zeroDteInput.arbitrations[0]!.proposalId = "candidate-0dte";
  zeroDteInput.arbitrations[0]!.lane = "options_0dte";
  zeroDteInput.reviews.forEach((review) => {
    review.candidateId = "candidate-0dte";
  });
  zeroDteInput.intents.forEach((intent) => {
    intent.candidateId = "candidate-0dte";
  });
  zeroDteInput.positions[0]!.candidateId = "candidate-0dte";
  const zeroDte = buildOutcomeLearningRecord(zeroDteInput);

  const leapsInput = exactInput();
  leapsInput.candidate.id = "candidate-leaps";
  leapsInput.candidate.symbol = "MSFT270618C00400000";
  leapsInput.candidate.underlyingSymbol = "MSFT";
  leapsInput.candidate.optionContractId = "contract-leaps";
  leapsInput.candidate.strategyFamily = "options_leaps";
  leapsInput.marketObservations[0]!.instrument = leapsInput.candidate.symbol;
  leapsInput.excursionObservations.forEach((observation) => {
    observation.instrument = leapsInput.candidate.symbol;
  });
  leapsInput.arbitrations[0]!.proposalId = "candidate-leaps";
  leapsInput.arbitrations[0]!.lane = "options_leaps";
  leapsInput.reviews.forEach((review) => {
    review.candidateId = "candidate-leaps";
  });
  leapsInput.intents.forEach((intent) => {
    intent.candidateId = "candidate-leaps";
  });
  leapsInput.positions[0]!.candidateId = "candidate-leaps";
  const leaps = buildOutcomeLearningRecord(leapsInput);

  const aggregates = buildHistoricalOutcomeAggregates({
    refreshRunId: "refresh-1",
    records: [equity, zeroDte, leaps],
    dateRangeStart: "2026-07-28T00:00:00.000Z",
    dateRangeEnd: "2026-07-29T00:00:00.000Z",
    calculatedAt: "2026-07-29T12:00:00.000Z",
    minimumSample: 1,
    maximumIncompleteJoinRatio: 0.25,
    sourceTruncated: false
  });

  for (const lane of ["equity", "options_0dte", "options_leaps"]) {
    const aggregate = aggregates.find(
      (entry) => entry.dimension === "lane" && entry.groupingKey === lane
    );
    assert.equal(aggregate?.sampleCount, 1, lane);
    assert.equal(aggregate?.environment, "paper", lane);
    assert.equal(aggregate?.lane, lane, lane);
    assert.equal(aggregate?.usableAsEvidence, true, lane);
  }
  for (const dimension of [
    "symbol",
    "underlying",
    "entry_reason",
    "arbitration_reason",
    "arbitration_action",
    "score_bucket",
    "confidence_bucket",
    "spread_bucket",
    "liquidity_bucket",
    "research_signal",
    "research_horizon",
    "time_horizon",
    "catalyst",
    "order_status",
    "fill_status",
    "holding_period_bucket"
  ]) {
    assert.ok(aggregates.some((entry) => entry.dimension === dimension), dimension);
  }
  assert.equal(
    aggregates.some((entry) => entry.environment === "live"),
    false
  );

  const liveInput = exactInput();
  liveInput.environment = "live";
  liveInput.candidate.id = "candidate-live";
  liveInput.arbitrations[0]!.proposalId = "candidate-live";
  liveInput.reviews.forEach((review) => {
    review.candidateId = "candidate-live";
  });
  liveInput.intents.forEach((intent) => {
    intent.candidateId = "candidate-live";
  });
  liveInput.positions[0]!.candidateId = "candidate-live";
  const live = buildOutcomeLearningRecord(liveInput);
  const separated = buildHistoricalOutcomeAggregates({
    refreshRunId: "refresh-mixed",
    records: [equity, live],
    dateRangeStart: "2026-07-28T00:00:00.000Z",
    dateRangeEnd: "2026-07-29T00:00:00.000Z",
    calculatedAt: "2026-07-29T12:00:00.000Z",
    minimumSample: 1,
    maximumIncompleteJoinRatio: 0.25,
    sourceTruncated: false
  }).filter((entry) => entry.dimension === "lane");
  assert.deepEqual(
    separated.map((entry) => [entry.environment, entry.sampleCount]),
    [["live", 1], ["paper", 1]]
  );
  assert.deepEqual(live.paperLimitations, []);
});
