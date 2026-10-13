import { test } from "node:test";
import assert from "node:assert/strict";

// A 50 ms reasoning deadline for this file (read once when the code loads).
process.env.UNJAILED_REASONING_TIMEOUT = "0.05";
const { evaluateGoal } = await import("../dist/goal.js");

const enc = new TextEncoder();
const thinkingForever = () => new Response(new ReadableStream({ start(c) {
  const t = setInterval(() => { try { c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "hmm" } }] })}\n\n`)); } catch { clearInterval(t); } }, 5);
} }), { headers: { "content-type": "text/event-stream" } });
const goal = { condition: "tests pass", turns: 0, maxTurns: 5, startedAt: 0 };
const conn = { baseUrl: "http://x/v1", key: "k", model: "m" };

test("a goal check that reasons past the deadline is retried with longer deadlines, then succeeds", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => (++calls < 3 ? thinkingForever() : Response.json({ choices: [{ message: { content: '{"met": true, "reason": "done"}' } }] }));
  try {
    const v = await evaluateGoal(conn, goal, "E", new AbortController().signal);
    assert.equal(v.met, true);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});

test("after three deadlines the goal check reports it clearly", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return thinkingForever(); };
  try {
    await assert.rejects(evaluateGoal(conn, goal, "E", new AbortController().signal), /goal check kept reasoning without answering \(3 tries/);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});
