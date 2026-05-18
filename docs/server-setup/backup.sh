#!/usr/bin/env bash
#
# Nightly Postgres backup → S3 IA. Drops into /opt/bondzi/backup.sh and
# fires from cron at 02:30 UTC (see 03-backup-cron.txt).
#
# - Logical pg_dump in custom format (-F c) so pg_restore can pick and
#   choose tables on a restore.
# - Gzip-compressed for size; STANDARD_IA storage class for cheap cold storage.
# - Local copies kept for KEEP_LOCAL_DAYS (3 by default) for fast access.
# - S3 upload uses SSE-KMS (or AES256 fallback) so user PII never sits
#   at rest in plaintext on AWS. Set BACKUP_KMS_KEY_ID to a KMS CMK arn
#   to use KMS; leaving it blank falls back to S3-managed AES256.

set -euo pipefail

DATE="$(date +%Y-%m-%d)"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOCAL_DIR=/opt/bondzi/backups
BUCKET="${BUCKET:-bondzi-prod}"
KEEP_LOCAL_DAYS="${KEEP_LOCAL_DAYS:-3}"
BACKUP_KMS_KEY_ID="${BACKUP_KMS_KEY_ID:-}"

mkdir -p "${LOCAL_DIR}"

# Include the UTC timestamp in the object name so a same-day re-run
# (manual fix, recovery drill, etc.) never overwrites the previous
# good copy. Coupled with S3 versioning + a lifecycle rule, this gives
# us a true point-in-time backup history.
DUMP_FILE="${LOCAL_DIR}/${DATE}_${TIMESTAMP}.dump.gz"

echo "[$(date -Iseconds)] Backing up to ${DUMP_FILE}"
docker exec bondzi-postgres pg_dump -U bondzi -d bondzi_prod -F c \
  | gzip > "${DUMP_FILE}"

SIZE_HUMAN=$(du -h "${DUMP_FILE}" | awk '{print $1}')
echo "[$(date -Iseconds)] Dump size: ${SIZE_HUMAN}"

# CRITICAL: encrypt at rest. Without `--sse` (or `--sse aws:kms`), the
# dump sits in S3 as plaintext PII (emails, phone numbers, password
# hashes, payment references) — a bucket-policy misconfig or
# compromised IAM key would leak every user.
S3_KEY="backups/postgres/${DATE}_${TIMESTAMP}.dump.gz"
if [[ -n "${BACKUP_KMS_KEY_ID}" ]]; then
  echo "[$(date -Iseconds)] Pushing to s3://${BUCKET}/${S3_KEY} (SSE-KMS)"
  aws s3 cp "${DUMP_FILE}" "s3://${BUCKET}/${S3_KEY}" \
    --storage-class STANDARD_IA \
    --sse aws:kms \
    --sse-kms-key-id "${BACKUP_KMS_KEY_ID}"
else
  echo "[$(date -Iseconds)] Pushing to s3://${BUCKET}/${S3_KEY} (SSE-S3 AES256 — set BACKUP_KMS_KEY_ID for KMS)"
  aws s3 cp "${DUMP_FILE}" "s3://${BUCKET}/${S3_KEY}" \
    --storage-class STANDARD_IA \
    --sse AES256
fi

echo "[$(date -Iseconds)] Pruning local dumps older than ${KEEP_LOCAL_DAYS} days"
find "${LOCAL_DIR}" -name '*.dump.gz' -mtime +"${KEEP_LOCAL_DAYS}" -delete

echo "[$(date -Iseconds)] Backup complete: ${DATE}_${TIMESTAMP}"
