import fs from "node:fs";
import path from "node:path";
import { configDir } from "./config.js";
import type { Usage } from "./api.js";

/**
 * Model prices, from the public catalog at <site>/models.json (USD per
 * million tokens: input, cached input, output). Cached on disk for a day so
 * startup never waits on it; with no price list (a custom base URL without
 * one, or no network) costs are simply not shown.
 */
export interface Price {
  input: number;
  cachedInput: number;
  output: number;
}
export type PriceList = Record<string, Price>;

const MAX_AGE_MS = 24 * 3600_000;
const cacheFile = () => path.join(configDir(), "prices.json");

/** "https://unjailedai.com/v1" → "https://unjailedai.com/models.json" */
export function catalogUrl(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl);
    return `${u.origin}/models.json`;
  } catch {
    return null;
  }
}

export function parsePriceList(json: unknown): PriceList {
  const out: PriceList = {};
  const models = (json as { models?: unknown })?.models;
  if (!Array.isArray(models)) return out;
  for (const m of models) {
    const p = (m as { pricing?: Record<string, unknown> })?.pricing;
    const id = (m as { id?: unknown })?.id;
    if (typeof id !== "string" || !p) continue;
    const input = Number(p.input);
    const output = Number(p.output);
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    if (p.unit && p.unit !== "per_million_tokens") continue;
    if (p.currency && p.currency !== "USD") continue;
    const cached = Number(p.cachedInput);
    out[id] = { input, output, cachedInput: Number.isFinite(cached) ? cached : input };
  }
  return out;
}

function readCache(url: string): { at: number; prices: PriceList } | null {
  try {
    const v = JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
    if (v?.url === url && Number.isFinite(v.at) && v.prices && typeof v.prices === "object") return { at: v.at, prices: v.prices };
  } catch {
    /* none yet */
  }
  return null;
}

/** The price list for `baseUrl`'s site: from the cache if fresh (unless
 *  `fresh`), else fetched. Never throws. */
export async function loadPrices(baseUrl: string, signal?: AbortSignal, fresh = false): Promise<PriceList | null> {
  const url = catalogUrl(baseUrl);
  if (!url) return null;
  const cached = readCache(url);
  if (!fresh && cached && Date.now() - cached.at < MAX_AGE_MS && Object.keys(cached.prices).length) return cached.prices;
  try {
    const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(10_000), headers: { Accept: "application/json" } });
    if (!res.ok) return cached?.prices ?? null;
    const prices = parsePriceList(await res.json());
    if (!Object.keys(prices).length) return cached?.prices ?? null;
    try {
      fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(cacheFile(), JSON.stringify({ url, at: Date.now(), prices }) + "\n", { mode: 0o600 });
    } catch {
      /* cache is optional */
    }
    return prices;
  } catch {
    return cached?.prices ?? null; // an old list beats none
  }
}

/** One request's cost split by what was billed: fresh input, cached input, output. */
export function costParts(price: Price, usage: Usage): { input: number; cached: number; output: number } {
  const cached = Math.min(usage.cached ?? 0, usage.prompt);
  return {
    input: ((usage.prompt - cached) * price.input) / 1_000_000,
    cached: (cached * price.cachedInput) / 1_000_000,
    output: (usage.completion * price.output) / 1_000_000,
  };
}

/** USD for one request's usage at `price`. Cached prompt tokens are billed at the cached rate. */
export function costOf(price: Price | undefined, usage: Usage): number | undefined {
  if (!price) return undefined;
  const cached = Math.min(usage.cached ?? 0, usage.prompt);
  return ((usage.prompt - cached) * price.input + cached * price.cachedInput + usage.completion * price.output) / 1_000_000;
}

/** $0.0042 · $0.042 · $0.42 · $4.20 — enough digits to see small amounts move. */
export function formatCost(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
