# Adaptive Allocation Safety-Floor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authenticate every paper new-risk decision, revalidate it against fresh portfolio state, and close the scale-in, 0DTE, hedge, direct-confirm, and late-day artifact gaps without implementing adaptive allocation.

**Architecture:** Preserve the existing domain executors. Add a focused general submit-state attestation service, a 0DTE activity/attestation service, and a hedge capital-evidence service; each existing executor consumes its domain evidence immediately before mutation. Persist canonical signed records and structured blockers while keeping exits, recovery, reconciliation, and protection independent from positive entry capacity.

**Tech Stack:** TypeScript, Node.js 22, `node:test`, `node:crypto` HMAC-SHA256, Node SQLite, existing Alpaca paper adapters, Next.js dashboard bridge, systemd VPS services.

## Global Constraints

- Work only from `origin/main@29f4a814d39cebc6f66b371571a92fe58228f6e1` in `.worktrees/adaptive-allocation-safety-floor`.
- Paper only: `ALPACA_ENV=paper`, `TRADING_MODE=paper`, `ALPACA_LIVE_TRADE=false`, and `LIVE_TRADING_ENABLED=false`.
- Do not submit a manual, forced, synthetic, or fabricated paper order.
- Do not implement Release 1 evidence/schema, Release 2 shadow, Release 3 advisory, or Release 4 enforced-paper allocation.
- Do not increase caps, weaken gates, resize inline, expose a public mutation route, or make an allocator own exits.
- Use additive, idempotent SQLite changes only; preserve all audit history.
- Preserve the `$250` equity scale-in default and the installed/source sizing baseline.
- Every production behavior change starts with a failing focused test.
- One branch, one pull request, one independent review, and at most one follow-up review after corrections.

---

## Execution status (2026-07-14)

- Tasks 1-8 are implemented in commits `0b597b4`, `9e77a27`, `79574b2`,
  `aa177d8`, `561653c`, `0cb461d`, `3e96334`, and `e6eaf99`.
- Task 9 documentation and configuration synchronization is complete in this
  tree, including the redacted pre-deploy VPS sizing/signing-key snapshot.
- Task 10 validation, the single authorized independent review, one pull
  request, exact-SHA deployment, and Basic Memory Cloud readback remain gated
  work. No paper or live order has been submitted.
- Stop before Release 1. Later allocator releases remain unimplemented and
  unauthorized.

---

## File map

### New focused services

- `src/services/paperSubmitStateService.ts` — normalized general-entry state,
  fingerprints, market evidence, cap checks, and drift comparison.
- `src/services/zeroDte/zeroDteActivityEvidenceService.ts` — New York trading-day
  0DTE counters and cross-path identity deduplication.
- `src/services/zeroDte/zeroDteSubmitAttestationService.ts` — canonical signed
  0DTE submit record and verification.
- `src/services/hedgeCapitalEvidenceService.ts` — existing, reserved, daily,
  completed, and open-order hedge evidence.
- `tests/paperSubmitStateService.test.ts`,
  `tests/zeroDteActivityEvidence.test.ts`, and
  `tests/hedgeCapitalEvidenceService.test.ts` — focused pure/evidence coverage.

### Existing integration surfaces

- `src/services/paperReviewArtifactService.ts` — sign and verify full artifacts.
- `src/services/paperOpsWorkflowService.ts` — capture signed state and create a
  fresh late-day artifact.
- `src/services/paperReviewedPayloadExecutionService.ts` — verify, refresh,
  compare, reserve, and submit entries while preserving independent exits.
- `src/services/paperExecutionLedgerService.ts` — active-reservation reads and
  atomic reviewed-entry reservation.
- `src/services/paperPlanService.ts` and
  `src/services/paperPortfolioReviewService.ts` — expose the normalized baseline
  caps and apply them to scale-ins.
- `src/services/zeroDte/zeroDteExecutionService.ts` and
  `src/services/zeroDte/zeroDteLifecycleService.ts` — populate counters, count
  open orders, persist signed attestation, and compare fresh state.
- `src/services/hedgeConfigService.ts`,
  `src/services/hedgeRecommendationService.ts`,
  `src/services/hedgeExecutionReviewService.ts`,
  `src/services/hedgeLearningService.ts`, and
  `src/services/hedgeExecutionService.ts` — correct ratios and enforce real
  hedge-capital evidence.
- `src/cli.ts`, `server/dashboard-control/server.ts`,
  `apps/dashboard/lib/data.ts`, and
  `apps/dashboard/app/api/paper/_lib/routeHelpers.ts` — remove direct-confirm
  bypass and implicit confirmation.
- `.env.example`, `README.md`, `RESUME_CONTEXT.md`, `server/README.md`,
  `server/RESUME_CONTEXT.md`, `docs/ARCHITECTURE.md`, and
  `docs/paper-monitoring-operations.md` — synchronize operational contracts.

### Task 1: Sign and verify general review artifacts

**Files:**
- Create: `tests/paperReviewArtifactService.test.ts`
- Modify: `src/services/paperReviewArtifactService.ts`
- Modify: `tests/paperReviewedPayloadExecutionService.test.ts`
- Modify: `tests/paperOpsWorkflowService.test.ts`

**Interfaces:**
- Produces: `PaperSubmitStateAttestation`, `verifyPaperReviewArtifact()`,
  `paperReviewArtifactSigningKey()`, and signed artifact fields
  `recordType`, `signatureAlgorithm`, `artifactHash`, and `signature`.
- Consumes: `canonicalJsonHash()` and `PAPER_REVIEW_SIGNING_KEY`.

- [ ] **Step 1: Write signature tests.** Add tests that set
  `PAPER_REVIEW_SIGNING_KEY=paper-review-test-key`, create one artifact, and
  assert valid verification, wrong-key rejection, JSON tamper rejection,
  database payload-hash mismatch rejection, unsigned legacy rejection, and
  expiry rejection.

```ts
const verification = verifyPaperReviewArtifact({ artifact, asOf: now });
assert.equal(verification.valid, true);
assert.deepEqual(verification.blockers, []);
assert.ok(
  verifyPaperReviewArtifact({ artifact: tampered, asOf: now }).blockers
    .includes("REVIEW_ARTIFACT_PAYLOAD_CHANGED")
);
```

- [ ] **Step 2: Run the focused tests to verify RED.**

Run: `npx tsx --test tests/paperReviewArtifactService.test.ts`

Expected: FAIL because `verifyPaperReviewArtifact` and signed artifact fields
do not exist.

- [ ] **Step 3: Implement canonical HMAC artifacts.** Sign the canonical
  unsigned artifact hash with HMAC-SHA256, compare signatures with
  `timingSafeEqual`, verify both the stored payload hash and recalculated
  artifact hash, and require a non-empty signing key.

```ts
const artifactHash = canonicalJsonHash(unsignedArtifact);
const signature = createHmac("sha256", signingKey)
  .update(artifactHash)
  .digest("hex");
```

Legacy artifacts without `recordType: "paper_review_artifact"`,
`signatureAlgorithm: "hmac-sha256"`, `artifactHash`, or `signature` return
`REVIEW_ARTIFACT_SIGNATURE_INVALID`; creation without the key throws
`PAPER_REVIEW_SIGNING_KEY_REQUIRED`.

- [ ] **Step 4: Run signature and existing artifact consumers.**

Run: `npx tsx --test tests/paperReviewArtifactService.test.ts tests/paperReviewedPayloadExecutionService.test.ts tests/paperOpsWorkflowService.test.ts`

Expected: PASS with all fixtures explicitly signed.

- [ ] **Step 5: Commit the authenticated artifact slice.**

```bash
git add -- src/services/paperReviewArtifactService.ts tests/paperReviewArtifactService.test.ts tests/paperReviewedPayloadExecutionService.test.ts tests/paperOpsWorkflowService.test.ts
git commit -m "Harden paper review artifact signatures"
```

### Task 2: Capture and compare fresh general-entry state

**Files:**
- Create: `src/services/paperSubmitStateService.ts`
- Create: `tests/paperSubmitStateService.test.ts`
- Modify: `src/services/paperPlanService.ts`
- Modify: `src/services/paperExecutionLedgerService.ts`

**Interfaces:**
- Produces:

```ts
export interface PaperSubmitStateAttestation {
  version: "paper-submit-state-v1";
  capturedAt: string;
  accountIdentityHash: string | null;
  accountState: Record<string, string | number | boolean | null>;
  configurationFingerprint: string;
  structuralPortfolioFingerprint: string;
  portfolioFingerprint: string;
  marketEvidenceFingerprint: string;
  allocationAttestation: {
    mode: "baseline";
    identity: "baseline-v1";
    allocatorControlled: false;
  };
  payloadIntents: PaperSubmitIntent[];
  complete: boolean;
  blockers: string[];
  warnings: string[];
}

export const capturePaperSubmitState: (input: {
  capturedAt: string;
  payloadSections: ReviewedPayloadSections;
}, deps?: PaperSubmitStateDeps) => Promise<PaperSubmitStateAttestation>;

export const validatePaperSubmitState: (input: {
  reviewed: PaperSubmitStateAttestation;
  current: PaperSubmitStateAttestation;
  sections: ReviewedPayloadSectionName[];
}) => PaperSubmitStateValidation;
```

- Consumes: normalized plan config exported as
  `loadPaperPlanConfig()`, Alpaca paper account/position/order/snapshot reads,
  and active execution-ledger reservations.

- [ ] **Step 1: Write failing state/cap tests.** Cover stable-state acceptance;
  account/config/position/order/reservation drift; missing cash, quantity,
  market value, or quote; source identity mismatch; stale quote; price drift;
  duplicate entry; cash reserve; per-order, position, total plan, portfolio
  deployment, buying-power, and option-premium caps; and fixed
  `baseline-v1` allocation identity.

```ts
const result = validatePaperSubmitState({
  reviewed,
  current: { ...reviewed, configurationFingerprint: "changed" },
  sections: ["equityBuys"]
});
assert.equal(result.valid, false);
assert.ok(result.blockers.includes("SUBMIT_CONFIGURATION_DRIFT"));
assert.ok(result.blockers.includes("FRESH_REVIEW_REQUIRED"));
```

- [ ] **Step 2: Run the state tests to verify RED.**

Run: `npx tsx --test tests/paperSubmitStateService.test.ts`

Expected: FAIL because the state service does not exist.

- [ ] **Step 3: Expose the existing normalized plan configuration.** Rename
  the internal config builder to exported `loadPaperPlanConfig` without
  changing defaults or call-site behavior.

```ts
export const loadPaperPlanConfig = (
  input: PaperPlanInput = {}
): Required<PaperPlanConfig> => ({
  // existing normalization and existing defaults only
});
```

- [ ] **Step 4: Add active-reservation and atomic reservation helpers.** Read
  active buy-side ledger rows in `reserved`, `attempted`, `submitted`,
  `accepted`, `partial`, and `partially_filled` states. Reserve reviewed
  entries with the unique deterministic client-order ID inside an immediate
  SQLite transaction and return `SUBMIT_DUPLICATE_ORDER_OR_RESERVATION` on a
  collision.

```ts
export const reserveReviewedPaperExecution = (input: ReviewedReservationInput) =>
  withImmediateTransaction(() => {
    const existing = findPaperExecutionByClientOrderId(input.clientOrderId);
    if (existing && ACTIVE_RESERVATION_STATUSES.has(existing.status)) {
      return { reserved: false as const, entry: existing };
    }
    return { reserved: true as const, entry: insertPaperExecutionLedgerEntry({
      ...input,
      status: "reserved"
    }) };
  });
```

- [ ] **Step 5: Implement normalized capture and drift/cap validation.** Keep
  raw credentials, authorization headers, account IDs, broker IDs, and full
  environment data out of the attestation. Hash identifiers, sort every
  position/order/reservation/intent collection, and fail closed when material
  evidence is missing.

- [ ] **Step 6: Run focused tests and typecheck.**

Run: `npx tsx --test tests/paperSubmitStateService.test.ts`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the shared state floor.**

```bash
git add -- src/services/paperSubmitStateService.ts src/services/paperPlanService.ts src/services/paperExecutionLedgerService.ts tests/paperSubmitStateService.test.ts
git commit -m "Add fresh paper submit state validation"
```

### Task 3: Enforce signed fresh state in reviewed execution

**Files:**
- Modify: `src/services/paperOpsWorkflowService.ts`
- Modify: `src/services/paperReviewedPayloadExecutionService.ts`
- Modify: `tests/paperOpsWorkflowService.test.ts`
- Modify: `tests/paperReviewedPayloadExecutionService.test.ts`

**Interfaces:**
- Consumes: `capturePaperSubmitState`, `validatePaperSubmitState`,
  `verifyPaperReviewArtifact`, and `reserveReviewedPaperExecution`.
- Produces: signed review artifacts whose entry sections carry a complete
  `submitState`, and entry execution that returns structured blockers without
  calling `submitPaperOrder` on drift.

- [ ] **Step 1: Write failing integration tests.** Assert a stable signed entry
  submits once; tamper/state/config/source/price/reservation drift submits zero;
  a missing source candidate blocks; a reservation is linked to artifact,
  section, payload index, and decision; and a valid exit still submits when the
  entry-state validator rejects allocation room.

```ts
assert.equal(entryReport.status, "blocked");
assert.equal(entryBrokerCalls, 0);
assert.ok(entryReport.blocked.some((row) => row.reason === "FRESH_REVIEW_REQUIRED"));
assert.deepEqual(exitSubmittedSymbols, ["MSFT"]);
```

- [ ] **Step 2: Run integration tests to verify RED.**

Run: `npx tsx --test tests/paperOpsWorkflowService.test.ts tests/paperReviewedPayloadExecutionService.test.ts`

Expected: FAIL because workflows do not capture state and the executor does not
verify or compare it.

- [ ] **Step 3: Capture state before artifact persistence.** In
  `runPaperOpsReview`, build sections, capture the state attestation, merge its
  blockers/warnings, and pass it to `createPaperReviewArtifact`. Require exact
  source candidate IDs for `equityBuys`, `equityAdds`, and `optionBuys`.

- [ ] **Step 4: Verify and partition before execution.** Verify the signed
  artifact and TTL before normalization. Partition entry sections from exits.
  Capture and compare fresh state only when an entry section is requested.
  Convert state failures into per-entry blocked rows and continue eligible
  exits independently.

- [ ] **Step 5: Reserve before broker mutation.** Replace direct `attempted`
  insertion with `reserveReviewedPaperExecution`; update the reserved row to
  `attempted` immediately before submission and reuse that row for all broker
  and reconciliation updates. Require exact entry decision and candidate
  linkage.

- [ ] **Step 6: Run focused tests.**

Run: `npx tsx --test tests/paperSubmitStateService.test.ts tests/paperReviewArtifactService.test.ts tests/paperOpsWorkflowService.test.ts tests/paperReviewedPayloadExecutionService.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit reviewed execution hardening.**

```bash
git add -- src/services/paperOpsWorkflowService.ts src/services/paperReviewedPayloadExecutionService.ts tests/paperOpsWorkflowService.test.ts tests/paperReviewedPayloadExecutionService.test.ts
git commit -m "Enforce fresh state for reviewed paper entries"
```

### Task 4: Make equity scale-ins fail closed under ordinary caps

**Files:**
- Modify: `src/services/paperPortfolioReviewService.ts`
- Modify: `tests/paperPortfolioReviewService.test.ts`

**Interfaces:**
- Consumes: `loadPaperPlanConfig`, `listAlpacaOpenOrders`, and active new-risk
  reservations.
- Produces: scale-in payloads with exact `sourceCandidateId` only after all
  ordinary reserve/deployment/position checks pass.

- [ ] **Step 1: Write failing scale-in tests.** Cover missing quantity, missing
  market value, missing equity/cash/buying power, open same-symbol order,
  active reservation, cash-reserve breach, portfolio deployment cap, position
  cap, and a valid `$250` case.

```ts
assert.equal(report.recommendations[0]?.recommendation, "HOLD_EQUITY");
assert.equal(
  report.recommendations[0]?.skippedReason,
  "SCALE_IN_POSITION_EVIDENCE_INCOMPLETE"
);
```

- [ ] **Step 2: Run scale-in tests to verify RED.**

Run: `npx tsx --test tests/paperPortfolioReviewService.test.ts`

Expected: missing market value is incorrectly accepted and duplicate/cap tests
fail.

- [ ] **Step 3: Select stable candidate identity.** Include candidate `id` in
  the latest-candidate query and carry it as `sourceCandidateId` in the payload.

- [ ] **Step 4: Apply ordinary cap math.** Require finite positive position and
  account evidence, sum current deployed market value and active reservations,
  enforce the normalized cash reserve, per-order, position, total-plan, and
  portfolio deployment limits, and reject duplicate same-symbol buys. Do not
  lower or change the configured `$250` amount inline.

- [ ] **Step 5: Run scale-in and plan tests.**

Run: `npx tsx --test tests/paperPortfolioReviewService.test.ts tests/paperPlanService.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit scale-in hardening.**

```bash
git add -- src/services/paperPortfolioReviewService.ts tests/paperPortfolioReviewService.test.ts
git commit -m "Fail closed equity scale-in sizing"
```

### Task 5: Populate all-path 0DTE activity evidence

**Files:**
- Create: `src/services/zeroDte/zeroDteActivityEvidenceService.ts`
- Create: `tests/zeroDteActivityEvidence.test.ts`
- Modify: `src/services/zeroDte/zeroDteTypes.ts`
- Modify: `src/services/zeroDte/zeroDteExecutionService.ts`
- Modify: `tests/zeroDteExecution.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ZeroDteActivityEvidence {
  tradingDate: string;
  complete: boolean;
  dailyTradeCount: number | null;
  dailyPremium: number | null;
  dailyRealizedLoss: number | null;
  openPositionCount: number;
  openOrderCount: number;
  openExposureCount: number;
  blockers: string[];
  warnings: string[];
  evidenceFingerprint: string;
}

export const buildZeroDteActivityEvidence: (input: {
  tradingDate: string;
  asOf: string;
  positions: AlpacaPositionRaw[];
  orders: AlpacaSubmittedOrder[];
}) => ZeroDteActivityEvidence;
```

- Consumes: broker positions/orders, `paper_execution_ledger`,
  `zero_dte_paper_trades`, `paper_positions`, and `paper_position_outcomes`.

- [ ] **Step 1: Write failing evidence tests.** Cover broker/ledger duplicate
  identity, legacy reviewed entry plus Level 2 entry, reserved versus completed
  premium, exact New York date rollover, open orders consuming exposure, closed
  trade realized loss, a missing outcome, and a filled order with missing
  premium evidence.

```ts
assert.equal(evidence.dailyTradeCount, 2);
assert.equal(evidence.openExposureCount, 2);
assert.ok(
  incomplete.blockers.includes("ZERO_DTE_ACTIVITY_EVIDENCE_INCOMPLETE")
);
```

- [ ] **Step 2: Run evidence tests to verify RED.**

Run: `npx tsx --test tests/zeroDteActivityEvidence.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement deterministic New York accounting.** Parse OCC
  expiration, classify active and terminal broker states, merge broker/ledger
  rows by broker ID then client ID, use actual fill premium when present and
  conservative reserved maximum otherwise, and deduplicate generic/Level 2
  realized outcomes by entry client-order identity. Any material unknown makes
  `complete=false`.

- [ ] **Step 4: Populate the concrete account adapter.** Have
  `accountFromProvider` pass the broker reads into the evidence service and set
  all daily counters and activity completeness fields. Eligibility blocks null
  counters or incomplete evidence with
  `ZERO_DTE_DAILY_COUNTER_EVIDENCE_REQUIRED`. Count the union of open same-day
  position and active-order symbols against `maxOpenPositions`.

- [ ] **Step 5: Run 0DTE evidence and execution tests.**

Run: `npx tsx --test tests/zeroDteActivityEvidence.test.ts tests/zeroDteExecution.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit 0DTE accounting.**

```bash
git add -- src/services/zeroDte/zeroDteActivityEvidenceService.ts src/services/zeroDte/zeroDteTypes.ts src/services/zeroDte/zeroDteExecutionService.ts tests/zeroDteActivityEvidence.test.ts tests/zeroDteExecution.test.ts
git commit -m "Enforce complete 0DTE activity limits"
```

### Task 6: Add a signed 0DTE submit attestation and fresh comparison

**Files:**
- Create: `src/services/zeroDte/zeroDteSubmitAttestationService.ts`
- Create: `tests/zeroDteSubmitAttestation.test.ts`
- Modify: `src/services/zeroDte/zeroDteLifecycleService.ts`
- Modify: `src/services/zeroDte/zeroDteExecutionService.ts`
- Modify: `tests/zeroDteExecution.test.ts`

**Interfaces:**
- Produces `createZeroDteSubmitAttestation`,
  `verifyZeroDteSubmitAttestation`, and the append-only lifecycle event type
  `execution_attested`.

```ts
export interface ZeroDteSubmitAttestation {
  recordType: "zero_dte_submit_attestation";
  decisionId: string;
  candidateId: string;
  configurationVersionId: string;
  accountStateFingerprint: string;
  activityEvidenceFingerprint: string;
  allocationIdentity: "baseline-v1";
  orderIntent: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  payloadHash: string;
  signature: string;
  signatureAlgorithm: "hmac-sha256";
}
```

- [ ] **Step 1: Write failing attestation tests.** Cover deterministic creation,
  valid verification, wrong key, tamper, expiry, candidate/config/quote drift,
  account/activity drift, and missing signing key.

- [ ] **Step 2: Run attestation tests to verify RED.**

Run: `npx tsx --test tests/zeroDteSubmitAttestation.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement HMAC attestation.** Reuse canonical JSON hashing and
  constant-time HMAC comparison. Use `PAPER_REVIEW_SIGNING_KEY`; missing key is
  `ZERO_DTE_SUBMIT_ATTESTATION_INVALID` at execution.

- [ ] **Step 4: Persist then refresh before mutation.** After the first complete
  account/activity read, create and append `execution_attested` with exact
  decision/candidate/config/order evidence. Perform one fresh read, verify the
  attestation against it, and only then reserve and submit. Any mismatch writes
  a blocked ledger row and calls no broker mutation.

- [ ] **Step 5: Strengthen decision linkage.** Compare persisted decision and
  candidate trading date, strategy/configuration identity, option/underlying,
  direction/side, quantity, quote timestamp, and canonical intent. Do not
  resize or reprice.

- [ ] **Step 6: Run 0DTE tests.**

Run: `npx tsx --test tests/zeroDteSubmitAttestation.test.ts tests/zeroDteActivityEvidence.test.ts tests/zeroDteExecution.test.ts tests/zeroDteEngine.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit signed 0DTE submission.**

```bash
git add -- src/services/zeroDte/zeroDteSubmitAttestationService.ts src/services/zeroDte/zeroDteLifecycleService.ts src/services/zeroDte/zeroDteExecutionService.ts tests/zeroDteSubmitAttestation.test.ts tests/zeroDteExecution.test.ts
git commit -m "Sign fresh 0DTE submit attestations"
```

### Task 7: Correct hedge ratios and require real capital evidence

**Files:**
- Create: `src/services/hedgeCapitalEvidenceService.ts`
- Create: `tests/hedgeCapitalEvidenceService.test.ts`
- Modify: `src/services/hedgeConfigService.ts`
- Modify: `src/services/hedgeRecommendationService.ts`
- Modify: `src/services/hedgeExecutionReviewService.ts`
- Modify: `src/services/hedgeLearningService.ts`
- Modify: `src/services/hedgeExecutionService.ts`
- Modify: `tests/hedgeExecutionReviewService.test.ts`
- Modify: `tests/hedgeRecommendationService.test.ts`
- Modify: `tests/hedgeExecutionService.test.ts`

**Interfaces:**
- Produces:

```ts
export interface HedgeCapitalEvidence {
  existingHedgeExposure: number | null;
  existingHedgePremium: number | null;
  reservedHedgePremium: number | null;
  dailyHedgePremiumUsed: number | null;
  completedHedgePremium: number | null;
  openHedgeOrderCount: number | null;
  complete: boolean;
  blockers: string[];
  fingerprint: string;
}
```

- Consumes: current long-put positions, recent broker orders, and hedge-entry
  ledger rows.

- [ ] **Step 1: Write failing ratio/evidence tests.** Assert absent env values
  equal `0.0075`, `0.02`, and `0.01`; explicit `0.75`, `2`, and `1` normalize
  identically; real positions/reservations/fills/open orders are summed and
  deduplicated; and missing cost/fill premium is incomplete rather than zero.

```ts
assert.equal(config.executionPolicy.maxNewHedgePremiumPctEquity, 0.0075);
assert.equal(config.executionPolicy.maxTotalHedgePremiumPctEquity, 0.02);
assert.equal(config.executionPolicy.maxDailyHedgePremiumPctEquity, 0.01);
```

- [ ] **Step 2: Run hedge tests to verify RED.**

Run: `npx tsx --test tests/hedgeCapitalEvidenceService.test.ts tests/hedgeExecutionReviewService.test.ts tests/hedgeRecommendationService.test.ts tests/hedgeExecutionService.test.ts`

Expected: current defaults and missing-evidence behavior fail.

- [ ] **Step 3: Correct only the three normalized fallback ratios.** Keep the
  existing percentage parser and change its already-normalized fallbacks to
  `0.0075`, `0.02`, and `0.01`; do not alter spread or coverage fallbacks.

- [ ] **Step 4: Implement authoritative capital evidence.** Classify only
  allowed-underlying long puts as hedge positions. Use cost basis for paid
  premium, market value for exposure, active hedge-entry rows for reservations,
  actual fills for completed premium, and broker plus ledger identity for open
  orders. Missing material values add `HEDGE_CAPITAL_EVIDENCE_INCOMPLETE`.

- [ ] **Step 5: Block recommendation on incomplete evidence.** Add
  `capitalEvidence` to the recommendation contract. Sizing may subtract only
  explicit complete values. Incomplete evidence forces monitoring with zero
  executable candidates.

- [ ] **Step 6: Sign and revalidate capital evidence.** Put the evidence and
  fingerprint into `HedgeExecutionReview.portfolioEvidence`. At execution,
  refresh it, require the fingerprint to match, and reapply new/total/daily
  premium, buying-power, quantity, order, spread, delta, DTE, and freshness
  limits before reservation.

- [ ] **Step 7: Run hedge suites.**

Run: `npx tsx --test tests/hedgeCapitalEvidenceService.test.ts tests/hedgeExecutionReviewService.test.ts tests/hedgeRecommendationService.test.ts tests/hedgeExecutionService.test.ts tests/hedgeLearningService.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit hedge safety evidence.**

```bash
git add -- src/services/hedgeCapitalEvidenceService.ts src/services/hedgeConfigService.ts src/services/hedgeRecommendationService.ts src/services/hedgeExecutionReviewService.ts src/services/hedgeLearningService.ts src/services/hedgeExecutionService.ts tests/hedgeCapitalEvidenceService.test.ts tests/hedgeExecutionReviewService.test.ts tests/hedgeRecommendationService.test.ts tests/hedgeExecutionService.test.ts
git commit -m "Enforce hedge premium evidence and caps"
```

### Task 8: Close direct-confirm and late-day artifact bypasses

**Files:**
- Modify: `src/cli.ts`
- Modify: `server/dashboard-control/server.ts`
- Modify: `apps/dashboard/lib/data.ts`
- Modify: `apps/dashboard/app/api/paper/_lib/routeHelpers.ts`
- Modify: `tests/dashboardControlServer.test.ts`
- Modify: `tests/dashboardVercelBridge.test.ts`
- Modify: `tests/paperOpsWorkflowService.test.ts`

**Interfaces:**
- Consumes: `buildPaperReviewedPayloadExecutionReport` and signed artifact
  readiness.
- Produces: compatibility direct-confirm surfaces that require explicit
  confirmation and dispatch only `paper:execute:reviewed`.

- [ ] **Step 1: Write failing route and late-day tests.** Assert missing
  `confirmPaper` blocks before bridge/control command; explicit confirmation
  dispatches `paper:execute:reviewed` with the exact latest payload signature;
  local dashboard fallback calls reviewed execution; CLI source no longer calls
  `buildPaperExecuteConfirmPaperReport`; and late day writes a new artifact with
  `source_action='paper.ops.late_day'`, a valid signature, and a fresh expiry.

- [ ] **Step 2: Run route/workflow tests to verify RED.**

Run: `npx tsx --test tests/dashboardControlServer.test.ts tests/dashboardVercelBridge.test.ts tests/paperOpsWorkflowService.test.ts`

Expected: direct confirm still dispatches the legacy command and late day writes
no artifact.

- [ ] **Step 3: Delegate all direct-confirm surfaces.** In CLI, route
  `paper:execute --confirmPaper` to reviewed execution. In the control server,
  retain the route name and input-shape compatibility but use
  `confirmPaperFromInput: true` and `executeReviewedHandler`. In dashboard data,
  make `runPaperConfirm` call the reviewed executor. Remove implicit
  confirmation from `routeHelpers`.

- [ ] **Step 4: Persist the late-day artifact.** Have `runPaperOpsLateDay`
  invoke the same signed review builder with `moment: "late_day"` and
  `sourceAction: "paper.ops.late_day"`; include the returned artifact in the
  outer workflow and preserve `forcedExitReview: true`.

- [ ] **Step 5: Run route/workflow/CLI tests.**

Run: `npx tsx --test tests/dashboardControlServer.test.ts tests/dashboardVercelBridge.test.ts tests/dashboardVercelFallback.test.ts tests/paperOpsWorkflowService.test.ts tests/paperMonitoringScheduler.test.ts`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit bypass closure.**

```bash
git add -- src/cli.ts server/dashboard-control/server.ts apps/dashboard/lib/data.ts apps/dashboard/app/api/paper/_lib/routeHelpers.ts src/services/paperOpsWorkflowService.ts tests/dashboardControlServer.test.ts tests/dashboardVercelBridge.test.ts tests/paperOpsWorkflowService.test.ts
git commit -m "Route paper confirmation through signed reviews"
```

### Task 9: Synchronize configuration and operational documentation

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `RESUME_CONTEXT.md`
- Modify: `server/README.md`
- Modify: `server/RESUME_CONTEXT.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/paper-monitoring-operations.md`
- Modify: `docs/specs/2026-07-14-adaptive-allocation-safety-floor.md`
- Modify: `docs/decisions/ADR-007-signed-fresh-paper-entry-validation.md`

**Interfaces:**
- Documents: `PAPER_REVIEW_SIGNING_KEY`, signed artifact lifecycle, direct-route
  delegation, fresh-review blockers, 0DTE accounting, hedge ratios/evidence,
  scale-in caps, late-day artifact TTL, and no-allocator boundary.

- [x] **Step 1: Add configuration names without values or secrets.** Add
  `PAPER_REVIEW_SIGNING_KEY=replace_me` and any new conservative freshness
  tolerance names. Add the documented hedge execution defaults
  `0.75`, `2`, and `1` as human percentages. Do not change current equity or
  0DTE cap values.

- [x] **Step 2: Update repository and server runbooks.** Document fresh review
  regeneration, unsigned-artifact cutover, structured blockers, read-only
  validation commands, and the fact that compatibility direct-confirm paths
  now dispatch reviewed execution only.

- [x] **Step 3: Record source/runtime sizing evidence.** State checked-in values
  and the safely inspected VPS values without exposing the environment file or
  secrets. If values differ, preserve both and identify the installed override
  as runtime-authoritative.

- [x] **Step 4: Run documentation and config checks.**

Run: `rg -n "PAPER_REVIEW_SIGNING_KEY|baseline-v1|FRESH_REVIEW_REQUIRED|0.0075|0.02|0.01" .env.example README.md RESUME_CONTEXT.md server/README.md server/RESUME_CONTEXT.md docs/ARCHITECTURE.md docs/paper-monitoring-operations.md docs/specs/2026-07-14-adaptive-allocation-safety-floor.md docs/decisions/ADR-007-signed-fresh-paper-entry-validation.md`

Run: `git diff --check`

Expected: every contract is documented and the whitespace check passes.

- [x] **Step 5: Commit documentation.**

```bash
git add -- .env.example README.md RESUME_CONTEXT.md server/README.md server/RESUME_CONTEXT.md docs/ARCHITECTURE.md docs/paper-monitoring-operations.md docs/specs/2026-07-14-adaptive-allocation-safety-floor.md docs/decisions/ADR-007-signed-fresh-paper-entry-validation.md docs/superpowers/plans/2026-07-14-adaptive-allocation-safety-floor.md
git commit -m "Document adaptive allocation safety floor"
```

### Task 10: Validate, independently review, release, and deploy exact SHA

**Files:**
- Review: every changed file in this plan.
- Runtime: no source change unless validation or review identifies an in-scope
  defect.

**Interfaces:**
- Produces: one reviewed pull request, exact merged SHA deployment, read-only
  runtime evidence, and Basic Memory Cloud checkpoint.

- [ ] **Step 1: Run the full local validation matrix.**

```bash
npm run lint
npm run typecheck
npm test
npm run test:zero-dte
npm run build
npm run dashboard:build
npm run db:migrate
npm run db:verify
```

Expected: every command exits zero.

- [ ] **Step 2: Run structural validation.** Run `bash -n` on every changed
  shell script, `node --check` on changed JavaScript, SQLite
  `PRAGMA integrity_check` and `PRAGMA foreign_key_check`, and
  `systemd-analyze verify` on affected units. Expected: no syntax, integrity,
  foreign-key, or unit validation error.

- [ ] **Step 3: Inspect the release diff.**

Run: `git status --short && git diff --check && git diff --stat && git diff origin/main...HEAD`

Expected: only safety-floor files, no secrets, no generated junk, and no
unrelated stale-main change.

- [ ] **Step 4: Run one independent review.** Give the reviewer the exact base
  and head SHAs and the safety-floor spec. Fix every Critical/High and every
  safety/correctness/auditability/determinism/deployment Medium. File unrelated
  Low/theoretical findings as GitHub issues. Run at most one follow-up review
  after corrections.

- [ ] **Step 5: Re-run affected focused tests and the complete validation
  matrix after corrections.** Expected: all pass from the final tree.

- [ ] **Step 6: Push and open one pull request.** Include goal, safety boundary,
  changed paths, sizing discrepancy, validation table, review disposition,
  database/deployment gate evidence, and explicit statement that no paper or
  live order was submitted.

- [ ] **Step 7: Merge only after checks pass.** Record the exact merged `main`
  SHA and verify `origin/main` resolves to it.

- [ ] **Step 8: Diagnose VPS pre-deploy state.** Verify clean checkout, current
  SHA, disk, paper flags/live disabled, selected non-secret sizing values,
  `systemctl --failed`, relevant service/timer status, database lock owner and
  duration, `npm run db:verify`, SQLite PRAGMAs, and paper health. Do not mask a
  lock with timeout/restart changes.

- [ ] **Step 9: Provision the signing key without printing it.** Add or preserve
  a cryptographically random `PAPER_REVIEW_SIGNING_KEY` in
  `/opt/alpaca-investing/secrets/alpaca.env`, report presence/fingerprint only,
  and retain mode `0600` and existing ownership.

- [ ] **Step 10: Deploy the exact merged SHA.** Update the clean VPS checkout to
  that SHA, install/build/migrate/verify, restart only affected services, and
  deploy the applicable Vercel production surface. Never run an execution
  command or manufacture a candidate.

- [ ] **Step 11: Validate exact-SHA runtime.** Confirm GitHub/VPS/Vercel SHA
  alignment, paper health, live disabled, signed review creation/readiness,
  late-day artifact capability, sanitized dashboard reads, service/timer
  health, `systemctl --failed`, and database PRAGMAs. Use only naturally
  occurring read/review evidence; submit zero orders.

- [ ] **Step 12: Update and read back Basic Memory Cloud.** Update `Current
  State`, `Trading Boundaries`, `Decision Log`, `Adaptive Allocation Direction`,
  and a dated checkpoint with the exact SHA, PR, tests, deployment state, no
  order submission, and the stop-before-Release-1 boundary. Read it back and
  verify accuracy.

- [ ] **Step 13: Report one terminal release status.** Use exactly one of
  `IMPLEMENTATION_COMPLETE`, `DEPLOYED_PROMOTION_PENDING`,
  `PROMOTION_ELIGIBLE`, `BLOCKED`, or `ROLLED_BACK`, and stop before Release 1.

## Self-review

- Spec coverage: Tasks 1-3 cover signed artifacts and fresh general submit
  validation; Task 4 covers scale-ins; Tasks 5-6 cover 0DTE evidence and signed
  submit state; Task 7 covers hedge normalization/evidence; Task 8 closes
  direct-confirm and late-day bypasses; Tasks 9-10 cover documentation,
  validation, review, exact-SHA release, runtime evidence, and memory writeback.
- Scope boundary: no task creates allocator weights, modes, optimizer schema,
  allocator-owned exits, live behavior, cap increases, or a public mutation
  route.
- Type consistency: artifact state uses `PaperSubmitStateAttestation`; 0DTE
  counters use `ZeroDteActivityEvidence`; hedge review and executor share
  `HedgeCapitalEvidence`; all three use canonical fingerprints and structured
  blockers.
- Placeholder scan: the plan contains no deferred implementation marker; each
  code task defines its files, interfaces, failing test, implementation action,
  validation command, and commit boundary.
