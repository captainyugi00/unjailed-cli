import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "unjailed-pricing-"));
process.env.UNJAILED_HOME = home;
process.env.NO_COLOR = "1";
const { parsePriceList, costOf, costParts, formatCost, catalogUrl, loadPrices } = await import("../dist/pricing.js");
const { usageLines, bar } = await import("../dist/ui/UsagePanel.js");
const stringWidth = (await import("string-width")).default;

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const CATALOG = { models: [
  { id: "glm-5.3", pricing: { input: 0.75, cachedInput: 0.08, output: 3, currency: "USD", unit: "per_million_tokens" } },
  { id: "eur-model", pricing: { input: 1, output: 2, currency: "EUR", unit: "per_million_tokens" } },
  { id: "no-cache", pricing: { input: 2, output: 8 } },
  { id: "broken", pricing: { input: "x" } },
] };

test("the catalog parses to USD-per-million prices; other currencies and broken rows are skipped", () => {
  const p = parsePriceList(CATALOG);
  assert.deepEqual(Object.keys(p).sort(), ["glm-5.3", "no-cache"]);
  assert.deepEqual(p["glm-5.3"], { input: 0.75, cachedInput: 0.08, output: 3 });
  assert.equal(p["no-cache"].cachedInput, 2, "no cached rate: cached tokens bill at the input rate");
  assert.equal(catalogUrl("https://unjailedai.com/v1"), "https://unjailedai.com/models.json");
});

test("cost matches the provider's formula: fresh input, cached input and output at their rates", () => {
  const p = parsePriceList(CATALOG)["glm-5.3"];
  const u = { prompt: 11_451, cached: 704, completion: 445, total: 0 };
  // The numbers from a real run, cross-checked against an independent proxy log.
  assert.equal(costOf(p, u).toFixed(4), "0.0095");
  const parts = costParts(p, u);
  assert.ok(Math.abs(parts.input + parts.cached + parts.output - costOf(p, u)) < 1e-12);
  assert.equal(costOf(undefined, u), undefined);
  assert.equal(formatCost(0.00423), "$0.0042");
  assert.equal(formatCost(0.0423), "$0.042");
  assert.equal(formatCost(4.2), "$4.20");
});

test("prices are fetched live, cached for a day, and an old list is used when offline", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json(CATALOG); };
  try {
    assert.equal((await loadPrices("https://example.test/v1"))["glm-5.3"].output, 3);
    await loadPrices("https://example.test/v1");
    assert.equal(calls, 1, "second load uses the day-long cache");
    await loadPrices("https://example.test/v1", undefined, true);
    assert.equal(calls, 2, "fresh=true always asks the API");
    globalThis.fetch = async () => { throw new TypeError("offline"); };
    assert.equal((await loadPrices("https://example.test/v1", undefined, true))["glm-5.3"].input, 0.75, "offline: last known list");
  } finally { globalThis.fetch = original; }
});

test("the usage panel shows spend, the split, periods and rates, and fits narrow terminals", () => {
  const view = {
    session: { turns: 3, workMs: 1000, requests: 9, retries: 0, recoveries: 0, tokensIn: 50_000, tokens: 2_000, reasoning: 300, tools: 4, agents: 1, cost: 0.0523, costIn: 0.03, costCached: 0.0023, costOut: 0.02, cachedTokens: 20_000, billedRequests: 9 },
    running: true, turnCost: 0.004, model: "glm-5.3", price: { input: 0.75, cachedInput: 0.08, output: 3 }, prices: "live", source: "unjailedai.com/models.json",
    periods: [{ label: "Today", cost: 0.0523, chats: 1, unpriced: 0 }, { label: "All chats", cost: 1.2, chats: 12, unpriced: 3 }],
  };
  const wide = usageLines(view, 96, 1, "◐").join("\n");
  assert.match(wide, /This chat\s+\$0\.052\s+3 turns · 9 requests/);
  assert.match(wide, /↑ 50k in \(20k cached\)\s+↓ 2k out\s+∴ 300 thinking/);
  assert.match(wide, /input \$0\.030 {2}· {2}■ cached \$0\.0023 {2}· {2}■ output \$0\.020/);
  assert.match(wide, /This turn\s+\$0\.0040/);
  assert.match(wide, /All chats\s+\$1\.20.*12 chats, 3 untracked/);
  assert.match(wide, /\$0\.75 in · \$0\.08 cached · \$3 out/);
  for (const w of [40, 56, 96]) for (const line of usageLines(view, w, 1, "◐")) assert.ok(stringWidth(line) <= w + 2, `${w}: ${line}`);
  const half = usageLines(view, 96, 0.3, "◐").join("\n");
  assert.doesNotMatch(half, /This chat\s+\$0\.052/, "numbers count up while it animates in");
  assert.equal(stringWidth(bar(0.5, 10, (s) => s)), 10);
});
