// 固件完整性:examples/reproducible-drill 对外承诺"clone 下来就能复现",
// 所以 run.sh 引用的每个文件都必须真的在版本库里。
// 这条测试的由来:config 文件曾被 .gitignore 的 backupdrill.config.json 规则
// 静默吞掉,本机能跑、fresh clone 必炸,而没有任何环节会发现。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exampleDir = join(repoRoot, "examples/reproducible-drill");

const tracked = new Set(
  execFileSync("git", ["ls-files", "examples/reproducible-drill"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .map((p) => p.replace("examples/reproducible-drill/", "")),
);

const REQUIRED = [
  "run.sh",
  "config.template.json",
  "source-schema.sql",
  "source-seed.sql",
  "storage-setup.mjs",
  "check-invariants.mjs",
  "README.md",
];

test("every file the reproduction needs is committed", () => {
  for (const file of REQUIRED) {
    assert.ok(tracked.has(file), `${file} is missing from git — a fresh clone cannot reproduce the drill`);
  }
});

test("run.sh references no file that git ignores", () => {
  const script = readFileSync(join(exampleDir, "run.sh"), "utf8");
  for (const file of REQUIRED) {
    if (file === "README.md" || !script.includes(file)) continue;
    // check-ignore 退出 0 = 被忽略(不合格),退出 1 = 未被忽略(合格)
    let ignored = false;
    try {
      execFileSync("git", ["check-ignore", "-q", `examples/reproducible-drill/${file}`], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      ignored = true;
    } catch {
      ignored = false;
    }
    assert.equal(ignored, false, `${file} is gitignored but run.sh needs it`);
  }
});

test("no credential literals live in the fixture source", () => {
  for (const file of ["run.sh", "storage-setup.mjs", "check-invariants.mjs", "config.template.json"]) {
    const body = readFileSync(join(exampleDir, file), "utf8");
    assert.doesNotMatch(body, /bdreport|sourcepw|secret-2026/, `${file} still carries a hard-coded credential`);
  }
});
