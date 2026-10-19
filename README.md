# backupdrill — free, open-source Supabase backup CLI

Open-source CLI to back up a **Supabase** project to **your own** S3/R2/B2 bucket — the Postgres database and, once you configure its S3 keys, your Storage files — with a checksummed `manifest.json` so you can prove what was captured.

Backup is half the job. `backupdrill drill` restores your latest snapshot into a throwaway Postgres and **verifies it actually restores** — because a backup you've never restored is a guess.

Backups stream through the CLI on your machine (or your CI) straight to your bucket. **Your data never touches our servers, because there are none — this is just a CLI.**

> This is the exact engine the hosted service runs in production. Want it on a schedule, with drills that run themselves, alerts, and emailed reports? That's **[backupdrill.com](https://backupdrill.com)**. This CLI is the DIY layer; the cloud adds scheduling, alerting, and reports on top.

🎥 Prefer watching? [Where do your backups actually go — explained in about a minute](https://backupdrill.com/guides/test-supabase-backup-restore#explainer-video).

## Why

- Supabase's own database restore only brings back `storage.objects` **metadata**, not your actual Storage files.
- Pro-plan backups keep 7 days and — on the physical backup process current projects use — can't be downloaded; PITR is $100/month per project.
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

## Use it from Claude Code or Cursor

The [`plugin/`](plugin/) folder is a plugin for Claude Code and Cursor. It teaches the agent to run `estimate`, `backup`, `drill` and `restore` for you, keeps your keys in a gitignored `.env.backupdrill` that the agent never opens, and always does a dry run before a restore. In Claude Code:

```
/plugin marketplace add backupdrill/cli
/plugin install backupdrill@backupdrill
```

Details are in [plugin/README.md](plugin/README.md).

## Use it from Pi

This npm package is also a Pi package. Installing it gives Pi the same skill the Claude Code plugin uses:

```sh
pi install npm:backupdrill
```

Start a new Pi session and ask it to back up your Supabase project or run a restore drill. The skill runs the CLI through `npx`, so Node.js 20 or newer has to be on your `PATH`. Everything else it needs, and where your keys go, is in [plugin/README.md](plugin/README.md).

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
| `BACKUPDRILL_PING_URL` | Healthchecks.io ping URL for `backup` and `drill` — see [Alerts with Healthchecks.io](#alerts-with-healthchecksio) | — |

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
  ├── RECOVERY.md                # how to restore this snapshot
  └── manifest.json              # schemas, tables, row counts, file list, sizes + sha256
<prefix>/<project>.drills/<finished-at>-<passed|failed>.json  # only with drill --record: one file per drill
```

## Restoring & drilling

Prove a backup is restorable, without touching anything real — `drill` restores the latest snapshot into a throwaway Postgres and checks it. It needs **Docker** (for the throwaway Postgres) and **`pg_restore`** (same major-version rule as `pg_dump`; set `BACKUPDRILL_PG_RESTORE` if it's not on your `PATH`):

```bash
backupdrill drill                    # latest snapshot; add --snapshot <timestamp> to pick one
backupdrill drill --verify-all-files # also checksum every Storage file, not just a sample
```

Backups record your installed Postgres extensions in the manifest, and the drill pre-installs them in the sandbox before restoring — including switching to a pgvector-enabled sandbox image when your database uses `vector` columns.

The sandbox restore runs up to 4 parallel `pg_restore` jobs, sized from the CPUs and memory Docker reports, so a 2 vCPU / 8 GB machine gets 2. Table data and index builds run in parallel. Foreign keys, triggers and policies run on a single connection to keep their error messages separate, including errors about Supabase-managed objects such as `auth.users`. `backupdrill restore` into a real Supabase project stays on a single connection.

### Run your own checks against the restored copy

The drill's structural checks (tables, rows, checksums) can't know what "working" means for *your* app — business invariants only have answers in your code. `--check-cmd` hands you the restored sandbox before it's destroyed:

```bash
backupdrill drill --check-cmd "npm run smoke"   # BACKUPDRILL_SANDBOX_URL points at the restored copy
```

Your command runs after all structural checks pass, with `BACKUPDRILL_SANDBOX_URL` set to the sandbox's connection string. Exit 0 means pass; the result shows up in the report as an `app checks` line, and a non-zero exit fails the drill (the report keeps structural and app-level failures clearly separate). Entirely optional — without the flag, nothing changes and the report has no `app checks` line. There's a 10-minute timeout (the whole process tree is killed), and `--keep` leaves the sandbox container running when a drill fails so you can inspect it — the report JSON then includes a `keptSandbox` object with the container id and connection string (`docker rm -f <id>` when done).

**What this can and cannot verify, honestly:** `BACKUPDRILL_SANDBOX_URL` connects as the sandbox **superuser**, and superusers bypass row-level security. The sandbox does carry a stub of the Supabase runtime — an `auth` schema whose `uid()`/`jwt()`/`role()`/`email()` return null, and the `anon`/`authenticated`/`service_role` roles — so functions, column defaults and policies that reference them restore instead of being skipped. The sandbox deliberately does not create Supabase-managed *tables* such as `auth.users`: an index, constraint or policy that points at one is reported as a skipped managed object (these are restored in a second, post-data pass where that exemption applies), while a *view* over one is created in the strict first pass and fails the drill — a real gap in what a public-only backup can rebuild, shown rather than hidden. A function *body* that selects from `auth.users` is different: PostgreSQL does not validate string-literal bodies (`AS $$ … $$`) during a restore (`check_function_bodies` is off in every dump), so such a function is recreated and the drill passes — it would only fail when called. The exception is an SQL-standard `BEGIN ATOMIC … END` body, which is parsed and dependency-checked at creation regardless of that setting, so one of those referencing a managed table fails the drill like a view does. That is exactly what `--check-cmd` is for: if your application depends on such a function, call it there. So use `--check-cmd` for data and business invariants ("orders reference existing users", "the row count I care about is sane"). It is **not** an RLS behavior test — `auth.uid()` is a stub and you are a superuser; verifying RLS takes an authenticated client stack with real JWTs, which no restore sandbox can fake generically.

When you actually need to recover, `restore` puts the database back into a fresh
target project (through the same engine the drills use, with verification) and
uploads the Storage files back — start with `--dry-run`, then confirm by typing
the target's project ref:

```bash
# credentials via hidden prompts (nothing lands in shell history); CI can inject
# BACKUPDRILL_TARGET_DATABASE_URL / BACKUPDRILL_TARGET_SERVICE_ROLE_KEY as managed secrets instead
backupdrill restore --database --target-supabase-url https://<ref>.supabase.co --dry-run
backupdrill restore --database --target-supabase-url https://<ref>.supabase.co --confirm-target <ref>
```

Prefer files on disk instead? Skip the Storage target and pass `--storage-dir ./recovered`.

Or restore the dump by hand — into an **empty** database, without `--clean`:

```bash
pg_restore --no-owner --no-privileges --dbname "<target-connection-string>" dump.pgcustom
```

Don't use `--clean` against a Supabase project: dropping and recreating the `public`
schema silently wipes Supabase's default grants for `anon`/`authenticated` (the dump
carries no ACLs), leaving the restored API returning 401s. One error is expected and
harmless: `schema "public" already exists` — the target always has it. The
`backupdrill restore` command above handles all of this (plus verification) for you.

## 2.0 migration — `restore` flags changed

Restore now refuses to take credentials on the command line (argv is visible to
every process on the machine):

- `--target-database-url <url>` was **removed**. Set `BACKUPDRILL_TARGET_DATABASE_URL`
  (or let the hidden prompt ask) and pass `--database` to say you want the
  database restored.
- Writing to a target now requires `--confirm-target <target-ref>` — type the
  target project's ref to confirm. Run `--dry-run` first to preview every check.
- The service-role key for Storage upload comes from
  `BACKUPDRILL_TARGET_SERVICE_ROLE_KEY` (or the hidden prompt), never a flag.

`backup`, `drill` and `estimate` are unchanged.

## GitHub Action / scheduled backups

Want this running on a schedule without paying for a server? Run it in GitHub Actions.

1. Copy [`examples/scheduled-backup.yml`](examples/scheduled-backup.yml) into **your own** repo at `.github/workflows/scheduled-backup.yml`. (It lives under `examples/` here so GitHub doesn't try to run it in this repo — it's a template.) It runs daily and can also be triggered by hand from the Actions tab. The workflow installs `postgresql-client-17` from the PGDG apt repo (so `pg_dump`'s major version matches Supabase) and points the CLI at it via `BACKUPDRILL_PG_DUMP`.
2. Add these repo secrets (Settings → Secrets and variables → Actions):
   - **Required:** `BACKUPDRILL_DATABASE_URL`, `BACKUPDRILL_S3_BUCKET`, `BACKUPDRILL_S3_ACCESS_KEY_ID`, `BACKUPDRILL_S3_SECRET_ACCESS_KEY`
   - **Optional (destination):** `BACKUPDRILL_S3_ENDPOINT` (for R2/B2), `BACKUPDRILL_S3_REGION`, `BACKUPDRILL_PROJECT_NAME`
   - **Optional (alerts):** `BACKUPDRILL_PING_URL` — see [Alerts with Healthchecks.io](#alerts-with-healthchecksio)
   - **Optional (Storage files):** set all four of `BACKUPDRILL_SUPABASE_STORAGE_ENDPOINT`, `BACKUPDRILL_SUPABASE_STORAGE_REGION`, `BACKUPDRILL_SUPABASE_STORAGE_ACCESS_KEY_ID`, `BACKUPDRILL_SUPABASE_STORAGE_SECRET_ACCESS_KEY` to also back up Storage files; leave them unset to back up the database only.

Before switching to a **daily** schedule, read the egress-cost section above — every run is egress on your Supabase bill.

## Alerts with Healthchecks.io

A scheduled backup can fail quietly, or not run at all: a cron entry that never fires, a runner that dies, a workflow GitHub disabled. `backup` and `drill` can report every run to a [Healthchecks.io](https://healthchecks.io) check (a self-hosted Healthchecks works the same), and Healthchecks alerts you when a run fails or a success ping doesn't arrive on time.

Create a check whose schedule and grace time match your job, copy its ping URL, then:

```bash
export BACKUPDRILL_PING_URL="https://hc-ping.com/<uuid>"
backupdrill backup
```

`--ping-url <url>` and a `"pingUrl"` key in the config file work too (same precedence as everything else). Each run sends a start ping, then either a success or a failure ping:

- `<url>/start` before it begins, so Healthchecks shows how long the run took and alerts if it runs past the grace time;
- `<url>` when it succeeds, with a one-line summary in the body (tables, Storage files and the snapshot name; for `drill`, rows restored and restore time);
- `<url>/fail` when it fails, with the error in the body. For a drill that ran but didn't pass, that's the failed checks. Before it's sent, the CLI filters out the connection strings, passwords, hostnames, IP addresses, project refs and bucket keys it can recognise, plus the parts of Postgres errors that usually quote row values or SQL (`DETAIL`, `CONTEXT`, `Command was`). It's a filter, not a guarantee: a sensitive value it doesn't recognise can still reach Healthchecks. The full error stays in the job's own output.

Both pings of a run carry the same `rid`, so Healthchecks pairs them even if two runs overlap. If you schedule both `backup` and `drill`, give each its own check: on a shared check, the daily backup's success pings would keep it up while a weekly drill that stopped running went unnoticed.

A ping never changes the result of a run. Each request times out after 10 seconds and is retried twice on network errors and 5xx responses; if it still fails, the CLI prints a warning and carries on, with the same exit code it would have had without a ping URL.

## Prometheus metrics

`backupdrill exporter` serves [Prometheus](https://prometheus.io) metrics about the backups in your bucket, and about the restore drills you run with `--record`. It reads the bucket each time Prometheus scrapes it and never writes, so a key with read-only access to the bucket is enough.

```bash
# reads the same BACKUPDRILL_S3_* and BACKUPDRILL_PROJECT_NAME settings as backup and drill
backupdrill exporter                  # http://127.0.0.1:10059/metrics
backupdrill exporter --host 0.0.0.0   # when Prometheus runs on another machine
```

It listens on `127.0.0.1` unless you pass `--host`, because every scrape costs a few requests against your bucket and the port shouldn't end up open to the internet by accident. `--port` changes the port.

Drill results only show up if the drill leaves them in the bucket. Add `--record` to your drill job: when the drill finishes, it writes one small JSON file to `<prefix>/<project>.drills/`, named after the time it finished and whether it passed (`2026-10-20T04-12-09-311Z-passed.json`). Files are never overwritten, so two drills that overlap can't replace each other's result. Only the outcome, the time, the snapshot name and the restore time are stored, never the check details. A drill that stops early (Docker isn't running, the bucket is empty) is recorded as not passed. `--record` needs write access to the bucket; if the write fails, the drill prints a warning and its own result and exit code stay the same. Without `--record`, `drill` only reads the bucket, as before.

```bash
backupdrill drill --record
```

Point Prometheus at it. One exporter watches one project. The metrics carry no labels of their own, so name the project in the scrape config:

```yaml
scrape_configs:
  - job_name: backupdrill
    scrape_interval: 1m
    static_configs:
      - targets: ["backup-host:10059"]
        labels:
          project: my-app
```

For a second project, run a second exporter with `--project-name` and a different `--port`.

| Metric | Meaning |
|---|---|
| `backupdrill_up` | 1 if the bucket was read, 0 if not (the reason goes to the exporter's log) |
| `backupdrill_scrape_duration_seconds` | How long reading the bucket took |
| `backupdrill_build_info{version}` | CLI version, always 1 |
| `backupdrill_snapshots` | Snapshot folders for the project, complete or not |
| `backupdrill_backup_last_success_timestamp_seconds` | When the newest complete snapshot finished (`createdAt` in its `manifest.json`); 0 if there is none |
| `backupdrill_latest_snapshot_dump_bytes` | Size of the database dump in that snapshot |
| `backupdrill_latest_snapshot_storage_files`, `_storage_bytes` | Storage files in that snapshot and their total size; 0 for a database-only backup |
| `backupdrill_latest_snapshot_tables`, `_estimated_rows` | Tables captured, and the row count Postgres estimated at backup time |
| `backupdrill_drill_last_run_timestamp_seconds` | When the last recorded drill finished, passed or not; 0 if none |
| `backupdrill_drill_last_run_passed` | 1 if that drill passed, 0 if not |
| `backupdrill_drill_last_success_timestamp_seconds` | When the last recorded drill that passed finished; 0 if none |
| `backupdrill_drill_last_success_restore_duration_seconds` | How long the database restore took in that drill |

A snapshot counts as complete once its `manifest.json` exists, because the backup writes it last. While there is no complete snapshot, the `latest_snapshot` metrics are left out. `backupdrill_drill_last_run_passed` appears once a drill has been recorded, and the restore duration once a recorded drill has passed. A manifest dated more than 10 minutes in the future counts as a failed read (`backupdrill_up 0`), and a drill file named with such a time is skipped with a warning in the log: either would hold back the alerts that work out an age from that timestamp. Check the clock on the machine that wrote it.

Alert rules to start from (`promtool check rules` passes on them):

```yaml
groups:
  - name: backupdrill
    rules:
      - alert: BackupdrillBucketUnreadable
        expr: backupdrill_up == 0
        for: 15m
      - alert: SupabaseBackupMissing
        # daily backups; use 8 * 86400 for weekly
        expr: time() - backupdrill_backup_last_success_timestamp_seconds > 26 * 3600
        for: 15m
      - alert: SupabaseBackupShrank
        expr: backupdrill_latest_snapshot_dump_bytes < 0.7 * max_over_time(backupdrill_latest_snapshot_dump_bytes[7d])
      - alert: SupabaseRestoreDrillFailed
        expr: backupdrill_drill_last_run_passed == 0
      - alert: SupabaseRestoreDrillMissing
        # weekly drills
        expr: time() - backupdrill_drill_last_success_timestamp_seconds > 8 * 86400
        for: 1h
```

What a scrape costs: one list request per 1,000 snapshot folders and one per 1,000 drill files, plus reads of the newest `manifest.json` and the newest passing drill file. The manifest is fetched with `If-None-Match`, so when it hasn't changed the bucket answers `304 Not Modified` and nothing is downloaded. That matters once you back up Storage files, since the manifest lists every file. At a one-minute interval this comes to about 86,000 list requests and 86,000 small reads a month; check your storage provider's request pricing. Each read of the bucket stops half a second before Prometheus's scrape timeout (10 seconds if there's no Prometheus header), so a slow bucket shows up as `backupdrill_up 0` instead of a failed scrape.

## Roadmap

- [x] Database backup → your bucket, with checksummed manifest
- [x] **Storage file sync** (the files Supabase restores leave behind)
- [x] `estimate` — project your monthly Supabase egress cost before you schedule
- [x] `drill` — restore a snapshot into an ephemeral Postgres and prove it comes back
- [x] Storage-file integrity check inside the drill (checksums, sampled by default)
- [x] `restore` — recover a snapshot into a fresh Supabase project: database through the drill-grade engine with verification, Storage uploaded back with per-file reconciliation (local download remains an option)
- [x] GitHub Action wrapper
- [x] `exporter` — Prometheus metrics for backups and recorded drills

For scheduling, automated restore drills, and alerting, use the hosted service at [backupdrill.com](https://backupdrill.com).

## Versioning & stability

`backupdrill` follows [semantic versioning](https://semver.org/). From **1.0.0** onwards the
following is the stable public surface — breaking it requires a major version bump:

- the commands (`backup`, `drill`, `restore`, `estimate`, `exporter`) and their flags
- the `BACKUPDRILL_*` environment variables and the config-file keys
- the layout written to your bucket, and the shape of `manifest.json` and the drill record files
- the names and meaning of the metrics `exporter` serves

`manifest.json` carries a `schemaVersion` so the format can evolve safely. A snapshot written by
a newer release is **refused with a clear message** rather than parsed on a best-effort basis —
for a backup tool, silently misreading an archive is the worst possible failure. Snapshots taken
before 1.0 have no `schemaVersion` and are treated as version 1, so older backups stay readable.

The package's **JavaScript exports are internal** to the hosted BackupDrill product and are not
covered by this promise; they may change in any release. Use the CLI if you need a stable contract.

## License

MIT
