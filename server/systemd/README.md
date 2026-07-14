# systemd Units

Systemd unit templates for future app services live in this directory.

The repository now includes a paper control service template for the VPS dashboard control API:

- `dashboard-control.service` — runs `server/dashboard-control/server.ts` as `alpaca` using `.env` from
  `/opt/alpaca-investing/secrets/alpaca.env`.
- `paper-ops-morning.service` / `.timer` — runs `npm run paper:ops:morning -- --format=json`
  on weekdays around 8:30 AM ET.
- `paper-ops-midday.service` / `.timer` — runs `npm run paper:ops:midday -- --format=json`
  on weekdays around 12:00 PM ET.
- `paper-ops-late-day.service` / `.timer` — runs `npm run paper:ops:late-day -- --format=json`
  on weekdays around 3:15 PM ET.
- `alpaca-market-observatory.service` / `.timer` — runs the read-only
  `npm run paper:monitor -- --task=observatory` collector every 15 minutes during
  weekday regular-market windows.
- `alpaca-paper-review.service` / `.timer` — runs `npm run paper:monitor -- --task=review`
  every 30 minutes during weekday market-hour windows.
- `alpaca-paper-execute.service` / `.timer` — runs reviewed entry execution through
  `npm run paper:monitor -- --task=execute`.
- `alpaca-paper-exit-review.service` / `.timer` — runs reviewed exit checks for equities,
  generic options, LEAPS, and final-hour 0DTE exits every 15 minutes and every 5 minutes
  during the final hour.
- `alpaca-paper-exit-execute.service` / `.timer` — runs reviewed exit execution through
  `npm run paper:monitor -- --task=exit-execute`.
- `alpaca-zero-dte-engine.service` / `.timer` — runs the independent guarded 0DTE Level 2
  engine every minute during the configured entry window.
- `alpaca-zero-dte-exit-review.service` / `.timer` — reviews 0DTE exits every minute during
  market hours without enabling execution.
- `alpaca-zero-dte-reconcile.service` / `.timer` — marks paper/shadow positions and captures
  forward outcomes every five minutes.
- `alpaca-zero-dte-eod.service` / `.timer` — records the 0DTE end-of-day summary after force exit.

## Installing and enabling the control API service

Use this flow only after cloning the repo on the VPS, installing dependencies, and loading paper-only environment.

```bash
sudo mkdir -p /opt/alpaca-investing/systemd
sudo cp /home/alpaca/Alpaca-Trading/server/systemd/dashboard-control.service /opt/alpaca-investing/systemd/alpaca-dashboard-control.service
sudo cp /opt/alpaca-investing/systemd/alpaca-dashboard-control.service /etc/systemd/system/alpaca-dashboard-control.service
sudo systemctl daemon-reload
sudo systemctl enable --now alpaca-dashboard-control.service
sudo systemctl status alpaca-dashboard-control.service --no-pager
```

After install, verify control API health:

```bash
curl -sS -H "Authorization: Bearer $VPS_CONTROL_TOKEN" http://127.0.0.1:4100/api/v1/health | cat
```

## Installing paper ops timers

Set or confirm the VPS timezone before enabling timer units:

```bash
timedatectl status
sudo timedatectl set-timezone America/New_York
```

Install timers:

```bash
sudo cp /home/alpaca/Alpaca-Trading/server/systemd/paper-ops-morning.service /etc/systemd/system/paper-ops-morning.service
sudo cp /home/alpaca/Alpaca-Trading/server/systemd/paper-ops-morning.timer /etc/systemd/system/paper-ops-morning.timer
sudo cp /home/alpaca/Alpaca-Trading/server/systemd/paper-ops-midday.service /etc/systemd/system/paper-ops-midday.service
sudo cp /home/alpaca/Alpaca-Trading/server/systemd/paper-ops-midday.timer /etc/systemd/system/paper-ops-midday.timer
sudo cp /home/alpaca/Alpaca-Trading/server/systemd/paper-ops-late-day.service /etc/systemd/system/paper-ops-late-day.service
sudo cp /home/alpaca/Alpaca-Trading/server/systemd/paper-ops-late-day.timer /etc/systemd/system/paper-ops-late-day.timer
sudo systemctl daemon-reload
sudo systemctl enable --now paper-ops-morning.timer paper-ops-midday.timer paper-ops-late-day.timer
systemctl list-timers 'paper-ops-*' --no-pager
```

Timer services set `AUTOMATED_PAPER_EXECUTION_ENABLED=false`, so scheduled workflows stop at review payload generation.

## Installing continuous paper monitor timers

The continuous monitor includes the non-executing market observatory collector, the reviewed paper-ops timers, and the independent 0DTE Level 2 timers. The 0DTE engine uses its own candidate, decision, paper-trade, shadow, and lifecycle persistence; it does not require the Market Observatory cycle. Reviewed entry and exit execution remain separated by payload section.

Database-heavy timers use deliberate offsets from the quarter-hour observatory write: paper exit review begins on minute 1, paper review on minute 3, the 0DTE engine near second 45, 0DTE exit review near second 55, and 0DTE reconciliation on minute 1 modulo 5 near second 30. The runner permits only the read-only 0DTE EOD task after a valid weekday session has closed; all other tasks retain the regular-session gate. Each oneshot service removes its task-specific transient `/tmp` lock in `ExecStopPost`, including after a forced stop or timeout.

```bash
sudo bash /home/alpaca/Alpaca-Trading/scripts/install-paper-monitoring-systemd.sh
systemctl list-timers 'alpaca-*' --no-pager
```

Disable:

```bash
sudo bash /home/alpaca/Alpaca-Trading/scripts/disable-paper-monitoring-systemd.sh
```

The monitor runner fails closed unless the runtime env remains paper-only and live-off. Execution services set
`AUTOMATED_PAPER_EXECUTION_ENABLED=true`, but the runner also requires `PAPER_ORDER_EXECUTION_ENABLED=true`,
`PAPER_OPTIONS_EXECUTION_ENABLED=true`, and the relevant executor's `--confirmPaper` boundary. The 0DTE
engine additionally requires `ZERO_DTE_ENGINE_ENABLED=true` and `ZERO_DTE_PAPER_EXECUTION_ENABLED=true`;
its exit-review, reconciliation, and end-of-day services set `AUTOMATED_PAPER_EXECUTION_ENABLED=false`.

`alpaca-universe-lifecycle.timer` is installed by the same monitoring installer.
It runs a bounded, non-broker-mutating discovery and lifecycle pass at 16:30 ET
on weekdays, after the intraday timer windows. The service has no execution
command or `--confirmPaper` path. It delegates historical-bar collection to
the 15-minute observatory, has a 120-second start deadline and 30-second stop
deadline, and uses control-group termination. `Persistent=false` intentionally
skips missed runs and resumes at the next daily window instead of replaying work
after reboot.

`alpaca-autonomous-recovery.timer` runs at minutes 07, 22, 37, and 52 and is
`Persistent=true` so a reboot receives one bounded local recovery pass. It only
marks stale local records terminal and writes immutable recovery events; it does
not call Alpaca, retry a job, clear locks, or submit orders. It handles stale
universe-lifecycle and learning-governance runs plus stale non-mutating
paper-operations records. The lifecycle service also starts it through
`OnFailure=` after a timeout or other service failure. A recovery never reruns
the interrupted workload: the next existing scheduler window remains the
automatic downstream consumer.

## Canonical autonomous scheduler graph

The monitoring installer owns every non-broker autonomous handoff: the
observatory, morning learning/research/review workflow, midday monitoring
workflow, late-day exit-review workflow, universe lifecycle, and recovery.
The paper-ops timers are therefore installed and disabled with the same
canonical script as the observatory and lifecycle units.

- `paper-ops-morning.timer`: 08:30 ET, before the observatory opens.
- `alpaca-market-observatory.timer`: every 15 minutes from 09:00 through 15:45 ET.
- `paper-ops-midday.timer`: 12:10 ET, after the 12:00 observatory deadline and
  the 12:07 recovery window.
- `paper-ops-late-day.timer`: 15:25 ET, after the 15:15 observatory deadline
  and the 15:22 recovery window.
- `alpaca-universe-lifecycle.timer`: 16:30 ET, after the intraday windows.

Midday and late-day paper-ops services also order behind observatory and
recovery when either is already active. This prevents database-heavy overlap
without changing broker, execution, or review behavior.

## Service operating guidance

- Run as `alpaca`.
- Read secrets from `/opt/alpaca-investing/secrets/alpaca.env`.
- Keep `LIVE_TRADING_ENABLED=false` and paper-only guardrails enabled unless explicitly changed.
- Keep `VPS_CONTROL_BIND_HOST=127.0.0.1` unless reverse proxy exposure is configured.
- `research.run` defaults to bounded control-action settings: `--barLookbackDays=120`,
  `ALPACA_REQUEST_TIMEOUT_MS=10000`, and `ALPACA_MAX_RETRIES=0`. Override only with
  `VPS_RESEARCH_REQUEST_TIMEOUT_MS` and `VPS_RESEARCH_MAX_RETRIES` when the public route has been retested.
- Preserve local paper scheduling, CLI runtime, and credentials ownership on the VPS.
- Stop the unit before changing deployment artifacts or security-relevant env values.

## Future unit pattern

Future units should:

- run as `alpaca`
- read secrets only from `/opt/alpaca-investing/secrets/alpaca.env`
- bind application services to localhost or a Docker internal network
- preserve `LIVE_TRADING_ENABLED=false` until the user explicitly requests live trading
- be stopped before changing secrets or deployment artifacts
