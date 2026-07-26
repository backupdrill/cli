// 建两个 S3 桶:user-uploads(Storage 源,存真实文件)、acme-backups(备份目标)。
// 文件内容确定性生成,便于第三方复现同一批 sha256。
import { createHash, createHmac } from "node:crypto";
import { S3Client, CreateBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import pg from "pg";

// 凭据与端点由 run.sh 每次运行生成并经环境变量传入,源码里不留密钥
const s3 = new S3Client({
  endpoint: process.env.BD_DEMO_S3_ENDPOINT,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.BD_DEMO_S3_ACCESS_KEY,
    secretAccessKey: process.env.BD_DEMO_S3_SECRET_KEY,
  },
});

for (const Bucket of ["user-uploads", "acme-backups"]) {
  try {
    await s3.send(new CreateBucketCommand({ Bucket }));
    console.log("created bucket", Bucket);
  } catch (e) {
    console.log("bucket", Bucket, "->", e.name);
  }
}

// 确定性内容:seed 决定字节,任何人重跑得到同样的 sha256
function bodyFor(seed, size) {
  const out = Buffer.alloc(size);
  let block = createHash("sha256").update(`backupdrill-demo:${seed}`).digest();
  for (let off = 0; off < size; off += 32) {
    block.copy(out, off, 0, Math.min(32, size - off));
    block = createHmac("sha256", block).update("next").digest();
  }
  return out;
}

const KINDS = [
  { dir: "avatars", ext: "png", type: "image/png", min: 8_000, max: 60_000, n: 90 },
  { dir: "invoices", ext: "pdf", type: "application/pdf", min: 40_000, max: 300_000, n: 70 },
  { dir: "exports", ext: "csv", type: "text/csv", min: 100_000, max: 900_000, n: 40 },
  { dir: "product-photos", ext: "jpg", type: "image/jpeg", min: 60_000, max: 400_000, n: 50 },
];

const client = new pg.Client({ connectionString: process.env.BD_DEMO_PG_URL });
await client.connect();
const { rows: customers } = await client.query("select id from public.customers limit 400");

let count = 0;
let bytes = 0;
const rows = [];
for (const kind of KINDS) {
  for (let i = 1; i <= kind.n; i++) {
    const seed = `${kind.dir}/${i}`;
    const size = kind.min + ((i * 7919) % (kind.max - kind.min));
    const key = `${kind.dir}/${String(i).padStart(4, "0")}.${kind.ext}`;
    const body = bodyFor(seed, size);
    await s3.send(
      new PutObjectCommand({
        Bucket: "user-uploads",
        Key: key,
        Body: body,
        ContentType: kind.type,
        CacheControl: "max-age=3600",
      }),
    );
    rows.push([customers[count % customers.length].id, "user-uploads", key, size, kind.type]);
    count += 1;
    bytes += size;
  }
  console.log(`${kind.dir}: ${kind.n} files`);
}

// attachments 表 = 数据库里的"指针";文件本体只在对象存储里
for (const [customerId, bucket, key, size, type] of rows) {
  await client.query(
    `insert into public.attachments (customer_id, bucket, object_key, bytes, content_type)
     values ($1,$2,$3,$4,$5) on conflict (bucket, object_key) do nothing`,
    [customerId, bucket, key, size, type],
  );
}
await client.query("analyze public.attachments");
await client.end();

console.log(`TOTAL: ${count} files, ${(bytes / 1e6).toFixed(1)} MB, attachments rows written`);
