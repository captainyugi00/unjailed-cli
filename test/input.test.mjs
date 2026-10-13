import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render, cleanup } from "ink-testing-library";

process.env.NO_COLOR = "1";
const { Prompt, moveVisual, onFirstVisualRow, onLastVisualRow, isSubmitNow, labelWidth } = await import("../dist/ui/Prompt.js");

test.after(cleanup);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mount({ value = "", cursor = value.length, width = 40, label, onSubmitNow, onSubmit } = {}) {
  const state = { value, cursor };
  let ui;
  const tree = () => React.createElement(Prompt, {
    state: { ...state }, width, maxRows: 6, label, isActive: true,
    onChange(s) { state.value = s.value; state.cursor = s.cursor; ui.rerender(tree()); },
    onSubmit: onSubmit ?? (() => {}), onSubmitNow,
  });
  ui = render(tree());
  return { ui, state };
}

test("continuation rows line up under the text even when the label is colored", async () => {
  const colored = "\x1b[38;2;125;211;252m› \x1b[39m";
  assert.equal(labelWidth(colored), 2);
  const { ui } = mount({ value: "first line\nsecond line\nthird", label: colored });
  await sleep(50);
  const rows = ui.lastFrame().split("\n").map((r) => r.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.match(rows[0], /^› first line/);
  assert.match(rows[1], /^ {2}second line/, `second row indented by the label width only: ${JSON.stringify(rows[1])}`);
  assert.match(rows[2], /^ {2}third/);
  ui.unmount();
});

test("↑/↓ move between the rows of a wrapped line, keeping the column", () => {
  const value = "a".repeat(25) + "b".repeat(25) + "c".repeat(10); // 60 chars, 20 columns → rows of 19
  const s = { value, cursor: value.length };
  assert.equal(onLastVisualRow(s, 20), true);
  assert.equal(onFirstVisualRow(s, 20), false);
  const up = moveVisual(s, 20, -1);
  assert.equal(up.cursor, value.length - 19, "one row up, same column");
  const top = moveVisual(moveVisual(up, 20, -1), 20, -1);
  assert.equal(onFirstVisualRow(top, 20), true);
  assert.deepEqual(moveVisual(top, 20, -1), top, "nothing above the first row");
  const lines = { value: "short\nmuch longer line", cursor: 14 };
  assert.equal(moveVisual(lines, 40, -1).cursor, 5, "a shorter row clamps to its end");
});

test("Ctrl+Enter (kitty and modifyOtherKeys forms) and Ctrl+S send now; plain Enter does not", async () => {
  for (const seq of ["\x1b[13;5u", "\x1b[27;5;13~", "\x13"]) {
    let now = null, normal = null;
    const { ui } = mount({ value: "stop and do this", onSubmitNow: (v) => (now = v), onSubmit: (v) => (normal = v) });
    await sleep(40);
    ui.stdin.write(seq);
    await sleep(60);
    assert.equal(now, "stop and do this", JSON.stringify(seq));
    assert.equal(normal, null);
    ui.unmount();
  }
  let normal = null, now = null;
  const { ui } = mount({ value: "regular", onSubmitNow: (v) => (now = v), onSubmit: (v) => (normal = v) });
  await sleep(40);
  ui.stdin.write("\r");
  await sleep(60);
  assert.equal(normal, "regular");
  assert.equal(now, null);
  ui.unmount();
  assert.equal(isSubmitNow("x", { ctrl: true }), false);
});

test("arrow keys edit inside a multi-line draft instead of jumping to history", async () => {
  const { ui, state } = mount({ value: "line one\nline two", width: 40 });
  await sleep(40);
  ui.stdin.write("\x1b[A"); await sleep(50); // up: to row 1
  ui.stdin.write("X"); await sleep(50);
  assert.equal(state.value, "line oneX\nline two");
  ui.stdin.write("\x1b[B"); await sleep(50); // down: back to row 2
  ui.stdin.write("Y"); await sleep(50);
  assert.match(state.value, /^line oneX\nline twoY?/);
  ui.unmount();
});
