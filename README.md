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

The [`plugin/`](https://github.com/backupdrill/cli/tree/main/plugin) folder is a plugin for Claude Code and Cursor. It teaches the agent to run `estimate`, `backup`, `drill` and `restore` for you, keeps your keys in a gitignored `.env.backupdrill` that the agent never opens, and always does a dry run before a restore. In Claude Code:

```
/plugin marketplace add backupdrill/cli
/plugin install backupdrill@backupdrill
```

Details are in [plugin/README.md](https://github.com/backupdrill/cli/blob/main/plugin/README.md).

## Use it from Pi

This npm package is also a Pi package. Installing it gives Pi the same skill the Claude Code plugin uses:

```sh
pi install npm:backupdrill
```

Start a new Pi session and ask it to back up your Supabase project or run a restore drill. The skill runs the CLI through `npx`, so Node.js 20 or newer has to be on your `PATH`. Everything else it needs, and where your keys go, is in [plugin/README.md](https://github.com/backupdrill/cli/blob/main/plugin/README.md).

## Usage

Configure via **env vars**, a **config file**, or **flags** (precedence: flags > env > file).

### Env vars

```bash
export BACKUPDRILL_DATABASE_URL="postgresql://postgres.<ref>:<pw>@<pooler-host>:5432/postgres"
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
| `BACKUPDRILL_AUTH` | Supabase Auth users (`auth.users` + `auth.identities`) go into `auth.dump` next to the database dump whenever the role can read them. `off` leaves them out. `on` makes a backup that can't include them exit with code 3; the database backup still completes either way. Also `--auth` / `--no-auth`, or `"auth": true/false` in the config file | on when possible |
| `BACKUPDRILL_S3_ENDPOINT` | S3-compatible endpoint (R2/B2/self-hosted; omit for AWS S3) | — |
| `BACKUPDRILL_S3_REGION` | Destination bucket region | `auto` |
| `BACKUPDRILL_S3_BUCKET` | Destination bucket | — (required) |
| `BACKUPDRILL_S3_ACCESS_KEY_ID`, `BACKUPDRILL_S3_SECRET_ACCESS_KEY` | Destination credentials | — (required) |
| `BACKUPDRILL_S3_PREFIX` | Key prefix inside the bucket | `backupdrill` |
| `BACKUPDRILL_S3_FORCE_PATH_STYLE` | `true`/`false` — path-style addressing (R2/MinIO) | `true` when an endpoint is set |
| `BACKUPDRILL_SUPABASE_STORAGE_*` | Storage-file source (endpoint/region/keys/buckets) — see [Backing up Storage files](#backing-up-storage-files-too) | — |
| `BACKUPDRILL_PG_DUMP` | Path to the `pg_dump` binary to use | `pg_dump` on `PATH` |
| `BACKUPDRILL_PG_RESTORE` | Path to `pg_restore` (used by `drill` and `restore`) | next to `BACKUPDRILL_PG_DUMP`, else `pg_restore` on `PATH` |
| `BACKUPDRILL_PSQL` | Path to `psql`, which `restore` uses for snapshots with Auth users | next to `pg_restore`, else `psql` on `PATH` |
| `BACKUPDRILL_STATE_DIR` | Where `restore` keeps its record of restores with Auth users, for `--status` and `--finish` | `~/.backupdrill/restores` |
| `BACKUPDRILL_PING_URL` | Healthchecks.io ping URL for `backup` and `drill` — see [Alerts with Healthchecks.io](#alerts-with-healthchecksio) | — |

### Config file

Copy `backupdrill.config.example.json` → `backupdrill.config.json` (it's gitignored) and fill it in. Keep secrets in env vars even when using a file. To also back up Storage files, start from `backupdrill.config.with-storage.example.json` instead — only copy the `supabaseStorage` block once you actually have S3 access keys for your project's Storage.

```bash
backupdrill backup --config backupdrill.config.json
```

## Get the connection string

Use the **Session pooler** string: in the Supabase dashboard, open your project, click **Connect** at the top of the page and pick **Session pooler**. Copy the whole string rather than typing the host yourself, because the pooler host can't be worked out from the region. Replace `[YOUR-PASSWORD]` with the database password (percent-encode characters like `@` or `#`). The default `postgres` user works as-is — it owns your tables, so `pg_dump` passes row-level security.

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
- **Spend Cap exists only on Pro, and it's ON by default.** With it on, going past the quota isn't billed. Supabase emails your billing address and starts a grace period, and if usage stays over it **restricts your organization's projects** (your app, not just the backup) until the next billing cycle or until you turn Spend Cap OFF. The grace period isn't renewed every time: go over again before the dashboard's notice clears (that takes several billing cycles under the limits) and the restriction can start right away. Turn Spend Cap OFF up front to be billed the overage instead.
- **Team has no Spend Cap**, so egress past the included 250 GB is always billed at $0.09/GB.
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
  ├── auth.dump                  # Auth users: auth.users + auth.identities (2.10.0+, when the role can read them)
  ├── storage/<bucket>/<key>     # your Storage files (if configured)
  ├── RECOVERY.md                # how to restore this snapshot
  └── manifest.json              # schemas, tables, row counts, grants, file list, sizes + sha256
<prefix>/<project>.drills/<finished-at>-<passed|failed>-<tag>.json  # only with drill --record: one file per drill
```

Versions up to 2.7.1 took an empty `BACKUPDRILL_PROJECT_NAME` (what an unset GitHub Actions secret becomes) as the project name, so those backups sit under `<prefix>//<timestamp>/`. Later versions treat it as unset and take the name from your config file, or use `supabase` if the file doesn't set one. To drill or restore one of the older snapshots, pass `--project-name ''`, as its RECOVERY.md already does.

## Restoring & drilling

Prove a backup is restorable, without touching anything real — `drill` restores the latest snapshot into a throwaway Postgres and checks it. It needs **Docker** (for the throwaway Postgres) and **`pg_restore`** (same major-version rule as `pg_dump`; set `BACKUPDRILL_PG_RESTORE` if it's not on your `PATH`):

```bash
backupdrill drill                    # latest snapshot; add --snapshot <timestamp> to pick one
backupdrill drill --verify-all-files # also checksum every Storage file, not just a sample
```

After the restore, the drill counts the rows of every table in the sandbox and compares each count with the number of rows that table has in the backup file. One row more or less in any table fails the drill. The backup's count comes from reading the dump itself, not from your database, so this adds no queries against production; it costs the drill one extra read of the dump. Materialized views and partitioned parent tables have no rows of their own in the dump, and tables created by an extension hold rows the extension adds itself, so these are checked for being non-empty instead. `restore` runs the same comparison on the target project.

Backups record your installed Postgres extensions in the manifest, and the drill pre-installs them in the sandbox before restoring — including switching to a pgvector-enabled sandbox image when your database uses `vector` columns.

The sandbox restore runs up to 4 parallel `pg_restore` jobs, sized from the CPUs and memory Docker reports, so a 2 vCPU / 8 GB machine gets 2. Table data and index builds run in parallel. Foreign keys, triggers and policies run on a single connection to keep their error messages separate, including errors about Supabase-managed objects such as `auth.users`. `backupdrill restore` into a real Supabase project stays on a single connection.

For a snapshot with Auth users, the drill does more once its usual checks are done. In the same sandbox it restores the two Auth tables and compares their row counts with the backup. It adds the foreign keys into them that it otherwise skips, recreates the triggers on them that a restore would recreate (the rest are listed as manual steps), and simulates an email sign-up as `supabase_auth_admin`, the role Supabase Auth uses, then rolls it back. If a trigger fails on that test sign-up (an email sign-up with no user metadata), the report says so. The result is an `auth` section in the report. For now it doesn't change whether the drill passes.

Ctrl+C (or a SIGTERM from whatever runs the drill) stops it and cleans up: the CLI stops a running `--check-cmd` and `pg_restore`, removes the sandbox container and its volume, deletes the downloaded dump, and exits with 130 (143 for SIGTERM). `--keep` doesn't apply to an interrupted drill. Press Ctrl+C a second time to exit without waiting for the cleanup.

### Run your own checks against the restored copy

The drill's structural checks (tables, rows, checksums) can't know what "working" means for *your* app — business invariants only have answers in your code. `--check-cmd` hands you the restored sandbox before it's destroyed:

```bash
backupdrill drill --check-cmd "npm run smoke"   # BACKUPDRILL_SANDBOX_URL points at the restored copy
```

Your command runs after all structural checks pass, with `BACKUPDRILL_SANDBOX_URL` set to the sandbox's connection string. Exit 0 means pass; the result shows up in the report as an `app checks` line, and a non-zero exit fails the drill (the report keeps structural and app-level failures clearly separate). Entirely optional — without the flag, nothing changes and the report has no `app checks` line. There's a 10-minute timeout (the whole process tree is killed), and `--keep` leaves the sandbox container running when a drill fails so you can inspect it — the report JSON then includes a `keptSandbox` object with the container id and connection string (`docker rm -f <id>` when done).

**What this can and cannot verify, honestly:** `BACKUPDRILL_SANDBOX_URL` connects as the sandbox **superuser**, and superusers bypass row-level security. The sandbox does carry a stub of the Supabase runtime — an `auth` schema whose `uid()`/`jwt()`/`role()`/`email()` return null, and the `anon`/`authenticated`/`service_role` roles — so functions, column defaults and policies that reference them restore instead of being skipped. The sandbox deliberately does not create Supabase-managed *tables* such as `auth.users`: an index, constraint or policy that points at one is reported as a skipped managed object (these are restored in a second, post-data pass where that exemption applies). A skipped foreign key into `auth.users` still matters for a real restore, see [Tables that reference auth.users](#tables-that-reference-authusers). A *view* over one is created in the strict first pass instead, and fails the drill — a real gap in what a public-only backup can rebuild, shown rather than hidden. A function *body* that selects from `auth.users` is different: PostgreSQL does not validate string-literal bodies (`AS $$ … $$`) during a restore (`check_function_bodies` is off in every dump), so such a function is recreated and the drill passes — it would only fail when called. The exception is an SQL-standard `BEGIN ATOMIC … END` body, which is parsed and dependency-checked at creation regardless of that setting, so one of those referencing a managed table fails the drill like a view does. That is exactly what `--check-cmd` is for: if your application depends on such a function, call it there. So use `--check-cmd` for data and business invariants ("orders reference existing users", "the row count I care about is sane"). It is **not** an RLS behavior test — `auth.uid()` is a stub and you are a superuser; verifying RLS takes an authenticated client stack with real JWTs, which no restore sandbox can fake generically.

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

`--dry-run` writes nothing to the target. Besides checking the target (not the source project, schemas empty, Postgres and `pg_restore` versions, extensions available), it downloads the dump to a temporary directory, checks its sha256 and looks for foreign keys that point outside the backup (see [Tables that reference auth.users](#tables-that-reference-authusers)). The real run repeats those checks before it writes anything; a foreign key into a table that one of the recorded extensions creates is checked again once the extensions are installed. The database restore then runs in a single transaction: if any statement fails, nothing from the snapshot stays on the target, and you can run it again on the same project once you've fixed the cause. (If the connection drops while it commits, the error says so and asks you to check the target first.) Right after that transaction commits, the grants for `anon`, `authenticated` and `service_role` are set in a transaction of their own (see [Grants for anon, authenticated and service_role](#grants-for-anon-authenticated-and-service_role)). Foreign keys between two tables in the backup are the exception to the single transaction: they're added after that, in one more. If rows in your data already break one of them (deleting with triggers switched off, for example under `session_replication_role = replica`, can leave rows like that), the key is added as `NOT VALID` instead of failing the restore. Those rows come back as they are, new writes are still checked, and the report names the key and, when it can count them, how many rows break it. Keys on or into partitioned tables, keys into an extension's tables, and every key in an archive whose foreign key statements BackupDrill can't fully read stay in the main transaction, so a broken one rolls the whole restore back. A key over a generated column is added in the second step but is never relaxed, because the restore recomputes those values; if it breaks, that step fails. Keys added as `NOT VALID` don't fail a drill: the drill passes and lists them in its report. If a step after the main transaction fails for any other reason, the tables and data are already on the target and the error says so. Extensions the run installed stay installed, since the next run needs them too, and the empty-target check doesn't count objects that belong to an extension (except an extension's configuration tables, whose rows a dump can carry). One transaction holds a lock on every table, index and sequence until it commits, so a very large schema can run out of lock slots: on Supabase's smallest compute size, about a thousand tables (partitions count as tables). The restore then stops with nothing written and tells you how to raise `max_locks_per_transaction`.

Snapshots taken with 2.10.0 or later usually hold the Auth users as well. For those, `restore` writes the Auth users, the database and the triggers on the Auth tables that it can recreate in **one** transaction. Triggers it can't recreate, and policies on the Auth tables, are listed as manual steps. A foreign key like `profiles.id → auth.users` then finds its users. If anything fails before the commit, the target is left as it was. The grants and some foreign keys come after the commit, as with any restore (see above). A few things come with that:

- **`psql` is needed.** It comes from the same PostgreSQL client package as `pg_restore`, and it must be 17.6, 16.10, 15.14, 14.19, 13.22 or newer. Those releases protect psql from commands smuggled into an archive.
- **The target has to be a new project.** No Auth users, and no triggers or policies of its own on the Auth tables.
- **Links and codes from before don't work.** Password-reset, email-confirmation and email or phone change links that were pending at backup time are cleared.
- **Everyone signs in again**, because sessions aren't in the snapshot.
- **Auth settings are yours to set up again.** Sign-in providers, SMTP, redirect URLs and the site URL live in the Supabase dashboard, not in the database. Users who signed in with Google or GitHub keep that sign-in method; reconfigure the same OAuth app in the new project.
- **MFA factors aren't backed up.** Users who had MFA sign in with one factor until they enroll again.

If the restore is cut off while it commits, `backupdrill restore --status` (same `BACKUPDRILL_TARGET_DATABASE_URL`, same machine) says whether it committed. If it did, `backupdrill restore --finish --confirm-target <ref>` does the grants and foreign keys that come after the commit, and it can be run again safely. `--skip-auth` leaves the Auth users out and restores the database the way 2.9 did; use it if you already copied the users into the target yourself.

Or restore by hand. For a snapshot with Auth users, follow step 4 of its `RECOVERY.md`, which restores `auth.dump` and `dump.pgcustom` in one transaction. For a snapshot without them, restore the dump into an **empty** database, without `--clean`:

```bash
pg_restore --no-owner --no-privileges --dbname "<target-connection-string>" dump.pgcustom
```

One error is expected and harmless: `schema "public" already exists` — the target always has it. An error on a foreign key into `auth.users` means the users have to be copied in first (see [Tables that reference auth.users](#tables-that-reference-authusers)). After that, set the grants yourself (next section). Don't use `--clean` against a Supabase project: it drops and recreates the `public` schema, and with it the grants Supabase put on it. The `backupdrill restore` command above handles all of this (plus verification) for you.

### Grants for anon, authenticated and service_role

supabase-js and the other client libraries reach your tables through the Data API, as `anon`, `authenticated` or `service_role`. Postgres refuses any table those roles have no grant on, with `42501 permission denied`, before row-level security even runs.

The dump doesn't carry grants, so a restored table only gets what the target project hands out by default. Supabase used to grant every new table in `public` to all three roles. It stopped doing that for new projects on May 30, 2026, and for existing projects on October 30, 2026 ([Supabase's announcement](https://github.com/orgs/supabase/discussions/45329)). On a project that has switched, a plain `pg_restore` brings back every table and row, and the app still gets `42501` on all of them. On a project that hasn't switched yet, it does the opposite: every restored table is open to `anon`, including the ones you had closed.

So each backup also records, in `manifest.json` under `database.grants`, what `anon`, `authenticated`, `service_role` and `PUBLIC` were granted on every table, view, sequence and function in the backed-up schemas (column-level grants and schema `USAGE` included). It reads them right before and right after the dump and keeps only the grants both reads agree on, for objects that weren't dropped and recreated in between. A grant added or removed while the dump runs is left off until the next backup. One taken away and given back during the dump looks unchanged to both reads, so it is kept. After the data is in, `restore` and `drill` take those four roles off every restored object and grant back exactly what the source had, whatever the target's defaults are, then read the grants back to check they took. Objects that belong to an extension are left alone. The report has an `API grants` line. `pg_restore` runs in its own process, so the grants can't go into its transaction: for the moment between its commit and the grants, the restored objects have the target's defaults. If setting the grants fails, `restore` tries to revoke those roles' access to the restored objects instead. If that works, your app gets `42501` until you grant what it needs; if it fails too, the error tells you to check the target's default grants before the app goes live.

Snapshots taken before 2.9.0 have no record. Restoring one of those, the CLI gives the three roles Supabase's old default access to every table, sequence and function in `public`, which is what those projects had unless you revoked it, and the `API grants` line says so. Revoke it on anything you had kept private. For tables in your own schemas, the CLI leaves the target's default grants as they are.

Restoring by hand, set the grants after `pg_restore`. A snapshot made with 2.9.1 or later has the SQL in its `RECOVERY.md`: one `do` block that does what `restore` does. It takes those roles off everything the restore created, grants back what the source had, and skips with a warning any grant whose object isn't there. 2.9.0 wrote a revoke and the grants for each recorded object instead, which misses objects that changed while the backup ran, so restore those snapshots with `backupdrill restore`. Snapshots from before 2.9.0 have no record: run this to give the three roles Supabase's old defaults in `public`, then revoke on the tables you keep private:

```sql
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;
```

### Tables that reference auth.users

This section is about snapshots without Auth users: those taken before 2.10.0, with `--no-auth`, or by a role that couldn't read the Auth tables, and restores with `--skip-auth`. (A snapshot's `manifest.json` says under `auth` whether it has them.) Plenty of Supabase apps have a table like `profiles` whose `id` is a foreign key to `auth.users(id)`. When the restore recreates that key in a new project, Postgres checks every `profiles` row against `auth.users`, and in a new project that table is empty, so the restore fails.

A drill of such a snapshot can't catch this. Its sandbox has no `auth.users` at all, so the drill reports that foreign key as a skipped Supabase-managed object and passes. `restore --dry-run` checks it against the real target and tells you how many rows have nothing to point at:

```
✗ references outside the backup: public.profiles → auth.users (profiles_id_fkey): 200 of 200 row(s) point at auth.users rows the target doesn't have
```

While that check fails, no snapshot data is written. Copy the users into the new project first, then run the restore. While the old project is still reachable, the Postgres tools can do it. Use the Session pooler string of each project, and type the passwords at hidden prompts so they stay out of your shell history:

```bash
read -rs OLD_PW; read -rs NEW_PW
PGPASSWORD="$OLD_PW" pg_dump --data-only --table=auth.users --table=auth.identities \
  "postgresql://postgres.<old-ref>@<old-pooler-host>:5432/postgres" |
  PGPASSWORD="$NEW_PW" psql -v ON_ERROR_STOP=1 \
  "postgresql://postgres.<new-ref>@<new-pooler-host>:5432/postgres"
unset OLD_PW NEW_PW
```

`auth.identities` holds each user's sign-in methods; users copied with it can sign in to the new project with their old password. If the old project is gone, the users can only come from a backup that includes them: a backupdrill snapshot taken with 2.10.0 or later, or Supabase's own daily backups on a paid plan.

Triggers you created on `auth.users`, such as the common one that inserts a `profiles` row on sign-up, belong to that table, so a snapshot without Auth users doesn't have them either. Create them again after the restore.

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

Want this running on a schedule without paying for a server? Use the [Supabase Backup with BackupDrill](https://github.com/backupdrill/supabase-backup-action) action. It installs `pg_dump` 17 from the PostgreSQL apt repo (PGDG), runs `backupdrill backup` with the newest 2.x release of this CLI, and with `drill: "true"` restores the new snapshot into a throwaway Postgres on the runner and checks it.

```yaml
# .github/workflows/supabase-backup.yml in your own (private) repo
name: supabase-backup
on:
  schedule:
    - cron: "0 3 * * 0" # weekly; read the egress section above before going daily
  workflow_dispatch: {}
permissions:
  contents: read
concurrency:
  group: supabase-backup
  cancel-in-progress: false
jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - uses: backupdrill/supabase-backup-action@v1
        with:
          database-url: ${{ secrets.BACKUPDRILL_DATABASE_URL }}
          s3-bucket: ${{ secrets.BACKUPDRILL_S3_BUCKET }}
          s3-access-key-id: ${{ secrets.BACKUPDRILL_S3_ACCESS_KEY_ID }}
          s3-secret-access-key: ${{ secrets.BACKUPDRILL_S3_SECRET_ACCESS_KEY }}
          s3-endpoint: ${{ secrets.BACKUPDRILL_S3_ENDPOINT }}
          s3-region: ${{ secrets.BACKUPDRILL_S3_REGION }}
          drill: "true"
```

Add the secrets under Settings → Secrets and variables → Actions:

- **Required:** `BACKUPDRILL_DATABASE_URL`, `BACKUPDRILL_S3_BUCKET`, `BACKUPDRILL_S3_ACCESS_KEY_ID`, `BACKUPDRILL_S3_SECRET_ACCESS_KEY`
- **Optional (destination):** `BACKUPDRILL_S3_ENDPOINT` (for R2/B2) and `BACKUPDRILL_S3_REGION` (AWS S3 needs the bucket's region; R2 works with the default `auto`). A readable project name goes in the `project-name` input.
- **Optional (alerts):** `BACKUPDRILL_PING_URL`, passed as `ping-url`. See [Alerts with Healthchecks.io](#alerts-with-healthchecksio).
- **Optional (Storage files):** the four `BACKUPDRILL_SUPABASE_STORAGE_*` values, passed as the `supabase-storage-endpoint`, `-region`, `-access-key-id` and `-secret-access-key` inputs. Leave them out to back up the database only.

The action's README lists every input and output.

Prefer a plain workflow file? [`examples/scheduled-backup.yml`](https://github.com/backupdrill/cli/blob/main/examples/scheduled-backup.yml) runs the backup without the action and without a drill. Copy it into your own repo at `.github/workflows/scheduled-backup.yml` and add the same secrets. (It lives under `examples/` here so GitHub doesn't try to run it in this repo.) It runs daily and can also be started by hand from the Actions tab.

Before switching to a **daily** schedule, read the egress-cost section above — every run is egress on your Supabase bill.

## Docker / scheduled backups on your own server

If you'd rather run backups on a machine you already have (a home server, a NAS, Unraid, any Docker host), use the image at `ghcr.io/backupdrill/backupdrill`. The image includes the CLI and `pg_dump` 17. It contains no credentials; configure it with the `BACKUPDRILL_*` environment variables listed above.

Set `BACKUPDRILL_CRON` and the container stays up and runs `backupdrill backup` on that schedule. The time zone comes from `TZ` (UTC if unset). If a scheduled backup is still running when the next one is due, the scheduler skips that run. A backup you start yourself with `docker exec` isn't covered by this and can overlap with a scheduled one.

```bash
docker run -d --name backupdrill --restart unless-stopped \
  -e BACKUPDRILL_CRON="0 3 * * 0" \
  -e TZ="Europe/Berlin" \
  -e BACKUPDRILL_DATABASE_URL="postgresql://postgres.<ref>:<pw>@<pooler-host>:5432/postgres" \
  -e BACKUPDRILL_PROJECT_NAME="my-app" \
  -e BACKUPDRILL_S3_ENDPOINT="https://<account>.r2.cloudflarestorage.com" \
  -e BACKUPDRILL_S3_BUCKET="my-backups" \
  -e BACKUPDRILL_S3_ACCESS_KEY_ID="…" \
  -e BACKUPDRILL_S3_SECRET_ACCESS_KEY="…" \
  -e BACKUPDRILL_PING_URL="https://hc-ping.com/<uuid>" \
  ghcr.io/backupdrill/backupdrill:latest
```

- Without `BACKUPDRILL_CRON` the container runs one backup and exits with the CLI's exit code, which suits a host cron job or a scheduler you already use.
- Arguments go straight to the CLI: `docker run --rm -e … ghcr.io/backupdrill/backupdrill estimate` or `… --help`. To start a backup now in a running scheduled container: `docker exec backupdrill backupdrill backup`.
- `BACKUPDRILL_CRON` takes a standard 5-field expression or a shortcut such as `@daily`. Anything else stops the container at start (exit code 64) instead of leaving it idle.
- `drill` needs Docker to start its throwaway Postgres, and the image doesn't get access to your Docker daemon, so run drills where Docker is available (your machine, or the GitHub Action with `drill: "true"`).
- Tags: `latest`, the CLI version (e.g. `2.10.1`), and `sha-<commit>`. Images are built for amd64 and arm64.

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

Drill results only show up if the drill leaves them in the bucket. Add `--record` to your drill job: when the drill finishes, it writes one small JSON file to `<prefix>/<project>.drills/`, named after the time it finished, whether it passed and a random tag (`2026-10-20T04-12-09-311Z-passed-3f9a1c07.json`). Each drill writes a file under its own name instead of updating a shared one, so the order in which two overlapping drills finish writing doesn't matter. Only the outcome, the time, the snapshot name and the restore time are stored, never the check details. A drill that stops early (Docker isn't running, the bucket is empty) is recorded as not passed. `--record` needs write access to the bucket; if the write fails, the drill prints a warning and its own result and exit code stay the same. Without `--record`, `drill` only reads the bucket, as before.

```bash
backupdrill drill --record
```

Point Prometheus at it. One exporter watches one project. The exporter doesn't add a project label, so set one in the scrape config:

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

Alert rules to start from. Save them as `backupdrill-alerts.yml`, list that file under `rule_files` in `prometheus.yml` and reload Prometheus; `promtool check rules` passes on them:

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
- [x] Auth users (`auth.users`, `auth.identities`): backed up, restored in the same transaction as the database, checked in drills

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
