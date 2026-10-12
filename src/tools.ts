import { spawn, spawnSync } from "node:child_process";
import { processStatus, runLocalCommand, stopProcess } from "./processes.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The built-in agent tools — a coding-agent toolkit like opencode/claude-code.
 *  Mode ladder (least → most capable):
 *    read  : read-only filesystem, clipboard and web fetch
 *    cmds  : + writes, launches and commands (user confirms each mutation)
 *    yolo  : same capabilities with explicit automatic approval
 */
export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type ToolsMode = "off" | "read" | "cmds" | "yolo";

export const MAX_READ_BYTES = 200_000;      // 200 KB per file read
export const MAX_EDIT_FILE_BYTES = 5_000_000; // targeted edits/range reads; full writes retain their smaller limit
export const MAX_WRITE_BYTES = 200_000;     // 200 KB per file write
export const MAX_RUN_OUTPUT = 30_000;       // chars of stdout/stderr kept
export const MAX_TOOL_OUTPUT = 28_000;      // HARD cap: upstream rejects strings > 32k — never send more
export const RUN_TIMEOUT_MS = 600_000;      // 10 min — downloads, builds, server setup
export const MAX_BG_LOG = 100_000;
export const MAX_LIST = 500;
export const MAX_GLOB_RESULTS = 200;
export const MAX_GREP_RESULTS = 100;
export const WEB_FETCH_MAX_BYTES = 200_000;
export const WEB_TIMEOUT_MS = 15_000;

export function toolDefinitions(mode: ToolsMode): ToolDef[] {
  if (mode === "off") return [];
  const defs: ToolDef[] = [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a UTF-8 text file. Use start_line and max_lines to inspect later sections or large files. Paths are relative to the current directory unless absolute.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "File path to read" }, start_line: { type: "integer", minimum: 1, description: "First line, 1-based" }, max_lines: { type: "integer", minimum: 1, maximum: 500, description: "Number of lines (default 200 for ranged reads)" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_dir",
        description: "List files and folders in a directory (one level). Defaults to the current directory.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Directory to list (default .)" } },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "glob",
        description: "Find files whose names match a glob pattern, e.g. \"**/*.ts\" or \"src/**/*.{js,ts}\". Recursive from the current directory unless the pattern starts with a path.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob pattern to match" },
            path: { type: "string", description: "Directory to search in (default .)" },
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "grep",
        description: "Search file CONTENTS for a regular expression. Returns matching lines with file:line. Skips node_modules, .git and binary-ish files.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regular expression to search for" },
            path: { type: "string", description: "File or directory to search (default .)" },
            glob: { type: "string", description: "Only search files matching this glob, e.g. \"*.ts\"" },
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "clipboard",
          description: mode === "read" ? "Read the system clipboard. Only action: read is allowed in read mode." : "Read or write the system clipboard. action: read or write; text required for write. Cross-platform.",
          parameters: {
            type: "object",
            properties: {
              action: { type: "string", enum: mode === "read" ? ["read"] : ["read", "write"] },
              text: { type: "string", description: "Text to write (for write)" },
            },
            required: ["action"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "launch_app",
          description: "Open a file, folder or application with the OS default handler. Windows: 'start', macOS: 'open', Linux: 'xdg-open'. Examples: 'notepad.exe', 'calc', a folder path to open Explorer/Finder, 'code' for VS Code.",
          parameters: {
            type: "object",
            properties: {
              target: { type: "string", description: "App name or file/folder path" },
            },
            required: ["target"],
          },
        },
      },
    {
      type: "function",
      function: {
        name: "open_url",
        description: "Open an http/https URL in the user's default browser (requires cmds/yolo permission).",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "URL to open" } },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "web_fetch",
        description: "Fetch a URL and return the response body as text (HTML stripped to text when possible). For reading docs and APIs.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "URL to fetch" } },
          required: ["url"],
        },
      },
    },
  ];

  if (mode === "cmds" || mode === "yolo") {
    defs.push(
      {
        type: "function",
        function: {
          name: "write_file",
          description: "Create or overwrite a text file with the given content. Parent folders are created automatically. On Windows 11 you can write to user folders directly: \"Desktop/file.txt\", \"Documents/notes.md\", \"Downloads/\", or create project folders like \"Desktop/Code/app.py\" or \"Desktop/Tools/script.ps1\". Also supports ~/ paths.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path to write" },
              content: { type: "string", description: "Full file content to write" },
            },
            required: ["path", "content"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "edit_file",
          description: "Replace exact text inside an existing file. old_text must match the file exactly (including whitespace). Fails without writing if not found or found more than once unless replace_all is true.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File to edit" },
              old_text: { type: "string", description: "Exact text to replace" },
              new_text: { type: "string", description: "Replacement text" },
              replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
            },
            required: ["path", "old_text", "new_text"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "move_file",
          description: "Move or rename a file/folder. Accepts Desktop/Documents/Downloads shortcuts and ~ paths. Destination parent folders are created.",
          parameters: {
            type: "object",
            properties: {
              from: { type: "string", description: "Source path" },
              to: { type: "string", description: "Destination path" },
            },
            required: ["from", "to"],
          },
        },
      },
            {
        type: "function",
        function: {
          name: "delete_file",
          description: "Send a file or folder to the OS trash/recycle bin. If trash is unavailable, returns an error and preserves the file. Permanent deletion requires permanent:true and permission.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File or folder to delete" },
              permanent: { type: "boolean", description: "Explicitly permanently delete instead of using Trash. Default false." },
            },
            required: ["path"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "run_command",
          description: "Run a shell command (/bin/sh on Unix, cmd.exe on Windows). Supports cwd for another project folder and timeout_ms (up to 600000). Use background:true for servers; returns a job_id for process_status/stop_process.",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "The command line to run" },
              background: { type: "boolean", description: "Run in the background for this CLI session. Returns a job ID and bounded log." },
              cwd: { type: "string", description: "Working directory, including absolute, ~/ and Desktop/Documents shortcuts. Default current directory." },
              timeout_ms: { type: "integer", minimum: 1, maximum: RUN_TIMEOUT_MS, description: "Foreground timeout in milliseconds (default 600000)." },
            },
            required: ["command"],
          },
        },
      },
    );
  }
  defs.push({
    type: "function",
    function: {
      name: "process_status", description: "Read status and recent output for a background job started in this CLI session.",
      parameters: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] },
    },
  });
  if (mode === "cmds" || mode === "yolo") defs.push({
    type: "function",
    function: {
      name: "stop_process", description: "Stop a background job and its child processes. Only accepts a job_id created by this CLI session.",
      parameters: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] },
    },
  });
  return mode === "read" ? defs.filter((def) => !["launch_app", "open_url"].includes(def.function.name)) : defs;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

/** Resolve user shortcut folders — Windows 11 friendly.
 *  "Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music" map to
 *  the real OS folders (%USERPROFILE%\Desktop on Win11, ~/Desktop elsewhere).
 *  Anything else returns null (not a shortcut). */
export function userFolder(name: string): string | null {
  const home = os.homedir();
  const map: Record<string, string> = {
    desktop: path.join(home, "Desktop"),
    documents: path.join(home, "Documents"),
    downloads: path.join(home, "Downloads"),
    pictures: path.join(home, "Pictures"),
    videos: path.join(home, "Videos"),
    music: path.join(home, "Music"),
  };
  return map[name.toLowerCase()] ?? null;
}

/** Resolve a tool path: supports "Desktop/foo.txt" style shortcuts + ~ expansion,
 *  then falls back to cwd-relative. Windows paths (C:\... or backslashes) resolve
 *  as absolute already. */
export function resolveToolPath(p: string, cwd: string, platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (p === "~") return home;
  if (/^~[\\/]/.test(p)) return paths.resolve(home, p.slice(2));
  const parts = p.split(/[\\\\/]/);
  const firstSeg = parts[0] ?? "";
  const names: Record<string, string> = { desktop: "Desktop", documents: "Documents", downloads: "Downloads", pictures: "Pictures", videos: "Videos", music: "Music" };
  const folder = names[firstSeg.toLowerCase()];
  if (folder) return paths.resolve(home, folder, ...parts.slice(1));
  return paths.resolve(cwd, p);
}

function clip(s: string, max = MAX_RUN_OUTPUT): string {
  // every tool result funnels through here — enforce the global cap too
  const m = Math.min(max, MAX_TOOL_OUTPUT);
  return s.length > m ? s.slice(0, m) + `\n…(truncated at ${m} chars)` : s;
}

/** Drop wasted tokens from command output: trailing whitespace per line and
 *  long blank runs. Used only for run_command (NOT read_file — collapsing a
 *  source file's blank lines would break edit_file's exact-match). */
function squeeze(s: string): string {
  return s.replace(/[ \t]+$/gm, "").replace(/\n{4,}/g, "\n\n\n");
}

/* ───────────── glob: tiny recursive matcher, no deps ───────────── */

function globToRe(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** — any chars including /
        re += ".*";
        i += 2;
        if (glob[i] === "/") i++; // '**/' also matches zero dirs
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      // simple {a,b} alternation
      let j = i + 1, depth = 1, body = "";
      while (j < glob.length && depth > 0) {
        if (glob[j] === "{") depth++;
        if (glob[j] === "}") { depth--; if (depth === 0) break; }
        body += glob[j]; j++;
      }
      re += `(?:${body.split(",").map(escapeRe).join("|")})`;
      i = j; i++;
      continue;
    } else re += escapeRe(c);
    i++;
  }
  return new RegExp(`^${re}$`);
}
function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "dist", "build", ".next", "target", "__pycache__", ".venv", "venv"]);

function walkFiles(root: string, out: string[], budget: { left: number }): void {
  if (budget.left <= 0) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (budget.left <= 0) return;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      walkFiles(path.join(root, e.name), out, budget);
    } else if (e.isFile()) {
      out.push(path.join(root, e.name));
      budget.left--;
    }
  }
}

/* ───────────── grep ───────────── */

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8000);
  return sample.includes(0);
}

function* grepWalk(root: string): Generator<string> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      yield* grepWalk(path.join(root, e.name));
    } else if (e.isFile()) yield path.join(root, e.name);
  }
}

/* ───────────── web ───────────── */

async function webFetch(url: string): Promise<ToolResult> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { ok: false, output: `Invalid URL: ${url}` }; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, output: "Only http and https URLs are supported." };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), WEB_TIMEOUT_MS);
  try {
    const res = await fetch(parsed, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": "unjailed-cli/0.6 (terminal agent)" },
    });
    const type = res.headers.get("content-type") ?? "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > WEB_FETCH_MAX_BYTES * 2) return { ok: false, output: `Response too large (${buf.byteLength} bytes).` };
    let text = buf.toString("utf8");
    if (type.includes("html")) {
      // crude but effective html → text
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }
    return { ok: res.ok, output: `HTTP ${res.status} ${res.statusText}\n${clip(text, WEB_FETCH_MAX_BYTES)}` };
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? `Timed out after ${WEB_TIMEOUT_MS / 1000}s` : (e as Error).message;
    return { ok: false, output: `Fetch failed: ${msg}` };
  } finally {
    clearTimeout(t);
  }
}

async function launchTarget(target: string, app = false): Promise<ToolResult> {
  const plat = process.platform;
  // Send Windows targets as data, never interpolate them into cmd/PowerShell code.
  const command = plat === "win32" ? "powershell.exe" : plat === "darwin" ? "open" : app ? target : "xdg-open";
  const args = plat === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; Start-Process -FilePath $env:UNJAILED_OPEN_TARGET"]
    : plat === "darwin" ? (app ? ["-a", target] : [target]) : app ? [] : [target];
  return await new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true,
      env: { ...process.env, UNJAILED_OPEN_TARGET: target } });
    child.once("error", (err) => resolve({ ok: false, output: `Launch failed: ${err.message}` }));
    if (plat === "linux" && app) {
      child.once("spawn", () => { child.unref(); resolve({ ok: true, output: `Launched ${target}.` }); });
    } else {
      child.once("close", (code) => resolve({ ok: code === 0, output: code === 0 ? `Opened ${target}.` : `Launch failed (exit ${code}): ${target}` }));
    }
  });
}

/* ───────────── main dispatcher ───────────── */

export interface ToolExecutionOptions {
  mode?: ToolsMode;
  autoApprove?: boolean;
  signal?: AbortSignal;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
  approve?: (action: string) => Promise<boolean>,
  options: ToolExecutionOptions = {},
): Promise<ToolResult> {
  try {
    const mode = options.mode ?? "read";
    const known = toolDefinitions("yolo").some((tool) => tool.function.name === name);
    if (!known) return { ok: false, output: `Unknown tool: ${name}` };
    if (!toolDefinitions(mode).some((tool) => tool.function.name === name) ||
      (mode === "read" && name === "clipboard" && args.action !== undefined && args.action !== "read")) {
      return { ok: false, output: `${name} is unavailable in ${mode} mode. The user must select /tools cmds to allow changes.` };
    }
    if (options.signal?.aborted) return { ok: false, output: "Tool cancelled before execution." };
    const readOnly = ["read_file", "list_dir", "glob", "grep", "web_fetch", "process_status"].includes(name) ||
      (name === "clipboard" && (args.action === undefined || args.action === "read"));
    if (!readOnly && mode !== "yolo" && !options.autoApprove) {
      const action = `${name} ${JSON.stringify(args)}`;
      if (!approve || !(await approve(action))) return { ok: false, output: "The user declined or approval is unavailable. Nothing executed." };
    }
    // An approval can remain on screen while the user cancels the turn.
    if (options.signal?.aborted) return { ok: false, output: "Tool cancelled before execution." };

    if (name === "read_file") {
      const p = String(args.path ?? "");
      if (!p) return { ok: false, output: "path is required" };
      const file = resolveToolPath(p, cwd);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) return { ok: false, output: `${p} is a directory (use list_dir)` };
      const ranged = args.start_line !== undefined || args.max_lines !== undefined;
      const start = args.start_line ?? 1;
      const count = args.max_lines ?? 200;
      if (!Number.isInteger(start) || Number(start) < 1 || !Number.isInteger(count) || Number(count) < 1 || Number(count) > 500) return { ok: false, output: "start_line must be a positive integer; max_lines must be between 1 and 500." };
      if (stat.size > MAX_EDIT_FILE_BYTES) return { ok: false, output: `${p} exceeds the ${MAX_EDIT_FILE_BYTES}-byte range-read limit.` };
      if (stat.size > MAX_READ_BYTES && !ranged) return { ok: false, output: `${p} is ${stat.size} bytes. Read a section with start_line and max_lines.` };
      const data = fs.readFileSync(file, "utf8");
      if (!ranged && data.length <= MAX_TOOL_OUTPUT) return { ok: true, output: data };
      const lines = data.split("\n");
      if (Number(start) > lines.length) return { ok: false, output: `start_line exceeds ${lines.length} lines.` };
      let end = Number(start) - 1;
      let text = "";
      while (end < lines.length && end < Number(start) - 1 + Number(count)) {
        const line = lines[end]!;
        if (text.length + line.length + 1 > MAX_TOOL_OUTPUT - 200) break;
        text += (text ? "\n" : "") + line;
        end++;
      }
      if (end === Number(start) - 1) return { ok: false, output: "This single line exceeds the tool output limit. Search for a smaller anchor with grep." };
      return { ok: true, output: `[${p}: lines ${start}-${end} of ${lines.length}${end < lines.length ? `; next start_line=${end + 1}` : ""}]\n${text}` };
    }

    if (name === "list_dir") {
      const p = String(args.path ?? ".");
      const dir = resolveToolPath(p, cwd);
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      if (entries.length > MAX_LIST) return { ok: true, output: clip(entries.slice(0, MAX_LIST).map((e) => (e.isDirectory() ? e.name + "/" : e.name)).join("\n") + `\n…(${entries.length - MAX_LIST} more)`) };
      return { ok: true, output: entries.map((e) => (e.isDirectory() ? e.name + "/" : e.name)).join("\n") || "(empty)" };
    }

    if (name === "glob") {
      const pattern = String(args.pattern ?? "");
      if (!pattern) return { ok: false, output: "pattern is required" };
      const base = resolveToolPath(String(args.path ?? "."), cwd);
      // pattern may include a dir prefix; split leading literal dirs off
      const all: string[] = [];
      walkFiles(base, all, { left: 20_000 });
      const re = globToRe(pattern);
      const hits = all.filter((f) => {
        const rel = path.relative(base, f).split(path.sep).join("/");
        return re.test(rel) || re.test(rel.split("/").pop() ?? "");
      }).slice(0, MAX_GLOB_RESULTS);
      return { ok: true, output: hits.length ? hits.map((f) => path.relative(cwd, f)).join("\n") : "(no matches)" };
    }

    if (name === "grep") {
      const pattern = String(args.pattern ?? "");
      if (!pattern) return { ok: false, output: "pattern is required" };
      const root = resolveToolPath(String(args.path ?? "."), cwd);
      let re: RegExp;
      try { re = new RegExp(pattern); } catch (e) { return { ok: false, output: `Invalid regex: ${(e as Error).message}` }; }
      const onlyGlob = args.glob ? globToRe(String(args.glob)) : null;
      const results: string[] = [];
      const stat = fs.statSync(root);
      const files: string[] = stat.isFile() ? [root] : [...grepWalk(root)];
      for (const file of files) {
        if (results.length >= MAX_GREP_RESULTS) break;
        if (onlyGlob) {
          const rel = path.relative(cwd, file).split(path.sep).join("/");
          const base = rel.split("/").pop() ?? "";
          if (!onlyGlob.test(base) && !onlyGlob.test(rel)) continue;
        }
        let buf: Buffer;
        try { buf = fs.readFileSync(file); } catch { continue; }
        if (buf.byteLength > MAX_READ_BYTES || looksBinary(buf)) continue;
        const lines = buf.toString("utf8").split("\n");
        for (let n = 0; n < lines.length && results.length < MAX_GREP_RESULTS; n++) {
          if (re.test(lines[n]!)) results.push(`${path.relative(cwd, file)}:${n + 1}: ${lines[n]!.trim().slice(0, 200)}`);
        }
      }
      return { ok: true, output: results.length ? results.join("\n") : "(no matches)" };
    }

    if (name === "clipboard") {
      const action = String(args.action ?? "read");
      const plat = process.platform;
      if (action !== "read" && action !== "write") return { ok: false, output: "Clipboard action must be read or write." };
      if (action === "write") {
        const text = String(args.text ?? "");
        if (typeof args.text !== "string") return { ok: false, output: "text is required for write" };
        const cmd = plat === "win32"
          ? "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())"
          : plat === "darwin" ? "pbcopy" : null;
        if (cmd === null) {
          // linux: try wl-copy then xclip
          for (const c of [["wl-copy"], ["xclip", "-selection", "clipboard"]]) {
            try {
              const r = spawnSync(c[0]!, c.slice(1), { input: text, encoding: "utf8", timeout: 10_000 });
              if (r.status === 0) return { ok: true, output: "Copied to clipboard." };
            } catch { /* try next */ }
          }
          return { ok: false, output: "No clipboard tool found (install xclip or wl-clipboard)." };
        }
        const r = plat === "win32"
          ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { input: text, encoding: "utf8", timeout: 10_000 })
          : spawnSync("pbcopy", [], { input: text, encoding: "utf8", timeout: 10_000 });
        return r.status === 0 ? { ok: true, output: "Copied to clipboard." } : { ok: false, output: "Clipboard write failed." };
      }
      // read
      const r = plat === "win32"
        ? spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard"], { encoding: "utf8" })
        : plat === "darwin"
          ? spawnSync("pbpaste", [], { encoding: "utf8" })
          : spawnSync("sh", ["-c", "wl-paste 2>/dev/null || xclip -selection clipboard -o 2>/dev/null"], { encoding: "utf8" });
      if (r.status !== 0) return { ok: false, output: "Clipboard read failed." };
      return { ok: true, output: clip(String(r.stdout ?? ""), 5_000) || "(clipboard empty)" };
    }

    if (name === "launch_app") {
      const target = String(args.target ?? "");
      if (!target) return { ok: false, output: "target is required" };
      const file = resolveToolPath(target, cwd);
      const exists = fs.existsSync(file);
      return await launchTarget(exists ? file : target, !exists);
    }

    if (name === "move_file") {
      const from = String(args.from ?? "");
      const to = String(args.to ?? "");
      if (!from || !to) return { ok: false, output: "from and to are required" };
      try {
        const src = resolveToolPath(from, cwd);
        const dst = resolveToolPath(to, cwd);
        if (!fs.existsSync(src)) return { ok: false, output: `${from} not found.` };
        if (fs.existsSync(dst)) return { ok: false, output: `${to} already exists; move refused to avoid overwriting it.` };
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(src, dst);
        return { ok: true, output: `Moved ${from} → ${to}.` };
      } catch (e) {
        return { ok: false, output: `Move failed: ${(e as Error).message}` };
      }
    }

    if (name === "delete_file") {
      const p2 = String(args.path ?? "");
      if (!p2) return { ok: false, output: "path is required" };
      const file = resolveToolPath(p2, cwd);
      if (!fs.existsSync(file)) return { ok: false, output: `${p2} not found.` };
      const plat = process.platform;
      if (args.permanent === true) {
        fs.rmSync(file, { recursive: true, force: false });
        return { ok: true, output: `Permanently deleted ${p2}.` };
      }
      // trash when the platform supports it
      if (plat === "win32") {
        const r = spawnSync("powershell.exe", ["-NoProfile", "-Command",
          `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${fs.statSync(file).isDirectory() ? "DeleteDirectory" : "DeleteFile"}('${file.replace(/'/g, "''")}', 'OnlyErrorDialogs', 'SendToRecycleBin')`], { encoding: "utf8" });
        if (r.status === 0) return { ok: true, output: `Sent ${p2} to the Recycle Bin.` };
      } else if (plat === "darwin") {
        const r = spawnSync("osascript", ["-e", `tell application "Finder" to delete POSIX file ${JSON.stringify(file)}`], { encoding: "utf8" });
        if (r.status === 0) return { ok: true, output: `Sent ${p2} to Trash.` };
      } else {
        const r = spawnSync("gio", ["trash", file], { encoding: "utf8" });
        if (r.status === 0) return { ok: true, output: `Sent ${p2} to trash.` };
      }
      return { ok: false, output: `Trash unavailable for ${p2}; the file was preserved. Request permanent:true only if the user wants permanent deletion.` };
    }

    if (name === "open_url") {
      const url = String(args.url ?? "");
      if (!url) return { ok: false, output: "url is required" };
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) return { ok: false, output: "open_url accepts http/https only. Use launch_app for local files." };
      return await launchTarget(parsed.href);
    }

    if (name === "web_fetch") {
      const url = String(args.url ?? "");
      if (!url) return { ok: false, output: "url is required" };
      return await webFetch(url);
    }

    if (name === "write_file") {
      const p = String(args.path ?? "");
      const content = String(args.content ?? "");
      if (!p) return { ok: false, output: "path is required" };
      if (Buffer.byteLength(content) > MAX_WRITE_BYTES) return { ok: false, output: `Content too large (${content.length} chars, limit ${MAX_WRITE_BYTES})` };
      const file = resolveToolPath(p, cwd);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return { ok: true, output: `Wrote ${content.length} chars to ${p}` };
    }

    if (name === "edit_file") {
      const p = String(args.path ?? "");
      const oldText = String(args.old_text ?? "");
      const newText = String(args.new_text ?? "");
      const replaceAll = args.replace_all === true;
      if (!p || !oldText) return { ok: false, output: "path and old_text are required" };
      const file = resolveToolPath(p, cwd);
      if (fs.statSync(file).size > MAX_EDIT_FILE_BYTES) return { ok: false, output: `File exceeds ${MAX_EDIT_FILE_BYTES} bytes; nothing written.` };
      if (Buffer.byteLength(newText) > MAX_WRITE_BYTES) return { ok: false, output: "Replacement exceeds the write limit; nothing written." };
      const src = fs.readFileSync(file, "utf8");
      // Only tolerate LF/CRLF differences, never guessed whitespace or fuzzy anchors.
      const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      let pattern = new RegExp(escape(oldText), "g");
      let count = [...src.matchAll(pattern)].length;
      if (!count && oldText.includes("\n")) {
        pattern = new RegExp(oldText.replace(/\r\n/g, "\n").split("\n").map(escape).join("\r?\n"), "g");
        count = [...src.matchAll(pattern)].length;
      }
      if (count === 0) return { ok: false, output: `old_text not found in ${p} — nothing written. Read the current lines before retrying.` };
      if (count > 1 && !replaceAll) return { ok: false, output: `old_text found ${count} times in ${p} — pass replace_all or make it more specific.` };
      const crlf = src.includes("\r\n") && !/(?<!\r)\n/.test(src);
      const replacement = crlf ? newText.replace(/\r?\n/g, "\r\n") : newText;
      // Callback keeps $&, $', $` and $$ literal in source code.
      const next = src.replace(pattern, () => replacement);
      if (Buffer.byteLength(next) > MAX_EDIT_FILE_BYTES) return { ok: false, output: `Edited content exceeds ${MAX_EDIT_FILE_BYTES} bytes; nothing written.` };
      fs.writeFileSync(file, next);
      return { ok: true, output: count > 1 && !replaceAll ? `Replaced 1 of ${count} occurrences in ${p}` : `Replaced ${replaceAll ? count : 1} occurrence${replaceAll && count > 1 ? "s" : ""} in ${p}` };
    }

    if (name === "process_status") return processStatus(String(args.job_id ?? ""));
    if (name === "stop_process") return await stopProcess(String(args.job_id ?? ""));
    if (name === "run_command") {
      const command = String(args.command ?? "");
      if (!command.trim()) return { ok: false, output: "command is required" };
      const timeoutMs = args.timeout_ms === undefined ? RUN_TIMEOUT_MS : args.timeout_ms;
      if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RUN_TIMEOUT_MS) {
        return { ok: false, output: `timeout_ms must be an integer between 1 and ${RUN_TIMEOUT_MS}.` };
      }
      const runCwd = resolveToolPath(String(args.cwd ?? cwd), cwd);
      if (!fs.statSync(runCwd).isDirectory()) return { ok: false, output: "cwd must be a directory." };
      return await runLocalCommand(command, runCwd, { background: args.background === true, timeoutMs, signal: options.signal });
    }

    return { ok: false, output: `Unknown tool: ${name}` };
  } catch (e) {
    return { ok: false, output: `Error: ${(e as Error).message}` };
  }
}
