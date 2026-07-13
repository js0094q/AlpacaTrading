import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildZeroDteCandidateId,
  buildZeroDteClientOrderId,
  buildZeroDteDecisionId
} from "../src/services/zeroDte/zeroDteIdentityService.js";
import type { ZeroDteCandidateIdentityInput } from "../src/services/zeroDte/zeroDteIdentityService.js";

const baseIdentity: ZeroDteCandidateIdentityInput = {
  tradingDate: "2026-07-13",
  underlying: "SPY",
  optionSymbol: "SPY260713C00500000",
  playbook: "trend_continuation",
  direction: "bullish",
  expirationDate: "2026-07-13",
  strike: 500
};

test("equivalent canonical candidate inputs produce the same stable ID", () => {
  const normalizedIdentity: ZeroDteCandidateIdentityInput = {
    ...baseIdentity,
    tradingDate: " 2026-07-13 ",
    underlying: " spy ",
    optionSymbol: " spy260713c00500000 ",
    expirationDate: " 2026-07-13 ",
    strike: 500.0
  };

  const candidateId = buildZeroDteCandidateId(baseIdentity);

  assert.equal(buildZeroDteCandidateId(normalizedIdentity), candidateId);
  assert.match(candidateId, /^zdt_[a-f0-9]{64}$/);
});

test("every candidate identity field participates in the candidate ID", () => {
  const variants: Array<[string, ZeroDteCandidateIdentityInput]> = [
    ["trading date", { ...baseIdentity, tradingDate: "2026-07-14" }],
    ["underlying", { ...baseIdentity, underlying: "QQQ" }],
    ["option symbol", { ...baseIdentity, optionSymbol: "SPY260713P00500000" }],
    ["playbook", { ...baseIdentity, playbook: "reversal" }],
    ["direction", { ...baseIdentity, direction: "bearish" }],
    ["expiration date", { ...baseIdentity, expirationDate: "2026-07-14" }],
    ["strike", { ...baseIdentity, strike: 501 }]
  ];
  const candidateId = buildZeroDteCandidateId(baseIdentity);

  for (const [field, variant] of variants) {
    assert.notEqual(
      buildZeroDteCandidateId(variant),
      candidateId,
      `changing ${field} must change the candidate ID`
    );
  }
});

test("decision IDs are deterministic and scoped to both run and candidate", () => {
  const candidateId = buildZeroDteCandidateId(baseIdentity);
  const decisionId = buildZeroDteDecisionId("run-2026-07-13-1", candidateId);

  assert.equal(buildZeroDteDecisionId("run-2026-07-13-1", candidateId), decisionId);
  assert.notEqual(buildZeroDteDecisionId("run-2026-07-13-2", candidateId), decisionId);
  assert.notEqual(buildZeroDteDecisionId("run-2026-07-13-1", `${candidateId}x`), decisionId);
  assert.match(decisionId, /^zdec_[a-f0-9]{64}$/);
});

test("client order IDs are stable, bounded, and broker-safe", () => {
  const candidateId = buildZeroDteCandidateId(baseIdentity);
  const input = {
    tradingDate: "2026-07-13",
    candidateId,
    action: "entry" as const,
    attempt: 1
  };
  const clientOrderId = buildZeroDteClientOrderId(input);

  assert.equal(buildZeroDteClientOrderId({ ...input }), clientOrderId);
  assert.notEqual(
    buildZeroDteClientOrderId({ ...input, action: "exit" }),
    clientOrderId
  );
  assert.notEqual(
    buildZeroDteClientOrderId({ ...input, attempt: 2 }),
    clientOrderId
  );
  assert.ok(clientOrderId.length <= 48);
  assert.match(clientOrderId, /^zord_[a-z0-9_]+$/);
});
