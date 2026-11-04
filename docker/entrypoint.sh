#!/bin/sh
# Three ways to run the image:
#   docker run IMAGE drill ...      arguments are passed straight to the CLI
#   BACKUPDRILL_CRON="0 3 * * 0"    run `backupdrill backup` on that schedule, forever
#   neither                         run one backup and exit with its exit code
set -eu

if [ "$#" -gt 0 ]; then
  exec backupdrill "$@"
fi

if [ -z "${BACKUPDRILL_CRON:-}" ]; then
  exec backupdrill backup
fi

# One line only: a newline in the variable would otherwise add extra cron entries.
case "$BACKUPDRILL_CRON" in
  *"
"*)
    echo "BACKUPDRILL_CRON must be a single cron expression, e.g. \"0 3 * * 0\"." >&2
    exit 64
    ;;
esac

crontab_file="$(mktemp)"
printf '%s backupdrill backup\n' "$BACKUPDRILL_CRON" > "$crontab_file"
# Check the expression up front so a typo fails at container start, not silently.
if ! supercronic -test "$crontab_file" >/dev/null 2>&1; then
  echo "BACKUPDRILL_CRON is not a valid cron expression: \"$BACKUPDRILL_CRON\"" >&2
  exit 64
fi

echo "backupdrill: scheduled \`backupdrill backup\` at \"$BACKUPDRILL_CRON\" (TZ=${TZ:-UTC})"
# supercronic skips a run while the previous one is still going, so two backups
# never overlap. -passthrough-logs keeps the CLI's own output as-is in the log.
exec supercronic -passthrough-logs "$crontab_file"
