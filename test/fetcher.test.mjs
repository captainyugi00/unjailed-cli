import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { executeTool } from "../dist/tools.js";
import { stopFetcher } from "../dist/fetcher.js";

// The wreq tests need a Python with wreq installed: CI sets UNJAILED_FETCH_PYTHON.
// Nothing here installs into the real ~/.unjailed.
const PY = process.env.UNJAILED_FETCH_PYTHON;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "uj-fetch-"));
process.env.UNJAILED_HOME = home;
const wreq = { skip: PY ? false : "set UNJAILED_FETCH_PYTHON to a Python with wreq installed" };

const fetchTool = (args) => executeTool("web_fetch", args, process.cwd(), undefined, { mode: "read" });

let seen = [];
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, headers: req.headers });
  const html = (body, extra = "") => { res.writeHead(200, { "content-type": `text/html${extra}` }); res.end(body); };
  switch (req.url) {
    case "/article":
      return html(`<!doctype html><html><head><title>Guide &amp; notes</title><script>var x = "<p>nope</p>";</script><style>p{color:red}</style></head>
<body><nav class="site-nav"><a href="/home">Home</a> <a href="/about">About</a></nav>
<main><h1>Install</h1><p>Run the <code>setup</code> step, then read <a href="/docs/next">the next page</a>.</p>
<ul><li>first</li><li>second</li></ul><ol><li>one</li><li>two</li></ol>
<pre>line 1
  indented</pre>
<table><tr><th>Name</th><th>Size</th></tr><tr><td>a.txt</td><td>3</td></tr><tr><td></td><td></td></tr></table>
<p>${"Filler text. ".repeat(30)}</p></main>
<footer id="footer">Copyright</footer></body></html>`);
    case "/latin1":
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(Buffer.concat([Buffer.from('<html><head><meta charset="iso-8859-1"></head><body><p>caf'), Buffer.from([0xe9]), Buffer.from("</p></body></html>")]));
    case "/json":
      res.writeHead(200, { "content-type": "application/json" });
      return res.end('{"a":1,"b":[true,null]}');
    case "/r1":
      res.writeHead(302, { location: "/r2" });
      return res.end();
    case "/r2":
      res.writeHead(301, { location: "/json" });
      return res.end();
    case "/challenge": {
      const ua = req.headers["user-agent"] ?? "";
      if (/Chrome/.test(ua)) {
        res.writeHead(403, { "content-type": "text/html" });
        return res.end("<html><title>Just a moment...</title><body>cf-chl challenge</body></html>");
      }
      return html("<html><body><main><p>welcome, real browser</p></main></body></html>");
    }
    case "/long":
      return html(`<html><body>${Array.from({ length: 4000 }, (_, i) => `<p>row ${i} ${"x".repeat(20)}</p>`).join("")}</body></html>`);
    case "/bin":
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(Buffer.alloc(2048, 7));
    default:
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not here");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  stopFetcher();
  server.closeAllConnections();
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test("wreq: sends a real browser's headers", wreq, async () => {
  seen = [];
  const r = await fetchTool({ url: `${base}/json` });
  assert.equal(r.ok, true, r.output);
  const h = seen[0].headers;
  assert.match(h["user-agent"], /Chrome\/\d+/);
  assert.match(h["sec-ch-ua"] ?? "", /Chrom/);
  assert.ok(h["accept-language"], "accept-language sent");
  assert.match(r.output, /^HTTP 200 OK · application\/json .*chrome\d+\//);

  seen = [];
  await fetchTool({ url: `${base}/json`, browser: "firefox", headers: { Referer: "https://example.org/" } });
  assert.match(seen[0].headers["user-agent"], /Firefox\/\d+/);
  assert.equal(seen[0].headers.referer, "https://example.org/");
});

test("wreq: HTML becomes readable text with absolute links", wreq, async () => {
  const r = await fetchTool({ url: `${base}/article` });
  assert.equal(r.ok, true, r.output);
  const out = r.output;
  assert.match(out, /Title: Guide & notes/);
  assert.match(out, /^# Install$/m);
  assert.match(out, /`setup`/);
  assert.match(out, new RegExp(`\\[the next page\\]\\(${base}/docs/next\\)`));
  assert.match(out, /^- first$/m);
  assert.match(out, /^2\. two$/m);
  assert.match(out, /```\nline 1\n  indented\n```/);
  assert.match(out, /^Name \| Size$/m);
  assert.match(out, /^a\.txt \| 3$/m);
  assert.doesNotMatch(out, /nope|color:red/, "scripts and styles dropped");
  assert.doesNotMatch(out, /Copyright|About/, "page furniture dropped in text mode");
  assert.match(out, /Note: main content only/);

  const full = await fetchTool({ url: `${base}/article`, format: "full" });
  assert.match(full.output, /Copyright/);
  assert.match(full.output, /\[About\]/);

  const html = await fetchTool({ url: `${base}/article`, format: "html" });
  assert.match(html.output, /<main><h1>Install<\/h1>/);

  const links = await fetchTool({ url: `${base}/article`, format: "links" });
  assert.match(links.output, new RegExp(`^- \\[Home\\]\\(${base}/home\\)$`, "m"));
});

test("wreq: decodes declared charsets, pretty-prints JSON, reports redirects", wreq, async () => {
  const latin = await fetchTool({ url: `${base}/latin1` });
  assert.match(latin.output, /café/);
  const r = await fetchTool({ url: `${base}/r1` });
  assert.match(r.output, new RegExp(`URL: ${base}/json \\(after 2 redirects\\)`));
  assert.match(r.output, /\{\n {2}"a": 1,/);
});

test("wreq: a bot challenge is retried as another browser", wreq, async () => {
  const r = await fetchTool({ url: `${base}/challenge` });
  assert.equal(r.ok, true, r.output);
  assert.match(r.output, /welcome, real browser/);
  assert.match(r.output, /bot challenge \(HTTP 403\); retried as firefox/);
  assert.match(r.output, /firefox\d+\//);
});

test("wreq: long pages page with offset, binaries and errors are described", wreq, async () => {
  const first = await fetchTool({ url: `${base}/long`, format: "full" });
  const m = /offset: (\d+) for more/.exec(first.output);
  assert.ok(m, "first page offers an offset");
  assert.ok(first.output.length <= 28_000);
  seen = [];
  const next = await fetchTool({ url: `${base}/long`, format: "full", offset: Number(m[1]) });
  assert.equal(seen.length, 0, "the next page comes from the cache");
  assert.match(next.output, new RegExp(`chars ${m[1]}–`));
  const lastRow = /row (\d+)/.exec(first.output.slice(first.output.lastIndexOf("row ")))[1];
  assert.match(next.output, new RegExp(`row ${Number(lastRow) + 1} `), "continues where the first page stopped");

  const bin = await fetchTool({ url: `${base}/bin` });
  assert.match(bin.output, /Binary content \(application\/octet-stream, 2\.0 KB\)/);
  const missing = await fetchTool({ url: `${base}/missing` });
  assert.equal(missing.ok, false);
  assert.match(missing.output, /^HTTP 404 Not Found/);
  const refused = await fetchTool({ url: "http://127.0.0.1:9/" });
  assert.match(refused.output, /Fetch failed: connection refused/);
  const head = await fetchTool({ url: `${base}/json`, method: "HEAD" });
  assert.match(head.output, /^content-type: application\/json$/m);
});

test("bad arguments are rejected before any request", async () => {
  assert.match((await fetchTool({ url: `${base}/json`, format: "pdf" })).output, /format must be/);
  assert.match((await fetchTool({ url: `${base}/json`, method: "POST" })).output, /GET or HEAD/);
  assert.match((await fetchTool({ url: `${base}/json`, headers: { "X-A": "1\r\nX-B: 2" } })).output, /line break/);
});

test("without a usable Python, fetches fall back to Node and say so", async () => {
  stopFetcher();
  const saved = process.env.UNJAILED_FETCH_PYTHON;
  process.env.UNJAILED_FETCH_PYTHON = path.join(home, "no-such-python");
  try {
    const r = await fetchTool({ url: `${base}/article` });
    assert.equal(r.ok, true, r.output);
    assert.match(r.output, /^Engine: wreq unavailable .*used Node fetch/m);
    assert.match(r.output, /· node fetch/);
    assert.match(r.output, /Install/);
  } finally {
    if (saved === undefined) delete process.env.UNJAILED_FETCH_PYTHON;
    else process.env.UNJAILED_FETCH_PYTHON = saved;
    stopFetcher();
  }
});
