import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { applyEdit, classifyKey, wordEnd, wordStart } from "../dist/ui/line-edit.js";
import { Prompt } from "../dist/ui/Prompt.js";

const at = (text) => ({ value: text.replace("|", ""), cursor: text.indexOf("|") });
const show = (s) => s.value.slice(0, s.cursor) + "|" + s.value.slice(s.cursor);
const run = (action, text) => show(applyEdit(action, at(text)).state);

test("raw key sequences from common terminals map to editing actions", () => {
  const cases = {
    wordLeft: ["\x1b[1;5D", "\x1b[1;3D", "\x1b[5D", "\x1bOd", "\x1b\x1b[D", "\x1bb"],
    wordRight: ["\x1b[1;5C", "\x1b[1;3C", "\x1b[5C", "\x1bOc", "\x1b\x1b[C", "\x1bf"],
    lineStart: ["\x1b[1;9D"],
    lineEnd: ["\x1b[1;9C"],
    bufferStart: ["\x1b[1;5H", "\x1b<", "\x1b[1;9A"],
    bufferEnd: ["\x1b[1;5F", "\x1b>", "\x1b[1;9B"],
    deleteCharForward: ["\x1b[3~"],
    deleteWordForward: ["\x1b[3;5~", "\x1b[3;3~", "\x1bd"],
    deleteWordBack: ["\x08", "\x1b\x7f", "\x1b\x08", "\x1b[127;5u", "\x1b[127;3u", "\x1b[27;5;127~"],
    deleteToLineStart: ["\x1b[127;9u"],
    undo: ["\x1a", "\x1f", "\x1b[122;5u", "\x1b[27;5;122~"],
    redo: ["\x1b[122;6u", "\x1b[27;6;90~"],
    yank: ["\x19"],
    charLeft: ["\x02"],
    charRight: ["\x06"],
    upcaseWord: ["\x1bu"],
    downcaseWord: ["\x1bl"],
    capitalizeWord: ["\x1bc"],
    transposeWords: ["\x1bt"],
  };
  for (const [action, seqs] of Object.entries(cases)) {
    for (const seq of seqs) assert.equal(classifyKey(seq), action, JSON.stringify(seq));
  }
  // Plain keys stay plain.
  for (const seq of ["\x1b[D", "\x1b[C", "\x7f", "\x1b", "\x1b[H", "a", "\r", "\x1b[3;2~"]) assert.equal(classifyKey(seq), null, JSON.stringify(seq));
});

test("word motion skips punctuation and spaces like an editor", () => {
  assert.equal(run("wordLeft", "git commit --amend|"), "git commit --|amend");
  assert.equal(run("wordLeft", "git commit --|amend"), "git |commit --amend");
  assert.equal(run("wordRight", "|git commit"), "git| commit");
  assert.equal(run("wordRight", "git| commit"), "git commit|");
  assert.equal(run("wordLeft", "foo.bar(baz)|"), "foo.bar(|baz)");
  assert.equal(run("wordRight", "line one|\nline two"), "line one\nline| two");
  assert.equal(run("wordLeft", "|start"), "|start");
  assert.equal(run("wordRight", "end|"), "end|");
  // Accented letters and CJK are word characters; emoji are skipped whole.
  assert.equal(run("wordLeft", "café olé|"), "café |olé");
  assert.equal(run("wordLeft", "日本語 テスト|"), "日本語 |テスト");
  const s = "hi 👋 there";
  assert.equal(wordStart(s, s.indexOf("there")), 0);
  assert.equal(wordEnd(s, 2), s.length);
});

test("word, line and character deletes", () => {
  assert.equal(run("deleteWordBack", "rm -rf build/|"), "rm -rf |");
  assert.equal(run("deleteWordBack", "rm -rf |build"), "rm -|build");
  assert.equal(run("deleteWordForward", "rm |-rf build"), "rm | build");
  assert.equal(run("deleteWordForward", "|hello world"), "| world");
  assert.equal(run("deleteBigWordBack", "rm -rf build/|"), "rm -rf |");
  assert.equal(run("deleteBigWordBack", "a foo.bar/baz  |"), "a |");
  assert.equal(run("deleteCharForward", "ab|c"), "ab|");
  assert.equal(run("deleteCharForward", "ab|"), "ab|");
  assert.equal(run("deleteCharForward", "a|👋b"), "a|b");
  assert.equal(run("deleteToLineStart", "one\ntwo thr|ee"), "one\n|ee");
  assert.equal(run("deleteToLineStart", "one\n|two"), "one|two");
  assert.equal(run("deleteToLineEnd", "one t|wo\nthree"), "one t|\nthree");
  assert.equal(run("deleteToLineEnd", "one|\ntwo"), "one|two");
  assert.equal(applyEdit("deleteWordBack", at("hello wor|ld")).killed, "wor");
});

test("case changes and word transposition", () => {
  assert.equal(run("upcaseWord", "make |this loud"), "make THIS| loud");
  assert.equal(run("downcaseWord", "|QUIET please"), "quiet| please");
  assert.equal(run("capitalizeWord", "|hELLO world"), "Hello| world");
  assert.equal(run("transposeWords", "first |second"), "second first|");
  assert.equal(run("transposeWords", "a bb| ccc"), "a ccc bb|");
});

// End to end through the Prompt component, with the bytes a terminal sends.
function harness(initial = "") {
  let state = { value: initial, cursor: initial.length };
  let submitted = null;
  const el = () =>
    React.createElement(Prompt, {
      state,
      onChange: (s) => { state = s; app.rerender(el()); },
      onSubmit: (v) => (submitted = v),
      isActive: true,
      width: 80,
    });
  const app = render(el());
  const press = async (...keys) => {
    for (const k of keys) {
      app.stdin.write(k);
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  return { press, get state() { return state; }, get submitted() { return submitted; }, app };
}

test("the prompt edits by word, kills, yanks and undoes with real key sequences", async () => {
  const h = harness();
  await h.press("deploy the app now");
  await h.press("\x1b[1;5D");            // Ctrl+←
  assert.equal(show(h.state), "deploy the app |now");
  await h.press("\x1b[1;5D", "\x1bb");   // Ctrl+←, Alt+B
  assert.equal(show(h.state), "deploy |the app now");
  await h.press("\x1b[3;5~");            // Ctrl+Delete
  assert.equal(show(h.state), "deploy | app now");
  await h.press("\x1b[1;5C");            // Ctrl+→
  assert.equal(show(h.state), "deploy  app| now");
  await h.press("\x1b\x7f");             // Alt+Backspace
  assert.equal(show(h.state), "deploy  | now");
  await h.press("\x19");                 // Ctrl+Y yanks the last kill
  assert.equal(show(h.state), "deploy  app| now");
  await h.press("\x1a", "\x1a");         // Ctrl+Z twice
  assert.equal(h.state.value, "deploy  app now");
  await h.press("\x1a");
  assert.equal(h.state.value, "deploy the app now");
  await h.press("\x1b[122;6u");          // Ctrl+Shift+Z redoes
  assert.equal(h.state.value, "deploy  app now");
  await h.press("\x1b[1;5H");            // Ctrl+Home
  assert.equal(h.state.cursor, 0);
  await h.press("\x1b[3~");              // Delete removes the character after the cursor
  assert.equal(show(h.state), "|eploy  app now");
  await h.press("\x1b[1;5F", "\x08");    // Ctrl+End, Ctrl+Backspace (^H)
  assert.equal(show(h.state), "eploy  app |");
  await h.press("\x7f");                 // plain Backspace is still one character
  assert.equal(show(h.state), "eploy  app|");
  await h.press("\x1b[D", "\x1b[D", "\x1b[C");
  assert.equal(show(h.state), "eploy  ap|p");
  h.app.unmount();
});

test("typing a word undoes as one step; Ctrl+K then Ctrl+U collect into one yank", async () => {
  const h = harness();
  await h.press("one", " ", "t", "w", "o");
  await h.press("\x1f");                 // Ctrl+_
  assert.equal(h.state.value, "one ");
  const k = harness("alpha beta gamma");
  await k.press("\x1b[1;5D");
  await k.press("\x0b", "\x15");         // Ctrl+K, Ctrl+U
  assert.equal(k.state.value, "");
  await k.press("\x19");
  assert.equal(k.state.value, "alpha beta gamma");
  h.app.unmount();
  k.app.unmount();
});
