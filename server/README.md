# Alpaca Investing VPS Bootstrap

This directory prepares a Njalla-hosted Ubuntu LTS VPS for a future paper-first Alpaca investing platform. It hardens the host before any trading code, secrets, public UI, or live execution path exists.

Nothing here connects to Alpaca, requests API keys, deploys trading logic, submits orders, or enables live trading.

## Run Order

Review the scripts first, then run exactly:

```bash
sudo bash server/bootstrap.sh
sudo bash server/hardening.sh
bash server/verify_server.sh
```

Keep the original SSH session open while running hardening.

## Manual Safety Checkpoints

Before running:

- Confirm you can connect by SSH key.
- Confirm any local key files or passwords remain outside Git.
- Confirm no real `.env` file is tracked.
- Confirm the VPS is a fresh Ubuntu LTS host or that existing services are intentionally being hardened.

After `server/hardening.sh` restarts SSH:

- Do not log out of the existing session.
- Open a second terminal.
- Test a second key-based SSH session.
- Only close the first session after the second session works.

## SSH Keys

Add operator public keys to the `alpaca` user:

```bash
sudo install -d -o alpaca -g alpaca -m 700 /home/alpaca/.ssh
printf '%s\n' '<public-key-here>' | sudo tee -a /home/alpaca/.ssh/authorized_keys >/dev/null
sudo chown alpaca:alpaca /home/alpaca/.ssh/authorized_keys
sudo chmod 600 /home/alpaca/.ssh/authorized_keys
```

Do not paste private keys into shell history or repository files.

## What Bootstrap Does

`server/bootstrap.sh`:

- installs baseline packages
- creates the `alpaca` user if missing
- copies root's existing public `authorized_keys` to `alpaca` when `alpaca` has no keys yet
- creates `/opt/alpaca-investing`
- locks `/opt/alpaca-investing/secrets` to `alpaca:alpaca` with `700` permissions
- writes `/opt/alpaca-investing/secrets/alpaca.env.example` with placeholders only
- enables unattended security updates without automatic reboots
- installs Docker Engine and the Docker Compose plugin from Docker's official apt repository unless `SKIP_DOCKER=1` is set

The bootstrap does not add `alpaca` to the `docker` group because that grants root-equivalent access. Rootless Docker is installed as a package dependency but intentionally left for a later interactive operator validation step.

## What Hardening Does

`server/hardening.sh`:

- backs up SSH config under `/root/alpaca-hardening-backups/`
- refuses to continue unless `alpaca` has at least one SSH public key in `authorized_keys`
- requires operator confirmation that `ssh alpaca@<server-ip>` works in a second terminal
- writes `/etc/ssh/sshd_config.d/99-alpaca-hardening.conf`
- validates SSH with `sshd -t`
- validates effective SSH settings with `sshd -T`
- restarts SSH only if validation passes
- enables UFW with default-deny inbound and OpenSSH allowed
- configures fail2ban for SSH

It does not change the SSH port.

For non-interactive hardening, first test a separate `alpaca` SSH session, then run:

```bash
sudo ALPACA_CONFIRMED_ALPACA_SSH=1 bash server/hardening.sh
```

## Verify UFW

```bash
sudo ufw status verbose
```

Expected initial state:

- status is active
- incoming default is deny
- outgoing default is allow
- OpenSSH is allowed
- app ports are not exposed

Only open `80/tcp` and `443/tcp` after a reverse proxy is intentionally configured.

## Check fail2ban

```bash
sudo systemctl status fail2ban
sudo fail2ban-client status sshd
```

The SSH jail config is `/etc/fail2ban/jail.d/sshd.local`.

## Check Security Updates

```bash
systemctl status unattended-upgrades
systemctl list-timers 'apt-daily*'
sudo less /var/log/unattended-upgrades/unattended-upgrades.log
```

Automatic reboots are disabled. Reboots require explicit operator approval.

## Secrets Policy

Real secrets must be stored only on the VPS at:

```text
/opt/alpaca-investing/secrets/alpaca.env
```

Required permissions:

```bash
sudo chown alpaca:alpaca /opt/alpaca-investing/secrets/alpaca.env
sudo chmod 600 /opt/alpaca-investing/secrets/alpaca.env
```

The only committed example is placeholder-only:

```text
ALPACA_ENV=paper
ALPACA_PAPER_KEY=
ALPACA_PAPER_SECRET=
ALPACA_LIVE_KEY=
ALPACA_LIVE_SECRET=
ALPACA_PAPER_BASE_URL=https://paper-api.alpaca.markets
ALPACA_LIVE_BASE_URL=https://api.alpaca.markets
LIVE_TRADING_ENABLED=false
```

Do not store Alpaca keys in shell history, README files, logs, tests, frontend code, or prompts. Rotate any live keys that were already uploaded, pasted, or exposed before future live use.

## Docker

`server/docker-compose.placeholder.yml` contains non-trading placeholders only. It is not deployed by the bootstrap.

If rootless Docker is configured later, validate it interactively as `alpaca` before deploying services. Until then, Docker remains rootful and should be operated with `sudo`; `alpaca` is not placed in the `docker` group.

## Caddy

`server/caddy/Caddyfile.example` is a template only:

```caddy
example.com {
    reverse_proxy 127.0.0.1:8000
}
```

Before using Caddy:

- set the domain's A and AAAA records to the VPS
- open `80/tcp` and `443/tcp` in UFW
- bind app services only to localhost or a Docker internal network
- let Caddy terminate HTTPS

No public UI is deployed by these server bootstrap scripts. The optional paper-only dashboard lives in `apps/dashboard/` and must be deployed separately behind its documented paper guards.

## Cached hedge review routes

The control server exposes GET-only cached persistence reads at:

```text
/api/v1/hedge/risk
/api/v1/hedge/regime
/api/v1/hedge/recommendation
```

The GET routes remain cached, paper-only persistence reads. Authenticated POST routes now use a fixed VPS allowlist for hedge review, reviewed entry execution, exit review, and reviewed exit execution. Each mutation route requires the dashboard admin token, `HEDGE_DASHBOARD_MUTATIONS_ENABLED=true`, paper runtime preflight, and the relevant explicit paper execution flags; execution still fails closed for live environment, live hedge execution, stale/consumed reviews, duplicate reservations, and multi-leg payloads. Signed hedge plans remain separate review artifacts, and put spreads remain blocked with `MULTI_LEG_EXECUTION_UNSUPPORTED`.

## Stop App Services

The VPS may run the paper-only dashboard control API and scheduled paper ops timers. Stop them before
changing deployment artifacts, secrets, or security-relevant environment values:

```bash
sudo systemctl stop alpaca-dashboard-control.service
sudo systemctl stop paper-ops-morning.timer paper-ops-midday.timer paper-ops-late-day.timer
docker compose -f /opt/alpaca-investing/app/docker-compose.yml down
```

## Intentionally Not Implemented

- Alpaca API connection
- Alpaca CLI login
- paper or live credentials
- trading strategies
- autonomous order submission
- live trading enablement
- public frontend deployment from the server bootstrap scripts
- public app ports
- DNS changes
