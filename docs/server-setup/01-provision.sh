#!/usr/bin/env bash
#
# Phase 2 of the deployment guide collapsed into one script.
# Run as root on a fresh Lightsail 2 GB ARM Ubuntu 22.04 box.
#
# Steps performed (matches guide section numbers):
#   2.2  apt update + essentials
#   2.3  UFW firewall (22 / 80 / 443 only)
#   2.4  fail2ban (default sshd jail)
#   2.5  Docker + Docker Compose plugin
#   2.6  2 GB swap with swappiness=10
#   2.7  AWS CLI v2 for arm64
#   2.8  /opt/bondzi/{nginx,postgres-data,redis-data,backups,logs} owned by ubuntu
#
# After this script exits successfully:
#   - log out and back in (docker group needs a fresh session)
#   - run `aws configure` once with the IAM keys the owner gave you
#   - copy this directory's other files into /opt/bondzi/
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root (use sudo)." >&2
  exit 1
fi

echo "==> [2.2] apt update + essentials"
apt update
apt upgrade -y
apt install -y \
  git curl unzip nginx ufw fail2ban \
  ca-certificates gnupg postgresql-client

echo "==> [2.3] UFW firewall"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status verbose

echo "==> [2.4] fail2ban (sshd jail)"
systemctl enable --now fail2ban
fail2ban-client status sshd || true

echo "==> [2.5] Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
usermod -aG docker ubuntu
apt install -y docker-compose-plugin

echo "==> [2.6] Swap (2 GB, swappiness=10)"
if [[ ! -f /swapfile ]]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -w vm.swappiness=10
grep -q '^vm.swappiness' /etc/sysctl.conf \
  || echo 'vm.swappiness=10' >> /etc/sysctl.conf

echo "==> [2.7] AWS CLI v2 (arm64)"
if ! command -v aws >/dev/null 2>&1; then
  TMP="$(mktemp -d)"
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" \
    -o "${TMP}/awscliv2.zip"
  unzip -q "${TMP}/awscliv2.zip" -d "${TMP}"
  "${TMP}/aws/install"
  rm -rf "${TMP}"
fi
aws --version

echo "==> [2.8] /opt/bondzi directory layout"
mkdir -p /opt/bondzi/{nginx,postgres-data,redis-data,backups,logs}
chown -R ubuntu:ubuntu /opt/bondzi

cat <<'NEXT'

==============================================================
Done. Next:

  1. exit and re-ssh so the docker group is picked up.
  2. aws configure          # paste IAM keys, region eu-central-1
  3. Copy Dockerfile / docker-compose.yml / docker-compose.local.yml /
     .env.example / nginx/bondzi.conf / backup.sh into /opt/bondzi/
  4. Fill in /opt/bondzi/.env (chmod 600 it after).
  5. sudo bash 02-tls-bootstrap.sh
  6. cd /opt/bondzi && docker compose -f docker-compose.local.yml up -d --build
==============================================================
NEXT
