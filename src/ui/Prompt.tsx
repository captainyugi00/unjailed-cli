import React, { useRef } from "react";
import { Box, Text, useInput, type Key } from "ink";
import { theme } from "../theme.js";
import { editorViewport } from "./stream-buffer.js";

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
  mask?: boolean;
  placeholder?: string;
  isActive: boolean;
  label?: string;
  width?: number;
  maxRows?: number;
}

const isShiftEnter = (input: string, key: Key) =>
  (key.return && (key.shift || key.meta)) || input === "[27;2;13~" || input === "[13;2u";

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

export function Prompt({ state: propState, onChange: propOnChange, onSubmit, onSpecialKey, mask, placeholder, isActive, label, width = 80, maxRows = 4 }: PromptProps) {
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
      if (key.upArrow) return onChange(moveVertical(state, -1));
      if (key.downArrow) return onChange(moveVertical(state, 1));
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
  const prefix = label ?? "› ";
  const pad = " ".repeat(prefix.length);
  const viewport = editorViewport(state.value, state.cursor, Math.max(4, width - prefix.length), maxRows);
  const lines = viewport.lines.map((line) => renderWithCursor(mask ? "•".repeat(line.text.length) : line.text, line.cursor ?? 0, isActive && line.cursor !== null, state.value ? undefined : placeholder));
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          {i === 0 ? theme.brand(prefix) : pad}
          {l}
        </Text>
      ))}
      {viewport.hidden && maxRows > 1 && <Text wrap="truncate-end">{theme.dim("  ⋯ draft continues; full text preserved")}</Text>}
    </Box>
  );
}

function renderWithCursor(value: string, cursor: number, active: boolean, placeholder?: string): string {
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
