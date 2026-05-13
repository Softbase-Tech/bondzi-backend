# Lightsail server setup — copy-pasteable

Companion to `docs/bondzi-backend-setup-guide.md`. These files turn the
manual Phases 2–6 into a small number of scripts you run on the
Lightsail box.

The Phase 1 code changes (Bedrock migration, WORKER_MODE switch, CI workflow
files) are already in this repo on the `develop` branch.

## Run order

```text
On your laptop:
  1. Push the repo to GitHub (the `develop` branch).
  2. Set GitHub secrets: LIGHTSAIL_HOST, LIGHTSAIL_SSH_KEY, GHCR_TOKEN.

On the Lightsail box (eu-central-1, 2 GB ARM Ubuntu 22.04):
  3. scp the contents of this directory to /tmp/setup/ (or git pull
     and reference docs/server-setup/ directly).
  4. sudo bash /tmp/setup/01-provision.sh
  5. Log out, log back in (docker group needs a fresh session).
  6. Run `aws configure` once with the IAM keys.
  7. Copy Dockerfile + docker-compose.yml + docker-compose.local.yml +
     .env.example + nginx/bondzi.conf + backup.sh into /opt/bondzi/.
  8. Fill in /opt/bondzi/.env from .env.example (generate the random
     secrets with `openssl rand -hex 24` / `32`).
  9. Run `sudo bash /tmp/setup/02-tls-bootstrap.sh` to issue the cert.
 10. cd /opt/bondzi && docker compose -f docker-compose.local.yml up -d --build
 11. docker compose -f docker-compose.local.yml run --rm api npm run migration:run
 12. docker compose -f docker-compose.local.yml run --rm api npm run seed
 13. Create the admin user (snippet at the bottom of this README).
 14. crontab -e and add the line shown in 03-backup-cron.txt.
 15. Run `bash /tmp/setup/03-restore-drill.sh` once to prove the backup pipeline.
 16. Tell the owner to do their Phase 3 (Africa's Talking IP whitelist,
     Paystack webhook URL, UptimeRobot monitor).
 17. After your first push to the `deploy` branch produces a GHCR image,
     switch to `docker compose up -d` (production compose) and drop the
     local bootstrap compose file.
```

## Files in this directory

| File | Maps to guide phase | Notes |
|---|---|---|
| `01-provision.sh` | 2.2 → 2.8 | apt updates, ufw, fail2ban, Docker, swap, AWS CLI, mkdir /opt/bondzi |
| `02-tls-bootstrap.sh` | 4.2 | Issues the Let's Encrypt cert via certbot standalone + installs the renewal hook |
| `03-backup-cron.txt` | 5.2 | Single line for `crontab -e` |
| `03-restore-drill.sh` | 5.3 | Tests the backup chain into a throwaway DB |
| `Dockerfile` | 3.1 | Multi-stage Node 20 alpine, tini, --omit=dev |
| `docker-compose.yml` | 3.2 | Production — pulls images from GHCR |
| `docker-compose.local.yml` | 3.2 (bootstrap) | Builds api + worker from /opt/bondzi/app for the very first deploy |
| `.env.example` | 3.3 | Template for /opt/bondzi/.env. Lock with `chmod 600`. |
| `nginx/bondzi.conf` | 3.4 | TLS, rate limits, Paystack IP allowlist, raw-body-safe webhook proxy |
| `backup.sh` | 5.1 | Nightly pg_dump → S3 IA, prunes local copies |

## Create the admin user (Phase 4.7)

After migrations + seed succeed, create the initial admin so the owner
can sign into the dashboard:

```bash
docker compose -f docker-compose.local.yml run --rm api node -e "
const bcrypt = require('bcrypt');
bcrypt.hash('CHANGE_ME_STRONG_PASSWORD', 10).then(h => console.log(h));
"
# Copy the resulting hash.

docker exec -it bondzi-postgres psql -U bondzi -d bondzi_prod -c "
INSERT INTO users (
  id, full_name, email, password_hash, role,
  exam_type, school_level, form_level, referral_code
) VALUES (
  gen_random_uuid(),
  'Bondzi Admin',
  'admin@bondzi.online',
  'PASTE_HASH_HERE',
  'admin',
  'wassce', 'shs', 3,
  'BZ-ADMIN-001'
);
"
```

## Useful runbook commands

```bash
docker compose ps                       # all 5 containers healthy?
docker logs -f --tail=200 bondzi-api    # api logs
docker logs -f --tail=200 bondzi-worker # worker logs
docker stats                            # live RAM/CPU per container

# Force a backup now
cd /opt/bondzi && ./backup.sh

# Pause AI generation (cost emergency)
docker compose stop worker              # students unaffected
docker compose start worker             # resume

# Manual TLS renewal
sudo certbot renew --force-renewal
docker exec bondzi-nginx nginx -s reload
```
