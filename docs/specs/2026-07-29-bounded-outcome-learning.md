# Section 10: Bounded Outcome Learning

Date: 2026-07-29

Status: accepted implementation design

Starting boundary: `de8f885642f688abceac58b156e56023d5bef568`

## Objective

Create one queryable, PostgreSQL-authoritative projection that connects an
existing candidate or proposal to its available arbitration, review, intent,
order, broker-event, position, research, and market evidence. The projection
may calculate only metrics supported by persisted data and must classify every
relationship as `exact`, `partial`, `missing`, `ambiguous`, or `unsupported`.

The layer is for post-trade evidence. It does not train a model, tune a
threshold, rewrite configuration, allocate capital, create an intent, or call a
broker.

## Discovery

The accepted Section 9 schema already contains the lifecycle identities needed
for Section 10:

- `candidates.id` is the existing proposal identity.
- `portfolio_arbitration_decisions.proposal_id` references `candidates.id`.
- `execution_reviews.candidate_id` references the candidate.
- `order_intents.execution_review_id`, `review_id`, and `candidate_id` preserve
  the reviewed decision.
- `orders.order_intent_id`, `client_order_id`, and `broker_order_id` preserve
  local and broker order identities.
- `broker_events` retain durable broker-event references for orders and intents.
- `positions.candidate_id`, `opening_order_id`, and `closing_order_id` preserve
  supported position lineage.
- exit intents use the existing `parent_position_id`.
- scheduler cycle, run, and fencing values are persisted on arbitration
  decisions and intents.
- Section 8 research evidence remains referenced from
  `candidates.signal_inputs.researchEvidence.signalId`.

The existing market evidence supports bounded lookups:

- `stock_snapshots(symbol, observed_at DESC)`.
- `option_snapshots(option_symbol, observed_at DESC)`.
- `market_bars(symbol, timeframe, observed_at DESC)`.

An exact market reference is available when persisted review evidence includes
the matching request and timestamp. Otherwise, a nearest-at-or-before lookup may
be used only inside the configured tolerance. Future observations are never
eligible.

The following limitations were found:

- Alpaca fill activity IDs are deduplicated in process memory but are not
  durably stored. Outcome records therefore retain durable broker-event IDs and
  report `FILL_ACTIVITY_ID_NOT_PERSISTED`; they never fabricate activity IDs.
- A reconciliation checkpoint is not directly linked to each position. The
  position's source account snapshot and reconciliation timestamp may be
  referenced, but are not labeled as exact checkpoint identity.
- historical records predate complete candidate, opening-order, or
  closing-order lineage. These become missing or ambiguous outcomes.
- stored position `realized_pnl` is not consistently populated. An exact
  realized return is derived only for a closed, unambiguous,
  one-entry/one-exit lifecycle with matching quantities and authoritative fill
  prices. Option P&L also requires the persisted contract multiplier; the
  conventional multiplier is not guessed when it is missing. A stored
  position-level P&L may be preserved without inventing a return when exact
  attribution is unsupported.
- fees, dividends, borrow cost, market impact, queue position, information
  leakage, assignment, exercise, and settlement effects are unavailable unless
  explicitly persisted.
- equity excursion can use bounded daily bars and is labeled daily
  mark-to-market. Option excursion uses persisted contract snapshots only;
  underlying movement is never substituted for contract return.
- legacy SQLite learning and trace services are historical-only and are not
  operational authority after the PostgreSQL-only cutover.

Read-only production inspection at the starting SHA found 14,785 candidates,
3,035 reviews, 2,965 intents, 99 orders, 301 broker events, and 57 positions.
Six closed positions have an exact candidate plus entry/exit order path.
Twenty-seven positions lack candidate or opening-order lineage, and 27 of 33
closed positions lack a closing order. Those records establish useful missing
join cases without manufacturing data. Production did not yet contain Section 9
arbitration rows or Section 8 research-signal rows, so those exact joins are
test-established until natural records appear.

## Selected Design

Migration 9 adds:

1. `outcome_learning_refresh_runs` for the fenced, bounded, deterministic
   refresh audit.
2. `outcome_learning_records` for one normalized projection per candidate and
   environment.
3. `historical_outcome_aggregates` for bounded, versioned, read-only group
   evidence.
4. `candidates(as_of, id)` to make the source boundary explicit and indexed.

A normal view was rejected because it cannot provide refresh bounds,
idempotency audit, calculation version, or a stable evidence watermark. A
materialized view was rejected because the repository has no existing safe
bounded materialized-view refresh pattern. The normalized projection is the
smallest option that follows existing migration, scheduler-fence, and
idempotency conventions.

Derived tables contain stable identifiers, supported scalar metrics, compact
reference arrays, join classification, limitations, hashes, and audit
metadata. They do not copy full candidate, order, broker, position, or market
payloads. Authoritative source tables are read-only to this service.

## Bounded Refresh

Manual backfill requires both `start` and `end`. Scheduled refresh defaults to
the immediately preceding UTC day. All input is parsed as a timestamp and bound
as a parameter; arbitrary SQL, paths, and commands are not accepted.

Defaults and hard bounds:

- default records: 250;
- hard maximum records: 500;
- hard maximum date span: 31 days;
- quote/trade reference tolerance: 60 seconds;
- hard maximum reference tolerance: 15 minutes;
- excursion window: at most 31 days;
- option observations per outcome: at most 500;
- arbitrations per candidate: at most 8;
- reviews per candidate: at most 16;
- intents per candidate: at most 32;
- positions per candidate: at most 16;
- orders per intent: at most 8;
- broker events per order or intent-only lineage: at most 64;
- research references per candidate: at most 16;
- direct market references per review: at most 32;
- aggregate minimum sample: 5;
- aggregate maximum incomplete-join ratio: 0.25;
- aggregate stale threshold: 24 hours;
- outcome schema version: 1.

The source page is ordered by `candidates.as_of, candidates.id`, constrained by
`start <= as_of < end`, and limited to `max + 1` so truncation is explicit.
Related lifecycle data is loaded once per relation through parameterized
`LATERAL` batches with a per-parent `limit + 1`, not through one query per
proposal. Overflow marks the affected record `partial`, marks the source page
truncated, and makes every aggregate from that page unusable as evidence.
Market evidence is deduplicated per event and read through indexed time
windows. Malformed JSON quote fields are parsed in application code and remain
unavailable; they are never cast in SQL where one malformed payload could abort
the batch. Persisted broker-event references are restricted to the selected
authoritative entry and exit order or intent chains.

A refresh identity includes environment, bounds, maximum records, schema
version, and a source fingerprint. Replaying an identical source state is a
no-op; changed source state creates a new auditable refresh. Every write checks
the existing learning scheduler fence. A missing or broken lineage produces a
record with limitations and does not stop other candidates.

Production validation uses the minimum useful indexed range:

- start: `2026-07-28T00:00:00.000Z`;
- end: `2026-07-29T00:00:00.000Z`;
- maximum candidate records: 250.

This range contains approximately 90 distinct reviewed candidates, including
missing-order, filled, open-position, and closed-position cases. It does not
scan or backfill the full option-snapshot history.

## Outcome Semantics

Exact joins always use existing identifiers. A bounded indirect relationship is
`partial` and carries its method. Multiple plausible lifecycle entities without
an authoritative discriminator are `ambiguous`, and dependent metrics stay
null. An absent expected entity is `missing`. A relationship or metric the
stored data cannot express is `unsupported`.

Paper records retain `environment = 'paper'` and explicit paper limitations.
They are never merged with or extrapolated into live performance.

Fill timestamps use durable broker-event occurrence times first and explicit
authoritative order timestamps only when available. A full-fill timestamp is
present only for a fully filled order. Adverse slippage is side-aware and uses
midpoint first, then a supported last trade; quote-relative fields remain null
when no eligible reference exists. Provider-event, receipt, and persistence
timestamps remain separate when stored, and unavailable timestamps are
reported rather than synthesized.

Realized return and P&L require a supported closed lifecycle. Open positions
may expose a stored unrealized checkpoint with mark time and source while
realized values remain null. MFE and MAE are produced only from a bounded
instrument-appropriate series.

## Aggregates and Strategy Evidence

Aggregates are separated by environment and lane and may group by symbol,
underlying, reason code, arbitration action, confidence, spread, liquidity,
candidate/research horizon, research signal, catalyst, order status, fill
status, and holding-period bucket when the underlying fields exist. Buckets and
schema version are persisted in aggregate metadata.

An aggregate is usable only when all of these hold:

- configured evidence consumption is enabled;
- environment and lane match the proposal;
- sample size meets the configured minimum;
- the date range is within the configured bound;
- missing plus ambiguous joins do not exceed the configured ratio;
- the calculation is fresh;
- the schema version is compatible;
- the source page was not truncated.

The conservative default is
`OUTCOME_LEARNING_EVIDENCE_ENABLED=false`. When explicitly enabled, the current
research batch loads the bounded aggregate set once and may attach only compact
read-only evidence and a reason code to a proposal. It does not change score,
confidence, size, eligibility, thresholds, priorities, lane allocation, or
configuration. Missing or invalid evidence affects only that proposal's
evidence and never gates another lane or workstream.

## Performance and Failure Boundary

Recent production cycles at the starting SHA were typically about 393–417
seconds, while the existing `paper:learn` inspection was about 9–29 seconds.
The Section 10 learning refresh has a documented workstream tolerance of 45
seconds and must remain bounded to at most 500 candidates. This is a conservative
upper bound near 1.5 times the observed learning-workstream maximum and roughly
11% of a typical full cycle. Query-count tests prohibit per-proposal source
loads, and query-plan tests verify the bounded candidate and market indexes.

Outcome query failure is local to `paper:learn` or optional proposal evidence.
It cannot stop reconciliation, recovery, cancellation, exits, Section 8
research ingestion, Section 9 arbitration, or unrelated proposal generation.

## Execution Separation

The only permitted flow is:

authoritative PostgreSQL lifecycle records → bounded projection → supported
metrics → bounded read-only aggregate → ordinary proposal evidence → Section 9
arbitration → existing review and intent path → existing order manager.

Outcome modules do not import Alpaca, construct broker payloads, generate
`client_order_id`, create intents, change lifecycle state, or call any execution
service. Structural tests enforce this boundary.
