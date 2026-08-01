# Option Lane Candidate Selection and Freshness Repair

## Objective

Restore the paper-only 0DTE and LEAPS paths so each lane can create a reviewed
PostgreSQL order intent only when its own current market, strategy, portfolio,
and operational evidence passes the existing gates. This change does not submit
a validation order, enable live trading, weaken freshness, change credentials,
or bypass review and arbitration.

## Confirmed failure boundaries

Research currently reduces every underlying's complete option chain to one call
and one put before assigning a strategy family. A higher-ranked longer-dated SPY
contract can therefore erase an eligible same-day contract, leaving the 0DTE
lane without a decision row.

The observed LEAPS contract reached review with an OPRA quote about 15 minutes
old, inside the existing 1,800-second limit, but review recorded stale evidence.
The repair must identify and refresh the exact stale component of the required
OPRA-contract and SIP-underlying pair. It must not extend the limit.

## Design

### Lane-separated option selection

Feature construction will retain independently ranked eligible candidates,
separated by call and put direction, for:

- `options_0dte`: SPY contracts expiring on the current New York trading date.
- `options_leaps`: contracts in the configured LEAPS DTE range.
- `standard_option`: eligible contracts outside those explicit lanes.

Existing OPRA provenance, quote, spread, liquidity, tradability, contract,
Greek, and score rules remain authoritative. Lane separation changes only which
eligible contracts compete; it never makes an ineligible contract eligible.
Stable score, symbol, expiration, strike, and contract-symbol ordering preserves
determinism.

### Focused pre-review evidence refresh

Before option entry review, the workflow will use the latest PostgreSQL evidence
for the selected contract and underlying. If either OPRA or SIP evidence is
absent, invalid, or stale, the scheduler will invoke the existing bounded
market-data boundary for only the selected symbols, then re-read PostgreSQL once.

The review service remains PostgreSQL-authoritative and broker-free. Refresh
failure, incomplete evidence, fence loss, or evidence that remains stale fails
closed with a component-specific reason. There is no threshold extension,
fallback feed, synthesized quote, or repeated retry.

### Unchanged downstream authority

Approved candidates retain the existing sequence: evidence validation, sizing,
portfolio arbitration, signed review, idempotent PostgreSQL intent persistence,
paper-only execution, and broker-event reconciliation. No new code path may call
the order manager, construct a broker payload, or submit outside that authority.

## Failure handling and observability

- 0DTE distinguishes missing, ineligible, stale-OPRA, stale-SIP, and strategy
  rejection states where the canonical result contract permits it.
- LEAPS failures remain candidate-scoped so one contract cannot block siblings.
- Refresh telemetry identifies the underlying, contract, reuse/refresh choice,
  and bounded result without logging credentials.

## Tests and acceptance criteria

Tests are written and observed failing before production changes.

- A higher-scoring longer-dated SPY contract cannot remove an eligible same-day
  SPY contract.
- Same-day classification uses `America/New_York`.
- LEAPS and standard candidates remain independently selectable.
- Fresh OPRA with stale SIP fails closed before intent persistence.
- One bounded refresh followed by fresh PostgreSQL OPRA and SIP evidence permits
  the existing review path to create an intent.
- Failed or incomplete refresh performs no intent or broker mutation.
- Focused tests, full tests, lint, typecheck, and builds pass.
- Paper/live-off and PostgreSQL-only checks pass before deployment is proposed.

Deployment remains separate. It requires a clean verified commit, exact SHA,
rollback, explicit authorization of that SHA, and at most one intentional worker
restart. Validation observes natural scheduled activity and manufactures no
order.
