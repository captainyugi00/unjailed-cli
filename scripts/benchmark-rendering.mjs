// Local CPU comparison; no API/network requests or customer data.
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { renderMarkdown } from "../dist/markdown.js";
import { StreamDisplayBuffer } from "../dist/ui/stream-buffer.js";

if (!process.env.BASELINE_MARKDOWN) throw new Error("Set BASELINE_MARKDOWN to the previous dist/markdown.js");
const { renderMarkdown: previous } = await import(pathToFileURL(process.env.BASELINE_MARKDOWN));
const cases = {
  openCodeFence: "```typescript\n" + Array.from({ length: 900 }, (_, i) => `export const item${i}: string = 'streamed response value ${i}';\n`).join(""),
  proseWithoutBlankLines: "This is a deliberately long paragraph with no blank-line flush boundary. ".repeat(900),
};
const receipt = { fakeLocalDataOnly: true, customerMutations: 0, colorEnabled: process.env.FORCE_COLOR ?? "unset", cases: {} };
for (const [name, source] of Object.entries(cases)) {
  const frames = 60;
  let baselineChars = 0;
  let begin = performance.now();
  for (let i = 1; i <= frames; i++) {
    const pending = source.slice(0, Math.ceil(source.length * i / frames));
    // Previous sync scanned pending for safe boundaries, then rendered all of
    // it before clipping the resulting terminal lines to the viewport.
    pending.split("\n");
    baselineChars += pending.length;
    previous(pending, { width: 100 });
  }
  const previousMs = performance.now() - begin;
  const buffer = new StreamDisplayBuffer();
  let offset = 0, previewChars = 0, previewMax = 0;
  begin = performance.now();
  for (let i = 1; i <= frames; i++) {
    const end = Math.ceil(source.length * i / frames);
    buffer.append(source.slice(offset, end));
    offset = end;
    buffer.drainSafe();
    const preview = buffer.preview();
    previewChars += preview.text.length;
    previewMax = Math.max(previewMax, preview.text.length);
    renderMarkdown(preview.text, { width: 100, highlightCode: false });
  }
  const currentMs = performance.now() - begin;
  receipt.cases[name] = { sourceChars: source.length, frames, previousMs: +previousMs.toFixed(2), currentMs: +currentMs.toFixed(2), speedup: +(previousMs / currentMs).toFixed(2), previousParsedChars: baselineChars, currentRenderedChars: previewChars, maximumLivePreviewChars: previewMax, incrementallyScannedChars: buffer.scannedCharacters };
}
const directory = new URL("../receipts/", import.meta.url);
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(new URL("rendering-benchmark.json", directory), JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify(receipt, null, 2));
