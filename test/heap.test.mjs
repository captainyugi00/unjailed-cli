import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { targetHeapMB } from "../dist/heap.js";

const GB = 1024 * 1024 * 1024;

test("targetHeapMB raises the heap on roomy machines and leaves headroom", () => {
  // 8 GB machine, default ~2 GB limit → ~0.75×, below total−reserve.
  assert.equal(targetHeapMB(8 * GB, 2096), Math.floor(8192 * 0.75)); // 6144
  // 16 GB → capped at the absolute 16384 ceiling only on huge machines; here 0.75×16384=12288.
  assert.equal(targetHeapMB(16 * GB, 2096), 12288);
  // 4 GB → 0.75×4096=3072, but reserve is max(1024,min(2048,1024))=1024 → total−reserve=3072.
  assert.equal(targetHeapMB(4 * GB, 2096), 3072);
});

test("targetHeapMB never lowers, and no-ops when already high enough", () => {
  assert.equal(targetHeapMB(8 * GB, 6144), null);  // already at target
  assert.equal(targetHeapMB(8 * GB, 8192), null);  // already higher
  assert.equal(targetHeapMB(2 * GB, 2096), null);  // small machine, target<=current+512
  assert.equal(targetHeapMB(1 * GB, 2096), null);  // tiny machine, floor 2048 ≤ current
});

test("targetHeapMB honors an explicit override but only to raise", () => {
  assert.equal(targetHeapMB(8 * GB, 2096, "4096"), 4096);
  assert.equal(targetHeapMB(64 * GB, 2096, "3000"), 3000); // override wins over the formula
  assert.equal(targetHeapMB(8 * GB, 5000, "4096"), null);  // override below current → skip
  assert.equal(targetHeapMB(8 * GB, 2096, "nonsense"), null);
  assert.equal(targetHeapMB(8 * GB, 2096, "0"), null);
});

test("never proposes an absurd heap on a huge machine", () => {
  assert.ok((targetHeapMB(256 * GB, 2096) ?? 0) <= 16384);
});

// End to end: the CLI actually re-execs with a raised old-space limit.
test("the CLI re-execs Node with a bigger --max-old-space-size", () => {
  const heap = new URL("../dist/heap.js", import.meta.url).href;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uj-heap-"));
  const probe = path.join(dir, "probe.mjs");
  // Stands in for the bin: raise the heap, then (in the re-exec'd child, which
  // skips re-tuning) report the limit it actually runs under.
  fs.writeFileSync(probe, [
    `import { ensureHeadroom } from ${JSON.stringify(heap)};`,
    `import v8 from "node:v8";`,
    `const code = ensureHeadroom(process.argv);`,
    `if (code !== null) process.exit(code);`,
    `process.stdout.write("LIMIT=" + Math.round(v8.getHeapStatistics().heap_size_limit / 1048576));`,
  ].join("\n"));
  const r = spawnSync(process.execPath, [probe], {
    encoding: "utf8",
    env: { ...process.env, UNJAILED_MAX_OLD_SPACE: "3333", UNJAILED_HEAP_TUNED: "", NODE_OPTIONS: "" },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  const limit = Number(/LIMIT=(\d+)/.exec(r.stdout)?.[1]);
  assert.ok(limit >= 3200 && limit <= 3466, `expected a ~3333 MB limit, got: ${r.stdout} ${r.stderr}`);
});

test("does not re-exec when told not to, or when already tuned", () => {
  const run = (env) => spawnSync(process.execPath, ["--input-type=module", "-e",
    `import {ensureHeadroom} from '${new URL("../dist/heap.js", import.meta.url).pathname}';` +
    `process.stdout.write(String(ensureHeadroom([process.execPath, 'x.js'])));`],
    { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(run({ UNJAILED_NO_HEAP_TUNE: "1", UNJAILED_MAX_OLD_SPACE: "9999" }).stdout, "null");
  assert.equal(run({ UNJAILED_HEAP_TUNED: "1", UNJAILED_MAX_OLD_SPACE: "9999" }).stdout, "null");
  assert.equal(run({ NODE_OPTIONS: "--max-old-space-size=9000", UNJAILED_MAX_OLD_SPACE: "9999" }).stdout, "null");
});
