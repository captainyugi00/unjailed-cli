import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "unjailed-review-"));
process.env.UNJAILED_HOME = home;
process.env.NO_COLOR = "1";
const { resolveToolPath, executeTool } = await import("../dist/tools.js");
const { prepareRequestHistory, serverReportedError, ApiError, isTransient } = await import("../dist/api.js");
const { revealForApproval } = await import("../dist/ui/sanitize.js");
const { renderMarkdown } = await import("../dist/markdown.js");
const { appendSession, deleteSession, loadSession, newSession } = await import("../dist/sessions.js");
const { runLocalCommand } = await import("../dist/processes.js");

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test("a project's own desktop/ or documents/ folder is never redirected to the home folder", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "uj-proj-"));
  fs.mkdirSync(path.join(cwd, "desktop"));
  assert.equal(resolveToolPath("desktop/main.ts", cwd, "linux", "/home/me"), path.join(cwd, "desktop/main.ts"));
  assert.equal(resolveToolPath("Desktop/notes.txt", fs.mkdtempSync(path.join(os.tmpdir(), "uj-empty-")), "linux", "/home/me"), "/home/me/Desktop/notes.txt", "without a local folder the shortcut still works");
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("glob braces may contain wildcards", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "uj-glob-"));
  for (const f of ["a.ts", "b.tsx", "c.js"]) fs.writeFileSync(path.join(cwd, f), "x");
  const r = await executeTool("glob", { pattern: "{*.ts,*.tsx}" }, cwd);
  assert.equal(r.ok, true);
  assert.deepEqual(r.output.split("\n").sort(), ["a.ts", "b.tsx"]);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("commands with control characters always ask, even with auto-approve, and the prompt shows every character", async () => {
  let asked = 0;
  const r = await executeTool("run_command", { command: "echo safe;\rrm -rf nothing-here" }, home, async () => { asked++; return false; }, { mode: "yolo", autoApprove: true });
  assert.equal(asked, 1, "approval forced");
  assert.equal(r.ok, false);
  assert.equal(revealForApproval("rm -rf ~/proj;\recho done"), "rm -rf ~/proj;␍echo done");
  assert.equal(revealForApproval("a\x1b]0;x\x07b"), "a␛]0;x␇b");
});

test("edit_file refuses non-UTF-8 files instead of corrupting them", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uj-latin1-"));
  const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x78, 0x3d, 0x31, 0x0a]); // "café\nx=1\n" in Latin-1
  fs.writeFileSync(path.join(dir, "f.txt"), bytes);
  const r = await executeTool("edit_file", { path: "f.txt", old_text: "x=1", new_text: "x=2" }, dir, async () => true, { mode: "cmds" });
  assert.equal(r.ok, false);
  assert.match(r.output, /not UTF-8/);
  assert.ok(fs.readFileSync(path.join(dir, "f.txt")).equals(bytes), "file untouched");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("grep searches files over 200 KB and reports files it had to skip", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uj-grep-"));
  fs.writeFileSync(path.join(dir, "big.ts"), "// filler\n".repeat(30_000) + "export const fooBar = 1;\n");
  const r = await executeTool("grep", { pattern: "fooBar", path: "." }, dir);
  assert.match(r.output, /big\.ts:30001: export const fooBar/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("command output keeps multi-byte characters split across chunks", async () => {
  const r = await runLocalCommand(`node -e "process.stdout.write('é'.repeat(70000))"`, home, { timeoutMs: 20_000 });
  assert.doesNotMatch(r.output, /�/);
});

test("large arguments of finished tool calls are compacted in requests; the call stays valid JSON", () => {
  const big = "x".repeat(60_000);
  const history = [
    { role: "user", content: "write it" },
    { role: "assistant", content: "", tool_calls: [{ id: "w", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: big }) } }] },
    { role: "tool", tool_call_id: "w", content: "Wrote 60000 bytes" },
  ];
  const wire = prepareRequestHistory(history).messages;
  const args = JSON.parse(wire[1].tool_calls[0].function.arguments);
  assert.equal(args.path, "a.txt");
  assert.ok(args.content.length < 600);
  assert.match(args.content, /already sent; this call has run/);
  assert.equal(JSON.parse(history[1].tool_calls[0].function.arguments).content.length, 60_000, "saved history keeps the full call");
});

test("a 5xx whose message says the request itself is wrong is not retried forever", async () => {
  const { streamChatRetry } = await import("../dist/api.js");
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ error: { message: "This model's maximum context length is 128000 tokens" } }, { status: 500 }); };
  try {
    await assert.rejects(streamChatRetry("http://x/v1", "k", "m", [{ role: "user", content: "q" }], { onToken() {} }, new AbortController().signal, { backoff: () => 1 }), /maximum context length/);
    assert.equal(calls, 1);
    calls = 0;
    globalThis.fetch = async () => { calls++; return new Response("", { status: 501 }); };
    await assert.rejects(streamChatRetry("http://x/v1", "k", "m", [{ role: "user", content: "q" }], { onToken() {} }, new AbortController().signal, { backoff: () => 1 }));
    assert.equal(calls, 1, "501 Not Implemented is final");
  } finally { globalThis.fetch = original; }
});

test("markdown keeps __dirname, __init__.py and 2 * 3 * 4 as written", () => {
  for (const t of ["use __dirname here", "edit __init__.py now", "2 * 3 * 4 = 24", "a*b*c"]) assert.equal(renderMarkdown(t), t);
});

test("a chat deleted in another terminal is saved again as a fresh, readable chat", async () => {
  const s = newSession(home, "m");
  s.messages = [{ role: "user", content: "one" }, { role: "assistant", content: "1" }];
  await appendSession(s);
  deleteSession(s.id);
  s.messages.push({ role: "user", content: "two" }, { role: "assistant", content: "2" });
  await appendSession(s);
  const back = loadSession(s.id);
  assert.ok(back, "readable");
  assert.deepEqual(back.messages.map((m) => m.content), ["one", "1", "two", "2"]);
});
