# Rollback Notes

These notes describe how to reverse the bootstrap and hardening changes. Review each command before running it on the VPS.

## SSH Hardening

`server/hardening.sh` writes `/etc/ssh/sshd_config.d/99-alpaca-hardening.conf` and stores backups under `/root/alpaca-hardening-backups/<timestamp>/`.

To roll back SSH hardening:

```bash
sudo cp /root/alpaca-hardening-backups/<timestamp>/sshd_config /etc/ssh/sshd_config
sudo rm -f /etc/ssh/sshd_config.d/99-alpaca-hardening.conf
sudo sshd -t
sudo systemctl restart ssh
```

If the service is named `sshd` on the host, use:

```bash
sudo systemctl restart sshd
```

Keep the current SSH session open until a second SSH session works.

## UFW

To inspect firewall state:

```bash
sudo ufw status verbose
```

To disable UFW temporarily during emergency recovery:

```bash
sudo ufw disable
```

Do not leave the server with UFW disabled after recovery.

## fail2ban

To stop fail2ban:

```bash
sudo systemctl stop fail2ban
```

To remove the local SSH jail:

```bash
sudo rm -f /etc/fail2ban/jail.d/sshd.local
sudo systemctl restart fail2ban
```

## Unattended Upgrades

To disable unattended upgrades:

```bash
sudo rm -f /etc/apt/apt.conf.d/20auto-upgrades
sudo rm -f /etc/apt/apt.conf.d/52unattended-upgrades-no-reboot
sudo systemctl disable --now unattended-upgrades
```

## Docker

The bootstrap installs Docker Engine from Docker's official apt repository unless `SKIP_DOCKER=1` is set.

To stop Docker:

```bash
sudo systemctl stop docker
```

To disable Docker at boot:

```bash
sudo systemctl disable docker
```

Do not remove Docker packages until future app data, volumes, and images have been reviewed.

## Project Directory

The project directory is `/opt/alpaca-investing`.

Do not delete `/opt/alpaca-investing/secrets` unless secrets have been backed up or intentionally destroyed.

## App Services

No trading services are installed by these scripts. If future services are added, stop them with:

```bash
sudo systemctl stop <service-name>
docker compose -f /opt/alpaca-investing/app/docker-compose.yml down
```
