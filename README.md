# backupdrill

Open-source CLI to back up a **Supabase** project to **your own** S3/R2/B2 bucket — the Postgres database now, Storage files next — with a checksummed `manifest.json` so you can prove what was captured.

Backups stream through the CLI on your machine (or your CI) straight to your bucket. **Your data never touches our servers, because there are none — this is just a CLI.**

> Want this on a schedule, with **restore drills that prove your backup actually restores**, plus Storage-file backup and alerts? That's the hosted service → **[backupdrill.com](https://backupdrill.com)**. This CLI is the DIY layer; the cloud adds scheduling, drills, alerting, and reports on top.

## Why

- Supabase's own database restore only brings back `storage.objects` **metadata**, not your actual Storage files.
- Pro-plan backups keep 7 days and can't be pulled into your own infrastructure; PITR is $100/mo per project.
- A `pg_dump` you've never restored is a guess.

This CLI gets your database into a bucket **you** control, with a manifest you can check.

## Requirements

- Node.js ≥ 20
- `pg_dump` whose **major version ≥ your Supabase Postgres version** (Supabase runs PG 15–17). On macOS: `brew install libpq` then add it to `PATH`, or point `BACKUPDRILL_PG_DUMP` at the binary. The CLI checks this and refuses to run a mismatched dump.

## Install

```bash
npm install -g backupdrill
# or run without installing:
npx backupdrill backup
```

## Usage

Configure via **env vars**, a **config file**, or **flags** (precedence: flags > env > file).

### Env vars

```bash
export BACKUPDRILL_DATABASE_URL="postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres"
export BACKUPDRILL_PROJECT_NAME="my-app"
export BACKUPDRILL_S3_ENDPOINT="https://<account>.r2.cloudflarestorage.com"  # omit for AWS S3
export BACKUPDRILL_S3_REGION="auto"
export BACKUPDRILL_S3_BUCKET="my-backups"
export BACKUPDRILL_S3_ACCESS_KEY_ID="…"
export BACKUPDRILL_S3_SECRET_ACCESS_KEY="…"

backupdrill backup
```

### Config file

Copy `backupdrill.config.example.json` → `backupdrill.config.json` (it's gitignored) and fill it in. Keep secrets in env vars even when using a file.

```bash
backupdrill backup --config backupdrill.config.json
```

## Get the connection string & a least-privilege role

Use the **Session Pooler** string from your Supabase dashboard (Project Settings → Database → Connection string → Session pooler).

For backups you only need read access. Create a dedicated read-only role and use it instead of the `postgres` superuser:

```sql
create role backup_reader with login password 'a-strong-password';
grant usage on schema public to backup_reader;
grant select on all tables in schema public to backup_reader;
alter default privileges in schema public grant select on tables to backup_reader;
```

## What lands in your bucket

```
<prefix>/<project>/<timestamp>/
  ├── dump.pgcustom     # pg_dump --format=custom
  └── manifest.json     # tables, estimated row counts, dump size + sha256
```

Restore later with:

```bash
pg_restore --clean --if-exists --no-owner --dbname "<target-connection-string>" dump.pgcustom
```

## Roadmap

- [x] Database backup → your bucket, with checksummed manifest
- [ ] **Storage file sync** (the files Supabase restores leave behind)
- [ ] `restore` helper command + restore verification
- [ ] GitHub Action wrapper

For scheduling, automated restore drills, and alerting, use the hosted service at [backupdrill.com](https://backupdrill.com).

## License

MIT
