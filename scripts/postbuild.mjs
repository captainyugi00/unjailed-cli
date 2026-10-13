// Make the CLI entry executable and ensure it has a shebang (tsc keeps it, this is a guard).
import fs from "node:fs";
const entry = new URL("../dist/index.js", import.meta.url);
let src = fs.readFileSync(entry, "utf8");
if (!src.startsWith("#!")) src = "#!/usr/bin/env node\n" + src;
fs.writeFileSync(entry, src);
if (process.platform !== "win32") fs.chmodSync(entry, 0o755);

// web_fetch's wreq helper is plain Python; ship it next to the compiled JS.
fs.copyFileSync(new URL("../src/fetcher.py", import.meta.url), new URL("../dist/fetcher.py", import.meta.url));
