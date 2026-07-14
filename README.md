# Alpaca Trading Research Infrastructure

## Current continuation checkpoint (July 2026)

- 2026-07-05: VPS was rebuilt from scratch and re-bootstrapped using `/opt/alpaca-investing/secrets/alpaca.env` for runtime secrets.
- Current VPS state:
  - Host alias: `njalla-vps` (target `alpaca@185.193.127.15`)
  - Repo path on VPS: `/home/alpaca/Alpaca-Trading`
  - Runtime repo service: `alpaca-dashboard-control` (systemd) is active and bound to `127.0.0.1:4100`.
  - Health endpoint is reachable locally at `/api/v1/health` (paper-only checks enabled).
  - `POST /api/v1/refresh` requires auth token, runs the read-only `paper:runtime` command, and does not run order execution or mutating safety prechecks.
- Current hardening posture after rebuild:
  - SSH is key-only (`PasswordAuthentication no`, `KbdInteractiveAuthentication no`).
  - Root key recovery remains intentionally preserved (`PermitRootLogin without-password`) until explicitly disabled.
  - `UFW` and `fail2ban` have been revalidated after privilege/session changes.
- Token coordination to verify before control actions:
  - `VPS_CONTROL_TOKEN` must be present in both `/opt/alpaca-investing/secrets/alpaca.env` and Vercel production env.
  - `DASHBOARD_ADMIN_TOKEN` should be confirmed in Vercel production for dashboard admin/mutating routes.
- Verified dashboard bridge state:
  - Public summary and refresh routes reach the VPS control service and return paper-only state.
  - Dashboard page summary loads use the VPS cached summary bridge with a 30 second timeout; fresh plan/review/dry-run generation remains on explicit protected action routes.
  - Public `POST /api/paper/research/run` completes with valid admin auth using bounded control-service research defaults.
  - Latest review is a clean no-op because all current equity candidates are already held in paper positions, so no eligible payloads exist.
- Paper trading operations layer:
  - Dashboard section: `Paper Trading Controls`.
  - Vercel action routes proxy to allowlisted VPS routes under `/api/v1/actions/*`.
  - `paper:ops:review` persists the latest reviewed payload artifact with separated sections for equity buys, equity adds, equity sells, option buys, and option sell-to-close exits.
  - `paper:execute:reviewed -- --confirmPaper` executes only the latest fresh reviewed payload artifact and refuses stale or signature-mismatched payloads.
  - Scheduled ops are systemd timers on the VPS; default automation stops at review payload generation.
- Fast resume command sequence:
  - `ssh njalla-vps`
  - load Node 22 and secrets from `/opt/alpaca-investing/secrets/alpaca.env`
  - run:
    - `bash server/verify_server.sh`
    - `npm run paper:snapshots -- --format=json --limit=5`
    - `npm run paper:runtime -- --format=json`
    - `npm run paper:review -- --riskProfile=aggressive --optionsEnabled=true --format=json`
    - `npm run paper:plan -- --riskProfile=aggressive --optionsEnabled=true --maxCandidates=10 --format=json`

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
PAPER_ORDER_EXECUTION_ENABLED=true
PAPER_OPTIONS_EXECUTION_ENABLED=true
PAPER_EQUITY_NOTIONAL_PER_ORDER=1000
PAPER_EQUITY_MAX_NOTIONAL_PER_ORDER=5000
PAPER_EQUITY_MAX_PORTFOLIO_DEPLOY_PCT=50
PAPER_EQUITY_MAX_POSITION_PCT=10
PAPER_EQUITY_MIN_CASH_RESERVE_PCT=20
PAPER_OPTION_MAX_PREMIUM_PER_CONTRACT=1500
PAPER_OPTION_MAX_ORDER_NOTIONAL=1500
PAPER_OPTION_MAX_CONTRACTS=1
PAPER_OPTIONS_MIN_DTE=0
PAPER_OPTIONS_MAX_DTE=90
ALLOW_0DTE_OPTIONS=true
PAPER_OPTIONS_ALLOW_MARKET_ORDERS=false
PAPER_OPTIONS_LIMIT_PRICE_BASIS=mid
OPTIONS_QUOTE_MAX_AGE_MS=900000
ALLOW_OPTIONS_LAST_PRICE_FALLBACK=false
PAPER_OPTIONS_MAX_SPREAD_PCT=50
PAPER_OPTIONS_HARD_SPREAD_CAP_ENABLED=false
PAPER_OPTIONS_MAX_PORTFOLIO_RISK_PCT=20
PAPER_OPTIONS_MAX_POSITION_RISK_PCT=5
PAPER_OPTIONS_ALLOW_LONG_CALLS=true
PAPER_OPTIONS_ALLOW_LONG_PUTS=true
PAPER_OPTIONS_ALLOW_CASH_SECURED_PUTS=true
PAPER_OPTIONS_ALLOW_COVERED_CALLS=true
PAPER_OPTIONS_ALLOW_NAKED_OPTIONS=false
PAPER_OPTION_LEARNING_LEDGER_ENABLED=true
PAPER_0DTE_SPY_ENABLED=false
PAPER_0DTE_SPY_UNDERLYINGS=SPY
PAPER_0DTE_SPY_MAX_PREMIUM_PER_CONTRACT=250
PAPER_0DTE_SPY_MAX_ORDER_NOTIONAL=250
PAPER_0DTE_SPY_MAX_CONTRACTS=1
PAPER_0DTE_SPY_MAX_DAILY_TRADES=3
PAPER_0DTE_SPY_MAX_QUOTE_AGE_SECONDS=60
PAPER_0DTE_SPY_MAX_SPREAD_PCT=20
PAPER_0DTE_SPY_HARD_SPREAD_CAP_ENABLED=false
PAPER_LEAPS_ENABLED=false
PAPER_LEAPS_UNDERLYINGS=SPY,QQQ
PAPER_LEAPS_MAX_PREMIUM_PER_CONTRACT=1500
PAPER_LEAPS_MAX_ORDER_NOTIONAL=1500
PAPER_LEAPS_MAX_CONTRACTS=1
PAPER_LEAPS_MIN_DTE=180
PAPER_LEAPS_MAX_DTE=730
PAPER_LEAPS_MAX_SPREAD_PCT=15
PAPER_LEAPS_HARD_SPREAD_CAP_ENABLED=false
LEAPS_MIN_DTE_AT_ENTRY=270
LEAPS_DTE_EXIT_THRESHOLD=180
LEAPS_REVIEW_LOSS_PCT=-20
LEAPS_HARD_STOP_LOSS_PCT=-35
LEAPS_PARTIAL_PROFIT_TAKE_PCT=75
LEAPS_FULL_PROFIT_TAKE_PCT=125
LEAPS_TREND_REVIEW_SMA=100
LEAPS_SEVERE_TREND_EXIT_SMA=200
LEAPS_MAX_BID_ASK_SPREAD_PCT=20
LEAPS_MIN_DELTA_REVIEW=0.45
LEAPS_REVIEW_INTERVAL_DAYS=30
PAPER_RUNTIME_DUPLICATE_RECONCILIATION_ENABLED=false
PAPER_POSITION_SYNC_FRESHNESS_MINUTES=2160
ENABLE_OPTIONS_RESEARCH=true
ENABLE_AGGRESSIVE_PAPER_STRATEGIES=true
ENABLE_SHORT_RESEARCH=true
RESEARCH_DB_PATH=./data/research.db
ALPACA_REQUEST_TIMEOUT_MS=15000
ALPACA_MAX_RETRIES=2
VPS_RESEARCH_REQUEST_TIMEOUT_MS=10000
VPS_RESEARCH_MAX_RETRIES=0
VPS_CONTROL_TOKEN=
DASHBOARD_ADMIN_TOKEN=
AUTOMATED_PAPER_EXECUTION_ENABLED=true
PAPER_0DTE_DISCOVERY_ENABLED=true
PAPER_OPTION_EXIT_REVIEW_ENABLED=true
PAPER_EQUITY_SCALE_IN_ENABLED=false
ZERO_DTE_ENGINE_ENABLED=true
ZERO_DTE_PAPER_EXECUTION_ENABLED=true
ZERO_DTE_SHADOW_ENABLED=true
ZERO_DTE_UNDERLYINGS=SPY,QQQ,IWM
ZERO_DTE_DISCOVERY_START_ET=09:35
ZERO_DTE_NEW_ENTRY_CUTOFF_ET=15:15
ZERO_DTE_FORCE_EXIT_ET=15:50
ZERO_DTE_ENGINE_INTERVAL_SECONDS=60
ZERO_DTE_QUEUE_MAX_ACTIVE=100
ZERO_DTE_QUEUE_TOP_N=20
ZERO_DTE_EXECUTION_TOP_N=3
ZERO_DTE_MAX_STRIKES_EACH_SIDE=5
ZERO_DTE_UNDERLYING_MAX_AGE_MS=60000
ZERO_DTE_MIN_OPTION_VOLUME=100
ZERO_DTE_MIN_OPEN_INTEREST=250
ZERO_DTE_MAX_SPREAD_PCT=15
ZERO_DTE_MIN_PREMIUM=0.10
ZERO_DTE_MAX_PREMIUM=5.00
ZERO_DTE_MIN_SCORE_MOVEMENT=5
ZERO_DTE_SIGNAL_SHORT_WINDOW=3
ZERO_DTE_SIGNAL_MEDIUM_WINDOW=5
ZERO_DTE_MIN_CONFIRMATION_OBSERVATIONS=2
ZERO_DTE_MAX_CONTRACTS_PER_TRADE=1
ZERO_DTE_MAX_OPEN_POSITIONS=3
ZERO_DTE_MAX_TRADES_PER_DAY=3
ZERO_DTE_MAX_PREMIUM_PER_TRADE=250
ZERO_DTE_MAX_DAILY_PREMIUM=750
ZERO_DTE_MAX_DAILY_REALIZED_LOSS=250
ZERO_DTE_OUTCOME_HORIZONS_MINUTES=5,15,30,60
ZERO_DTE_STRATEGY_VERSION=zero-dte-level-2-v1
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
VPS_RESEARCH_REQUEST_TIMEOUT_MS=10000
VPS_RESEARCH_MAX_RETRIES=0
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
npm run options:diagnose -- --underlyings=SPY,QQQ
npm run paper:plan -- --riskProfile=aggressive --optionsEnabled=true --format=json
npm run paper:review -- --riskProfile=aggressive --optionsEnabled=true --format=json
npm run paper:exit:review -- --format=json
npm run paper:execute -- --dryRun --riskProfile=aggressive --optionsEnabled=true --format=json
npm run paper:execute -- --confirmPaper --riskProfile=aggressive --optionsEnabled=true --assetClass=all --format=json
npm run paper:exit:execute -- --confirmPaper --format=json
npm run paper:learn -- --format=json
```

### Paper option learning ledger

`paper:plan` records paper learning rows when `PAPER_OPTION_LEARNING_LEDGER_ENABLED=true`.
Each option decision is classified as `zero_dte_spy`, `leaps`, or `standard_option`, with a hypothesis, signal inputs, quote snapshot, paper fill model, live-like fill model, and risk model.

`PAPER_0DTE_SPY_ENABLED=false` and `PAPER_LEAPS_ENABLED=false` are safe defaults.
Enabling either flag allows first-class paper discovery under the paper-only guards; 0DTE discovery considers same-day SPY calls and puts from `PAPER_0DTE_SPY_UNDERLYINGS=SPY`, and LEAPS discovery considers one long-dated call per symbol from `PAPER_LEAPS_UNDERLYINGS=SPY,QQQ`.
When `paper:plan` or `paper:review` runs with options enabled and an explicit discovery family enabled, the planner refreshes empty or stale matching option-contract cache windows from Alpaca and refreshes quotes only for selected discovery contracts.
It does not enable live trading or automatic live promotion.

Use `npm run options:diagnose -- --underlyings=SPY,QQQ` for a read-only provider/cache check.
It reports the Alpaca contract endpoints used, local `option_contracts` cache counts, SPY same-day contracts, configured LEAPS counts by underlying, sample contract symbols, quote availability for sample contracts, and the exact zero-contract reason when filters or provider responses return no contracts.

Use `npm run paper:learn -- --format=json` to evaluate pending learning rows when local option mark data exists.
The command also reports promotion-readiness analytics using live-like profit factor, trade count, observed days, drawdown, and spread gates.

## Paper Trading Controls and Ops

Dashboard controls live in `apps/dashboard/app/components/ActionPanel.tsx` and call only fixed dashboard API routes:

```bash
POST /api/paper/actions/research/run
POST /api/paper/actions/learn/run
POST /api/paper/actions/portfolio/review
POST /api/paper/actions/options/discover
POST /api/paper/actions/review
POST /api/paper/actions/execute
GET  /api/paper/actions/history
```

The VPS control server maps those routes to hardcoded commands only. No raw command string is accepted from the dashboard.

```bash
npm run paper:ops:morning -- --format=json
npm run paper:ops:midday -- --format=json
npm run paper:ops:late-day -- --format=json
npm run paper:portfolio:review -- --format=json
npm run paper:exit:review -- --format=json
npm run paper:options:discover -- --underlying=SPY --dte=0 --format=json
npm run paper:ops:review -- --format=json
```

`npm run paper:execute:reviewed -- --confirmPaper --format=json` is paper-only and requires `PAPER_ORDER_EXECUTION_ENABLED=true`. Option payloads also require `PAPER_OPTIONS_EXECUTION_ENABLED=true`. Reviewed LEAPS sell-to-close payloads additionally require `ALPACA_ENV=paper`, `TRADING_MODE=paper`, `ALPACA_LIVE_TRADE=false`, `LIVE_TRADING_ENABLED=false`, `AUTOMATED_PAPER_EXECUTION_ENABLED=true`, and `--confirmPaper`; failures use `PAPER_RUNTIME_REQUIRED`, `LIVE_TRADING_DISABLED_REQUIRED`, `PAPER_EXECUTION_FLAG_REQUIRED`, `PAPER_OPTIONS_EXECUTION_FLAG_REQUIRED`, `AUTOMATED_PAPER_EXECUTION_FLAG_REQUIRED`, or `PAPER_CONFIRMATION_REQUIRED`. Do not use execution commands during implementation or review unless the user explicitly requests paper execution.

Systemd timers in `server/systemd/` implement the VPS automation schedule:

- `paper-ops-morning.timer`: weekdays around 8:30 AM ET.
- `paper-ops-midday.timer`: weekdays around 12:00 PM ET.
- `paper-ops-late-day.timer`: weekdays around 3:15 PM ET.

Market Observatory Phase 1A uses the canonical universe in
`src/config/universe.seed.ts` and retains all prior symbols. Because `TSLA` was
already present, the requested 20-name set adds 19 net-new rows for 51 unique
symbols. Asset-reference refresh records Alpaca status, exchange, tradability,
fractionability, shortability, marginability, options availability, attributes,
validation time, and request ID; inactive or non-tradable symbols remain recorded
but are disabled.

Run one read-only collection with:

```bash
npm run observatory:collect
```

The collector uses Alpaca's batched stock-snapshot endpoint, initially with the
configured `iex` feed. `stock_snapshots` preserves ingestion time separately from
trade, quote, minute, daily, and previous-daily timestamps. It retains feed and
request provenance, explicit freshness/data-quality states, and nullable derived
spread, return, VWAP-distance, range, and relative-volume values. Latest evidence
augments only the latest research feature row. All scored candidate outcomes are
persisted, while only `selected` candidates can enter existing guarded paper
planning and runtime paths.

Phase 1B keeps candidate, decision, and broker-reconciled position lifecycle IDs
distinct. Immutable `decision_snapshots` retain decision-time evidence; later
review, eligibility, fill, open, and close states append to
`decision_lifecycle_events`. Analytical positions are created only from exact
confirmed fills in `paper_execution_ledger`. If Alpaca nets more than one possible
decision into a symbol position, the linked lifecycles are marked
`AMBIGUOUS_NETTED_POSITION` and per-decision return/MFE/MAE stay null.

Run and verify the additive migration (the database flag defaults to
`RESEARCH_DB_PATH` when omitted):

```bash
npm run db:migrate -- --database /path/to/research.db
npm run db:verify -- --database /path/to/research.db
```

Terminal outcomes use persisted observations only and keep option-position and
underlying-return bases separate. One original outcome is retained per lifecycle;
corrections append as revisions. Trace one decision without returning raw payload
or secret-bearing model/environment data:

```bash
npm run paper:trace -- --decisionId <uuid>
```

Those legacy `paper-ops-*` timers are review-only and override `AUTOMATED_PAPER_EXECUTION_ENABLED=false`; bounded paper execution tasks use the checked-in target value `true` only with their own confirmation and paper-runtime gates.
The continuous paper monitor is installed separately with `scripts/install-paper-monitoring-systemd.sh`:

- `alpaca-market-observatory.timer`: wakes every 15 minutes during weekday
  market-hour windows and runs the non-executing stock observation job through a
  dedicated lock.
- `alpaca-paper-review.timer`: wakes every 30 minutes during weekday market-hour windows and runs the existing paper research/review workflow.
- `alpaca-paper-execute.timer`: wakes after review windows and can execute only reviewed entry sections (`equityBuys`, `equityAdds`, `optionBuys`).
- `alpaca-paper-exit-review.timer`: wakes every 15 minutes during the regular window and every 5 minutes in the final hour; exit review evaluates equity exits, generic option exits, 0DTE late-day exits, and LEAPS exit discipline.
- `alpaca-paper-exit-execute.timer`: wakes after exit-review windows and can execute only reviewed exit sections (`equitySells`, `optionSellToCloseExits`).
- `alpaca-zero-dte-engine.timer`: wakes every minute from the configured discovery start through the new-entry cutoff and runs the guarded 0DTE engine.
- `alpaca-zero-dte-exit-review.timer`: wakes every minute during the market window and reviews 0DTE exits without submitting orders.
- `alpaca-zero-dte-reconcile.timer`: wakes every five minutes to mark paper/shadow positions and capture forward outcomes.
- `alpaca-zero-dte-eod.timer`: writes the end-of-day 0DTE summary after the force-exit window.

Database-heavy wakeups are deliberately staggered: general exit review starts on minute 1, general review on minute 3, the 0DTE engine near second 45, 0DTE exit review near second 55, and reconciliation on minute 1 modulo 5 near second 30. SQLite connections wait up to 60 seconds for transient writer contention. The monitor runner otherwise no-ops with `MARKET_CLOSED` outside regular market hours, weekends, and configured US market holidays; the read-only `zero-dte-eod` task is the sole post-close exception on a valid weekday session. It fails closed unless `ALPACA_ENV=paper`, `TRADING_MODE=paper`, `ALPACA_LIVE_TRADE=false`, `LIVE_TRADING_ENABLED=false`, `PAPER_ORDER_EXECUTION_ENABLED=true`, `PAPER_OPTIONS_EXECUTION_ENABLED=true`, and `AUTOMATED_PAPER_EXECUTION_ENABLED=true` for execution tasks. See `docs/paper-monitoring-operations.md`.

Set the VPS timezone to `America/New_York` or adjust the timer calendar before enabling timers.

Each 0DTE monitor task has a dedicated lock (`/tmp/alpaca-zero-dte-engine.lock`, `/tmp/alpaca-zero-dte-exit-review.lock`, `/tmp/alpaca-zero-dte-reconcile.lock`, or `/tmp/alpaca-zero-dte-eod.lock`). Only the engine task is mutation-capable; exit review, reconciliation, and end-of-day summary tasks set `AUTOMATED_PAPER_EXECUTION_ENABLED=false`.

## 0DTE Level 2 Engine

The 0DTE Level 2 engine is an independent paper-only workflow. It obtains its own underlying and same-day option market data, maintains a ranked candidate queue, evaluates separate playbooks, records shadow alternatives, and feeds the dedicated dashboard panel. Its batched snapshot adapter accepts both Alpaca's wrapped snapshot payloads and the top-level symbol map returned by the stock snapshot endpoint, and its intraday stock-bar requests explicitly use Alpaca's paper-compatible `iex` feed. Contract discovery reads a bounded same-day chain before selecting the configured nearest strikes; session volume comes from the option snapshot daily bar and open interest from the contract record when the snapshot omits it. Candidate, observation, evaluation, and queue-rank persistence is committed once per engine cycle so the one-minute scheduler does not pay one durable commit per row. Immediate broker responses and later reconciliation share the same fail-closed identity and fill-evidence checks. Valid fills persist the broker quantity, average premium, and fill timestamp; zero-fill and partial-fill terminal orders are recorded without inventing fill data, and exact decision-to-ledger linkage is preserved before positions are marked. A terminal entry reservation is reused only when its client-order and candidate identity are exact and it has no broker order; a different candidate or client order receives a new immutable ledger row. Reconciliation may repair a legacy stale link only when the terminal old row and paper broker independently prove the persisted order ID, client order ID, symbol, buy-to-open limit semantics, quantity, and price. The repair preserves the old row, creates an exact new row, atomically relinks the trade, and only then applies broker fill state. Each write re-reads local state inside the transaction so stale pending or partial responses cannot regress a confirmed fill. Only verified partial or open fills receive position marks or appear as active Level 2 paper positions. Confirmed exit submissions remain `exit_requested` until reconciliation validates the exact sell-to-close broker order, client order, symbol, quantity, average fill price, and fill time against the same immutable exit-request generation and execution-ledger identity. Fill time must be chronologically possible relative to entry, exit request, and reconciliation. A validated full exit atomically updates the shared execution ledger, closes the Level 2 trade, appends fill/close lifecycle events, and records the terminal paper outcome; a conflicting existing outcome rolls back the close. Pending, partial, zero-fill terminal, or identity-mismatched exits remain explicit and never use a quote mark as a synthetic fill. Reconciliation never submits, replaces, or cancels an order. The engine does not require the Market Observatory cycle to complete first.

Run the engine and lifecycle workers directly from the CLI:

```bash
npm run zero-dte:engine -- --dryRun --format=json
npm run zero-dte:engine -- --format=json
npm run zero-dte:engine -- --confirmPaper --format=json
npm run zero-dte:exit:review -- --format=json
npm run zero-dte:reconcile -- --format=json
npm run zero-dte:eod -- --format=json
npm run zero-dte:summary -- --format=json
```

`--dryRun` persists local engine, candidate, decision, and shadow evidence without submitting an order. The default engine mode is shadow-only; `--confirmPaper` is the only engine execution mode and remains paper-only. It requires `ALPACA_ENV=paper`, `TRADING_MODE=paper`, `ALPACA_LIVE_TRADE=false`, `LIVE_TRADING_ENABLED=false`, `ZERO_DTE_ENGINE_ENABLED=true`, `ZERO_DTE_PAPER_EXECUTION_ENABLED=true`, `PAPER_ORDER_EXECUTION_ENABLED=true`, `PAPER_OPTIONS_EXECUTION_ENABLED=true`, `AUTOMATED_PAPER_EXECUTION_ENABLED=true`, and the explicit `--confirmPaper` flag. A candidate that the engine has advanced from `eligible` to `selected` remains eligible for this guarded execution step; every other execution gate is reapplied. `ZERO_DTE_MAX_OPEN_POSITIONS` counts active same-day option positions only, while exact-symbol duplicate checks still consider positions and open orders independently. Entry selection is blocked at or after `ZERO_DTE_NEW_ENTRY_CUTOFF_ET`; exit review continues through the force-exit window. No live endpoint or live-order path is exposed.

The database migrations are `2026-07-13-zero-dte-level-2` and `2026-07-13-zero-dte-level-2-hardening`. They persist engine runs, candidates, observations, playbook evaluations, decisions, lifecycle events, paper trades, shadow trades, position marks, terminal outcomes, and configuration versions. Decision groups link selected, skipped, rejected, and shadow alternatives for later learning; shadow rows are simulated and are never account exposure.

The read-only summary is available locally and through `GET /api/v1/zero-dte/summary`; the Vercel route is `GET /api/paper/zero-dte/summary`. The dashboard `0DTE Level 2` panel shows queue state, paper positions, simulated shadows, lifecycle counts, learning outcomes, blockers, and engine health without exposing secrets.

### Paper exit management

Paper exit management is separate from entry planning. Review is read-only:

```bash
npm run paper:exit:review
npm run paper:exit:review -- --format=json
```

Confirmed execution is paper-only and guarded:

```bash
npm run paper:exit:execute -- --confirmPaper
npm run paper:exit:execute -- --confirmPaper --format=json
```

`paper:exit:review` fetches `/v2/account`, `/v2/positions`, current-day `/v2/orders?status=all`, current-day `/v2/account/activities`, market clock data, and latest stock/option snapshots when available. It returns current sell candidates and skipped positions with Alpaca request IDs and `mutationAttempted: false`.

`paper:exit:execute --confirmPaper` reruns review first and also requires the existing `PAPER_ORDER_EXECUTION_ENABLED=true` paper mutation gate. It never submits skipped positions.

Default 0DTE option rules:

- outside the final 2 hours: sell-to-close at `-50%` unrealized P/L (`ODTE_STOP_LOSS_50`) or `+50%` unrealized P/L (`ODTE_TAKE_PROFIT_50`)
- inside the final 2 hours: sell-to-close at `-25%` (`ODTE_EOD_STOP_LOSS_25`) or `+25%` (`ODTE_EOD_TAKE_PROFIT_25`)
- inside the final 30 minutes: force sell-to-close sellable 0DTE contracts (`ODTE_FORCE_EXIT_BEFORE_CLOSE`)
- below `minSellableOptionValue=0.05`: skip by default with `ODTE_BELOW_MIN_SELLABLE_VALUE`

0DTE sell payloads use `side=sell`, `positionIntent=sell_to_close`, `timeInForce=day`, and a conservative limit price from a fresh bid when reliable option quote data exists. Stale or missing option quotes do not produce execution payloads. LEAPS are classified separately and are skipped by default; 0DTE rules never sell LEAPS.

LEAPS exits are paper-only and disabled unless `--includeLEAPS=true` is explicitly provided:

```bash
npm run paper:exit:review -- --includeLEAPS=true --format=json
npm run paper:exit:execute -- --confirmPaper --includeLEAPS=true --format=json
```

Default LEAPS exit rules:

- sell-to-close at `-35%` unrealized P/L (`LEAPS_STOP_LOSS_35`)
- sell-to-close at `+75%` unrealized P/L (`LEAPS_TAKE_PROFIT_75`)
- sell-to-close known LEAPS that decay below `120` DTE (`LEAPS_DTE_DECAY_EXIT`)
- skip when no fresh sellable quote is available (`LEAPS_QUOTE_UNAVAILABLE`)
- skip below `leapsMinSellableOptionValue=0.05` (`LEAPS_BELOW_MIN_SELLABLE_VALUE`)

LEAPS sell payloads use `side=sell`, `positionIntent=sell_to_close`, `timeInForce=day`, and a conservative limit price from the bid. Market LEAPS exits are not enabled. Contracts that were originally recorded as LEAPS in the paper learning ledger can still be recognized for the DTE decay rule after current DTE falls below the normal `180` DTE LEAPS classification threshold, but only if the contract still exists in `/v2/positions`; local-only records never create synthetic sell payloads.

Default equity exit rules:

- sell at `-5%` unrealized P/L (`EQUITY_STOP_LOSS_5`)
- sell at `+8%` unrealized P/L (`EQUITY_TAKE_PROFIT_8`)
- use `/v2/positions.qty_available` when present, including fractional quantities
- skip positions with existing open or pending sell orders (`EXIT_ORDER_ALREADY_OPEN`)

Alpaca paper sync behavior remains part of the guardrail model. Orders and activities may show simulated fills before `/v2/positions` synchronizes, and paper positions may temporarily disappear and later reappear. `/v2/positions` and `/v2/account` remain the authority for current exposure. The exit review never fabricates sell fills, never creates sell payloads for local-only missing positions, and preserves reconciliation events such as `PAPER_POSITION_SYNC_PENDING`, `PAPER_POSITION_SYNC_RESTORED`, and `PAPER_SYNC_POSITION_REMOVAL`.

Account reconciliation blocks execution when current exposure cannot be safely calculated, including material `account.position_market_value` mismatches against the sum of `/v2/positions.market_value`. The default tolerance is `$2` or `0.25%`, whichever is larger. Live-account mismatches remain hard failures, and no live exit behavior is added.

Expected safety properties:

- Paper environment only (`ALPACA_ENV=paper`).
- Inspection, research, plan, review, and dry-run commands remain read-only.
- `paper:execute --confirmPaper` is the intentional entry/planned-order submission path and submits to Alpaca paper endpoints only after hard gates pass.
- `paper:exit:execute --confirmPaper` is paper-only and submits only generated exit candidates after review and hard gates pass.
- `paper:execute --confirmPaper` runs a read-only account reconciliation before any submission.
- No live trading.
- No live account mutations.
- Request IDs are surfaced when provided by Alpaca.
- `paper:trace`, `db:verify`, and observatory collection submit no orders.
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
- checks duplicate held positions and open orders by asset identity: held/open `XLF` equity blocks duplicate `XLF` equity candidates, but does not by itself block `XLF` option contracts; same option contracts are blocked by option symbol
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
- structured candidate counts separating held-equity skips from held-option-contract skips
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
If the plan has no eligible payloads after candidate filtering, `paper:execute --dryRun` and `paper:execute --confirmPaper` return `status: "no_op"` with `reason: "NO_ELIGIBLE_PAPER_PAYLOADS"` and submit zero orders.
`paper:execute --confirmPaper` submits eligible equity and options payloads to Alpaca paper.
Before any paper submission, `paper:execute --confirmPaper` fetches `/v2/account`, `/v2/positions`, `/v2/orders?status=all`, and `/v2/account/activities` over the configured reconciliation lookback.

Required command forms:

```bash
npm run paper:execute -- --confirmPaper --assetClass=equity
npm run paper:execute -- --confirmPaper --assetClass=equity --format=json
npm run paper:execute -- --confirmPaper --riskProfile=aggressive --optionsEnabled=true --assetClass=option
npm run paper:execute -- --confirmPaper --riskProfile=aggressive --optionsEnabled=true --assetClass=all
```

`--confirmPaper` hard gates:

- `PAPER_ENV_REQUIRED`: `ALPACA_ENV=paper`
- `LIVE_TRADING_MUST_BE_DISABLED`: `LIVE_TRADING_ENABLED=false`
- `PAPER_ORDER_EXECUTION_DISABLED`: `PAPER_ORDER_EXECUTION_ENABLED=true`
- `PAPER_OPTIONS_EXECUTION_DISABLED`: `PAPER_OPTIONS_EXECUTION_ENABLED=true` for option payloads
- `OPTIONS_EXECUTION_REQUIRES_EXPLICIT_OPTIONS_ENABLED`: `--optionsEnabled=true` on the execution command for option payloads
- `OPTIONS_EXECUTION_REQUIRES_EXPLICIT_RISK_PROFILE`: explicit `--riskProfile=<profile>` on the execution command for option payloads

Paper endpoint-only safety note:

`paper:execute --confirmPaper` submits to Alpaca paper endpoints only and includes request IDs where available.
When option payloads are present, execution rebuilds plan/review with the supplied `--riskProfile` and `--optionsEnabled=true` flags before submission; default moderate/options-disabled execution cannot submit option payloads.

### Alpaca paper reconciliation

Alpaca paper trading has an observed EOD/BOD synchronization limitation: `/v2/orders` and `/v2/account/activities` can show simulated fills before `/v2/positions` is fully synchronized, and missing paper positions can later reappear. For current paper exposure, this project treats `/v2/positions` plus `/v2/account` as authoritative.

The pre-execution reconciliation guard preserves buy-fill evidence and Alpaca request IDs without inventing sell fills or realized P/L:

- `PAPER_POSITION_SYNC_PENDING`: recent paper buy fill evidence exists, but `/v2/positions` does not yet show the symbol inside `PAPER_POSITION_SYNC_FRESHNESS_MINUTES` (default `2160` minutes). This is warning-only when account math is consistent.
- `PAPER_POSITION_SYNC_RESTORED`: a symbol previously recorded as pending or paper-sync removed is now present in `/v2/positions` again.
- `PAPER_SYNC_POSITION_REMOVAL`: missing state persisted beyond the freshness window, account math is consistent without the symbol, and no sell/order/activity explains the removal. This remains a paper-environment reconciliation event, not a synthetic sell.
- `ACCOUNT_RECONCILIATION_MISMATCH`: hard fail before mutation when `account.position_market_value` materially differs from the sum of `/v2/positions.market_value`, account cash/equity/market value are internally inconsistent, exposure cannot be safely calculated, or a live account has an unexplained ledger mismatch.

Confirm-paper JSON includes `reconciliationStatus`, `reconciliationEvents`, `paperSyncRemovedSymbols`, `accountCash`, `accountEquity`, `accountPositionMarketValue`, `sumPositionsMarketValue`, `alpacaRequestIds`, and `mutationAttempted`.
Missing paper symbols are excluded from current exposure calculations unless `/v2/positions` confirms them. The local audit trail records reconciliation events in `paper_reconciliation_events`; it does not create fake sell fills. When a symbol reappears, `PAPER_POSITION_SYNC_RESTORED` records the restoration and current exposure follows `/v2/positions` again.

## Paper Risk Posture

Paper execution may use realistic sizing and broader speculative strategies because it is paper-only. The system still blocks malformed orders, impossible orders, duplicate submissions, missing contract resolution, missing option prices, disabled option classes, and any live endpoint usage.

Equity sizing defaults are calibrated for an approximately `$100,000` paper account:

- `PAPER_EQUITY_NOTIONAL_PER_ORDER=1000`
- `PAPER_EQUITY_MAX_NOTIONAL_PER_ORDER=5000`
- `PAPER_EQUITY_MAX_PORTFOLIO_DEPLOY_PCT=50`
- `PAPER_EQUITY_MAX_POSITION_PCT=10`
- `PAPER_EQUITY_MIN_CASH_RESERVE_PCT=20`

When account values are available, equity plans size from paper account equity, buying power, existing exposure, and cash reserve. If account-based sizing cannot be computed, the plan falls back to the configured notional while still respecting the configured max.

Paper options are operationally enabled for the current paper runtime with `PAPER_OPTIONS_EXECUTION_ENABLED=true`. This enables eligible paper option payloads only after contract, price, strategy, DTE, duplicate, explicit command, and risk checks pass. Current practical paper defaults:

- `PAPER_OPTION_MAX_PREMIUM_PER_CONTRACT=1500`
- `PAPER_OPTION_MAX_ORDER_NOTIONAL=1500`
- `PAPER_OPTION_MAX_CONTRACTS=1`
- `PAPER_0DTE_SPY_MAX_PREMIUM_PER_CONTRACT=250`
- `PAPER_0DTE_SPY_MAX_ORDER_NOTIONAL=250`
- `PAPER_LEAPS_MAX_PREMIUM_PER_CONTRACT=1500`
- `PAPER_LEAPS_MAX_ORDER_NOTIONAL=1500`
- `PAPER_OPTIONS_MIN_DTE=0`
- `PAPER_OPTIONS_MAX_DTE=90`
- `ALLOW_0DTE_OPTIONS=true`
- `PAPER_OPTIONS_ALLOW_MARKET_ORDERS=false`
- `OPTIONS_QUOTE_MAX_AGE_MS=900000`
- `ALLOW_OPTIONS_LAST_PRICE_FALLBACK=false`
- `PAPER_OPTIONS_MAX_SPREAD_PCT=50`
- `PAPER_OPTIONS_HARD_SPREAD_CAP_ENABLED=false`
- `PAPER_OPTIONS_MAX_PORTFOLIO_RISK_PCT=20`
- `PAPER_OPTIONS_MAX_POSITION_RISK_PCT=5`
- long calls, long puts, cash-secured puts, and covered calls enabled by default
- naked options disabled by default

Wide spreads, stale quotes with complete non-crossed bid/ask, weak discovery signals, and ask-fallback limit prices are warnings in paper mode by default. Spread caps become hard blockers only when `PAPER_OPTIONS_HARD_SPREAD_CAP_ENABLED=true` or a family-specific hard-spread flag is enabled. `OPTION_LIMIT_PRICE_UNAVAILABLE` remains a hard blocker when no usable bid/ask quote can produce a positive limit price. Last-price fallback is disabled unless `ALLOW_OPTIONS_LAST_PRICE_FALLBACK=true`; same-day expiration is disabled unless `ALLOW_0DTE_OPTIONS=true`. Legacy `PAPER_OPTIONS_MAX_PREMIUM_PER_ORDER`, `PAPER_OPTIONS_MAX_CONTRACTS`, `PAPER_0DTE_SPY_MAX_PREMIUM_PER_TRADE`, and `PAPER_LEAPS_MAX_PREMIUM_PER_TRADE` names remain accepted as aliases when the preferred paper-option cap names are unset.

LEAPS paper exits are evaluated by `paper:portfolio:review`, `paper:exit:review`, and the `paper:ops:review` artifact flow. A contract is classified as LEAPS when entry DTE is at least `LEAPS_MIN_DTE_AT_ENTRY=270`; entry DTE is read from `paper_learning_records` first, then the paper execution ledger, and only falls back to current DTE with `LEAPS_CLASSIFICATION_INFERRED` when no entry record can be derived. Short-dated options are not classified as LEAPS by fallback.

LEAPS hard sell-to-close reviews are generated for `LEAPS_HARD_STOP_LOSS` at `LEAPS_HARD_STOP_LOSS_PCT=-35`, `LEAPS_FULL_PROFIT_TAKE` at `LEAPS_FULL_PROFIT_TAKE_PCT=125`, `LEAPS_DTE_EXIT_WINDOW` at `LEAPS_DTE_EXIT_THRESHOLD=180`, and `LEAPS_SEVERE_TREND_BREAK` when a bullish call underlying closes below `LEAPS_SEVERE_TREND_EXIT_SMA=200`. Put LEAPS use the inverted trend check when present. These reviews populate `optionSellToCloseExits` only when the liquidity guard passes.

LEAPS review-only warnings are `LEAPS_REVIEW_LOSS_WARNING` at `LEAPS_REVIEW_LOSS_PCT=-20`, `LEAPS_PARTIAL_PROFIT_REVIEW` at `LEAPS_PARTIAL_PROFIT_TAKE_PCT=75`, `LEAPS_TREND_REVIEW` below `LEAPS_TREND_REVIEW_SMA=100` for calls or above it for puts, `LEAPS_DELTA_DETERIORATION` below `LEAPS_MIN_DELTA_REVIEW=0.45`, `LEAPS_DELTA_UNAVAILABLE` when Greeks are missing, and `LEAPS_PERIODIC_REVIEW_DUE` after `LEAPS_REVIEW_INTERVAL_DAYS=30`. Multiple-contract partial-profit reviews include a non-executable partial candidate in review output; automated reviewed execution does not sell on review-only triggers alone.

Before a LEAPS hard exit becomes executable, bid/ask liquidity must be present and `((ask - bid) / mid) * 100` must be no more than `LEAPS_MAX_BID_ASK_SPREAD_PCT=20`. Wider spreads add `LIMIT_EXIT_REQUIRED`; missing bid/ask adds `LEAPS_QUOTE_UNAVAILABLE`. Both conditions keep the reviewed candidate non-executable and prevent marketable sell orders.

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

The `0DTE Level 2` panel adds the bounded live queue, active paper 0DTE positions, simulated shadow trades, lifecycle state, learning/outcome summary, blockers, and engine health. Its VPS and Vercel summary routes are read-only.

On local and VPS runtimes, historical dashboard sections read the local SQLite database at `RESEARCH_DB_PATH` or `./data/research.db`. On Vercel, the dashboard does not initialize local SQLite or create app-local data directories. Vercel historical sections render a read-only fallback warning because durable runtime history and the paper execution ledger live on the VPS/local runtime.

Dashboard actions include:

- Run research
- Build paper plan
- Run paper review
- Run dry-run execution
- Submit to Alpaca Paper Account

Every dashboard API route enforces `ALPACA_ENV=paper` and `LIVE_TRADING_ENABLED=false`. Order-submission routes additionally require `PAPER_ORDER_EXECUTION_ENABLED=true`, and option submissions require `PAPER_OPTIONS_EXECUTION_ENABLED=true`. Vercel dashboard deployments remain read-only and do not allow order submission. Routes must not expose Alpaca keys, secrets, `.env` contents, raw process environment, live endpoint URLs, secret-bearing error messages, or live-trading toggles.

## Vercel Deployment

Build locally before deploying:

```bash
npm run dashboard:build
```

Deploy the repository to Vercel with the dashboard app as the project root or with a project configured to run the `dashboard:*` scripts from this repo. Required Vercel guard variables should use this repo's names:

```bash
ALPACA_ENV=paper
TRADING_MODE=paper
ALPACA_LIVE_TRADE=false
LIVE_TRADING_ENABLED=false
PAPER_ORDER_EXECUTION_ENABLED=true
PAPER_OPTIONS_EXECUTION_ENABLED=true
```

Optional read-only Alpaca account and position data uses the paper credential names from `src/config.ts`:

```bash
ALPACA_PAPER_API_KEY=...
ALPACA_PAPER_SECRET_KEY=...
ALPACA_PAPER_BASE_URL=https://paper-api.alpaca.markets
ALPACA_DATA_BASE_URL=https://data.alpaca.markets
```

The hosted dashboard cannot submit orders from Vercel directly: `assertPaperOrderSubmissionEnabled` fails closed on Vercel before checking paper execution flags. When the VPS bridge is configured, paper submission remains a VPS runtime concern and still requires a valid dashboard admin token, matching `VPS_CONTROL_TOKEN`, `ALPACA_ENV=paper`, `LIVE_TRADING_ENABLED=false`, `PAPER_ORDER_EXECUTION_ENABLED=true`, `PAPER_OPTIONS_EXECUTION_ENABLED=true` for option payloads, and the CLI `--confirmPaper` boundary.

Safe Vercel environment parity check:

```bash
npm run vercel:env:parity -- --check-vercel-presence --pull-vercel
```

The parity check prints only presence booleans and sha256 fingerprint comparison results. It must not print raw token, URL, or credential values.

The Vercel serverless runtime must not rely on writable SQLite persistence under `/var/task`. Without future durable dashboard storage, historical API routes return:

```json
{
  "ok": true,
  "mode": "vercel-read-only",
  "data": [],
  "warning": "Historical runtime data is stored on the VPS. Configure durable dashboard storage to show this data on Vercel."
}
```

Future durable Vercel history requires an external store such as Vercel Postgres, Neon, Supabase, or Turso. `DASHBOARD_DATABASE_URL` is reserved for a future durable dashboard adapter and is not used by the current SQLite-backed local/VPS runtime.

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

- Diagnose option contract availability without writing to the local cache:

```bash
npm run options:diagnose -- --underlyings=SPY,QQQ
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

## Portfolio risk and hedge review

The hedge layer on `paper-ops-layer` is read-only and paper-only. It normalizes equity and option exposure, uses observed Greeks when available, calculates signed-exposure portfolio beta, classifies the market regime deterministically, reports an explainable 100-point risk score, and ranks LEAPS trims or protective alternatives.

Run the four supported commands with:

```bash
npm run hedge:risk -- --format=json
npm run hedge:regime -- --format=json
npm run hedge:review -- --format=json
npm run hedge:plan -- --paperOnly --format=json
```

`hedge:plan` creates a signed, expiring paper planning artifact. `hedge:execute`, `hedge:exit:review`, and `hedge:exit:execute` are separate signed, authenticated paper-only lifecycle commands; execution is limited to one long put or one sell-to-close long put. Put spreads are analyzed with `MULTI_LEG_EXECUTION_UNSUPPORTED`; SH and PSQ are secondary tactical alternatives with daily-reset and tracking-risk warnings.

The checked-in paper target enables `HEDGE_PAPER_EXECUTION_ENABLED`, `HEDGE_AUTOMATED_PAPER_EXECUTION_ENABLED`, `HEDGE_EXIT_MANAGEMENT_ENABLED`, `HEDGE_LEARNING_ENABLED`, and `HEDGE_DASHBOARD_MUTATIONS_ENABLED`. `HEDGE_LIVE_EXECUTION_ENABLED=false` and `MULTI_LEG_HEDGE_EXECUTION_ENABLED=false` remain hard gates. `ALPACA_ENV=paper`, `TRADING_MODE=paper`, `ALPACA_LIVE_TRADE=false`, and `LIVE_TRADING_ENABLED=false` are the canonical paper/live boundary; no duplicate `PAPER_TRADING_ENABLED` flag is used. Missing prices, Greeks, beta history, sector mappings, or regime evidence remain null and produce quality warnings, monitoring, or blockers.

Option delta completeness is measured by absolute held contract quantity and absolute option market value. Defaults require 80% coverage on each basis and treat 10% of account equity as material (`HEDGE_MIN_OPTION_DELTA_CONTRACT_COVERAGE_PCT=80`, `HEDGE_MIN_OPTION_DELTA_MARKET_VALUE_COVERAGE_PCT=80`, and `HEDGE_MATERIAL_UNMEASURED_OPTION_EXPOSURE_PCT=10`). When the material gate fails, beta and unsupported option exposure remain null, the calculated score is retained for audit, the effective risk band is `indeterminate`, and hedge sizing stops at monitoring.

Alpaca option snapshots may use current camelCase fields (`greeks`, `latestQuote`, `latestTrade`, and `impliedVolatility`) or the legacy-shaped aliases already used by fixtures. Ingestion normalizes both without estimating missing Greeks.

The bounded beta cache is compatible only when symbol, benchmark, lookback, interval, minimum observations, calculation version, latest aligned market-data date, and expiry all match. Persisted recommendations retain generated/expiry times, paper environment, source snapshot ID, risk/regime versions, configuration fingerprint, quality/status, and the reviewed-payload hash after planning. Dashboard reads re-evaluate freshness and never label stale or expired records current.

## Data persistence

Local/VPS persistence uses `data/research.db` by default with the following collections/tables:

- universe_symbols
- universe_lifecycle_runs
- universe_lifecycle_events
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
- hedge_execution_reviews
- hedge_learning_events
- paper_learning_records
- paper_operation_log
- paper_review_artifacts
- portfolio_high_water_marks
- portfolio_beta_cache
- paper_reconciliation_events

Alpaca API request IDs are persisted in `api_request_log.request_id`.

On Vercel, API request logging does not write to local SQLite. Historical dashboard state remains unavailable until an external durable dashboard store is added.

## API request IDs

- Recorded in `api_request_log` with columns `provider`, `endpoint`, `method`, `status`, `request_id`, `created_at`.

## Safety boundaries

- No module places live orders.
- Paper mode remains default (`ALPACA_LIVE_TRADE=false`).
- Any future live execution path must add explicit opt-in gates.
- Default provider behavior remains paper-only; do not add live-order code in this phase.
- Hedge execution remains paper-only and single-leg; keep `HEDGE_LIVE_EXECUTION_ENABLED=false` and `MULTI_LEG_HEDGE_EXECUTION_ENABLED=false`.

## Autonomous Universe Lifecycle Service

`npm run universe:lifecycle` is a daily, read-only-Alpaca discovery and governance
worker. It moves bounded U.S. equities through
`discovered`, `observe_only`, `research_eligible`, `paper_eligible`,
`paper_active`, `suspended`, and `retired`, recording every transition with
reason code, evidence, timestamp, Git SHA, and configuration version.

The worker does not submit, modify, or cancel broker orders. `observe_only`
symbols feed the existing 15-minute observatory collector; only
`research_eligible`, `paper_eligible`, and `paper_active` symbols are supplied
to the active research universe. Existing review and execution gates remain
authoritative.

Use `npm run universe:lifecycle:status` for a read-only status summary. On the
VPS, `alpaca-universe-lifecycle.timer` runs on weekdays at 16:30 America/New_York
with `Persistent=false`; a missed run waits for the next scheduled window rather
than replaying an unbounded backlog.

If a service run is interrupted, the next lifecycle start preserves the partial
audit trail and marks the interrupted run failed before continuing. Alpaca
request timeouts cover both response headers and response-body parsing, keeping
the bounded worker inside its configured request deadline.

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
npm run paper:execute -- --confirmPaper --assetClass=equity --format=json
```

- Option ingestion supports optional filters:

```bash
npm run options:ingest -- --minDaysToExpiration=1 --maxDaysToExpiration=90 --minDelta=-0.2 --maxDelta=0.8
```

### API/dashboard surface

The dashboard exposes paper-only API routes under `/api/paper/*`. CLI commands remain the source of execution behavior; routes call the same service layer and add paper/live guard checks at the HTTP boundary.

Cached hedge reads are available at `/api/paper/hedge/risk`, `/api/paper/hedge/regime`, and `/api/paper/hedge/recommendation`, backed by the corresponding `/api/v1/hedge/*` VPS control GET routes. They read persisted recommendations only and do not dispatch broker or CLI work.

## Known limitations (phase 1)

- Dashboard persistence depends on the configured local/VPS SQLite database path. Vercel renders historical dashboard sections with a read-only fallback until an external durable store is added.
- Options support uses Alpaca snapshot-based simulation approximations where historical option pricing is unavailable.
- Multi-leg options are not implemented.
- API responses and request IDs are logged, but route-level retry policy is intentionally minimal.
- No live execution path exists by design in this phase.
