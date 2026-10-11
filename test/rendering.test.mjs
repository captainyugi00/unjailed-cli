import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { StreamDisplayBuffer, retainDisplayWindow, streamingRowBudget, editorViewport } from "../dist/ui/stream-buffer.js";
import { Prompt } from "../dist/ui/Prompt.js";
import { renderMarkdown } from "../dist/markdown.js";

test.after(cleanup);

test("large unterminated fences and prose use bounded previews with linear parsing and lossless final text", () => {
  for (const source of ["```typescript\n" + "const value = 'hello';\n".repeat(20_000), "long prose ".repeat(50_000), "````js\n```\nnot a close\n````\n\nDone.\n"]) {
    const buffer = new StreamDisplayBuffer();
    let printed = "", largestPreview = 0;
    for (let i = 0; i < source.length; i += 137) {
      buffer.append(source.slice(i, i + 137));
      printed += buffer.drainSafe();
      const preview = buffer.preview();
      largestPreview = Math.max(largestPreview, preview.text.length);
      assert.ok(preview.text.length <= 2_400);
    }
    printed += buffer.finish();
    assert.equal(printed, source, "all raw output survives incremental flushes exactly once");
    assert.ok(largestPreview <= 2_400);
    assert.ok(buffer.scannedCharacters <= source.length, "each complete line is scanned once");
  }
});

test("open fenced code is not flushed early; complete tables retain their header", () => {
  const buffer = new StreamDisplayBuffer();
  buffer.append("Intro.\n\n```js\nline\n\n``` text that is not a closing fence\n");
  assert.equal(buffer.drainSafe(), "Intro.\n\n");
  assert.equal(buffer.drainSafe(), "");
  buffer.append("```\n");
  assert.match(buffer.drainSafe(), /^```js[\s\S]*```\n$/);
  buffer.append("| A | B |\n|---|---|\n| 1 | 2 |\n");
  assert.equal(buffer.drainSafe(), "");
  buffer.append("\n");
  assert.match(renderMarkdown(buffer.drainSafe()), /A\s+│ B/);
});

test("rolling display windows retain recent complete output with bounded replay", () => {
  const history = [{ id: 1, kind: "header" }];
  for (let i = 0; i < 20_000; i++) history.push({ id: i + 2, kind: "assistant", text: "old output ".repeat(100) });
  const window = retainDisplayWindow(history);
  assert.equal(window[0].kind, "header");
  assert.equal(window.at(-1), history.at(-1));
  assert.ok(window.length <= 120);
  assert.ok(window.reduce((n, item) => n + (item.text?.length ?? 0), 0) <= 96_000);
  assert.equal(history.length, 20_001, "does not mutate the source conversation");
});

test("draft viewport remains bounded around start/middle/end without changing value or cursor", () => {
  for (const value of ["x".repeat(1_000_000), "one long draft line\n".repeat(50_000), "漢字😀 mixed text\n".repeat(20_000)]) {
    for (const cursor of [0, Math.floor(value.length / 2), value.length]) {
      const view = editorViewport(value, cursor, 78, 4);
      assert.ok(view.lines.length <= 3);
      assert.ok(view.lines.some((line) => line.cursor !== null));
      assert.ok(view.lines.reduce((n, line) => n + line.text.length, 0) <= 3 * 78);
      assert.equal(view.hidden, true);
    }
  }
  assert.equal(streamingRowBudget(16, 80, "x\n".repeat(1_000_000), true, false), 2);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test("immediate terminal unmount flushes queued final output exactly once", async () => {
  const { Transcript } = await import("../dist/ui/App.js");
  const text = "Shutdown-final-marker\n```js\nconst answer = 42;\n```";
  const ui = render(React.createElement(Transcript, { items: [{ id: 1, kind: "assistant", first: true, text }], width: 80 }));
  ui.unmount();
  await sleep(30);
  assert.equal(ui.frames.join("\n").split("Shutdown-final-marker").length - 1, 1);
  assert.match(ui.frames.join("\n"), /const answer = 42;/);
  ui.cleanup();
});

test("completed transcript output is printed once and absent from later Ink redraw payloads", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "unjailed-render-cache-"));
  const priorHome = process.env.UNJAILED_HOME;
  const priorKey = process.env.UNJAILED_API_KEY;
  process.env.UNJAILED_HOME = home;
  process.env.UNJAILED_API_KEY = "sk-local-render-cache-test";
  const { App } = await import("../dist/ui/App.js");
  const { writeConfig } = await import("../dist/config.js");
  writeConfig({ tools: "off", fx: false, saveSessions: false });
  const originalFetch = globalThis.fetch;
  let turns = 0;
  globalThis.fetch = async (url) => String(url).endsWith("/models") ? Response.json({ data: [{ id: "kimi-k3" }] }) : Response.json({ choices: [{ message: { content: `completed-${turns++}-marker ` + "old transcript ".repeat(100) } }] });
  const ui = render(React.createElement(App));
  try {
    await sleep(100);
    for (let i = 0; i < 10; i++) {
      ui.stdin.write(`prompt ${i}`); await sleep(40); ui.stdin.write("\r"); await sleep(80);
    }
    assert.equal(turns, 10);
    const printed = ui.frames.join("\n");
    for (let i = 0; i < turns; i++) assert.equal(printed.split(`completed-${i}-marker`).length - 1, 1, `completed output ${i} prints exactly once`);
    ui.stdin.write("viewport check");
    await sleep(80);
    assert.match(ui.lastFrame(), /viewport check/);
    assert.doesNotMatch(ui.lastFrame(), /completed-\d+-marker/, "no old Static transcript retained in later live redraws");
    assert.ok(ui.lastFrame().length < 4_000, "live frame size stays independent of 15k printed transcript");
  } finally {
    ui.unmount(); ui.cleanup(); globalThis.fetch = originalFetch;
    if (priorHome === undefined) delete process.env.UNJAILED_HOME; else process.env.UNJAILED_HOME = priorHome;
    if (priorKey === undefined) delete process.env.UNJAILED_API_KEY; else process.env.UNJAILED_API_KEY = priorKey;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("giant bracketed paste stays editable and submits the whole draft with a bounded terminal viewport", async () => {
  let value = "", cursor = 0, submitted = null;
  const draft = Array.from({ length: 3_000 }, (_, i) => `draft line ${i}`).join("\n");
  let ui;
  const tree = () => React.createElement(Prompt, { state: { value, cursor }, width: 80, maxRows: 4, onChange(s) { value = s.value; cursor = s.cursor; ui.rerender(tree()); }, onSubmit(v) { submitted = v; }, isActive: true });
  ui = render(tree());
  try {
    await sleep(80);
    ui.stdin.write("\x1b[200~" + draft + "\x1b[201~");
    await sleep(100);
    assert.equal(value, draft);
    assert.equal(cursor, draft.length);
    assert.equal(submitted, null, "paste does not submit itself");
    assert.ok(ui.lastFrame().split("\n").length <= 4, "draft does not force terminal-sized redraws");
    ui.stdin.write("\x1b[D");
    await sleep(60);
    assert.equal(cursor, draft.length - 1, "navigation still edits the full draft");
    ui.stdin.write("!");
    await sleep(60);
    assert.equal(value, draft.slice(0, -1) + "!" + draft.slice(-1));
    ui.stdin.write("\r");
    await sleep(60);
    assert.equal(submitted, value, "full text is sent, not just the visible tail");
  } finally { ui.unmount(); ui.cleanup(); }
});
