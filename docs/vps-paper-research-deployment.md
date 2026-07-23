# Paper-Only VPS Research Deployment

> Retired runtime procedure as of 2026-07-20. PostgreSQL is the sole production
> authority, SQLite-backed research workflows are disabled, and all research or
> trading timers remain stopped pending the evidence-utilization and runtime
> audit. Use `docs/runbooks/neon-postgres-operations.md` for current operations.

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
TRADING_MODE=paper
ALPACA_LIVE_TRADE=false
ALPACA_PAPER_API_KEY=replace_me
ALPACA_PAPER_SECRET_KEY=replace_me
ALPACA_PAPER_BASE_URL=https://paper-api.alpaca.markets
ALPACA_DATA_BASE_URL=https://data.alpaca.markets
LIVE_TRADING_ENABLED=false
PAPER_REVIEW_SIGNING_KEY=replace_with_random_secret
HEDGE_REVIEW_SIGNING_KEY=replace_with_independent_random_secret
PAPER_ORDER_EXECUTION_ENABLED=false
PAPER_OPTIONS_EXECUTION_ENABLED=false
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
PAPER_OPTIONS_MAX_PORTFOLIO_RISK_PCT=20
PAPER_OPTIONS_MAX_POSITION_RISK_PCT=5
PAPER_OPTIONS_ALLOW_LONG_CALLS=true
PAPER_OPTIONS_ALLOW_LONG_PUTS=true
PAPER_OPTIONS_ALLOW_CASH_SECURED_PUTS=true
PAPER_OPTIONS_ALLOW_COVERED_CALLS=true
PAPER_OPTIONS_ALLOW_NAKED_OPTIONS=false
PAPER_RUNTIME_DUPLICATE_RECONCILIATION_ENABLED=false
ENABLE_AGGRESSIVE_PAPER_STRATEGIES=true
AUTOMATED_PAPER_EXECUTION_ENABLED=false
PAPER_0DTE_DISCOVERY_ENABLED=true
PAPER_OPTION_EXIT_REVIEW_ENABLED=true
PAPER_EQUITY_SCALE_IN_ENABLED=false
PAPER_SUBMIT_MAX_PRICE_DRIFT_PCT=10
ALPACA_REQUEST_TIMEOUT_MS=15000
ALPACA_MAX_RETRIES=2
VPS_RESEARCH_REQUEST_TIMEOUT_MS=10000
VPS_RESEARCH_MAX_RETRIES=0
ALPACA_USER_AGENT=alpaca-research-cli
```

Keep a real `.env` file local to the VPS runtime user and exclude it from version control.

The two review signers belong only in the VPS runtime secret file. Provision
independent random values through the server's approved secret-management or
interactive editing process; never print, log, copy into the repository, or send
either value to Vercel. Preserve ownership `alpaca:alpaca` and mode `0600`.
Presence-only checks are safe because they emit no value. The final two checks
also reject the checked-in illustrative placeholders:

```bash
test "$(stat -c '%a:%U:%G' /opt/alpaca-investing/secrets/alpaca.env)" = "600:alpaca:alpaca"
grep -Eq '^PAPER_REVIEW_SIGNING_KEY=.+$' /opt/alpaca-investing/secrets/alpaca.env
grep -Eq '^HEDGE_REVIEW_SIGNING_KEY=.+$' /opt/alpaca-investing/secrets/alpaca.env
! grep -Eq '^PAPER_REVIEW_SIGNING_KEY=(replace_me|replace_with_random_secret)$' /opt/alpaca-investing/secrets/alpaca.env
! grep -Eq '^HEDGE_REVIEW_SIGNING_KEY=(replace_me|replace_with_independent_random_secret)$' /opt/alpaca-investing/secrets/alpaca.env
```

`PAPER_REVIEW_SIGNING_KEY` authenticates general review artifacts and 0DTE
submit attestations. `HEDGE_REVIEW_SIGNING_KEY` independently authenticates
hedge reviews. Legacy unsigned artifacts and reviews are intentionally
non-executable and must be regenerated after signer provisioning.

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
- POST `/api/v1/actions/research/run`
- POST `/api/v1/actions/learn/run`
- POST `/api/v1/actions/portfolio/review`
- POST `/api/v1/actions/options/discover`
- POST `/api/v1/actions/review`
- POST `/api/v1/actions/execute`
- GET `/api/v1/actions/history`

The `/api/v1/actions/*` routes are fixed command mappings. The dashboard never sends arbitrary shell commands to the VPS. `actions.execute` requires `confirmPaper: true` and dispatches only the exact latest HMAC-signed reviewed payload. New-risk sections must have a successful signed review with no blockers, then pass fresh account, configuration, portfolio, source, market, 0DTE activity, cap, and atomic reservation checks. A stale, unsigned, empty, missing, consumed, or changed review fails closed and requires a fresh review. A fresh signed mixed artifact with a blocked entry section may still be dispatched when it contains a valid exit section; the section-aware executor keeps the signed entry blockers binding and applies the exit's independent gates.

On the VPS, those historical views use local SQLite at `RESEARCH_DB_PATH` or `./data/research.db`. The VPS remains the owner of the scheduler, CLI runtime, research history, execution ledger, and local persistence.

## Paper Trading Controls

The dashboard section is named `Paper Trading Controls` and exposes:

- Run Automated Paper Research.
- Commit Learning.
- Run Portfolio Review.
- Run 0DTE Options Discovery.
- Review Paper Order Payloads.
- Execute Reviewed Paper Payloads.

Each action shows status, last run time, request/correlation IDs, a summary, and raw JSON details. Execution is labeled as paper-only and requires an additional confirmation step in the UI.

Review payload artifacts are stored in SQLite table `paper_review_artifacts`. Operation history is stored in `paper_operation_log` and exposed through `GET /api/v1/actions/history` and `GET /api/paper/actions/history`.

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

The systemd unit reads that protected file directly. Do not copy `.env.example`
over an existing runtime file or copy the protected secret file into the Git
checkout.

```bash
cd /home/alpaca/Alpaca-Trading
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
npm run paper:portfolio:review -- --format=json
npm run paper:exit:review -- --format=json
npm run paper:options:discover -- --underlying=SPY --dte=0 --format=json
npm run paper:ops:review -- --format=json
npm run paper:execute -- --dryRun --riskProfile=aggressive --optionsEnabled=true --format=json
npm run dashboard:build
```

This validation set is read-only with respect to broker orders. Confirmed paper
execution is deliberately excluded; release validation must not invoke any
`--confirmPaper` executor or an execution timer.

## Required runtime validation command set

Run these commands only from a shell that already has the real protected runtime
environment loaded. Do not create, replace, or seed the runtime environment from
`.env.example`; its values are illustrative placeholders.

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
npm run paper:portfolio:review -- --format=json
npm run paper:exit:review -- --format=json
npm run paper:options:discover -- --underlying=SPY --dte=0 --format=json
npm run paper:ops:review -- --format=json
npm run paper:execute -- --dryRun --riskProfile=aggressive --optionsEnabled=true --format=json
```

This runtime validation command set is also read-only. A signed review can be
created and inspected without dispatching it; do not add a confirmed executor to
deployment validation.

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
npm run paper:execute -- --confirmPaper --format=json
```

`paper:execute --confirmPaper` is a compatibility alias for exact latest signed
reviewed-payload execution. It does not accept asset-class, planning, candidate,
or sizing authority at confirmation time and never rebuilds a plan. It submits
to Alpaca paper endpoints only after hard gates pass:

- `ALPACA_ENV=paper`
- `TRADING_MODE=paper`
- `ALPACA_LIVE_TRADE=false`
- `LIVE_TRADING_ENABLED=false`
- `PAPER_ORDER_EXECUTION_ENABLED=true`
- `PAPER_OPTIONS_EXECUTION_ENABLED=true` for option payloads
- an explicit `--confirmPaper`
- the required signer and a valid, fresh, successful, unblocked artifact
- unchanged source/account/configuration/portfolio/market/activity evidence
- unchanged shared-cap headroom, active reservations, and all-buy-side ledger-
  lifecycle fingerprint inside an atomic reservation transaction

Fresh option evidence may block on quote identity or configured review-to-submit
price drift, but confirmation never reprices or resizes the reviewed order. Broker
statuses such as `held` and `pending_cancel` consume exposure; an unrecognized
non-terminal status is retained as active evidence and blocks new risk rather
than disappearing.

The ledger-lifecycle fingerprint includes terminal transitions, so a concurrent
reservation cannot evade the submit window by becoming `filled` between fresh
evidence collection and the atomic reservation check.

## Scheduled Paper Ops Automation

### Explicit database migration and runtime deployment

Before changing runtime state, verify the merged target SHA, paper/live flags,
active services/timers/locks, database path, disk space, broker-order baseline,
and current SQLite integrity without displaying secret files.

Stop affected SQLite writers and create a timestamped backup. Apply the migration
twice to a controlled copy, then verify it:

```bash
npm run db:migrate -- --database /path/to/copied-research.db
npm run db:migrate -- --database /path/to/copied-research.db
npm run db:verify -- --database /path/to/copied-research.db
```

After the copy passes, migrate production exactly once and verify it before
restoring writers. Ordinary CLI startup must not be used as a migration path;
an existing pending database returns `DATABASE_MIGRATION_REQUIRED`. Confirm all
required migrations, required tables/columns/indexes, retained legacy row
counts, no new exact-linkage orphans, `PRAGMA integrity_check`,
`PRAGMA foreign_key_check`, `PRAGMA journal_mode`, `PRAGMA busy_timeout`,
`PRAGMA foreign_keys`, and `PRAGMA synchronous`. Deploy only the
merged SHA with fast-forward-only Git operations, install/build, reinstall the
checked-in units, restore the prior service/timer state, and enable:

The steady-state concurrency repair adds the named `runtime_write_leases`
table through the migration ledger. It leaves `journal_mode=delete` unchanged.
Only research option persistence and the 0DTE engine persistence batch use the
`research-options-and-zero-dte-engine` lease; option normalization and network
work remain outside write transactions. Finite `SQLITE_BUSY` retry is limited
to explicitly idempotent lifecycle, lease-maintenance, and rollback-safe batch
writes. Contention logs include operation, transaction duration, retry count,
process identity, and run/correlation ID; they do not claim a historical
lock-holder PID.

```bash
sudo systemctl enable --now alpaca-market-observatory.timer
systemctl status alpaca-market-observatory.timer --no-pager
systemctl list-timers 'alpaca-market-observatory*' --no-pager
```

The acceptance run must account for all 51 symbols. Use `COMPLETE` only when all
51 observations persist; use `PARTIAL` when every bounded failure has a structured
reason and all successful symbols persist. Outside regular hours, verify
`SKIPPED_MARKET_CLOSED`, service/timer/schema/migration health, universe size,
paper-only Alpaca access, and a safe bounded probe. Record regular-session
collection as pending; never fabricate market-open evidence or force a paper trade.

After restart, run `npm run system:recover -- --format=json` before research.
Confirm the known stale research row is terminal and audited, then invoke one
guarded dashboard research request. A duplicate request while the first is
active must return `already_running` without a second worker. Require the
research run to reach a successful terminal state with targets and candidates
persisted while the normal staggered timers remain enabled. Only after that
success may a separately authorized paper review be run; do not invoke
`--confirmPaper`, paper execution, exit execution, or any order-producing
command as a repair probe.

Rollback the application to the immediately prior SHA, rebuild, and restart only
the affected services while restoring the recorded timer state. The migration
is additive: nullable research lifecycle columns and the recovery count coexist
with the prior application. Do not delete migration rows or recovery evidence,
and do not reverse the database schema during application rollback.

Use systemd timers for VPS automation. Before enabling timers, set the VPS timezone to New York market time or adjust the `OnCalendar` entries:

```bash
timedatectl status
sudo timedatectl set-timezone America/New_York
```

Install the timer units:

```bash
sudo cp server/systemd/paper-ops-morning.service /etc/systemd/system/paper-ops-morning.service
sudo cp server/systemd/paper-ops-morning.timer /etc/systemd/system/paper-ops-morning.timer
sudo cp server/systemd/paper-ops-midday.service /etc/systemd/system/paper-ops-midday.service
sudo cp server/systemd/paper-ops-midday.timer /etc/systemd/system/paper-ops-midday.timer
sudo cp server/systemd/paper-ops-late-day.service /etc/systemd/system/paper-ops-late-day.service
sudo cp server/systemd/paper-ops-late-day.timer /etc/systemd/system/paper-ops-late-day.timer
sudo systemctl daemon-reload
sudo systemctl enable --now paper-ops-morning.timer paper-ops-midday.timer paper-ops-late-day.timer
systemctl list-timers 'paper-ops-*' --no-pager
```

Schedules:

- Morning: weekdays at 8:30 AM ET; runs research, learning commit/evaluation, 0DTE discovery, and review payload generation.
- Midday: weekdays at 12:00 PM ET; runs portfolio add/new-buy/sell and option exit review.
- Late day: weekdays at 3:15 PM ET; runs portfolio sell and 0DTE forced-exit review.

Default automation mode is review-only:

```bash
AUTOMATED_PAPER_EXECUTION_ENABLED=false
```

When false, timers do not submit orders. Future automated paper execution still requires paper-only runtime guards and explicit paper execution flags.

Manual review-only commands:

```bash
npm run paper:ops:morning -- --format=json
npm run paper:ops:midday -- --format=json
npm run paper:ops:late-day -- --format=json
npm run paper:portfolio:review -- --format=json
npm run paper:exit:review -- --format=json
npm run paper:options:discover -- --underlying=SPY --dte=0 --format=json
npm run paper:ops:review -- --format=json
```

Confirm no live trading path is configured:

```bash
npm run alpaca:health -- --format=json
rg -n "LIVE_TRADING_ENABLED=true|ALPACA_LIVE_TRADE=true|api.alpaca.markets|live" apps/dashboard server src
```

Expected dashboard/control state is paper-only: `ALPACA_ENV=paper`, `TRADING_MODE=paper`, `ALPACA_LIVE_TRADE=false`, and `LIVE_TRADING_ENABLED=false`.

## Legacy cron fallback

Systemd timers are the preferred scheduler for the paper ops layer because they are easier to inspect with `systemctl list-timers` and keep logs under `/opt/alpaca-investing/logs`. If systemd timers are unavailable, use cron only as a fallback.

Suggested fallback cron entries:

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

Use systemd timers for the current VPS paper operations loop unless the host cannot run them.
