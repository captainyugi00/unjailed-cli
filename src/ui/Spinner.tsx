import React, { useEffect, useState } from "react";
import { Text } from "ink";
import { theme } from "../theme.js";

/**
 * The live status line while the model works. Instead of a single opaque
 * "Thinking…", it tells the user WHAT is happening right now — a coding pass,
 * a shell command, reading files — with elapsed time. States:
 *
 *   idle      → pulsing dots (waiting for first token)
 *   reasoning → "Reasoning" with a brain pulse
 *   coding    → writing/editing files (brackets animation)
 *   command   → shell command running (prompt animation)
 *   reading   → reading files / searching
 *   browsing  → fetching a URL
 *   streaming → tokens landing (bytes counter)
 */

export type WorkKind = "idle" | "reasoning" | "streaming" | "coding" | "command" | "reading" | "browsing";

const SPIN_FRAMES   = ["|", "/", "-", "\\"]; // classic rotating spinner
const CODE_FRAMES   = ["[ ]", "{ }", "[_]", "{~}"];
const CMD_FRAMES    = [">", ">>", ">>>", ">>", ">"];
const READ_FRAMES   = ["◂", "◄", "◀", "◄"];
const WEB_FRAMES    = ["⇄", "↻", "⟳", "↻"];
const STREAM_FRAMES = ["▁", "▃", "▅", "▆", "▅", "▃"];

const META: Record<WorkKind, { frames: string[]; verb: string }> = {
  idle:      { frames: SPIN_FRAMES,   verb: "Thinking" },
  reasoning: { frames: SPIN_FRAMES,   verb: "Reasoning" },
  streaming: { frames: STREAM_FRAMES, verb: "Writing" },
  coding:    { frames: CODE_FRAMES,   verb: "Writing code" },
  command:   { frames: CMD_FRAMES,    verb: "Running command" },
  reading:   { frames: READ_FRAMES,   verb: "Reading files" },
  browsing:  { frames: WEB_FRAMES,    verb: "Fetching page" },
};

export function Spinner({ label, kind = "idle", detail }: { label?: string; kind?: WorkKind; detail?: string }) {
  const [i, setI] = useState(0);
  const [start] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => {
      setI((n) => n + 1);
    }, 250);
    return () => clearInterval(t);
  }, []);
  const meta = META[kind];
  const secs = Math.floor((Date.now() - start) / 1000);
  const timeStr = secs >= 60 ? `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}` : `${secs}s`;
  // blink the elapsed counter every ~half second so the line feels alive even between frames
  const showTime = i % 10 !== 9 || secs === 0;
  const frame = meta.frames[i % meta.frames.length]!;
  const frameStr = theme.brand(frame);
  const verb = label ?? meta.verb;
  const tail = showTime ? `${timeStr} · Ctrl+C to stop` : `${timeStr}  · Ctrl+C to stop`;
  return (
    <Text wrap="truncate-end">
      {frameStr} {theme.bold(verb)}
      {detail ? theme.dim(` · ${detail.length > 48 ? detail.slice(0, 48) + "…" : detail}`) : ""}
      {theme.dim(` · ${tail}`)}
    </Text>
  );
}
