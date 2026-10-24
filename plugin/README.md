# BackupDrill plugin

Back up a Supabase project to a bucket you own and prove the backup restores, by asking your coding agent. The plugin is one skill that teaches the agent to use [backupdrill](https://github.com/backupdrill/cli), the open-source (MIT) CLI behind backupdrill.com:

- `estimate` measures the database and Storage files and projects the Supabase egress cost of backing them up.
- `backup` dumps the Postgres database with `pg_dump`, plus Storage files once you add their S3 keys, into your S3, R2 or B2 bucket, with a checksummed `manifest.json` and a `RECOVERY.md` in every snapshot.
- `drill` restores a snapshot into a throwaway Postgres in Docker, checks that the tables and their data came back, and checksums a sample of the Storage files.
- `restore` puts a snapshot into a new, empty Supabase project, after a dry run and only once you confirm the target.

The agent runs every command as `npx -y backupdrill@2.7.1`, so the CLI version stays fixed.

## What you need

- A shell the agent can use, such as Claude Code. In a chat with no terminal, the agent can explain the commands but not run them.
- Node.js 20 or newer.
- `pg_dump` and `pg_restore` version 17, which handle Supabase's Postgres 15 to 17. On macOS: `brew install libpq@17` (plain `libpq` is now 18, whose dumps can contain SQL that Postgres 17 rejects).
- Docker, for `drill`.
- A bucket on AWS S3, Cloudflare R2 or Backblaze B2, with a key that can list, read and write objects in it.

## Install

In Claude Code:

```
/plugin marketplace add backupdrill/cli
/plugin install backupdrill@backupdrill
```

Or from a terminal:

```sh
claude plugin install backupdrill --marketplace backupdrill/cli
```

In Pi, the same skill comes with the npm package:

```sh
pi install npm:backupdrill
```

## Things to ask

- "Back up my Supabase project to my R2 bucket."
- "How much egress would a daily backup of this project add on the Pro plan?"
- "Run a restore drill on the latest backup and tell me whether it passed."
- "Set up a weekly backup in GitHub Actions."
- "Restore last night's snapshot into my new staging project. Dry run first."

## Your credentials

The skill keeps your connection string and bucket keys in `.env.backupdrill` in your project root and adds that file to `.gitignore`. It creates the file with placeholders and asks you to fill it in your editor. The agent is told never to open or print the file, never to ask for keys in the chat, and to load the file only for the command that needs it.

## What runs and where your data goes

Everything runs on your machine:

- `npx` downloads the `backupdrill` package from the npm registry the first time.
- The CLI connects to your Supabase project's database, to its Storage if you add Storage S3 keys, and to your bucket. `restore` also connects to the target project you name.
- `drill` starts a temporary Postgres container in Docker. The first time, Docker downloads the Postgres image from Docker Hub.
- Nothing goes to BackupDrill. There is no account, telemetry or license check.

What the agent reads while it works, such as command output with table names, row counts and file names, goes to your model provider like the rest of your conversation. The CLI itself never deletes objects in your bucket.

## Troubleshooting

- `Missing required config`: the message names the missing setting. Fill that line in `.env.backupdrill`.
- A `pg_dump` version error: install the version 17 PostgreSQL client and set `BACKUPDRILL_PG_DUMP` to its `pg_dump`.
- Can't connect to the database: use the Session pooler string from the Connect button in the Supabase dashboard, not the Direct one. Resume the project if it's paused.
- `drill` can't start a container: start Docker.

The CLI's [README](https://github.com/backupdrill/cli#readme) covers every option, and [backupdrill.com/docs/cli](https://backupdrill.com/docs/cli) walks through the same steps.

## Support

Open an issue at [github.com/backupdrill/cli/issues](https://github.com/backupdrill/cli/issues) or email support@backupdrill.com. Privacy policy: [backupdrill.com/privacy](https://backupdrill.com/privacy).

## License

MIT
