import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildHedgeCapitalEvidence } from "../src/services/hedgeCapitalEvidenceService.js";

const asOf = "2026-07-14T15:00:00.000Z";
const spyPut = "SPY260918P00500000";
const qqqPut = "QQQ260918P00450000";

describe("hedge capital evidence", () => {
  test("empty authoritative sources produce complete zero evidence", () => {
    const evidence = buildHedgeCapitalEvidence({
      asOf,
      allowedUnderlyings: ["SPY", "QQQ"],
      positions: [],
      orders: [],
      ledger: []
    });

    assert.equal(evidence.complete, true);
    assert.equal(evidence.existingHedgeExposure, 0);
    assert.equal(evidence.existingHedgePremium, 0);
    assert.equal(evidence.reservedHedgePremium, 0);
    assert.equal(evidence.dailyHedgePremiumUsed, 0);
    assert.equal(evidence.completedHedgePremium, 0);
    assert.equal(evidence.openHedgeOrderCount, 0);
    assert.match(evidence.fingerprint, /^[a-f0-9]{64}$/);
  });

  test("sums long-put positions and deduplicates a broker order from its ledger reservation", () => {
    const evidence = buildHedgeCapitalEvidence({
      asOf,
      allowedUnderlyings: ["SPY", "QQQ"],
      positions: [
        {
          symbol: spyPut,
          assetClass: "option",
          optionType: "put",
          quantity: 1,
          marketValue: 550,
          costBasis: 500
        }
      ],
      orders: [
        {
          brokerOrderId: "broker-reserved-1",
          clientOrderId: "client-reserved-1",
          symbol: qqqPut,
          assetClass: "us_option",
          side: "buy",
          positionIntent: "buy_to_open",
          status: "accepted",
          quantity: 1,
          limitPrice: 2,
          filledQuantity: 0,
          filledAveragePrice: null,
          createdAt: "2026-07-14T14:00:00.000Z"
        }
      ],
      ledger: [
        {
          ledgerId: 1,
          mode: "hedge-entry",
          strategy: "portfolio_hedge",
          symbol: qqqPut,
          side: "buy",
          status: "reserved",
          quantity: 1,
          limitPrice: 2,
          estimatedPremium: 200,
          clientOrderId: "client-reserved-1",
          brokerOrderId: "broker-reserved-1",
          createdAt: "2026-07-14T14:00:00.000Z",
          rawResponse: null
        }
      ]
    });

    assert.equal(evidence.complete, true);
    assert.equal(evidence.existingHedgeExposure, 550);
    assert.equal(evidence.existingHedgePremium, 500);
    assert.equal(evidence.reservedHedgePremium, 200);
    assert.equal(evidence.dailyHedgePremiumUsed, 200);
    assert.equal(evidence.completedHedgePremium, 0);
    assert.equal(evidence.openHedgeOrderCount, 1);
  });

  test("uses actual fills once and carries an unmaterialized fill into existing capital", () => {
    const evidence = buildHedgeCapitalEvidence({
      asOf,
      allowedUnderlyings: ["SPY", "QQQ"],
      positions: [
        {
          symbol: spyPut,
          assetClass: "option",
          optionType: "put",
          quantity: 1,
          marketValue: 550,
          costBasis: 500
        }
      ],
      orders: [
        {
          brokerOrderId: "broker-filled-1",
          clientOrderId: "client-filled-1",
          symbol: qqqPut,
          assetClass: "us_option",
          side: "buy",
          positionIntent: "buy_to_open",
          status: "filled",
          quantity: 1,
          limitPrice: 2,
          filledQuantity: 1,
          filledAveragePrice: 1.5,
          createdAt: "2026-07-14T14:00:00.000Z"
        }
      ],
      ledger: [
        {
          ledgerId: 2,
          mode: "hedge-entry",
          strategy: "portfolio_hedge",
          symbol: qqqPut,
          side: "buy",
          status: "filled",
          quantity: 1,
          limitPrice: 2,
          estimatedPremium: 200,
          clientOrderId: "client-filled-1",
          brokerOrderId: "broker-filled-1",
          createdAt: "2026-07-14T14:00:00.000Z",
          rawResponse: {
            status: "filled",
            filled_qty: "1",
            filled_avg_price: "1.5"
          }
        }
      ]
    });

    assert.equal(evidence.complete, true);
    assert.equal(evidence.completedHedgePremium, 150);
    assert.equal(evidence.dailyHedgePremiumUsed, 150);
    assert.equal(evidence.existingHedgePremium, 650);
    assert.equal(evidence.existingHedgeExposure, 700);
    assert.equal(evidence.openHedgeOrderCount, 0);
  });

  test("missing material position, reservation, or fill values fail closed", () => {
    const missingPosition = buildHedgeCapitalEvidence({
      asOf,
      allowedUnderlyings: ["SPY"],
      positions: [{
        symbol: spyPut,
        assetClass: "option",
        optionType: "put",
        quantity: 1,
        marketValue: null,
        costBasis: null
      }],
      orders: [],
      ledger: []
    });
    const missingOrder = buildHedgeCapitalEvidence({
      asOf,
      allowedUnderlyings: ["QQQ"],
      positions: [],
      orders: [{
        brokerOrderId: "broker-missing-price",
        clientOrderId: "client-missing-price",
        symbol: qqqPut,
        assetClass: "us_option",
        side: "buy",
        positionIntent: "buy_to_open",
        status: "filled",
        quantity: 1,
        limitPrice: null,
        filledQuantity: 1,
        filledAveragePrice: null,
        createdAt: "2026-07-14T14:00:00.000Z"
      }],
      ledger: []
    });
    const missingFillQuantity = buildHedgeCapitalEvidence({
      asOf,
      allowedUnderlyings: ["QQQ"],
      positions: [],
      orders: [{
        brokerOrderId: "broker-missing-fill-quantity",
        clientOrderId: "client-missing-fill-quantity",
        symbol: qqqPut,
        assetClass: "us_option",
        side: "buy",
        positionIntent: "buy_to_open",
        status: "filled",
        quantity: 1,
        limitPrice: 2,
        filledQuantity: null,
        filledAveragePrice: 1.5,
        createdAt: "2026-07-14T14:00:00.000Z"
      }],
      ledger: []
    });

    assert.equal(missingPosition.complete, false);
    assert.equal(missingPosition.existingHedgeExposure, null);
    assert.equal(missingPosition.existingHedgePremium, null);
    assert.ok(missingPosition.blockers.includes("HEDGE_CAPITAL_EVIDENCE_INCOMPLETE"));
    assert.equal(missingOrder.complete, false);
    assert.equal(missingOrder.completedHedgePremium, null);
    assert.equal(missingOrder.dailyHedgePremiumUsed, null);
    assert.ok(missingOrder.blockers.includes("HEDGE_COMPLETED_PREMIUM_EVIDENCE_REQUIRED"));
    assert.equal(missingFillQuantity.complete, false);
    assert.equal(missingFillQuantity.completedHedgePremium, null);
    assert.ok(
      missingFillQuantity.blockers.includes(
        "HEDGE_COMPLETED_PREMIUM_EVIDENCE_REQUIRED"
      )
    );
  });
});
