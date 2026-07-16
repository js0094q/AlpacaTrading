# Resume Context: Alpaca Investing Server Provisioning

## Neon migration Release 4 staged-cutover prerequisite (2026-07-16)

- Deploy the Release 4 implementation before changing authority flags. It
  reuses PostgreSQL migrations 1 and 2 and adds no migration 3.
- Keep all PostgreSQL authority flags disabled through deployment verification.
  Then enable reads, writes, and shadow together as a non-authoritative stage;
  SQLite remains authoritative until reconciliation passes.
- Control-plane authority precedes scheduler authority. Scheduler authority may
  advance only after all 14 approved timers prove lease, heartbeat, release,
  expiry recovery, monotonic fencing, and stale-write rejection.
- Backfill and reconcile execution state before enabling its shadow or authority
  flags. Retire authoritative SQLite writes only after the final paper-only
  concurrency gate; live trading remains disabled throughout.

## Neon migration Release 3 VPS next step (2026-07-15)

- Deploy Release 3 code with every PostgreSQL authority flag off. Run direct
  migration twice and verify schema version 2, 23 tables, 59 indexes, and the
  Release 3 columns/constraints before any backfill.
- Quiesce affected SQLite writers, verify no worker remains, and create the
  timestamped mode-`0400` control-plane snapshot. Preserve its checksum,
  integrity, foreign-key, and table-count report; never alter the source.
- Backfill and reconcile through the direct Neon endpoint. Any unexplained
  discrepancy blocks shadow and authority. Candidate lifecycle maps only
  candidate-linked decision events; non-candidate lifecycle is Release 4.
- Run paper-only shadow mode with SQLite authoritative before enabling
  `POSTGRES_CONTROL_PLANE_AUTHORITY_ENABLED=true`. Keep
  `POSTGRES_EXECUTION_STATE_AUTHORITY_ENABLED=false` throughout Release 3.
- Only research may use PostgreSQL fencing after the Release 3 cutover.
  Observatory, market-data-refresh, and execution-state timers remain
  SQLite-owned until their durable writes validate the current fencing token.
  PostgreSQL authority has no SQLite fallback; the temporary audit mirror is a
  compatibility projection only.

## Neon migration Release 2 VPS next step (2026-07-15)

- Release 2 adds the non-authoritative PostgreSQL client and explicit migration
  commands. The Neon schema was validated locally before VPS installation.
- Install only `DATABASE_URL` and `DATABASE_URL_UNPOOLED` in the existing
  protected environment file using `scripts/manage-postgres-env.mjs`; preserve
  unrelated values, owner, and mode and create a mode-`0400` backup.
- Keep `DATABASE_BACKEND=sqlite` and every PostgreSQL read/write/shadow/authority
  flag false. Restart only `alpaca-dashboard-control.service`, run redacted
  pooled/direct connectivity, and confirm journald contains no credential
  material. Scheduler timers remain SQLite-owned until Release 3 passes.

## Neon migration Release 1 VPS evidence (2026-07-15)

- VPS, GitHub main, and Vercel production were reverified at
  `8cc9fe8431e3676b96a3a904a1256d4aa2dcf21b` before Release 1 validation.
- The runtime remained paper-only with live execution disabled. Five active
  timers and dashboard control were captured, quiesced, and restored; no
  scheduled service was active during the successful copy test.
- A checksum-identical, mode-`0400` protected database backup was created only
  after zero Node workers and a stable source checksum were verified. A first
  weaker quiesce attempt failed the checksum gate and stopped before WAL
  mutation, which is why future snapshot procedures must verify worker absence
  and source stability rather than relying on timer state alone.
- The Btrfs/RBD copied database passed WAL mechanics, FULL-synchronous commit,
  checkpoint, SQLite online backup, committed/uncommitted SIGKILL recovery,
  integrity, foreign keys, two explicit migration runs, and schema verification.
  The source remained DELETE mode and unchanged during the successful test.
- Keep production on DELETE for Release 1 because current deployment/backup
  procedures are not WAL-sidecar aware. No Neon credentials have been installed
  on the VPS yet; that is a gated Release 2/3 action.

## Paper runtime contention deployment handoff (2026-07-15)

- Stop the control service and affected SQLite writer timers before cutover;
  record their prior enabled/active state and preserve all paper/live flags.
- Back up the production database, run `db:migrate` twice against a copy, run
  `db:verify`, compare legacy row counts, and check integrity/foreign keys.
- Run production `db:migrate` exactly once before restarting affected services.
  Ordinary commands now fail with `DATABASE_MIGRATION_REQUIRED` instead of
  applying pending schema changes.
- After restart, run `system:recover` first. Confirm the pre-existing stale
  `research_runs` row is `failed` with
  `WORKER_TERMINATED_OR_HEARTBEAT_EXPIRED` and one immutable recovery event.
- Validate one guarded research request and one duplicate request; the duplicate
  must return `already_running` without a second worker. Validate read-only 0DTE
  discovery only. Do not run a confirmed executor or submit any order.
- Health commands use a 9-second shared account/clock budget within the
  10-second control deadline. Structured child errors remain primary over Node
  warnings.

## Adaptive allocation safety-floor pre-deploy handoff (2026-07-14)

- A redacted, read-only VPS check found `/home/alpaca/Alpaca-Trading` clean at
  `29f4a814d39cebc6f66b371571a92fe58228f6e1` before this release.
- Runtime flags remain `ALPACA_ENV=paper`, `TRADING_MODE=paper`,
  `ALPACA_LIVE_TRADE=false`, and `LIVE_TRADING_ENABLED=false`.
  `PAPER_ORDER_EXECUTION_ENABLED`, `PAPER_OPTIONS_EXECUTION_ENABLED`, and
  `AUTOMATED_PAPER_EXECUTION_ENABLED` are present, but no order was submitted
  during implementation or pre-deploy inspection.
- None of the selected equity, plan, scale-in, 0DTE, or hedge sizing variables
  was installed, so checked-in defaults were runtime-effective: `$1,000`
  ordinary equity notional, `$5,000` per-order cap, `$50,000` total-plan cap,
  `$250` scale-in when explicitly enabled, unchanged 0DTE caps, and hedge
  ratios `0.0075`, `0.02`, and `0.01` of equity. The objective's
  `$100`/`$300` figures were not installed or adopted.
- `PAPER_REVIEW_SIGNING_KEY` was absent. Provision or preserve a random value
  in `/opt/alpaca-investing/secrets/alpaca.env` without printing it, keep
  `alpaca:alpaca` mode `0600`, and report only presence/fingerprint before
  restarting affected services. It must not be added to Vercel.
- The deployed cutover invalidates unsigned general review artifacts. Generate
  a new signed `baseline-v1` artifact with the review-only
  `paper:ops:review`. Compatibility confirm routes then dispatch reviewed
  execution only; `FRESH_REVIEW_REQUIRED` means regenerate the review, not
  resize or rebuild inline.
- The safety floor stops before adaptive-allocation Release 1. It adds no live
  path, allocator, cap increase, public mutation route, or allocator-owned exit.

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
  - `GET /api/v1/summary` returns cached/read-only dashboard state and does not dispatch fresh plan, review, or dry-run commands.
  - Public `POST /api/paper/research/run` was verified through `https://www.jlsprojects.com` with valid admin auth.
  - The branch now defines cached GET-only hedge routes at `/api/v1/hedge/risk`, `/api/v1/hedge/regime`, and `/api/v1/hedge/recommendation`; this task did not deploy them.
  - Hedge routes read the latest integrity-checked `paper_learning_records` payload and never dispatch commands or order fetches.
- Optional stock streaming:
  - `server/dashboard-control/server.ts` starts the singleton SIP stock stream only when `ALPACA_STOCK_STREAM_ENABLED=true` and stops it on `SIGINT`/`SIGTERM`.
  - With no explicit `ALPACA_STOCK_STREAM_SYMBOLS`, the stream receives the current active stock universe; the configured stream URL remains `wss://stream.data.alpaca.markets/v2/sip`.
  - `/api/v1/health` includes sanitized `data.stockStream` health, and current equity-price reads prefer fresh stream trade/quote state before falling back to SIP REST; historical bars and complete snapshots remain REST-backed.
  - `npm run smoke:alpaca-stream` is a read-only AAPL authentication/subscription check and never submits orders.
- Paper monitor behavior:
  - Market Observatory Phase 1A adds `alpaca-market-observatory.service` and
    `.timer` to the checked-in monitor installer. The read-only collector uses a
    dedicated lock, wakes every 15 minutes during weekday market windows, checks
    the Alpaca clock again, and cannot submit orders. This branch has not been
    deployed, so the units are not asserted active on the VPS.
  - Exit review now evaluates LEAPS positions through the existing `optionSellToCloseExits` reviewed section; no separate LEAPS timer or execution command is required.
  - Reviewed LEAPS sell-to-close execution fails closed unless paper runtime, live-off, paper execution, paper options execution, automated execution, and `--confirmPaper` gates are all satisfied.
  - Existing paper-ops review moments may refresh hedge recommendations; authenticated hedge review/entry/exit routes are bounded by the VPS control allowlist and paper-only gates.
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
   - `refresh` is a read-only runtime refresh and should run `paper:runtime` without order execution or mutating precheck.

## Do-not-break requirements

- Preserve paper-only guardrails (`ALPACA_ENV=paper`, `LIVE_TRADING_ENABLED=false`) on all runs.
- Keep `HEDGE_LIVE_EXECUTION_ENABLED=false` and `MULTI_LEG_HEDGE_EXECUTION_ENABLED=false`; hedge plans remain signed and expiring, while the separate reviewed executor is paper-only and single-leg.
- Keep `PAPER_REVIEW_SIGNING_KEY` VPS-only. General reviews and 0DTE submit
  attestations fail closed when it is absent, and unsigned legacy artifacts
  must never be grandfathered.
- Keep paper execution operationally enabled only through the guarded paper path (`PAPER_ORDER_EXECUTION_ENABLED=true`, `PAPER_OPTIONS_EXECUTION_ENABLED=true`, valid control/admin auth, and CLI `--confirmPaper`).
- Continuous paper monitor timers are installed with `scripts/install-paper-monitoring-systemd.sh`; they use `npm run paper:monitor`, reviewed payload artifacts, section filters, market-hours no-ops, and per-task locks.
- Do not add direct shell command execution in dashboard actions; keep allowlisted control endpoints only.
- Do not configure direct client-side Alpaca credentials or local SQLite writes on Vercel.
- Preserve option quote execution gates: stale/missing/crossed quotes and same-day expirations are non-executable unless explicitly enabled by runtime env.
