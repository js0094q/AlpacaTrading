# Resume Context: Alpaca Investing Server Provisioning

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
  - Public `POST /api/paper/research/run` was verified through `https://www.jlsprojects.com` with valid admin auth.
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

## Do-not-break requirements

- Preserve paper-only guardrails (`ALPACA_ENV=paper`, `LIVE_TRADING_ENABLED=false`) on all runs.
- Do not add direct shell command execution in dashboard actions; keep allowlisted control endpoints only.
- Do not configure direct client-side Alpaca credentials or local SQLite writes on Vercel.
- Preserve option quote execution gates: stale/missing/crossed quotes and same-day expirations are non-executable unless explicitly enabled by runtime env.
