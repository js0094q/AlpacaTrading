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
PAPER_REVIEW_SIGNING_KEY=
HEDGE_REVIEW_SIGNING_KEY=
```

Do not store Alpaca keys in shell history, README files, logs, tests, frontend code, or prompts. Rotate any live keys that were already uploaded, pasted, or exposed before future live use.

### Signed-review deployment cutover

`PAPER_REVIEW_SIGNING_KEY` is a VPS-only HMAC secret for general reviewed
payloads and 0DTE submit attestations. `HEDGE_REVIEW_SIGNING_KEY` remains the
independent hedge-review signer. Before deploying the safety floor, stop the
affected control service and paper/0DTE timers, add or preserve a
cryptographically random general signer without printing it, restore
`alpaca:alpaca` ownership and mode `0600`, and report only presence or a SHA-256
fingerprint. Never copy either signer to Vercel.

After restart, all unsigned general artifacts are intentionally invalid. Create
a new review with `npm run paper:ops:review -- --format=json`. Do not run an
execution command as a cutover check. A later entry submit re-fetches paper
account, position, order, reservation, market, and cap evidence; material drift
returns `FRESH_REVIEW_REQUIRED` and requires another review. Compatibility CLI
and HTTP confirm paths now dispatch reviewed execution only and never supply
confirmation implicitly.

The checked-in ordinary equity defaults remain `$1,000` per order, `$5,000`
maximum per order, and `$50,000` total plan notional, with a `20%` cash reserve,
`50%` portfolio deployment cap, and `10%` position cap. Scale-in remains
disabled by default with a `$250` add size. A redacted 2026-07-14 pre-deploy
inspection found no selected VPS sizing overrides, so these source defaults
were runtime-effective; the objective's `$100`/`$300` figures were neither
installed nor adopted. Hedge environment percentages are `0.75`, `2`, and `1`,
which normalize to `0.0075`, `0.02`, and `0.01` of equity.

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
sudo systemctl stop alpaca-market-observatory.timer
sudo systemctl stop paper-ops-morning.timer paper-ops-midday.timer paper-ops-late-day.timer
sudo systemctl stop alpaca-paper-review.timer alpaca-paper-execute.timer alpaca-paper-exit-review.timer alpaca-paper-exit-execute.timer
sudo systemctl stop alpaca-zero-dte-engine.timer alpaca-zero-dte-exit-review.timer alpaca-zero-dte-reconcile.timer alpaca-zero-dte-eod.timer
docker compose -f /opt/alpaca-investing/app/docker-compose.yml down
```

For a schema-bearing release, record the prior timer state, stop affected SQLite
writers, back up the database, and validate `db:migrate` twice on a copy. Run
`db:migrate` once on production before restarting the control service or timers,
then run `db:verify`. Ordinary runtime commands intentionally do not apply
pending production migrations and fail closed with
`DATABASE_MIGRATION_REQUIRED`.

The continuous paper-monitor installer also installs the independent 0DTE Level 2 services and timers. The 0DTE engine runs every minute during the configured entry window; its exit review runs every minute, reconciliation runs every five minutes, and the end-of-day summary runs after the force-exit window. Only `alpaca-zero-dte-engine.service` sets `AUTOMATED_PAPER_EXECUTION_ENABLED=true`, and it still requires the CLI `--confirmPaper` and paper-runtime gates. The other 0DTE services are read-only or mark/summarize local paper and shadow state. See `server/systemd/README.md` for the install/disable commands.

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
