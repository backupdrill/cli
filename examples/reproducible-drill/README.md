# Reproducible restore drill

Everything here reproduces the drill report published at
**<https://backupdrill.com/drill-report>** — same schema, same seed, same
commands. Run it and compare your output to ours.

```bash
pnpm install --frozen-lockfile && pnpm build   # run.sh calls ../../dist, which is not committed
./examples/reproducible-drill/run.sh               # backup + drill
./examples/reproducible-drill/run.sh --with-login  # then restore into Supabase Postgres + GoTrue and sign in
```

Requires Docker, Node ≥ 20, and `pg_dump`/`pg_restore` ≥ 17 on your `PATH` (or
point `PG_BIN` at them); `--with-login` also needs `psql` from the same client
package. It starts two fixture containers — Postgres and an S3-compatible store —
and the drill starts a third for its restore sandbox. `--with-login` then starts
two more on a Docker network of their own, once the sandbox is gone: Supabase's
Postgres image (`supabase/postgres`, about 1.7 GB to pull) and GoTrue, the
Supabase Auth server. All of them, and the network, are removed on exit.

Nothing touches a real project, and that is enforced rather than promised:
credentials are generated per run and never written to a tracked file, every
container binds to `127.0.0.1` only, and the CLI is invoked with a scrubbed
environment so a `BACKUPDRILL_*` or `DATABASE_URL` already exported in your
shell cannot redirect the fixture at a real database or bucket. The config is
rendered per run from `config.template.json`, and the record `restore` keeps
for `--status` goes into the run's temporary directory, not your home.

## What it builds

A **Supabase-shaped** Postgres 17 source, because the shapes that break restores
are the platform-specific ones:

- Supabase Auth: `auth.users` and `auth.identities` in the exact layout GoTrue
  v2.186.0 creates, owned by `supabase_auth_admin` with RLS on, as in a hosted
  project. 1,000 users: 600 sign in with an email and a password
  (`demo-password-<n>` for `user<n>@example.com`), 400 signed up with Google and
  have no password. Five of the password users still have a password-reset link
  pending, which a restore must clear.
- a `profiles` table whose primary key references `auth.users`, filled by an
  `on_auth_user_created` trigger on `auth.users`. A new project's `auth.users`
  is empty, so a database-only restore cannot recreate that foreign key, and
  without the trigger new sign-ups get no profile.
- grants to `anon`, `authenticated` and `service_role`, written out by hand the
  way projects do now that Supabase no longer grants new tables in `public` to
  them automatically
- RLS policies granted `TO authenticated` / `TO anon`, one of them using
  `auth.uid()` — roles and a function that do **not** exist in a bare Postgres
  (the drill sandbox creates stub versions of them, so these policies restore)
- extensions (`pg_trgm`, `pgcrypto`) installed into their own `extensions`
  schema, with a GIN trigram index that depends on one of them
- a range-partitioned table, a materialized view, a trigger, and FK graphs
- an `attachments` table holding object keys — the pointers a database-only
  restore brings back without the files behind them
- one intentionally empty table, so you can see that "populated tables came
  back" only judges tables that had rows at backup time

Seed: 14 tables, 1,496,250 rows, ~199 MB on disk, the 1,000 Auth users, plus 250
files (35 MB) in an S3-compatible store standing in for Supabase Storage. Every
value any published number depends on is generated deterministically — the
file bytes, so per-file sha256 reproduces exactly, the row values behind the
invariant totals, and the Auth users' IDs, emails and timestamps. Three things
are deliberately not deterministic and do not feed any published figure: uuid
primary keys (`gen_random_uuid()`), the `now()` timestamps on eight tables, and
the bcrypt salts in the password hashes.

The source's superuser is called `source_admin`, not `postgres`. `--with-login`
restores into the second database as `postgres`, and `restore` refuses a target
whose host and user both match the source (it does not compare ports): that
check is what stops a restore from overwriting the project it backed up.

## What we measured

Run on 2026-11-06 with CLI 2.10.0 and the PostgreSQL 17 client tools
(`pg_dump`/`pg_restore`/`psql` 17.11), the same major version the hosted service
uses.

Backup:

```
→ Inspecting database…
✓ Postgres 17.6 — schema(s) public: 14 tables, ~1,496,499 rows
→ Dumping → s3://acme-backups/backupdrill/acme-prod/2026-11-06T03-58-17-486Z/dump.pgcustom
✓ Database dumped (21.6 MB, sha256 f160e1c9536d…)
✓ Auth users backed up (1,000 users, 1,000 sign-in identities, 0.2 MB)
→ Syncing Storage files…
→   user-uploads: 250 files
! Bucket attributes not captured (relation "storage.buckets" does not exist); this manifest will record them as absent — restore will say so instead of guessing.
✓ Storage synced (250 files, 33.6 MB)
✓ Recovery runbook written → …/RECOVERY.md
✓ Manifest written → …/manifest.json
✓ Backup complete — 14 tables + 250 Storage files.
```

Drill:

```
✓ Auth users: 1,000 users restored (1,000 identities); 1 foreign key(s) into the Auth tables created; 1 trigger(s) recreated; a test sign-up worked

✓ archive integrity — sha256 matches (f160e1c9536d…)
✓ storage file integrity — all 250 files match their manifest checksums
✓ sandbox extensions — installed pg_trgm, pgcrypto
✓ pg_restore — completed in 1.9s (2 parallel jobs)
✓ post-data objects — user objects restored; 1 Supabase-managed object(s) skipped (they reference tables such as auth.users, which the drill sandbox doesn't have; restoring into a new project needs the rows they point at to be there first)
✓ table count — restored 14, manifest 14
✓ no missing tables — all manifest tables present
✓ populated tables came back — no populated table restored empty
✓ API grants — access for anon, authenticated and service_role set as it was at backup time on 24 object(s)
✓ app checks — command exited 0 in 0.1s

✓ Drill PASSED — snapshot 2026-11-06T03-58-17-486Z, 14 tables / 1,496,250 rows restored in 1.9s
```

The Auth line is printed first but runs last: once the checks below it have
decided pass or fail, the drill restores `auth.dump` into the same sandbox,
adds the foreign key it skipped earlier, recreates the trigger, and inserts a
test user the way GoTrue does on an email sign-up, then rolls that back. It
reports on its own line and does not change the verdict.

`check-invariants.mjs` is what `--check-cmd` runs. It runs on your machine, not
inside the sandbox container — the drill hands it the sandbox's connection
string via `BACKUPDRILL_SANDBOX_URL`, so it needs whatever runtime your check
is written in, and it has your machine's privileges, not a container's. It
asserts
the exact row count of five tables and the exact revenue total, so losing part
of the data fails the drill. Its other two assertions — no orphaned foreign
keys, materialized view agreeing with its base table — are near-tautologies a
completed restore forces to hold; they are in there as a template for the
assertions only your own code can make.

```
row counts: {"orders":"200000","order_items":"600000","customers":"20000","attachments":"250","events":"300000"}
orphan order_items: 0 | orphan orders: 0
revenue orders vs matview: 25099150000 vs 25099150000
```

Restore and sign in (`--with-login`). The target is `supabase/postgres:17.6.1.084`
with GoTrue v2.186.0 running against it, so its Auth tables exist and are empty,
as in a new project:

```
→ Restoring the Auth users and the database into target in one transaction…
→ Verifying restored tables…
✓ table count: restored 14, manifest 14
✓ no missing tables: all manifest tables present
✓ populated tables came back: no populated table restored empty
✓ API grants: access for anon, authenticated and service_role set as it was at backup time on 24 object(s)
✓ Database restored (14 tables, 1,496,250 rows)
✓ Auth users restored: 1,000 users (1,000 identities); trigger(s) recreated: on_auth_user_created
! Everyone signs in again: sessions aren't in the snapshot. Reconfigure Auth in the Supabase dashboard before switching your app over: sign-in providers (OAuth client IDs and secrets), SMTP, redirect URLs, the site URL and SSO.
→ Downloading 250 Storage files → …/recovered-files
✓ Storage files written to …/recovered-files
✓ Restore complete — snapshot 2026-11-06T03-58-17-486Z: database restored, 250 Storage files written to …/recovered-files
==> sign in on the restored project
  ✓ user1@example.com signed in with the password it had before the backup (HTTP 200, access token issued)
  ✓ the same account with a wrong password is refused (HTTP 400)
  ✓ a new sign-up through GoTrue got its profiles row from the restored trigger
  ✓ password-reset links pending at backup time: 5 at the source, 0 after the restore
```

The dry run and the restore's own preflight lines come before this in the full
output; they are cut here for length.

## What is and isn't identical when you rerun this

We ran it three times in July 2026, again in October, and again in November
after adding the Auth users. Worth knowing before you compare:

| Value | Stable across runs? | Why |
|---|---|---|
| Measured rows restored (1,496,250), table count, Auth user and identity counts, per-file sha256, the invariant numbers above | **Yes** | The drill counts rows in the restored database, and every value these figures depend on is deterministic |
| Manifest's `estimatedRows` — the `~1,496,499` in the backup line | **No** — on the 13-table fixture we saw 1,495,250 / 1,745,499 / 1,495,499 in July and 1,745,499 in October | It is `n_live_tup`, a planner estimate the collector can inflate right after a bulk load |
| Dump and `auth.dump` sha256 | **No** | Two reasons: the random uuid keys, `now()` stamps and bcrypt salts above mean the bytes genuinely differ, and `pg_dump` writes a creation timestamp into the archive header, so even identical data would not hash the same |
| `pg_restore` seconds | **No** | Hardware |

The first two rows are the reason the drill measures instead of trusting the
manifest: on one of our runs the manifest claimed 250,000 more rows than the
database actually held, and the drill's count was right anyway. The manifest's
row counts are estimates, which is exactly why the check is "every table that
had rows came back non-empty" rather than "the row counts match".

**Restore time is hardware, not a product claim.** 1.9 s is a 21.6 MB dump
restored into a container on the same laptop. Your number depends on dump size,
disk, and network — which is the point of measuring it on a schedule instead of
guessing.

## Three honest gaps in this fixture

1. The source is a local Postgres, not a hosted Supabase project, so the backup
   cannot read `storage.buckets` and records bucket attributes as **absent**
   rather than inventing them. Against a real project they are captured.
2. Your RLS policies are **restored, not tested**. The sandbox creates stub
   `authenticated` / `anon` roles and `auth.uid()`-style functions so the
   policies can be created (CLI 2.1.0, which produced the July report, listed
   them as five expected skips instead), but nothing exercises them. Verifying
   RLS behavior takes an authenticated client stack with real JWTs, which no
   restore sandbox can fake.
3. The sign-in target runs Supabase's own Postgres image and GoTrue on your
   machine; it is not a hosted project. Only password sign-in is exercised: the
   400 Google users are restored, but signing them in needs a Google OAuth
   client, which a new project has to be given again anyway. Sessions, MFA
   factors and Auth settings are not in a snapshot, so a restore does not bring
   them back and this run does not test them.
