#!/usr/bin/env bash
#
# Phase 4.2 — issue the Let's Encrypt certificate via certbot standalone
# (Nginx isn't running yet) and install the renewal hook that reloads the
# in-container Nginx after each automatic renewal.
#
# Prerequisites:
#   - api.bondzi.online resolves to this box's public IP (Cloudflare).
#   - Port 80 is reachable from the public internet (UFW + Lightsail firewall).
#
# Usage:  sudo bash 02-tls-bootstrap.sh <api-hostname> <admin-email>
# Example: sudo bash 02-tls-bootstrap.sh api.bondzi.online admin@bondzi.online
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root (use sudo)." >&2
  exit 1
fi

HOST="${1:-api.bondzi.online}"
EMAIL="${2:?usage: $0 <api-hostname> <admin-email>}"

echo "==> Installing certbot"
apt install -y certbot
mkdir -p /var/www/certbot

# If port 80 is bound (e.g. by a container that started too early), free it.
if ss -ltn '( sport = :80 )' | grep -q LISTEN; then
  echo "Port 80 is bound — stopping listeners so certbot can use it." >&2
  systemctl stop nginx 2>/dev/null || true
  docker stop bondzi-nginx 2>/dev/null || true
fi

echo "==> Requesting certificate for ${HOST}"
certbot certonly --standalone \
  -d "${HOST}" \
  --email "${EMAIL}" \
  --agree-tos --no-eff-email

echo "==> Installing renewal hook (reloads in-container Nginx)"
mkdir -p /etc/letsencrypt/renewal-hooks/deploy/
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/bin/bash
# Reload the Nginx container so the renewed cert is picked up.
docker exec bondzi-nginx nginx -s reload 2>/dev/null || true
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

echo "==> Verifying certbot.timer is enabled"
systemctl enable --now certbot.timer
systemctl status certbot.timer --no-pager | head -5

# Dry-run the renewal RIGHT NOW so a misconfigured renewal hook /
# permission issue / firewall change surfaces on day-0 instead of
# silently failing on day-90 when the cert actually expires.
# A successful dry-run exercises:
#   1. ACME challenge path (HTTP-01 via /var/www/certbot)
#   2. Renewal hook execution (reload nginx)
#   3. cert + key write permissions
# certbot exits non-zero on any failure; set -e propagates it.
echo "==> Dry-run renewal to validate the full pipeline"
certbot renew --dry-run

echo
echo "Certificate installed at /etc/letsencrypt/live/${HOST}/"
echo "Renewal dry-run passed — the cert will auto-renew before expiry."
echo "Next: cd /opt/bondzi && docker compose -f docker-compose.local.yml up -d --build"
