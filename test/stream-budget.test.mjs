import { test } from "node:test";
import assert from "node:assert/strict";

// A tiny per-response budget, set before the API module reads it, so the test
// doesn't have to stream tens of megabytes to prove the cap works.
process.env.UNJAILED_MAX_STREAM_MB = "0.05"; // ~52 KB
const { streamChatRetry, agentTurn } = await import("../dist/api.js");

const enc = new TextEncoder();
const sse = (obj) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
const delta = (d, finish = null) => sse({ choices: [{ delta: d, finish_reason: finish }] });

/** An endless stream of content tokens that never sends finish or [DONE]. */
function runaway() {
  return () => new Response(new ReadableStream({
    pull(c) { c.enqueue(delta({ content: "x".repeat(4000) })); },
  }), { headers: { "content-type": "text/event-stream" } });
}

async function withFetch(script, fn) {
  const { fetch, requests } = (() => {
    const requests = [];
    return { fetch: async (_u, init) => { requests.push(JSON.parse(init.body)); return script[Math.min(requests.length - 1, script.length - 1)](); }, requests };
  })();
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  try { return await fn(requests); } finally { globalThis.fetch = original; }
}

test("a runaway response is cut off at the budget instead of growing forever", async () => {
  let streamed = 0;
  const res = await withFetch([runaway()], () =>
    streamChatRetry("http://local.test/v1", "k", "m", [{ role: "user", content: "q" }],
      { onToken: (t) => { streamed += t.length; } }, new AbortController().signal, { maxAttempts: 1 }));
  // It produced output, so the retry layer returns it as resumable (incomplete),
  // and it stopped near the cap rather than running away.
  assert.equal(res.incomplete, true);
  assert.ok(streamed > 0 && streamed < 2_000_000, `streamed ${streamed} bytes — should stop near the ~52 KB cap`);
});

test("the agent loop resumes after an oversized cut-off and still finishes", async () => {
  // First response runs away; the second (the resume) finishes cleanly.
  const good = () => new Response(new ReadableStream({ start(c) { c.enqueue(delta({ content: " done." }, "stop")); c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
  const res = await withFetch([runaway(), good], () =>
    agentTurn("http://local.test/v1", "k", "m", [{ role: "user", content: "q" }],
      { onToken: () => {}, onRetry: () => {} }, new AbortController().signal, { backoff: () => 1 }));
  assert.equal(res.end, "done");
  assert.match(res.text, /done\./);
});
