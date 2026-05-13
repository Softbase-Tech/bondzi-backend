#!/usr/bin/env bash
#
# Nightly Postgres backup → S3 IA. Drops into /opt/bondzi/backup.sh and
# fires from cron at 02:30 UTC (see 03-backup-cron.txt).
#
# - Logical pg_dump in custom format (-F c) so pg_restore can pick and
#   choose tables on a restore.
# - Gzip-compressed for size; STANDARD_IA storage class for cheap cold storage.
# - Local copies kept for KEEP_LOCAL_DAYS (3 by default) for fast access.

set -euo pipefail

DATE="$(date +%Y-%m-%d)"
LOCAL_DIR=/opt/bondzi/backups
BUCKET="${BUCKET:-bondzi-prod}"
KEEP_LOCAL_DAYS="${KEEP_LOCAL_DAYS:-3}"

mkdir -p "${LOCAL_DIR}"

echo "[$(date -Iseconds)] Backing up to ${LOCAL_DIR}/${DATE}.dump.gz"
docker exec bondzi-postgres pg_dump -U bondzi -d bondzi_prod -F c \
  | gzip > "${LOCAL_DIR}/${DATE}.dump.gz"

SIZE_HUMAN=$(du -h "${LOCAL_DIR}/${DATE}.dump.gz" | awk '{print $1}')
echo "[$(date -Iseconds)] Dump size: ${SIZE_HUMAN}"

echo "[$(date -Iseconds)] Pushing to s3://${BUCKET}/backups/postgres/${DATE}.dump.gz"
aws s3 cp "${LOCAL_DIR}/${DATE}.dump.gz" \
  "s3://${BUCKET}/backups/postgres/${DATE}.dump.gz" \
  --storage-class STANDARD_IA

echo "[$(date -Iseconds)] Pruning local dumps older than ${KEEP_LOCAL_DAYS} days"
find "${LOCAL_DIR}" -name '*.dump.gz' -mtime +"${KEEP_LOCAL_DAYS}" -delete

echo "[$(date -Iseconds)] Backup complete: ${DATE}"
