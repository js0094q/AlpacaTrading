# Resume Context: Alpaca Trading Research Infra

## Latest VPS handoff status (2026-07-05 UTC)

- VPS was rebuilt from empty and re-bootstrapped from this repo.
- SSH target remains `alpaca@185.193.127.15` and can be reached as:
  - `ssh njalla-vps`
- VPS hostname is `jspaper`.
- Repo location on VPS is `/home/alpaca/Alpaca-Trading`.
- Runtime secrets are sourced from `/opt/alpaca-investing/secrets/alpaca.env`
  - owned by `alpaca:alpaca`
  - mode `600`
- Runtime service layer currently expected:
  - `alpaca-dashboard-control.service` (from `server/systemd/dashboard-control.service`)
  - active and bound to `127.0.0.1:4100`.
- Paper mode controls are still in force:
  - `ALPACA_ENV=paper`
  - `ALPACA_LIVE_TRADE=false`
  - `LIVE_TRADING_ENABLED=false`
  - `PAPER_ORDER_EXECUTION_ENABLED=false`
  - `PAPER_OPTIONS_EXECUTION_ENABLED=false`
- Options quote/execution controls after the quote-status fix:
  - `OPTIONS_QUOTE_MAX_AGE_MS=900000` by default.
  - `ALLOW_OPTIONS_LAST_PRICE_FALLBACK=false` by default.
  - `ALLOW_0DTE_OPTIONS=true` for the current paper runtime target.
  - Option contracts may be discovered with null quotes, but they must carry `quoteStatus`, `executable=false`, and `rejectionReason` before they can appear in dashboard/runtime outputs.
- Paper option learning layer:
  - `PAPER_OPTION_LEARNING_LEDGER_ENABLED=true` records option candidate decisions into `paper_learning_records`.
  - `PAPER_0DTE_SPY_ENABLED=false` and `PAPER_LEAPS_ENABLED=false` remain safe defaults; enabling them is paper-only and does not enable live trading.
  - 0DTE discovery is first-class when enabled, does not require SPY to appear in normal equity candidates, considers at most one same-day SPY call and one same-day SPY put, and is capped by premium/contracts/daily-trade controls.
  - LEAPS discovery is first-class when enabled, does not require the underlying to appear in normal equity candidates, uses `PAPER_LEAPS_UNDERLYINGS=SPY,QQQ` by default, and selects at most one long-dated call per underlying inside `PAPER_LEAPS_MIN_DTE=180` to `PAPER_LEAPS_MAX_DTE=730`.
  - `paper:plan` and `paper:review` refresh empty or stale explicit discovery contract windows from Alpaca, then refresh quotes only for selected discovery contracts before deciding whether payloads are executable.
  - `npm run options:diagnose -- --underlyings=SPY,QQQ` is the read-only diagnostic for local cache counts, Alpaca contract endpoint availability, SPY same-day contracts, LEAPS counts, sample symbols, quote availability, and zero-contract reasons.
  - Wide spreads are warnings unless `PAPER_OPTIONS_HARD_SPREAD_CAP_ENABLED=true` or the family-specific hard-spread flag is enabled.
  - `npm run paper:learn -- --format=json` evaluates pending learning rows when local option marks exist and reports promotion-readiness analytics using live-like fill profit factor.
- Control bridge health:
  - `GET /api/v1/health` without token returns a healthy 200.
  - `POST /api/v1/refresh` without or with a bad token returns `401`.
  - `POST /api/v1/refresh` with the control token returns 200, remains non-mutating, and runs only the read-only `paper:runtime` command.
  - Public `https://www.jlsprojects.com/api/paper/summary` returns paper-only state through the Vercel-to-VPS bridge.
  - Dashboard page summary loads use a 30 second VPS bridge timeout so slow summary reads are reported as dashboard data timeouts instead of environment-guard aborts.
  - Public `POST https://www.jlsprojects.com/api/paper/research/run` succeeds with valid admin auth after the control action was bounded to `--barLookbackDays=120`, `ALPACA_REQUEST_TIMEOUT_MS=10000`, and `ALPACA_MAX_RETRIES=0`.
- SSH hardening:
  - key-based auth is active and password auth is disabled.
  - root key recovery remains intentionally preserved (`PermitRootLogin without-password`) until the user explicitly disables it.
  - `UFW` and `fail2ban` have been revalidated.
- Runtime check results captured prior to pause:
  - `alpaca:health` returned `paperOnly: true`.
  - `paper:runtime -- --format=json` returned runtime state.
  - latest `paper:runtime` sees 3 equity candidates, each already held in current paper positions.
  - latest `paper:plan` finds the current research run but produces zero planned orders because those candidate symbols are already held.
  - `paper:execute` now reports this zero-payload state as `status: "no_op"` with `reason: "NO_ELIGIBLE_PAPER_PAYLOADS"` instead of a safety-review failure.
- Current duplicate-classification behavior:
  - held/open equity positions or orders block duplicate equity candidates on the same symbol.
  - held/open equity positions or orders do not by themselves block option contracts on the same underlying.
  - held/open option contracts are compared by option contract symbol and reported with option-specific duplicate reasons.

## Token/env coordination

- `VPS_CONTROL_TOKEN` is configured in `/opt/alpaca-investing/secrets/alpaca.env`; Vercel must use the same value in `VPS_CONTROL_TOKEN`.
- `DASHBOARD_ADMIN_TOKEN` belongs in Vercel production environment for dashboard mutating/admin routes.
- Secrets must not be copied into repo files, client code, or Vercel frontend bundles.

## Current continuation objective

1. Open SSH control:
   - `ssh njalla-vps`
   - `cd /home/alpaca/Alpaca-Trading`
   - load NVM and source `/opt/alpaca-investing/secrets/alpaca.env`.
2. Confirm there are no stale research runs:
   - `ps -ef | rg "tsx src/cli.ts research daily|npm run research:daily|timeout .*research:daily"`.
3. Run bounded paper research only when a fresh research cycle is needed:
   - `ALPACA_REQUEST_TIMEOUT_MS=10000 ALPACA_MAX_RETRIES=0 timeout 300 npm run research:daily -- --riskProfile=aggressive --optionsEnabled=true --maxCandidates=3 --format=json --barLookbackDays=120`.
4. Verify output and re-run readiness chain:
   - `npm run paper:snapshots -- --format=json --limit=5`
   - `npm run paper:runtime -- --format=json`
   - `npm run options:diagnose -- --underlyings=SPY,QQQ`
   - `npm run paper:review -- --riskProfile=aggressive --optionsEnabled=true --format=json`
   - `npm run paper:plan -- --riskProfile=aggressive --optionsEnabled=true --maxCandidates=10 --format=json`.
5. Once snapshots flow, re-check control bridge actions:
   - `curl -sS -H "Authorization: Bearer $VPS_CONTROL_TOKEN" http://127.0.0.1:4100/api/v1/review/latest`
   - `curl -sS -H "Authorization: Bearer $VPS_CONTROL_TOKEN" http://127.0.0.1:4100/api/v1/plan/latest`
   - `curl -sS -X POST -H "Authorization: Bearer $VPS_CONTROL_TOKEN" -H "Content-Type: application/json" -d '{}' http://127.0.0.1:4100/api/v1/refresh`

## Known safe boundaries

- Do not enable any live or direct Alpaca execution on Vercel.
- Keep dashboard actions behind explicit admin controls and VPS allowlisted commands.
- Do not relax paper-only gates without an explicit request.
