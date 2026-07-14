#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash scripts/install-paper-monitoring-systemd.sh" >&2
  exit 1
fi

REPO_DIR="/home/alpaca/Alpaca-Trading"
ENV_FILE="/opt/alpaca-investing/secrets/alpaca.env"
UNIT_SRC="${REPO_DIR}/server/systemd"
UNIT_DEST="/etc/systemd/system"

units=(
  alpaca-market-observatory.service
  alpaca-market-observatory.timer
  paper-ops-morning.service
  paper-ops-morning.timer
  paper-ops-midday.service
  paper-ops-midday.timer
  paper-ops-late-day.service
  paper-ops-late-day.timer
  alpaca-universe-lifecycle.service
  alpaca-universe-lifecycle.timer
  alpaca-autonomous-recovery.service
  alpaca-autonomous-recovery.timer
  alpaca-paper-review.service
  alpaca-paper-review.timer
  alpaca-paper-execute.service
  alpaca-paper-execute.timer
  alpaca-paper-exit-review.service
  alpaca-paper-exit-review.timer
  alpaca-paper-exit-execute.service
  alpaca-paper-exit-execute.timer
  alpaca-zero-dte-engine.service
  alpaca-zero-dte-engine.timer
  alpaca-zero-dte-exit-review.service
  alpaca-zero-dte-exit-review.timer
  alpaca-zero-dte-reconcile.service
  alpaca-zero-dte-reconcile.timer
  alpaca-zero-dte-eod.service
  alpaca-zero-dte-eod.timer
)

if [[ ! -d "${REPO_DIR}" ]]; then
  echo "Repository not found: ${REPO_DIR}" >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Runtime env file missing: ${ENV_FILE}" >&2
  exit 1
fi

install -d -m 0755 "${UNIT_DEST}"
for unit in "${units[@]}"; do
  install -m 0644 "${UNIT_SRC}/${unit}" "${UNIT_DEST}/${unit}"
done

systemd-analyze verify "${units[@]/#/${UNIT_DEST}/}"
systemctl daemon-reload
systemctl enable --now \
  alpaca-market-observatory.timer \
  paper-ops-morning.timer \
  paper-ops-midday.timer \
  paper-ops-late-day.timer \
  alpaca-universe-lifecycle.timer \
  alpaca-autonomous-recovery.timer \
  alpaca-paper-review.timer \
  alpaca-paper-execute.timer \
  alpaca-paper-exit-review.timer \
  alpaca-paper-exit-execute.timer \
  alpaca-zero-dte-engine.timer \
  alpaca-zero-dte-exit-review.timer \
  alpaca-zero-dte-reconcile.timer \
  alpaca-zero-dte-eod.timer

systemctl list-timers 'alpaca-*' --no-pager
