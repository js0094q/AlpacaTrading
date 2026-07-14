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
- `alpaca-paper-exit-review.timer`: wakes every 15 minutes during regular windows and every 5 minutes in the final hour. It evaluates equity exits, generic option exits, LEAPS sell discipline, and in the final hour uses `paper:ops:late-day` so 0DTE late-day exit review is active.
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
```

Execution commands always include `--confirmPaper` and use `paper:execute:reviewed`, which refuses missing, stale, empty, duplicate, or payload-signature-mismatched reviewed artifacts before paper submission.

LEAPS sell-to-close payloads use the same `optionSellToCloseExits` section. The reviewed executor also blocks LEAPS exits unless `AUTOMATED_PAPER_EXECUTION_ENABLED=true`; review-only LEAPS warnings and liquidity-blocked LEAPS hard exits do not create executable payloads.

The runner uses separate lock files under `/tmp` for review, entry execution, exit review, and exit execution. If a prior run is still active, the next wakeup no-ops with `LOCK_BUSY`.

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
