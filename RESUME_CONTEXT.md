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
  - `PAPER_ORDER_EXECUTION_ENABLED=true`
  - `PAPER_OPTIONS_EXECUTION_ENABLED=true`
- Options quote/execution controls after the quote-status fix:
  - `OPTIONS_QUOTE_MAX_AGE_MS=900000` by default.
  - `ALLOW_OPTIONS_LAST_PRICE_FALLBACK=false` by default.
  - `ALLOW_0DTE_OPTIONS=true` for the current paper runtime target.
  - Option contracts may be discovered with null quotes, but null quote, missing bid, missing ask, crossed quote, and non-positive derived limit price remain hard blockers.
  - Stale quotes with complete non-crossed bid/ask are warning-only for paper option review; paper limit prices are derived from midpoint by default or `askFallback` when explicitly configured.
- Paper option learning layer:
  - `PAPER_OPTION_LEARNING_LEDGER_ENABLED=true` records option candidate decisions into `paper_learning_records`.
  - Preferred paper option caps are `PAPER_OPTION_MAX_PREMIUM_PER_CONTRACT=1500`, `PAPER_OPTION_MAX_ORDER_NOTIONAL=1500`, and `PAPER_OPTION_MAX_CONTRACTS=1`.
  - 0DTE SPY paper caps are `PAPER_0DTE_SPY_MAX_PREMIUM_PER_CONTRACT=250`, `PAPER_0DTE_SPY_MAX_ORDER_NOTIONAL=250`, and `PAPER_0DTE_SPY_MAX_CONTRACTS=1`.
  - LEAPS paper caps are `PAPER_LEAPS_MAX_PREMIUM_PER_CONTRACT=1500`, `PAPER_LEAPS_MAX_ORDER_NOTIONAL=1500`, and `PAPER_LEAPS_MAX_CONTRACTS=1`.
  - `PAPER_0DTE_SPY_ENABLED=false` and `PAPER_LEAPS_ENABLED=false` remain safe defaults; enabling them is paper-only and does not enable live trading.
  - 0DTE discovery is first-class when enabled, does not require SPY to appear in normal equity candidates, considers ranked same-day SPY call/put alternatives, selects at most one executable call and one executable put, and walks OTM when the nearest contract exceeds caps.
  - LEAPS discovery is first-class when enabled, does not require the underlying to appear in normal equity candidates, uses `PAPER_LEAPS_UNDERLYINGS=SPY,QQQ` by default, considers ranked delta/moneyness alternatives, and selects at most one executable long-dated call per underlying inside `PAPER_LEAPS_MIN_DTE=180` to `PAPER_LEAPS_MAX_DTE=730`.
  - LEAPS exit review is now explicit and does not depend on `PAPER_LEAPS_ENABLED`; it manages already-held LEAPS through `paper:portfolio:review`, `paper:exit:review`, `paper:ops:review`, and the `optionSellToCloseExits` reviewed artifact section.
  - LEAPS exit defaults: `LEAPS_MIN_DTE_AT_ENTRY=270`, `LEAPS_DTE_EXIT_THRESHOLD=180`, `LEAPS_REVIEW_LOSS_PCT=-20`, `LEAPS_HARD_STOP_LOSS_PCT=-35`, `LEAPS_PARTIAL_PROFIT_TAKE_PCT=75`, `LEAPS_FULL_PROFIT_TAKE_PCT=125`, `LEAPS_TREND_REVIEW_SMA=100`, `LEAPS_SEVERE_TREND_EXIT_SMA=200`, `LEAPS_MAX_BID_ASK_SPREAD_PCT=20`, `LEAPS_MIN_DELTA_REVIEW=0.45`, and `LEAPS_REVIEW_INTERVAL_DAYS=30`.
  - LEAPS classification uses entry DTE from `paper_learning_records`, then paper execution ledger rows; if neither proves entry DTE, current DTE can classify only with `LEAPS_CLASSIFICATION_INFERRED`, so short-dated options are not promoted into LEAPS.
  - LEAPS hard exits are `LEAPS_HARD_STOP_LOSS`, `LEAPS_FULL_PROFIT_TAKE`, `LEAPS_DTE_EXIT_WINDOW`, and `LEAPS_SEVERE_TREND_BREAK`; warning-only reasons are `LEAPS_REVIEW_LOSS_WARNING`, `LEAPS_PARTIAL_PROFIT_REVIEW`, `LEAPS_TREND_REVIEW`, `LEAPS_DELTA_DETERIORATION`, `LEAPS_DELTA_UNAVAILABLE`, and `LEAPS_PERIODIC_REVIEW_DUE`.
  - LEAPS hard exits become executable only when bid/ask exists and spread is within `LEAPS_MAX_BID_ASK_SPREAD_PCT`; otherwise `LIMIT_EXIT_REQUIRED` or `LEAPS_QUOTE_UNAVAILABLE` keeps the reviewed candidate non-executable.
  - `paper:plan` and `paper:review` refresh empty or stale explicit discovery contract windows from Alpaca, then refresh quotes for ranked discovery alternatives before deciding whether payloads are executable.
  - `npm run options:diagnose -- --underlyings=SPY,QQQ` is the read-only diagnostic for local cache counts, Alpaca contract endpoint availability, SPY same-day contracts, LEAPS counts, sample symbols, quote availability, and zero-contract reasons.
  - Wide spreads are warnings unless `PAPER_OPTIONS_HARD_SPREAD_CAP_ENABLED=true` or the family-specific hard-spread flag is enabled.
  - `npm run paper:learn -- --format=json` evaluates pending learning rows when local option marks exist and reports promotion-readiness analytics using live-like fill profit factor.
- Control bridge health:
  - `GET /api/v1/health` without token returns a healthy 200.
  - `POST /api/v1/refresh` without or with a bad token returns `401`.
  - `POST /api/v1/refresh` with the control token returns 200, remains non-mutating, and runs only the read-only `paper:runtime` command.
  - Public `https://www.jlsprojects.com/api/paper/summary` returns paper-only state through the Vercel-to-VPS bridge.
  - Dashboard page summary loads use a cached VPS summary bridge with a 30 second timeout; expensive fresh plan/review/dry-run work stays on explicit protected action routes.
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
  - `paper:execute --confirmPaper` accepts `--riskProfile` and `--optionsEnabled`; option payload submission requires `--optionsEnabled=true` plus an explicit valid `--riskProfile` on the execution command, and internally rebuilds plan/review with those supplied flags before submitting.
- Current duplicate-classification behavior:
  - held/open equity positions or orders block duplicate equity candidates on the same symbol.
  - held/open equity positions or orders do not by themselves block option contracts on the same underlying.
  - held/open option contracts are compared by option contract symbol and reported with option-specific duplicate reasons.
- Paper operations layer added after this checkpoint:
  - Dashboard cards live under `Paper Trading Controls`.
  - New dashboard routes live under `apps/dashboard/app/api/paper/actions/*`.
  - New VPS allowlisted control routes live under `/api/v1/actions/*`.
  - `paper:portfolio:review` is review-only and emits `BUY_NEW_EQUITY`, `ADD_TO_EQUITY`, `SELL_EQUITY`, `HOLD_EQUITY`, `BUY_OPTION`, `SELL_TO_CLOSE_OPTION`, and `HOLD_OPTION` recommendations.
  - `paper:options:discover` is review-only and labels current-session 0DTE versus `nextSessionPreparation: true`.
  - `paper:ops:review` persists the latest reviewed payload artifact and operation log rows.
  - `paper:execute:reviewed -- --confirmPaper` refuses missing, stale, empty, or payload-signature-mismatched review artifacts before paper submission.
  - `paper:execute:reviewed` now supports `--sections=` so scheduler entry execution is limited to `equityBuys,equityAdds,optionBuys` and scheduler exit execution is limited to `equitySells,optionSellToCloseExits`.
  - Reviewed LEAPS sell-to-close execution also fails closed unless `ALPACA_ENV=paper`, `TRADING_MODE=paper`, `ALPACA_LIVE_TRADE=false`, `LIVE_TRADING_ENABLED=false`, `PAPER_ORDER_EXECUTION_ENABLED=true`, `PAPER_OPTIONS_EXECUTION_ENABLED=true`, `AUTOMATED_PAPER_EXECUTION_ENABLED=true`, and `--confirmPaper` are all present.
  - `AUTOMATED_PAPER_EXECUTION_ENABLED=false` remains the default for review-only `paper-ops-*` timers.
  - Continuous monitor timers are installed from `scripts/install-paper-monitoring-systemd.sh` and run through `npm run paper:monitor`, which gates market hours/holidays, paper runtime, live-off flags, execution flags, and per-task locks.
- Portfolio risk and hedge-management layer added on `paper-ops-layer` (not deployed in this task):
  - Canonical OCC parsing now feeds asset identity, LEAPS exit review, portfolio review, and paper dry-run DTE logic.
  - Read-only commands are `hedge:risk`, `hedge:regime`, `hedge:review`, and `hedge:plan -- --paperOnly`; no `hedge:execute` command exists.
  - `HEDGE_PAPER_EXECUTION_ENABLED=false` remains the fail-closed default.
  - Portfolio risk uses observed option Greeks, signed-exposure beta, grouped concentration, persisted paper high-water marks, and 5/8/10/15 percent benchmark-decline scenarios.
  - Beta cache identity includes symbol, benchmark, lookback, interval, minimum observations, calculation version, and latest aligned market-data date; incompatible or expired rows are ignored.
  - Hedge recommendations prefer concentrated/profitable LEAPS trimming before paid protection, subtract existing puts/inverse exposure, and treat profit funding as an unrealized-gain proxy.
  - Put spreads remain analysis-only with `MULTI_LEG_EXECUTION_UNSUPPORTED`; SH/PSQ remain secondary alternatives.
  - Signed plans are stored in `paper_learning_records`, expire, retain configuration/model/snapshot integrity, and are not recognized by the reviewed order executor.
  - Existing paper-ops moments refresh persisted hedge reviews but cannot submit hedge orders and do not alter reviewed order sections.
  - Cached GET routes are `/api/v1/hedge/risk`, `/api/v1/hedge/regime`, and `/api/v1/hedge/recommendation`, with matching Vercel `/api/paper/hedge/*` routes.
  - The dashboard marks `stale` and `expired` recommendations as not current and displays model versions, quality, scenarios, LEAPS logic, candidates, warnings, and blockers.

## Token/env coordination

- `VPS_CONTROL_TOKEN` is configured in `/opt/alpaca-investing/secrets/alpaca.env`; Vercel must use the same value in `VPS_CONTROL_TOKEN`.
- `DASHBOARD_ADMIN_TOKEN` belongs in Vercel production environment for dashboard mutating/admin routes.
- Secrets must not be copied into repo files, client code, or Vercel frontend bundles.
- Use `npm run vercel:env:parity -- --check-vercel-presence --pull-vercel` for redacted Vercel production env checks. The utility reports presence and sha256 fingerprint match booleans only.

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
   - `npm run paper:portfolio:review -- --format=json`
   - `npm run paper:exit:review -- --format=json`
   - `npm run paper:options:discover -- --underlying=SPY --dte=0 --format=json`
   - `npm run paper:ops:review -- --format=json`
   - `npm run hedge:risk -- --format=json`
   - `npm run hedge:regime -- --format=json`
   - `npm run hedge:review -- --format=json`
   - `npm run hedge:plan -- --paperOnly --format=json`
5. Once snapshots flow, re-check control bridge actions:
   - `curl -sS -H "Authorization: Bearer $VPS_CONTROL_TOKEN" http://127.0.0.1:4100/api/v1/review/latest`
   - `curl -sS -H "Authorization: Bearer $VPS_CONTROL_TOKEN" http://127.0.0.1:4100/api/v1/plan/latest`
   - `curl -sS -X POST -H "Authorization: Bearer $VPS_CONTROL_TOKEN" -H "Content-Type: application/json" -d '{}' http://127.0.0.1:4100/api/v1/refresh`

## Known safe boundaries

- Do not enable any live or direct Alpaca execution on Vercel.
- Keep dashboard actions behind explicit admin controls and VPS allowlisted commands.
- Do not relax paper-only gates without an explicit request.
- Do not run `npm run paper:execute:reviewed -- --confirmPaper` or `npm run paper:execute -- --confirmPaper` unless the user explicitly requests paper execution.
- No live execution route exists in the dashboard operations layer.
- No hedge execution route or command exists; do not add or run `hedge:execute`.
- Automated paper execution is only allowed through the `alpaca-paper-*` monitor timers, reviewed artifacts, section filters, and paper-only/live-off runner guards.
