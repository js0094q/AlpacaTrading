#!/usr/bin/env bash
set -Eeuo pipefail

SSH_SNIPPET="/etc/ssh/sshd_config.d/99-alpaca-hardening.conf"
FAIL2BAN_JAIL="/etc/fail2ban/jail.d/sshd.local"
BACKUP_ROOT="/root/alpaca-hardening-backups"
APP_USER="${APP_USER:-alpaca}"

log() {
  printf '[hardening] %s\n' "$*"
}

fail() {
  printf '[hardening] ERROR: %s\n' "$*" >&2
  exit 1
}

require_root() {
  if [ "${EUID}" -ne 0 ]; then
    fail "Run as root or with sudo: sudo bash server/hardening.sh"
  fi
}

check_tracked_secret_patterns() {
  if ! command -v git >/dev/null 2>&1; then
    return 0
  fi

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi

  local matches
  matches="$(
    git grep -I -l -E '((PK|AK)[A-Z0-9]{16,}|(ALPACA|APCA)[A-Z0-9_]*(KEY|SECRET)[A-Z0-9_]*[[:space:]]*=[[:space:]]*[^[:space:]#]{12,})' -- . 2>/dev/null || true
  )"

  if [ -n "${matches}" ]; then
    printf '%s\n' "${matches}" >&2
    fail "Refusing to proceed because tracked files contain Alpaca key-like values. File names only are shown above."
  fi
}

backup_ssh_config() {
  local stamp backup_dir
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_dir="${BACKUP_ROOT}/${stamp}"
  install -d -m 0700 "${backup_dir}"

  cp -a /etc/ssh/sshd_config "${backup_dir}/sshd_config"
  if [ -d /etc/ssh/sshd_config.d ]; then
    cp -a /etc/ssh/sshd_config.d "${backup_dir}/sshd_config.d"
  fi

  printf '%s\n' "${backup_dir}"
}

ensure_non_root_key_access() {
  local ssh_dir="/home/${APP_USER}/.ssh"
  local authorized_keys="${ssh_dir}/authorized_keys"

  if ! id "${APP_USER}" >/dev/null 2>&1; then
    fail "User ${APP_USER} does not exist. Run bootstrap.sh before hardening.sh."
  fi

  if [ ! -s "${authorized_keys}" ]; then
    fail "No public keys found at ${authorized_keys}. Add a key for ${APP_USER} before disabling root/password SSH."
  fi

  chown "${APP_USER}:${APP_USER}" "${ssh_dir}" "${authorized_keys}"
  chmod 0700 "${ssh_dir}"
  chmod 0600 "${authorized_keys}"
  log "Verified ${APP_USER} has key-based SSH material before root login is disabled"
}

require_operator_ssh_confirmation() {
  if [ "${ALPACA_CONFIRMED_ALPACA_SSH:-0}" = "1" ]; then
    log "Operator confirmation provided by ALPACA_CONFIRMED_ALPACA_SSH=1"
    return 0
  fi

  if [ ! -t 0 ]; then
    fail "Refusing non-interactive SSH hardening. First test 'ssh ${APP_USER}@<server-ip>', then rerun with ALPACA_CONFIRMED_ALPACA_SSH=1."
  fi

  printf '\n'
  log "Before root/password SSH is disabled, open a second terminal and verify key-based login works:"
  printf '  ssh %s@<server-ip>\n' "${APP_USER}"
  printf "Type I_HAVE_TESTED_ALPACA_SSH to continue: "

  local confirmation
  read -r confirmation

  if [ "${confirmation}" != "I_HAVE_TESTED_ALPACA_SSH" ]; then
    fail "Operator did not confirm a tested ${APP_USER} SSH session. SSH hardening was not applied."
  fi
}

ensure_sshd_include() {
  local backup_dir="$1"

  install -d -m 0755 /etc/ssh/sshd_config.d

  if grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config; then
    return 0
  fi

  log "Adding Include /etc/ssh/sshd_config.d/*.conf to /etc/ssh/sshd_config"
  cp -a /etc/ssh/sshd_config "${backup_dir}/sshd_config.before-include"
  sed -i '1iInclude /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
}

write_ssh_hardening_snippet() {
  log "Writing SSH hardening snippet to ${SSH_SNIPPET}"
  cat >"${SSH_SNIPPET}" <<'SSHCONF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
X11Forwarding no
AllowTcpForwarding no
ClientAliveInterval 300
ClientAliveCountMax 2
MaxAuthTries 3
SSHCONF
  chmod 0644 "${SSH_SNIPPET}"
}

restore_ssh_config() {
  local backup_dir="$1"

  cp -a "${backup_dir}/sshd_config" /etc/ssh/sshd_config
  if [ -f "${backup_dir}/sshd_config.d/99-alpaca-hardening.conf" ]; then
    cp -a "${backup_dir}/sshd_config.d/99-alpaca-hardening.conf" "${SSH_SNIPPET}"
  else
    rm -f "${SSH_SNIPPET}"
  fi
}

require_effective_ssh_setting() {
  local effective_config="$1"
  local key="$2"
  local expected="$3"

  printf '%s\n' "${effective_config}" | grep -Eq "^${key}[[:space:]]+${expected}$"
}

validate_effective_ssh_hardening() {
  local effective_config
  effective_config="$(sshd -T)"

  local failed=0
  local required_settings=(
    "permitrootlogin no"
    "passwordauthentication no"
    "kbdinteractiveauthentication no"
    "pubkeyauthentication yes"
    "x11forwarding no"
    "allowtcpforwarding no"
    "clientaliveinterval 300"
    "clientalivecountmax 2"
    "maxauthtries 3"
  )

  local setting key expected
  for setting in "${required_settings[@]}"; do
    key="${setting%% *}"
    expected="${setting#* }"
    if ! require_effective_ssh_setting "${effective_config}" "${key}" "${expected}"; then
      printf '[hardening] Effective SSH setting mismatch: expected %s %s\n' "${key}" "${expected}" >&2
      failed=1
    fi
  done

  return "${failed}"
}

validate_and_restart_ssh() {
  local backup_dir="$1"

  log "Validating SSH configuration with sshd -t"
  if ! sshd -t; then
    log "SSH validation failed; restoring SSH config from backup"
    restore_ssh_config "${backup_dir}"
    sshd -t || true
    fail "SSH hardening was not applied because sshd -t failed"
  fi

  log "Validating effective SSH hardening with sshd -T"
  if ! validate_effective_ssh_hardening; then
    log "Effective SSH hardening validation failed; restoring SSH config from backup"
    restore_ssh_config "${backup_dir}"
    sshd -t || true
    fail "SSH hardening was not applied because required settings were not effective"
  fi

  printf '\n'
  log "WARNING: Keep this SSH session open. Test a second key-based SSH session before logging out."
  log "Restarting SSH because validation passed"

  if systemctl list-unit-files ssh.service >/dev/null 2>&1; then
    systemctl restart ssh
  else
    systemctl restart sshd
  fi
}

configure_ufw() {
  log "Configuring UFW with default-deny inbound and SSH allowed"
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow OpenSSH
  ufw --force enable
  ufw status verbose
}

configure_fail2ban() {
  log "Configuring fail2ban SSH jail"
  install -d -m 0755 /etc/fail2ban/jail.d
  cat >"${FAIL2BAN_JAIL}" <<'JAIL'
[sshd]
enabled = true
port = ssh
filter = sshd
logpath = %(sshd_log)s
maxretry = 5
findtime = 10m
bantime = 1h
JAIL

  systemctl enable --now fail2ban
  systemctl restart fail2ban
  fail2ban-client status sshd
}

main() {
  require_root
  check_tracked_secret_patterns

  local backup_dir
  backup_dir="$(backup_ssh_config)"
  log "Backed up SSH config to ${backup_dir}"
  ensure_non_root_key_access
  require_operator_ssh_confirmation
  ensure_sshd_include "${backup_dir}"
  write_ssh_hardening_snippet
  validate_and_restart_ssh "${backup_dir}"
  configure_ufw
  configure_fail2ban

  log "Hardening complete. Keep the current SSH session open until a second key-based SSH session succeeds."
}

main "$@"
