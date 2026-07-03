# Resume Context: Alpaca Investing Server Provisioning

Last milestone status:
- Repo research infra is implemented in the CLI layer (`src/*`, `tests/*`).
- Server work is still limited to bootstrap/hardening tooling in `server/`.

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
