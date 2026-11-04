# Supabase backups without the CLI: pg_dump, pg_restore and the Free plan

Read this when the user asks what Supabase already backs up for them, wants a plain `pg_dump` backup instead of the CLI, or wants to test a restore by hand. The commands here are what `backupdrill backup` and `backupdrill drill` automate.

## What Supabase keeps for you

- **Free plan:** no access to automatic backups. Supabase's docs tell Free projects to export their data themselves (`supabase db dump`) and keep off-site copies. Free projects are paused after a week of inactivity; the pause snapshot lets the user restore the paused project from the dashboard for up to a year.
- **Pro and Team:** daily backups, kept 7 days on Pro and 14 on Team, restorable from the dashboard. On the physical backup process that current projects use they can't be downloaded. Point-in-time recovery is an add-on at $100/month per project.
- **Storage files are not in any database backup.** A database restore brings back the `storage.objects` rows, which only point at files. The files themselves need a separate copy (the CLI copies them once the Storage S3 keys are set).

Every backup taken from outside the project counts as egress on the user's Supabase bill. Free includes 5 GB a month, shared with whatever the app already serves. At the Free plan's 500 MB database limit, a weekly dump is about 2 GB a month, and a daily one would go over.

## Use the Session pooler connection string

In the dashboard, **Connect** → **Session pooler**: port 5432, user `postgres.<project-ref>`. The direct connection is IPv6-only unless the project has the IPv4 add-on, so it fails on most home and CI networks. Don't use port 6543, the transaction pooler: `pg_dump` needs a session.

## Match client and server versions

- `pg_dump`'s major version must be at least the server's. Supabase runs Postgres 15 to 17, so a version 17 client covers all of them. Check with `pg_dump --version`.
- `pg_restore` must be at least as new as the `pg_dump` that wrote the archive. Archives from `pg_dump` 18 can contain SQL that Postgres 17 rejects, so stay on 17 unless the project runs something newer.

## A plain backup

```sh
export DB_URL="postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
export BACKUP_FILE="backup-$(date +%Y%m%dT%H%M%S).dump"

pg_dump "$DB_URL" --format=custom --schema=public --file="$BACKUP_FILE"
pg_restore --list "$BACKUP_FILE" > /dev/null && echo "archive is readable"
```

- `--format=custom` writes an archive that only `pg_restore` reads; it allows selective and parallel restores. A plain-text dump goes through `psql` instead.
- `--schema=public` leaves out Supabase-managed schemas, including `auth`, so Auth users aren't in this file. Add `--schema=<name>` for each of the app's own schemas.
- Keep the password out of shell history and the chat. With the CLI, it lives in `.env.backupdrill` as `SKILL.md` describes.

## Test the restore by hand

A dump that has never been restored is a guess. Restore it into a throwaway Postgres and look at the data:

```sh
docker run -d --rm --name restore-test \
  -e POSTGRES_PASSWORD=drill \
  -p 127.0.0.1:55432:5432 \
  postgres:17-alpine
docker exec restore-test pg_isready -h 127.0.0.1 -U postgres

export TEST_DB="postgresql://postgres:drill@127.0.0.1:55432/postgres"

# Stand-ins for what a Supabase project provides, so policies and grants that mention them restore
psql "$TEST_DB" --set ON_ERROR_STOP=1 -c "
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create function auth.uid()   returns uuid  language sql stable as 'select null::uuid';
  create function auth.role()  returns text  language sql stable as 'select null::text';
  create function auth.email() returns text  language sql stable as 'select null::text';
  create function auth.jwt()   returns jsonb language sql stable as 'select null::jsonb';" \
&& pg_restore --no-owner --no-privileges --dbname "$TEST_DB" "$BACKUP_FILE"

psql "$TEST_DB" -c "select count(*) from pg_tables where schemaname = 'public';"
psql "$TEST_DB" -c "select count(*) from public.<a table that must never be empty>;"

docker rm -f restore-test
```

- `pg_restore` keeps going after an error and prints how many it ignored at the end. Treat any ignored error as a failed test and read the first one.
- Compare the table count and a few row counts with the same queries on production. For a table that only grows, `max(created_at)` shows how recent the backup is.
- If the schema uses extensions, the restore fails on the first object that needs one the container doesn't have. Install it in the container first, or run the CLI's drill, which installs the extensions recorded in the snapshot's manifest before restoring.

## What the CLI adds

`backupdrill backup` runs the same `pg_dump`, copies Storage files, and writes a checksummed `manifest.json` and a `RECOVERY.md` next to the dump in the user's bucket. `backupdrill drill` does the restore test above against the latest snapshot in that bucket and reports each check. The full command reference is at [backupdrill.com/docs/cli](https://backupdrill.com/docs/cli).
