# Dashboard Control API (VPS)

This service exposes a fixed, allowlisted HTTP API used by the Vercel dashboard.

Run target:

- `GET /api/v1/health`
- `GET /api/v1/account`
- `GET /api/v1/positions`
- `GET /api/v1/orders`
- `GET /api/v1/research/latest`
- `GET /api/v1/review/latest`
- `GET /api/v1/plan/latest`
- `GET /api/v1/executions`
- `GET /api/v1/summary`
- `GET /api/v1/execute/dry-run/latest`
- `POST /api/v1/research/run`
- `POST /api/v1/review/run`
- `POST /api/v1/plan/run`
- `POST /api/v1/execute/dry-run`
- `POST /api/v1/execute/confirm`
- `POST /api/v1/refresh`

Admin POST actions require `Authorization: Bearer <VPS_CONTROL_TOKEN>` and fixed allowlist scripts.
`POST /api/v1/refresh` is a read-only runtime refresh that runs `paper:runtime`.
Guarded submit actions return structured safety-guard details when execution flags are disabled.

Run locally (paper-mode checks still apply):

```bash
VPS_CONTROL_TOKEN=replace_me \
VPS_CONTROL_BIND_HOST=127.0.0.1 \
VPS_CONTROL_PORT=4100 \
VPS_CONTROL_AUDIT_PATH=/opt/alpaca-investing/logs/dashboard-control-audit.jsonl \
npm run dashboard:control
```

The handler enforces paper-safe guards before mutation commands and writes a JSONL audit trail if
`VPS_CONTROL_AUDIT_PATH` is set.
