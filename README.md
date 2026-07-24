# backupdrill

Open-source CLI to back up a **Supabase** project to **your own** S3/R2/B2 bucket — the Postgres database **and** Storage files, together — with a checksummed `manifest.json` so you can prove what was captured.

Backups stream through the CLI on your machine (or your CI) straight to your bucket. **Your data never touches our servers, because there are none — this is just a CLI.**

> Want this on a schedule, with **restore drills that prove your backup actually restores**, plus alerts and reports? That's the hosted service → **[backupdrill.com](https://backupdrill.com)**. This CLI is the DIY layer; the cloud adds scheduling, drills, alerting, and reports on top.

🎥 Prefer watching? [Where do your backups actually go — explained in about a minute](https://backupdrill.com/guides/test-supabase-backup-restore#explainer-video).

## Why

- Supabase's own database restore only brings back `storage.objects` **metadata**, not your actual Storage files.
- Pro-plan backups keep 7 days and can't be pulled into your own infrastructure; PITR is $100/month per project.
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

All recognized variables:

| Variable | Purpose | Default |
|---|---|---|
| `BACKUPDRILL_DATABASE_URL` | Source connection string (falls back to `DATABASE_URL`) | — (required) |
| `BACKUPDRILL_PROJECT_NAME` | Readable name used in object keys and the manifest | `supabase` |
| `BACKUPDRILL_SCHEMAS` | Comma-separated schemas to dump | `public` |
| `BACKUPDRILL_S3_ENDPOINT` | S3-compatible endpoint (R2/B2/self-hosted; omit for AWS S3) | — |
| `BACKUPDRILL_S3_REGION` | Destination bucket region | `auto` |
| `BACKUPDRILL_S3_BUCKET` | Destination bucket | — (required) |
| `BACKUPDRILL_S3_ACCESS_KEY_ID`, `BACKUPDRILL_S3_SECRET_ACCESS_KEY` | Destination credentials | — (required) |
| `BACKUPDRILL_S3_PREFIX` | Key prefix inside the bucket | `backupdrill` |
| `BACKUPDRILL_S3_FORCE_PATH_STYLE` | `true`/`false` — path-style addressing (R2/MinIO) | `true` when an endpoint is set |
| `BACKUPDRILL_SUPABASE_STORAGE_*` | Storage-file source (endpoint/region/keys/buckets) — see [Backing up Storage files](#backing-up-storage-files-too) | — |
| `BACKUPDRILL_PG_DUMP` | Path to the `pg_dump` binary to use | `pg_dump` on `PATH` |
| `BACKUPDRILL_PG_RESTORE` | Path to `pg_restore` (used by `drill` and `restore`) | next to `BACKUPDRILL_PG_DUMP`, else `pg_restore` on `PATH` |

### Config file

Copy `backupdrill.config.example.json` → `backupdrill.config.json` (it's gitignored) and fill it in. Keep secrets in env vars even when using a file. To also back up Storage files, start from `backupdrill.config.with-storage.example.json` instead — only copy the `supabaseStorage` block once you actually have S3 access keys for your project's Storage.

```bash
backupdrill backup --config backupdrill.config.json
```

## Get the connection string

Use the **Session Pooler** string from your Supabase dashboard (Project Settings → Database → Connection string → Session pooler). The default `postgres` user works as-is — it owns your tables, so `pg_dump` passes row-level security.

**Least-privilege role (advanced, usually not viable on Supabase):** `pg_dump` needs `select` on *sequences* too, and it **errors on any RLS-enabled table the role can't bypass** — and most Supabase tables have RLS on, while `bypassrls` can't be granted without superuser. Only use a dedicated role if your schema has no RLS tables:

```sql
-- replace <generate-a-strong-password> before running
create role backup_reader with login password '<generate-a-strong-password>';
grant usage on schema public to backup_reader;
grant select on all tables in schema public to backup_reader;
grant select on all sequences in schema public to backup_reader;
alter default privileges in schema public grant select on tables to backup_reader;
alter default privileges in schema public grant select on sequences to backup_reader;
```

## Backing up Storage files too

Supabase's own database restore only brings back `storage.objects` **metadata** — not the files. To capture the actual files, give the CLI read access to your project's Storage via its S3-compatible endpoint:

1. Dashboard → Project → **Storage → Settings → S3 Access Keys** → enable the S3 connection and generate an **Access Key ID + Secret Access Key** (these bypass RLS; keep them server-side).
2. Copy the **endpoint** and **region** from the same page.
3. Provide them (env shown; config-file keys are `supabaseStorage.*` — see `backupdrill.config.with-storage.example.json`):

```bash
export BACKUPDRILL_SUPABASE_STORAGE_ENDPOINT="https://<ref>.storage.supabase.co/storage/v1/s3"
export BACKUPDRILL_SUPABASE_STORAGE_REGION="<project-region>"
export BACKUPDRILL_SUPABASE_STORAGE_ACCESS_KEY_ID="…"
export BACKUPDRILL_SUPABASE_STORAGE_SECRET_ACCESS_KEY="…"
# optional: only specific buckets — BACKUPDRILL_SUPABASE_STORAGE_BUCKETS="avatars,uploads"
```

With those set, `backupdrill backup` also copies every Storage file into your bucket and records each file's checksum in the manifest. Omit them to back up the database only.

## Egress & cost — read this before scheduling daily backups

A backup pulls data **out** of Supabase, which counts as **egress on your Supabase bill**. Verified rates (2026-07-10, [egress docs](https://supabase.com/docs/guides/platform/manage-your-usage/egress) + [pricing](https://supabase.com/pricing)):

- Backup traffic (pg_dump + first-time file downloads) is **uncached egress: $0.09/GB** above your plan's included allowance.
- Included uncached egress: **Free 5 GB · Pro 250 GB · Team 250 GB** per month.
- **Spend Cap is ON by default (Pro/Team).** If a backup pushes you past the quota, Supabase **throttles your whole project's egress** for the rest of the month and the backup fails — turn Spend Cap OFF to be billed the overage instead.
- **Free never bills overage.** Exceeding the included 5 GB/month starts Supabase's Fair Use process: a notification to your billing email, then a grace period, then egress restrictions if usage stays over (the restriction clears at the next billing cycle or when you upgrade). Sustained large backups are not viable on Free.

Rough cost (Pro, Spend Cap OFF, backups = your only egress):

| DB + Storage | Weekly | Daily |
|---|---|---|
| 10 GB | $0/month (within 250 GB) | ~$4.50/month |
| 50 GB | ~$0/month | **~$112/month** ⚠ |

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

## Restoring & drilling

Prove a backup is restorable, without touching anything real — `drill` restores the latest snapshot into a throwaway Postgres and checks it. It needs **Docker** (for the throwaway Postgres) and **`pg_restore`** (same major-version rule as `pg_dump`; set `BACKUPDRILL_PG_RESTORE` if it's not on your `PATH`):

```bash
backupdrill drill                    # latest snapshot; add --snapshot <timestamp> to pick one
backupdrill drill --verify-all-files # also checksum every Storage file, not just a sample
```

Backups record your installed Postgres extensions in the manifest, and the drill pre-installs them in the sandbox before restoring — including switching to a pgvector-enabled sandbox image when your database uses `vector` columns.

### Run your own checks against the restored copy

The drill's structural checks (tables, rows, checksums) can't know what "working" means for *your* app — business invariants only have answers in your code. `--check-cmd` hands you the restored sandbox before it's destroyed:

```bash
backupdrill drill --check-cmd "npm run smoke"   # BACKUPDRILL_SANDBOX_URL points at the restored copy
```

Your command runs after all structural checks pass, with `BACKUPDRILL_SANDBOX_URL` set to the sandbox's connection string. Exit 0 means pass; the result shows up in the report as an `app checks` line, and a non-zero exit fails the drill (the report keeps structural and app-level failures clearly separate). Entirely optional — without the flag, nothing changes and the report has no `app checks` line. There's a 10-minute timeout (the whole process tree is killed), and `--keep` leaves the sandbox container running when a drill fails so you can inspect it — the report JSON then includes a `keptSandbox` object with the container id and connection string (`docker rm -f <id>` when done).

**What this can and cannot verify, honestly:** `BACKUPDRILL_SANDBOX_URL` connects as the sandbox **superuser**, and superusers bypass row-level security — plus policies referencing Supabase-managed roles (`authenticated`, `anon`) are skipped during restore, since those roles don't exist outside the platform. So use `--check-cmd` for data and business invariants ("orders reference existing users", "the row count I care about is sane"). It is **not** an RLS behavior test — verifying RLS takes an authenticated client stack with real JWTs, which no restore sandbox can fake generically.

When you actually need to recover, `restore` puts the database back into a target you name and pulls the Storage files down to a local folder:

```bash
backupdrill restore \
  --target-database-url "postgresql://…/postgres" \
  --storage-dir ./recovered
```

Or restore the dump by hand — into an **empty** database, without `--clean`:

```bash
pg_restore --no-owner --no-privileges --dbname "<target-connection-string>" dump.pgcustom
```

Don't use `--clean` against a Supabase project: dropping and recreating the `public`
schema silently wipes Supabase's default grants for `anon`/`authenticated` (the dump
carries no ACLs), leaving the restored API returning 401s. One error is expected and
harmless: `schema "public" already exists` — the target always has it. The
`backupdrill restore` command above handles all of this (plus verification) for you.

## GitHub Action / scheduled backups

Want this running on a schedule without paying for a server? Run it in GitHub Actions.

1. Copy [`examples/scheduled-backup.yml`](examples/scheduled-backup.yml) into **your own** repo at `.github/workflows/scheduled-backup.yml`. (It lives under `examples/` here so GitHub doesn't try to run it in this repo — it's a template.) It runs daily and can also be triggered by hand from the Actions tab. The workflow installs `postgresql-client-17` from the PGDG apt repo (so `pg_dump`'s major version matches Supabase) and points the CLI at it via `BACKUPDRILL_PG_DUMP`.
2. Add these repo secrets (Settings → Secrets and variables → Actions):
   - **Required:** `BACKUPDRILL_DATABASE_URL`, `BACKUPDRILL_S3_BUCKET`, `BACKUPDRILL_S3_ACCESS_KEY_ID`, `BACKUPDRILL_S3_SECRET_ACCESS_KEY`
   - **Optional (destination):** `BACKUPDRILL_S3_ENDPOINT` (for R2/B2), `BACKUPDRILL_S3_REGION`, `BACKUPDRILL_PROJECT_NAME`
   - **Optional (Storage files):** set all four of `BACKUPDRILL_SUPABASE_STORAGE_ENDPOINT`, `BACKUPDRILL_SUPABASE_STORAGE_REGION`, `BACKUPDRILL_SUPABASE_STORAGE_ACCESS_KEY_ID`, `BACKUPDRILL_SUPABASE_STORAGE_SECRET_ACCESS_KEY` to also back up Storage files; leave them unset to back up the database only.

Before switching to a **daily** schedule, read the egress-cost section above — every run is egress on your Supabase bill.

## Roadmap

- [x] Database backup → your bucket, with checksummed manifest
- [x] **Storage file sync** (the files Supabase restores leave behind)
- [x] `estimate` — project your monthly Supabase egress cost before you schedule
- [x] `drill` — restore a snapshot into an ephemeral Postgres and prove it comes back
- [x] Storage-file integrity check inside the drill (checksums, sampled by default)
- [x] `restore` — recover a snapshot into a target DB + pull Storage files down
- [x] GitHub Action wrapper

For scheduling, automated restore drills, and alerting, use the hosted service at [backupdrill.com](https://backupdrill.com).

## Versioning & stability

`backupdrill` follows [semantic versioning](https://semver.org/). From **1.0.0** onwards the
following is the stable public surface — breaking it requires a major version bump:

- the commands (`backup`, `drill`, `restore`, `estimate`) and their flags
- the `BACKUPDRILL_*` environment variables and the config-file keys
- the layout written to your bucket, and the shape of `manifest.json`

`manifest.json` carries a `schemaVersion` so the format can evolve safely. A snapshot written by
a newer release is **refused with a clear message** rather than parsed on a best-effort basis —
for a backup tool, silently misreading an archive is the worst possible failure. Snapshots taken
before 1.0 have no `schemaVersion` and are treated as version 1, so older backups stay readable.

The package's **JavaScript exports are internal** to the hosted BackupDrill product and are not
covered by this promise; they may change in any release. Use the CLI if you need a stable contract.

## License

MIT
