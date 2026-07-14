#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash scripts/disable-paper-monitoring-systemd.sh" >&2
  exit 1
fi

systemctl disable --now \
  alpaca-market-observatory.timer \
  alpaca-universe-lifecycle.timer \
  alpaca-paper-review.timer \
  alpaca-paper-execute.timer \
  alpaca-paper-exit-review.timer \
  alpaca-paper-exit-execute.timer \
  alpaca-zero-dte-engine.timer \
  alpaca-zero-dte-exit-review.timer \
  alpaca-zero-dte-reconcile.timer \
  alpaca-zero-dte-eod.timer

systemctl daemon-reload
systemctl list-timers 'alpaca-*' --no-pager || true
