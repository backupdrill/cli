// runRestore 在任何 I/O 之前拒绝身份不可考的**源**配置(集群别名 / 租户覆盖):
// 只查目标的话,一个路由到目标的源别名能绕过同源阻断(交叉审查)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { runRestore } from "../dist/restore.js";

const REF = "abcdefghijklmnopqrst";
const POOLER = "aws-0-us-east-1.pooler.supabase.com";
// 桶指向一个不可达地址:若守卫没在 I/O 前抛出,会看到网络错误而不是 /cluster|options/
const storage = {
  bucket: "never-reached",
  region: "auto",
  endpoint: "https://s3.invalid.localhost.test",
  accessKeyId: "a",
  secretAccessKey: "b",
};

test("runRestore:源配置是 Supavisor 集群别名串 → I/O 前拒绝", async () => {
  const config = { databaseUrl: `postgresql://postgres.cluster.${REF}:pw@${POOLER}:5432/postgres`, storage };
  await assert.rejects(
    runRestore(config, { targetDatabaseUrl: `postgresql://postgres.zyxwvutsrqponmlkjihg:pw@${POOLER}:5432/postgres`, dryRun: true }),
    /cluster/
  );
});

test("runRestore:源配置带 ?options= 租户覆盖、且有远端目标 → I/O 前拒绝", async () => {
  const config = { databaseUrl: `postgresql://postgres.${REF}:pw@${POOLER}:5432/postgres?options=reference%3Dzyxwvutsrqponmlkjihg`, storage };
  await assert.rejects(
    runRestore(config, { targetDatabaseUrl: `postgresql://postgres.zyxwvutsrqponmlkjihg:pw@${POOLER}:5432/postgres`, dryRun: true }),
    /options/
  );
});

test("runRestore:纯本地下载(无远端目标)不因源配置不可考而被拒——守卫放行后才到桶 I/O", async () => {
  const config = { databaseUrl: `postgresql://postgres.cluster.${REF}:pw@${POOLER}:5432/postgres`, storage };
  // 断言失败发生在桶 I/O(不可达的 storage 主机),而不是守卫:证明本地下载路径没被源守卫拦下
  await assert.rejects(runRestore(config, { dryRun: true }), (error) => {
    const message = String(error && error.message);
    return !/cluster|options/.test(message) && /ENOTFOUND|getaddrinfo|invalid\.localhost\.test|ECONNREFUSED|EAI_AGAIN/.test(message);
  });
});

test("runRestore:目标串是集群别名同样在 I/O 前拒绝", async () => {
  const config = { databaseUrl: `postgresql://postgres.${REF}:pw@${POOLER}:5432/postgres`, storage };
  await assert.rejects(
    runRestore(config, { targetDatabaseUrl: `postgresql://postgres.cluster.zyxwvutsrqponmlkjihg:pw@${POOLER}:5432/postgres`, dryRun: true }),
    /cluster/
  );
});
