#!/usr/bin/env bash
#
# Nightly database backup.
#
# Two things matter. Postgres holds accounts, servers, channels, private
# conversations and the avatars, which are rows rather than files. Uploaded
# attachments are files on disk, because a hundred-megabyte video has no
# business inside a dump - so they are archived separately, in the same run.
#
# It has to be the same run. A database restored from Tuesday next to files
# from Sunday is a set of messages pointing at attachments that are not there,
# and the discovery happens when somebody scrolls back rather than when the
# restore is done.
#
# Redis holds only presence and rate-limit counters, which rebuild themselves,
# and the updates directory is build output that can be produced again.
#
# Installed by scripts/install-backups.sh; run by cron as root. Safe to run by
# hand at any time.
#
# What "properly" means here, in order of how often each one actually saves you:
#
#   1. The dump is written to a temporary file and only moved into place once it
#      has been checked. A half-written backup that looks like a backup is worse
#      than an obviously missing one.
#   2. It is verified: gzip integrity, then a look inside for the tables that
#      must be there. A dump of the wrong database, or of a database that failed
#      to start, is syntactically perfect and completely useless.
#   3. It is compared against the last one. A backup that suddenly shrinks by
#      more than half is the signature of a truncated table or a partial dump,
#      and it is the failure people discover months later.
#   4. Old ones are pruned by age, but the newest few are always kept whatever
#      their age - otherwise a server left off for two months wakes up and
#      deletes the only copies it has.

set -euo pipefail

REPO_DIR="${REPO_DIR:-/root/ChitChak}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_DIR/backups}"
CONTAINER="${POSTGRES_CONTAINER:-chitchak-postgres}"
DB_NAME="${POSTGRES_DB:-chitchak}"
DB_USER="${POSTGRES_USER:-chitchak}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
KEEP_MINIMUM="${BACKUP_KEEP_MINIMUM:-7}"
UPLOAD_DIR="${UPLOAD_DIR:-$REPO_DIR/uploads}"
# Optional. An rclone remote ("b2:chitchak-backups") or an scp target
# ("user@host:/path"). Empty means local-only, which is not a real backup - see
# the note at the end of the run.
REMOTE="${BACKUP_REMOTE:-}"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
TARGET="$BACKUP_DIR/chitchak-$STAMP.sql.gz"
TEMP="$TARGET.partial"

log() { echo "[$(date -u +%H:%M:%S)] $*"; }
fail() { echo "[$(date -u +%H:%M:%S)] FAILED: $*" >&2; rm -f "$TEMP"; exit 1; }

mkdir -p "$BACKUP_DIR"

# --- Dump ---------------------------------------------------------------------

docker inspect -f '{{.State.Running}}' "$CONTAINER" >/dev/null 2>&1 \
  || fail "container $CONTAINER is not running"

log "dumping $DB_NAME"
# pipefail is on, so a pg_dump failure fails the pipeline rather than leaving a
# gzip of an error message.
docker exec "$CONTAINER" pg_dump -U "$DB_USER" "$DB_NAME" | gzip -9 > "$TEMP" \
  || fail "pg_dump failed"

# --- Verify -------------------------------------------------------------------

gzip -t "$TEMP" || fail "the gzip is corrupt"

# A dump of an empty or wrong database is valid gzip and valid SQL. These are
# the tables whose absence means the file is not what it claims to be.
#
# The archive is read once into a list of table names rather than grepped per
# table, and deliberately not with `grep -q` in the pipeline: -q exits the moment
# it matches, gunzip takes SIGPIPE for writing to a closed pipe, and `pipefail`
# then fails the whole check *because* the table was found.
TABLES=$(gunzip -c "$TEMP" | sed -n 's/^CREATE TABLE public\.\([a-z_]*\) .*/\1/p') \
  || fail "could not read the dump back"

for table in users guilds channels messages friendships; do
  printf '%s\n' "$TABLES" | grep -qx "$table" \
    || fail "no '$table' table in the dump - wrong database?"
done

SIZE=$(stat -c %s "$TEMP")
[ "$SIZE" -gt 1024 ] || fail "dump is only $SIZE bytes"

# Shrinking by more than half is not proof of damage, but it is never normal for
# a database that only accumulates. Worth stopping for.
PREVIOUS=$(find "$BACKUP_DIR" -maxdepth 1 -name 'chitchak-*.sql.gz' -printf '%T@ %s\n' 2>/dev/null \
  | sort -rn | head -1 | cut -d' ' -f2 || true)
if [ -n "${PREVIOUS:-}" ] && [ "$PREVIOUS" -gt 0 ]; then
  if [ "$((SIZE * 2))" -lt "$PREVIOUS" ]; then
    fail "dump is $SIZE bytes, less than half of the previous $PREVIOUS - refusing"
  fi
fi

mv "$TEMP" "$TARGET"
log "wrote $(basename "$TARGET") ($(numfmt --to=iec "$SIZE" 2>/dev/null || echo "$SIZE bytes"))"

# --- Attachments --------------------------------------------------------------
#
# Content addressed, so the archive is almost entirely new files each night and
# tar's own dedupe does nothing - but the same is true of any scheme, and a
# plain tar is a thing anyone can open in ten years without this script.

UPLOADS_TARGET=""
if [ -d "$UPLOAD_DIR" ]; then
  UPLOADS_TARGET="$BACKUP_DIR/uploads-$STAMP.tar.gz"
  UPLOADS_TEMP="$UPLOADS_TARGET.partial"

  if tar -czf "$UPLOADS_TEMP" -C "$(dirname "$UPLOAD_DIR")" "$(basename "$UPLOAD_DIR")"; then
    gzip -t "$UPLOADS_TEMP" || fail "the uploads archive is corrupt"
    mv "$UPLOADS_TEMP" "$UPLOADS_TARGET"
    log "wrote $(basename "$UPLOADS_TARGET") ($(du -h "$UPLOADS_TARGET" | cut -f1))"
  else
    rm -f "$UPLOADS_TEMP"
    fail "could not archive $UPLOAD_DIR"
  fi
else
  log "no uploads directory at $UPLOAD_DIR - nothing to archive"
fi

# --- Offsite ------------------------------------------------------------------

if [ -n "$REMOTE" ]; then
  case "$REMOTE" in
    *:/*|*@*:*)
      log "copying to $REMOTE over scp"
      scp -q -o BatchMode=yes "$TARGET" "$REMOTE/" || fail "scp to $REMOTE failed"
      [ -n "$UPLOADS_TARGET" ] && { scp -q -o BatchMode=yes "$UPLOADS_TARGET" "$REMOTE/"         || fail "scp of the uploads archive failed"; }
      ;;
    *)
      log "copying to $REMOTE with rclone"
      rclone copy "$TARGET" "$REMOTE" || fail "rclone to $REMOTE failed"
      [ -n "$UPLOADS_TARGET" ] && { rclone copy "$UPLOADS_TARGET" "$REMOTE"         || fail "rclone of the uploads archive failed"; }
      ;;
  esac
  log "offsite copy done"
else
  log "BACKUP_REMOTE is not set - this copy lives only on the machine it backs up"
fi

# --- Prune --------------------------------------------------------------------

TOTAL=$(find "$BACKUP_DIR" -maxdepth 1 -name 'chitchak-*.sql.gz' | wc -l)
if [ "$TOTAL" -gt "$KEEP_MINIMUM" ]; then
  # Age-based, but never below the floor: sort newest first, skip the ones being
  # kept unconditionally, and only then consider age.
  find "$BACKUP_DIR" -maxdepth 1 -name 'chitchak-*.sql.gz' -printf '%T@ %p\n' \
    | sort -rn | tail -n +$((KEEP_MINIMUM + 1)) | cut -d' ' -f2- \
    | while read -r old; do
        if [ -n "$(find "$old" -mtime "+$KEEP_DAYS")" ]; then
          rm -f "$old"
          log "pruned $(basename "$old")"
        fi
      done
fi

UPLOAD_TOTAL=$(find "$BACKUP_DIR" -maxdepth 1 -name 'uploads-*.tar.gz' | wc -l)
if [ "$UPLOAD_TOTAL" -gt "$KEEP_MINIMUM" ]; then
  find "$BACKUP_DIR" -maxdepth 1 -name 'uploads-*.tar.gz' -printf '%T@ %p
'     | sort -rn | tail -n +$((KEEP_MINIMUM + 1)) | cut -d' ' -f2-     | while read -r old; do
        if [ -n "$(find "$old" -mtime "+$KEEP_DAYS")" ]; then
          rm -f "$old"
          log "pruned $(basename "$old")"
        fi
      done
fi

log "$(find "$BACKUP_DIR" -maxdepth 1 -name 'chitchak-*.sql.gz' | wc -l) database backups on disk"
log "$(find "$BACKUP_DIR" -maxdepth 1 -name 'uploads-*.tar.gz' | wc -l) upload archives on disk"
