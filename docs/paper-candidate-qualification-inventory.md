# Paper Candidate Qualification Inventory

Last verified against the PostgreSQL-only autonomous runtime on 2026-07-24.

## Runtime path and empty-work outcomes

The production path is `src/postgresOnlyCli.ts` → PostgreSQL research, review,
learning, and execution services. The four legitimate empty-work results
originate here:

| Result | Exact source | Meaning | Worker result |
| --- | --- | --- | --- |
| `NO_ELIGIBLE_POSTGRES_CANDIDATES` | `runPostgresReviewWorkflow` in `src/services/postgresReviewWorkflowService.ts` | The authoritative entry-review query returned no selected candidate that was eligible for this review command. | `classification=no_action`, `code=WORKSTREAM_NO_ACTION`, exit 0 |
| `NO_POSTGRES_EXIT_TRIGGER` | `runExitReview` in `src/services/postgresReviewWorkflowService.ts` | Authoritative open positions were evaluated and none met an existing protective exit rule. | `classification=no_action`, `code=WORKSTREAM_NO_ACTION`, exit 0 |
| `NO_READY_POSTGRES_ORDER_INTENTS` | `runAutonomousPostgresExecutionCommand` in `src/services/autonomousPostgresExecutionService.ts` | No PostgreSQL intent was ready or confirmable for submission. | `classification=no_action`, `code=WORKSTREAM_NO_ACTION`, exit 0 |
| `NO_RECONCILIABLE_POSTGRES_ORDERS` | `runAutonomousPostgresCommand` in `src/services/autonomousPostgresCommandService.ts` | The learning workstream found no completed PostgreSQL order eligible for reconciliation-based learning. | `classification=no_action`, `code=WORKSTREAM_NO_ACTION`, exit 0 |

`scripts/autonomous-paper-worker.mjs` performs the worker classification. Only
those four exact reason codes receive the successful `no_action`
classification. Other `blocked` results and any operational inability to
continue retain `WORKSTREAM_BLOCKED` or a more specific failure/deferred code.

## Paper exploration V3

All values below are applied only when all four environment assertions are
explicit: `ALPACA_ENV=paper`, `TRADING_MODE=paper`,
`ALPACA_LIVE_TRADE=false`, and `LIVE_TRADING_ENABLED=false`. Otherwise the
unchanged baseline profile is used.

| Strategy qualification gate | V2 | V3 | Change |
| --- | ---: | ---: | ---: |
| Absolute directional score | 0.05 | 0.04 | -20% |
| Minimum directional confidence | 0.10 | 0.05 | -5 percentage points |
| Minimum long-option confidence | 0.25 | 0.20 | -5 percentage points |
| Minimum aggressive-option confidence | 0.40 | 0.35 | -5 percentage points |
| Minimum defined-risk confidence | 0.50 | 0.45 | -5 percentage points |
| Minimum option expected return | 0.25% | 0.20% | -20% |
| Minimum defined-risk expected return | 0.50% | 0.40% | -20% |

The following gates are deliberately unchanged:

| Gate | V2 and V3 |
| --- | ---: |
| Minimum option liquidity score | 0.10 |
| Maximum option spread | 15% |
| Maximum candidates per research run | 25 |
| Maximum new-order notional | $1,000 |
| Current OPRA quote age | at most 1,200 seconds |
| LEAPS range | 180–730 DTE |

The computed candidate score in `postgresResearchWorkflowService.ts` is a
ranking value, not an additional qualification cutoff. Eligible candidates are
ranked and the first 25 are selected.

## Qualification by strategy family

### Equities, longs, and shorts

- Equity candidates require a directional score of at least `+0.04` for longs
  or at most `-0.04` for shorts.
- Both directions require confidence of at least `0.05`.
- There is no separate equity expected-return cutoff.
- Longs and shorts retain the same PostgreSQL market-evidence, account
  fingerprint, open-position/open-order, buying-power, cash/equity, allocation,
  notional, and position-capacity checks.
- Equity short review still requires sufficient quantity capacity; broker
  tradability/shortability and reconciliation remain execution gates.

### Options, long calls, and long puts

- Every option candidate first passes the equity directional and confidence
  gates above.
- Contract evidence must be active and tradable, have a current snapshot and
  underlying price, be OPRA-validated, have a quote no older than 1,200
  seconds, contain volume and open interest with positive combined liquidity,
  contain a spread no wider than 15%, and contain an entry price.
- The derived option liquidity score must remain at least `0.10`.
- A long-call branch requires confidence of at least `0.20` and expected return
  of at least `+0.20%`. A single-leg `long_call` expression additionally
  requires aggressive paper strategy permission, implied volatility above
  `0.25`, spread within 15%, and confidence strictly above `0.35`.
- A single-leg `long_put` requires a short direction, expected return at or
  below `-0.20%`, aggressive paper strategy permission, implied volatility
  above `0.22`, spread within 15%, and confidence strictly above `0.35`.
- Defined-risk call/put selection retains the existing nonzero ATR condition
  and aggressive-strategy permission. Its confidence threshold is `0.45` and
  expected-return magnitude threshold is `0.40%`.
- Research persists executable single-contract option candidates only for
  `long_call` and `long_put`. The V3 change does not add or simulate multi-leg
  execution.

### 0DTE

- A selected SPY option whose expiration date is the current New York date is
  classified as `zero_dte_spy`; it inherits the long-call or long-put
  qualification gates above.
- `paper:options:discover` still requires the requested underlying and an exact
  0–730 DTE input, then scopes review to that underlying and expiration.
- The existing 0DTE exit window, protective exit rules, option validation,
  buying power, position limits, authorization, and reconciliation are
  unchanged.

### LEAPS

- A selected executable option between 180 and 730 DTE is classified as
  `leaps`; it inherits the same long-call or long-put qualification gates.
- The 180-day minimum cannot be configured lower. LEAPS execution and exit
  validation remain unchanged.

### Hedge review

- The current PostgreSQL `hedge:review` command introduces no independent
  score, confidence, or expected-return threshold. It admits only candidates
  already selected by research whose `strategy_family` contains `hedge`.
- Hedge entry/exit review retains PostgreSQL position/account authority,
  current market evidence, allocation, coverage, liquidity, risk, signing,
  authorization, and reconciliation gates.
- Historical non-PostgreSQL hedge recommendation settings are not part of the
  autonomous production qualification path and were not changed.

## Safety boundary

V3 changes only the seven strategy qualification numbers in the first table.
It does not change paper/live assertions, PostgreSQL authority or scheduler
fencing, SIP/OPRA freshness, option-contract observability, liquidity/spread
validation, broker/account reconciliation, duplicate prevention, buying power,
cash/equity availability, allocation and position limits, maximum order
notional, stop-loss/take-profit or forced-exit rules, signing/authorization,
confirmation, reservations, or order-state reconciliation.
