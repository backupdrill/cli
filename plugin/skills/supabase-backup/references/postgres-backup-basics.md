# Supabase backups without the CLI: pg_dump, pg_restore and the Free plan

Read this when the user asks what Supabase already backs up for them, wants a plain `pg_dump` backup instead of the CLI, or wants to test a restore by hand. The commands here are what `backupdrill backup` and `backupdrill drill` automate.

## What Supabase keeps for you

- **Free plan:** no access to automatic backups. Supabase's docs tell Free projects to export their data themselves (`supabase db dump`) and keep off-site copies. Free projects are paused after a week of inactivity; the pause snapshot lets the user restore the paused project from the dashboard for up to a year.
- **Pro and Team:** daily backups, kept 7 days on Pro and 14 on Team, restorable from the dashboard. On the physical backup process that current projects use they can't be downloaded. Point-in-time recovery is a paid add-on: about $100/month per project for 7 days of history, and it needs a Small compute add-on or larger.
- **Storage files are not in any database backup.** A database restore brings back the `storage.objects` rows, which only point at files. The files themselves need a separate copy (the CLI copies them once the Storage S3 keys are set).

Every backup taken from outside the project counts as egress on the user's Supabase bill. Free includes 5 GB a month, shared with whatever the app already serves. Run `backupdrill estimate --plan free` for an upper-bound estimate of the project's backup egress. As a rough guide, if each run transfers 500 MB (the Free database limit), weekly backups use about 2 GB a month and daily ones about 15 GB, three times the allowance.

## Use the Session pooler connection string

In the dashboard, **Connect** → **Session pooler**: port 5432, user `postgres.<project-ref>`. Copy the host from there as it is; it can't be worked out from the region. Without the IPv4 add-on, the direct connection needs IPv6, so on an IPv4-only home or CI network it won't connect. Don't use port 6543, the transaction pooler: `pg_dump` needs a session.

## Match client and server versions

- `pg_dump`'s major version must be at least the server's. Supabase runs Postgres 15 to 17, so a version 17 client covers all of them. Check with `pg_dump --version`.
- `pg_restore` must be at least as new as the `pg_dump` that wrote the archive. Archives from `pg_dump` 18 can contain SQL that Postgres 17 rejects, so stay on 17 unless the project runs something newer.

## A plain backup

Keep the password off the command line, where other users on the machine can see it in the process list. Ask the user to add one line to `~/.pgpass` themselves and make the file private (`chmod 600 ~/.pgpass`); `pg_dump`, `pg_restore` and `psql` read it, so the connection string carries no password:

```
<pooler-host>:5432:postgres:postgres.<project-ref>:<password>
```

In that file a `:` or `\` inside the password has to be written as `\:` or `\\`.

```sh
export DB_URL="postgresql://postgres.<project-ref>@<pooler-host>:5432/postgres?sslmode=require"
export BACKUP_FILE="backup-$(date +%Y%m%dT%H%M%S).dump"

# umask 077 in a subshell: the dump is production data, so only the user can read it
( umask 077 && pg_dump "$DB_URL" --format=custom --schema=public --file="$BACKUP_FILE" ) \
&& pg_restore --list "$BACKUP_FILE" > /dev/null && echo "archive is readable"
```

- `sslmode=require` encrypts the connection. To also check the server's certificate, download the CA certificate from the project's database settings (SSL Configuration) and use `sslmode=verify-full&sslrootcert=<path to the certificate>`.
- `--format=custom` writes an archive that only `pg_restore` reads; it allows selective and parallel restores. A plain-text dump goes through `psql` instead.
- `--schema=public` leaves out Supabase-managed schemas, including `auth`, so Auth users aren't in this file. Add `--schema=<name>` for each of the app's own schemas.
- With `--schema`, `pg_dump` also leaves out large objects (the `lo_*` / `oid` kind, not Storage files). If the app uses them, add `--large-objects`.
- Never ask for the password in the chat. With the CLI, it lives in `.env.backupdrill` as `SKILL.md` describes.

## Test the restore by hand

A dump that has never been restored is a guess. Restore it into a throwaway Postgres and look at the data. Start the container and wait until it accepts connections:

```sh
# docker run can print an ID and still fail (port taken), so only a zero exit counts
cid="$(docker run -d --rm -e POSTGRES_PASSWORD=drill -p 127.0.0.1:55432:5432 postgres:17-alpine)" || cid=""
[ -n "$cid" ] \
&& for i in $(seq 60); do docker exec "$cid" pg_isready -q -h 127.0.0.1 -U postgres && break; sleep 1; done \
&& docker exec "$cid" pg_isready -h 127.0.0.1 -U postgres
echo "container: ${cid:-not started}"
```

If it prints `container: not started` (port 55432 already taken, for example) or the last `pg_isready` says `no response`, stop and fix that first. Then restore and check:

```sh
export TEST_DB="postgresql://postgres:drill@127.0.0.1:55432/postgres"

# The dump creates schema public itself, so drop the empty one first. Then add stand-ins
# for what a Supabase project provides, so policies that mention them restore.
# --no-privileges skips GRANT and REVOKE: this test checks the data, not who can read it.
psql "$TEST_DB" --set ON_ERROR_STOP=1 -c "
  drop schema public;
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create function auth.uid()   returns uuid  language sql stable as 'select null::uuid';
  create function auth.role()  returns text  language sql stable as 'select null::text';
  create function auth.email() returns text  language sql stable as 'select null::text';
  create function auth.jwt()   returns jsonb language sql stable as 'select null::jsonb';" \
&& pg_restore --no-owner --no-privileges --dbname "$TEST_DB" "$BACKUP_FILE"

psql "$TEST_DB" -c "select count(*) from pg_tables where schemaname = 'public';"
psql "$TEST_DB" -c "select count(*) from public.<a table that must never be empty>;"
```

When you're done, remove only the container you started: `docker rm -f "$cid"`.

- `pg_restore` keeps going after an error and prints how many it ignored at the end. Read every error. The one expected failure is a foreign key to `auth.users` (a `profiles` table usually has one): this dump has no Auth users, so the constraint can't be created here. Anything else is a failed test.
- Compare the table count and a few row counts with the same queries on production. For a table that only grows, `max(created_at)` shows how recent the backup is.
- If the schema uses extensions, the restore fails on the first object that needs one the container doesn't have. Install the missing extension in the container first. The CLI's drill tries to install the extensions listed in the snapshot's manifest and reports any its container can't install; a restore can still fail on those.

## What the CLI adds

`backupdrill backup` runs the same `pg_dump`, copies Storage files, and writes a checksummed `manifest.json` and a `RECOVERY.md` next to the dump in the user's bucket. `backupdrill drill` does the restore test above against the latest snapshot in that bucket and reports each check. The full command reference is at [backupdrill.com/docs/cli](https://backupdrill.com/docs/cli).
