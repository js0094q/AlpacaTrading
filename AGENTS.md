# Alpaca Investing Agent Rules

This repository is for preparing infrastructure for a future paper-first Alpaca investing platform.

## Safety Boundaries

- Do not connect to Alpaca from this repository unless the user explicitly requests it.
- Do not request, print, commit, or copy real Alpaca API keys.
- Do not configure live trading.
- Do not deploy autonomous trading logic.
- Do not expose application ports publicly except through an explicitly configured reverse proxy.
- Preserve key-based SSH access when changing server hardening.
- Treat `.env*`, `*.env`, `secrets/`, `.ssh/`, `.APILIVEKEY`, and `.APIPAPERKEY` as sensitive local material.

## Implementation Rules

- Inspect the repo before editing.
- Keep changes narrow and reversible.
- Prefer scripts and docs under `server/` for VPS provisioning work.
- Use paper-trading assumptions only.
- Validate shell scripts with `bash -n` after editing.
- Do not commit, deploy, push, or run VPS hardening unless the user explicitly asks.

## Repository-first workflow

- Read these in order before work resumes:
- `AGENTS.md` (this file).
- `RESUME_CONTEXT.md`.
- `README.md`.
- `server/RESUME_CONTEXT.md` if work touches VPS scripts.
- `server/README.md` for full VPS runbook.
- Prefer `rg` and `rg --files` for discovery.
- Preserve the CLI-first architecture and existing dashboard route boundaries unless explicitly asked to broaden them.
- Use existing modules and naming first, only add new abstractions when needed.

## Current continuation note (2026-07-05)

- VPS was rebuilt from empty and re-bootstrapped using `/opt/alpaca-investing/secrets/alpaca.env` as the runtime environment source.
- Runtime endpoint status after rebuild:
  - `alpaca-dashboard-control` service is running from `server/systemd/dashboard-control.service`.
  - Control API currently listens on `127.0.0.1:4100`.
  - `/opt/alpaca-investing/secrets/alpaca.env` includes `VPS_CONTROL_TOKEN`, `VPS_CONTROL_PORT`, `VPS_CONTROL_BIND_HOST`, and paper safety flags.
- Coordination rule for the next handoff:
  - `VPS_CONTROL_TOKEN` must match between VPS runtime env and Vercel runtime env.
  - `DASHBOARD_ADMIN_TOKEN` should be set in Vercel production before mutating dashboard admin routes are used.
- Verified bridge state:
  - Public `https://www.jlsprojects.com/api/paper/summary` returns paper-only state through the VPS bridge.
  - Public `POST /api/paper/research/run` succeeds with a valid admin token after the control service bounds research to `--barLookbackDays=120`, `ALPACA_REQUEST_TIMEOUT_MS=10000`, and `ALPACA_MAX_RETRIES=0`.
  - `paper:review` is currently blocked by duplicate open orders (`OPEN_ORDER_EXISTS`) for the latest candidates, not by missing research snapshots.
- Security state to preserve:
  - SSH access is key-only; root password login is disabled while root key recovery remains intentionally preserved until the user says otherwise.
  - `UFW` and `fail2ban` were revalidated after the rebuild.

## Core module map (for quick resume)

- CLI: `src/cli.ts`
- Persistence: `src/lib/db.ts`
- Universe: `src/services/universeService.ts`
- Market bars: `src/services/marketDataIngest.ts`
- Options: `src/services/optionsService.ts`, `src/services/providers/alpaca.ts`
- Features: `src/services/featureService.ts`
- Targets: `src/services/targetService.ts`
- Strategy selection: `src/services/strategySelector.ts`
- Backtest: `src/services/backtestService.ts`
- Learning: `src/services/learningService.ts`
- API request logging: `src/services/apiLog.ts`
- Dashboard: `apps/dashboard/`
- Tests: `tests/research.test.ts`

## Safety checks required for continuation

- Paper mode remains default (`ALPACA_LIVE_TRADE=false`, `TRADING_MODE=paper`).
- No module should submit live orders.
- Any future live path must have explicit opt-in feature flags.
- Keep `ENABLE_AGGRESSIVE_PAPER_STRATEGIES` and `ENABLE_SHORT_RESEARCH` in defaults, but do not remove caution controls.
- `paper:execute --dryRun` constructs local would-submit payloads only; it must not submit orders.
- `paper:execute --confirmPaper` is now available and remains paper-only under explicit hard gates.
- Dashboard routes must remain paper-only (`ALPACA_ENV=paper`, `LIVE_TRADING_ENABLED=false`) and must not expose secrets or live-trading toggles.
- If `paper:review` is blocked by `NO_RUNTIME_CANDIDATES`, check `research:daily` bar lookback/history depth before weakening strategy or review guardrails.

## Validation baseline

- `npm run lint`
- `npm run test`
- `npm run typecheck`
- `npm run build`

Run the smallest relevant subset when possible and report pass/fail clearly.

## Context update policy

- Keep README and `RESUME_CONTEXT.md` synchronized after behavior changes.
- Prefer docs-only updates to heavy refactors when the ask is coordination, handoff, or continuation speed.
