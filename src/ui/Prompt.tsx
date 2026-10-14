import React, { useEffect, useRef } from "react";
import { Box, Text, useInput, useStdin, type Key } from "ink";
import { theme } from "../theme.js";
import stringWidth from "string-width";
import { editorViewport, TAB_CELLS } from "./stream-buffer.js";
import { applyEdit, classifyKey, lineBounds, nextIndex, prevIndex, type EditAction, type EditorState } from "./line-edit.js";

export type { EditorState } from "./line-edit.js";

export interface PromptProps {
  state: EditorState;
  onChange: (s: EditorState) => void;
  onSubmit: (value: string) => void;
  /** Return true if the key was consumed (e.g. by the slash menu or history). */
  onSpecialKey?: (key: Key, input: string, state: EditorState) => boolean;
  /** Ctrl+Enter (or Ctrl+S): send now, interrupting whatever is running. */
  onSubmitNow?: (value: string) => void;
  mask?: boolean;
  placeholder?: string;
  isActive: boolean;
  label?: string;
  width?: number;
  maxRows?: number;
}

const isShiftEnter = (input: string, key: Key) =>
  (key.return && (key.shift || key.meta)) || input === "[27;2;13~" || input === "[13;2u";

/** Ctrl+Enter as reported by the kitty protocol (CSI 13;5u) or xterm's
 *  modifyOtherKeys (CSI 27;5;13~); Ctrl+S works in every terminal. */
export const isSubmitNow = (input: string, key: Key) =>
  (key.return && key.ctrl) || /^\x1b?\[(27;5;13~|13;5u)$/.test(input) || (key.ctrl && input === "s");

/** Visible width of the label in front of the input (it may carry color codes). */
export const labelWidth = (label: string) => stringWidth(label.replace(/\x1b\[[0-9;]*m/g, ""));

/** The rows the editor shows for `value` at `columns` (same wrapping as editorViewport). */
function visualRows(value: string, columns: number): Array<{ start: number; end: number }> {
  const width = Math.max(4, columns - 1);
  const rows: Array<{ start: number; end: number }> = [];
  let start = 0;
  let cells = 0;
  let offset = 0;
  for (const ch of value) {
    if (ch === "\n") {
      rows.push({ start, end: offset });
      start = offset + 1;
      cells = 0;
    } else {
      const size = ch === "\t" ? TAB_CELLS : stringWidth(ch);
      if (cells + size > width) {
        rows.push({ start, end: offset });
        start = offset;
        cells = 0;
      }
      cells += size;
    }
    offset += ch.length;
  }
  rows.push({ start, end: offset });
  return rows;
}

function rowOf(rows: Array<{ start: number; end: number }>, cursor: number): number {
  for (let i = rows.length - 1; i >= 0; i--) if (cursor >= rows[i]!.start) return i;
  return 0;
}

/** Is the cursor on the first / last row the editor shows (wrapped rows count)? */
export function onFirstVisualRow(s: EditorState, columns: number): boolean {
  return rowOf(visualRows(s.value.slice(0, s.cursor + 1), columns), s.cursor) === 0;
}
export function onLastVisualRow(s: EditorState, columns: number): boolean {
  const rows = visualRows(s.value, columns);
  return rowOf(rows, s.cursor) === rows.length - 1;
}

/** Move the cursor one shown row up or down, keeping its column. */
export function moveVisual(s: EditorState, columns: number, dir: -1 | 1): EditorState {
  const rows = visualRows(s.value, columns);
  const at = rowOf(rows, s.cursor);
  const target = at + dir;
  if (target < 0 || target >= rows.length) return s;
  const cellsOf = (t: string) => stringWidth(t.replace(/\t/g, " ".repeat(TAB_CELLS)));
  const col = cellsOf(s.value.slice(rows[at]!.start, s.cursor));
  const row = rows[target]!;
  let cursor = row.start;
  let cells = 0;
  for (const ch of s.value.slice(row.start, row.end)) {
    const size = ch === "\t" ? TAB_CELLS : stringWidth(ch);
    if (cells + size > col) break;
    cells += size;
    cursor += ch.length;
  }
  return { ...s, cursor };
}

export function onFirstLine(s: EditorState) {
  return s.value.lastIndexOf("\n", s.cursor - 1) === -1;
}
export function onLastLine(s: EditorState) {
  return s.value.indexOf("\n", s.cursor) === -1;
}

/** Move the cursor up/down one line, keeping the column when possible. */
export function moveVertical(s: EditorState, dir: -1 | 1): EditorState {
  const { start, end } = lineBounds(s.value, s.cursor);
  const col = s.cursor - start;
  if (dir === -1) {
    if (start === 0) return s;
    const prev = lineBounds(s.value, start - 1);
    return { ...s, cursor: Math.min(prev.start + col, prev.end) };
  }
  if (end === s.value.length) return s;
  const next = lineBounds(s.value, end + 1);
  return { ...s, cursor: Math.min(next.start + col, next.end) };
}

/** Text removed by the kill commands (Ctrl+K/U/W, word deletes), for Ctrl+Y.
 *  Shared by every prompt, like a terminal's kill ring. */
let killed = "";

function insert(s: EditorState, text: string): EditorState {
  return { value: s.value.slice(0, s.cursor) + text + s.value.slice(s.cursor), cursor: s.cursor + text.length };
}

export function Prompt({ state: propState, onChange: propOnChange, onSubmit, onSubmitNow, onSpecialKey, mask, placeholder, isActive, label, width = 80, maxRows = 4 }: PromptProps) {
  const prefix = label ?? "› ";
  const textColumns = Math.max(4, width - labelWidth(prefix));
  // Several key events can arrive in one batch (e.g. a paste followed by an arrow key) before
  // React re-renders, so edits build on the latest state kept here, not the possibly stale prop.
  const latest = useRef(propState);
  latest.current = propState;
  // Undo history. Typing within a word is one step; a change made outside
  // this editor (history recall, sending) starts a fresh history.
  const undo = useRef<EditorState[]>([]);
  const redo = useRef<EditorState[]>([]);
  const lastKind = useRef<string>("");
  const ownValue = useRef(propState.value);
  if (propState.value !== ownValue.current) {
    undo.current = [];
    redo.current = [];
    lastKind.current = "";
    ownValue.current = propState.value;
  }
  type Kind = "type" | "edit" | "kill-back" | "kill-forward" | "move" | "history";
  const onChange = (s: EditorState, kind: Kind = "edit") => {
    const prev = latest.current;
    if (s.value !== prev.value && kind !== "history") {
      const sameWord = kind === "type" && lastKind.current === "type" && !/\s$/.test(prev.value.slice(0, prev.cursor));
      if (!sameWord) {
        undo.current.push(prev);
        if (undo.current.length > 200) undo.current.shift();
      }
      redo.current = [];
    }
    if (kind !== "history") lastKind.current = kind;
    latest.current = s;
    ownValue.current = s.value;
    propOnChange(s);
  };
  const edit = (action: EditAction, state: EditorState) => {
    if (action === "yank") {
      if (killed) onChange(insert(state, mask ? killed.replace(/\s+/g, "") : killed));
      return;
    }
    if (action === "undo" || action === "redo") {
      const from = action === "undo" ? undo.current : redo.current;
      const to = action === "undo" ? redo.current : undo.current;
      const target = from.pop();
      if (!target) return;
      to.push(state);
      lastKind.current = "";
      onChange(target, "history");
      return;
    }
    const r = applyEdit(action, state);
    if (r.killed !== undefined) {
      const back = r.state.cursor < state.cursor || action === "deleteToLineStart" || action === "deleteWordBack" || action === "deleteBigWordBack";
      const kind = back ? "kill-back" : "kill-forward";
      // Consecutive kills collect into one piece of text, as in readline.
      killed = lastKind.current.startsWith("kill") ? (back ? r.killed + killed : killed + r.killed) : r.killed;
      onChange(r.state, kind);
      return;
    }
    if (r.state.value === state.value && r.state.cursor === state.cursor) return;
    onChange(r.state, r.state.value === state.value ? "move" : "edit");
  };
  // Ink's key events drop what tells Ctrl+← from ←, or Delete from
  // Backspace; the raw sequence of the key being handled is kept here.
  // This listener is added before useInput's, so it always runs first.
  const { internal_eventEmitter: inputEvents } = useStdin();
  const raw = useRef("");
  useEffect(() => {
    const onRaw = (data: string) => (raw.current = data);
    inputEvents.on("input", onRaw);
    return () => {
      inputEvents.off("input", onRaw);
    };
  }, [inputEvents]);
  // Inside a bracketed paste (ESC[200~ … ESC[201~), Enter is a newline, never "send".
  const pasting = useRef(false);

  useInput(
    (input, key) => {
      const state = latest.current;
      if (input.includes("[200~")) pasting.current = true;
      if (pasting.current) {
        const end = input.includes("[201~");
        const text = input
          .replace(/\x1b?\[20[01]~/g, "")
          .replace(/\r\n?/g, "\n")
          .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
        let chunk = key.return ? "\n" : key.tab ? "  " : text;
        if (mask && chunk.includes("\n")) {
          // masked paste with trailing newline = paste-and-enter in one event (mac):
          // strip the newline, insert, and submit after this event settles
          chunk = chunk.replace(/\s+/g, "");
          if (end) pasting.current = false;
          if (chunk) onChange(insert(state, chunk));
          return;
        }
        if (end) pasting.current = false;
        if (chunk) onChange(insert(state, mask ? chunk.replace(/\s+/g, "") : chunk));
        return;
      }
      if (onSubmitNow && !mask && isSubmitNow(input, key)) {
        onSubmitNow(state.value);
        return;
      }
      const action = classifyKey(raw.current);
      raw.current = "";
      if (action) return edit(action, state);
      if (onSpecialKey?.(key, input, state)) return;
      const { value, cursor } = state;

      if (isShiftEnter(input, key) || (key.ctrl && input === "j")) {
        if (!mask) onChange(insert(state, "\n"));
        return;
      }
      if (key.return) {
        // Trailing backslash continues onto a new line.
        if (!mask && value.endsWith("\\") && cursor === value.length) {
          onChange({ value: value.slice(0, -1) + "\n", cursor: value.length });
          return;
        }
        onSubmit(value);
        return;
      }
      if (key.ctrl) {
        if (input === "a") return edit("lineStart", state);
        if (input === "e") return edit("lineEnd", state);
        if (input === "u") return edit("deleteToLineStart", state);
        if (input === "k") return edit("deleteToLineEnd", state);
        if (input === "w") return edit("deleteBigWordBack", state);
        if (input === "d" && value) return edit("deleteCharForward", state);
        // Ctrl with an arrow or Delete the terminal encoded some other way.
        if (key.leftArrow) return edit("wordLeft", state);
        if (key.rightArrow) return edit("wordRight", state);
        if (key.delete || key.backspace) return edit("deleteWordBack", state);
        return;
      }
      if (key.meta && !key.escape) {
        if (key.leftArrow) return edit("wordLeft", state);
        if (key.rightArrow) return edit("wordRight", state);
        if (key.delete || key.backspace) return edit("deleteWordBack", state);
      }
      if (key.leftArrow) return onChange({ ...state, cursor: prevIndex(value, cursor) }, "move");
      if (key.rightArrow) return onChange({ ...state, cursor: nextIndex(value, cursor) }, "move");
      if (key.home) return onChange({ ...state, cursor: lineBounds(value, cursor).start });
      if (key.end) return onChange({ ...state, cursor: lineBounds(value, cursor).end });
      if (key.upArrow) return onChange(moveVisual(state, textColumns, -1));
      if (key.downArrow) return onChange(moveVisual(state, textColumns, 1));
      // Most terminals send DEL (0x7f) for Backspace, which Ink reports as `delete`.
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        const from = prevIndex(value, cursor);
        return onChange({ value: value.slice(0, from) + value.slice(cursor), cursor: from });
      }
      if (key.escape || key.tab || key.pageUp || key.pageDown) return;
      if (!input) return;
      if (/^\[\?\d*u$/.test(input)) return; // stray keyboard-protocol reply from the terminal
      // Pasted text arrives as one chunk; normalise its line endings and strip control chars.
      let text = input.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
      if (mask) text = text.replace(/\s+/g, "");
      if (text) onChange(insert(state, text), "type");
    },
    { isActive },
  );

  const state = propState;
  // Measure the label by what it shows, not its color codes: counting the
  // codes indented every continuation row far to the right.
  const pad = " ".repeat(labelWidth(prefix));
  const viewport = editorViewport(state.value, state.cursor, textColumns, maxRows);
  const lines = viewport.lines.map((line) => renderWithCursor(mask ? "•".repeat(line.text.length) : line.text, line.cursor ?? 0, isActive && line.cursor !== null, state.value ? undefined : placeholder));
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          {i === 0 ? (prefix.includes("\x1b") ? prefix : theme.brand(prefix)) : pad}
          {l}
        </Text>
      ))}
      {viewport.hidden && maxRows > 1 && <Text wrap="truncate-end">{theme.dim("  ⋯ draft continues; full text preserved")}</Text>}
    </Box>
  );
}

function renderWithCursor(raw: string, rawCursor: number, active: boolean, placeholder?: string): string {
  // Tabs stay in the draft but are drawn as spaces: a raw tab would move the
  // terminal cursor and push the box border out of place.
  const tabs = raw.slice(0, rawCursor).split("\t").length - 1;
  const value = raw.replace(/\t/g, " ".repeat(TAB_CELLS));
  const cursor = rawCursor + tabs * (TAB_CELLS - 1);
  const inv = (ch: string) => `\x1b[7m${ch}\x1b[27m`;
  if (!value) {
    const ph = placeholder ? theme.dim(placeholder) : "";
    return active ? inv(" ") + ph : ph;
  }
  if (!active) return value;
  const ch = value[cursor];
  if (ch === undefined) return value + inv(" ");
  if (ch === "\n") return value.slice(0, cursor) + inv(" ") + value.slice(cursor);
  return value.slice(0, cursor) + inv(ch) + value.slice(cursor + 1);
}
