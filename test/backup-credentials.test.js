// 凭据不进 argv(D6)的备份侧回归:恢复路径早就把密码拆进 PGPASSWORD,备份的 pg_dump
// 漏了,连接串整段(含密码)在 argv 里,同机任何进程 `ps` 都能看到。这里把 runBackup
// 整条跑一遍,pg_dump 换成一个把自己收到的 argv 和 PGPASSWORD 写进文件的 shell 脚本。
// 打桩方式同 backup-part-size.test.js。
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { runBackup } from "../dist/backup.js";

async function pgDumpInvocationFor(databaseUrl) {
  const dir = mkdtempSync(join(tmpdir(), "bd-fake-pgdump-"));
  const fakePgDump = join(dir, "pg_dump");
  writeFileSync(
    fakePgDump,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 17.2"; exit 0; fi',
      `printf '%s\\n' "$@" > '${join(dir, "argv")}'`,
      `printf '%s' "\${PGPASSWORD-}" > '${join(dir, "pgpassword")}'`,
      'printf "PGDMP-fake"',
      "",
    ].join("\n")
  );
  chmodSync(fakePgDump, 0o755);
  const previousPgDump = process.env.BACKUPDRILL_PG_DUMP;
  const previousPassword = process.env.PGPASSWORD;
  process.env.BACKUPDRILL_PG_DUMP = fakePgDump;
  process.env.PGPASSWORD = "inherited-from-the-shell"; // URL 里的密码必须盖过继承来的

  const mocks = [
    mock.method(pg.Client.prototype, "connect", async () => {}),
    mock.method(pg.Client.prototype, "end", async () => {}),
    mock.method(pg.Client.prototype, "query", async (sql) => {
      if (sql === "show server_version") return { rows: [{ server_version: "17.2" }] };
      if (sql === "show server_version_num") return { rows: [{ server_version_num: "170002" }] };
      if (sql.includes("pg_total_relation_size")) return { rows: [{ bytes: "1024" }] };
      return { rows: [] };
    }),
    mock.method(S3Client.prototype, "send", async () => ({})),
    mock.method(console, "error", () => {}),
    mock.method(Upload.prototype, "done", async function () {
      for await (const _chunk of this.params.Body); // 读完转储流,pg_dump 才能正常退出
      return {};
    }),
  ];
  try {
    await runBackup({
      databaseUrl,
      projectName: "credentials-test",
      schemas: ["public"],
      storage: {
        endpoint: "http://127.0.0.1:1",
        region: "us-east-1",
        bucket: "target",
        accessKeyId: "k",
        secretAccessKey: "s",
        prefix: "backupdrill",
        forcePathStyle: true,
      },
    });
    return {
      argv: readFileSync(join(dir, "argv"), "utf8"),
      pgPassword: readFileSync(join(dir, "pgpassword"), "utf8"),
    };
  } finally {
    for (const m of mocks) m.mock.restore();
    if (previousPgDump === undefined) delete process.env.BACKUPDRILL_PG_DUMP;
    else process.env.BACKUPDRILL_PG_DUMP = previousPgDump;
    if (previousPassword === undefined) delete process.env.PGPASSWORD;
    else process.env.PGPASSWORD = previousPassword;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("备份:密码不进 pg_dump 的 argv,经 PGPASSWORD 传,且盖过继承的 PGPASSWORD", async () => {
  const { argv, pgPassword } = await pgDumpInvocationFor("postgresql://u:s3cret-pw@127.0.0.1:5432/db");
  assert.ok(!argv.includes("s3cret-pw"), "password leaked into argv");
  assert.match(argv, /postgresql:\/\/u@127\.0\.0\.1:5432\/db/);
  assert.equal(pgPassword, "s3cret-pw");
});

test("备份:百分号编码的密码解码后进 PGPASSWORD,编码前后都不留在 argv", async () => {
  const { argv, pgPassword } = await pgDumpInvocationFor("postgresql://u:p%40ss%2Fword@127.0.0.1:5432/db");
  assert.ok(!argv.includes("p%40ss"), "encoded password leaked into argv");
  assert.ok(!argv.includes("p@ss"), "decoded password leaked into argv");
  assert.equal(pgPassword, "p@ss/word");
});

test("备份:连接串里有字面 # 时,连库之前就拒绝(否则预检连 trusted、pg_dump 连 evil)", async () => {
  const connect = mock.method(pg.Client.prototype, "connect", async () => {});
  try {
    await assert.rejects(
      runBackup({
        databaseUrl: "postgresql://u@127.0.0.1:5432/db?password=pw#?host=10.0.0.1",
        projectName: "credentials-test",
        schemas: ["public"],
        storage: {
          endpoint: "http://127.0.0.1:1",
          region: "us-east-1",
          bucket: "target",
          accessKeyId: "k",
          secretAccessKey: "s",
          prefix: "backupdrill",
          forcePathStyle: true,
        },
      }),
      /literal '#'/
    );
    assert.equal(connect.mock.callCount(), 0, "must reject before any connection");
  } finally {
    connect.mock.restore();
  }
});

test("备份:?password= 查询参数同样剥离,不进 argv", async () => {
  const { argv, pgPassword } = await pgDumpInvocationFor("postgresql://u@127.0.0.1:5432/db?password=q-secret");
  assert.ok(!argv.includes("q-secret"), "query password leaked into argv");
  assert.equal(pgPassword, "q-secret");
});
