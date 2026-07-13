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
4. `paper_review_decisions` joins exact reviewed payload indexes to entry or exit
   decisions. Existing review, eligibility, reservation, duplicate, freshness,
   sizing, exposure, and live-off gates remain authoritative.
5. A confirmed paper fill with exact execution-ledger lineage creates one
   `paper_positions` analytical lifecycle. Observations are append-only. A single
   possible lifecycle links exactly; multiple possible netted lifecycles link as
   ambiguous and suppress per-decision analytics.
6. Terminal outcomes are derived only from persisted exact observations. The
   original is unique and immutable; corrections are revision rows.
7. Learning records reference candidate, entry/exit decisions, lifecycle,
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

### Runtime topology

The VPS runs the SQLite-backed CLI/control service and systemd timers. The
observatory timer wakes every 15 minutes during weekday market windows through the
existing locked monitor runner and performs a second market-clock check. Vercel is
only a dashboard/control bridge and does not execute orders or own SQLite state.
