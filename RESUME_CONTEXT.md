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
- Control bridge health:
  - `GET /api/v1/health` without token returns a healthy 200.
  - `POST /api/v1/refresh` without or with a bad token returns `401`.
  - `POST /api/v1/refresh` with the control token returns 200 and remains non-mutating.
  - Public `https://www.jlsprojects.com/api/paper/summary` returns paper-only state through the Vercel-to-VPS bridge.
  - Public `POST https://www.jlsprojects.com/api/paper/research/run` succeeds with valid admin auth after the control action was bounded to `--barLookbackDays=120`, `ALPACA_REQUEST_TIMEOUT_MS=10000`, and `ALPACA_MAX_RETRIES=0`.
- SSH hardening:
  - key-based auth is active and password auth is disabled.
  - root key recovery remains intentionally preserved (`PermitRootLogin without-password`) until the user explicitly disables it.
  - `UFW` and `fail2ban` have been revalidated.
- Runtime check results captured prior to pause:
  - `alpaca:health` returned `paperOnly: true`.
  - `paper:runtime -- --format=json` returned runtime state.
  - latest `paper:runtime` sees 3 candidates.
  - latest `paper:plan` finds the current research run but skips all candidates due to `OPEN_ORDER_EXISTS`.
  - latest `paper:review` is blocked by `ALL_CANDIDATES_SKIPPED` and `NO_PLANNED_ORDERS`.

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
