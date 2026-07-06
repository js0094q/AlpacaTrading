# Paper-Only VPS Research Deployment

## Purpose

This guide documents running the paper-only Alpaca research loop on a VPS for scheduled execution.

## Current continuation checkpoint (2026-07-05 UTC)

- VPS runtime has been rebuilt and currently reads secrets from `/opt/alpaca-investing/secrets/alpaca.env`.
- The control bridge is running from `server/systemd/dashboard-control.service` on `127.0.0.1:4100`.
- `VPS_CONTROL_TOKEN` is in the VPS runtime env and must match the same value in Vercel production env.
- `DASHBOARD_ADMIN_TOKEN` must be present in Vercel production env for dashboard mutation actions.
- SSH hardening is in place for key-only access; `UFW` and `fail2ban` were revalidated after bootstrap/minor privilege sequencing changed.

## Paper-only warning

This phase is paper-first. Most CLI commands are read-only; `paper:execute --confirmPaper` is paper-only and submits paper orders only after explicit hard gates pass. The optional dashboard in `apps/dashboard/` uses the same paper-only service layer. No live trading is supported.

## Required Node version

- Node.js 22+ is recommended for both CLI workflows and dashboard runtime.

## Required environment variables

At minimum:

```bash
ALPACA_ENV=paper
ALPACA_PAPER_API_KEY=replace_me
ALPACA_PAPER_SECRET_KEY=replace_me
ALPACA_PAPER_BASE_URL=https://paper-api.alpaca.markets
ALPACA_DATA_BASE_URL=https://data.alpaca.markets
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
ALLOW_0DTE_OPTIONS=true
PAPER_OPTIONS_ALLOW_MARKET_ORDERS=false
PAPER_OPTIONS_LIMIT_PRICE_BASIS=mid
OPTIONS_QUOTE_MAX_AGE_MS=900000
ALLOW_OPTIONS_LAST_PRICE_FALLBACK=false
PAPER_OPTIONS_MAX_SPREAD_PCT=50
PAPER_OPTIONS_MAX_PORTFOLIO_RISK_PCT=20
PAPER_OPTIONS_MAX_POSITION_RISK_PCT=5
PAPER_OPTIONS_ALLOW_LONG_CALLS=true
PAPER_OPTIONS_ALLOW_LONG_PUTS=true
PAPER_OPTIONS_ALLOW_CASH_SECURED_PUTS=true
PAPER_OPTIONS_ALLOW_COVERED_CALLS=true
PAPER_OPTIONS_ALLOW_NAKED_OPTIONS=false
PAPER_RUNTIME_DUPLICATE_RECONCILIATION_ENABLED=false
ENABLE_AGGRESSIVE_PAPER_STRATEGIES=true
ALPACA_REQUEST_TIMEOUT_MS=15000
ALPACA_MAX_RETRIES=2
VPS_RESEARCH_REQUEST_TIMEOUT_MS=10000
VPS_RESEARCH_MAX_RETRIES=0
ALPACA_USER_AGENT=alpaca-research-cli
```

Keep a real `.env` file local to the VPS runtime user and exclude it from version control.

The CLI loads `.env` first, then `.env.txt` as fallback when keys are missing. If both files exist, `.env` values take precedence over `.env.txt`.

## Install dependencies

From the project root:

```bash
npm ci
```

## Paper dashboard

The Next.js dashboard is optional and lives under `apps/dashboard/`.

```bash
npm run dashboard:dev
npm run dashboard:build
npm run dashboard:start
```

Dashboard routes enforce `ALPACA_ENV=paper` and `LIVE_TRADING_ENABLED=false`. Submission routes additionally require `PAPER_ORDER_EXECUTION_ENABLED=true`; option submission also requires `PAPER_OPTIONS_EXECUTION_ENABLED=true`.

Use `PAPER_ORDER_EXECUTION_ENABLED=false` to keep the dashboard read-only while still allowing paper account, position, plan, review, dry-run, ledger, and analytics views.

When the dashboard is hosted, the preferred control model is an authenticated VPS control API:

```bash
VPS_CONTROL_TOKEN=<secret>
VPS_CONTROL_BIND_HOST=127.0.0.1
VPS_CONTROL_PORT=4100
VPS_CONTROL_AUDIT_PATH=/opt/alpaca-investing/logs/dashboard-control-audit.jsonl
DASHBOARD_ADMIN_TOKEN=<secret>
```

Vercel-side dashboard routes call the VPS control API using `VPS_CONTROL_BASE_URL` and `VPS_CONTROL_TOKEN` with standard bearer auth.
The control API exposes only allowlisted actions; no arbitrary command strings are accepted.
The `research.run` control action intentionally uses a bounded research profile:
`--barLookbackDays=120`, `ALPACA_REQUEST_TIMEOUT_MS=10000`, and `ALPACA_MAX_RETRIES=0`
by default. This keeps the synchronous dashboard action inside the public route timeout while still
allowing slow optional options ingestion to fail fast and continue with paper candidate generation.

Current allowlist:

- GET `/api/v1/health`, `/api/v1/account`, `/api/v1/positions`, `/api/v1/orders`
- GET `/api/v1/research/latest`, `/api/v1/review/latest`, `/api/v1/plan/latest`
- GET `/api/v1/executions`, `/api/v1/summary`
- POST `/api/v1/research/run`, `/api/v1/review/run`, `/api/v1/plan/run`
- GET `/api/v1/execute/dry-run/latest`
- POST `/api/v1/execute/dry-run`, `/api/v1/execute/confirm`, `/api/v1/refresh`

On the VPS, those historical views use local SQLite at `RESEARCH_DB_PATH` or `./data/research.db`. The VPS remains the owner of the scheduler, CLI runtime, research history, execution ledger, and local persistence.

For Vercel, configure the project to build the dashboard app with `npm run dashboard:build` and provide paper-only guard variables:

```bash
ALPACA_ENV=paper
TRADING_MODE=paper
ALPACA_LIVE_TRADE=false
LIVE_TRADING_ENABLED=false
PAPER_ORDER_EXECUTION_ENABLED=false
PAPER_OPTIONS_EXECUTION_ENABLED=false
VPS_CONTROL_BASE_URL=https://your-domain-or-ip:4100
VPS_CONTROL_TOKEN=<secret>
DASHBOARD_ADMIN_TOKEN=<secret>
```

Optional live read-only paper account and position data can use the repo's paper credential names:

```bash
ALPACA_PAPER_API_KEY=...
ALPACA_PAPER_SECRET_KEY=...
ALPACA_PAPER_BASE_URL=https://paper-api.alpaca.markets
ALPACA_DATA_BASE_URL=https://data.alpaca.markets
```

Vercel dashboard deployments are read-only by default. They do not create `apps/dashboard/data`, do not initialize SQLite under `/var/task`, and do not use local app-bundle persistence for historical ledger or research data. Historical Vercel routes return empty data with a warning until a future external store such as Vercel Postgres, Neon, Supabase, or Turso is implemented.

## Run the dashboard control API on VPS

On the VPS, install dependencies, keep secrets in `/opt/alpaca-investing/secrets/alpaca.env`, and start the control API service after cloning this repo:

```bash
cd /home/alpaca/Alpaca-Trading
cp .env.example .env
cp /opt/alpaca-investing/secrets/alpaca.env .env
npm ci
cp server/systemd/dashboard-control.service /opt/alpaca-investing/systemd/alpaca-dashboard-control.service
cp /opt/alpaca-investing/systemd/alpaca-dashboard-control.service /etc/systemd/system/alpaca-dashboard-control.service
systemctl daemon-reload
systemctl enable --now alpaca-dashboard-control.service
systemctl status alpaca-dashboard-control.service --no-pager
```

If you do not use systemd yet, run the control API directly for validation:

```bash
VPS_CONTROL_TOKEN=<secret> \
VPS_CONTROL_BIND_HOST=127.0.0.1 \
VPS_CONTROL_PORT=4100 \
VPS_CONTROL_AUDIT_PATH=/opt/alpaca-investing/logs/dashboard-control-audit.jsonl \
npm run dashboard:control
```

Then verify control API health from the VPS:

```bash
curl -sS -H "Authorization: Bearer $VPS_CONTROL_TOKEN" http://127.0.0.1:4100/api/v1/health
```

Do not expose `.env`, `.env.txt`, API keys, secrets, raw process environment, live endpoint URLs, or live-trading toggles through dashboard routes. Keep `PAPER_ORDER_EXECUTION_ENABLED=false` and `PAPER_OPTIONS_EXECUTION_ENABLED=false` on Vercel; order submission belongs on the explicitly gated VPS/local paper runtime, not the hosted dashboard.

## Required production network validation

Before marking the control bridge complete, verify the public control endpoint is reachable from this environment:

```bash
curl -m 8 -v "https://<host>:4100/api/v1/health"
curl -m 8 -v "http://<host>:4100/api/v1/health"
```

Expected result for a healthy configuration is HTTP `200` with a JSON payload containing `"ok": true`.

If port 4100 (or alternate port) is not reachable externally:

- do not keep `VPS_CONTROL_BASE_URL` pointed at an unreachable host
- expose the control API through an HTTPS reverse proxy, dedicated public domain, or tunnel
- keep `VPS_CONTROL_TOKEN` on the server and add allowlist controls (`VPS_CONTROL_BASE_URL`, reverse-proxy IP ACL, and/or firewall rules)
- confirm that `VPS_CONTROL_HOST`/`VPS_CONTROL_BIND_HOST` and upstream DNS remain consistent with the public entrypoint
- rerun:
  - `curl -sS -H "Authorization: Bearer $VPS_CONTROL_TOKEN" <VPS_CONTROL_BASE_URL>/api/v1/health`
  - production dashboard read-only action endpoint: `https://www.jlsprojects.com/api/paper/summary`

The dashboard intentionally requires this endpoint for authenticated control actions; if public reachability is not in place, those actions must remain unavailable even if code-level guards are correct.

## Run validation

```bash
npm run lint
npm run test
npm run typecheck
npm run build
npm run alpaca:config -- --format=json
npm run alpaca:health -- --format=json
npm run alpaca:health
npm run alpaca:account -- --format=json
npm run alpaca:positions -- --format=json
npm run alpaca:orders -- --format=json
npm run alpaca:asset -- --symbol=AAPL --format=json
npm run research:daily -- --riskProfile=aggressive --optionsEnabled=true --maxCandidates=10 --useAlpacaAssets=true
npm run research:report -- --includeAnalytics=true --format=json
npm run paper:analytics -- --groupBy=symbol --format=json
npm run paper:snapshots -- --format=json --limit=5
npm run paper:trends -- --format=json
npm run paper:runtime -- --format=json
npm run paper:intel -- --format=json
npm run paper:plan -- --riskProfile=aggressive --optionsEnabled=true --format=json
npm run paper:review -- --riskProfile=aggressive --optionsEnabled=true --format=json
npm run paper:execute -- --dryRun --riskProfile=aggressive --optionsEnabled=true --format=json
npm run paper:execute -- --confirmPaper --assetClass=all --riskProfile=aggressive --optionsEnabled=true --format=json
npm run dashboard:build
```

## Required runtime validation command set

From a shell with real credentials in `.env`:

```bash
cp .env.example .env
```

Then run:

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
npm run paper:execute -- --confirmPaper --assetClass=all --riskProfile=aggressive --optionsEnabled=true --format=json
```

## Read-only paper intelligence checks

These commands are intended to be read-only and provide the next intelligence step before any paper planning or execution work:

- `npm run paper:trends -- --format=json`
- `npm run paper:runtime -- --format=json`
- `npm run paper:intel -- --format=json`
- `npm run paper:plan -- --format=json`
- `npm run paper:review -- --format=json`
- `npm run paper:execute -- --dryRun --format=json`

They must remain non-mutating: no POST/PATCH/PUT/DELETE Alpaca requests, no order placement, and no live mutation path.

`paper:execute --dryRun` is payload construction only. It returns `wouldSubmit` payloads for review and does not send them to Alpaca.
`paper:execute --confirmPaper` is the explicit paper-only submission gate and is intentionally excluded from the read-only command group.
If review is blocked by `NO_RUNTIME_CANDIDATES`, rerun `research:daily` and confirm it reports a historical bar lookback. The command defaults to `--barLookbackDays=365`, which gives the feature engine enough daily bars for RSI, EMA, ATR, MACD, and trend calculations.

## Run one-off paper research

```bash
npm run research:daily -- --riskProfile=aggressive --optionsEnabled=true --maxCandidates=10 --useAlpacaAssets=true
npm run research:report -- --includeAnalytics=true --format=json
npm run paper:plan -- --riskProfile=aggressive --optionsEnabled=true --maxCandidates=10 --format=json
npm run paper:execute -- --dryRun --riskProfile=aggressive --optionsEnabled=true --format=json
```

### Paper planning command

```bash
npm run paper:plan
npm run paper:plan -- --format=json
```

`paper:plan` is the dry-run order proposal gate:

- reads current paper account state, open orders, and latest recommendations
- applies buying-power and exposure caps
- reports empty-plan diagnostics such as `NO_RESEARCH_SNAPSHOTS`, `NO_MATCHING_SNAPSHOTS_FOR_FILTERS`, `NO_RUNTIME_CANDIDATES`, and `ALL_CANDIDATES_SKIPPED`
- produces a plan-only output with `dryRun: true` and `nonMutating: true`
- does not submit, replace, cancel, or close orders

### Paper review command

```bash
npm run paper:review
npm run paper:review -- --format=json
```

`paper:review` is the next non-mutating review gate after planning:

- validates plan freshness, blockers, and warning-level risks
- checks buying-power capacity and concentration/duplicate exposure
- distinguishes missing data, filter mismatch, no runtime candidates, and skipped-only plans
- emits stable blocker/warning codes for future dry-run execution payload testing
- does not submit, replace, cancel, or modify orders
- does not connect to mutation endpoints

### Paper execute dry-run command

```bash
npm run paper:execute -- --dryRun
npm run paper:execute -- --dryRun --format=json
```

`paper:execute --dryRun` consumes the current plan/review output and constructs local would-submit Alpaca order payloads only. It requires `--dryRun` or `--dry-run`; without that flag it returns `DRY_RUN_OR_CONFIRM_PAPER_REQUIRED`.
`paper:execute --dryRun` also supports `--dry-run` and keeps execution non-mutating.

### Paper execute confirm-paper command

```bash
npm run paper:execute -- --confirmPaper
npm run paper:execute -- --confirmPaper --assetClass=equity
npm run paper:execute -- --confirmPaper --assetClass=option --format=json
```

`paper:execute --confirmPaper` submits to Alpaca paper endpoints only after hard gates pass:

- `ALPACA_ENV=paper`
- `LIVE_TRADING_ENABLED=false`
- `PAPER_ORDER_EXECUTION_ENABLED=true`
- `PAPER_OPTIONS_EXECUTION_ENABLED=true` for option payloads

## Schedule paper research and reporting

Suggested cron entries:

```bash
# Paper-only daily research loop, weekdays before market open
15 8 * * 1-5 cd /path/to/alpaca-trading && npm run research:daily -- --riskProfile=aggressive --optionsEnabled=true --maxCandidates=10 --useAlpacaAssets=true >> logs/research-daily.log 2>&1
# Paper-only report after daily research
30 8 * * 1-5 cd /path/to/alpaca-trading && npm run research:report -- --includeAnalytics=true --format=json >> logs/research-report.jsonl 2>&1
# Paper-only outcome evaluation
30 17 * * 1-5 cd /path/to/alpaca-trading && npm run paper:evaluate -- --horizon=5d >> logs/paper-evaluate.log 2>&1
# Paper-only analytics
45 17 * * 1-5 cd /path/to/alpaca-trading && npm run paper:analytics -- --groupBy=symbol --format=json >> logs/paper-analytics.jsonl 2>&1
```

## Inspect logs

- Tail the relevant files in `logs/` (for example `tail -f logs/research-daily.log`).
- Confirm command output includes expected JSON or table rows and warning summaries.

## Disable scheduled jobs

Temporarily comment or remove cron entries, then reload cron.

```bash
crontab -e
# remove or comment paper job lines, then save
```

## Scheduling note

Systemd timers may be preferable for stricter reliability and observability, but cron is acceptable for the first VPS paper-only deployment.
