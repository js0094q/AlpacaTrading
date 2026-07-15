# Resume Context: Alpaca Investing Server Provisioning

## Adaptive allocation safety-floor pre-deploy handoff (2026-07-14)

- A redacted, read-only VPS check found `/home/alpaca/Alpaca-Trading` clean at
  `29f4a814d39cebc6f66b371571a92fe58228f6e1` before this release.
- Runtime flags remain `ALPACA_ENV=paper`, `TRADING_MODE=paper`,
  `ALPACA_LIVE_TRADE=false`, and `LIVE_TRADING_ENABLED=false`.
  `PAPER_ORDER_EXECUTION_ENABLED`, `PAPER_OPTIONS_EXECUTION_ENABLED`, and
  `AUTOMATED_PAPER_EXECUTION_ENABLED` are present, but no order was submitted
  during implementation or pre-deploy inspection.
- None of the selected equity, plan, scale-in, 0DTE, or hedge sizing variables
  was installed, so checked-in defaults were runtime-effective: `$1,000`
  ordinary equity notional, `$5,000` per-order cap, `$50,000` total-plan cap,
  `$250` scale-in when explicitly enabled, unchanged 0DTE caps, and hedge
  ratios `0.0075`, `0.02`, and `0.01` of equity. The objective's
  `$100`/`$300` figures were not installed or adopted.
- `PAPER_REVIEW_SIGNING_KEY` was absent. Provision or preserve a random value
  in `/opt/alpaca-investing/secrets/alpaca.env` without printing it, keep
  `alpaca:alpaca` mode `0600`, and report only presence/fingerprint before
  restarting affected services. It must not be added to Vercel.
- The deployed cutover invalidates unsigned general review artifacts. Generate
  a new signed `baseline-v1` artifact with the review-only
  `paper:ops:review`. Compatibility confirm routes then dispatch reviewed
  execution only; `FRESH_REVIEW_REQUIRED` means regenerate the review, not
  resize or rebuild inline.
- The safety floor stops before adaptive-allocation Release 1. It adds no live
  path, allocator, cap increase, public mutation route, or allocator-owned exit.

## Latest VPS provisioning handoff (2026-07-05 UTC)

- Repository work after server rebuild:
  - Repo was rebuilt on VPS and synced from host (`main`) during re-bootstrap.
  - Runtime service artifacts were copied from this repo:
    - `server/systemd/dashboard-control.service`
    - `server/verify_server.sh`
    - `server/bootstrap.sh`
    - `server/hardening.sh`
  - Control API service `alpaca-dashboard-control` is active on `127.0.0.1:4100`.
  - Node runtime on VPS is modern (`node -v` from rebuild output: `v22.23.1`).
- Secrets and control config:
  - `/opt/alpaca-investing/secrets/alpaca.env` exists and is owned by `alpaca:alpaca`.
  - `VPS_CONTROL_TOKEN`, `VPS_CONTROL_BIND_HOST`, `VPS_CONTROL_PORT`, `VPS_CONTROL_AUDIT_PATH` are present.
  - Keep Vercel `VPS_CONTROL_TOKEN` synchronized with this file.
  - Keep Vercel `DASHBOARD_ADMIN_TOKEN` in production env for admin endpoints.
- Control action behavior:
  - `research.run` is intentionally bounded by the control server to `--barLookbackDays=120`, `ALPACA_REQUEST_TIMEOUT_MS=10000`, and `ALPACA_MAX_RETRIES=0` so optional slow Alpaca options calls do not exceed Vercel's synchronous timeout.
  - `GET /api/v1/summary` returns cached/read-only dashboard state and does not dispatch fresh plan, review, or dry-run commands.
  - Public `POST /api/paper/research/run` was verified through `https://www.jlsprojects.com` with valid admin auth.
  - The branch now defines cached GET-only hedge routes at `/api/v1/hedge/risk`, `/api/v1/hedge/regime`, and `/api/v1/hedge/recommendation`; this task did not deploy them.
  - Hedge routes read the latest integrity-checked `paper_learning_records` payload and never dispatch commands or order fetches.
- Paper monitor behavior:
  - Market Observatory Phase 1A adds `alpaca-market-observatory.service` and
    `.timer` to the checked-in monitor installer. The read-only collector uses a
    dedicated lock, wakes every 15 minutes during weekday market windows, checks
    the Alpaca clock again, and cannot submit orders. This branch has not been
    deployed, so the units are not asserted active on the VPS.
  - Exit review now evaluates LEAPS positions through the existing `optionSellToCloseExits` reviewed section; no separate LEAPS timer or execution command is required.
  - Reviewed LEAPS sell-to-close execution fails closed unless paper runtime, live-off, paper execution, paper options execution, automated execution, and `--confirmPaper` gates are all satisfied.
  - Existing paper-ops review moments may refresh hedge recommendations; authenticated hedge review/entry/exit routes are bounded by the VPS control allowlist and paper-only gates.
- Security/hardening posture:
  - SSH key-only hardening is in place; password auth is disabled.
  - Root key recovery remains intentionally preserved until explicitly disabled.
  - `UFW` and `fail2ban` were revalidated in the current server session.

## Server fast resume sequence

1. Confirm SSH + sudo path:
   - `ssh njalla-vps`
   - ensure you still have a second SSH session available before any restart-required hardening change.
2. Confirm bootstrap/provision state:
   - `bash /home/alpaca/Alpaca-Trading/server/verify_server.sh`
3. If needed, re-run hardening (non-interactive only after confirmed second session):
   - `sudo ALPACA_CONFIRMED_ALPACA_SSH=1 bash /home/alpaca/Alpaca-Trading/server/hardening.sh`
4. Confirm service and hardening state:
   - `systemctl status alpaca-dashboard-control --no-pager`
   - `sshd -T | rg "passwordauthentication|permitrootlogin|x11forwarding|allowagentforwarding"`
   - `sudo ufw status verbose` (if installed)
   - `sudo systemctl status fail2ban` (if installed)
5. Confirm runtime auth gates:
   - `curl -sS -H "Authorization: Bearer $VPS_CONTROL_TOKEN" http://127.0.0.1:4100/api/v1/health`
   - `curl -sS -H "Authorization: Bearer $VPS_CONTROL_TOKEN" -X POST http://127.0.0.1:4100/api/v1/refresh`
   - `refresh` is a read-only runtime refresh and should run `paper:runtime` without order execution or mutating precheck.

## Do-not-break requirements

- Preserve paper-only guardrails (`ALPACA_ENV=paper`, `LIVE_TRADING_ENABLED=false`) on all runs.
- Keep `HEDGE_LIVE_EXECUTION_ENABLED=false` and `MULTI_LEG_HEDGE_EXECUTION_ENABLED=false`; hedge plans remain signed and expiring, while the separate reviewed executor is paper-only and single-leg.
- Keep `PAPER_REVIEW_SIGNING_KEY` VPS-only. General reviews and 0DTE submit
  attestations fail closed when it is absent, and unsigned legacy artifacts
  must never be grandfathered.
- Keep paper execution operationally enabled only through the guarded paper path (`PAPER_ORDER_EXECUTION_ENABLED=true`, `PAPER_OPTIONS_EXECUTION_ENABLED=true`, valid control/admin auth, and CLI `--confirmPaper`).
- Continuous paper monitor timers are installed with `scripts/install-paper-monitoring-systemd.sh`; they use `npm run paper:monitor`, reviewed payload artifacts, section filters, market-hours no-ops, and per-task locks.
- Do not add direct shell command execution in dashboard actions; keep allowlisted control endpoints only.
- Do not configure direct client-side Alpaca credentials or local SQLite writes on Vercel.
- Preserve option quote execution gates: stale/missing/crossed quotes and same-day expirations are non-executable unless explicitly enabled by runtime env.
