# Guarded Paper Hedge Execution

**Repository:** `/Users/josephstewart/Documents/Alpaca Trading`  
**Date:** 2026-07-10  
**Status:** Approved for implementation and paper deployment  
**Risk level:** High - financially consequential paper execution  
**Target environments:** local mocked broker, paper VPS, production Vercel proxy  
**Baseline:** `main@67721e7324cfd8b48d679b0840db6e216d4baa57`

## Goal

Complete portfolio Greek measurement and add a fail-closed, paper-only hedge lifecycle that can discover, review, submit, monitor, learn from, and later exit one bounded long protective put. The first eligible reviewed hedge is authorized for submission to the Alpaca paper account after implementation, validation, merge, deployment, migration, and runtime safety checks pass.

Live trading remains prohibited.

## Verified Current State

- Local and VPS `main` are clean at `67721e7` and aligned with `origin/main`.
- The VPS reports `environment=paper`, `paperOnly=true`, `liveTradingEnabled=false`, and `HEDGE_PAPER_EXECUTION_ENABLED=false`.
- `alpaca-dashboard-control.service` is active on `127.0.0.1:4100`.
- Current option ingestion accepts Alpaca current and legacy aliases and persists delta, gamma, theta, vega, rho, IV, quote status, and timestamps.
- Portfolio risk currently measures signed option Greeks, but complete Greek/IV freshness, weighted coverage, groupings, and dashboard presentation are incomplete.
- `hedge:risk`, `hedge:regime`, `hedge:review`, and `hedge:plan --paperOnly` are read-only.
- Existing hedge plans are deliberately non-executable, use an unkeyed canonical hash as a checksum, and always carry `HEDGE_EXECUTION_NOT_IMPLEMENTED`.
- Existing paper reviewed execution can submit single orders, but hedge candidates must not be added to timer-owned `optionBuys`.
- The current client has no cancel, replace, or order-status method and no validated atomic multi-leg request model.
- Put spreads remain analysis-only with `MULTI_LEG_EXECUTION_UNSUPPORTED`.

## Desired End State

The deployed system must:

- measure held-option delta, gamma, theta, vega, rho, and implied volatility with explicit units, timestamps, quality, and coverage;
- make material delta gaps or stale evidence force `measurementStatus=indeterminate`, `effectiveBand=indeterminate`, `decision=monitor`, and `executionEligible=false`;
- discover current SPY and QQQ long-put candidates within a centralized policy;
- create exactly one HMAC-signed, expiring, account-bound executable paper review when eligible;
- revalidate the complete review and current broker/market state immediately before submission;
- submit only a bounded `buy_to_open` option limit order to the Alpaca paper endpoint;
- monitor, reprice, cancel, and record only the newly created hedge order within bounded limits;
- persist decision, review, execution, fill, protection, and evaluation evidence;
- expose authenticated review/execute/exit mutations through Vercel-to-VPS proxy routes;
- leave automated hedge submission disabled;
- leave live trading disabled and unsupported.

## Scope

### In scope

- Complete normalized option snapshot contract and portfolio Greek measurement.
- Greek and IV coverage, freshness, concentration, and quality gates.
- SPY/QQQ single-leg long-put discovery and ranking.
- Executable hedge review creation and HMAC verification.
- Paper entry execution, bounded fill management, and reconciliation.
- Paper exit review/execution using the same integrity model.
- Additive SQLite migration and learning events.
- CLI, authenticated control routes, Vercel proxy routes, dashboard display, and scheduler review/monitor integration.
- Feature branch, PR, merge, VPS deployment, Vercel production deployment, one eligible bounded paper hedge, and evidence-backed validation.

### Non-goals

- Live trading or live credentials for execution.
- Sequential emulation of option spreads.
- Automatic scheduled hedge submission.
- Executable inverse-ETF hedges.
- Automatic LEAPS trimming through the hedge executor; existing reviewed LEAPS exits remain authoritative.
- Unbounded market orders.
- General refactoring unrelated to portfolio Greeks or hedge lifecycle safety.

## Non-Negotiable Runtime Boundary

Every hedge mutation must prove all of:

```text
ALPACA_ENV=paper
TRADING_MODE=paper
ALPACA_LIVE_TRADE=false
LIVE_TRADING_ENABLED=false
PAPER_ORDER_EXECUTION_ENABLED=true
PAPER_OPTIONS_EXECUTION_ENABLED=true
HEDGE_PAPER_EXECUTION_ENABLED=true
HEDGE_LIVE_EXECUTION_ENABLED=false
HEDGE_AUTOMATED_PAPER_EXECUTION_ENABLED=false
broker endpoint=https://paper-api.alpaca.markets
explicit --confirmPaper or confirmPaper=true
```

Any disagreement fails closed. `HEDGE_LIVE_EXECUTION_ENABLED` is a permanent negative gate in this phase, not an opt-in path.

## Architecture

### 1. Market-data boundary

Add one canonical normalized option snapshot boundary. Current and legacy aliases are field-merged so a partial current object does not hide a valid legacy field. Non-finite values remain `null`; zero is preserved.

```ts
type NormalizedOptionGreeks = {
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
};

type NormalizedOptionSnapshot = {
  symbol: string;
  underlying: string;
  expiration: string;
  strike: number;
  optionType: "call" | "put";
  latestQuote: {
    bidPrice: number | null;
    askPrice: number | null;
    bidSize: number | null;
    askSize: number | null;
    timestamp: string | null;
  } | null;
  latestTrade: {
    price: number | null;
    size: number | null;
    timestamp: string | null;
  } | null;
  impliedVolatility: number | null;
  greeks: NormalizedOptionGreeks;
  snapshotTimestamp: string | null;
  normalizationPath: "current" | "legacy" | "mixed" | "none";
};
```

OCC identity is parsed through `optionSymbolService`; downstream services do not read compatibility aliases.

### 2. Portfolio Greek model

Per-position units are explicit:

- `deltaShares = signedContracts * multiplier * delta`
- `deltaDollars = deltaShares * underlyingPrice`
- `gammaSharesPerDollar = signedContracts * multiplier * gamma`
- `thetaDollarsPerDay = signedContracts * multiplier * theta`
- `vegaDollarsPerVolPoint = signedContracts * multiplier * vega`
- `rhoDollarsPerRatePoint = signedContracts * multiplier * rho`

Portfolio output includes net and absolute exposures, positive/negative theta, IV weighted by contracts/market value/absolute vega, and groupings by underlying, expiration, option type, and DTE bucket. Missing values are never coerced to zero in measured denominators or group totals.

### 3. Coverage and freshness

For delta, gamma, theta, vega, rho, and IV, report position count, absolute contract quantity, absolute market value, measured/unmeasured coverage, and observation freshness. Central policy uses:

```text
OPTION_GREEKS_CURRENT_MAX_AGE_SECONDS
OPTION_GREEKS_STALE_MAX_AGE_SECONDS
HEDGE_LIMIT_PRICE_MAX_AGE_SECONDS
```

Execution requires delta market-value coverage at least 95%, delta contract coverage at least 90%, no expired delta in portfolio sizing, and current quote/delta/OCC identity for the selected hedge.

### 4. Central execution policy

Initial defaults:

```text
HEDGE_ALLOWED_STRUCTURES=long_put
HEDGE_ALLOWED_UNDERLYINGS=SPY,QQQ
HEDGE_MIN_DTE=30
HEDGE_TARGET_DTE=60
HEDGE_MAX_DTE=120
HEDGE_TARGET_ABS_DELTA_MIN=0.20
HEDGE_TARGET_ABS_DELTA_MAX=0.40
HEDGE_MAX_BID_ASK_SPREAD_PCT=20
HEDGE_MAX_ORDERS_PER_RUN=1
HEDGE_MAX_NEW_CONTRACTS_PER_RUN=2
HEDGE_MAX_NEW_HEDGE_PREMIUM_PCT_EQUITY=0.75
HEDGE_MAX_TOTAL_HEDGE_PREMIUM_PCT_EQUITY=2.00
HEDGE_MAX_DAILY_HEDGE_PREMIUM_PCT_EQUITY=1.00
HEDGE_MIN_ORDER_NOTIONAL_DOLLARS=25
HEDGE_REVIEW_TTL_SECONDS=300
HEDGE_DUPLICATE_WINDOW_HOURS=24
HEDGE_MIN_REBALANCE_INTERVAL_HOURS=6
HEDGE_LIMIT_PRICE_MAX_AGE_SECONDS=60
HEDGE_ORDER_TIMEOUT_SECONDS=120
HEDGE_MAX_REPRICE_ATTEMPTS=2
```

Percentage settings are human percentages from 0 through 100 and normalize internally to ratios.

### 5. Executable reviewed payload

Create a separate `HedgeExecutionReview` rather than making the historical analysis plan directly executable. The review contains account hash, source snapshot/recommendation/regime IDs, one long-put order intent, reviewed market/Greek evidence, coverage, caps, warnings, blockers, deterministic client order ID, canonical payload hash, and HMAC-SHA256 signature.

`HEDGE_REVIEW_SIGNING_KEY` is required on the VPS. It is never returned, logged, persisted, or bundled into Vercel. Tests use an injected key.

Stored reviews are strictly schema-validated and hash/signature-verified on every read. Any material mutation creates a new review.

### 6. Manual paper executor

`hedge:execute -- --confirmPaper --reviewId="$REVIEW_ID" --format=json`:

1. runs runtime mutation preflight;
2. verifies paper endpoint and account identity;
3. loads and verifies the review;
4. refreshes account, positions, open/recent orders, selected contract, quote, snapshot, and buying power;
5. revalidates coverage, freshness, spread, price drift, quantity, premium, duplicate/frequency caps, and existing protection;
6. atomically reserves the deterministic client order ID in the execution ledger;
7. submits one simple `buy_to_open` limit order;
8. polls bounded order state, reprices at most twice without exceeding the reviewed premium, and cancels only that order at timeout;
9. persists every attempt and terminal state.

The client gains only the necessary paper methods: get order, replace order, and cancel order. Each asserts the paper endpoint and accepts a broker order ID returned from the reviewed hedge submission.

### 7. Reconciliation

Before reservation/submission and after terminal monitoring, reconcile:

- reviewed account hash versus current paper account;
- current option position versus reviewed quantity;
- open and recent broker orders versus client order ID and option symbol;
- execution ledger versus broker order state;
- account buying power and option approval;
- pre-existing positions/orders remain untouched.

Any material mismatch blocks new submission with `HEDGE_ACCOUNT_RECONCILIATION_MISMATCH`.

### 8. Exit lifecycle

Exit review supports paper-only `sell_to_close` for an identified hedge position. It uses current position quantity, current quote, repeated risk-normalization observations, and explicit reasons. Risk-normalization exits require two qualifying observations. Entry and exit reviews use different review types and client-order namespaces.

Initial defaults:

```text
HEDGE_EXIT_MIN_DTE=14
HEDGE_EXIT_PROFIT_TARGET_PCT=50
HEDGE_EXIT_LOSS_LIMIT_PCT=50
HEDGE_EXIT_RISK_NORMALIZED_CONFIRMATIONS=2
HEDGE_EXIT_MAX_ORDERS_PER_RUN=1
```

No initial exit is submitted unless a pre-existing hedge independently qualifies.

### 9. Persistence and learning

Migrations are additive and idempotent. Add a dedicated review table with a primary review ID and unique client order ID. Extend existing ledgers/learning records only with additive columns or canonical event rows. Do not persist secrets or full authenticated broker payloads.

Lifecycle events include risk/recommendation/candidate/review/execution/order/fill/position/protection/exit/outcome stages from the approved brief. Outcome evaluation distinguishes decision, selection, sizing, execution, protection, and exit quality.

### 10. API, dashboard, and scheduler

- Cached GET routes expose risk, regime, recommendation, review, execution, and learning.
- POST review/execute/exit routes require Vercel admin auth, VPS control auth, paper guards, explicit confirmation, and runtime preflight.
- Vercel is a proxy; it never holds broker credentials or writes runtime SQLite.
- Scheduler moments may refresh data, reviews, order monitoring, and learning evaluations.
- Scheduled submission remains disabled unless `HEDGE_AUTOMATED_PAPER_EXECUTION_ENABLED=true`; initial production value is false.
- Hedge orders never enter existing timer-owned reviewed `optionBuys`.

## Stable Blocker Codes

At minimum:

```text
HEDGE_REVIEW_EXPIRED
HEDGE_REVIEW_SIGNATURE_INVALID
HEDGE_PAYLOAD_CHANGED
HEDGE_EXECUTION_DISABLED
HEDGE_ENVIRONMENT_NOT_PAPER
HEDGE_LIVE_TRADING_ENABLED
HEDGE_ACCOUNT_IDENTITY_MISMATCH
HEDGE_ACCOUNT_RECONCILIATION_MISMATCH
HEDGE_DATA_COVERAGE_INSUFFICIENT
HEDGE_GREEKS_STALE
HEDGE_QUOTE_STALE
HEDGE_QUOTE_MOVED
HEDGE_SPREAD_TOO_WIDE
HEDGE_PREMIUM_CAP_EXCEEDED
HEDGE_DUPLICATE_ORDER
HEDGE_EXISTING_PROTECTION_SUFFICIENT
HEDGE_NO_ELIGIBLE_CONTRACT
HEDGE_ORDER_REJECTED
MULTI_LEG_EXECUTION_UNSUPPORTED
```

## Validation

Local execution tests use dependency-injected broker spies only. No local validation command may reach the real broker. Test clean, existing-schema, and development-database migrations; back up VPS SQLite before deployment.

Required validation:

```bash
npm run lint
npm test
npm run typecheck
npm run build
npm run dashboard:build
```

Run read-only hedge commands locally and on the VPS. Run real `hedge:execute` only once, after merged-main deployment, enabled paper execution, current review creation, and all runtime gates pass.

## Deployment Authorization

This specification authorizes:

- feature branch creation, commits, push, PR, checks, and merge to `main`;
- VPS database backup, code deployment, additive migration, required service restart, and paper-only environment configuration;
- production Vercel deployment and authenticated route validation;
- exactly one eligible bounded paper hedge entry, including bounded replace/cancel of that same order;
- read-only broker verification and post-execution learning.

It does not authorize live trading, unrelated order cancellation, unrelated position changes, autonomous hedge submission, destructive migrations, or unrelated infrastructure changes.

## Acceptance Criteria

Completion requires all deployment success criteria in the user-approved brief, including merged code, deployed VPS and Vercel revisions, complete Greek visibility, paper execution enabled, automated hedge submission disabled, one eligible reviewed hedge submitted when hard gates pass, broker/position verification, learning persistence, protection recalculation, duplicate resubmission rejection, and explicit proof that live trading remained disabled.
