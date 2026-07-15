import assert from "node:assert/strict";
import test from "node:test";

import { buildHedgeConfig } from "../src/services/hedgeConfigService.js";
import { buildHedgeCapitalEvidence } from "../src/services/hedgeCapitalEvidenceService.js";
import { rankHedgeCandidates } from "../src/services/hedgeRecommendationService.js";
import {
  createHedgeExecutionReview,
  verifyHedgeExecutionReview,
  type HedgeExecutionReviewInput
} from "../src/services/hedgeExecutionReviewService.js";

const baseInput = (): HedgeExecutionReviewInput => ({
  accountHash: "account-hash-1",
  sourceRecommendationId: "hedge-rec-1",
  sourceSnapshotId: "snapshot-1",
  sourceRegimeId: "regime-1",
  riskModelVersion: "portfolio-risk-v1",
  regimeModelVersion: "market-regime-v1",
  configurationFingerprint: "config-hash-1",
  generatedAt: "2026-07-13T14:00:00.000Z",
  signingKey: "unit-test-signing-key",
  capitalEvidence: buildHedgeCapitalEvidence({
    asOf: "2026-07-13T14:00:00.000Z",
    allowedUnderlyings: ["SPY", "QQQ"],
    positions: [],
    orders: [],
    ledger: []
  }),
  candidate: {
    candidateId: "candidate-1",
    rank: 1,
    instrumentType: "protective_put",
    symbol: "SPY260918P00500000",
    underlying: "SPY",
    executable: true,
    expectedProtection: 1_000,
    estimatedCost: 500,
    units: 1,
    rationale: ["highest protection per premium dollar"],
    warnings: [],
    blockers: [],
    details: {
      expirationDate: "2026-09-18",
      daysToExpiration: 67,
      strikePrice: 500,
      underlyingPrice: 520,
      bid: 4.9,
      ask: 5.1,
      midpoint: 5,
      delta: -0.32,
      spreadPct: 0.04,
      quoteTimestamp: "2026-07-13T13:59:45.000Z",
      snapshotTimestamp: "2026-07-13T13:59:45.000Z",
      multiplier: 100,
      contractDeltaCoveragePct: 1,
      marketValueDeltaCoveragePct: 1
    }
  }
});

test("creates a deterministic HMAC-reviewed single long put payload", () => {
  const first = createHedgeExecutionReview(baseInput());
  const second = createHedgeExecutionReview(baseInput());

  assert.equal(first.reviewType, "entry");
  assert.equal(first.orderIntent.structure, "long_put");
  assert.equal(first.orderIntent.side, "buy_to_open");
  assert.equal(first.orderIntent.quantity, 1);
  assert.equal(first.orderIntent.limitPrice, 5);
  assert.equal(first.clientOrderId, second.clientOrderId);
  assert.equal(first.payloadHash, second.payloadHash);
  assert.equal(first.signature, second.signature);
  assert.match(first.signature, /^[a-f0-9]{64}$/);

  const verification = verifyHedgeExecutionReview({
    review: first,
    signingKey: "unit-test-signing-key",
    accountHash: "account-hash-1",
    configurationFingerprint: "config-hash-1",
    sourceSnapshotId: "snapshot-1",
    capitalEvidenceFingerprint: first.portfolioEvidence
      .capitalEvidenceFingerprint as string,
    asOf: "2026-07-13T14:00:01.000Z"
  });

  assert.equal(verification.valid, true);
  assert.deepEqual(verification.blockers, []);
});

test("rejects changed payloads, wrong keys, expired reviews, and account mismatches", () => {
  const review = createHedgeExecutionReview({
    ...baseInput(),
    generatedAt: "2026-07-13T14:00:00.000Z",
    reviewTtlSeconds: 60
  });
  const changed = {
    ...review,
    orderIntent: { ...review.orderIntent, quantity: 2 }
  };

  const changedResult = verifyHedgeExecutionReview({
    review: changed,
    signingKey: "unit-test-signing-key",
    asOf: "2026-07-13T14:00:01.000Z"
  });
  assert.equal(changedResult.valid, false);
  assert.ok(changedResult.blockers.includes("HEDGE_PAYLOAD_CHANGED"));

  const wrongKey = verifyHedgeExecutionReview({
    review,
    signingKey: "wrong-key",
    asOf: "2026-07-13T14:00:01.000Z"
  });
  assert.ok(wrongKey.blockers.includes("HEDGE_REVIEW_SIGNATURE_INVALID"));

  const expired = verifyHedgeExecutionReview({
    review,
    signingKey: "unit-test-signing-key",
    asOf: "2026-07-13T14:02:00.000Z"
  });
  assert.ok(expired.blockers.includes("HEDGE_REVIEW_EXPIRED"));

  const accountMismatch = verifyHedgeExecutionReview({
    review,
    signingKey: "unit-test-signing-key",
    accountHash: "different-account",
    asOf: "2026-07-13T14:00:01.000Z"
  });
  assert.ok(accountMismatch.blockers.includes("HEDGE_ACCOUNT_IDENTITY_MISMATCH"));

  const capitalEvidenceMismatch = verifyHedgeExecutionReview({
    review,
    signingKey: "unit-test-signing-key",
    capitalEvidenceFingerprint: "different-capital-evidence",
    asOf: "2026-07-13T14:00:01.000Z"
  });
  assert.ok(
    capitalEvidenceMismatch.blockers.includes("HEDGE_CAPITAL_EVIDENCE_CHANGED")
  );
  assert.ok(capitalEvidenceMismatch.blockers.includes("FRESH_REVIEW_REQUIRED"));
});

test("requires a supported executable long put and paper-only policy defaults are explicit", () => {
  const config = buildHedgeConfig();
  assert.deepEqual(config.executionPolicy.allowedStructures, ["long_put"]);
  assert.deepEqual(config.executionPolicy.allowedUnderlyings, ["SPY", "QQQ"]);
  assert.equal(config.executionPolicy.minDte, 30);
  assert.equal(config.executionPolicy.targetDte, 60);
  assert.equal(config.executionPolicy.maxDte, 120);
  assert.equal(config.executionPolicy.maxNewHedgePremiumPctEquity, 0.0075);
  assert.equal(config.executionPolicy.maxTotalHedgePremiumPctEquity, 0.02);
  assert.equal(config.executionPolicy.maxDailyHedgePremiumPctEquity, 0.01);

  assert.throws(
    () => createHedgeExecutionReview({ ...baseInput(), capitalEvidence: undefined }),
    /HEDGE_CAPITAL_EVIDENCE_INCOMPLETE/
  );

  assert.throws(
    () =>
      createHedgeExecutionReview({
        ...baseInput(),
        candidate: {
          ...baseInput().candidate,
          instrumentType: "put_spread",
          executable: false,
          blockers: ["MULTI_LEG_EXECUTION_UNSUPPORTED"]
        }
      }),
    /HEDGE_NO_EXECUTABLE_LONG_PUT/
  );
});

test("ranks one eligible long put and fail-closes unsupported or capped candidates", () => {
  const config = buildHedgeConfig();
  const ranked = rankHedgeCandidates({
    netProtectionTarget: 1_000,
    premiumBudget: 10_000,
    accountEquity: 1_000_000,
    scenarioDeclinePct: 8,
    config,
    asOf: "2026-07-13T14:00:00.000Z",
    options: [
      {
        optionSymbol: "SPY260918P00500000",
        underlying: "SPY",
        expirationDate: "2026-09-18",
        daysToExpiration: 67,
        strikePrice: 500,
        underlyingPrice: 520,
        bid: 4.9,
        ask: 5.1,
        midpoint: 5,
        delta: -0.32,
        openInterest: 5_000,
        volume: 1_000,
        theta: -0.04,
        quoteTimestamp: "2026-07-13T13:59:45.000Z"
      },
      {
        optionSymbol: "QQQ261218P00400000",
        underlying: "QQQ",
        expirationDate: "2026-12-18",
        daysToExpiration: 158,
        strikePrice: 400,
        underlyingPrice: 450,
        bid: 2,
        ask: 8,
        midpoint: 5,
        delta: -0.3,
        openInterest: 5_000,
        volume: 1_000
      },
      {
        optionSymbol: "IWM260918P00100000",
        underlying: "IWM",
        expirationDate: "2026-09-18",
        daysToExpiration: 67,
        strikePrice: 100,
        underlyingPrice: 110,
        bid: 4,
        ask: 4.5,
        midpoint: 4.25,
        delta: -0.3,
        openInterest: 5_000,
        volume: 1_000
      }
    ]
  });

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.symbol, "SPY260918P00500000");
  assert.equal(ranked[0]?.executable, true);
});
