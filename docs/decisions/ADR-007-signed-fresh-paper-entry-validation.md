# ADR-007: Signed Fresh-State Validation for Paper Entries

Status: Accepted for the safety-floor prerequisite.

## Context

The paper platform has multiple guarded entry executors: general reviewed
payload execution, 0DTE Level 2 execution, and hedge execution. Their existing
guards are not equivalent. General artifacts are payload hashes rather than
authenticated records, 0DTE daily evidence is incomplete in the concrete
provider, and hedge capital evidence can default to zero. A compatibility
direct-confirm route also reaches the legacy plan-and-submit implementation.

Adaptive allocation would amplify these differences by making entry sizes
depend on shared portfolio state. The entry floor therefore has to be uniform
before an allocator can exist.

## Decision

All new-risk paper entries require two distinct facts:

1. an authenticated canonical intent tied to exact source, configuration,
   account, portfolio, market, and baseline allocation evidence; and
2. a fresh submit-time state read that still satisfies that intent and all
   current caps.

General reviewed payloads use an HMAC-SHA256 signed persisted artifact. 0DTE
uses an append-only signed submit attestation tied to its immutable decision.
Hedge entries retain their HMAC review and add signed capital evidence. The
shared signing secret is `PAPER_REVIEW_SIGNING_KEY` for general/0DTE artifacts;
the existing hedge signing key remains independently required for hedge
reviews.

General artifact entries reserve as an all-or-none batch. General, 0DTE, and
hedge executors recheck the exact active-reservation fingerprint and cap
headroom inside immediate transactions. Hedge reviews bind deterministic review
and client-order identities and are consumed atomically with their one ledger
reservation. Generic discovery-based 0DTE option entries use the same cross-path
daily activity evidence as the Level 2 executor.

Material state drift fails closed with a fresh-review requirement. Executors
refresh option price evidence without changing the reviewed limit and do not
resize, reprice upward, or reallocate inline. Broker statuses explicitly known to be
active, including `held` and `pending_cancel`, consume exposure. Unknown
non-terminal statuses remain active evidence and block new risk. Exit, protection, recovery, and
reconciliation remain independent from positive entry capacity.

The compatibility CLI and HTTP direct-confirm surfaces delegate to reviewed
execution and never implicitly supply confirmation. `baseline-v1` is the only
allocation attestation in this release and explicitly states that no allocator
owns the order.

## Rationale

Canonical hashing detects accidental payload changes but does not authenticate
who produced the artifact. HMAC signatures make tampering and unsigned legacy
artifacts fail closed. Fresh state comparison prevents a valid old decision
from being submitted after positions, orders, reservations, configuration, or
capital have materially changed.

Keeping domain-specific executors preserves current architecture: general
entries, 0DTE, and hedges retain their specialized quote, strategy, and
lifecycle logic while sharing the same safety invariant. Keeping exits
independent avoids turning an entry-capacity failure into a risk-reduction
failure.

## Alternatives considered

- Rebuild the plan at submission. Rejected because it silently changes the
  reviewed decision and can resize against a different portfolio.
- Trust a caller-supplied SHA-256 payload hash. Rejected because it is not an
  authenticated signature and does not cover account or portfolio state.
- Centralize every executor in one new order service. Rejected for this release
  because it would replace mature domain-specific gates and materially broaden
  the safety-floor change.
- Treat missing daily/capital evidence as zero. Rejected because it increases
  risk precisely when evidence quality is lowest.
- Gate exits on the same positive-allocation validation. Rejected because exits
  reduce or protect risk and must remain independently reachable.

## Consequences

- Deployments must provision `PAPER_REVIEW_SIGNING_KEY` on the VPS before a
  fresh review can become executable.
- Existing unsigned review artifacts become intentionally non-executable.
- Review-to-submit state changes can require another review even if an order
  might still fit; this is conservative and auditable.
- General entry submission makes additional read-only broker/data calls.
- 0DTE accounting and hedge sizing can remain in monitoring/blocked status when
  authoritative evidence is incomplete.
- Concurrent entry decisions serialize briefly while shared reservation
  headroom is validated and reserved.
- A blocked signed review cannot authorize new-risk sections, while its valid
  exit sections remain independently executable.
- Hedge premium limits are `0.0075`, `0.02`, and `0.01` of equity. Human
  percentage environment values are `0.75`, `2`, and `1`.
- No allocator mode, weight, or optimization contract is created by this ADR.

## Validation

- Tampering, wrong-key, missing-key, stale-artifact, source-drift, account-drift,
  portfolio-drift, market-drift, duplicate-reservation, and cap tests submit no
  broker order.
- Exit-only tests prove allocation-room failures do not block a valid exit.
- 0DTE tests cover all-path deduplication, New York date boundaries, missing
  evidence, generic-path enforcement, active/unknown broker statuses, open
  orders consuming exposure, signed attestation, quote drift, and state drift.
- Hedge tests cover corrected default ratios, missing evidence, fingerprint
  drift, signed identity, one-time consumption, quote drift, unknown order
  status, atomic reservation, and total/daily cap enforcement.
- General tests cover signed blocker status, exit independence, unknown order
  status, and concurrent shared-cap reservation.
- CLI, control-server, and Vercel bridge tests prove direct-confirm delegation
  and explicit confirmation.
- A redacted 2026-07-14 VPS snapshot established a clean base checkout,
  paper-only/live-disabled flags, no selected sizing overrides, and an absent
  `PAPER_REVIEW_SIGNING_KEY`. Exact-SHA deployment must provision the signer
  without exposing it, preserve mode `0600`, invalidate unsigned artifacts, and
  create a new signed review. The safety-floor release does not change the
  runtime-effective `$1,000`/`$5,000`/`$50,000` ordinary equity defaults.

## Conditions for reconsideration

Reconsider the `baseline-v1` attestation only in a separately authorized
adaptive-allocation release. Reconsider the separate domain executors only if a
future reviewed architecture can preserve their existing specialized safety,
lineage, recovery, and exit contracts with equivalent or stronger evidence.
