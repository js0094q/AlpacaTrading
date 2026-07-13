#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash scripts/disable-paper-monitoring-systemd.sh" >&2
  exit 1
fi

systemctl disable --now \
  alpaca-market-observatory.timer \
  alpaca-paper-review.timer \
  alpaca-paper-execute.timer \
  alpaca-paper-exit-review.timer \
  alpaca-paper-exit-execute.timer

systemctl daemon-reload
systemctl list-timers 'alpaca-*' --no-pager || true
