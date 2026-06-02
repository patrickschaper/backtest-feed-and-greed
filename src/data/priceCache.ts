/**
 * Date-keyed disk cache for daily price data.
 *
 * Cache lives at: ~/.cache/backtest-feed-and-greed/prices/YYYY-MM-DD/
 * Each (symbol, startDate, endDate) tuple maps to one JSON file.
 * Entries are valid for the entire current calendar day — no TTL logic needed,
 * because the directory name encodes the date and yesterday's files are ignored.
 *
 * Cache file format: { data: DailyPricePoint[], provider: string }
 * Old format (bare array) is treated as a cache miss so it gets re-fetched.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

import type { DailyPricePoint } from "../types.js";

const CACHE_ROOT = join(homedir(), ".cache", "backtest-feed-and-greed", "prices");

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function todayDir(): string {
  return join(CACHE_ROOT, todayStr());
}

function cacheFilename(symbol: string, startDate: Date, endDate: Date): string {
  // Sanitise symbol — TradingView uses "EXCHANGE:SYMBOL", colons are unsafe in filenames
  const sym = symbol.replace(/[:/\\*?"<>|]/g, "_");
  const start = startDate.toISOString().slice(0, 10);
  const end = endDate.toISOString().slice(0, 10);
  return `${sym}__${start}__${end}.json`;
}

interface CacheEntry {
  data: DailyPricePoint[];
  provider: string;
}

/**
 * Returns cached price points and provider for the given key, or null on cache miss / read error.
 */
export async function getCached(
  symbol: string,
  startDate: Date,
  endDate: Date
): Promise<CacheEntry | null> {
  const path = join(todayDir(), cacheFilename(symbol, startDate, endDate));
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    // Old format was a bare array — treat as cache miss so it gets re-fetched with provider info
    if (Array.isArray(parsed)) return null;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "data" in parsed &&
      "provider" in parsed &&
      Array.isArray((parsed as CacheEntry).data)
    ) {
      return parsed as CacheEntry;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persists price points and provider info for the given key to today's cache directory.
 * Silently swallows write errors (cache is best-effort).
 */
export function setCached(
  symbol: string,
  startDate: Date,
  endDate: Date,
  data: DailyPricePoint[],
  provider: string
): void {
  const dir = todayDir();
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, cacheFilename(symbol, startDate, endDate));
    const entry: CacheEntry = { data, provider };
    writeFileSync(path, JSON.stringify(entry), "utf8");
  } catch {
    // Best-effort: ignore write failures
  }
}

/**
 * Removes all cache directories that are not today's date.
 * Call once at startup to keep the cache tidy.
 */
export function pruneOldCache(): void {
  if (!existsSync(CACHE_ROOT)) return;
  const today = todayStr();
  try {
    for (const entry of readdirSync(CACHE_ROOT)) {
      if (entry !== today) {
        rmSync(join(CACHE_ROOT, entry), { recursive: true, force: true });
      }
    }
  } catch {
    // Best-effort
  }
}
