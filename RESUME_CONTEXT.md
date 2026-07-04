# Resume Context: Alpaca Trading Research Infra

## Latest VPS Paper Runtime Handoff - 2026-07-04 UTC

- VPS target confirmed:
  - SSH user/host: `alpaca@185.193.127.15`
  - Hostname: `jspaper`
  - VPS repo path: `/home/alpaca/Alpaca-Trading`
  - Runtime secrets path: `/opt/alpaca-investing/secrets/alpaca.env`
- SSH key path from local repo:
  - `/Users/josephstewart/Documents/Alpaca Trading/.ssh/id_ed25519`
  - Key passphrase is stored in local `.ssh/.sshpw`; when automating, use the value after the `password=` prefix and do not commit or print it.
- Local and VPS Git state were aligned on `main` against `origin/main`.
- Paper credentials were placed on the VPS at `/opt/alpaca-investing/secrets/alpaca.env` with `600` permissions and `alpaca:alpaca` ownership.
- VPS `alpaca:health -- --format=json` passed:
  - `paperOnly: true`
  - `liveTradingEnabled: false`
  - `mutationAllowed: false`
  - `accountReachable: true`
  - `accountStatus: ACTIVE`
- VPS `paper:runtime -- --format=json` passed and returned paper account state.
- VPS `paper:review -- --riskProfile=moderate --optionsEnabled=true --format=json` completed but was blocked by `NO_RESEARCH_SNAPSHOTS`.
- VPS `paper:plan -- --riskProfile=moderate --optionsEnabled=true --maxCandidates=10 --format=json` completed with no planned orders because there were no research snapshots.
- `research:daily` follow-up was paused before a fresh snapshot was verified:
  - Wide run with `--useAlpacaAssets=true` used a `timeout 600` guard and exited with status `124`; output file `/home/alpaca/research-daily-20260704T013221Z.json` only contained the npm command header.
  - Static-universe run with `timeout 240` was manually stopped at the user's pause request before completion; no fresh snapshot was verified from it.
  - After stopping, no `research:daily` / `tsx src/cli.ts research daily` processes remained on the VPS.
- Current resume objective:
  - Run one clean, bounded `research:daily` on the VPS until it exits successfully and writes fresh snapshots.
  - Then rerun `paper:snapshots`, `paper:runtime`, `paper:review`, and `paper:plan` to confirm `NO_RESEARCH_SNAPSHOTS` is cleared.

Suggested bounded resume sequence on VPS:

```bash
cd /home/alpaca/Alpaca-Trading
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
set -a
. /opt/alpaca-investing/secrets/alpaca.env
set +a
ps -ef | grep -E "[t]sx src/cli.ts research daily|[n]ode .*src/cli.ts research daily|[t]imeout .*research:daily" || true
timeout 300 npm run research:daily -- --riskProfile=aggressive --optionsEnabled=true --maxCandidates=3 --format=json --barLookbackDays=120
npm run paper:snapshots -- --format=json --limit=5
npm run paper:runtime -- --format=json
npm run paper:review -- --riskProfile=aggressive --optionsEnabled=true --format=json
npm run paper:plan -- --riskProfile=aggressive --optionsEnabled=true --maxCandidates=10 --format=json
```

- Keep paper-only gates intact:
  - `ALPACA_ENV=paper`
  - `LIVE_TRADING_ENABLED=false`
  - no live trading path
  - no `paper:execute --confirmPaper` unless explicitly requested.

- Added Alpaca Paper API read-only integration for account snapshots, positions, open orders, market clock, and asset tradability checks.
- Added paper-only safety guardrails for mutation controls (`alpaca:health`, trading safety assertions, default non-mutating behavior).
- Extended `research:daily` with optional `--useAlpacaAssets=true` filtering and preserved exclusion reasons in run output and run summary.
- Extended `research:daily` to default to a 365-day daily-bar lookback (`--barLookbackDays=365`) so feature generation has enough history for rankable targets.
- Added CLI commands for Alpaca inspection: `alpaca:health`, `alpaca:account`, `alpaca:positions`, `alpaca:orders`, `alpaca:asset`.
- Added redacted Alpaca configuration diagnostic command:
  - `alpaca:config`
- Added `docs/vps-paper-research-deployment.md` with cron scheduling and cron-command examples for paper-only VPS workflows.
- Added `.env.example` placeholders and scripts for read-only Alpaca commands plus the explicit paper-only `paper:execute --confirmPaper` gate; no live-order commands were added.
- Added paper snapshot history read path for `paper:snapshots` with table and JSON output support.
- Added paper intelligence read-only surface commands:
  - `paper:trends`
  - `paper:runtime`
  - `paper:intel`
- Added dry-run planning gate:
  - `paper:plan`
- Added review-only safety gate:
  - `paper:review`
- Added dry-run execution payload builder:
  - `paper:execute -- --dryRun`
- Added confirm-paper execution command:
  - `paper:execute -- --confirmPaper`
- Added paper-only Next.js dashboard under `apps/dashboard/`:
  - `npm run dashboard:dev`
  - `npm run dashboard:build`
  - `npm run dashboard:start`
- Dashboard API routes enforce `ALPACA_ENV=paper` and `LIVE_TRADING_ENABLED=false`; order submission additionally requires `PAPER_ORDER_EXECUTION_ENABLED=true`.
- Vercel dashboard runtime is read-only for historical data:
  - does not create `apps/dashboard/data`
  - does not initialize local SQLite under `/var/task`
  - returns `mode: "vercel-read-only"` fallback responses for historical routes
  - still allows guarded live read-only paper account/positions if paper credentials are configured
  - always blocks order submission on Vercel
- VPS/local runtime remains the owner of SQLite history, scheduler, paper execution ledger, and paper submission.
- Confirm-paper pre-submission gates:
  - `ALPACA_ENV=paper`
  - `LIVE_TRADING_ENABLED=false`
  - `PAPER_ORDER_EXECUTION_ENABLED=true`
  - `PAPER_OPTIONS_EXECUTION_ENABLED=true` for option payloads
- Added realistic paper equity sizing defaults:
  - `PAPER_EQUITY_NOTIONAL_PER_ORDER=1000`
  - `PAPER_EQUITY_MAX_NOTIONAL_PER_ORDER=5000`
  - `PAPER_EQUITY_MAX_PORTFOLIO_DEPLOY_PCT=50`
  - `PAPER_EQUITY_MAX_POSITION_PCT=10`
  - `PAPER_EQUITY_MIN_CASH_RESERVE_PCT=20`
- Added practical paper options execution defaults (execution disabled by default):
  - `PAPER_OPTIONS_MAX_PREMIUM_PER_ORDER=1000`
  - `PAPER_OPTIONS_MAX_CONTRACTS=5`
  - `PAPER_OPTIONS_MIN_DTE=0`
  - `PAPER_OPTIONS_MAX_DTE=90`
  - `PAPER_OPTIONS_ALLOW_0DTE=true`
  - `PAPER_OPTIONS_ALLOW_MARKET_ORDERS=false`
  - `PAPER_OPTIONS_LIMIT_PRICE_BASIS=mid`
  - `PAPER_OPTIONS_MAX_SPREAD_PCT=50`
  - `PAPER_OPTIONS_MAX_PORTFOLIO_RISK_PCT=20`
  - `PAPER_OPTIONS_MAX_POSITION_RISK_PCT=5`
  - `PAPER_OPTIONS_ALLOW_LONG_CALLS=true`
  - `PAPER_OPTIONS_ALLOW_LONG_PUTS=true`
  - `PAPER_OPTIONS_ALLOW_CASH_SECURED_PUTS=true`
  - `PAPER_OPTIONS_ALLOW_COVERED_CALLS=true`
  - `PAPER_OPTIONS_ALLOW_NAKED_OPTIONS=false`
- `paper:execute --confirmPaper` remains blocked unless dry-run or confirm flag requirements and all blocker checks pass.
- Execution ledger now records built, blocked, submitted, accepted, rejected, failed, and duplicate-blocked attempts with payload/response audit fields where available.
- Optional runtime duplicate reconciliation checks recent paper orders when `PAPER_RUNTIME_DUPLICATE_RECONCILIATION_ENABLED=true`.
- Multi-leg options are still intentionally left for a future phase; do not model spreads as separate unrelated single-leg submissions.
- If review reports `NO_RUNTIME_CANDIDATES`, confirm the latest research run used enough bar history before changing planner/review logic.
- Current validation checklist:
  - `npm run alpaca:config -- --format=json`
  - `npm run alpaca:health -- --format=json`
  - `npm run alpaca:account -- --format=json`
  - `npm run alpaca:positions -- --format=json`
  - `npm run alpaca:orders -- --format=json`
  - `npm run alpaca:asset -- --symbol=AAPL --format=json`
  - `npm run research:daily -- --riskProfile=aggressive --optionsEnabled=true --maxCandidates=10 --useAlpacaAssets=true`
  - `npm run paper:snapshots -- --format=json --limit=5`
  - `npm run paper:trends -- --format=json`
  - `npm run paper:runtime -- --format=json`
  - `npm run paper:intel -- --format=json`
  - `npm run paper:plan -- --riskProfile=aggressive --optionsEnabled=true --format=json`
  - `npm run paper:review -- --riskProfile=aggressive --optionsEnabled=true --format=json`
  - `npm run paper:execute -- --dryRun --riskProfile=aggressive --optionsEnabled=true --format=json`
  - `npm run paper:execute -- --confirmPaper --format=json`
  - `npm run dashboard:build`
