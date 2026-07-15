import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  createZeroDteSubmitAttestation,
  verifyZeroDteSubmitAttestation
} from "../src/services/zeroDte/zeroDteSubmitAttestationService.js";

const signingKey = "zero-dte-submit-attestation-test-key";
const createdAt = "2026-07-14T14:30:00.000Z";

const input = () => ({
  decisionId: "decision-1",
  candidateId: "candidate-1",
  tradingDate: "2026-07-14",
  strategyVersion: "zero-dte-level-2-v1",
  configurationVersionId: "configuration-1",
  accountIdentityHash: "account-hash-1",
  accountStateFingerprint: "account-state-1",
  activityEvidenceFingerprint: "activity-1",
  allocationIdentity: "baseline-v1" as const,
  submitPriceDriftLimitPct: 10,
  orderIntent: {
    symbol: "SPY260714C00500000",
    underlying: "SPY",
    direction: "bullish",
    side: "buy",
    positionIntent: "buy_to_open",
    quantity: 1,
    limitPrice: 1.25,
    estimatedPremium: 125,
    quoteTimestamp: createdAt,
    quoteFingerprint: "quote-1",
    clientOrderId: "zero-dte-client-1"
  },
  createdAt,
  ttlSeconds: 300,
  signingKey
});

const expected = () => {
  const value = input();
  return {
    decisionId: value.decisionId,
    candidateId: value.candidateId,
    tradingDate: value.tradingDate,
    strategyVersion: value.strategyVersion,
    configurationVersionId: value.configurationVersionId,
    accountIdentityHash: value.accountIdentityHash,
    accountStateFingerprint: value.accountStateFingerprint,
    activityEvidenceFingerprint: value.activityEvidenceFingerprint,
    allocationIdentity: value.allocationIdentity,
    submitPriceDriftLimitPct: value.submitPriceDriftLimitPct,
    orderIntent: value.orderIntent
  };
};

describe("0DTE submit attestation", () => {
  test("creation is deterministic and verifies exact signed evidence", () => {
    const first = createZeroDteSubmitAttestation(input());
    const second = createZeroDteSubmitAttestation(input());
    const verification = verifyZeroDteSubmitAttestation({
      attestation: first,
      signingKey,
      asOf: "2026-07-14T14:31:00.000Z",
      expected: expected()
    });

    assert.deepEqual(first, second);
    assert.match(first.attestationId, /^zero_dte_attest_[a-f0-9]{24}$/);
    assert.match(first.payloadHash, /^[a-f0-9]{64}$/);
    assert.match(first.signature, /^[a-f0-9]{64}$/);
    assert.equal(verification.valid, true);
    assert.deepEqual(verification.blockers, []);
  });

  test("wrong keys and payload tampering fail signature verification", () => {
    const attestation = createZeroDteSubmitAttestation(input());
    const wrongKey = verifyZeroDteSubmitAttestation({
      attestation,
      signingKey: "wrong-key",
      expected: expected()
    });
    const tampered = verifyZeroDteSubmitAttestation({
      attestation: {
        ...attestation,
        orderIntent: { ...attestation.orderIntent, quantity: 2 }
      },
      signingKey,
      expected: expected()
    });

    assert.equal(wrongKey.valid, false);
    assert.ok(wrongKey.blockers.includes("ZERO_DTE_SUBMIT_ATTESTATION_INVALID"));
    assert.equal(tampered.valid, false);
    assert.ok(tampered.blockers.includes("ZERO_DTE_SUBMIT_ATTESTATION_INVALID"));
  });

  test("expiry fails closed", () => {
    const verification = verifyZeroDteSubmitAttestation({
      attestation: createZeroDteSubmitAttestation(input()),
      signingKey,
      asOf: "2026-07-14T14:35:00.001Z",
      expected: expected()
    });

    assert.equal(verification.valid, false);
    assert.ok(verification.blockers.includes("ZERO_DTE_SUBMIT_ATTESTATION_EXPIRED"));
  });

  test("candidate, configuration, and quote drift are explicit", () => {
    const attestation = createZeroDteSubmitAttestation(input());
    const drifted = expected();
    drifted.candidateId = "candidate-2";
    drifted.configurationVersionId = "configuration-2";
    drifted.orderIntent = {
      ...drifted.orderIntent,
      quoteTimestamp: "2026-07-14T14:30:01.000Z"
    };
    const verification = verifyZeroDteSubmitAttestation({
      attestation,
      signingKey,
      expected: drifted
    });

    assert.equal(verification.valid, false);
    assert.ok(verification.blockers.includes("ZERO_DTE_CANDIDATE_MISMATCH"));
    assert.ok(verification.blockers.includes("ZERO_DTE_CONFIGURATION_MISMATCH"));
    assert.ok(verification.blockers.includes("ZERO_DTE_ORDER_INTENT_DRIFT"));
    assert.ok(verification.blockers.includes("FRESH_REVIEW_REQUIRED"));
  });

  test("account identity, account state, and activity drift are explicit", () => {
    const attestation = createZeroDteSubmitAttestation(input());
    const drifted = expected();
    drifted.accountIdentityHash = "account-hash-2";
    drifted.accountStateFingerprint = "account-state-2";
    drifted.activityEvidenceFingerprint = "activity-2";
    const verification = verifyZeroDteSubmitAttestation({
      attestation,
      signingKey,
      expected: drifted
    });

    assert.equal(verification.valid, false);
    assert.ok(verification.blockers.includes("ZERO_DTE_ACCOUNT_IDENTITY_MISMATCH"));
    assert.ok(verification.blockers.includes("ZERO_DTE_ACCOUNT_STATE_DRIFT"));
    assert.ok(verification.blockers.includes("ZERO_DTE_ACTIVITY_EVIDENCE_DRIFT"));
    assert.ok(verification.blockers.includes("FRESH_REVIEW_REQUIRED"));
  });

  test("a signing key is mandatory", () => {
    assert.throws(
      () => createZeroDteSubmitAttestation({ ...input(), signingKey: "" }),
      /PAPER_REVIEW_SIGNING_KEY_REQUIRED/
    );
    const attestation = createZeroDteSubmitAttestation(input());
    const verification = verifyZeroDteSubmitAttestation({
      attestation,
      signingKey: "",
      expected: expected()
    });
    assert.equal(verification.valid, false);
    assert.ok(verification.blockers.includes("ZERO_DTE_SUBMIT_ATTESTATION_INVALID"));
  });
});
