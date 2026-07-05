// Regression test for the pg_dump version parser. This bug class ("works on dev Mac, breaks on the
// deployed Debian/PGDG worker") slipped through once because the parser had no test — the Debian
// build appends a "(Debian …)" vendor suffix that an end-anchored regex could not handle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePgDumpMajor } from "../dist/backup.js";

const CASES = [
  ["Homebrew / macOS (dev)", "pg_dump (PostgreSQL) 17.2", 17],
  // The exact string produced by our runtime image (postgresql-client-17 on bookworm-slim).
  ["Debian / PGDG (prod)", "pg_dump (PostgreSQL) 17.10 (Debian 17.10-1.pgdg120+1)", 17],
  ["Ubuntu suffix", "pg_dump (PostgreSQL) 16.4 (Ubuntu 16.4-1.pgdg22.04+1)", 16],
  ["no suffix, older major", "pg_dump (PostgreSQL) 15.8", 15],
];

for (const [label, raw, expected] of CASES) {
  test(`parses major from ${label}`, () => {
    assert.equal(parsePgDumpMajor(raw), expected);
  });
}

test("returns null for unparseable output", () => {
  assert.equal(parsePgDumpMajor("pg_dump: command not found"), null);
});
