import { highlight, supportsLanguage } from "cli-highlight";
import { c, colorLevel } from "./theme.js";
import { BRAND_BLUE } from "./constants.js";
import stringWidth from "string-width";

const RESET = colorLevel > 0 ? "\x1b[0m" : "";

// A conservative allow-list of HTML tags some models leak into markdown. We only
// strip these exact tags (not every `<...>`), so things like `List<int>` or
// `a < b` survive untouched.
const HTML_TAG = /<\/?(?:br|p|div|span|strong|em|b|i|u|s|code|pre|ul|ol|li|dl|dt|dd|h[1-6]|blockquote|hr|table|thead|tbody|tfoot|tr|td|th|a|img|figure|figcaption|small|sub|sup)(?:\s[^>]*)?\s*\/?>/gi;

/** Bold, italics, inline code and links within a single line. */
function inline(text: string): string {
  // Pull inline code out first so its contents aren't formatted or HTML-stripped.
  const codes: string[] = [];
  let s = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(HTML_TAG, ""); // drop leaked html outside code spans
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, (_, t: string) => c.bold(t));
  s = s.replace(/__([^_\n]+?)__/g, (_, t: string) => c.bold(t));
  s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, (_, pre: string, t: string) => pre + c.italic(t));
  s = s.replace(/~~([^~\n]+?)~~/g, (_, t: string) => c.strikethrough(t));
  s = s.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, (_, label: string, url: string) => `${c.hex(BRAND_BLUE).underline(label)} ${c.gray(`(${url})`)}`);
  // inline code renders as a subtle chip; stays verbatim in no-color mode
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => (colorLevel === 0 ? `\`${codes[+i]}\`` : c.hex(BRAND_BLUE)(codes[+i]!)));
  return s;
}

/** A fenced code block drawn as a rounded box with a dim language label.
 *  `boxW` is the total visible width of the box (borders included); long code
 *  lines are wrapped to the inner width so the right border never blows out. */
function codeBlock(code: string, lang: string, boxW: number, highlightCode = true): string[] {
  let body = code.replace(/\n+$/, "");
  // Automatic language detection tests many grammars and can stall on long
  // generated files. Streaming previews never highlight; completed output
  // highlights only an explicit supported language and a bounded code block.
  if (highlightCode && colorLevel > 0 && body.length <= 32_000 && lang && supportsLanguage(lang)) {
    try {
      body = highlight(body, { language: lang, ignoreIllegals: true });
    } catch {
      /* leave plain */
    }
  }
  const h = (s: string) => c.gray(s);
  const inner = Math.max(8, boxW - 4); // between "│ " (2) and " │" (2)
  const open = lang ? `╭─ ${lang} ` : "╭─ ";
  const fill = Math.max(2, boxW - stringWidth(open) - 1);
  const rows: string[] = [h(open + "─".repeat(fill) + "╮")];
  for (const raw of body.split("\n")) {
    const pieces = stringWidth(raw) > inner ? wrapAnsiLine(raw, inner + 1) : [raw];
    for (const piece of pieces) {
      const pad = " ".repeat(Math.max(0, inner - stringWidth(piece)));
      rows.push(h("│ ") + piece + RESET + pad + h(" │"));
    }
  }
  rows.push(h("╰" + "─".repeat(Math.max(2, boxW - 2)) + "╯"));
  return rows;
}

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

const isTableSeparator = (line: string) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);

function table(rows: string[][], aligns: ("left" | "right" | "center")[]): string[] {
  const cols = Math.max(...rows.map((r) => r.length));
  const cells = rows.map((r) => Array.from({ length: cols }, (_, i) => inline(r[i] ?? "")));
  const widths = Array.from({ length: cols }, (_, i) => Math.max(3, ...cells.map((r) => stringWidth(r[i]!))));
  const pad = (text: string, i: number) => {
    const gap = widths[i]! - stringWidth(text);
    if (aligns[i] === "right") return " ".repeat(gap) + text;
    if (aligns[i] === "center") return " ".repeat(Math.floor(gap / 2)) + text + " ".repeat(Math.ceil(gap / 2));
    return text + " ".repeat(gap);
  };
  const bar = c.gray(" │ ");
  const out = cells.map((r, ri) => r.map((cell, i) => pad(ri === 0 ? c.bold(cell) : cell, i)).join(bar));
  out.splice(1, 0, c.gray(widths.map((w) => "─".repeat(w)).join("─┼─")));
  return out;
}

/** Wrap a single rendered line to `cols` visible columns, ANSI-aware.
 *  Long unbroken lines (urls, paths, minified code) otherwise clip hard at
 *  the terminal edge on narrow windows consoles. */
function wrapAnsiLine(line: string, cols: number): string[] {
  if (cols < 20) return [line];
  const parts: string[] = [];
  let cur = "";
  let width = 0;
  // split into (ansi, visible char) tokens
  const tokens = line.match(/\x1b\[[0-9;]*m|./gu) ?? [];
  for (const tok of tokens) {
    if (tok.startsWith("\x1b")) { cur += tok; continue; }
    const w = stringWidth(tok);
    if (width + w > cols - 1) {
      parts.push(cur);
      cur = "";
      width = 0;
      // preserve leading bullet indent continuation
    }
    cur += tok;
    width += w;
  }
  parts.push(cur);
  return parts;
}

/**
 * Render markdown to ANSI text. Safe to call on partial (still-streaming) input:
 * an unterminated code fence renders as the code block so far, a half-written
 * table or dangling emphasis just renders as text. Never throws.
 */
export function renderMarkdown(src: string, opts: { width?: number; highlightCode?: boolean } = {}): string {
  // Width is known while streaming; for the settled transcript it isn't passed,
  // so fall back to the live terminal width. Boxes are sized to fit inside it
  // (and capped) so Ink never has to wrap — and corrupt — a bordered line.
  const effWidth = opts.width ?? (process.stdout.columns || 80);
  const boxW = Math.max(24, Math.min(effWidth - 3, 120));

  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/);
    if (fence) {
      const marker = fence[1]!;
      const lang = fence[2] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) body.push(lines[i++]!);
      out.push(...codeBlock(body.join("\n"), lang, boxW, opts.highlightCode));
      continue;
    }

    // GitHub-style table: a header row followed by a |---|---| separator.
    if (line.trim().startsWith("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const aligns = splitRow(lines[i + 1]!).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left") as "left" | "right" | "center");
      const rows = [splitRow(line)];
      i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith("|")) rows.push(splitRow(lines[i++]!));
      i--;
      out.push(...table(rows, aligns));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1]!.length;
      const text = inline(heading[2]!.trim());
      // h1/h2: brand, bold, underlined · h3: brand bold · h4+: bold
      if (level <= 2) out.push(c.hex(BRAND_BLUE).bold.underline(text));
      else if (level === 3) out.push(c.hex(BRAND_BLUE).bold(text));
      else out.push(c.bold(text));
      continue;
    }

    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push(c.gray("─".repeat(Math.min(boxW, 60))));
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/);
    if (bullet) {
      const indent = " ".repeat(Math.floor(bullet[1]!.length / 2) * 2);
      const box = bullet[2] === undefined ? "•" : bullet[2] === " " ? "☐" : "☑";
      out.push(`${indent}${c.hex(BRAND_BLUE)(box)} ${inline(bullet[3]!)}`);
      continue;
    }

    const numbered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (numbered) {
      const indent = " ".repeat(Math.floor(numbered[1]!.length / 2) * 2);
      out.push(`${indent}${c.hex(BRAND_BLUE)(numbered[2] + ".")} ${inline(numbered[3]!)}`);
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      out.push(c.gray("▎ ") + c.italic(inline(quote[1]!)));
      continue;
    }

    out.push(inline(line));
  }

  // Tidy: right-trim every line, and collapse runs of blank lines to one.
  const tidy: string[] = [];
  let blank = false;
  for (const l of out) {
    if (l.trim() === "") {
      if (blank) continue;
      blank = true;
      tidy.push("");
    } else {
      blank = false;
      tidy.push(l.replace(/[ \t]+$/, ""));
    }
  }
  while (tidy.length && tidy[0] === "") tidy.shift();
  while (tidy.length && tidy[tidy.length - 1] === "") tidy.pop();

  // Width-wrap: box lines are already sized to fit, so wrapAnsiLine returns them
  // intact; only over-long prose/urls actually get broken.
  return tidy
    .flatMap((l) => (l.includes("\x1b") || stringWidth(l) > effWidth - 1 ? wrapAnsiLine(l, effWidth) : [l]))
    .join("\n");
}
