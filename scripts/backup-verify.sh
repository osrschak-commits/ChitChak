#!/usr/bin/env bash
#
# Restore a backup into a throwaway database and check what came back.
#
#   ./scripts/backup-verify.sh                  # the newest backup
#   ./scripts/backup-verify.sh path/to/file.gz  # a specific one
#
# A backup nobody has ever restored is a file, not a backup. The nightly job
# checks that its dump is well-formed; this checks the only thing that actually
# matters, which is that Postgres will take it back and the rows are still there.
#
# It restores into a disposable container on a random port, never into the live
# database, and removes it afterwards whether it passed or failed. Running this
# cannot damage anything.
#
# Worth running by hand after any schema change, and on a schedule if you would
# rather find out on a Tuesday than during an outage.

set -euo pipefail

REPO_DIR="${REPO_DIR:-/root/ChitChak}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_DIR/backups}"
LIVE_CONTAINER="${POSTGRES_CONTAINER:-chitchak-postgres}"
DB_USER="${POSTGRES_USER:-chitchak}"
DB_NAME="${POSTGRES_DB:-chitchak}"
IMAGE="${POSTGRES_IMAGE:-postgres:17-alpine}"

SCRATCH="chitchak-restore-check-$$"

BACKUP="${1:-}"
if [ -z "$BACKUP" ]; then
  BACKUP=$(find "$BACKUP_DIR" -maxdepth 1 -name 'chitchak-*.sql.gz' -printf '%T@ %p\n' \
    | sort -rn | head -1 | cut -d' ' -f2-)
fi
[ -n "$BACKUP" ] && [ -f "$BACKUP" ] || { echo "No backup found" >&2; exit 1; }

echo "verifying $(basename "$BACKUP")"

cleanup() { docker rm -f "$SCRATCH" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# No published port: nothing outside Docker can reach it, and it needs no
# password because nothing else will ever connect.
docker run -d --name "$SCRATCH" \
  -e POSTGRES_USER="$DB_USER" \
  -e POSTGRES_PASSWORD=verify-only \
  -e POSTGRES_DB="$DB_NAME" \
  "$IMAGE" >/dev/null

# Deliberately a real query rather than pg_isready. The postgres image runs a
# temporary server while it initialises, and pg_isready answers yes to that one -
# several seconds before the database named in POSTGRES_DB exists. Waiting on a
# successful SELECT waits for the server that actually has it.
printf 'waiting for the scratch database'
READY=no
for _ in $(seq 1 60); do
  if docker exec "$SCRATCH" psql -U "$DB_USER" -d "$DB_NAME" -tAc 'select 1' >/dev/null 2>&1; then
    READY=yes
    echo " ready"
    break
  fi
  printf '.'
  sleep 1
done
[ "$READY" = yes ] || { echo; echo "scratch database never became usable" >&2; exit 1; }

echo "restoring"
# ON_ERROR_STOP so a failed statement fails the restore rather than leaving a
# half-populated database that then passes the row counts by luck.
if ! gunzip -c "$BACKUP" | docker exec -i "$SCRATCH" \
     psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>"/tmp/$SCRATCH.err"; then
  echo "RESTORE FAILED" >&2
  tail -5 "/tmp/$SCRATCH.err" >&2
  rm -f "/tmp/$SCRATCH.err"
  exit 1
fi
rm -f "/tmp/$SCRATCH.err"

counts() {
  docker exec "$1" psql -U "$DB_USER" -d "$DB_NAME" -tAc "
    select 'users='||(select count(*) from users)
        ||' guilds='||(select count(*) from guilds)
        ||' channels='||(select count(*) from channels)
        ||' messages='||(select count(*) from messages)
        ||' friendships='||(select count(*) from friendships)
        ||' images='||(select count(*) from images);"
}

RESTORED=$(counts "$SCRATCH")
echo "restored: $RESTORED"

# The live database has almost certainly moved on since the dump was taken, so
# this is a sanity check rather than an equality test - the restored copy should
# be in the same territory, not identical.
if docker inspect -f '{{.State.Running}}' "$LIVE_CONTAINER" >/dev/null 2>&1; then
  echo "live:     $(counts "$LIVE_CONTAINER")"
fi

RESTORED_USERS=$(docker exec "$SCRATCH" psql -U "$DB_USER" -d "$DB_NAME" -tAc "select count(*) from users;")
[ "$RESTORED_USERS" -gt 0 ] || { echo "PASSED THE RESTORE BUT HAS NO USERS" >&2; exit 1; }

echo "OK - the backup restores and has $RESTORED_USERS users in it"
