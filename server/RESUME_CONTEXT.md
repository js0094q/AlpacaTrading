# Resume Context: Alpaca Investing Server Provisioning

Last milestone status:
- Repo research infra is implemented in the CLI layer (`src/*`, `tests/*`).
- Server work is still limited to bootstrap/hardening tooling in `server/`.
- Latest VPS runtime handoff, 2026-07-04 UTC:
  - VPS SSH target is `alpaca@185.193.127.15`; hostname is `jspaper`.
  - Local SSH key is `.ssh/id_ed25519` under the repo root.
  - Local `.ssh/.sshpw` stores the key passphrase in `password=<value>` form; use the value after `password=` and do not commit or print it.
  - VPS app repo path is `/home/alpaca/Alpaca-Trading`.
  - VPS runtime secrets file is `/opt/alpaca-investing/secrets/alpaca.env`, owned by `alpaca:alpaca`, mode `600`.
  - Local and VPS Git states were aligned on `main` with `origin/main`.
  - `alpaca:health -- --format=json` passed on the VPS with paper-only guards and account reachability.
  - `paper:runtime -- --format=json` passed on the VPS.
  - `paper:review` and `paper:plan` completed but remained blocked by `NO_RESEARCH_SNAPSHOTS`.
  - `research:daily -- --riskProfile=aggressive --optionsEnabled=true --maxCandidates=10 --useAlpacaAssets=true --format=json --barLookbackDays=365` timed out under a 600-second guard; output file was `/home/alpaca/research-daily-20260704T013221Z.json`.
  - A static-universe `research:daily` run under a 240-second guard was stopped when the user asked to pause; no fresh snapshot was verified.
  - No `research:daily` process was left running after pause cleanup.

## What to read first for infra follow-up

- [server/README.md](/Users/josephstewart/Documents/Alpaca%20Trading/server/README.md) (source of operational truth)
- `server/bootstrap.sh`
- `server/hardening.sh`
- `server/verify_server.sh`
- `server/rollback_notes.md` (if touching hardening behavior)

## Fast resume sequence (server lane)

1. Confirm environment and SSH key-based access in place.
2. Review `server/README.md` before any command run.
3. Re-run bootstrap only if missing baseline setup:
   - `sudo bash server/bootstrap.sh`
4. Run verification:
   - `bash server/verify_server.sh`
5. If hardening is needed, confirm a second SSH session first:
   - `sudo ALPACA_CONFIRMED_ALPACA_SSH=1 bash server/hardening.sh`
6. Re-verify:
   - `sudo ufw status verbose`
   - `sudo systemctl status fail2ban`
   - `systemctl status unattended-upgrades`

## Fast resume sequence (VPS paper runtime lane)

1. SSH to the VPS as `alpaca@185.193.127.15` with the repo-local key.
2. Confirm no stale daily research processes:
   - `ps -ef | grep -E "[t]sx src/cli.ts research daily|[n]ode .*src/cli.ts research daily|[t]imeout .*research:daily" || true`
3. Load Node and runtime secrets:
   - `cd /home/alpaca/Alpaca-Trading`
   - `export NVM_DIR="$HOME/.nvm"`
   - `. "$NVM_DIR/nvm.sh"`
   - `set -a && . /opt/alpaca-investing/secrets/alpaca.env && set +a`
4. Run a smaller bounded snapshot-producing daily pass first:
   - `timeout 300 npm run research:daily -- --riskProfile=aggressive --optionsEnabled=true --maxCandidates=3 --format=json --barLookbackDays=120`
5. Verify snapshots and paper readiness:
   - `npm run paper:snapshots -- --format=json --limit=5`
   - `npm run paper:runtime -- --format=json`
   - `npm run paper:review -- --riskProfile=aggressive --optionsEnabled=true --format=json`
   - `npm run paper:plan -- --riskProfile=aggressive --optionsEnabled=true --maxCandidates=10 --format=json`

## Critical safety checkpoints

- Never commit real credentials.
- Never paste real API keys into repo files, shell history, logs, or docs.
- Do not proceed through hardening without operator SSH confirmation step.
- Keep app ports closed unless an explicit reverse proxy and allowlist are configured.
- Do not create or run live app services in this phase.

## Common validation checks

- SSH hardening sanity:
  - `/etc/ssh/sshd_config.d/99-alpaca-hardening.conf`
  - `sshd -T | rg 'passwordauthentication|permitrootlogin|port|x11forwarding'`
- Firewall:
  - UFW active, incoming deny, outgoing allow, OpenSSH allowed
- Secret file target on VPS:
  - `/opt/alpaca-investing/secrets/alpaca.env` (if present) owned by `alpaca:alpaca`, mode `600`

## Follow-up candidates

- Add structured rollback docs for each server script change.
- Add non-destructive validation commands for dry-run bootstrap/hardening.
- Add explicit host inventory snapshot capture (`/etc/os-release`, `uname -a`, `systemctl --failed`) after hardening.
