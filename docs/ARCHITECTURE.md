# Architecture

## Market Observatory and Paper Decision Lifecycle

The canonical universe, market observations, research, reviewed paper execution,
broker reconciliation, analytical outcomes, and learning use one SQLite database.
Alpaca positions/orders remain broker truth; internal records add attribution and
never override broker state.

### Data flow

1. `universe_symbols` defines the enabled/tradable research universe.
2. `stock_snapshots` stores append-only Alpaca market evidence. The latest record
   may enrich only the latest feature row.
3. Every scored candidate is persisted. `decision_snapshots` stores immutable
   decision-time evidence, while `decision_lifecycle_events` appends later states.
4. `paper_review_artifacts` stores the latest canonical HMAC-signed reviewed
   payload, a `baseline-v1` allocation attestation, and normalized account,
   configuration, portfolio, order, reservation, and market fingerprints.
   `paper_review_decisions` joins exact artifact section indexes to entry or
   exit decisions.
5. General entry execution verifies the artifact and exact caller payload hash,
   refreshes paper account/portfolio/market evidence, compares it to the signed
   state, reapplies current caps, and atomically reserves exact intent in the
   execution ledger before broker submission. It never resizes or reallocates
   inline. Compatibility confirm routes dispatch this same executor only.
6. 0DTE derives complete New York-day activity across broker positions/orders,
   the execution ledger, Level 2 trades, and generic outcomes. Immediately
   before an order request it persists and rechecks an append-only signed submit
   attestation. Hedge entry reviews independently bind complete long-put
   exposure, reservation, fill, daily-premium, and open-order evidence.
7. A confirmed paper fill with exact execution-ledger lineage creates one
   `paper_positions` analytical lifecycle. Observations are append-only. A single
   possible lifecycle links exactly; multiple possible netted lifecycles link as
   ambiguous and suppress per-decision analytics.
8. Terminal outcomes are derived only from persisted exact observations. The
   original is unique and immutable; corrections are revision rows.
9. Learning records reference candidate, entry/exit decisions, lifecycle,
   original outcome, effective revision, completeness, and linkage status.

### Identity and ownership

- Candidate ID: researched opportunity.
- Decision ID: immutable entry, exit, or non-executable decision.
- Position lifecycle ID: broker-confirmed analytical position lifecycle.
- Alpaca: broker order and net-position truth.
- Execution ledger: order-attempt and broker-response audit.
- Analytical lifecycle tables: attribution and longitudinal evidence.

### Trust and safety boundaries

All order paths are hard-bound to paper endpoints and require existing explicit
gates. Observatory, migration verification, and trace commands are read-only with
respect to the broker. Provenance hashes use explicit configuration allowlists;
full environments and secret-bearing payloads are excluded. The trace command
does not return raw request, response, model-input, or environment JSON.

`PAPER_REVIEW_SIGNING_KEY` authenticates general review artifacts and 0DTE
submit attestations. It exists only in the VPS runtime secret file and is never
sent to Vercel. `HEDGE_REVIEW_SIGNING_KEY` remains independent. Missing keys,
unsigned/tampered artifacts, incomplete material evidence, or material drift
fail closed with structured blockers such as `FRESH_REVIEW_REQUIRED`. Exit,
protection, recovery, and reconciliation sections retain their domain gates and
do not depend on positive entry allocation room.

The safety floor does not define allocator weights, an optimization objective,
strategy budgets, an allocator mode, or allocator-owned exits. `baseline-v1`
records only the absence of allocator ownership. Ordinary equity, scale-in,
0DTE, and hedge caps remain owned by their existing configuration services.

### Runtime topology

The VPS runs the SQLite-backed CLI/control service and systemd timers. The
observatory timer wakes every 15 minutes during weekday market windows through the
existing locked monitor runner and performs a second market-clock check. Vercel is
only a dashboard/control bridge and does not execute orders or own SQLite state.
Late-day paper operations write a fresh signed artifact with
`sourceAction=paper.ops.late_day` and the normal 30-minute artifact TTL before
the separately scheduled reviewed exit executor runs.
