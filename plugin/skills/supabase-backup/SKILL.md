---
name: supabase-backup
description: Use when the user wants to back up a Supabase project to their own S3, R2 or B2 bucket with the open-source backupdrill CLI, estimate what those backups add to their Supabase egress bill, check that a backup actually restores (a restore drill in Docker), schedule backups in GitHub Actions, or restore a backupdrill snapshot into a new Supabase project.
---

# Back up and restore-drill a Supabase project with backupdrill

backupdrill is an open-source (MIT) command-line tool. `backup` dumps the project's Postgres database with `pg_dump`, copies Storage files too once their S3 keys are set, and writes everything to a bucket the user owns, with a checksummed `manifest.json` and a `RECOVERY.md` in every snapshot. `drill` restores a snapshot into a throwaway Postgres in Docker and checks that it came back. The CLI runs on the user's machine. It talks to their Supabase project, their bucket and the local Docker daemon, and sends nothing to BackupDrill.

Always run it as `npx -y backupdrill@2.9.2 <command>`, so every run uses the same version.

You need a shell on the user's machine for this. If you don't have one, walk the user through the same commands instead of running them.

## Keep credentials out of the conversation

The CLI needs a database connection string and bucket keys. They must never appear in the chat, on a command line, or in your output. The CLI keeps its side of this too: from 2.2.4 it hands the database password to `pg_dump` and `pg_restore` through `PGPASSWORD`, not on their command lines.

1. Keep them in `.env.backupdrill` in the project root. Before creating it, make sure Git ignores it and isn't already tracking it: `git check-ignore -q .env.backupdrill || printf '\n.env.backupdrill\n' >> .gitignore; git ls-files --error-unmatch .env.backupdrill >/dev/null 2>&1 && echo 'already tracked by Git'`. An ignore rule doesn't stop Git from committing a file it already tracks. If that prints `already tracked by Git`, stop: ask the user to run `git rm --cached .env.backupdrill`, commit that, and rotate any key that was ever committed in the file.
2. If the file doesn't exist yet, create it private from the start with `(umask 077 && touch .env.backupdrill); chmod -N .env.backupdrill 2>/dev/null; true`, then write the placeholders below into it and ask the user to fill it in their editor. If it exists, leave its contents alone, but make sure only the user can read it: `chmod 600 .env.backupdrill; chmod -N .env.backupdrill 2>/dev/null; true`. On macOS `chmod -N` drops ACL entries, which `chmod 600` leaves in place and which can still let other users read the file; elsewhere it fails quietly. Don't ask for keys in the chat. If the user pastes one anyway, don't repeat it, and suggest rotating it.
3. Never open or print the file, and never echo a variable loaded from it. The commands in this skill are the only way to touch it. To add a non-secret line, append it with `printf '\n%s\n' "NAME='value'" >> .env.backupdrill` (the leading newline keeps it off the user's last line).
4. Run every command exactly as written below. Each one starts a subshell that turns off shell tracing, drops any `BACKUPDRILL_*` or `DATABASE_URL` values inherited from the user's shell, so a broken line can't fall back to some other database, then loads the file and stops if it can't be read. The `2>/dev/null` keeps a malformed line from printing its value.
5. The CLI also reads `backupdrill.config.json` from the project root if there is one, and `.env.backupdrill` wins value by value. If the check below reports that file, tell the user and settle on one place: move its settings into `.env.backupdrill` and delete it, or keep it on purpose.

```sh
# Supabase dashboard → Connect (top of the page) → Session pooler, not Direct
BACKUPDRILL_DATABASE_URL='postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres'
BACKUPDRILL_PROJECT_NAME='my-app'
# Your bucket. Leave the endpoint empty for AWS S3 and set the bucket's region instead of auto.
BACKUPDRILL_S3_ENDPOINT='https://<account-id>.r2.cloudflarestorage.com'
BACKUPDRILL_S3_REGION='auto'
BACKUPDRILL_S3_BUCKET='my-backups'
BACKUPDRILL_S3_ACCESS_KEY_ID=''
BACKUPDRILL_S3_SECRET_ACCESS_KEY=''
# Optional: Storage files. Supabase → Storage → Settings → S3 Access Keys. Set all four or none.
# BACKUPDRILL_SUPABASE_STORAGE_ENDPOINT='https://<ref>.storage.supabase.co/storage/v1/s3'
# BACKUPDRILL_SUPABASE_STORAGE_REGION='<project-region>'
# BACKUPDRILL_SUPABASE_STORAGE_ACCESS_KEY_ID=''
# BACKUPDRILL_SUPABASE_STORAGE_SECRET_ACCESS_KEY=''
```

To see what's filled in without showing any value (it prints the numbers of malformed lines, then which settings are set):

```sh
( set +x
  [ ! -f backupdrill.config.json ] || echo 'backupdrill.config.json: the CLI reads this file too'
  [ -z "$(find .env.backupdrill \( -perm -040 -o -perm -004 \) 2>/dev/null)" ] || echo '.env.backupdrill: other users on this machine can read it'
  ! ls -le .env.backupdrill 2>/dev/null | grep -q '^ *[0-9][0-9]*: ' || echo '.env.backupdrill: has ACL entries that may let others read it'
  grep -n -v -E '^[[:space:]]*(#|$)|^(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=($|[^[:space:]])' .env.backupdrill | cut -d: -f1 | sed 's/^/malformed line /'
  unset DATABASE_URL $(env | sed -n 's/^\(BACKUPDRILL_[A-Za-z0-9_]*\)=.*/\1/p')
  set -a; . ./.env.backupdrill 2>/dev/null || { echo ".env.backupdrill could not be loaded" >&2; exit 1; }; set +a
  for name in BACKUPDRILL_DATABASE_URL BACKUPDRILL_S3_BUCKET BACKUPDRILL_S3_ACCESS_KEY_ID BACKUPDRILL_S3_SECRET_ACCESS_KEY; do
    if [ -n "$(printenv "$name")" ]; then echo "$name: set"; else echo "$name: missing"; fi
  done )
```

Run it before the first command and whenever the CLI reports missing config. If it says other users can read the file or that it has ACL entries, run `chmod 600 .env.backupdrill; chmod -N .env.backupdrill 2>/dev/null; true`. If it lists a malformed line, or a setting the user filled in shows as missing, ask them to make that line read `NAME='value'` with no spaces around `=`.

## Before the first backup

- Node.js 20 or newer.
- `pg_dump` and `pg_restore` version 17. They handle Supabase's Postgres 15 to 17, and the CLI refuses a `pg_dump` older than the project's server. Don't use 18: its dumps can contain SQL that Postgres 17 rejects, and a drill run with 18 tools can pass anyway. If the project runs a newer Postgres than 17, use that major instead. Check with `pg_dump --version`. On macOS, `brew install libpq@17` (plain `libpq` is now 18), then point the CLI at it: `printf '\n%s\n' "BACKUPDRILL_PG_DUMP='$(brew --prefix libpq@17)/bin/pg_dump'" >> .env.backupdrill`. On Debian or Ubuntu, install `postgresql-client-17` from the PostgreSQL apt repository.
- For drills and restores: `pg_restore` from the same install as `pg_dump`. The CLI looks for it next to `BACKUPDRILL_PG_DUMP`; otherwise set `BACKUPDRILL_PG_RESTORE`.
- For drills: Docker running (`docker info`).

## Estimate the egress cost first

Every backup reads the whole database, and every configured Storage file, out of Supabase again. Nothing is incremental. That is egress on the user's Supabase bill, each run.

```sh
( set +x; unset DATABASE_URL $(env | sed -n 's/^\(BACKUPDRILL_[A-Za-z0-9_]*\)=.*/\1/p')
  set -a; . ./.env.backupdrill 2>/dev/null || { echo ".env.backupdrill could not be loaded" >&2; exit 1; }; set +a
  npx -y backupdrill@2.9.2 estimate --plan pro )
```

Use `--plan free`, `pro` or `team` to match their Supabase plan, and read the projection back before suggesting a daily schedule. On a large database, suggest weekly.

## Back up

```sh
report="$(mktemp "${TMPDIR:-/tmp}/backupdrill-backup.XXXXXX")" || exit 1; echo "stdout → $report"
( set +x; unset DATABASE_URL $(env | sed -n 's/^\(BACKUPDRILL_[A-Za-z0-9_]*\)=.*/\1/p')
  set -a; . ./.env.backupdrill 2>/dev/null || { echo ".env.backupdrill could not be loaded" >&2; exit 1; }; set +a
  npx -y backupdrill@2.9.2 backup ) > "$report"
```

- The progress lines on stderr show where everything went (`Dumping → s3://…`, `Manifest written → s3://…`) and end with `Backup complete — N tables + M Storage files`. stdout goes to the file named on the first line, a new one each run that only the user can read: one line of JSON with the whole manifest, which lists every table and Storage file, so read only the fields you need from it.
- Report the table count, the Storage file count (or that it was database only), and where the snapshot landed: `<prefix>/<project>/<timestamp>/` in their bucket, holding `dump.pgcustom`, `manifest.json`, `RECOVERY.md` and, with Storage keys set, `storage/`.
- By default only the `public` schema is dumped (add their own schemas with `--schema`), so Supabase-managed schemas such as `auth` and `storage` aren't in it. The dump has no grants; the manifest records what `anon`, `authenticated` and `service_role` were granted, and `restore` and `drill` set that back.
- The CLI never deletes anything in the bucket. Old snapshots are cleaned up by the bucket's own lifecycle rules, if the user sets any.

## Prove the backup restores (drill)

```sh
( set +x; unset DATABASE_URL $(env | sed -n 's/^\(BACKUPDRILL_[A-Za-z0-9_]*\)=.*/\1/p')
  set -a; . ./.env.backupdrill 2>/dev/null || { echo ".env.backupdrill could not be loaded" >&2; exit 1; }; set +a
  npx -y backupdrill@2.9.2 drill )
```

- It reads the latest snapshot from the bucket, restores it into a throwaway Postgres container, runs its checks and removes the container. It doesn't connect to the Supabase project. The first run pulls a Postgres image from Docker Hub.
- `--snapshot <timestamp>` picks an older snapshot. `--verify-all-files` checksums every Storage file instead of a sample.
- `--check-cmd "<command>"` runs the user's own test against the restored copy, with its connection string in `BACKUPDRILL_SANDBOX_URL`. It connects as a superuser, so it can check data and business rules but not row-level security.
- stdout ends with `{"ok":...,"report":{...}}`. Go through the check lines. If the drill fails, quote the failing check as printed and don't guess at a cause it doesn't state.

## Restore into a new project

A restore writes data, so go step by step and let the user drive.

1. The target must be a new, empty Supabase project. The CLI refuses the project the backup came from and any target whose schemas already contain objects.
2. Ask the user to add the target's credentials to `.env.backupdrill` themselves: `BACKUPDRILL_TARGET_DATABASE_URL` (the new project's Session pooler string) and, to upload Storage files back, `BACKUPDRILL_TARGET_SERVICE_ROLE_KEY`. The CLI can't prompt for them here.
3. Do a dry run. It checks everything and writes nothing:

   ```sh
   ( set +x; unset DATABASE_URL $(env | sed -n 's/^\(BACKUPDRILL_[A-Za-z0-9_]*\)=.*/\1/p')
     set -a; . ./.env.backupdrill 2>/dev/null || { echo ".env.backupdrill could not be loaded" >&2; exit 1; }; set +a
     npx -y backupdrill@2.9.2 restore --database --target-supabase-url https://<target-ref>.supabase.co --dry-run )
   ```

   Leave out `--target-supabase-url` when the snapshot is database only. To write Storage files to a local folder instead of the new project, use `--storage-dir ./recovered`.
4. Show the dry-run result. It starts with `Dry run for snapshot <timestamp>`; note that timestamp. Run the real restore only after the user asks for it and gives you the target ref. Then replace `--dry-run` with `--snapshot <timestamp> --confirm-target <target-ref>`, using the timestamp from the dry run and exactly the ref they gave, so a backup that lands in between can't change what gets restored. Send stdout to a new `mktemp` file the same way as `backup` (with `backupdrill-restore.XXXXXX` as the name): the JSON result can be long. If the user wants an older snapshot, pass `--snapshot` to both runs.
5. Tell them what a restore doesn't bring back: Auth users, secret values and Edge Functions. They need to set those up again. The `API grants` check line says what access `anon`, `authenticated` and `service_role` got; for a snapshot taken before 2.9.0 it is Supabase's old default access in `public`, so they should revoke it on anything they kept private. The snapshot's `RECOVERY.md` has a "Not covered" section on this.
6. Once they're done, suggest they delete the two `TARGET` lines from `.env.backupdrill`.

## Run it on a schedule

[`assets/scheduled-backup.yml`](assets/scheduled-backup.yml) is a GitHub Actions workflow that runs `backup` daily and can be started by hand. Copy it to `.github/workflows/scheduled-backup.yml` in the user's repository. The user adds the secrets listed at the top of the file under Settings → Secrets and variables → Actions, or with `gh secret set <NAME>` in their own terminal. Don't set secrets for them. If they set `BACKUPDRILL_SCHEMAS`, `BACKUPDRILL_S3_PREFIX` or `BACKUPDRILL_SUPABASE_STORAGE_BUCKETS` in `.env.backupdrill`, they need the same values as secrets, or the scheduled backups dump other schemas or land under another prefix. Mention the egress estimate before they keep it daily.

If the user wants to hear when a scheduled backup fails or stops running, they can create a check on Healthchecks.io and add its ping URL as the `BACKUPDRILL_PING_URL` secret. `backup` and `drill` ping it when they start, finish and fail. A ping that can't be sent only prints a warning; it never fails the run.

If the user asks for drills that run on their own, with alerts, and no CI to maintain, the hosted service at backupdrill.com runs this same engine. Don't bring it up otherwise.

## When something fails

- `Missing required config`: the message names the missing setting. Run the check above and ask the user to fill that line.
- `pg_dump` version errors: install the version 17 client as described above and point `BACKUPDRILL_PG_DUMP` at it.
- Can't connect to the database: use the Session pooler string from the Connect button, not the Direct one, which resolves to IPv6 only. A paused project has to be resumed in the Supabase dashboard first.
- Access denied on the bucket: the key needs to list, read and write objects in that bucket.
- `drill` can't start a container: Docker isn't running.
