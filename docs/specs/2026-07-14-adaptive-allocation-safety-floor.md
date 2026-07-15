# Adaptive Allocation Safety-Floor Prerequisite

Status: implemented on the release branch; validation, review, and exact-SHA
deployment are governed by the gates below.

## Goal

Close the known paper-order safety gaps that must be resolved before adaptive
portfolio allocation or cross-strategy optimization can be introduced.

This release does not implement an allocator. It makes every reachable
new-risk paper-order path prove that it is executing an authentic, fresh,
reviewed intent against fresh paper-account state and the currently installed
safety configuration.

## Authorization boundary

Only this safety-floor prerequisite is authorized by the attached objective.
The following later releases remain explicitly out of scope until the user
authorizes each one separately:

- Release 1: evidence and schema for adaptive allocation.
- Release 2: shadow allocator behavior.
- Release 3: advisory allocator behavior.
- Release 4: enforced-paper allocator behavior.

This release may inspect and change the repository, add tests and additive
schema, commit, push, open and merge one pull request, deploy the exact merged
SHA to the VPS and applicable Vercel surface, and update the approved Basic
Memory Cloud checkpoint. It may not submit a manual or forced paper order.

## Verified current state

The repository at
`origin/main@29f4a814d39cebc6f66b371571a92fe58228f6e1` has the following material
gaps:

1. `paper:execute:reviewed` checks artifact age and a caller-supplied payload
   hash, but the stored review artifact is not HMAC signed and the executor
   does not re-fetch positions, open orders, active reservations, current
   market evidence, or normalized capital limits before submitting an entry.
2. `paper:execute --confirmPaper`, the VPS `/api/v1/execute/confirm` route, and
   the dashboard fallback helper reach the legacy plan-and-submit function
   without requiring the persisted reviewed artifact.
3. late-day paper operations build exit recommendations but do not persist the
   fresh review artifact consumed by the final-hour exit executor.
4. equity scale-ins default to `$250`, but missing quantity or market value can
   be treated as zero and the scale-in decision does not account for open
   orders, active reservations, the cash reserve, or the portfolio deployment
   cap.
5. the concrete 0DTE account adapter leaves daily trade count, daily premium,
   and daily realized loss unset. Eligibility treats those missing values as
   non-blocking, and open 0DTE orders do not consume the open-position limit.
6. absent hedge premium-cap environment values normalize to `75%`, `200%`, and
   `100%` rather than the specified `0.75%`, `2%`, and `1%`. Hedge sizing also
   treats missing existing and daily hedge premium as zero.
7. hedge execution refreshes paper account, position, order, and quote data,
   but the signed review does not carry authoritative existing hedge exposure,
   reserved premium, daily used/completed premium, or open-order evidence, and
   the executor does not reapply total and daily hedge-premium caps to that
   evidence.

The checked-in sizing defaults are currently `$1,000` per ordinary equity
order, `$5,000` maximum per equity order, and `$50,000` maximum total plan
notional. Those values differ from the attached objective's stated `$100` per
scheduled order and `$300` scheduled total. This release will not silently
change either source or installed values. The installed VPS environment is
authoritative for runtime overrides, and any discrepancy must be recorded in
the release evidence.

## Implementation and pre-deploy evidence

The implementation is isolated in `feat/adaptive-allocation-safety-floor`. It
changes only the safety-floor prerequisite described here; Releases 1-4 remain
unimplemented and unauthorized.

A redacted, read-only VPS snapshot on 2026-07-14 found:

- a clean checkout at the base SHA above;
- `ALPACA_ENV=paper`, `TRADING_MODE=paper`, `ALPACA_LIVE_TRADE=false`, and
  `LIVE_TRADING_ENABLED=false`;
- no installed values for the selected equity, plan, scale-in, 0DTE, or hedge
  sizing variables, so checked-in source defaults were runtime-effective;
- `PAPER_REVIEW_SIGNING_KEY` absent before deployment; and
- `/opt/alpaca-investing/secrets/alpaca.env` owned by `alpaca:alpaca` with mode
  `0600`.

Therefore this release must provision or preserve the signing key without
printing it before restarting affected services. It must not alter the runtime
sizing merely to match the objective's `$100`/`$300` prose. No paper or live
order was submitted to gather this evidence.

## Desired end state

### Signed reviewed artifacts

Every general reviewed payload artifact is an HMAC-SHA256 signed canonical
record. The signed envelope includes:

- artifact identity, source action, creation time, and expiry;
- canonical payload sections and their SHA-256 payload hash;
- normalized paper-account identity and status;
- normalized configuration and its fingerprint;
- position, open-order, reservation, and market-evidence fingerprints;
- exact order intent and candidate/source identity for every new-risk payload;
- a baseline allocation attestation identifying this release as
  `baseline-v1`, with no allocator ownership;
- warnings, blockers, and review summary.

`PAPER_REVIEW_SIGNING_KEY` is required to create or execute a reviewed artifact.
Legacy unsigned artifacts fail closed and require a fresh review. Artifact
verification recalculates both the canonical payload hash and signed-envelope
hash; it never trusts only the database columns or caller input.

### Fresh submit-time validation

Immediately before a general new-risk entry, the executor re-fetches the
paper account, positions, recent/open orders, current entry market evidence,
and local active reservations. It compares that state with the signed review
and reapplies the current normalized limits.

Known active broker statuses include `held` and `pending_cancel`. Unknown
non-terminal statuses remain active evidence and block new risk instead of
being silently discarded. A signed review whose status is blocked or whose
signed blocker list is non-empty cannot authorize entry sections; independently
valid exit sections remain eligible.

Material drift includes:

- account identity, paper/live state, account status, or blocking flags;
- configuration or baseline allocation identity;
- source candidate, symbol, side, quantity, notional, premium, or limit price;
- position quantities, open orders, or active reservations;
- stale or materially changed market evidence;
- missing account, position, price, quantity, cash, reserve, buying-power, or
  cap evidence;
- a cash-reserve, buying-power, per-order, position, total-plan, portfolio
  deployment, strategy, sleeve, lane, or daily cap violation.

The result is a structured blocker that requests a fresh review. The executor
does not resize, reallocate, or reprice upward inline. Exit, protection,
recovery, and reconciliation paths do not depend on positive allocation room;
they retain their own safety gates and may proceed even when an entry is
blocked for state drift.

### Reservation and lineage

Every general new-risk entry reserves a unique execution-ledger identity before
the broker mutation. A duplicate open order or active reservation fails closed.
The reservation carries the exact review artifact, payload section/index,
candidate identity, decision identity, canonical intent, and validation
evidence. Broker submission and fill reconciliation update that same row.

All new-risk sections selected from one artifact reserve as an all-or-none batch
inside an immediate transaction. The transaction recomputes the exact active
reservation fingerprint and shared-cap headroom before inserting reservations,
so concurrent general, 0DTE, or hedge decisions cannot each consume the same
remaining capacity.

### Equity scale-ins

The existing `$250` scale-in default is preserved. A scale-in is reviewable
only when all of the following are known and valid:

- current positive quantity and current market value;
- current account identity, status, equity, cash, and buying power;
- the ordinary equity cash reserve and deployable-capital calculations;
- the ordinary per-order, per-position, total-plan, and portfolio deployment
  caps;
- no same-symbol open buy order or active new-risk reservation;
- exact source candidate identity.

Missing material evidence produces a hold recommendation with a structured
reason; it is never interpreted as zero exposure.

### 0DTE accounting and signed submit attestation

The 0DTE executor derives New York trading-day evidence from current paper
positions, broker orders, the execution ledger, Level 2 trades, and generic
position outcomes. It deduplicates broker/client identities across all entry
paths and supplies:

- daily 0DTE entry count;
- daily premium used or reserved;
- daily realized loss;
- open 0DTE positions;
- active open 0DTE entry orders.

Open positions and active orders jointly consume the current open-exposure
limit. Missing premium or realized-loss evidence is a hard blocker. No current
0DTE cap is increased.

Generic reviewed `optionBuys` sourced from `discovery:zero_dte_spy:*` use the
same cross-path daily trade, premium, realized-loss, and open-exposure evidence
as the standalone Level 2 executor. They cannot bypass those counters through
the compatibility confirmation path.

Before a 0DTE order request, the executor persists a signed canonical submit
attestation tied to the exact decision, candidate, configuration, quote,
account/activity snapshot, order intent, and `baseline-v1` allocation identity.
It then performs one fresh account/activity read and compares it to that
attestation before the broker mutation. Candidate, decision, quote, or state
drift blocks without inline resizing. The standalone executor also refreshes
the option quote immediately before reservation, preserves the reviewed limit,
and blocks stale, identity-drifted, or over-threshold price evidence.

### Hedge accounting

Hedge percentage defaults normalize to these ratios:

- maximum new hedge premium: `0.0075` of equity (`0.75%`);
- maximum total hedge premium: `0.02` of equity (`2%`);
- maximum daily hedge premium: `0.01` of equity (`1%`).

Hedge reviews and execution use explicit capital evidence:

- existing long-put hedge market exposure and paid premium from current paper
  positions;
- active reserved hedge premium from the execution ledger;
- current broker open hedge orders;
- daily hedge premium used, with completed premium derived from fills;
- an evidence-completeness flag and canonical fingerprint.

Missing material evidence forces monitoring/blocked status. At submission the
executor refreshes the same evidence, verifies the signed fingerprint, and
reapplies new, total, daily, buying-power, deployable-capital, quantity, order,
spread, delta, DTE, quote-freshness, and review-to-submit price-drift gates. The
HMAC binds deterministic review and client-order identities. Persistence
verifies the database row against the signed review, and one review is consumed
atomically with its one execution-ledger reservation so it cannot be replayed.

### Direct-confirm and late-day paths

The existing direct-confirm URL and CLI alias remain for compatibility, but
they delegate only to reviewed execution. They require an explicit
`confirmPaper: true` or `--confirmPaper`, a valid signed latest artifact,
canonical payload hash, freshness, and exact linkage. No route implicitly
supplies confirmation.

Late-day paper operations persist a newly signed artifact generated from the
late-day portfolio review. The normal artifact TTL applies. Exit sections
remain independently executable and do not require positive entry capacity.

## Scope

- Signed general paper review artifacts and verification.
- Shared general-entry review/submit state capture and validation.
- Ledger reservation hardening for reviewed entries.
- Scale-in evidence and ordinary-cap enforcement.
- 0DTE daily accounting, open-exposure counting, and signed submit attestation.
- Hedge default normalization and capital-evidence enforcement.
- Direct-confirm delegation and explicit-confirm enforcement.
- Fresh late-day exit artifact creation.
- Documentation, tests, deployment gates, exact-SHA deployment, and runtime
  validation.

## Non-goals

- No adaptive allocation weights, optimization objective, covariance model,
  strategy budgeting, allocator mode switch, or allocator-owned exit.
- No live trading, live configuration, live endpoint, or live-order path.
- No manual, forced, synthetic, or fabricated paper opportunity or order.
- No public mutation route or dashboard allocation control.
- No cap increase, gate weakening, inline order resize, or upward reprice.
- No destructive migration or deletion/rewrite of audit history.
- No modification of the stale local `main` checkout.

## Interfaces and failure behavior

New or strengthened structured failure codes include:

- `PAPER_REVIEW_SIGNING_KEY_REQUIRED`
- `REVIEW_ARTIFACT_SIGNATURE_INVALID`
- `REVIEW_ARTIFACT_PAYLOAD_CHANGED`
- `REVIEW_ARTIFACT_STATE_ATTESTATION_REQUIRED`
- `REVIEW_ARTIFACT_ENTRY_BLOCKED`
- `REVIEW_ENTRY_SOURCE_IDENTITY_MISSING`
- `SUBMIT_ACCOUNT_STATE_DRIFT`
- `SUBMIT_CONFIGURATION_DRIFT`
- `SUBMIT_PORTFOLIO_STATE_DRIFT`
- `SUBMIT_MARKET_EVIDENCE_STALE`
- `SUBMIT_PRICE_DRIFT`
- `SUBMIT_CAP_EVIDENCE_INCOMPLETE`
- `SUBMIT_CAP_EXCEEDED`
- `SUBMIT_DUPLICATE_ORDER_OR_RESERVATION`
- `SUBMIT_ORDER_STATUS_UNRECOGNIZED`
- `FRESH_REVIEW_REQUIRED`
- `SCALE_IN_POSITION_EVIDENCE_INCOMPLETE`
- `SCALE_IN_CAPITAL_EVIDENCE_INCOMPLETE`
- `ZERO_DTE_ACTIVITY_EVIDENCE_INCOMPLETE`
- `ZERO_DTE_DAILY_COUNTER_EVIDENCE_REQUIRED`
- `ZERO_DTE_SUBMIT_ATTESTATION_INVALID`
- `ZERO_DTE_ORDER_STATUS_EVIDENCE_REQUIRED`
- `ZERO_DTE_PRICE_DRIFT`
- `HEDGE_CAPITAL_EVIDENCE_INCOMPLETE`
- `HEDGE_CAPITAL_EVIDENCE_CHANGED`
- `HEDGE_TOTAL_PREMIUM_CAP_EXCEEDED`
- `HEDGE_DAILY_PREMIUM_CAP_EXCEEDED`
- `HEDGE_ORDER_STATUS_EVIDENCE_REQUIRED`
- `HEDGE_PRICE_DRIFT`
- `HEDGE_REVIEW_ALREADY_CONSUMED`

All errors are sanitized. Secrets, raw environment contents, API credentials,
and authorization headers are never persisted or returned.

## Acceptance criteria

1. Every reachable general paper entry route requires a valid signed artifact
   and fresh state validation; the legacy direct plan-and-submit path is not
   reachable from CLI, control API, or dashboard routes.
2. A tampered, unsigned, stale, mismatched, or state-drifted entry artifact
   submits zero orders and returns a structured fresh-review blocker.
3. Exit-only sections from a valid, fresh signed artifact remain independent of
   positive allocation room and entry-state drift.
4. Scale-ins fail closed on missing quantity/value/account/cap evidence,
   duplicate orders/reservations, cash-reserve breach, or deployment/position
   cap breach, while preserving the `$250` default.
5. The concrete 0DTE provider always supplies complete daily counters and open
   exposure from authoritative evidence or blocks. All supported entry paths
   deduplicate by broker/client identity and use the New York trading date;
   generic discovery-based 0DTE option buys cannot bypass these counters.
6. 0DTE order submission requires a valid persisted signed submit attestation
   and unchanged fresh account/activity/quote evidence.
7. Hedge defaults equal `0.75%`, `2%`, and `1%`; missing capital evidence never
   becomes zero; reviews and execution enforce current total/daily evidence,
   signed deterministic identity, one-time consumption, and fresh quote drift.
8. `/api/v1/execute/confirm`, its Vercel bridge route, and
   `paper:execute --confirmPaper` delegate to reviewed execution and require
   explicit confirmation.
9. `paper:ops:late-day` writes a fresh signed artifact containing eligible
   final-hour exits and the normal TTL is enforced.
10. Source and installed sizing values are recorded; this release does not
    increase or silently rewrite them.
11. Documentation and examples describe the signed artifact, fresh validation,
    structured blockers, and paper-only boundary accurately.
12. General, 0DTE, and hedge cap headroom is rechecked with active reservations
    inside immediate transactions; concurrent decisions cannot over-reserve it.
13. Active and unknown non-terminal broker statuses never disappear from risk
    evidence; unknown statuses fail closed.

## Validation plan

Run the focused tests for every red/green change, then run:

```text
npm run lint
npm run typecheck
npm test
npm run test:zero-dte
npm run build
npm run dashboard:build
npm run db:migrate
npm run db:verify
```

Also run focused scheduler, execution bridge, reservation, dashboard API,
0DTE, and hedge suites; `bash -n` for changed shell scripts; `node --check` for
changed JavaScript; SQLite `PRAGMA integrity_check` and
`PRAGMA foreign_key_check`; `systemd-analyze verify` for affected units; and
`systemctl --failed` on the VPS.

Before deployment, diagnose any current or historical database lock with its
owner and duration. A timeout increase, error suppression, or repeated service
restart is not an acceptable substitute for diagnosis. Deployment requires no
relevant failed unit, paper health, live disabled, a clean VPS checkout, and
exact GitHub/VPS/Vercel SHA alignment.

## Deployment authorization and boundaries

Use one branch and one pull request for this release. Run one independent
review, fix all Critical/High findings and any Medium finding affecting safety,
correctness, auditability, determinism, or deployment, then run at most one
follow-up review after corrections. Low or theoretical unrelated findings are
filed as GitHub issues rather than expanded into this release.

Merge only after required checks pass. Deploy the exact merged `main` SHA.
Runtime validation is read-only and must not manufacture or submit an order.
The final release status must be exactly one of `IMPLEMENTATION_COMPLETE`,
`DEPLOYED_PROMOTION_PENDING`, `PROMOTION_ELIGIBLE`, `BLOCKED`, or
`ROLLED_BACK`.
