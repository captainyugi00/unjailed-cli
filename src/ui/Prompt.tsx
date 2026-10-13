import React, { useRef } from "react";
import { Box, Text, useInput, type Key } from "ink";
import { theme } from "../theme.js";
import stringWidth from "string-width";
import { editorViewport, TAB_CELLS } from "./stream-buffer.js";

export interface EditorState {
  value: string;
  cursor: number;
}

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

function lineBounds(value: string, cursor: number) {
  const start = value.lastIndexOf("\n", cursor - 1) + 1;
  let end = value.indexOf("\n", cursor);
  if (end === -1) end = value.length;
  return { start, end };
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
  const onChange = (s: EditorState) => {
    latest.current = s;
    propOnChange(s);
  };
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
        const { start, end } = lineBounds(value, cursor);
        if (input === "a") return onChange({ ...state, cursor: start });
        if (input === "e") return onChange({ ...state, cursor: end });
        if (input === "u") return onChange({ value: value.slice(0, start) + value.slice(cursor), cursor: start });
        if (input === "k") return onChange({ value: value.slice(0, cursor) + value.slice(end), cursor });
        if (input === "w") {
          const before = value.slice(0, cursor).replace(/\S+\s*$/, "");
          return onChange({ value: before + value.slice(cursor), cursor: before.length });
        }
        return;
      }
      if (key.leftArrow) return onChange({ ...state, cursor: Math.max(0, cursor - 1) });
      if (key.rightArrow) return onChange({ ...state, cursor: Math.min(value.length, cursor + 1) });
      if (key.home) return onChange({ ...state, cursor: lineBounds(value, cursor).start });
      if (key.end) return onChange({ ...state, cursor: lineBounds(value, cursor).end });
      if (key.upArrow) return onChange(moveVisual(state, textColumns, -1));
      if (key.downArrow) return onChange(moveVisual(state, textColumns, 1));
      // Most terminals send DEL (0x7f) for Backspace, which Ink reports as `delete`.
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        return onChange({ value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 });
      }
      if (key.escape || key.tab || key.pageUp || key.pageDown) return;
      if (!input) return;
      if (/^\[\?\d*u$/.test(input)) return; // stray keyboard-protocol reply from the terminal
      // Pasted text arrives as one chunk; normalise its line endings and strip control chars.
      let text = input.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
      if (mask) text = text.replace(/\s+/g, "");
      if (text) onChange(insert(state, text));
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
