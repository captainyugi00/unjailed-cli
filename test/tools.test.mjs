import test from "node:test";
import assert from "node:assert/strict";
import { toolDefinitions, executeTool as executeApprovedTool, MAX_READ_BYTES } from "../dist/tools.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
const executeTool = (name, args, cwd, approve = async () => true) => executeApprovedTool(name, args, cwd, approve, { mode: "cmds" });

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uj-tools-"));
  return dir;
}

test("tool definitions by mode", () => {
  const read = toolDefinitions("read");
  const cmds = toolDefinitions("cmds");
  const yolo = toolDefinitions("yolo");
  const names = (d) => d.map((t) => t.function.name);
  assert.deepEqual(names(read), ["read_file", "list_dir", "glob", "grep", "clipboard", "web_fetch", "process_status"]);
  assert.deepEqual(names(cmds), ["read_file", "list_dir", "glob", "grep", "clipboard", "launch_app", "open_url", "web_fetch", "write_file", "edit_file", "move_file", "delete_file", "run_command", "process_status", "stop_process"]);
  assert.equal(cmds.length, yolo.length);
});

test("read_file reads a real file, clips big ones, refuses dirs", async () => {
  const dir = tmp();
  const file = path.join(dir, "hello.txt");
  fs.writeFileSync(file, "hello agent");
  const r = await executeTool("read_file", { path: file }, dir);
  assert.equal(r.ok, true);
  assert.equal(r.output, "hello agent");

  const big = path.join(dir, "big.txt");
  fs.writeFileSync(big, "x".repeat(MAX_READ_BYTES + 10));
  assert.equal((await executeTool("read_file", { path: big }, dir)).ok, false);
  assert.equal((await executeTool("read_file", { path: dir }, dir)).ok, false);
});

test("list_dir lists with trailing slash on dirs", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "a.txt"), "a");
  fs.mkdirSync(path.join(dir, "sub"));
  const r = await executeTool("list_dir", {}, dir);
  assert.equal(r.ok, true);
  assert.ok(r.output.includes("a.txt"));
  assert.ok(r.output.includes("sub/"));
});

test("glob finds files by pattern and skips node_modules", async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "src", "deep"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "deep", "x.ts"), "x");
  fs.writeFileSync(path.join(dir, "y.md"), "y");
  fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "pkg", "z.ts"), "z");

  const r = await executeTool("glob", { pattern: "**/*.ts" }, dir);
  assert.ok(r.output.includes("x.ts"));
  assert.ok(!r.output.includes("z.ts"), "node_modules must be skipped");

  const r2 = await executeTool("glob", { pattern: "*.md" }, dir);
  assert.ok(r2.output.includes("y.md"));
  assert.ok(!r2.output.includes("x.ts"), "*.md must not match nested ts");
});

test("grep finds content with file:line and honors glob filter", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "a.ts"), "line1\nNEEDLE here\nline3\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "NEEDLE in txt\n");
  const r = await executeTool("grep", { pattern: "NEEDLE" }, dir);
  assert.ok(r.output.includes("a.ts:2:"));
  assert.ok(r.output.includes("b.txt:1:"));

  const r2 = await executeTool("grep", { pattern: "NEEDLE", glob: "*.ts" }, dir);
  assert.ok(r2.output.includes("a.ts"));
  assert.ok(!r2.output.includes("b.txt"));

  const bad = await executeTool("grep", { pattern: "(" }, dir);
  assert.equal(bad.ok, false);
});

test("web_fetch pulls a page and strips html", async () => {
  // The wreq engine has its own suite (fetcher.test.mjs); this one covers the Node fallback.
  process.env.UNJAILED_FETCH_ENGINE = "node";
  const server = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end("<html><h1>Example Domain</h1></html>"); }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  let r;
  try { r = await executeTool("web_fetch", { url: `http://127.0.0.1:${server.address().port}` }, process.cwd()); }
  finally { server.closeAllConnections(); server.close(); }
  assert.equal(r.ok, true);
  assert.ok(/Example Domain/i.test(r.output), "body text present");
  assert.ok(r.output.startsWith("HTTP 200"));

  const bad = await executeTool("web_fetch", { url: "not-a-url" }, process.cwd());
  assert.equal(bad.ok, false);
  const ftp = await executeTool("web_fetch", { url: "ftp://x" }, process.cwd());
  assert.equal(ftp.ok, false);
  delete process.env.UNJAILED_FETCH_ENGINE;
});

test("write_file creates files and parent dirs", async () => {
  const dir = tmp();
  const r = await executeTool("write_file", { path: "src/new/file.txt", content: "made by agent" }, dir);
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, "src/new/file.txt"), "utf8"), "made by agent");
});

test("edit_file replaces exact text, refuses ambiguous matches", async () => {
  const dir = tmp();
  const f = path.join(dir, "e.txt");
  fs.writeFileSync(f, "alpha\nbeta\ngamma\nbeta\n");
  const r = await executeTool("edit_file", { path: "e.txt", old_text: "gamma", new_text: "GAMMA" }, dir);
  assert.equal(r.ok, true);
  assert.ok(fs.readFileSync(f, "utf8").includes("GAMMA"));

  const amb = await executeTool("edit_file", { path: "e.txt", old_text: "beta", new_text: "BETA" }, dir);
  assert.equal(amb.ok, false, "ambiguous match must refuse");
  assert.ok(/found 2 times/.test(amb.output));

  const all = await executeTool("edit_file", { path: "e.txt", old_text: "beta", new_text: "BETA", replace_all: true }, dir);
  assert.equal(all.ok, true);
  assert.ok(!fs.readFileSync(f, "utf8").includes("\nbeta\n"));

  const miss = await executeTool("edit_file", { path: "e.txt", old_text: "nope", new_text: "x" }, dir);
  assert.equal(miss.ok, false);
  assert.ok(/not found/.test(miss.output));
});

test("run_command works cross-platform and respects approval", async () => {
  const dir = tmp();
  const echo = "echo hello";
  const r = await executeTool("run_command", { command: echo }, dir);
  assert.equal(r.ok, true);
  assert.ok(r.output.includes("hello"));

  const r2 = await executeTool("run_command", { command: echo }, dir, async () => false);
  assert.equal(r2.ok, false);
  assert.ok(/declined/i.test(r2.output));

  const r3 = await executeTool("run_command", { command: echo }, dir, async () => true);
  assert.equal(r3.ok, true);
});

test("run_command background starts detached and logs to file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uj-bg-"));
  const r = await executeTool("run_command", { command: "echo hi-from-bg", background: true }, dir);
  assert.equal(r.ok, true);
  assert.ok(/background/i.test(r.output));
  assert.ok(/\.unjailed\/bg-.*\.log/.test(r.output.replace(/\\/g, "/")));
  // give the detached shell a moment to write
  await new Promise((res) => setTimeout(res, 1500));
  const logDir = path.join(dir, ".unjailed");
  const logs = fs.readdirSync(logDir).filter((f) => f.endsWith(".log"));
  assert.ok(logs.length > 0, "log file exists");
  const content = fs.readFileSync(path.join(logDir, logs[0]), "utf8");
  assert.ok(content.includes("hi-from-bg"));
});

test("unknown tool errors cleanly", async () => {
  const r = await executeTool("nope", {}, process.cwd());
  assert.equal(r.ok, false);
  assert.ok(/Unknown tool/.test(r.output));
});
