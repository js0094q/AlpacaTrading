# Paper Monitoring Operations

This repo has two VPS scheduling layers:

- `paper-ops-*` timers: legacy review-only scheduled workflows. They keep `AUTOMATED_PAPER_EXECUTION_ENABLED=false`.
- `alpaca-paper-*` timers: continuous paper-market monitor timers for reviewed buy/add/open execution and reviewed sell/sell-to-close exits.

## Existing VPS Automation Check

Use redacted, read-only checks only:

```bash
cd /home/alpaca/Alpaca-Trading
git rev-parse --short HEAD
git status --short
systemctl list-units --type=service --all | grep -iE 'alpaca|paper|trade|research|monitor|exit' || true
systemctl list-timers --all | grep -iE 'alpaca|paper|trade|research|monitor|exit' || true
crontab -l || true
sudo crontab -l || true
pm2 list || true
ps aux | grep -iE 'alpaca|paper|trade|research|monitor|node|tsx|npm' | grep -v grep || true
```

Do not print `/opt/alpaca-investing/secrets/alpaca.env`.

## Monitor Timers

- `alpaca-market-observatory.timer`: wakes every 15 minutes on weekdays during
  regular market-hour windows. It runs `npm run paper:monitor -- --task=observatory`
  through a dedicated lock, performs a second Alpaca market-clock check, and is
  broker-read-only.
- `alpaca-paper-review.timer`: wakes every 30 minutes on weekdays during regular market-hour windows. Runs `npm run paper:monitor -- --task=review`, which executes `paper:ops:morning` after market-hours gating.
- `alpaca-paper-execute.timer`: wakes five minutes after review windows. Runs reviewed entry execution only for `equityBuys`, `equityAdds`, and `optionBuys`.
- `alpaca-paper-exit-review.timer`: wakes every 15 minutes during regular windows and every 5 minutes in the final hour. It evaluates equity exits, generic option exits, LEAPS sell discipline, and in the final hour uses `paper:ops:late-day` so 0DTE late-day exit review is active. Late day persists a fresh signed `sourceAction=paper.ops.late_day` artifact with the normal 30-minute TTL.
- `alpaca-paper-exit-execute.timer`: wakes after exit review windows. Runs reviewed exit execution only for `equitySells` and `optionSellToCloseExits`.

The database-heavy timers are offset from the quarter-hour observatory write: exit review starts on minute 1, review on minute 3, the 0DTE engine near second 45, 0DTE exit review near second 55, and 0DTE reconciliation on minute 1 modulo 5 near second 30. SQLite connections use a 60-second busy timeout for residual transient writer contention.

Monitor tasks no-op with `MARKET_CLOSED` outside regular market hours,
weekends, and configured US market holidays, except that the read-only `zero-dte-eod` task may run after a valid weekday session closes. Observatory validation must account
for all 51 symbols. Bounded symbol failures produce `PARTIAL` with structured
reasons; silent omissions or systemic failures are deployment failures.

## Guardrails

The runner blocks execution unless all are true:

```text
ALPACA_ENV=paper
TRADING_MODE=paper
ALPACA_LIVE_TRADE=false
LIVE_TRADING_ENABLED=false
PAPER_ORDER_EXECUTION_ENABLED=true
PAPER_OPTIONS_EXECUTION_ENABLED=true
AUTOMATED_PAPER_EXECUTION_ENABLED=true
PAPER_REVIEW_SIGNING_KEY=<present only in the VPS secret file>
```

Execution commands always include `--confirmPaper` and use
`paper:execute:reviewed`. The executor verifies the canonical HMAC-signed
artifact and `baseline-v1` state, refreshes paper account, position, order,
reservation, market, and cap evidence, and refuses missing, unsigned, stale,
empty, tampered, duplicate, or materially drifted entries. A
`FRESH_REVIEW_REQUIRED` result submits zero for the entry and requires a new
review; execution never resizes or rebuilds the plan inline.

`paper:execute --confirmPaper`, `/api/v1/execute/confirm`, and the dashboard
confirm route are compatibility surfaces for this exact reviewed executor.
They require explicit confirmation and never create it implicitly. Exit-only
sections retain independent safety validation and are not blocked merely by a
lack of positive entry capacity.

0DTE also requires complete New York-day broker/ledger/trade/outcome counters
and a persisted signed submit attestation. Open entry orders consume the same
three-exposure limit as open 0DTE positions. Hedge entries use their independent
signed review plus complete current/reserved/daily/open-order evidence and
reapply the `0.0075`, `0.02`, and `0.01` equity-premium ratios at submit time.

LEAPS sell-to-close payloads use the same `optionSellToCloseExits` section. The reviewed executor also blocks LEAPS exits unless `AUTOMATED_PAPER_EXECUTION_ENABLED=true`; review-only LEAPS warnings and liquidity-blocked LEAPS hard exits do not create executable payloads.

The runner uses separate lock files under `/tmp` for review, entry execution, exit review, and exit execution. If a prior run is still active, the next wakeup no-ops with `LOCK_BUSY`. Each systemd oneshot removes only its own transient lock in `ExecStopPost`, including after an operator stop or timeout, so a terminated run cannot permanently suppress later cycles.

## Install

After local validation and a VPS fast-forward:

```bash
sudo bash scripts/install-paper-monitoring-systemd.sh
systemctl list-timers 'alpaca-paper-*' --no-pager
```

Disable:

```bash
sudo bash scripts/disable-paper-monitoring-systemd.sh
```

Manual safe validation:

```bash
npm run paper:monitor -- --task=observatory --dry-run
npm run paper:monitor -- --task=review --dry-run
npm run paper:monitor -- --task=execute --dry-run
npm run paper:monitor -- --task=exit-review --dry-run
npm run paper:monitor -- --task=exit-execute --dry-run
npm run paper:review -- --riskProfile=aggressive --optionsEnabled=true --format=json
npm run db:verify -- --database /path/to/research.db
```

When a naturally filled position has exact lineage, inspect it with
`npm run paper:trace -- --decisionId <uuid>`. Do not submit a paper order merely to
create trace evidence.

Do not manually run `paper:execute:reviewed -- --confirmPaper` or `paper:execute -- --confirmPaper` unless paper execution is explicitly approved.

For a signing-key cutover, stop affected services/timers before editing the VPS
secret file, preserve `alpaca:alpaca` mode `0600`, report only key presence or a
SHA-256 fingerprint, then create a new artifact with the review-only
`npm run paper:ops:review -- --format=json`. Unsigned legacy artifacts are
intentionally non-executable. This safety floor does not introduce an adaptive
allocator or change any sizing cap.
