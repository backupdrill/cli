import { test } from "node:test";
import assert from "node:assert/strict";
import { overageNote } from "../dist/estimate.js";

// Supabase 只有 Pro 有 Spend Cap(默认开);Team 没有,超额直接计费。
// 2.7.1 及以前 estimate --plan team 也说 "Spend Cap is ON by default on Pro/Team"。

test("Pro: warns that the default Spend Cap blocks egress past the quota", () => {
  const note = overageNote({ planLabel: "Pro", includedGb: 250, pricePerGb: 0.09, hardCap: false, spendCap: true });
  assert.match(note, /^Spend Cap is ON by default on Pro\./);
  assert.doesNotMatch(note, /Team/);
});

test("Team: says there is no Spend Cap and overage is billed", () => {
  const note = overageNote({ planLabel: "Team", includedGb: 250, pricePerGb: 0.09, hardCap: false, spendCap: false });
  assert.equal(
    note,
    "Team has no Spend Cap: egress past the 250 GB quota is billed at $0.09/GB, so the numbers above are what you'd pay."
  );
});

test("pricing without spendCap keeps the Spend Cap warning (library callers from before the field existed)", () => {
  const note = overageNote({ planLabel: "Pro", includedGb: 250, pricePerGb: 0.09, hardCap: false });
  assert.match(note, /^Spend Cap is ON by default on Pro\./);
});
