import os from "node:os";
import v8 from "node:v8";
import { spawnSync } from "node:child_process";

/**
 * Give the CLI a heap sized to the machine instead of V8's default cap
 * (~2 GB on 64-bit). A long agent session legitimately keeps its whole
 * conversation and tool history in memory, and on a machine with plenty of
 * RAM it should be allowed to, rather than dying with "heap out of memory"
 * once the history passes 2 GB. V8 fixes the old-space limit at startup and
 * `setFlagsFromString` can't raise it afterwards, so the only way is to
 * re-exec Node once with `--max-old-space-size`.
 *
 * This never *lowers* a limit, is a no-op when the limit is already high
 * enough (or the user set one), and can be turned off entirely.
 */

const MB = 1024 * 1024;

/** Desired old-space cap (MB) for a machine with `totalBytes` of RAM, or null
 *  to leave the current `currentLimitMB` alone. Leaves headroom for the rest
 *  of the process (buffers, code, other spaces) and the OS. */
export function targetHeapMB(totalBytes: number, currentLimitMB: number, override?: string): number | null {
  if (override) {
    const n = Math.floor(Number(override));
    if (!Number.isFinite(n) || n <= 0) return null;
    return n > currentLimitMB ? n : null; // only ever raise
  }
  const totalMB = Math.floor(totalBytes / MB);
  if (!Number.isFinite(totalMB) || totalMB <= 0) return null;
  // Use most of RAM, but always leave ~2 GB (or a quarter of a small machine)
  // for everything else, and never propose an absurd multi-tens-of-GB heap.
  const reserve = Math.max(1024, Math.min(2048, Math.floor(totalMB / 4)));
  const desired = Math.min(Math.floor(totalMB * 0.75), totalMB - reserve, 16384);
  const target = Math.max(2048, desired);
  // Only bother re-exec'ing for a worthwhile gain over what we already have.
  return target >= currentLimitMB + 512 ? target : null;
}

/** Already running with a raised limit, or asked not to tune, or the user set
 *  their own limit through NODE_OPTIONS. */
function shouldSkip(): boolean {
  if (process.env.UNJAILED_HEAP_TUNED === "1") return true;
  const off = process.env.UNJAILED_NO_HEAP_TUNE;
  if (off && off !== "0" && off !== "false") return true;
  if (/--max[-_]old[-_]space[-_]size/.test(process.env.NODE_OPTIONS ?? "")) return true;
  return false;
}

/**
 * Re-exec the CLI once with a bigger `--max-old-space-size` when the machine
 * has the RAM for it. Returns the child's exit code when it re-exec'd (the
 * caller should exit with it), or null when it did nothing and the CLI should
 * carry on in this process. Any failure falls through to running normally.
 */
export function ensureHeadroom(argv = process.argv): number | null {
  try {
    if (shouldSkip()) return null;
    const entry = argv[1];
    if (!entry) return null;
    const currentLimitMB = Math.round(v8.getHeapStatistics().heap_size_limit / MB);
    const target = targetHeapMB(os.totalmem(), currentLimitMB, process.env.UNJAILED_MAX_OLD_SPACE);
    if (target === null) return null;
    const result = spawnSync(process.execPath, [`--max-old-space-size=${target}`, entry, ...argv.slice(2)], {
      stdio: "inherit",
      env: { ...process.env, UNJAILED_HEAP_TUNED: "1" },
    });
    // Couldn't spawn (shouldn't happen): run in this process instead.
    if (result.error) return null;
    if (typeof result.status === "number") return result.status;
    // Killed by a signal: mirror Node's 128+signal convention so the parent
    // doesn't report a clean exit when the child was, say, Ctrl+C'd.
    if (result.signal) return 128 + (os.constants.signals[result.signal] ?? 0);
    return 0;
  } catch {
    return null; // never let heap tuning stop the CLI from starting
  }
}
