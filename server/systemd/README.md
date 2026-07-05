# systemd Units

Systemd unit templates for future app services live in this directory.

The repository now includes a paper control service template for the VPS dashboard control API:

- `dashboard-control.service` — runs `server/dashboard-control/server.ts` as `alpaca` using `.env` from
  `/opt/alpaca-investing/secrets/alpaca.env`.

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
