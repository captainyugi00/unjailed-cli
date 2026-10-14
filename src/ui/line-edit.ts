/**
 * Word-level editing for the prompt: the shortcuts of readline, macOS text
 * fields and Windows/VS Code editors, decoded from the raw escape sequences
 * terminals send. Ink folds many of these into plain arrows or reports
 * Delete and Backspace as the same key, so they are matched here instead.
 */

export interface EditorState {
  value: string;
  cursor: number;
}

export type EditAction =
  | "charLeft" | "charRight" | "wordLeft" | "wordRight"
  | "lineStart" | "lineEnd" | "bufferStart" | "bufferEnd"
  | "deleteCharForward" | "deleteWordBack" | "deleteWordForward" | "deleteBigWordBack"
  | "deleteToLineStart" | "deleteToLineEnd"
  | "yank" | "undo" | "redo"
  | "upcaseWord" | "downcaseWord" | "capitalizeWord" | "transposeWords";

// CSI modifier numbers: 2 shift, 3 alt, 5 ctrl, 9 super/cmd (+1 for each
// combination). Alt and Ctrl both mean "by word"; Cmd means "to the line edge".
const WORD_MODS = "(?:3|5|7|4|6|8)";
const CMD_MODS = "(?:9|10|11|13|14|15|16)";

const TABLE: Array<[RegExp, EditAction]> = [
  // Ctrl/Alt + ←/→ (xterm, kitty, iTerm, Windows Terminal, VS Code), rxvt's
  // ESC O d/c, the ESC-prefixed arrows of older macOS terminals, and
  // readline's Alt+B / Alt+F (macOS Option+←/→ by default).
  [new RegExp(`^\\x1b\\[(?:1;)?${WORD_MODS}D$`), "wordLeft"],
  [new RegExp(`^\\x1b\\[(?:1;)?${WORD_MODS}C$`), "wordRight"],
  [/^\x1bO[dD]$|^\x1b\x1b\[D$|^\x1b[bB]$/, "wordLeft"],
  [/^\x1bO[cC]$|^\x1b\x1b\[C$|^\x1b[fF]$/, "wordRight"],
  // Cmd + ←/→ when the terminal passes it through (kitty, Ghostty, WezTerm).
  [new RegExp(`^\\x1b\\[1;${CMD_MODS}D$`), "lineStart"],
  [new RegExp(`^\\x1b\\[1;${CMD_MODS}C$`), "lineEnd"],
  // Ctrl+Home / Ctrl+End and Alt+< / Alt+>: the whole message.
  [new RegExp(`^\\x1b\\[(?:1;)?${WORD_MODS}H$|^\\x1b\\[1;${CMD_MODS}A$|^\\x1b<$`), "bufferStart"],
  [new RegExp(`^\\x1b\\[(?:1;)?${WORD_MODS}F$|^\\x1b\\[1;${CMD_MODS}B$|^\\x1b>$`), "bufferEnd"],
  // Delete (forward) — Ink reports it exactly like Backspace.
  [/^\x1b\[3~$/, "deleteCharForward"],
  // Ctrl/Alt + Delete, Alt+D: delete the next word.
  [new RegExp(`^\\x1b\\[3;${WORD_MODS}~$|^\\x1b[dD]$`), "deleteWordForward"],
  [new RegExp(`^\\x1b\\[3;${CMD_MODS}~$`), "deleteToLineEnd"],
  // Ctrl/Alt + Backspace: ^H (Windows Terminal, VS Code, GNOME), ESC DEL
  // (Alt/Option), and the kitty / modifyOtherKeys encodings.
  [/^\x08$|^\x1b[\x7f\x08]$|^\x1b\[(?:127|8);[3-8]u$|^\x1b\[27;[3-8];(?:127|8)~$/, "deleteWordBack"],
  // Cmd+Backspace (kitty); most macOS terminals send Ctrl+U for it already.
  [/^\x1b\[(?:127|8);(?:9|1[0-6])u$/, "deleteToLineStart"],
  // Undo: Ctrl+Z, Ctrl+_ (also Ctrl+/ and Ctrl+- in most terminals), Cmd+Z.
  [/^\x1a$|^\x1f$|^\x1b\[(?:122|47|45);5u$|^\x1b\[27;5;(?:122|47|45)~$|^\x1b\[122;9u$/, "undo"],
  // Redo: Ctrl+Shift+Z, Ctrl+Y is taken by yank, Cmd+Shift+Z, Alt+_.
  [/^\x1b\[(?:122|90);(?:6|10)u$|^\x1b\[27;6;(?:122|90)~$|^\x1b_$/, "redo"],
  [/^\x02$/, "charLeft"],
  [/^\x06$/, "charRight"],
  [/^\x19$/, "yank"],
  [/^\x1b[uU]$/, "upcaseWord"],
  [/^\x1b[lL]$/, "downcaseWord"],
  [/^\x1b[cC]$/, "capitalizeWord"],
  [/^\x1b[tT]$/, "transposeWords"],
];

/** The editing action a raw key sequence stands for, if any. */
export function classifyKey(raw: string): EditAction | null {
  for (const [re, action] of TABLE) if (re.test(raw)) return action;
  return null;
}

const WORD = /[\p{L}\p{N}\p{M}_]/u;
const isWord = (ch: string | undefined) => !!ch && WORD.test(ch);

/** Index of the character before / after `i`, stepping over surrogate pairs. */
export function prevIndex(s: string, i: number): number {
  if (i <= 0) return 0;
  const c = s.charCodeAt(i - 1);
  return i >= 2 && c >= 0xdc00 && c <= 0xdfff && (s.charCodeAt(i - 2) & 0xfc00) === 0xd800 ? i - 2 : i - 1;
}
export function nextIndex(s: string, i: number): number {
  if (i >= s.length) return s.length;
  const c = s.charCodeAt(i);
  return c >= 0xd800 && c <= 0xdbff && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? i + 2 : i + 1;
}
const charAt = (s: string, i: number) => s.slice(i, nextIndex(s, i));
const charBefore = (s: string, i: number) => s.slice(prevIndex(s, i), i);

/** Start of the word at or before the cursor (skips spaces and punctuation first). */
export function wordStart(s: string, i: number): number {
  while (i > 0 && !isWord(charBefore(s, i))) i = prevIndex(s, i);
  while (i > 0 && isWord(charBefore(s, i))) i = prevIndex(s, i);
  return i;
}

/** End of the word at or after the cursor (skips spaces and punctuation first). */
export function wordEnd(s: string, i: number): number {
  while (i < s.length && !isWord(charAt(s, i))) i = nextIndex(s, i);
  while (i < s.length && isWord(charAt(s, i))) i = nextIndex(s, i);
  return i;
}

export function lineBounds(value: string, cursor: number): { start: number; end: number } {
  const start = value.lastIndexOf("\n", cursor - 1) + 1;
  const nl = value.indexOf("\n", cursor);
  return { start, end: nl === -1 ? value.length : nl };
}

export interface EditResult {
  state: EditorState;
  /** Text removed by a kill command, for yank. */
  killed?: string;
}

const cut = (s: EditorState, from: number, to: number): EditResult =>
  from === to ? { state: s } : { state: { value: s.value.slice(0, from) + s.value.slice(to), cursor: from }, killed: s.value.slice(from, to) };

function recase(s: EditorState, fn: (w: string) => string): EditorState {
  const start = s.cursor;
  const end = wordEnd(s.value, start);
  return { value: s.value.slice(0, start) + fn(s.value.slice(start, end)) + s.value.slice(end), cursor: end };
}

/** Apply a movement or edit. Yank, undo and redo need the editor's own
 *  history and are handled by the caller. */
export function applyEdit(action: EditAction, s: EditorState): EditResult {
  const { value, cursor } = s;
  const line = lineBounds(value, cursor);
  const move = (c: number): EditResult => ({ state: { value, cursor: c } });
  switch (action) {
    case "charLeft": return move(prevIndex(value, cursor));
    case "charRight": return move(nextIndex(value, cursor));
    case "wordLeft": return move(wordStart(value, cursor));
    case "wordRight": return move(wordEnd(value, cursor));
    case "lineStart": return move(line.start);
    case "lineEnd": return move(line.end);
    case "bufferStart": return move(0);
    case "bufferEnd": return move(value.length);
    case "deleteCharForward": return cut(s, cursor, nextIndex(value, cursor));
    case "deleteWordBack": return cut(s, wordStart(value, cursor), cursor);
    case "deleteWordForward": return cut(s, cursor, wordEnd(value, cursor));
    case "deleteBigWordBack": {
      // Ctrl+W: back to the previous whitespace, like readline's unix-word-rubout.
      const from = value.slice(0, cursor).replace(/\S+\s*$|\s+$/, "").length;
      return cut(s, from, cursor);
    }
    case "deleteToLineStart":
      // At the start of a line, join it with the one above.
      return cut(s, cursor === line.start && cursor > 0 ? cursor - 1 : line.start, cursor);
    case "deleteToLineEnd":
      return cut(s, cursor, cursor === line.end && cursor < value.length ? cursor + 1 : line.end);
    case "upcaseWord": return { state: recase(s, (w) => w.toUpperCase()) };
    case "downcaseWord": return { state: recase(s, (w) => w.toLowerCase()) };
    case "capitalizeWord": {
      return {
        state: recase(s, (w) => {
          const i = w.search(WORD);
          return i < 0 ? w : w.slice(0, i) + w.charAt(i).toUpperCase() + w.slice(i + 1).toLowerCase();
        }),
      };
    }
    case "transposeWords": {
      // Swap the word before the cursor with the one after it (Alt+T).
      const bEnd = wordEnd(value, wordStart(value, cursor));
      const bStart = wordStart(value, bEnd);
      const aEnd = wordEnd(value, bEnd);
      const aStart = wordStart(value, aEnd);
      if (aStart <= bStart || bEnd === bStart || aEnd === aStart) return { state: s };
      const out = value.slice(0, bStart) + value.slice(aStart, aEnd) + value.slice(bEnd, aStart) + value.slice(bStart, bEnd) + value.slice(aEnd);
      return { state: { value: out, cursor: aEnd } };
    }
    default:
      return { state: s };
  }
}
