# Option Greek observability vertical slice

## Goal

Make the enabled paper options workflow observable end to end. The dashboard
must display the exact decision-time option snapshot that the VPS used while
evaluating a contract, including nullable Greeks and explicit data-quality
states. The dashboard must not recalculate or fetch current Greeks.

## Verified current state

- `src/services/providers/alpaca.ts` requests option snapshots from
  `/v1beta1/options/snapshots` and supplemental quotes from
  `/v1beta1/options/quotes/latest`, using the configured/default `opra` feed.
- `src/services/optionSnapshotNormalizer.ts` accepts current, legacy, and
  mixed provider aliases and retains nullable `delta`, `gamma`, `theta`,
  `vega`, and `rho` values.
- `src/services/optionsService.ts` writes the normalized Greeks to the local
  `option_snapshots` evidence table when the provider supplies them.
- Standard research uses IV, bid/ask spread, volume, open interest, and
  aggregate liquidity. It loads `delta` but does not use it; standard feature
  scoring does not load or use `gamma`, `theta`, `vega`, or `rho`.
- The strategy selector emits a synthetic option expression symbol rather than
  binding an actual OCC contract. The selected nearest contract snapshot must
  therefore be recorded as evidence with an explicit binding label.
- The VPS summary projection currently returns `optionContracts: []`, and the
  Options Runs UI does not render Greek fields.
- PostgreSQL is the active candidate authority in the verified VPS runtime.
  The existing `candidates.signal_inputs` JSONB column is the narrowest
  existing durable projection for nested decision evidence; no parallel option
  datastore is required for this slice.
- Read-only VPS diagnosis on 2026-07-17 showed paper mode/live trading
  disabled, but provider contract checks returned HTTP 401
  `PROVIDER_ERROR`. Live provider receipt of Greeks is not proven until the
  runtime authentication issue is resolved.

## Desired behavior

For each evaluated option contract, retain a nullable decision snapshot with:

- contract symbol, underlying, option type, strike, expiration, DTE, and
  multiplier;
- underlying price and explicit price source when available;
- bid, ask, midpoint, last, volume, open interest, implied volatility;
- delta, gamma, theta, vega, and rho;
- quote timestamp, decision timestamp, snapshot timestamp, quote age, source,
  and source feed;
- persisted spread percentage, liquidity/IV/selection metrics, candidate
  score when available, and rejection reasons.

Unavailable values remain `null`. The evidence includes explicit statuses for
provider-unavailable, partial, stale, enrichment-failed, and not-used cases;
missing values are never replaced with zero.

The standard scorer's actual usage map is persisted with the evidence. Greeks
are observability fields on the standard path unless a current strategy
condition demonstrably uses one. Existing 0DTE discovery continues to use its
current quote/spread/premium eligibility rules; this slice adds snapshot
evidence and rejection visibility without changing those rules.

Each Greek and major numeric market-data field also carries decision-use
metadata in the same evidence object:

```json
{
  "value": 0.3459,
  "used": false,
  "useType": null,
  "reason": "Retrieved from the provider but not used by the standard scorer"
}
```

`used` is true only when a non-null, non-stale, non-invalid value actually
participated in the current decision path. Retrieved-but-unused fields retain
their values with `useType: null`; unavailable, enrichment-failed, stale, and
invalid fields retain null or observed values with an explicit reason.

## Persistence and projection

- Add only additive provenance fields needed by the existing SQLite
  `option_snapshots` table, including research-run linkage, source feed, quote
  age, and persisted spread percentage.
- Carry the structured option evidence through the existing candidate
  `signal_inputs` JSON value so PostgreSQL authority retains the same values
  used to build and rank the candidate.
- Keep the decision-use metadata inside that same nested JSON value; do not add
  a separate metadata table or parallel datastore.
- Project the existing SQLite option evidence into the VPS dashboard summary
  and bridge response. The dashboard displays persisted values and statuses;
  it does not call Alpaca or derive replacement Greeks.
- Keep all order and broker paths paper-only and untouched.

## Scope and non-goals

In scope: the enabled options snapshot/feature/candidate path, its existing
SQLite evidence rows, PostgreSQL candidate projection, dashboard summary/API,
Options Runs rendering, and focused tests/fixtures.

Out of scope: a general PostgreSQL migration or authority audit, changing
strategy selection to a new contract model, adding a local Greek calculator,
backfilling historical Greeks, changing quote thresholds, enabling live
trading, deploying to the VPS/Vercel, or submitting any order.

## Acceptance criteria

1. Complete current-schema snapshots retain all supplied Greeks through
   normalization and persistence.
2. Candidate scoring receives the same persisted Greek values in its nested
   evidence, with an explicit standard-path usage map.
3. Decision evidence retains the exact snapshot and timestamps used for the
   candidate.
4. Missing/invalid Greeks remain nullable with a meaningful availability
   status, never zero.
5. Stale quote/snapshot data is labeled or rejected according to the existing
   freshness policy.
6. The dashboard API returns persisted snapshot fields and statuses.
7. The Options Runs UI renders Greek values and meaningful unavailable/stale/
   not-used states.
8. A no-selection discovery run retains evaluated candidates and rejection
   reasons wherever the current report schema supports them.
9. Candidate creation, the PostgreSQL JSONB projection, the dashboard API
   projection, and the Options Runs rendering retain and distinguish the
   decision-use metadata.
10. Focused tests pass, existing tests remain green, typecheck/build pass, and
   the final report includes sanitized paper-mode runtime evidence. No
   deployment is performed in this task.

## Validation plan

- Run focused red/green tests for the evidence contract, option persistence,
  candidate projection, dashboard projection/formatting, and no-selection
  discovery reporting.
- Run `npm run typecheck`, the relevant existing test suites, and `npm run
  build` after implementation.
- Use only sanitized, non-mutating paper-mode diagnostics for runtime proof.
  Do not print credentials or full environment values.
