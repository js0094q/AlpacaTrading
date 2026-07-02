#!/usr/bin/env bash
set -uo pipefail

APP_ROOT="${APP_ROOT:-/opt/alpaca-investing}"
APP_USER="${APP_USER:-alpaca}"
SSH_SNIPPET="/etc/ssh/sshd_config.d/99-alpaca-hardening.conf"
DOCKER_STATUS_FILE="${APP_ROOT}/docker-status"

PASS_COUNT=0
FAIL_COUNT=0
INFO_COUNT=0

if [ "${EUID}" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '[PASS] %s\n' "$*"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf '[FAIL] %s\n' "$*"
}

info() {
  INFO_COUNT=$((INFO_COUNT + 1))
  printf '[INFO] %s\n' "$*"
}

check() {
  local label="$1"
  shift

  if "$@" >/dev/null 2>&1; then
    pass "${label}"
  else
    fail "${label}"
  fi
}

check_contains() {
  local label="$1"
  local command_output="$2"
  local pattern="$3"

  if printf '%s\n' "${command_output}" | grep -Eq "${pattern}"; then
    pass "${label}"
  else
    fail "${label}"
  fi
}

check_effective_ssh_setting() {
  local effective_config="$1"
  local key="$2"
  local expected="$3"

  if printf '%s\n' "${effective_config}" | grep -Eq "^${key}[[:space:]]+${expected}$"; then
    pass "effective SSH setting ${key} ${expected}"
  else
    fail "effective SSH setting ${key} ${expected}"
  fi
}

get_effective_ssh_config() {
  if [ -n "${SUDO}" ]; then
    sudo sshd -T 2>/dev/null
  else
    sshd -T 2>/dev/null
  fi
}

tracked_secret_matches() {
  if ! command -v git >/dev/null 2>&1; then
    return 1
  fi

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 1
  fi

  git grep -I -l -E '((PK|AK)[A-Z0-9]{16,}|(ALPACA|APCA)[A-Z0-9_]*(KEY|SECRET)[A-Z0-9_]*[[:space:]]*=[[:space:]]*[^[:space:]#]{12,})' -- . 2>/dev/null
}

tracked_real_env_files() {
  if ! command -v git >/dev/null 2>&1; then
    return 1
  fi

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 1
  fi

  git ls-files | grep -E '(^|/)(\.env|[^/]+\.env)$|(^|/)\.env\.[^/]+$|(^|/)[^/]+\.env\.[^/]+$' | grep -Ev '(^|/)\.env\.example$|(^|/)[^/]+\.env\.example$'
}

check_public_listeners() {
  if ! command -v ss >/dev/null 2>&1; then
    fail "ss command is available for listener inspection"
    return
  fi

  local reverse_proxy_ports_allowed="0"
  if [ "${ALLOW_REVERSE_PROXY_PORTS:-0}" = "1" ] || systemctl is-active --quiet caddy 2>/dev/null; then
    reverse_proxy_ports_allowed="1"
  fi

  local offenders
  offenders="$(
    ss -tlnH | awk '{print $4}' | while read -r local_addr; do
      port="${local_addr##*:}"
      host="${local_addr%:*}"
      case "${host}" in
        0.0.0.0|::|\[::\]|\*)
          case "${port}" in
            22)
              ;;
            80|443)
              if [ "${reverse_proxy_ports_allowed}" != "1" ]; then
                printf '%s\n' "${local_addr}"
              fi
              ;;
            *)
              printf '%s\n' "${local_addr}"
              ;;
          esac
          ;;
      esac
    done
  )"

  if [ -z "${offenders}" ]; then
    pass "No public TCP listeners except SSH and intentional reverse-proxy ports"
  else
    fail "Unexpected public TCP listeners: ${offenders}"
  fi
}

main() {
  printf 'Alpaca Investing server verification\n'
  printf '====================================\n'

  info "Current user: $(id -un) ($(id -u))"
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    info "OS: ${PRETTY_NAME:-unknown}"
  else
    fail "OS version file /etc/os-release is readable"
  fi

  if [ -f "${SSH_SNIPPET}" ]; then
    pass "SSH hardening snippet exists"
  else
    fail "SSH hardening snippet exists"
  fi

  if [ -s "/home/${APP_USER}/.ssh/authorized_keys" ]; then
    pass "${APP_USER} has key-based SSH authorized_keys"
  else
    fail "${APP_USER} has key-based SSH authorized_keys"
  fi

  check "SSH configuration validates with sshd -t" ${SUDO} sshd -t

  local effective_ssh_config
  effective_ssh_config="$(get_effective_ssh_config || true)"
  if [ -n "${effective_ssh_config}" ]; then
    check_effective_ssh_setting "${effective_ssh_config}" permitrootlogin no
    check_effective_ssh_setting "${effective_ssh_config}" passwordauthentication no
    check_effective_ssh_setting "${effective_ssh_config}" kbdinteractiveauthentication no
    check_effective_ssh_setting "${effective_ssh_config}" pubkeyauthentication yes
    check_effective_ssh_setting "${effective_ssh_config}" x11forwarding no
    check_effective_ssh_setting "${effective_ssh_config}" allowtcpforwarding no
  else
    fail "effective SSH configuration is readable with sshd -T"
  fi

  local ufw_status
  ufw_status="$(${SUDO} ufw status verbose 2>/dev/null || true)"
  check_contains "UFW is active" "${ufw_status}" '^Status:[[:space:]]+active'
  check_contains "UFW default denies incoming traffic" "${ufw_status}" '^Default:[[:space:]]+deny[[:space:]]+\(incoming\)'
  check_contains "UFW default allows outgoing traffic" "${ufw_status}" '^Default:.*allow[[:space:]]+\(outgoing\)'
  check_contains "UFW allows SSH" "${ufw_status}" 'OpenSSH|22/tcp'

  check "fail2ban service is active" systemctl is-active --quiet fail2ban
  check "fail2ban sshd jail responds" ${SUDO} fail2ban-client status sshd

  check "unattended-upgrades package is installed" dpkg-query -W unattended-upgrades
  if grep -Eq 'APT::Periodic::Unattended-Upgrade[[:space:]]+"1"' /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null; then
    pass "automatic unattended upgrades are enabled"
  else
    fail "automatic unattended upgrades are enabled"
  fi
  if grep -Eq 'Unattended-Upgrade::Automatic-Reboot[[:space:]]+"false"' /etc/apt/apt.conf.d/52unattended-upgrades-no-reboot 2>/dev/null; then
    pass "automatic reboots are disabled"
  else
    fail "automatic reboots are disabled"
  fi

  if [ -d "${APP_ROOT}" ]; then
    pass "${APP_ROOT} exists"
  else
    fail "${APP_ROOT} exists"
  fi

  if [ -d "${APP_ROOT}/secrets" ]; then
    local mode owner
    mode="$(stat -c '%a' "${APP_ROOT}/secrets" 2>/dev/null || true)"
    owner="$(stat -c '%U:%G' "${APP_ROOT}/secrets" 2>/dev/null || true)"
    if [ "${mode}" = "700" ] && [ "${owner}" = "${APP_USER}:${APP_USER}" ]; then
      pass "${APP_ROOT}/secrets is owned by ${APP_USER}:${APP_USER} with 700 permissions"
    else
      fail "${APP_ROOT}/secrets permissions expected ${APP_USER}:${APP_USER} 700, got ${owner} ${mode}"
    fi
  else
    fail "${APP_ROOT}/secrets exists"
  fi

  local env_files
  env_files="$(tracked_real_env_files || true)"
  if [ -z "${env_files}" ]; then
    pass "No real env files are tracked by Git"
  else
    fail "Tracked real env files found: ${env_files}"
  fi

  local secret_files
  secret_files="$(tracked_secret_matches || true)"
  if [ -z "${secret_files}" ]; then
    pass "No Alpaca key-like values found in tracked files"
  else
    fail "Alpaca key-like values found in tracked files: ${secret_files}"
  fi

  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    pass "Docker Engine and Compose plugin are installed"
  elif [ -f "${DOCKER_STATUS_FILE}" ] && grep -qi '^pending:' "${DOCKER_STATUS_FILE}"; then
    pass "Docker is explicitly marked pending"
  else
    fail "Docker is installed or explicitly marked pending"
  fi

  check_public_listeners

  printf '\nSummary: %s passed, %s failed, %s info\n' "${PASS_COUNT}" "${FAIL_COUNT}" "${INFO_COUNT}"
  if [ "${FAIL_COUNT}" -eq 0 ]; then
    printf 'Result: PASS\n'
    exit 0
  fi

  printf 'Result: FAIL\n'
  exit 1
}

main "$@"
