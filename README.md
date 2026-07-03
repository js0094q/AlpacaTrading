# Alpaca Trading Research Infrastructure

This repository now contains a durable paper-trading research stack with:

- durable universe storage and management
- historical market bar ingestion (daily-first)
- options contract and snapshot ingestion
- feature snapshots
- target generation with equity/options expression preference
- baseline backtesting
- learning/evaluation loop
- paper-only Next.js dashboard under `apps/dashboard/`

All modules are paper-first. Live trading is not enabled by default.

## Resume context (July 2026)

Current implementation target is complete for this pass:

- Initial ticker seed is persisted and normalized in `src/config/universe.seed.ts` and `universe_symbols`.
- Daily-first market bar ingestion and options ingestion pipelines exist and track runs in `ingestion_runs`.
- Feature snapshots are generated from bars and enriched with options-aware fields where data exists.
- Target snapshots are generated, with directional, confidence, risk-profile, and preferred-expression outputs.
- Backtest, learning, and strategy selection support paper research-first execution and trade accounting.
- CLI remains the primary execution interface, with a paper-only dashboard/API surface for monitoring and guarded workflow actions.

If you return to this repo later, run `npm run universe:get` first to confirm the active universe state.

## Environment

Create environment variables (or `.env`) with paper defaults:

```bash
ALPACA_ENV=paper
ALPACA_PAPER_API_KEY=replace_me
ALPACA_PAPER_SECRET_KEY=replace_me
ALPACA_PAPER_BASE_URL=https://paper-api.alpaca.markets
ALPACA_DATA_BASE_URL=https://data.alpaca.markets
MARKET_DATA_PROVIDER=alpaca
TRADING_MODE=paper
ALPACA_LIVE_TRADE=false
LIVE_TRADING_ENABLED=false
PAPER_ORDER_EXECUTION_ENABLED=false
PAPER_OPTIONS_EXECUTION_ENABLED=false
PAPER_EQUITY_NOTIONAL_PER_ORDER=1000
PAPER_EQUITY_MAX_NOTIONAL_PER_ORDER=5000
PAPER_EQUITY_MAX_PORTFOLIO_DEPLOY_PCT=50
PAPER_EQUITY_MAX_POSITION_PCT=10
PAPER_EQUITY_MIN_CASH_RESERVE_PCT=20
PAPER_OPTIONS_MAX_PREMIUM_PER_ORDER=1000
PAPER_OPTIONS_MAX_CONTRACTS=5
PAPER_OPTIONS_MIN_DTE=0
PAPER_OPTIONS_MAX_DTE=90
PAPER_OPTIONS_ALLOW_0DTE=true
PAPER_OPTIONS_ALLOW_MARKET_ORDERS=false
PAPER_OPTIONS_LIMIT_PRICE_BASIS=mid
PAPER_OPTIONS_MAX_SPREAD_PCT=50
PAPER_OPTIONS_MAX_PORTFOLIO_RISK_PCT=20
PAPER_OPTIONS_MAX_POSITION_RISK_PCT=5
PAPER_OPTIONS_ALLOW_LONG_CALLS=true
PAPER_OPTIONS_ALLOW_LONG_PUTS=true
PAPER_OPTIONS_ALLOW_CASH_SECURED_PUTS=true
PAPER_OPTIONS_ALLOW_COVERED_CALLS=true
PAPER_OPTIONS_ALLOW_NAKED_OPTIONS=false
PAPER_RUNTIME_DUPLICATE_RECONCILIATION_ENABLED=false
ENABLE_OPTIONS_RESEARCH=true
ENABLE_AGGRESSIVE_PAPER_STRATEGIES=true
ENABLE_SHORT_RESEARCH=true
RESEARCH_DB_PATH=./data/research.db
ALPACA_REQUEST_TIMEOUT_MS=15000
ALPACA_MAX_RETRIES=2
```

The CLI loads `.env` first, then `.env.txt` as fallback when keys are missing. If both files exist, `.env` values take precedence over `.env.txt`.

## Alpaca Paper API read-only integration

This project now supports read-only Alpaca Paper API inspection for account, positions, open orders, market clock, and symbol tradability checks in a CLI-first flow.

This integration remains paper-only and non-mutating. It does not place paper or live orders.

### Environment variables

```bash
ALPACA_PAPER_BASE_URL=https://paper-api.alpaca.markets
ALPACA_DATA_BASE_URL=https://data.alpaca.markets
ALPACA_ENV=paper
ALPACA_PAPER_API_KEY=replace_me
ALPACA_PAPER_SECRET_KEY=replace_me
LIVE_TRADING_ENABLED=false
ALPACA_REQUEST_TIMEOUT_MS=15000
ALPACA_MAX_RETRIES=2
```

### Health check

```bash
npm run alpaca:config -- --format=json
npm run alpaca:health
npm run alpaca:health -- --format=json
```

`alpaca:config` is read-only and prints only redacted configuration diagnostics: credential presence, key prefix, base URLs, loaded env files, and precedence notes. It never prints full API keys, secret keys, or authorization headers.

### Account snapshot

```bash
npm run alpaca:account
npm run alpaca:account -- --format=json
```

### Positions

```bash
npm run alpaca:positions
npm run alpaca:positions -- --format=json
```

### Open orders (read-only)

```bash
npm run alpaca:orders
npm run alpaca:orders -- --format=json
```

### Asset check

```bash
npm run alpaca:asset -- --symbol=AAPL
npm run alpaca:asset -- --symbol=AAPL --format=json
```

### Research with Alpaca asset filtering

```bash
npm run research:daily -- --riskProfile=aggressive --optionsEnabled=true --maxCandidates=10 --useAlpacaAssets=true
```

`research:daily` defaults to a 365-day daily-bar lookback so RSI/EMA/ATR/trend features have enough history to produce rankable targets. Override with `--barLookbackDays=<days>` if a shorter or longer read-only data window is needed.

The Alpaca asset filter only removes unsupported, inactive, or untradable symbols.
It does not place orders.

See also: [docs/vps-paper-research-deployment.md](/Users/josephstewart/Documents/Alpaca%20Trading/docs/vps-paper-research-deployment.md)

## Alpaca Paper API Validation

Run this once before using the research commands to confirm real paper credentials are wired correctly:

```bash
cp .env.example .env
```

Set required values:

```bash
ALPACA_ENV=paper
ALPACA_PAPER_API_KEY=your-paper-key
ALPACA_PAPER_SECRET_KEY=your-paper-secret
ALPACA_PAPER_BASE_URL=https://paper-api.alpaca.markets
ALPACA_DATA_BASE_URL=https://data.alpaca.markets
LIVE_TRADING_ENABLED=false
```

Validation sequence:

```bash
npm run alpaca:health -- --format=json
npm run alpaca:config -- --format=json
npm run alpaca:account -- --format=json
npm run alpaca:positions -- --format=json
npm run alpaca:orders -- --format=json
npm run alpaca:asset -- --symbol=AAPL --format=json
npm run research:daily -- --riskProfile=aggressive --optionsEnabled=true --maxCandidates=10 --useAlpacaAssets=true
npm run paper:snapshots -- --format=json --limit=5
npm run paper:trends -- --format=json
npm run paper:runtime -- --format=json
npm run paper:intel -- --format=json
npm run paper:plan -- --riskProfile=aggressive --optionsEnabled=true --format=json
npm run paper:review -- --riskProfile=aggressive --optionsEnabled=true --format=json
npm run paper:execute -- --dryRun --riskProfile=aggressive --optionsEnabled=true --format=json
npm run paper:execute -- --confirmPaper --riskProfile=aggressive --optionsEnabled=true --assetClass=all --format=json
```

Expected safety properties:

- Paper environment only (`ALPACA_ENV=paper`).
- Inspection, research, plan, review, and dry-run commands remain read-only.
- `paper:execute --confirmPaper` is the only intentional order-submission path and submits to Alpaca paper endpoints only after hard gates pass.
- No live trading.
- No live account mutations.
- Request IDs are surfaced when provided by Alpaca.
- `--confirmPaper` requires explicit hard gates and still keeps paper endpoint-only submission.

Read-only paper intelligence commands:

```bash
npm run paper:snapshots
npm run paper:snapshots -- --limit=5 --format=json
npm run paper:trends -- --limit=20 --format=json
npm run paper:runtime -- --format=json --riskProfile=aggressive --optionsEnabled=true --maxCandidates=10
npm run paper:intel -- --riskProfile=aggressive --optionsEnabled=true --format=json
npm run paper:plan -- --riskProfile=aggressive --optionsEnabled=true --format=json
npm run paper:review -- --riskProfile=aggressive --optionsEnabled=true --format=json
npm run paper:execute -- --dryRun --riskProfile=aggressive --optionsEnabled=true --format=json
```

The read-only intelligence commands are explicitly non-mutating and keep paper safety checks enforced:

- `paper:snapshots` reads persisted recommendation history.
- `paper:trends` summarizes historical behavior and symbol trend states.
- `paper:runtime` compares latest recommendation candidates with current paper account state.
- `paper:intel` combines snapshots + trends + runtime into one report.
- `paper:plan` creates a dry-run-only plan using realistic paper sizing and account-relative cap rules.
- `paper:review` evaluates the dry-run plan for freshness, buying-power risk, duplicate exposure, and execution blockers/warnings.
- `paper:execute --dryRun` constructs would-submit Alpaca order payloads from the accepted plan/review. It does not send them.
- `paper:execute --confirmPaper` is paper-only mutation mode and submits candidate payloads after all hard gates and option gates pass.
If `paper:review` reports `NO_RUNTIME_CANDIDATES`, first confirm the latest `research:daily` run used enough bar history. The default is `--barLookbackDays=365`.

Paper planning command (dry-run only):

```bash
npm run paper:plan
npm run paper:plan -- --format=json
```

`paper:plan` is the final non-mutating planning gate before any execution phase:

- reads latest recommendation/runtime context and current paper account/positions/open orders
- enforces buying-power reserve and notional/rank exposure caps
- reports empty-plan diagnostics such as `NO_RESEARCH_SNAPSHOTS`, `NO_MATCHING_SNAPSHOTS_FOR_FILTERS`, `NO_RUNTIME_CANDIDATES`, and `ALL_CANDIDATES_SKIPPED`
- outputs `dryRun: true` and `nonMutating: true`
- never submits, replaces, cancels, or closes any orders

Paper review command (non-mutating safety gate):

```bash
npm run paper:review
npm run paper:review -- --format=json
```

`paper:review` is the non-mutating review gate before any future dry-run payload build and evaluates:

- plan staleness and execution readiness
- buying-power use warnings and hard stop thresholds
- concentration and duplicate exposure warnings
- option planning limitations and environment/guardrail blockers
- candidate-generation blockers from the plan diagnostics
- `reviewOnly: true` and `nonMutating: true` invariants

`paper:review` does not submit, replace, cancel, or modify Alpaca orders.

Paper execute dry-run command (payload construction only):

```bash
npm run paper:execute -- --dryRun
npm run paper:execute -- --dryRun --format=json
npm run paper:execute -- --dryRun --riskProfile=aggressive --optionsEnabled=true --format=json
```

`paper:execute --dryRun` only constructs the Alpaca order payloads that would be submitted later. It requires an explicit dry-run flag and returns `DRY_RUN_OR_CONFIRM_PAPER_REQUIRED` if omitted. It does not submit, replace, cancel, or modify Alpaca orders.
`paper:execute --dryRun` returns `DRY_RUN_OR_CONFIRM_PAPER_REQUIRED` when neither dry-run nor confirm flags are present.
`paper:execute --confirmPaper` submits eligible equity and options payloads to Alpaca paper.

Required command forms:

```bash
npm run paper:execute -- --confirmPaper
npm run paper:execute -- --confirmPaper --format=json
npm run paper:execute -- --confirmPaper --assetClass=option
npm run paper:execute -- --confirmPaper --assetClass=all
```

`--confirmPaper` hard gates:

- `PAPER_ENV_REQUIRED`: `ALPACA_ENV=paper`
- `LIVE_TRADING_MUST_BE_DISABLED`: `LIVE_TRADING_ENABLED=false`
- `PAPER_ORDER_EXECUTION_DISABLED`: `PAPER_ORDER_EXECUTION_ENABLED=true`
- `PAPER_OPTIONS_EXECUTION_DISABLED`: `PAPER_OPTIONS_EXECUTION_ENABLED=true` for option payloads

Paper endpoint-only safety note:

`paper:execute --confirmPaper` submits to Alpaca paper endpoints only and includes request IDs where available.

## Paper Risk Posture

Paper execution may use realistic sizing and broader speculative strategies because it is paper-only. The system still blocks malformed orders, impossible orders, duplicate submissions, missing contract resolution, missing option prices, disabled option classes, and any live endpoint usage.

Equity sizing defaults are calibrated for an approximately `$100,000` paper account:

- `PAPER_EQUITY_NOTIONAL_PER_ORDER=1000`
- `PAPER_EQUITY_MAX_NOTIONAL_PER_ORDER=5000`
- `PAPER_EQUITY_MAX_PORTFOLIO_DEPLOY_PCT=50`
- `PAPER_EQUITY_MAX_POSITION_PCT=10`
- `PAPER_EQUITY_MIN_CASH_RESERVE_PCT=20`

When account values are available, equity plans size from paper account equity, buying power, existing exposure, and cash reserve. If account-based sizing cannot be computed, the plan falls back to the configured notional while still respecting the configured max.

Paper options remain disabled by default with `PAPER_OPTIONS_EXECUTION_ENABLED=false`. Setting it to `true` allows eligible paper option payloads after contract, price, strategy, DTE, duplicate, and risk checks pass. Current practical paper defaults:

- `PAPER_OPTIONS_MAX_PREMIUM_PER_ORDER=1000`
- `PAPER_OPTIONS_MAX_CONTRACTS=5`
- `PAPER_OPTIONS_MIN_DTE=0`
- `PAPER_OPTIONS_MAX_DTE=90`
- `PAPER_OPTIONS_ALLOW_0DTE=true`
- `PAPER_OPTIONS_ALLOW_MARKET_ORDERS=false`
- `PAPER_OPTIONS_MAX_SPREAD_PCT=50`
- `PAPER_OPTIONS_MAX_PORTFOLIO_RISK_PCT=20`
- `PAPER_OPTIONS_MAX_POSITION_RISK_PCT=5`
- long calls, long puts, cash-secured puts, and covered calls enabled by default
- naked options disabled by default

Wide spreads and speculative long calls/puts are warnings in paper mode unless they exceed configured hard limits. `OPTION_LIMIT_PRICE_UNAVAILABLE` remains a hard blocker when no usable bid/ask/mark/last-derived limit price can be built.

Multi-leg options remain intentionally out of scope. Do not model spreads as unrelated single-leg submissions until the system can represent every leg, net debit/credit, max risk/reward, strike ordering, expiration alignment, combined payload behavior, and partial-failure handling.

## Execution Ledger

`paper_execution_ledger` is the canonical audit trail for paper execution. It records built, blocked, submitted, accepted, rejected, failed, and duplicate-blocked attempts where available, including symbol, strategy, order shape, notional, limit price, estimated premium, max risk, client order ID, Alpaca order/request IDs, source plan/candidate IDs, blocked reason, sanitized error message, raw payload JSON, and raw response JSON.

Duplicate protection uses the local ledger by default. Optional runtime reconciliation checks recent Alpaca paper orders before submission when `PAPER_RUNTIME_DUPLICATE_RECONCILIATION_ENABLED=true`; if a matching client order ID is found, the attempt is recorded as `duplicate_blocked` and no new order is submitted.

## Paper Dashboard

The dashboard lives in `apps/dashboard/` and uses Next.js routes over the existing CLI/service layer.

```bash
npm run dashboard:dev
npm run dashboard:build
npm run dashboard:start
```

The dashboard shows paper account state, buying power, equity, cash, positions, latest research candidates, latest paper plan/review/dry-run payloads, confirmed submissions, execution ledger, blocked reasons, option candidates/contracts, request IDs, stale-data warnings, outcome analytics, and a clear `PAPER ONLY` environment state.

Dashboard actions include:

- Run research
- Build paper plan
- Run paper review
- Run dry-run execution
- Submit to Alpaca Paper Account

Every dashboard API route enforces `ALPACA_ENV=paper` and `LIVE_TRADING_ENABLED=false`. Order-submission routes additionally require `PAPER_ORDER_EXECUTION_ENABLED=true`, and option submissions require `PAPER_OPTIONS_EXECUTION_ENABLED=true`. Routes must not expose Alpaca keys, secrets, `.env` contents, raw process environment, live endpoint URLs, secret-bearing error messages, or live-trading toggles.

## Vercel Deployment

Build locally before deploying:

```bash
npm run dashboard:build
```

Deploy the repository to Vercel with the dashboard app as the project root or with a project configured to run the `dashboard:*` scripts from this repo. Required Vercel environment variables should use this repo's names:

```bash
ALPACA_ENV=paper
TRADING_MODE=paper
ALPACA_LIVE_TRADE=false
LIVE_TRADING_ENABLED=false
PAPER_ORDER_EXECUTION_ENABLED=false
PAPER_OPTIONS_EXECUTION_ENABLED=false
ALPACA_PAPER_API_KEY=...
ALPACA_PAPER_SECRET_KEY=...
ALPACA_PAPER_BASE_URL=https://paper-api.alpaca.markets
ALPACA_DATA_BASE_URL=https://data.alpaca.markets
```

Keep `PAPER_ORDER_EXECUTION_ENABLED=false` to run the dashboard read-only. Set it to `true` only when the paper order button should be able to submit eligible paper equity orders. Set `PAPER_OPTIONS_EXECUTION_ENABLED=true` only when paper option submissions should also be allowed.

The dashboard uses the local SQLite database through Node APIs. For Vercel, configure a persistent database/storage path before relying on historical ledger or research data, or treat the deployment as a live Alpaca read/control surface with limited local history. Use a Node runtime compatible with the project's `node:sqlite` dependency; Node.js 24+ is the safest deployment target for the dashboard runtime.

## Setup

```bash
npm install
```

VPS and bootstrap hardening context remains in [server/README.md](/Users/josephstewart/Documents/Alpaca%20Trading/server/README.md).

## Core architecture map

- CLI: `src/cli.ts`
- Config: `src/config.ts`
- DB schema: `src/lib/db.ts`
- Data/provider boundary: `src/services/providers/alpaca.ts`
- Core services: `src/services/universeService.ts`, `src/services/marketDataIngest.ts`, `src/services/optionsService.ts`, `src/services/featureService.ts`, `src/services/targetService.ts`, `src/services/strategySelector.ts`, `src/services/backtestService.ts`, `src/services/learningService.ts`
- Request logging: `src/services/apiLog.ts`
- Dashboard: `apps/dashboard/`

## Run the workflow

- Seed and verify universe:

```bash
npm run universe:seed
npm run universe:get
```

- Ingest historical bars:

```bash
npm run data:ingest -- --symbols=SPY,QQQ --timeframe=1Day --start=2026-01-01 --end=2026-01-31
```

- Ingest options data:

```bash
npm run options:ingest -- --underlyingSymbols=SPY,QQQ --minDaysToExpiration=1 --maxDaysToExpiration=60
```

- Build features:

```bash
npm run features:build
```

- Generate targets:

```bash
npm run targets:generate -- --riskProfile=aggressive
npm run targets:generate -- --optionsOnly=true
```

- Run backtest:

```bash
npm run backtest -- --start=2026-01-01 --end=2026-06-30 --initialCapital=100000 --maxPositions=2 --holdingPeriod=10
```

- Run learning:

```bash
npm run learn
```

- Run the new daily paper-research workflow:

```bash
npm run research:daily
npm run research:daily -- --riskProfile=aggressive --optionsEnabled=true --maxCandidates=10
npm run research:daily -- --riskProfile=aggressive --optionsEnabled=true --maxCandidates=10 --barLookbackDays=365
```

The command runs, in order:

1. Seed/refresh universe
2. Ingest market bars
3. Ingest options contracts and snapshots (if `--optionsEnabled=true`)
4. Build features
5. Update learning
6. Generate targets
7. Rank targets
8. Create paper-trade candidates
9. Create paper-trade plans

- Evaluate outcomes after horizon passes:

```bash
npm run paper:evaluate
npm run paper:evaluate -- --asOf=2026-07-03
npm run paper:evaluate -- --horizon=5d
```

- Build a readable daily report:

```bash
npm run research:report
npm run research:report -- --format=json
```

- Run paper outcome analytics over completed paper evaluations:

```bash
npm run paper:analytics
npm run paper:analytics -- --groupBy=symbol
npm run paper:analytics -- --groupBy=riskProfile
npm run paper:analytics -- --groupBy=optionsEnabled
npm run paper:analytics -- --groupBy=horizon
npm run paper:analytics -- --groupBy=rankBucket
npm run paper:analytics -- --groupBy=expression
npm run paper:analytics -- --format=json
npm run paper:analytics -- --topN=3 --bottomN=3
npm run paper:analytics -- --includeBacklogAging=true
npm run paper:analytics -- --persistSnapshots=true --snapshotRunId=my-paper-loop-pass-2026-07-01
npm run paper:analytics -- --since=2026-07-01 --until=2026-07-10
npm run paper:analytics -- --minEvaluations=3
```

- Include analytics in the research report:

```bash
npm run research:report -- --includeAnalytics=true
npm run research:report -- --includeAnalytics=true --format=json
```

Paper outcome analytics are paper-only research tuning signals and are not live-trading guidance.

Optional table options:

- `--topN` and `--bottomN` add ranking slices by supported metrics (default disabled when both are zero).
- `--includeBacklogAging=true` shows unevaluated backlog aging buckets in the command output.
- `--persistSnapshots=true` writes recommendation snapshot rows into `paper_recommendation_snapshots` (for loop-control trend tracking) using optional `--snapshotRunId`.

### Recommended order

1. `universe:seed`
2. `data:ingest`
3. `options:ingest`
4. `features:build`
5. `learn`
6. `targets:generate`
7. `backtest`

8. `research:daily`
9. `research:report`
10. `paper:evaluate`

`research:daily` does not submit orders. It is paper-first planning only.

## Data persistence

Persistence uses `data/research.db` by default with the following collections/tables:

- universe_symbols
- market_bars
- option_contracts
- option_snapshots
- feature_snapshots
- target_snapshots
- options_strategy_snapshots
- ingestion_runs
- backtest_runs
- backtest_trades
- backtest_options_trades
- learning_runs
- api_request_log
- paper_recommendation_snapshots
- paper_execution_ledger

Alpaca API request IDs are persisted in `api_request_log.request_id`.

## API request IDs

- Recorded in `api_request_log` with columns `provider`, `endpoint`, `method`, `status`, `request_id`, `created_at`.

## Safety boundaries

- No module places live orders.
- Paper mode remains default (`ALPACA_LIVE_TRADE=false`).
- Any future live execution path must add explicit opt-in gates.
- Default provider behavior remains paper-only; do not add live-order code in this phase.

## Resume commands

Fast checks when resuming:

```bash
npm run universe:get
npm run features:build
npm run targets:generate -- --riskProfile=aggressive
npm run backtest -- --start=2026-01-01 --end=2026-06-30
```

Validate quickly with:

```bash
npm run lint
npm run test
npm run typecheck
npm run build
npm run dashboard:build
```

## Validation

- Run full checks with:

```bash
npm run lint
npm run test
npm run typecheck
npm run build
npm run dashboard:build
npm run paper:execute -- --dryRun --format=json
npm run paper:execute -- --confirmPaper --format=json
```

- Option ingestion supports optional filters:

```bash
npm run options:ingest -- --minDaysToExpiration=1 --maxDaysToExpiration=90 --minDelta=-0.2 --maxDelta=0.8
```

### API/dashboard surface

The dashboard exposes paper-only API routes under `/api/paper/*`. CLI commands remain the source of execution behavior; routes call the same service layer and add paper/live guard checks at the HTTP boundary.

## Known limitations (phase 1)

- Dashboard persistence depends on the configured SQLite database path. Serverless deployments need explicit persistence planning before relying on historical local data.
- Options support uses Alpaca snapshot-based simulation approximations where historical option pricing is unavailable.
- Multi-leg options are not implemented.
- API responses and request IDs are logged, but route-level retry policy is intentionally minimal.
- No live execution path exists by design in this phase.
