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

# supercronic -test alone would accept a comment ("# off"), a VAR=value line, or
# "0 3 * * * foo" (it reads the 6th word as the start of the command), and the
# container would then run something other than the backup, or nothing. So only
# standard cron is allowed: a descriptor like @daily, or exactly 5 fields.
invalid_schedule() {
  echo "BACKUPDRILL_CRON is not a valid cron expression: \"$BACKUPDRILL_CRON\"" >&2
  exit 64
}
case "$BACKUPDRILL_CRON" in
  @* | [0-9*]*) ;;
  *) invalid_schedule ;;
esac
case "$BACKUPDRILL_CRON" in
  *[!0-9A-Za-z*/,?@#\ -]*) invalid_schedule ;;
esac
# Word splitting is the point here (count the fields); set -f stops "*" from
# expanding to file names in the working directory.
set -f
# shellcheck disable=SC2086
set -- $BACKUPDRILL_CRON
set +f
# "#" is valid inside a field (0#2 = second Sunday) but a field that starts with it
# would turn the rest of the crontab line, the backup command, into a comment.
for field in "$@"; do
  case "$field" in \#*) invalid_schedule ;; esac
done
case "$1" in
  @*) [ "$#" -eq 1 ] || invalid_schedule ;;
  *) [ "$#" -eq 5 ] || invalid_schedule ;;
esac

crontab_file="$(mktemp)"
printf '%s backupdrill backup\n' "$BACKUPDRILL_CRON" > "$crontab_file"
# Check the expression up front so a typo fails at container start, not silently.
supercronic -test "$crontab_file" >/dev/null 2>&1 || invalid_schedule

echo "backupdrill: scheduled \`backupdrill backup\` at \"$BACKUPDRILL_CRON\" (TZ=${TZ:-UTC})"
# supercronic skips a run while the previous one is still going, so two backups
# never overlap. -passthrough-logs keeps the CLI's own output as-is in the log.
exec supercronic -passthrough-logs "$crontab_file"
