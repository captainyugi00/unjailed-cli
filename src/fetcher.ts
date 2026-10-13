import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { configDir } from "./config.js";

/**
 * web_fetch engine. Requests go through wreq (github.com/0x676e67/wreq-python),
 * a Rust HTTP client that reproduces real browsers' TLS, HTTP/2 and header
 * fingerprints, so sites that turn away scripted clients answer it like Chrome.
 *
 * wreq is a Python package, so the CLI keeps a private virtualenv in
 * ~/.unjailed/fetcher (made on the first fetch, with uv when present, else
 * python3 -m venv + pip) and runs src/fetcher.py there as one long-lived
 * helper speaking JSON lines: connection pools and cookies carry over between
 * fetches the way they would in a browser tab.
 *
 * With no Python 3.11+ (or UNJAILED_FETCH_ENGINE=node) fetches fall back to
 * Node's fetch with browser headers, and the result says so.
 */

export const WREQ_VERSION = "0.13.0";
const HELPER = fileURLToPath(new URL("./fetcher.py", import.meta.url));
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const READY_TIMEOUT_MS = 20_000;
const RETRY_SETUP_MS = 10 * 60_000;

export type FetchFormat = "text" | "full" | "html" | "links";

export interface FetchRequest {
  url: string;
  method?: "GET" | "HEAD";
  browser?: string;
  headers?: Record<string, string>;
  format?: FetchFormat;
  timeoutSec?: number;
  maxBytes?: number;
}

export interface FetchReply {
  ok: boolean;
  engine: "wreq" | "node";
  status?: number;
  reason?: string;
  url?: string;
  version?: string;
  browser?: string;
  content_type?: string;
  headers?: Record<string, string>;
  bytes?: number;
  truncated?: boolean;
  redirects?: number;
  title?: string;
  body?: string;
  kind?: "html" | "json" | "text" | "binary";
  note?: string;
  error?: string;
  /** Set when this call set up the engine or fell back from it. */
  setup?: string;
}

// ── Private Python environment ───────────────────────────────────────────────

const fetcherDir = () => path.join(configDir(), "fetcher");
const venvDir = () => path.join(fetcherDir(), "venv");
const markerFile = () => path.join(fetcherDir(), "installed.json");
const venvPython = (dir: string) =>
  process.platform === "win32" ? path.join(dir, "Scripts", "python.exe") : path.join(dir, "bin", "python");

function run(cmd: string, args: string[], timeoutMs = INSTALL_TIMEOUT_MS): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_NO_INPUT: "1" } });
    } catch (e) {
      resolve({ code: null, out: (e as Error).message });
      return;
    }
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", (e) => { clearTimeout(t); resolve({ code: null, out: e.message }); });
    child.on("close", (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

/** A system Python new enough for wreq (3.11+), or null. */
function findPython(): string | null {
  const names = process.platform === "win32"
    ? ["python", "python3", "py"]
    : ["python3.14", "python3.13", "python3.12", "python3.11", "python3", "python"];
  for (const name of names) {
    const r = spawnSync(name, ["-c", "import sys, venv; print(sys.version_info >= (3, 11))"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    if (r.status === 0 && r.stdout.trim() === "True") return name;
  }
  return null;
}

function hasUv(): boolean {
  return spawnSync("uv", ["--version"], { windowsHide: true, timeout: 10_000 }).status === 0;
}

function installed(): string | null {
  try {
    const m = JSON.parse(fs.readFileSync(markerFile(), "utf8"));
    const py = venvPython(venvDir());
    if (m?.wreq === WREQ_VERSION && fs.existsSync(py)) return py;
  } catch {
    /* not installed yet */
  }
  return null;
}

/** Build the virtualenv in a temp folder, then move it into place, so an
 *  interrupted install never leaves a half-made environment behind. */
async function install(): Promise<{ python: string } | { error: string }> {
  fs.mkdirSync(fetcherDir(), { recursive: true, mode: 0o700 });
  const tmp = fs.mkdtempSync(path.join(fetcherDir(), "venv-"));
  const fail = (error: string) => {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { error };
  };
  const pkg = `wreq==${WREQ_VERSION}`;
  const tail = (s: string) => s.trim().split("\n").slice(-3).join(" ").slice(0, 300);
  const system = findPython();
  if (!system && hasUv()) {
    // uv can fetch a suitable Python itself.
    let r = await run("uv", ["venv", "--quiet", "--python", ">=3.11", tmp]);
    if (r.code !== 0) return fail(`uv venv failed: ${tail(r.out)}`);
    r = await run("uv", ["pip", "install", "--quiet", "--python", venvPython(tmp), pkg]);
    if (r.code !== 0) return fail(`installing ${pkg} failed: ${tail(r.out)}`);
  } else if (system) {
    let r = await run(system, ["-m", "venv", tmp]);
    if (r.code !== 0) return fail(`python -m venv failed: ${tail(r.out)}`);
    r = await run(venvPython(tmp), ["-m", "pip", "install", "--quiet", pkg]);
    if (r.code !== 0) return fail(`installing ${pkg} failed: ${tail(r.out)}`);
  } else {
    return fail("needs Python 3.11+ (or uv) on PATH");
  }
  fs.rmSync(venvDir(), { recursive: true, force: true });
  fs.renameSync(tmp, venvDir());
  fs.writeFileSync(markerFile(), JSON.stringify({ wreq: WREQ_VERSION, at: new Date().toISOString() }) + "\n", { mode: 0o600 });
  return { python: venvPython(venvDir()) };
}

// ── The helper process ───────────────────────────────────────────────────────

interface Pending {
  resolve: (r: FetchReply) => void;
  timer: NodeJS.Timeout;
}

class Helper {
  private child: ChildProcess;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  dead = false;
  ready: Promise<void>;

  constructor(python: string) {
    this.child = spawn(python, ["-I", HELPER], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
    });
    let stderr = "";
    this.child.stderr?.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    const lines = readline.createInterface({ input: this.child.stdout! });
    this.ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("the fetch helper did not start")), READY_TIMEOUT_MS);
      lines.on("line", (line) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.ready) { clearTimeout(t); resolve(); return; }
        const p = this.pending.get(msg.id as number);
        if (!p) return;
        this.pending.delete(msg.id as number);
        clearTimeout(p.timer);
        delete msg.id;
        p.resolve({ ...(msg as unknown as FetchReply), engine: "wreq" });
        this.idle();
      });
      this.child.on("error", (e) => { clearTimeout(t); this.die(e.message); reject(e); });
      this.child.on("exit", (code) => {
        clearTimeout(t);
        const why = stderr.trim().split("\n").slice(-1)[0] || `exited with code ${code}`;
        this.die(why);
        reject(new Error(why));
      });
    });
    this.ready.catch(() => {});
    this.idle();
  }

  /** Don't hold the CLI open while nothing is in flight. */
  private idle(): void {
    const handles = [this.child, this.child.stdin, this.child.stdout, this.child.stderr] as Array<{ ref?: () => void; unref?: () => void } | null>;
    for (const h of handles) (this.pending.size ? h?.ref : h?.unref)?.call(h);
  }

  private die(why: string): void {
    if (this.dead) return;
    this.dead = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, engine: "wreq", error: `fetch helper stopped: ${why}` });
    }
    this.pending.clear();
  }

  request(req: FetchRequest, signal?: AbortSignal): Promise<FetchReply> {
    return new Promise((resolve) => {
      if (this.dead) return resolve({ ok: false, engine: "wreq", error: "fetch helper is not running" });
      const id = this.nextId++;
      const finish = (r: FetchReply) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        this.idle();
        resolve(r);
      };
      // The helper enforces the request timeout; this is the backstop.
      const timer = setTimeout(() => finish({ ok: false, engine: "wreq", error: `timed out after ${req.timeoutSec ?? 20}s` }), ((req.timeoutSec ?? 20) + 15) * 1000);
      this.pending.set(id, { resolve, timer });
      signal?.addEventListener("abort", () => finish({ ok: false, engine: "wreq", error: "cancelled" }), { once: true });
      this.idle();
      this.child.stdin!.write(JSON.stringify({ id, url: req.url, method: req.method, browser: req.browser, headers: req.headers, format: req.format, timeout: req.timeoutSec, max_bytes: req.maxBytes }) + "\n");
    });
  }

  stop(): void {
    this.die("stopped");
    this.child.kill();
  }
}

let helper: Helper | null = null;
let starting: Promise<{ helper: Helper; setup?: string } | { error: string }> | null = null;
let failure: { error: string; at: number } | null = null;

process.once("exit", () => helper?.stop());

async function startHelper(): Promise<{ helper: Helper; setup?: string } | { error: string }> {
  const forced = process.env.UNJAILED_FETCH_PYTHON;
  let python = forced || installed();
  let setup: string | undefined;
  if (!python) {
    const t0 = Date.now();
    let r: Awaited<ReturnType<typeof install>>;
    try {
      r = await install();
    } catch (e) {
      // e.g. another unjailed process finishing the same install first
      r = installed() ? { python: installed()! } : { error: `setup failed: ${(e as Error).message}` };
    }
    if ("error" in r) return r;
    python = r.python;
    setup = `installed wreq ${WREQ_VERSION} (one-time setup, ${Math.round((Date.now() - t0) / 1000)}s, in ${fetcherDir()})`;
  }
  const h = new Helper(python);
  try {
    await h.ready;
  } catch (e) {
    h.stop();
    return { error: `wreq helper failed to start: ${(e as Error).message}` };
  }
  return { helper: h, setup };
}

/** The running helper, starting (and on first use installing) it. */
async function getHelper(): Promise<{ helper: Helper; setup?: string } | { error: string }> {
  if (helper && !helper.dead) return { helper };
  if (failure && Date.now() - failure.at < RETRY_SETUP_MS) return { error: failure.error };
  starting ??= startHelper().catch((e: Error) => ({ error: e.message })).then((r) => {
    starting = null;
    if ("error" in r) failure = { error: r.error, at: Date.now() };
    else { helper = r.helper; failure = null; }
    return r;
  });
  return starting;
}

/** Stop the helper (tests, and switching engines). */
export function stopFetcher(): void {
  helper?.stop();
  helper = null;
  failure = null;
}

// ── Node fallback ────────────────────────────────────────────────────────────

const BROWSER_HEADERS = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|pre|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function nodeFetch(req: FetchRequest, signal?: AbortSignal): Promise<FetchReply> {
  const timeout = AbortSignal.timeout((req.timeoutSec ?? 20) * 1000);
  try {
    const res = await fetch(req.url, {
      method: req.method ?? "GET",
      redirect: "follow",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { ...BROWSER_HEADERS, ...req.headers },
    });
    const type = res.headers.get("content-type") ?? "";
    const max = req.maxBytes ?? 5_000_000;
    const buf = Buffer.from(await res.arrayBuffer());
    const kind = /html/i.test(type) ? "html" : /json/i.test(type) ? "json" : /^text\/|xml|javascript/i.test(type) || !type ? "text" : "binary";
    let body = kind === "binary" ? "" : buf.subarray(0, max).toString("utf8");
    let title = "";
    if (kind === "html" && req.format !== "html") {
      title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim() ?? "";
      body = htmlToText(body);
    }
    return {
      ok: res.ok, engine: "node", status: res.status, reason: res.statusText, url: res.url, content_type: type,
      headers: Object.fromEntries(res.headers), bytes: buf.byteLength, truncated: buf.byteLength > max,
      redirects: res.redirected ? 1 : 0, title, body, kind,
    };
  } catch (e) {
    const err = e as Error;
    const msg = err.name === "TimeoutError" ? `timed out after ${req.timeoutSec ?? 20}s` : err.name === "AbortError" ? "cancelled" : ((err.cause as Error)?.message ?? err.message);
    return { ok: false, engine: "node", error: msg };
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

/** Fetch through wreq, or Node's fetch when wreq can't run. Never throws. */
export async function fetchPage(req: FetchRequest, signal?: AbortSignal): Promise<FetchReply> {
  if (process.env.UNJAILED_FETCH_ENGINE === "node") return nodeFetch(req, signal);
  const h = await getHelper();
  if ("error" in h) {
    const r = await nodeFetch(req, signal);
    return { ...r, setup: `wreq unavailable (${h.error}); used Node fetch without browser fingerprints` };
  }
  const r = await h.helper.request(req, signal);
  return h.setup ? { ...r, setup: h.setup } : r;
}
