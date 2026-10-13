import stringWidth from "string-width";

/** Incremental display parsing. The original response is kept separately by
 * App: this buffer never modifies the text it flushes to terminal scrollback. */
export class StreamDisplayBuffer {
  private parts: string[] = [];
  private head = 0;
  private pendingCharacters = 0;
  private tail = "";
  private partialLine = "";
  private safe = 0;
  private fence: string | null = null;
  scannedCharacters = 0;

  append(text: string): void {
    const before = this.pendingCharacters;
    this.parts.push(text);
    this.pendingCharacters += text.length;
    this.tail = (this.tail + text).slice(-2_400);
    let start = 0;
    let end: number;
    // Search only the new chunk. Searching/slicing a growing cons string can
    // force V8 to flatten the complete response again for every tiny token.
    while ((end = text.indexOf("\n", start)) !== -1) {
      const line = this.partialLine + text.slice(start, end);
      this.partialLine = "";
      this.scannedCharacters += line.length + 1;
      const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
      if (this.fence) {
        if (marker && marker[1]![0] === this.fence[0] && marker[1]!.length >= this.fence.length && !marker[2]!.trim()) {
          this.fence = null;
          this.safe = before + end + 1;
        }
      } else if (marker) {
        this.fence = marker[1]!;
      } else if (!line.trim()) {
        this.safe = before + end + 1;
      }
      start = end + 1;
    }
    this.partialLine += text.slice(start);
  }

  drainSafe(): string {
    if (!this.safe) return "";
    const pieces: string[] = [];
    let remaining = this.safe;
    while (remaining > 0) {
      const part = this.parts[this.head]!;
      if (part.length <= remaining) {
        pieces.push(part);
        remaining -= part.length;
        this.head++;
      } else {
        pieces.push(part.slice(0, remaining));
        this.parts[this.head] = part.slice(remaining);
        remaining = 0;
      }
    }
    this.pendingCharacters -= this.safe;
    this.tail = this.pendingCharacters ? this.tail.slice(-this.pendingCharacters) : "";
    this.safe = 0;
    if (this.head === this.parts.length || this.head > 1_024) {
      this.parts = this.parts.slice(this.head);
      this.head = 0;
    }
    return pieces.join("");
  }

  preview(maxChars = 2_400, maxLines = 40): { text: string; hiddenCharacters: number } {
    let text = this.tail.slice(-maxChars);
    // Do not split a surrogate pair at the beginning of a live tail.
    if (/^[\uDC00-\uDFFF]/.test(text)) text = text.slice(1);
    const lines = text.split("\n");
    if (lines.length > maxLines) text = lines.slice(-maxLines).join("\n");
    return { text, hiddenCharacters: this.pendingCharacters - text.length };
  }

  /** Everything not yet drained, without consuming it (for saving a turn mid-paragraph). */
  peek(): string {
    return this.parts.slice(this.head).join("");
  }

  finish(): string {
    const result = this.parts.slice(this.head).join("");
    this.parts = [];
    this.head = this.pendingCharacters = this.safe = 0;
    this.tail = this.partialLine = "";
    this.fence = null;
    return result;
  }
}

/** Completed output is already in terminal scrollback. Keep a bounded recent
 * display window for resize/replay, independently of saved conversation data.
 * The newest item is retained whole so final output is never silently cut. */
export function retainDisplayWindow<T extends { kind: string; text?: string }>(items: T[], maxItems = 120, maxChars = 96_000): T[] {
  if (items.length < 2) return items;
  const header = items[0]?.kind === "header" ? items[0] : null;
  let chars = 0;
  let start = items.length;
  while (start > (header ? 1 : 0)) {
    const next = items[start - 1]!;
    const size = next.text?.length ?? 0;
    if (start < items.length && (items.length - start >= maxItems - (header ? 1 : 0) || chars + size > maxChars)) break;
    chars += size;
    start--;
  }
  return start <= (header ? 1 : 0) ? items : [...(header ? [header] : []), ...items.slice(start)];
}

/** Reserve space for status, reasoning, separators, the queued-input editor
 * and menus. Oversized input can leave only one live response row. */
export function streamingRowBudget(rows: number, columns: number, editor: string, hasReasoning: boolean, planApproval: boolean): number {
  const width = Math.max(8, columns - 3);
  // Input has its own four-row viewport; never split an entire giant paste
  // merely to decide how much response text fits above it.
  const sample = editor.slice(-width * 4);
  const inputRows = Math.min(4, sample.split("\n").reduce((total, line) => total + Math.max(1, Math.ceil(line.length / width)), 0));
  return Math.max(1, rows - 8 - inputRows - (hasReasoning ? 2 : 0) - (planApproval ? 5 : 0));
}
/** Bound draft rendering around the cursor without altering the edit buffer.
 * Only a small local slice is measured/wrapped, even for a megabyte paste. */
export function editorViewport(value: string, cursor: number, columns: number, maxRows = 4): { lines: Array<{ text: string; cursor: number | null }>; hidden: boolean } {
  const width = Math.max(4, columns - 1); // leave one cell for an end cursor
  const radius = width * Math.max(1, maxRows);
  let start = Math.max(0, cursor - radius);
  if (start && /[\uDC00-\uDFFF]/.test(value[start]!)) start--;
  let end = Math.min(value.length, cursor + radius);
  if (end < value.length && /[\uDC00-\uDFFF]/.test(value[end]!)) end++;
  const rows: Array<{ text: string; start: number; end: number }> = [];
  let text = "", cells = 0, rowStart = start, offset = start;
  for (const ch of value.slice(start, end)) {
    if (ch === "\n") {
      rows.push({ text, start: rowStart, end: offset });
      text = ""; cells = 0; rowStart = offset + 1;
    } else {
      const size = stringWidth(ch);
      if (cells + size > width) {
        rows.push({ text, start: rowStart, end: offset });
        text = ""; cells = 0; rowStart = offset;
      }
      text += ch; cells += size;
    }
    offset += ch.length;
  }
  rows.push({ text, start: rowStart, end: offset });
  let current = rows.findIndex((row) => cursor >= row.start && cursor <= row.end);
  if (current < 0) current = rows.length - 1;
  const visibleCount = Math.max(1, maxRows - (maxRows > 1 ? 1 : 0));
  const first = Math.max(0, Math.min(current - Math.floor(visibleCount / 2), rows.length - visibleCount));
  const selected = rows.slice(first, first + visibleCount);
  return {
    lines: selected.map((row, i) => ({ text: row.text, cursor: first + i === current ? cursor - row.start : null })),
    hidden: start > 0 || end < value.length || first > 0 || first + selected.length < rows.length,
  };
}
