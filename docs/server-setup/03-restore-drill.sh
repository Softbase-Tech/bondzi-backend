#!/usr/bin/env bash
#
# Phase 5.3 — restore drill. Verifies the backup pipeline works end-to-end
# by restoring the latest S3 dump into a throwaway database, counting rows,
# and dropping the throwaway DB.
#
# Run this once after the first backup.sh execution. Re-run any time you
# change the backup script.
#
# Usage:  bash 03-restore-drill.sh
set -euo pipefail

DATE="$(date +%Y-%m-%d)"
BUCKET="${BUCKET:-bondzi-prod}"
CONTAINER="${CONTAINER:-bondzi-postgres}"
USER_DB="${POSTGRES_USER:-bondzi}"
SOURCE_DB="${POSTGRES_DB:-bondzi_prod}"
TEST_DB="bondzi_restore_test"

echo "==> Pulling latest dump from s3://${BUCKET}/backups/postgres/${DATE}.dump.gz"
aws s3 cp "s3://${BUCKET}/backups/postgres/${DATE}.dump.gz" "/tmp/${DATE}.dump.gz"

echo "==> Creating ${TEST_DB}"
docker exec "${CONTAINER}" psql -U "${USER_DB}" -d postgres \
  -c "CREATE DATABASE ${TEST_DB};"

echo "==> Restoring dump into ${TEST_DB}"
gunzip -c "/tmp/${DATE}.dump.gz" | \
  docker exec -i "${CONTAINER}" pg_restore -U "${USER_DB}" \
    -d "${TEST_DB}" --clean --if-exists

echo "==> Spot check: row counts"
docker exec "${CONTAINER}" psql -U "${USER_DB}" -d "${TEST_DB}" -c "
  SELECT 'users' AS table, COUNT(*) AS rows FROM users
  UNION ALL SELECT 'subjects', COUNT(*) FROM subjects
  UNION ALL SELECT 'questions', COUNT(*) FROM questions;
"

echo "==> Dropping ${TEST_DB}"
docker exec "${CONTAINER}" psql -U "${USER_DB}" -d postgres \
  -c "DROP DATABASE ${TEST_DB};"

echo
echo "Backup pipeline OK — you have a real backup."
