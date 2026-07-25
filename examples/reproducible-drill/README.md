# Reproducible restore drill

Everything here reproduces the drill report published at
**<https://backupdrill.com/drill-report>** — same schema, same seed, same
commands. Run it and compare your output to ours.

```bash
./run.sh
```

Requires Docker, Node ≥ 20, and `pg_dump`/`pg_restore` ≥ 17. It creates two
throwaway containers and removes them on exit; nothing touches a real project.

## What it builds

A **Supabase-shaped** Postgres 17 source, because the shapes that break restores
are the platform-specific ones:

- RLS policies granted `TO authenticated` / `TO anon` — roles that do **not**
  exist in a bare restore sandbox
- extensions (`pg_trgm`, `pgcrypto`) installed into their own `extensions`
  schema, with a GIN trigram index that depends on one of them
- a range-partitioned table, a materialized view, a trigger, and FK graphs
- an `attachments` table holding object keys — the pointers a database-only
  restore brings back without the files behind them
- one intentionally empty table, so you can see that "populated tables came
  back" only judges tables that had rows at backup time

Seed: 13 tables, 1,495,250 rows, ~197 MB on disk, plus 250 files (35 MB) in an
S3-compatible store standing in for Supabase Storage. Both the row values and
the file bytes are generated deterministically, so a rerun produces the same
data — and the same per-file sha256.

## What we measured

Backup:

```
→ Inspecting database…
✓ Postgres 17.10 — schema(s) public: 13 tables, ~1,495,499 rows
→ Dumping → s3://acme-backups/backupdrill/acme-prod/2026-07-25T14-07-06-441Z/dump.pgcustom
✓ Database dumped (21.6 MB, sha256 210958d28579…)
→ Syncing Storage files…
→   user-uploads: 250 files
✓ Storage synced (250 files, 33.6 MB)
✓ Recovery runbook written → …/RECOVERY.md
✓ Manifest written → …/manifest.json
✓ Backup complete — 13 tables + 250 Storage files.
```

Drill:

```
✓ archive integrity — sha256 matches (210958d28579…)
✓ storage file integrity — all 250 files match their manifest checksums
✓ sandbox extensions — installed pg_trgm, pgcrypto
✓ pg_restore — completed in 2.3s
✓ post-data objects — user objects restored; 5 Supabase-managed object(s) skipped
✓ table count — restored 13, manifest 13
✓ no missing tables — all manifest tables present
✓ populated tables came back — no populated table restored empty
✓ app checks — command exited 0 in 0.1s

✓ Drill PASSED — 13 tables / 1,495,250 rows restored in 2.3s
```

`check-invariants.mjs` is what `--check-cmd` runs inside the sandbox. It proves
the data is genuinely there rather than trusting the structural checks:

```
row counts: {"orders":"200000","order_items":"600000","customers":"20000","attachments":"250","events":"300000"}
orphan order_items: 0 | orphan orders: 0
revenue orders vs matview: 25099150000 vs 25099150000
```

## What is and isn't identical when you rerun this

We ran it three times. Worth knowing before you compare:

| Value | Stable across runs? | Why |
|---|---|---|
| Measured rows restored (1,495,250), table count, per-file sha256, the invariant numbers above | **Yes** | The drill counts rows in the restored database, and the fixture data is deterministic |
| Manifest's `estimatedRows` — the `~1,495,499` in the backup line | **No** — we saw 1,495,250 / 1,745,499 / 1,495,499 | It is `n_live_tup`, a planner estimate the collector can inflate right after a bulk load |
| Dump sha256 | **No** | `pg_dump` writes a creation timestamp into the archive header, so identical data still hashes differently |
| `pg_restore` seconds | **No** | Hardware |

The first two rows are the reason the drill measures instead of trusting the
manifest: on one of our runs the manifest claimed 250,000 more rows than the
database actually held, and the drill's count was right anyway. The manifest's
row counts are estimates, which is exactly why the check is "every table that
had rows came back non-empty" rather than "the row counts match".

**Restore time is hardware, not a product claim.** 2.3 s is a 21.6 MB dump
restored into a container on the same laptop. Your number depends on dump size,
disk, and network — which is the point of measuring it on a schedule instead of
guessing.

## Two honest gaps in this fixture

1. The source is a local Postgres, not a hosted Supabase project, so the backup
   cannot read `storage.buckets` and records bucket attributes as **absent**
   rather than inventing them. Against a real project they are captured.
2. `5 Supabase-managed object(s) skipped` are the RLS policies bound to
   `authenticated`/`anon`. Those roles do not exist in a bare sandbox, so the
   drill records them as expected skips — it does **not** claim your RLS rules
   were verified. Verifying RLS behavior takes an authenticated client stack
   with real JWTs, which no restore sandbox can fake.
