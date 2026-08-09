#!/usr/bin/env bash
#
# Phase 5.3 — restore drill. Verifies the backup pipeline works end-to-end
# by restoring the latest S3 dump into a THROWAWAY postgres container,
# counting rows, then nuking the container.
#
# CRITICAL: the previous shape restored into the PRODUCTION postgres
# container (`bondzi-postgres`) and relied on `--clean --if-exists` plus
# a typo-free TEST_DB to avoid clobbering live data. A single character
# slip (TEST_DB="" or "$SOURCE_DB") would have erased prod. The drill
# now spins up an ephemeral postgres container with its own data
# volume — there is no production DB to wreck.
#
# Run this once after the first backup.sh execution. Re-run any time you
# change the backup script.
#
# Usage:  bash 03-restore-drill.sh
set -euo pipefail

BUCKET="${BUCKET:-bondzi-prod}"
USER_DB="${POSTGRES_USER:-bondzi}"
DRILL_CONTAINER="bondzi-restore-drill-$(date -u +%s)"
DRILL_PASSWORD="$(openssl rand -hex 16)"
DUMP_TMP="/tmp/${DRILL_CONTAINER}.dump.gz"

cleanup() {
  echo "==> Cleaning up: stopping ${DRILL_CONTAINER}"
  docker rm -f "${DRILL_CONTAINER}" >/dev/null 2>&1 || true
  rm -f "${DUMP_TMP}"
}
trap cleanup EXIT

# Pick the latest dump in S3 rather than `date +%Y-%m-%d` so the drill
# works even before today's 02:30 backup has run.
echo "==> Looking up the latest dump on s3://${BUCKET}/backups/postgres/"
LATEST_KEY=$(aws s3 ls "s3://${BUCKET}/backups/postgres/" \
  | awk '/\.dump\.gz$/ {print $4}' \
  | sort \
  | tail -n1)
if [[ -z "${LATEST_KEY}" ]]; then
  echo "ERROR: no dumps found in s3://${BUCKET}/backups/postgres/"
  exit 1
fi
echo "    using ${LATEST_KEY}"

echo "==> Downloading dump to ${DUMP_TMP}"
aws s3 cp "s3://${BUCKET}/backups/postgres/${LATEST_KEY}" "${DUMP_TMP}"

echo "==> Starting ephemeral postgres container '${DRILL_CONTAINER}' (no shared volume with prod)"
docker run -d \
  --name "${DRILL_CONTAINER}" \
  --rm=false \
  -e POSTGRES_PASSWORD="${DRILL_PASSWORD}" \
  -e POSTGRES_USER="${USER_DB}" \
  -e POSTGRES_DB=postgres \
  postgres:15-alpine >/dev/null

# Wait for the container to accept connections — pg_isready loops up to 30s.
echo "==> Waiting for postgres to start"
for _ in $(seq 1 30); do
  if docker exec "${DRILL_CONTAINER}" pg_isready -U "${USER_DB}" -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "==> Creating target DB 'bondzi_restore_test'"
docker exec "${DRILL_CONTAINER}" psql -U "${USER_DB}" -d postgres \
  -c "CREATE DATABASE bondzi_restore_test;"

echo "==> Restoring dump"
gunzip -c "${DUMP_TMP}" | \
  docker exec -i "${DRILL_CONTAINER}" pg_restore -U "${USER_DB}" \
    -d bondzi_restore_test

echo "==> Spot check: row counts"
docker exec "${DRILL_CONTAINER}" psql -U "${USER_DB}" -d bondzi_restore_test -c "
  SELECT 'users' AS table, COUNT(*) AS rows FROM users
  UNION ALL SELECT 'subjects', COUNT(*) FROM subjects
  UNION ALL SELECT 'questions', COUNT(*) FROM questions;
"

echo
echo "Backup pipeline OK — restored ${LATEST_KEY} into an ephemeral container."
echo "(Production database was never touched.)"
