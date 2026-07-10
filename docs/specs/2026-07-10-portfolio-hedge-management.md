# Portfolio Risk and Hedge Management

Status: Approved for implementation

Implementation baseline: `paper-ops-layer` at `42e45c5`

Safety mode: read-only, paper-only

Risk model version: `portfolio-risk-v1`

Regime model version: `market-regime-v1`

Hedge plan version: `hedge-plan-v1`

## Goal

Add an explainable portfolio-risk and hedge-management layer to the existing paper operations architecture. The layer must normalize equity and option exposure, calculate portfolio-level risk, classify the market regime, recommend and size hedges, produce signed and expiring paper-only plan artifacts, expose read-only CLI and dashboard surfaces, and record outcomes for later learning.

The implementation must stop before order submission. It may analyze multi-leg put spreads, but it must never expose a multi-leg submission path or add hedge orders to the current reviewed executor.

## Verified Current State

The `paper-ops-layer` branch already provides the foundations this work must reuse:

- paper account and position reads;
- option snapshot persistence with Greeks;
- daily market-bar persistence;
- reviewed-artifact hashing, signatures, expiry, and replay protection;
- paper runtime mutation preflight and paper/live environment guards;
- LEAPS review and reviewed exit execution services;
- a paper learning ledger and paper operation log;
- a paper operations scheduler;
- authenticated dashboard bridge routes with request and correlation identifiers;
- redaction utilities and paper-only dashboard boundaries.

The branch does not yet provide:

- a single canonical OCC option-symbol parser;
- a normalized portfolio-risk snapshot;
- portfolio beta or concentration analysis;
- a deterministic market-regime classifier;
- an explainable portfolio-risk score;
- hedge selection, sizing, or signed hedge plans;
- hedge recommendation persistence or learning records;
- read-only hedge CLI, API, or dashboard views.

Option parsing is currently duplicated in portfolio review, LEAPS review, asset identity, and paper dry-run services. The new parser must replace those local interpretations without changing their existing public behavior.

## Desired End State

A paper-only operator can run:

```bash
npm run hedge:risk -- --format=json
npm run hedge:regime -- --format=json
npm run hedge:review -- --format=json
npm run hedge:plan -- --paperOnly --format=json
```

The first three commands are read-only analyses. `hedge:plan` may persist a signed, expiring planning artifact and learning record, but cannot submit or stage an order for submission. The paper operations scheduler may refresh cached risk and recommendation records, but cannot call any hedge execution code.

The dashboard displays the latest persisted recommendation only. It distinguishes current, stale, expired, monitoring, and blocked states and never presents an expired or stale recommendation as current.

## Scope

### In scope

- canonical option parsing and shared option metadata;
- normalized equity, option, cash, and inverse-exposure representation;
- Greeks-based exposure when observed data is available;
- signed-exposure portfolio beta and concentration metrics;
- scenario losses for 5%, 8%, 10%, and 15% benchmark declines;
- deterministic market-regime classification;
- an explainable 100-point risk score;
- hedge recommendation and modeled-loss protection sizing;
- LEAPS trimming and profit-funded hedge recommendations;
- existing-protection offsets for puts and inverse ETFs;
- put-spread analysis with a hard execution blocker;
- SH and PSQ as secondary tactical candidates;
- signed and expiring hedge-plan artifacts;
- read-only CLI commands and authenticated read-only routes;
- cached dashboard retrieval;
- scheduler refreshes that cannot submit orders;
- hedge-learning records in `paper_learning_records`;
- SQLite high-water marks and bounded beta caching;
- tests, documentation, and validation.

### Non-goals

- submitting paper or live orders;
- enabling a live hedge path;
- adding a `hedge:execute` package script or public route;
- adding hedge orders to the current reviewed execution sections;
- creating synthetic multi-leg execution;
- changing the existing LEAPS exit authorization or execution behavior;
- deploying, pushing, merging to `main`, or modifying VPS/runtime state;
- fabricating Greeks, prices, betas, regimes, or recommendations when evidence is missing.

## Safety and Authorization Boundaries

This phase is read-only and paper-only.

- `HEDGE_PAPER_EXECUTION_ENABLED` defaults to `false` and must be exactly `false` for all supplied validation commands.
- No hedge service may import or call a broker order-submission method.
- No hedge CLI command or dashboard route may expose order submission.
- The scheduler may invoke analysis, recommendation, and persistence services only.
- The future execution-gate scaffold is a pure authorization decision with no broker dependency. It must fail closed unless every paper-only gate passes, while this phase still returns `HEDGE_EXECUTION_NOT_IMPLEMENTED` even when configuration gates are otherwise satisfied.
- Put-spread recommendations must include the blocker `MULTI_LEG_EXECUTION_UNSUPPORTED`.
- Missing material evidence must yield `null`, warnings, `monitoring`, or `blocked`; it must never yield an inferred numeric value.
- Existing runtime mutation preflight, paper/live guards, authentication, artifact integrity, freshness validation, duplicate protection, request identifiers, correlation identifiers, and redaction remain unchanged or are reused.
- No external account connection is required for unit tests. Read-only CLI validation may use safe paper configuration and must not invoke an order endpoint.

## Architecture

The implementation follows the existing service-oriented CLI-first structure.

1. `optionSymbolService` parses OCC symbols into typed metadata.
2. `portfolioRiskService` reads the paper account, positions, persisted market data, option snapshots, and configuration, then creates a normalized risk snapshot.
3. `portfolioBetaService` calculates or retrieves compatible cached betas.
4. `marketRegimeService` classifies current conditions from persisted benchmark bars and volatility evidence.
5. `portfolioRiskScoreService` converts measured exposures, concentration, drawdown, regime, and quality into an explainable 100-point score.
6. `hedgeRecommendationService` chooses monitoring, trimming, or protective instruments and sizes protection against modeled scenario loss.
7. `hedgePlanService` creates a signed, expiring planning artifact without execution authority.
8. `hedgePersistenceService` stores recommendations, plans, high-water marks, and beta cache entries in SQLite.
9. `hedgeLearningService` writes normalized decision and outcome records to `paper_learning_records`.
10. CLI, dashboard bridge, and scheduler entry points call the same services and never bypass their validation.

## Canonical Option Parsing

The canonical parser accepts an option symbol and returns a discriminated union.

Success:

```ts
type OptionSymbolParseSuccess = {
  ok: true;
  input: string;
  normalizedSymbol: string;
  underlying: string;
  expirationDate: string;
  optionType: "call" | "put";
  strikePrice: number;
  strikeMilliunits: number;
  occRoot: string;
};
```

Failure:

```ts
type OptionSymbolParseFailure = {
  ok: false;
  input: string;
  code:
    | "OPTION_SYMBOL_EMPTY"
    | "OPTION_SYMBOL_FORMAT_INVALID"
    | "OPTION_EXPIRATION_INVALID"
    | "OPTION_STRIKE_INVALID";
  message: string;
};
```

Rules:

- normalize case and remove permitted broker display spacing before validation;
- parse the OCC root, six-digit expiration, call/put marker, and eight-digit strike;
- validate that the expiration is a real calendar date;
- retain strike milliunits and expose a dollar strike;
- calculate days to expiration from UTC date boundaries in callers that have an explicit as-of timestamp;
- return typed failures instead of throwing for user or market-data input;
- replace duplicated parsing in asset identity, portfolio review, LEAPS review, and paper dry-run logic.

## Normalized Portfolio-Risk Snapshot

The snapshot contains:

- `snapshotId`: deterministic hash of environment, account timestamp, positions, and model configuration;
- `generatedAt` and source timestamps;
- `environment`, which must be `paper`;
- account equity, cash, buying power, and prior/high-water equity when observed;
- normalized positions;
- aggregate exposure and concentration metrics;
- portfolio beta and scenario results;
- market regime and risk score;
- data-quality summary, warnings, and blockers;
- risk and regime model versions;
- configuration fingerprint.

Each normalized position records:

- broker symbol and parsed underlying;
- asset class and option type where applicable;
- signed quantity;
- observed mark or market value;
- absolute and signed notional exposure;
- cost basis and unrealized profit/loss when observed;
- sector classification and source;
- beta, beta status, and beta provenance;
- option multiplier;
- delta, gamma, theta, vega, and rho when observed;
- delta-equivalent shares and delta-adjusted notional when calculable;
- expiration, strike, days to expiration, and moneyness when calculable;
- data-quality status, warnings, and blockers.

### Exposure rules

- Equity signed exposure is observed market value, preserving long or short direction.
- Option delta-equivalent shares are `quantity * multiplier * delta`.
- Option delta-adjusted exposure is `deltaEquivalentShares * underlyingPrice`.
- Gamma, theta, and vega aggregate only observed Greeks and preserve sign.
- Existing long puts contribute negative delta and modeled downside protection.
- Inverse ETFs contribute negative signed exposure and are identified explicitly.
- If option delta, multiplier, underlying price, or material price evidence is unavailable, the related exposure is `null` and a quality warning is recorded.
- Missing Greeks are never reconstructed from moneyness, time, or implied volatility in this phase.

### Data-quality statuses

Every snapshot has one of:

- `complete`: all material inputs required for scoring and recommendation are observed;
- `partial`: some non-critical inputs are unavailable, but a bounded recommendation can be explained;
- `monitoring`: risk can be described, but hedge sizing is not sufficiently supported;
- `blocked`: paper safety, account identity, materially missing prices/Greeks, or integrity requirements prevent a recommendation.

The service records component coverage percentages for position prices, option delta, option gamma, option theta, option vega, beta, and sector classification.

### Material option-delta coverage gate

The snapshot also reports contract-quantity and absolute-market-value delta coverage:

```ts
optionDataCoverage: {
  totalOptionContracts: number;
  contractsWithDelta: number;
  contractsWithoutDelta: number;
  contractDeltaCoveragePct: number | null;
  totalOptionMarketValue: number;
  optionMarketValueWithDelta: number;
  optionMarketValueWithoutDelta: number;
  marketValueDeltaCoveragePct: number | null;
  materialCoverageMissing: boolean;
};
```

Coverage ratios use absolute held contract quantity and absolute observed option market value. Contract coverage is materially insufficient when total observed option market value is at least the configured material-exposure threshold and contract delta coverage is below its minimum. Market-value coverage is materially insufficient when unmeasured option market value is at least the configured percentage of account equity and market-value delta coverage is below its minimum.

When either condition is material, portfolio beta, aggregate option delta, positive-delta concentration, and net scenario loss remain `null`. The engine records `MATERIAL_OPTION_GREEKS_COVERAGE_INSUFFICIENT`, returns monitoring, and does not size or rank a hedge. It may use market value, moneyness, and DTE only to characterize data completeness; it does not convert those fields into estimated delta.

## Portfolio Beta

### Formula

For positions with compatible observed or calculated beta:

```text
position beta exposure = signed delta-adjusted market exposure * position beta
portfolio beta = sum(position beta exposure) / account equity
```

For ordinary equities, delta-adjusted exposure equals signed market value. For options, it uses delta-equivalent exposure. Cash has zero beta. Inverse exposure remains signed. Missing position beta contributes no numeric estimate and reduces beta coverage; it is not treated as zero.

The portfolio beta result is `null` when beta coverage falls below the configured materiality threshold or account equity is not a positive observed value.

### Beta calculation

- benchmark default: `SPY`;
- source: persisted split-adjusted daily bars already used by the research layer;
- return series: aligned close-to-close simple returns;
- beta: sample covariance of symbol returns with benchmark returns divided by benchmark sample variance;
- lookback, observation interval, and minimum observations are configuration inputs;
- a calculation fails closed when observation count is insufficient or benchmark variance is zero.

### Bounded beta-cache identity and invalidation

Each beta cache entry is identified or validated by all of:

- symbol;
- benchmark;
- lookback period;
- observation interval;
- minimum observation requirement;
- calculation version;
- latest symbol and benchmark market-data date, represented by the effective latest aligned market-data date.

The SQLite row also stores beta, observation count, data window, computed timestamp, expiry timestamp, and calculation status.

A cached beta may be reused only when:

- every identity input exactly matches the current request;
- the cached latest market-data date equals the latest currently available aligned date;
- the row has not expired;
- the stored observation count still meets the requested minimum;
- the row has a successful status and finite beta.

Stale, expired, incompatible, incomplete, or non-finite rows are ignored. They may remain for audit or cleanup but cannot silently satisfy a request. Cache lookup never falls back from one benchmark, interval, lookback, minimum observation count, calculation version, or data date to another.

## Concentration and Factor Analysis

The snapshot calculates:

- largest absolute position weight;
- top-five absolute position weight;
- underlying concentration after grouping equity and options by underlying;
- sector concentration using the existing or configured symbol-to-sector mapping;
- gross exposure divided by equity;
- net signed exposure divided by equity;
- long and short/inverse exposure;
- option delta, gamma, theta, and vega exposure;
- expiration-bucket concentration;
- positive-delta LEAPS concentration;
- unrealized-gain concentration where cost evidence is available.

Unknown sector classifications remain `unknown` and reduce sector coverage. They must not be assigned to a guessed sector.

## Scenario Analysis

The engine evaluates benchmark declines of 5%, 8%, 10%, and 15%.

For each scenario:

- equity and linear exposure loss is based on signed beta exposure;
- option delta impact uses observed delta-equivalent exposure;
- second-order option impact uses observed gamma only when underlying price and gamma are available;
- existing puts and inverse exposure reduce modeled loss according to their measured exposure;
- losses are reported in dollars and as a percentage of equity;
- the result carries coverage and quality metadata.

No scenario may imply full distributional confidence. It is a deterministic sensitivity estimate, not value-at-risk.

## Market-Regime Classification

The classifier uses persisted evidence for `SPY`, `QQQ`, and a volatility proxy configured for the deployment. It derives:

- price relative to 50-day and 200-day simple moving averages;
- 20-day realized volatility and its configured elevated threshold;
- 20-day maximum drawdown;
- short-term breadth proxy from SPY and QQQ trend agreement;
- current volatility-proxy level and trend when observed.

Rule priority is deterministic and first-match wins:

1. `insufficient-data`: any required benchmark lacks the configured minimum observations; recommendation status becomes monitoring or blocked.
2. `crisis`: SPY is at least 10% below its 50-day moving average, or 20-day drawdown is at least 12%, or the observed volatility proxy is at or above the configured crisis threshold.
3. `risk-off`: SPY is below its 200-day moving average and QQQ is below its 200-day moving average, or realized volatility is elevated while both are below their 50-day moving averages.
4. `transition`: SPY and QQQ trend directions disagree, or either benchmark crosses its 50-day average while still on the opposite side of its 200-day average, or volatility is elevated without a risk-off match.
5. `risk-on`: SPY and QQQ are above both 50-day and 200-day moving averages and realized volatility is below the elevated threshold.
6. `neutral`: sufficient data exists but none of the preceding rules match.

The classifier returns the selected rule, all measured inputs, missing-input warnings, and the model version. It does not call a language model or rely on nondeterministic inference.

## Explainable 100-Point Risk Score

The total is the capped sum of ten independently reported components:

| Component | Maximum points | Basis |
| --- | ---: | --- |
| Gross exposure | 15 | Gross exposure divided by equity |
| Beta-adjusted exposure | 15 | Absolute portfolio beta and beta coverage |
| Options convexity | 15 | Delta/gamma/vega exposure and downside asymmetry |
| Positive-delta option concentration | 10 | Long call/LEAPS delta-equivalent concentration |
| Largest position | 10 | Largest grouped-underlying absolute weight |
| Top-five concentration | 8 | Top-five grouped-underlying absolute weight |
| Expiration concentration | 7 | Option exposure in near and clustered expirations |
| Drawdown | 8 | Current equity versus persisted high-water mark |
| Market regime | 7 | Deterministic regime severity |
| Data quality | 5 | Missing material prices, Greeks, beta, or sector data |

Each component returns its points, maximum, measured value, thresholds, rationale, and quality status. Total score bands are:

- `0-24`: low;
- `25-44`: moderate;
- `45-64`: elevated;
- `65-79`: high;
- `80-100`: critical.

No quality penalty repairs missing exposure. If material data is missing, numeric components remain bounded by observed data, the data-quality component increases, and recommendation status may still become monitoring or blocked.

The score output distinguishes the calculated score from the confidence of the measurement. `band` remains the band calculated from supported numeric components. `measurementStatus` is `measured`, `partially_measured`, `indeterminate`, or `blocked`; `effectiveBand` becomes `indeterminate` when material option delta coverage is insufficient or the assessment is blocked. Missing evidence does not artificially add score points.

## Hedge Decision Logic

Decision priority is deterministic:

1. block when environment or integrity gates fail;
2. monitor when data quality cannot support sizing;
3. recognize existing puts and inverse exposure before adding protection;
4. recommend trimming concentrated or profitable positive-delta LEAPS before paid protection when trimming can meet the protection need;
5. use profit-funded hedge budgeting when observed unrealized LEAPS gains are available;
6. rank a protective SPY or QQQ put when portfolio exposure and market evidence support it;
7. analyze a defined-risk put spread only as a non-executable alternative;
8. rank SH or PSQ only as secondary tactical alternatives and disclose path dependency and tracking risk;
9. recommend monitoring when modeled benefit does not exceed configured cost and quality thresholds.

Recommendation statuses are:

- `current`;
- `monitoring`;
- `blocked`;
- `stale`;
- `expired`.

## LEAPS Risk Logic

A position is a LEAPS candidate only when the canonical parser identifies a call and its observed as-of days to expiration meets the configured threshold. The system records inferred classifications as warnings when broker metadata is absent.

LEAPS analysis includes:

- delta-equivalent exposure and underlying concentration;
- expiration and moneyness;
- observed unrealized profit and profit percentage;
- share of total positive option delta;
- scenario contribution;
- liquidity evidence when current quote data is available;
- whether the existing LEAPS exit service already recommends a trim or close.

Trimming is preferred when concentration, risk score, or regime thresholds are exceeded and a trim can reduce modeled loss without adding premium cost. Existing LEAPS exit recommendations are referenced rather than duplicated, and hedge planning must not authorize a LEAPS exit.

Profit-funded protection budget is:

```text
eligible realized budget proxy = max(0, observed unrealized LEAPS gain)
profit-funded cap = eligible gain proxy * configured profit allocation
premium budget = min(profit-funded cap, configured NAV premium cap)
```

This is a recommendation metric only. It does not imply that profit has been realized, and the UI must label it accordingly.

## Hedge Target and Sizing

The hedge target percentage is the desired percentage of modeled scenario loss to protect, not a percentage of NAV to allocate.

```text
gross protection target = modeled loss at selected scenario * target protection percentage
net protection target = max(0, gross target - existing measured protection)
```

The selected scenario and target protection percentage vary by risk-score band and regime, with configuration-bounded defaults. Instrument sizing must report:

- target scenario;
- gross modeled loss;
- desired protected loss;
- existing measured protection;
- net protection need;
- expected payoff per unit under the selected scenario;
- units required before caps;
- units after liquidity, premium, and position caps;
- residual unprotected loss;
- all assumptions and quality blockers.

For options, expected payoff uses the observed strike and premium/mark under the deterministic terminal scenario. A recommendation requires an observed usable quote or mark. Missing option price or spread produces monitoring or a blocker, never a zero-cost hedge.

Put spreads may be ranked by modeled long-put payoff minus modeled short-put payoff and net debit, but every spread result contains `MULTI_LEG_EXECUTION_UNSUPPORTED` and cannot enter an executable artifact.

SH and PSQ sizing uses signed observed price and the configured benchmark relationship. Recommendations disclose that inverse ETFs rebalance daily and may not track a multi-day scenario linearly.

## Signed Hedge-Plan Artifacts

`hedge:plan --paperOnly` creates a planning artifact only when the recommendation is current or explicitly monitoring with no trade candidates. A plan includes:

- deterministic plan identifier and source recommendation identifier;
- generated and expiration timestamps;
- environment fixed to `paper`;
- source account or portfolio snapshot identifier when available;
- risk and regime model versions;
- hedge-plan version;
- configuration fingerprint;
- data-quality and recommendation statuses;
- modeled candidates and non-executable blockers;
- reviewed payload and canonical reviewed-payload hash;
- signature algorithm and signature;
- request and correlation identifiers;
- artifact status.

Canonical hashing and signature verification reuse the reviewed-artifact integrity pattern. The plan is invalid when its environment, expiry, source snapshot, configuration fingerprint, reviewed hash, or signature does not match current evidence.

The plan must not include a broker submission payload, client order identifier, or any flag that causes the current paper executor to recognize it as an order section.

## Persisted Recommendation Integrity

The dashboard may read the latest persisted recommendation, but every persisted recommendation record must retain:

- generation timestamp;
- expiration timestamp;
- environment;
- source account or portfolio snapshot identifier when available;
- risk model version;
- regime model version;
- configuration fingerprint;
- data-quality status;
- recommendation status;
- reviewed-payload hash when planning occurred.

The persisted payload also retains its recommendation identifier, request and correlation identifiers, risk snapshot, regime snapshot, score breakdown, candidates, warnings, blockers, and persistence timestamp.

On read, status is re-evaluated against current time and configuration fingerprint:

- after expiration, status is `expired`;
- before expiration but beyond the configured freshness age, status is `stale`;
- a configuration or model-version mismatch is `stale` or `blocked` according to materiality;
- neither stale nor expired records can be labeled current;
- a missing integrity field prevents a legacy or malformed record from being treated as current.

The dashboard must render the effective status, generation time, expiry, source snapshot, model versions, configuration match, quality summary, and warnings prominently.

## Persistence

New SQLite persistence is limited to:

- `portfolio_high_water_marks` for environment-scoped observed equity highs;
- `portfolio_beta_cache` for bounded beta estimates and their complete identity;
- existing `paper_learning_records` for hedge recommendations, hedge plans, and later outcomes.

`paper_learning_records` uses distinct record types and canonical JSON payloads:

- `hedge_recommendation`;
- `hedge_plan`;
- `hedge_outcome` reserved for later observed outcomes.

Records use deterministic identifiers or uniqueness checks to prevent duplicate scheduler writes for the same snapshot and model configuration. Persisted JSON is parsed and validated at read boundaries. Malformed records are ignored with sanitized warnings.

High-water marks update only from observed positive paper account equity. A lower observation cannot reduce the stored high-water mark. Environment identity is part of the key.

## Read-Only CLI Contracts

All commands accept `--format=json`; human-readable output remains concise and redacted.

### `hedge:risk`

Returns the normalized risk snapshot, component coverage, scenarios, warnings, and blockers. It performs no persistence except a bounded beta-cache refresh and an observed paper high-water-mark update.

### `hedge:regime`

Returns measured regime inputs, selected rule, status, warnings, and blockers. It does not call the broker.

### `hedge:review`

Returns the risk snapshot, regime, risk score, recommendation, and candidates. It may persist a recommendation and learning record unless a read-only no-persist flag is supplied for tests.

### `hedge:plan --paperOnly`

Requires explicit `--paperOnly`, paper environment, and `HEDGE_PAPER_EXECUTION_ENABLED=false`. It creates and verifies a signed, expiring planning artifact. It never submits, queues, or stages an order.

No `hedge:execute` command is added in this phase.

## Dashboard and API

Authenticated read-only bridge routes expose:

- latest risk snapshot;
- latest market regime;
- latest persisted recommendation or plan summary.

The VPS control layer may provide corresponding GET endpoints using the existing token authentication, redaction, request/correlation IDs, timeout handling, and paper-only environment checks. No POST execution endpoint is added.

The dashboard reads cached persisted results rather than running broker or market-data work in the request path. It displays:

- calculated risk score and calculated band;
- measurement status and effective risk band;
- effective decision status and option delta coverage by contracts and market value;
- effective recommendation status;
- exposure, beta, concentration, and data-quality summaries;
- scenario losses and existing protection;
- market regime and selected rule;
- LEAPS trim/profit-funded recommendation;
- ranked hedge candidates and non-executable blockers;
- generation/expiration timestamps, source snapshot, model versions, and configuration match.

Expired and stale states use explicit labels and explanatory copy. They are not visually or textually presented as current.

## Scheduler Integration

The existing paper operations moments may refresh risk, regime, and recommendation records after account state is synchronized. Scheduler integration:

- invokes analysis and persistence services only;
- cannot call an executor or broker order method;
- skips and records a sanitized blocker when paper environment checks fail;
- uses deterministic deduplication for the same source snapshot and model configuration;
- carries request and correlation identifiers into persisted records and operation logs;
- does not add a new order-capable timer.

## Future Execution-Gate Scaffold

A pure `evaluateHedgeExecutionGate` function documents future requirements:

- paper environment;
- explicit paper-only intent;
- `HEDGE_PAPER_EXECUTION_ENABLED=true` in a future authorized phase;
- valid, unexpired signed plan;
- matching source snapshot and configuration fingerprint;
- matching reviewed-payload hash;
- duplicate/replay protection;
- supported single-leg instrument;
- runtime mutation preflight.

In this phase the final result remains blocked by `HEDGE_EXECUTION_NOT_IMPLEMENTED`. The scaffold has no order-submission dependency and is not exposed through CLI or HTTP.

## Configuration

New configuration is namespaced and has conservative defaults:

- `HEDGE_PAPER_EXECUTION_ENABLED=false`;
- `HEDGE_RISK_MODEL_VERSION=portfolio-risk-v1`;
- `HEDGE_REGIME_MODEL_VERSION=market-regime-v1`;
- `HEDGE_PLAN_VERSION=hedge-plan-v1`;
- `HEDGE_RECOMMENDATION_TTL_MINUTES`;
- `HEDGE_RECOMMENDATION_FRESHNESS_MINUTES`;
- `HEDGE_PLAN_TTL_MINUTES`;
- `HEDGE_BETA_BENCHMARK=SPY`;
- `HEDGE_BETA_LOOKBACK_DAYS`;
- `HEDGE_BETA_OBSERVATION_INTERVAL=1Day`;
- `HEDGE_BETA_MIN_OBSERVATIONS`;
- `HEDGE_BETA_CALCULATION_VERSION`;
- `HEDGE_BETA_CACHE_TTL_HOURS`;
- `HEDGE_BETA_MIN_COVERAGE`;
- `HEDGE_MIN_OPTION_DELTA_CONTRACT_COVERAGE_PCT=80`;
- `HEDGE_MIN_OPTION_DELTA_MARKET_VALUE_COVERAGE_PCT=80`;
- `HEDGE_MATERIAL_UNMEASURED_OPTION_EXPOSURE_PCT=10`;
- `HEDGE_REGIME_REALIZED_VOL_THRESHOLD`;
- `HEDGE_REGIME_VOLATILITY_PROXY`;
- `HEDGE_REGIME_CRISIS_VOL_LEVEL`;
- `HEDGE_TARGET_PROTECTION_*` by score/regime band;
- `HEDGE_PREMIUM_NAV_CAP`;
- `HEDGE_PROFIT_ALLOCATION`;
- `HEDGE_LEAPS_MIN_DTE`;
- `HEDGE_LEAPS_CONCENTRATION_THRESHOLD`;
- `HEDGE_MAX_OPTION_SPREAD_PCT`;
- `HEDGE_SECTOR_MAP_JSON` for explicit local mappings only.

Configuration validation rejects non-finite, negative, out-of-range, or internally inconsistent values. The configuration fingerprint hashes only normalized non-secret risk, regime, sizing, and freshness settings. It never includes tokens or credentials.

The three option-coverage environment values are expressed as percentages from 0 through 100 and normalized internally to ratios.

## Observed Option Snapshot Compatibility (2026-07-10)

Read-only checks of current paper positions validated `SPY270115C00805000` and `QQQ270115C00840000` through Alpaca's `/v1beta1/options/snapshots` path. Both symbols were accepted and both responses included current quotes, implied volatility, and complete delta/gamma/theta/vega/rho values. The response used camelCase keys (`greeks`, `latestQuote`, `latestTrade`, and `impliedVolatility`), while the ingestion parser recognized only legacy-shaped keys (`Greeks`, `latest_quote`, `latest_trade`, and `implied_volatility`). The parser now accepts both shapes and derives a missing underlying from the canonical OCC symbol. This was a parser compatibility defect, not evidence of missing entitlement, unsupported OCC formatting, batching failure, stale market state, or unavailable snapshot data for the two representative contracts.

## Observability and Redaction

- Every CLI or route invocation has request and correlation identifiers.
- Recommendation, plan, scheduler, and gate outcomes use sanitized operation-log details.
- Configuration output reports non-secret normalized values only.
- Tokens, credentials, raw environment values, broker account identifiers, and secret material are not logged or returned.
- Error output uses stable blocker codes plus sanitized messages.

## Tests

The implementation must add or update tests for:

- valid and invalid OCC symbols, including calendar and strike validation;
- UTC days-to-expiration parity across migrated callers;
- normalized equity, call, put, inverse, and cash exposure;
- missing prices, Greeks, multipliers, betas, sectors, and account equity;
- signed portfolio-beta calculation;
- beta cache identity, compatible reuse, expiration, data-date change, version change, benchmark change, interval change, lookback change, and minimum-observation change;
- concentration and scenario calculations;
- every regime rule and rule priority;
- all risk-score components, caps, bands, and quality effects;
- existing-protection offsets;
- LEAPS trimming and profit-funded budget rules;
- hedge sizing, premium caps, liquidity blockers, and residual protection;
- put-spread ranking with `MULTI_LEG_EXECUTION_UNSUPPORTED`;
- SH/PSQ disclosure and sizing;
- recommendation persistence integrity and malformed-row handling;
- current, stale, expired, model-mismatch, configuration-mismatch, and missing-integrity recommendation reads;
- plan canonicalization, signing, verification, hash mismatch, expiry, and source-snapshot mismatch;
- future execution gate fail-closed behavior;
- CLI JSON contracts and explicit `--paperOnly` requirement;
- dashboard bridge authentication, redaction, and cached read behavior;
- scheduler inability to submit and deterministic deduplication;
- regression coverage for existing LEAPS and paper execution safeguards.

## Validation Plan

Run the repository's complete validation suite:

```bash
npm run lint
npm test
npm run typecheck
npm run build
npm --prefix apps/dashboard run build
```

Then run the new commands with explicit safe paper configuration and execution disabled:

```bash
ALPACA_ENV=paper TRADING_MODE=paper ALPACA_LIVE_TRADE=false LIVE_TRADING_ENABLED=false HEDGE_PAPER_EXECUTION_ENABLED=false npm run hedge:risk -- --format=json
ALPACA_ENV=paper TRADING_MODE=paper ALPACA_LIVE_TRADE=false LIVE_TRADING_ENABLED=false HEDGE_PAPER_EXECUTION_ENABLED=false npm run hedge:regime -- --format=json
ALPACA_ENV=paper TRADING_MODE=paper ALPACA_LIVE_TRADE=false LIVE_TRADING_ENABLED=false HEDGE_PAPER_EXECUTION_ENABLED=false npm run hedge:review -- --format=json
ALPACA_ENV=paper TRADING_MODE=paper ALPACA_LIVE_TRADE=false LIVE_TRADING_ENABLED=false HEDGE_PAPER_EXECUTION_ENABLED=false npm run hedge:plan -- --paperOnly --format=json
```

Do not run `npm run hedge:execute` or any order-submission command.

## Acceptance Criteria

Implementation is accepted when:

- all in-scope services, CLI commands, routes, dashboard states, persistence, and tests are present;
- option parsing is canonical across relevant services;
- missing data remains null with explicit quality handling;
- risk, regime, score, recommendation, sizing, and LEAPS logic are deterministic and explainable;
- beta cache identity and invalidation satisfy every required input and freshness condition;
- persisted recommendations retain every required integrity field and stale/expired UI behavior is verified;
- signed plans are expiring, paper-only, non-executable, and integrity checked;
- put spreads remain blocked from execution;
- the scheduler has no order-submission capability;
- the future execution gate remains fail closed;
- all validation commands pass or environment-related limitations are documented with evidence;
- no paper or live orders are submitted;
- `HEDGE_PAPER_EXECUTION_ENABLED` remains false;
- existing paper/live safeguards are not weakened.

## Migration and Rollback

SQLite schema changes use additive `CREATE TABLE IF NOT EXISTS` statements and indexes. Existing tables and columns are not removed or rewritten. The feature can be rolled back by removing the new services, commands, routes, and dashboard components while leaving additive cache and high-water rows inert. Existing paper execution and LEAPS exit flows remain independently operable.

## Branch and Deployment Boundary

Implementation, validation, and commits occur only on `paper-ops-layer`. This task does not merge into `main`, push, deploy, alter VPS services, change production environment variables, or authorize paper/live trading. Any later merge or deployment requires separate review and authorization.
