"""web_fetch engine for the unjailed CLI, built on wreq (https://github.com/0x676e67/wreq-python).

wreq is a Rust HTTP client that reproduces real browsers' TLS, HTTP/2 and
header fingerprints, so sites that turn away scripted clients (bot walls,
"please enable JavaScript" stubs served to curl-like handshakes) answer it the
way they answer Chrome or Firefox.

The CLI starts this script once and keeps it running. It reads one JSON request
per line on stdin and writes one JSON reply per line on stdout, matched by
"id", so several fetches can run at once over shared connection pools and
per-browser cookie jars.

Request:  {"id", "url", "method"?: "GET"|"HEAD", "browser"?: str,
           "headers"?: {str: str}, "format"?: "text"|"html"|"links",
           "timeout"?: seconds, "max_bytes"?: int}
Reply:    {"id", "ok", "status", "reason", "url", "version", "browser",
           "content_type", "bytes", "truncated", "redirects", "title",
           "body", "kind": "html"|"json"|"text"|"binary", "note"?}
          or {"id", "ok": false, "error", "browser"?}
"""

from __future__ import annotations

import codecs
import datetime
import json
import platform
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from html import unescape
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

import wreq
from wreq import Emulation, Platform, Profile
from wreq.blocking import Client
from wreq.redirect import Policy

DEFAULT_TIMEOUT = 20.0
DEFAULT_MAX_BYTES = 5_000_000
MAX_REDIRECTS = 10


# ── Browser profiles ─────────────────────────────────────────────────────────

def _version_key(name: str, prefix: str) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", name[len(prefix):]))


def _latest(prefix: str) -> Profile | None:
    """The newest profile of a family (Chrome154 over Chrome153), so updating
    wreq is all it takes to track new browser releases."""
    names = [n for n in dir(Profile) if n.startswith(prefix) and n[len(prefix):][:1].isdigit()]
    if not names:
        return None
    return getattr(Profile, max(names, key=lambda n: _version_key(n, prefix)))


def _host_platform() -> Platform:
    s = platform.system()
    return Platform.MacOS if s == "Darwin" else Platform.Windows if s == "Windows" else Platform.Linux


# name → (profile family, platform override). Desktop browsers claim the
# machine's own OS: a Chrome handshake with a mismatched OS is itself a tell.
FAMILIES: dict[str, tuple[str, Platform | None]] = {
    "chrome": ("Chrome", None),
    "edge": ("Edge", Platform.Windows if platform.system() == "Linux" else None),
    "firefox": ("Firefox", None),
    "safari": ("Safari", Platform.MacOS),
    "opera": ("Opera", None),
    "safari_ios": ("SafariIos", Platform.IOS),
    "chrome_android": ("Chrome", Platform.Android),
    "okhttp": ("OkHttp", Platform.Android),
}

# Tried in order when a site answers with a bot challenge.
FALLBACKS = ["chrome", "firefox", "safari"]


def resolve_browser(name: str | None) -> tuple[str, Emulation]:
    key = (name or "chrome").strip()
    low = key.lower().replace("-", "_").replace(" ", "_")
    if low in FAMILIES:
        family, plat = FAMILIES[low]
        prof = _latest(family)
        if prof is None:
            raise ValueError(f"no {family} profile in this wreq build")
        plat = plat or _host_platform()
        return f"{prof}/{plat}".replace("Profile.", "").replace("Platform.", "").lower(), Emulation(prof, plat)
    # An exact profile name, e.g. "Firefox152" or "Safari18_5".
    exact = next((n for n in dir(Profile) if n.lower() == low), None)
    if exact is None:
        raise ValueError(f"unknown browser {key!r}; use one of {', '.join(FAMILIES)} or an exact wreq profile like Chrome154")
    prof = getattr(Profile, exact)
    plat = Platform.IOS if exact.startswith(("SafariIos", "SafariIPad", "SafariIpad")) else Platform.MacOS if exact.startswith("Safari") else _host_platform()
    return f"{exact}/{plat}".replace("Platform.", "").lower(), Emulation(prof, plat)


_clients: dict[str, Client] = {}
_clients_lock = threading.Lock()


def client_for(label: str, emulation: Emulation) -> Client:
    """One client per browser profile: its own cookie jar and connection pool,
    reused across calls the way a browser session would be."""
    with _clients_lock:
        c = _clients.get(label)
        if c is None:
            c = Client(
                emulation=emulation,
                cookie_store=True,
                redirect=Policy.limited(MAX_REDIRECTS),
                gzip=True,
                brotli=True,
                deflate=True,
                zstd=True,
                connect_timeout=datetime.timedelta(seconds=10),
            )
            _clients[label] = c
        return c


# ── Body decoding ────────────────────────────────────────────────────────────

_META_CHARSET = re.compile(rb"""<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_\-:.]+)""", re.I)


def _charset_from_type(content_type: str) -> str | None:
    m = re.search(r"charset\s*=\s*\"?([A-Za-z0-9_\-:.]+)", content_type, re.I)
    return m.group(1) if m else None


def _valid_codec(name: str | None) -> str | None:
    if not name:
        return None
    try:
        return codecs.lookup(name).name
    except LookupError:
        return None


def decode(body: bytes, content_type: str) -> str:
    if body.startswith(codecs.BOM_UTF8):
        return body[3:].decode("utf-8", "replace")
    if body.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        return body.decode("utf-16", "replace")
    enc = _valid_codec(_charset_from_type(content_type))
    if not enc and "html" in content_type or not enc and body[:1] == b"<":
        m = _META_CHARSET.search(body[:4096])
        enc = _valid_codec(m.group(1).decode("ascii", "ignore")) if m else None
    if enc:
        return body.decode(enc, "replace")
    try:
        return body.decode("utf-8")
    except UnicodeDecodeError:
        # Pre-UTF-8 pages without a declared charset are almost always Windows-1252.
        return body.decode("cp1252", "replace")


def kind_of(content_type: str, body: bytes) -> str:
    ct = content_type.split(";")[0].strip().lower()
    if "html" in ct or "xhtml" in ct:
        return "html"
    if ct.endswith("json") or ct.endswith("+json"):
        return "json"
    if ct.startswith("text/") or ct.endswith(("xml", "javascript", "ecmascript", "csv", "yaml", "x-sh")) or ct in ("", "application/x-www-form-urlencoded"):
        head = body[:1024].lstrip().lower()
        if not ct and (head.startswith(b"<!doctype html") or head.startswith(b"<html")):
            return "html"
        return "binary" if not ct and b"\x00" in body[:1024] else "text"
    return "binary"


# ── HTML → readable text ─────────────────────────────────────────────────────

SKIP = {"script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "head", "select", "math"}
BLOCK = {
    "p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "form", "fieldset",
    "ul", "ol", "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "tr", "blockquote", "figure",
    "figcaption", "details", "summary", "address", "hr", "body", "html", "caption", "center", "label",
}
# Page furniture dropped from the default "text" view (kept with format "full").
CHROME_TAGS = {"nav", "aside", "footer", "button", "dialog", "form"}
CHROME_ATTR = re.compile(
    r"(^|[\s_-])(nav|navbar|navigation|menu|dropdown|sidebar|breadcrumbs?|cookie|consent|banner|"
    r"toc|footer|share|social|advert|ads?|promo|newsletter|subscribe|popup|modal|skip-link|"
    r"langlinks|interlanguage|lang-list|related-links)($|[\s_-])",
    re.I,
)
STRUCTURAL = {"html", "body", "main", "article"}
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}


class Extractor(HTMLParser):
    """Turns a page into Markdown-flavored text a model can read: headings,
    lists, links with absolute URLs, code blocks and table rows survive;
    scripts, styles and markup do not."""

    def __init__(self, base: str, clean: bool = True):
        super().__init__(convert_charrefs=True)
        self.base = base
        self.clean = clean
        self.out: list[str] = []
        # While skipping a subtree: the tag that opened it and how deep we are in it.
        self.skip_tag: str | None = None
        self.skip_depth = 0
        self.pre = 0
        self.title: list[str] = []
        self.in_title = False
        self.links: list[tuple[str, str]] = []
        self._link: list[tuple[str | None, int]] = []  # (href, index in out where its text starts)
        self.lists: list[list] = []  # [kind, counter]
        self.cell = 0
        self.cell_start: int | None = None
        # The page's main region (<main>, role=main, else the first <article>):
        # [tag, depth, start index, end index]
        self.region: dict[str, list] = {}

    def _open_region(self, kind: str, tag: str) -> None:
        if kind not in self.region:
            self.region[kind] = [tag, 0, len(self.out), None]

    def _track(self, tag: str, opening: bool) -> None:
        for r in self.region.values():
            if r[3] is None and r[0] == tag:
                r[1] += 1 if opening else -1
                if r[1] == 0:
                    r[3] = len(self.out)

    def _skippable(self, tag: str, a: dict) -> bool:
        if tag in SKIP or "hidden" in a or a.get("aria-hidden") == "true":
            return True
        if not self.clean or tag in STRUCTURAL or a.get("role") == "main":
            return False
        if tag in CHROME_TAGS or a.get("role") in ("navigation", "banner", "contentinfo", "complementary", "menu", "dialog"):
            return True
        return bool(CHROME_ATTR.search(f"{a.get('class') or ''} {a.get('id') or ''}"))

    # helpers
    def _nl(self, n: int = 1) -> None:
        if not self.out:
            return
        tail = "".join(self.out[-4:]).rstrip(" ")
        have = len(tail) - len(tail.rstrip("\n"))
        if have < n:
            self.out.append("\n" * (n - have))

    def _abs(self, href: str | None) -> str | None:
        if not href:
            return None
        href = href.strip()
        if href.startswith(("javascript:", "mailto:", "tel:", "data:", "#")):
            return href if href.startswith(("mailto:", "tel:")) else None
        try:
            return urljoin(self.base, href)
        except ValueError:
            return None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = dict(attrs)
        if tag == "title" and not self.title:
            self.in_title = True
            return
        if self.skip_tag:
            if tag == self.skip_tag:
                self.skip_depth += 1
            return
        if tag not in VOID and self._skippable(tag, a):
            self.skip_tag, self.skip_depth = tag, 1
            return
        if tag == "main" or a.get("role") == "main":
            self._open_region("main", tag)
        elif tag == "article":
            self._open_region("article", tag)
        if tag not in VOID:
            self._track(tag, True)
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._nl(2)
            self.out.append("#" * int(tag[1]) + " ")
        elif tag == "pre":
            self._nl(2)
            self.out.append("```\n")
            self.pre += 1
        elif tag == "code" and not self.pre:
            self.out.append("`")
        elif tag in ("ul", "ol"):
            self.lists.append([tag, 0])
            self._nl()
        elif tag == "li":
            self._nl()
            depth = max(0, len(self.lists) - 1)
            if self.lists and self.lists[-1][0] == "ol":
                self.lists[-1][1] += 1
                self.out.append("  " * depth + f"{self.lists[-1][1]}. ")
            else:
                self.out.append("  " * depth + "- ")
        elif tag == "br":
            self.out.append("\n")
        elif tag == "hr":
            self._nl(2)
            self.out.append("---")
            self._nl(2)
        elif tag in ("td", "th"):
            # Cells are joined with " | "; empty layout cells leave no trace.
            self.cell_start = len(self.out)
            if self.cell:
                self.out.append(" | ")
        elif tag == "tr":
            self._nl()
            self.cell = 0
        elif tag in ("strong", "b"):
            self.out.append("**")
        elif tag in ("em", "i") and not self.pre:
            self.out.append("_")
        elif tag == "a":
            self._link.append((self._abs(a.get("href")), len(self.out)))
        elif tag == "img":
            alt = (a.get("alt") or "").strip()
            if alt and not self._link:
                self.out.append(f"[image: {alt}]")
        elif tag in BLOCK or tag == "p":
            self._nl(2 if tag in ("p", "blockquote", "table", "section", "article") else 1)
            if tag == "blockquote":
                self.out.append("> ")

    def handle_endtag(self, tag: str) -> None:
        if tag == "title" and self.in_title:
            self.in_title = False
            return
        if self.skip_tag:
            if tag == self.skip_tag:
                self.skip_depth -= 1
                if self.skip_depth == 0:
                    self.skip_tag = None
            return
        self._end(tag)
        self._track(tag, False)

    def _end(self, tag: str) -> None:
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._nl(2)
        elif tag == "pre" and self.pre:
            self.pre -= 1
            self._nl()
            self.out.append("```")
            self._nl(2)
        elif tag == "code" and not self.pre:
            self.out.append("`")
        elif tag in ("ul", "ol"):
            if self.lists:
                self.lists.pop()
            self._nl()
        elif tag in ("strong", "b"):
            self.out.append("**")
        elif tag in ("em", "i") and not self.pre:
            self.out.append("_")
        elif tag in ("td", "th"):
            start = getattr(self, "cell_start", None)
            if start is not None and start <= len(self.out):
                if "".join(self.out[start:]).strip(" |\n"):
                    self.cell += 1
                else:
                    del self.out[start:]
            self.cell_start = None
        elif tag == "tr":
            self.cell = 0
            self._nl()
        elif tag == "a" and self._link:
            href, start = self._link.pop()
            text = re.sub(r"\s+", " ", "".join(self.out[start:])).strip()
            if href and text:
                del self.out[start:]
                # A heading inside a link renders as "## [title](url)".
                m = re.match(r"^(#{1,6} )", text)
                lead, text = (m.group(1), text[len(m.group(1)):]) if m else ("", text)
                prev = "".join(self.out[-2:])
                gap = " " if prev and prev[-1] in ")*" else ""  # [a](x)[b](y) → [a](x) [b](y)
                self.out.append(gap + lead + (f"[{text}]({href})" if text != href else href))
                self.links.append((text, href))
            elif href:
                self.links.append(("", href))
        elif tag in BLOCK or tag == "p":
            self._nl(2 if tag in ("p", "blockquote", "table", "section", "article") else 1)

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title.append(data)
            return
        if self.skip_tag:
            return
        if self.pre:
            self.out.append(data)
            return
        text = re.sub(r"\s+", " ", data)
        if text.strip() or (self.out and not self.out[-1].endswith((" ", "\n"))):
            self.out.append(text)

    def main_text(self) -> str | None:
        """Just the main content, when the page marks it and it has substance."""
        for kind in ("main", "article"):
            r = self.region.get(kind)
            if r:
                part = self.tidy("".join(self.out[r[2]:r[3]]))
                if len(part) >= 200:
                    return part
        return None

    def text(self) -> str:
        return self.tidy("".join(self.out))

    @staticmethod
    def tidy(raw: str) -> str:
        # Tidy: trim each line outside code fences, collapse blank runs.
        lines, fenced = [], False
        for line in raw.split("\n"):
            if line.startswith("```"):
                fenced = not fenced
                lines.append(line)
                continue
            lines.append(line if fenced else re.sub(r" {2,}", " ", line).strip() if not re.match(r"^\s+(- |\d+\. )", line) else line.rstrip())
        out = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
        out = re.sub(r"\*\*\s*\*\*", "", out)
        return out


def extract(html: str, base: str, clean: bool = True) -> Extractor:
    p = Extractor(base, clean)
    try:
        p.feed(html)
        p.close()
    except Exception:  # malformed markup: keep what was parsed
        pass
    return p


# ── Fetching ─────────────────────────────────────────────────────────────────

CHALLENGE = re.compile(
    rb"cf-chl|challenge-platform|Just a moment\.\.\.|cf_chl_opt|_Incapsula_Resource|"
    rb"px-captcha|Pardon Our Interruption|ddos-guard|perimeterx|datadome",
    re.I,
)


def _header(headers, name: str) -> str:
    try:
        v = headers.get(name)
    except Exception:
        return ""
    if v is None:
        return ""
    return bytes(v).decode("latin-1") if isinstance(v, (bytes, memoryview, bytearray)) else str(v)


def _headers(headers) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        for k in headers.keys():
            name = bytes(k).decode("latin-1") if not isinstance(k, str) else k
            vals = headers.get_all(name)
            out[name] = ", ".join(bytes(v).decode("latin-1") if not isinstance(v, str) else v for v in vals)
    except Exception:
        pass
    return out


def _status(resp) -> tuple[int, str]:
    s = resp.status
    code = s.as_int() if hasattr(s, "as_int") else int(s)
    try:
        from http import HTTPStatus
        reason = HTTPStatus(code).phrase
    except ValueError:
        reason = ""
    return code, reason


def fetch_once(req: dict, browser: str | None) -> dict:
    label, emulation = resolve_browser(browser)
    client = client_for(label, emulation)
    method = (req.get("method") or "GET").upper()
    if method not in ("GET", "HEAD"):
        raise ValueError("only GET and HEAD are supported")
    timeout = float(req.get("timeout") or DEFAULT_TIMEOUT)
    max_bytes = int(req.get("max_bytes") or DEFAULT_MAX_BYTES)
    headers = {str(k): str(v) for k, v in (req.get("headers") or {}).items()}
    kwargs = {"timeout": datetime.timedelta(seconds=timeout)}
    if headers:
        kwargs["headers"] = headers
    resp = client.head(req["url"], **kwargs) if method == "HEAD" else client.get(req["url"], **kwargs)
    with resp:
        code, reason = _status(resp)
        ctype = _header(resp.headers, "content-type")
        body = bytearray()
        truncated = False
        if method == "GET":
            with resp.stream() as stream:
                for chunk in stream:
                    if not isinstance(chunk, memoryview):
                        continue  # trailers
                    body += chunk
                    if len(body) > max_bytes:
                        del body[max_bytes:]
                        truncated = True
                        break
        history = getattr(resp, "history", None) or []
        return {
            "status": code,
            "reason": reason,
            "url": str(resp.url),
            "version": str(resp.version).replace("Version.", ""),
            "browser": label,
            "content_type": ctype,
            "headers": _headers(resp.headers),
            "redirects": len(history),
            "truncated": truncated,
            "_body": bytes(body),
        }


def render(r: dict, fmt: str) -> dict:
    body: bytes = r.pop("_body")
    r["bytes"] = len(body)
    kind = kind_of(r["content_type"], body)
    r["kind"] = kind
    r["title"] = ""
    if kind == "binary":
        r["body"] = ""
        return r
    text = decode(body, r["content_type"])
    if kind == "html" and fmt != "html":
        page = extract(text, r["url"], clean=fmt == "text")
        r["title"] = re.sub(r"\s+", " ", unescape("".join(page.title))).strip()
        if fmt == "links":
            seen, rows = set(), []
            for label, href in page.links:
                if href in seen:
                    continue
                seen.add(href)
                rows.append(f"- [{label}]({href})" if label else f"- {href}")
            r["body"] = "\n".join(rows)
        else:
            main = page.main_text() if fmt == "text" else None
            r["body"] = main or page.text()
            if main:
                r["note"] = "main content only (format \"full\" for the whole page)"
    elif kind == "json" and fmt != "html":
        try:
            r["body"] = json.dumps(json.loads(text), indent=2, ensure_ascii=False)
        except ValueError:
            r["body"] = text
    else:
        r["body"] = text
    return r


def handle(req: dict) -> dict:
    url = str(req.get("url") or "")
    if urlsplit(url).scheme not in ("http", "https"):
        return {"ok": False, "error": "only http and https URLs are supported"}
    fmt = req.get("format") or "text"
    asked = req.get("browser")
    order = [asked] if asked else FALLBACKS
    note = None
    last = None
    for i, browser in enumerate(order):
        attempt = 0
        while True:
            try:
                r = fetch_once(req, browser)
                break
            except (wreq.ConnectionResetError, wreq.ConnectionError) as e:
                # One quick retry for a dropped connection, as a browser would.
                attempt += 1
                if attempt > 1:
                    raise
                last = e
        blocked = r["status"] in (403, 429, 503) and CHALLENGE.search(r["_body"][:200_000] or b"")
        if blocked and i + 1 < len(order):
            note = f"{r['browser']} got a bot challenge (HTTP {r['status']}); retried as {order[i + 1]}"
            continue
        if blocked:
            note = (note + "; " if note else "") + "the site answered with a bot-protection challenge that needs a real browser with JavaScript"
        r = render(r, fmt)
        r["ok"] = 200 <= r["status"] < 400
        if note:
            r["note"] = note + ("; " + r["note"] if r.get("note") else "")
        return r
    raise RuntimeError(str(last) if last else "fetch failed")


# ── JSON-lines loop ──────────────────────────────────────────────────────────

_write_lock = threading.Lock()


def describe(e: Exception, req: dict) -> str:
    """wreq errors carry the whole Rust error chain; keep the part that says what went wrong."""
    name = type(e).__name__
    msg = str(e) or name
    low = msg.lower()
    host = urlsplit(str(req.get("url") or "")).hostname or "the host"
    if "Timeout" in name or "timed out" in low:
        return f"timed out after {float(req.get('timeout') or DEFAULT_TIMEOUT):g}s"
    if "dns error" in low or "noRecordsFound".lower() in low or "failed to lookup" in low:
        return f"could not resolve {host} (DNS lookup failed)"
    if "connection refused" in low:
        return f"connection refused by {host}"
    if "certificate verify failed" in low or "certificate_verify_failed" in low or "self-signed" in low or "self signed" in low:
        return f"TLS certificate of {host} is not trusted (expired, self-signed or wrong host)"
    if "tls" in name.lower() or "ssl" in low or "handshake" in low:
        return f"TLS handshake with {host} failed"
    if "redirect" in name.lower() or "too many redirects" in low:
        return f"too many redirects (limit {MAX_REDIRECTS})"
    if "connection reset" in low or "ConnectionReset" in name:
        return f"connection reset by {host}"
    return f"{name}: {msg[:300]}"


def reply(obj: dict) -> None:
    line = json.dumps(obj, ensure_ascii=False)
    with _write_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def serve_one(line: str) -> None:
    try:
        req = json.loads(line)
    except ValueError:
        return
    rid = req.get("id")
    try:
        out = handle(req)
    except Exception as e:  # every failure goes back to the caller, never kills the loop
        out = {"ok": False, "error": describe(e, req)}
    out["id"] = rid
    reply(out)


def main() -> None:
    if "--version" in sys.argv:
        print(json.dumps({"wreq": getattr(wreq, "__version__", "?"), "chrome": str(_latest("Chrome")), "python": platform.python_version()}))
        return
    reply({"ready": True})
    pool = ThreadPoolExecutor(max_workers=8)
    for line in sys.stdin:
        if line.strip():
            pool.submit(serve_one, line)
    pool.shutdown(wait=True)


if __name__ == "__main__":
    main()
