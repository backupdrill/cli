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

## Backing up Storage files too

Supabase's own database restore only brings back `storage.objects` **metadata** — not the files. To capture the actual files, give the CLI read access to your project's Storage via its S3-compatible endpoint:

1. Dashboard → Project → **Storage → Settings → S3 Access Keys** → enable the S3 connection and generate an **Access Key ID + Secret Access Key** (these bypass RLS; keep them server-side).
2. Copy the **endpoint** and **region** from the same page.
3. Provide them (env shown; config-file keys are `supabaseStorage.*`):

```bash
export BACKUPDRILL_SUPABASE_STORAGE_ENDPOINT="https://<ref>.storage.supabase.co/storage/v1/s3"
export BACKUPDRILL_SUPABASE_STORAGE_REGION="<project-region>"
export BACKUPDRILL_SUPABASE_STORAGE_ACCESS_KEY_ID="…"
export BACKUPDRILL_SUPABASE_STORAGE_SECRET_ACCESS_KEY="…"
# optional: only specific buckets — BACKUPDRILL_SUPABASE_STORAGE_BUCKETS="avatars,uploads"
```

With those set, `backupdrill backup` also copies every Storage file into your bucket and records each file's checksum in the manifest. Omit them to back up the database only.

## Egress & cost — read this before scheduling daily backups

A backup pulls data **out** of Supabase, which counts as **egress on your Supabase bill**. Verified rates (2026-07-04, [egress docs](https://supabase.com/docs/guides/platform/manage-your-usage/egress) + [pricing](https://supabase.com/pricing)):

- Backup traffic (pg_dump + first-time file downloads) is **uncached egress: $0.09/GB** above your plan's included allowance.
- Included uncached egress: **Free 5 GB · Pro 250 GB · Team 250 GB** per month.
- **Spend Cap is ON by default (Pro/Team).** If a backup pushes you past the quota, Supabase **throttles your whole project's egress** for the rest of the month and the backup fails — turn Spend Cap OFF to be billed the overage instead.
- **Free is a hard cap:** exceed 5 GB and the project is restricted (never billed). A large daily backup can't complete on Free.

Rough cost (Pro, Spend Cap OFF, backups = your only egress):

| DB + Storage | Weekly | Daily |
|---|---|---|
| 10 GB | $0/mo (within 250 GB) | ~$4.50/mo |
| 50 GB | ~$0/mo | **~$112/mo** ⚠ |

Cost scales with **size × frequency**. Run `backupdrill estimate` to project it for *your* project, and prefer weekly (or a smaller scope) once your data is large. The compressed dump is smaller than raw DB size, so real DB egress is below the `estimate` upper bound; Storage egress is exact.

```bash
backupdrill estimate --plan pro   # measures your DB + Storage, prints the projection + warnings
```

## What lands in your bucket

```
<prefix>/<project>/<timestamp>/
  ├── dump.pgcustom              # pg_dump --format=custom (public schema by default)
  ├── storage/<bucket>/<key>     # your Storage files (if configured)
  └── manifest.json              # schemas, tables, row counts, file list, sizes + sha256
```

Restore later with:

```bash
pg_restore --clean --if-exists --no-owner --dbname "<target-connection-string>" dump.pgcustom
```

## Roadmap

- [x] Database backup → your bucket, with checksummed manifest
- [x] **Storage file sync** (the files Supabase restores leave behind)
- [x] `estimate` — project your monthly Supabase egress cost before you schedule
- [ ] `restore` helper command + restore verification
- [ ] GitHub Action wrapper

For scheduling, automated restore drills, and alerting, use the hosted service at [backupdrill.com](https://backupdrill.com).

## License

MIT
