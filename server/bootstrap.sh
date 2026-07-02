#!/usr/bin/env bash
set -Eeuo pipefail

APP_USER="${APP_USER:-alpaca}"
APP_ROOT="${APP_ROOT:-/opt/alpaca-investing}"
SECRETS_DIR="${APP_ROOT}/secrets"
DOCKER_STATUS_FILE="${APP_ROOT}/docker-status"

log() {
  printf '[bootstrap] %s\n' "$*"
}

fail() {
  printf '[bootstrap] ERROR: %s\n' "$*" >&2
  exit 1
}

require_root() {
  if [ "${EUID}" -ne 0 ]; then
    fail "Run as root or with sudo: sudo bash server/bootstrap.sh"
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

install_baseline_packages() {
  log "Updating package indexes"
  apt-get update

  log "Installing baseline packages"
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    curl \
    wget \
    git \
    ufw \
    fail2ban \
    unattended-upgrades \
    ca-certificates \
    gnupg \
    lsb-release \
    jq \
    htop \
    tmux \
    logrotate
}

create_app_user() {
  if id "${APP_USER}" >/dev/null 2>&1; then
    log "User ${APP_USER} already exists"
  else
    log "Creating user ${APP_USER}"
    adduser --disabled-password --gecos "" "${APP_USER}"
  fi

  if id -nG "${APP_USER}" | tr ' ' '\n' | grep -qx sudo; then
    log "User ${APP_USER} is already in sudo group"
  else
    log "Adding ${APP_USER} to sudo group for controlled administration"
    usermod -aG sudo "${APP_USER}"
  fi
}

provision_app_user_ssh_keys() {
  local ssh_dir="/home/${APP_USER}/.ssh"
  local authorized_keys="${ssh_dir}/authorized_keys"
  local root_authorized_keys="/root/.ssh/authorized_keys"

  install -d -o "${APP_USER}" -g "${APP_USER}" -m 0700 "${ssh_dir}"

  if [ -s "${authorized_keys}" ]; then
    log "${APP_USER} already has authorized_keys; leaving it unchanged"
  elif [ -s "${root_authorized_keys}" ]; then
    log "Copying root authorized_keys to ${APP_USER} to preserve key-based SSH after root login is disabled"
    install -o "${APP_USER}" -g "${APP_USER}" -m 0600 "${root_authorized_keys}" "${authorized_keys}"
  else
    log "WARNING: No root authorized_keys found. Add a key to ${authorized_keys} before running hardening.sh."
    touch "${authorized_keys}"
    chown "${APP_USER}:${APP_USER}" "${authorized_keys}"
    chmod 0600 "${authorized_keys}"
  fi
}

create_project_directories() {
  log "Creating ${APP_ROOT} directory tree"
  install -d -o "${APP_USER}" -g "${APP_USER}" -m 0755 "${APP_ROOT}"
  install -d -o "${APP_USER}" -g "${APP_USER}" -m 0755 "${APP_ROOT}/app"
  install -d -o "${APP_USER}" -g "${APP_USER}" -m 0750 "${APP_ROOT}/logs"
  install -d -o "${APP_USER}" -g "${APP_USER}" -m 0700 "${SECRETS_DIR}"
  install -d -o "${APP_USER}" -g "${APP_USER}" -m 0750 "${APP_ROOT}/backups"
}

write_env_example() {
  local target="${SECRETS_DIR}/alpaca.env.example"

  log "Writing placeholder-only environment example at ${target}"
  cat >"${target}" <<'ENVEOF'
ALPACA_ENV=paper
ALPACA_PAPER_KEY=
ALPACA_PAPER_SECRET=
ALPACA_LIVE_KEY=
ALPACA_LIVE_SECRET=
ALPACA_PAPER_BASE_URL=https://paper-api.alpaca.markets
ALPACA_LIVE_BASE_URL=https://api.alpaca.markets
LIVE_TRADING_ENABLED=false
ENVEOF

  chown "${APP_USER}:${APP_USER}" "${target}"
  chmod 0600 "${target}"
}

configure_unattended_upgrades() {
  log "Configuring unattended security updates without automatic reboots"
  cat >/etc/apt/apt.conf.d/20auto-upgrades <<'APTCONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
APTCONF

  cat >/etc/apt/apt.conf.d/52unattended-upgrades-no-reboot <<'APTCONF'
Unattended-Upgrade::Automatic-Reboot "false";
APTCONF

  systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
  systemctl enable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true
}

install_docker_engine() {
  if [ "${SKIP_DOCKER:-0}" = "1" ]; then
    log "SKIP_DOCKER=1 set; marking Docker installation pending"
    printf 'pending: operator skipped Docker installation during bootstrap\n' >"${DOCKER_STATUS_FILE}"
    chown "${APP_USER}:${APP_USER}" "${DOCKER_STATUS_FILE}"
    return 0
  fi

  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker Engine and Compose plugin already installed"
    printf 'installed: existing Docker Engine and Compose plugin detected\n' >"${DOCKER_STATUS_FILE}"
    chown "${APP_USER}:${APP_USER}" "${DOCKER_STATUS_FILE}"
    return 0
  fi

  log "Installing Docker Engine from Docker's official apt repository"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  local codename arch
  codename="$(. /etc/os-release && printf '%s' "${VERSION_CODENAME}")"
  arch="$(dpkg --print-architecture)"

  cat >/etc/apt/sources.list.d/docker.list <<EOF
deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${codename} stable
EOF

  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin \
    docker-ce-rootless-extras \
    uidmap \
    dbus-user-session \
    slirp4netns

  systemctl enable --now docker

  cat >"${DOCKER_STATUS_FILE}" <<'STATUS'
installed: rootful Docker Engine and Compose plugin installed
rootless: not configured by bootstrap; use an interactive operator session to validate rootless Docker for alpaca before enabling it
docker_group: alpaca was not added to the docker group because that grants root-equivalent access
STATUS
  chown "${APP_USER}:${APP_USER}" "${DOCKER_STATUS_FILE}"
}

main() {
  require_root
  check_tracked_secret_patterns
  install_baseline_packages
  create_app_user
  provision_app_user_ssh_keys
  create_project_directories
  write_env_example
  configure_unattended_upgrades
  install_docker_engine

  log "Bootstrap complete. No trading containers, Alpaca credentials, or live trading paths were deployed."
}

main "$@"
