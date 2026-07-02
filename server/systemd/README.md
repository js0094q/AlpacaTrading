# systemd Units

No application services are installed in this phase.

Future units should:

- run as `alpaca`
- read secrets only from `/opt/alpaca-investing/secrets/alpaca.env`
- bind application services to localhost or a Docker internal network
- preserve `LIVE_TRADING_ENABLED=false` until the user explicitly requests live trading
- be stopped before changing secrets or deployment artifacts
