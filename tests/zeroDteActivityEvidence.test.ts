import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildZeroDteActivityEvidence } from "../src/services/zeroDte/zeroDteActivityEvidenceService.js";

const tradingDate = "2026-07-14";
const asOf = "2026-07-14T15:00:00.000Z";
const callA = "SPY260714C00500000";
const callB = "SPY260714C00505000";

const sources = (overrides: Record<string, unknown> = {}) => ({
  listLedgerActivity: () => [],
  listLevel2Activity: () => [],
  listGenericPositionActivity: () => [],
  ...overrides
});

describe("0DTE activity evidence", () => {
  test("returns complete zero counters when authoritative sources are empty", () => {
    const evidence = buildZeroDteActivityEvidence(
      { tradingDate, asOf, positions: [], orders: [] },
      sources()
    );

    assert.equal(evidence.complete, true);
    assert.equal(evidence.dailyTradeCount, 0);
    assert.equal(evidence.dailyPremium, 0);
    assert.equal(evidence.dailyRealizedLoss, 0);
    assert.equal(evidence.openExposureCount, 0);
  });

  test("deduplicates broker and ledger identities and prefers actual fill premium", () => {
    const evidence = buildZeroDteActivityEvidence(
      {
        tradingDate,
        asOf,
        positions: [],
        orders: [
          {
            id: "broker-order-1",
            client_order_id: "entry-shared-1",
            symbol: callA,
            asset_class: "us_option",
            side: "buy",
            position_intent: "buy_to_open",
            status: "filled",
            qty: "1",
            limit_price: "1.25",
            filled_qty: "1",
            filled_avg_price: "1.20",
            created_at: "2026-07-14T14:00:00.000Z",
            filled_at: "2026-07-14T14:00:02.000Z"
          }
        ]
      },
      sources({
        listLedgerActivity: () => [
          {
            id: 1,
            createdAt: "2026-07-14T14:00:00.000Z",
            assetClass: "option",
            symbol: callA,
            side: "buy",
            status: "filled",
            quantity: "1",
            limitPrice: "1.25",
            estimatedPremium: 125,
            clientOrderId: "entry-shared-1",
            brokerOrderId: "broker-order-1",
            rawResponse: {
              filled_qty: "1",
              filled_avg_price: "1.20",
              status: "filled"
            }
          }
        ]
      })
    );

    assert.equal(evidence.complete, true);
    assert.equal(evidence.dailyTradeCount, 1);
    assert.equal(evidence.dailyPremium, 120);
  });

  test("counts legacy reviewed and Level 2 entries without double counting", () => {
    const evidence = buildZeroDteActivityEvidence(
      { tradingDate, asOf, positions: [], orders: [] },
      sources({
        listLedgerActivity: () => [
          {
            id: 10,
            createdAt: "2026-07-14T14:00:00.000Z",
            assetClass: "option",
            symbol: callA,
            side: "buy",
            status: "accepted",
            quantity: "1",
            limitPrice: "1.00",
            estimatedPremium: 100,
            clientOrderId: "legacy-reviewed-entry",
            brokerOrderId: "legacy-broker",
            rawResponse: null
          }
        ],
        listLevel2Activity: () => [
          {
            paperTradeId: "level2-trade-1",
            sourceLedgerId: 11,
            tradingDate,
            optionSymbol: callB,
            status: "open",
            quantity: 1,
            entryPremium: 1.5,
            realizedPnl: null,
            clientOrderId: "level2-entry",
            brokerOrderId: "level2-broker",
            requestedAt: "2026-07-14T14:05:00.000Z",
            filledAt: "2026-07-14T14:05:02.000Z",
            exitedAt: null
          }
        ]
      })
    );

    assert.equal(evidence.dailyTradeCount, 2);
    assert.equal(evidence.dailyPremium, 250);
    assert.equal(evidence.openOrderCount, 1);
    assert.equal(evidence.openPositionCount, 1);
    assert.equal(evidence.openExposureCount, 2);
  });

  test("uses New York trading dates while preserving active open exposure", () => {
    const evidence = buildZeroDteActivityEvidence(
      {
        tradingDate,
        asOf,
        positions: [],
        orders: [
          {
            id: "after-midnight-utc",
            client_order_id: "after-midnight-utc",
            symbol: callA,
            asset_class: "us_option",
            side: "buy",
            status: "accepted",
            qty: "1",
            limit_price: "1.00",
            created_at: "2026-07-14T03:30:00.000Z"
          }
        ]
      },
      sources()
    );

    assert.equal(evidence.dailyTradeCount, 0);
    assert.equal(evidence.dailyPremium, 0);
    assert.equal(evidence.openOrderCount, 1);
    assert.equal(evidence.openExposureCount, 1);
  });

  test("counts the union of open position and active order symbols", () => {
    const evidence = buildZeroDteActivityEvidence(
      {
        tradingDate,
        asOf,
        positions: [
          {
            symbol: callA,
            asset_class: "us_option",
            qty: "1",
            market_value: "100",
            current_price: "1"
          }
        ],
        orders: [
          {
            id: "open-same-symbol",
            client_order_id: "open-same-symbol",
            symbol: callA,
            asset_class: "us_option",
            side: "buy",
            status: "accepted",
            qty: "1",
            limit_price: "1.00",
            created_at: "2026-07-14T14:00:00.000Z"
          },
          {
            id: "open-other-symbol",
            client_order_id: "open-other-symbol",
            symbol: callB,
            asset_class: "us_option",
            side: "buy",
            status: "accepted",
            qty: "1",
            limit_price: "1.00",
            created_at: "2026-07-14T14:01:00.000Z"
          }
        ]
      },
      sources()
    );

    assert.equal(evidence.openPositionCount, 1);
    assert.equal(evidence.openOrderCount, 2);
    assert.equal(evidence.openExposureCount, 2);
  });

  test("derives realized loss from a generic closed 0DTE outcome", () => {
    const evidence = buildZeroDteActivityEvidence(
      { tradingDate, asOf, positions: [], orders: [] },
      sources({
        listGenericPositionActivity: () => [
          {
            positionLifecycleId: "position-1",
            optionSymbol: callA,
            status: "CLOSED",
            brokerEntryOrderId: "generic-broker-1",
            entryClientOrderId: "generic-entry-1",
            openedAt: "2026-07-14T14:00:00.000Z",
            closedAt: "2026-07-14T14:30:00.000Z",
            entryQuantity: 1,
            entryPrice: 1,
            realizedPnl: -75,
            outcomeCompletenessStatus: "COMPLETE",
            latestOutcomeRevisionJson: null
          }
        ]
      })
    );

    assert.equal(evidence.complete, true);
    assert.equal(evidence.dailyTradeCount, 1);
    assert.equal(evidence.dailyPremium, 100);
    assert.equal(evidence.dailyRealizedLoss, 75);
  });

  test("fails closed on a missing realized outcome or premium", () => {
    const missingOutcome = buildZeroDteActivityEvidence(
      { tradingDate, asOf, positions: [], orders: [] },
      sources({
        listGenericPositionActivity: () => [
          {
            positionLifecycleId: "position-missing-outcome",
            optionSymbol: callA,
            status: "CLOSED",
            brokerEntryOrderId: "generic-broker-missing",
            entryClientOrderId: "generic-entry-missing",
            openedAt: "2026-07-14T14:00:00.000Z",
            closedAt: "2026-07-14T14:30:00.000Z",
            entryQuantity: 1,
            entryPrice: 1,
            realizedPnl: null,
            outcomeCompletenessStatus: null,
            latestOutcomeRevisionJson: null
          }
        ]
      })
    );
    const missingPremium = buildZeroDteActivityEvidence(
      {
        tradingDate,
        asOf,
        positions: [],
        orders: [
          {
            id: "filled-without-price",
            client_order_id: "filled-without-price",
            symbol: callA,
            asset_class: "us_option",
            side: "buy",
            status: "filled",
            qty: "1",
            filled_qty: "1",
            created_at: "2026-07-14T14:00:00.000Z"
          }
        ]
      },
      sources()
    );

    assert.equal(missingOutcome.complete, false);
    assert.equal(missingOutcome.dailyRealizedLoss, null);
    assert.ok(
      missingOutcome.blockers.includes("ZERO_DTE_ACTIVITY_EVIDENCE_INCOMPLETE")
    );
    assert.equal(missingPremium.complete, false);
    assert.equal(missingPremium.dailyPremium, null);
    assert.ok(
      missingPremium.blockers.includes("ZERO_DTE_DAILY_PREMIUM_EVIDENCE_REQUIRED")
    );
  });

  test("fails closed when an authoritative activity source cannot be read", () => {
    const evidence = buildZeroDteActivityEvidence(
      { tradingDate, asOf, positions: [], orders: [] },
      sources({
        listLedgerActivity: () => {
          throw new Error("database busy");
        }
      })
    );

    assert.equal(evidence.complete, false);
    assert.equal(evidence.dailyTradeCount, null);
    assert.equal(evidence.dailyPremium, null);
    assert.equal(evidence.dailyRealizedLoss, null);
    assert.equal(evidence.openExposureCount, null);
    assert.ok(evidence.blockers.includes("ZERO_DTE_ACTIVITY_SOURCE_UNAVAILABLE"));
  });

  test("does not treat a partial closed-position outcome as complete loss evidence", () => {
    const evidence = buildZeroDteActivityEvidence(
      { tradingDate, asOf, positions: [], orders: [] },
      sources({
        listGenericPositionActivity: () => [
          {
            positionLifecycleId: "position-partial-outcome",
            optionSymbol: callA,
            status: "CLOSED",
            brokerEntryOrderId: "generic-broker-partial",
            entryClientOrderId: "generic-entry-partial",
            openedAt: "2026-07-14T14:00:00.000Z",
            closedAt: "2026-07-14T14:30:00.000Z",
            entryQuantity: 1,
            entryPrice: 1,
            realizedPnl: -25,
            outcomeCompletenessStatus: "PARTIAL",
            latestOutcomeRevisionJson: null
          }
        ]
      })
    );

    assert.equal(evidence.complete, false);
    assert.equal(evidence.dailyRealizedLoss, null);
    assert.ok(evidence.blockers.includes("ZERO_DTE_REALIZED_LOSS_EVIDENCE_REQUIRED"));
  });
});
