import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";
import { colorLevel, theme, tone } from "../theme.js";
import { formatCost, type Price } from "../pricing.js";
import { formatTokens, type SessionStats } from "./ActivityBar.js";

/**
 * /usage: a live dashboard of what the CLI has spent, from the usage the API
 * reports on every request priced at the catalog rates. It stays open while
 * you keep typing and while the agent works (it never blocks input); bars
 * grow in when it opens and the numbers keep moving as requests complete.
 */

export interface PeriodSpend {
  label: string;
  cost: number;
  chats: number;
  /** Chats saved before costs were tracked: their spend is unknown. */
  unpriced: number;
}

export interface UsageView {
  session: SessionStats;
  /** Cost of the turn that is running now, if any. */
  turnCost?: number;
  running: boolean;
  model: string;
  price?: Price;
  prices: "loading" | "live" | "cached" | "unknown";
  source: string;
  periods: PeriodSpend[];
}

const BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const SPIN = colorLevel === 0 ? ["-", "\\", "|", "/"] : ["◐", "◓", "◑", "◒"];

const ease = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** A bar of `cells` columns filled to `fraction`, with eighth-block precision. */
export function bar(fraction: number, cells: number, paint: (s: string) => string): string {
  const f = Math.min(1, Math.max(0, fraction)) * cells;
  const full = Math.floor(f);
  const part = BLOCKS[Math.round((f - full) * 8)] ?? "";
  const filled = "█".repeat(full) + (full < cells ? part : "");
  return paint(filled) + theme.dim("·".repeat(Math.max(0, cells - stringWidth(filled))));
}

/** A bar split into colored segments (input / cached / output). */
function stackedBar(parts: Array<{ value: number; paint: (s: string) => string }>, total: number, cells: number): string {
  if (total <= 0) return theme.dim("·".repeat(cells));
  let used = 0;
  let out = "";
  for (const p of parts) {
    const n = Math.round((p.value / total) * cells);
    const take = Math.min(n, cells - used);
    out += p.paint("█".repeat(Math.max(0, take)));
    used += take;
  }
  return out + theme.dim("·".repeat(Math.max(0, cells - used)));
}

const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - stringWidth(strip(s))));

export function usageLines(v: UsageView, width: number, progress: number, frame: string): string[] {
  const p = ease(progress);
  const s = v.session;
  const lines: string[] = [];
  const known = s.cost !== undefined;
  const barW = Math.max(10, Math.min(36, width - 40));

  // This chat
  const cost = known ? formatCost((s.cost ?? 0) * p) : theme.dim("unknown");
  lines.push(`${theme.bold("This chat")}   ${known ? theme.ok(theme.bold(cost)) : cost}${theme.dim(`   ${s.turns} turn${s.turns === 1 ? "" : "s"} · ${s.billedRequests ?? 0} request${(s.billedRequests ?? 0) === 1 ? "" : "s"}`)}`);
  const tin = s.tokensIn, cached = s.cachedTokens ?? 0;
  // Narrow terminals drop the cached and thinking details first.
  const tokenParts = [
    `↑ ${formatTokens(tin * p)} in` + (cached && width >= 52 ? theme.dim(` (${formatTokens(cached * p)} cached)`) : ""),
    `↓ ${formatTokens(s.tokens * p)} out`,
    s.reasoning && width >= 60 ? tone.thinking(`∴ ${formatTokens(s.reasoning * p)} thinking`) : "",
  ].filter(Boolean);
  lines.push("  " + tokenParts.join("  "));
  if (known && (s.cost ?? 0) > 0) {
    const parts = [
      { value: (s.costIn ?? 0) * p, paint: tone.writing, label: "input" },
      { value: (s.costCached ?? 0) * p, paint: tone.web, label: "cached" },
      { value: (s.costOut ?? 0) * p, paint: tone.tool, label: "output" },
    ];
    lines.push("  " + stackedBar(parts, s.cost ?? 0, barW));
    const legend = parts.filter((x) => x.value > 0 || x.label !== "cached").map((x) => `${x.paint("■")} ${width >= 70 ? x.label + " " : ""}${formatCost(x.value)}`);
    lines.push("  " + legend.join(theme.dim(width >= 70 ? "  ·  " : " · ")));
  }
  if (v.running) lines.push(`${theme.bold("This turn")}   ${v.turnCost !== undefined ? formatCost(v.turnCost) : theme.dim("—")}  ${tone.writing(frame)} ${theme.dim("running")}`);

  // Periods from saved chats
  lines.push("");
  const max = Math.max(0.000001, ...v.periods.map((x) => x.cost));
  const labelW = Math.max(...v.periods.map((x) => stringWidth(x.label)), 4) + 2;
  for (const x of v.periods) {
    const value = formatCost(x.cost * p);
    const note = theme.dim(` ${x.chats} chat${x.chats === 1 ? "" : "s"}${x.unpriced ? `, ${x.unpriced} untracked` : ""}`);
    lines.push(`${pad(theme.bold(x.label), labelW)}${pad(value, 9)} ${bar((x.cost / max) * p, barW, tone.agent)}${width >= 70 ? note : ""}`);
  }

  // Rates
  lines.push("");
  if (v.price) {
    const src = v.prices === "loading" ? `${frame} refreshing` : v.prices === "live" ? `live from ${v.source}` : `cached from ${v.source}`;
    const rates = `${tone.writing(`$${v.price.input}`)} in · ${tone.web(`$${v.price.cachedInput}`)} cached · ${tone.tool(`$${v.price.output}`)} out`;
    const oneLine = `${theme.bold(v.model)} ${theme.dim("rates per 1M tokens:")} ${rates} ${theme.dim(`· ${src}`)}`;
    if (stringWidth(strip(oneLine)) <= width) lines.push(oneLine);
    else {
      // Narrow: the same information over three short lines instead of cut off.
      lines.push(`${theme.bold(v.model)} ${theme.dim("rates per 1M tokens")}`);
      lines.push(`  ${rates}`);
      lines.push(theme.dim(`  ${src}`));
    }
  } else if (v.prices === "loading") {
    lines.push(theme.dim(`${frame} Loading rates from ${v.source}…`));
  } else {
    lines.push(theme.warn(`No price for ${v.model} at ${v.source || "this API"} — costs can't be computed; token counts are exact.`));
  }
  const note = "Costs = the token usage the API reports for every request × these rates. Wallet balance: unjailedai.com/dashboard.";
  if (stringWidth(note) <= width) lines.push(theme.dim(note));
  else {
    lines.push(theme.dim(width >= 56 ? "Costs = token usage the API reports × these rates." : "Costs = API-reported usage × rates."));
    lines.push(theme.dim(width >= 56 ? "Wallet balance: unjailedai.com/dashboard." : "Balance: unjailedai.com/dashboard"));
  }
  return lines;
}

export function UsagePanel({ read, width }: { read: () => UsageView; width: number }) {
  const [opened] = useState(() => Date.now());
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 80);
    return () => clearInterval(t);
  }, []);
  const now = Date.now();
  const frame = SPIN[Math.floor(now / 160) % SPIN.length]!;
  const w = Math.min(width - 1, 100);
  const v = read();
  const lines = usageLines(v, w - 4, (now - opened) / 700, frame);
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1} width={w}>
      <Box justifyContent="space-between">
        <Text>
          {theme.bold(theme.brand("Usage"))}
          {v.running ? theme.dim(`  ${frame} live`) : ""}
        </Text>
        <Text>{theme.dim("Esc closes · keeps updating")}</Text>
      </Box>
      {lines.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          {l || " "}
        </Text>
      ))}
    </Box>
  );
}
