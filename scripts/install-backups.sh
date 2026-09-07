#!/usr/bin/env bash
#
# Put the backup job in cron. Run once, on the server:
#
#   ./scripts/install-backups.sh
#
# Idempotent - re-running replaces the entries rather than adding a second copy,
# so it is safe to run again after changing the schedule.

set -euo pipefail

REPO_DIR="${REPO_DIR:-/root/ChitChak}"
LOG="${BACKUP_LOG:-/var/log/chitchak-backup.log}"
# 04:12 rather than 04:00: every cron job in the world runs on the hour, and the
# nightly Docker and apt work on this box does too.
SCHEDULE="${BACKUP_SCHEDULE:-12 4 * * *}"
# Sunday, after the nightly dump has finished.
VERIFY_SCHEDULE="${BACKUP_VERIFY_SCHEDULE:-40 4 * * 0}"

chmod +x "$REPO_DIR/scripts/backup.sh" "$REPO_DIR/scripts/backup-verify.sh"

MARKER="# chitchak-backup"

# Keep every line that is not ours, then append ours. Rewriting the whole
# crontab is what makes this safe to run twice.
EXISTING=$(crontab -l 2>/dev/null | grep -v "$MARKER" || true)

{
  [ -n "$EXISTING" ] && echo "$EXISTING"
  echo "$SCHEDULE cd $REPO_DIR && ./scripts/backup.sh >> $LOG 2>&1 $MARKER"
  echo "$VERIFY_SCHEDULE cd $REPO_DIR && ./scripts/backup-verify.sh >> $LOG 2>&1 $MARKER"
} | crontab -

echo "Installed:"
crontab -l | grep "$MARKER"
echo
echo "Log: $LOG"
echo "Run one now with:  cd $REPO_DIR && ./scripts/backup.sh"
