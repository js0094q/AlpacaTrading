# systemd units

## Current service boundary

PostgreSQL is the sole production runtime authority. During the fresh authority
cutover, start only `alpaca-dashboard-control.service`. Keep the autonomous
worker and every paper, research, observatory, recovery, universe, and 0DTE timer
stopped and disabled pending the separate evidence-utilization and runtime audit.

Historical timer templates remain in this directory as deployment evidence,
but production command gating rejects their application paths with
`POSTGRES_ONLY_RUNTIME_PATH_DISABLED`. They must not be installed or enabled as
part of this cutover.

## Dashboard-control installation

Use this only after the exact validated commit is checked out, dependencies are
installed, PostgreSQL schema verification passes, and the fresh authority
checkpoint is passed:

```bash
sudo install -d -m 755 /opt/alpaca-investing/systemd
sudo install -m 644 \
  /home/alpaca/Alpaca-Trading/server/systemd/dashboard-control.service \
  /etc/systemd/system/alpaca-dashboard-control.service
sudo systemctl daemon-reload
sudo systemctl enable --now alpaca-dashboard-control.service
sudo systemctl status alpaca-dashboard-control.service --no-pager
```

The unit hardcodes the PostgreSQL-only authority flags and binds to
`127.0.0.1`. Its API is read-only. Authenticated mutation routes fail closed and
never invoke legacy CLI workflows.

Verify authenticated local health without displaying the token:

```bash
curl -fsS -H "Authorization: Bearer $VPS_CONTROL_TOKEN" \
  http://127.0.0.1:4100/api/v1/health
```

## Autonomous-worker hold

The autonomous worker unit hardcodes:

```text
DATABASE_BACKEND=postgres
POSTGRES_SHADOW_COMPARE_ENABLED=false
POSTGRES_EXECUTION_STATE_SHADOW_ENABLED=false
SQLITE_AUDIT_MIRROR_ENABLED=false
AUTONOMOUS_RUNTIME_AUDIT_APPROVED=false
```

The worker and monitor runner require full PostgreSQL authority and then fail
closed while `AUTONOMOUS_RUNTIME_AUDIT_APPROVED=false`. Keep the service and its
timer disabled:

```bash
sudo systemctl disable --now alpaca-autonomous-paper.service 2>/dev/null || true
sudo systemctl disable --now alpaca-autonomous-paper.timer 2>/dev/null || true
sudo bash /home/alpaca/Alpaca-Trading/scripts/disable-paper-monitoring-systemd.sh
```

Do not change the audit approval flag during this cutover.

## Deployment verification

Verify all of the following without printing secrets:

- repository checkout is clean and equals the validated commit;
- `ALPACA_ENV=paper` and `TRADING_MODE=paper`;
- `ALPACA_LIVE_TRADE=false` and `LIVE_TRADING_ENABLED=false`;
- PostgreSQL reads/writes and all three authority flags are true;
- both shadow flags and `SQLITE_AUDIT_MIRROR_ENABLED` are false;
- pooled PostgreSQL connectivity succeeds repeatedly;
- `db:postgres:authority:status` reports a passed
  `fresh_postgresql_authority_cutover` checkpoint;
- dashboard-control is active;
- autonomous worker and all trading/research timers are inactive;
- no application SQLite database is open;
- no migration, backfill, or reconciliation process is active;
- the cutover submitted zero orders.

## Security boundary

- Run the application as `alpaca`.
- Read secrets only from `/opt/alpaca-investing/secrets/alpaca.env` with mode
  `0600` and owner `alpaca:alpaca`.
- Keep `VPS_CONTROL_BIND_HOST=127.0.0.1`.
- Do not display database URLs, broker keys, signing keys, or control tokens.
- Stop dashboard-control before changing deployment artifacts or environment
  values.
