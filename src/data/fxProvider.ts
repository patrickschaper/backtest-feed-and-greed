import type { DailyPricePoint } from "../types.js";
import type { Logger } from "../utils/logger.js";
import { getCached, setCached } from "./priceCache.js";
import { fetchFromYahoo } from "./providers/yahoo.js";

/**
 * FX normalization helpers.
 *
 * Converts per-symbol price series from their native listing currency into a
 * single base currency so multi-currency portfolios are valued in comparable
 * money (including currency movements).
 *
 * Daily FX rates come from Yahoo Finance FX pairs: chart("<NATIVE><BASE>=X")
 * returns a close equal to BASE units per 1 NATIVE unit
 * (e.g. USDEUR=X close 0.86 => 0.86 EUR per 1 USD). priceBase = priceNative * rate.
 */

const FX_CACHE_PREFIX = "FX:";

export interface NormalizedCurrency {
  /** Major ISO currency code used for the FX pair (e.g. GBP). */
  code: string;
  /** Divide native prices by this to reach the major unit (100 for pence). */
  scale: number;
}

/**
 * Resolve minor currency units (e.g. GBp/GBX pence, ZAc cents) to their major
 * ISO code plus a price scale. Returns undefined when the input is not a usable
 * 3-letter code or known minor unit.
 */
export function normalizeCurrency(raw: string | undefined): NormalizedCurrency | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "—") return undefined;

  // Minor units quoted in subunits (pence/cents/agorot). Matched by the exact
  // provider-emitted form (e.g. Yahoo returns "GBp") => major code, scale 100.
  const MINOR_UNITS: Record<string, NormalizedCurrency> = {
    GBp: { code: "GBP", scale: 100 },
    GBX: { code: "GBP", scale: 100 },
    ZAc: { code: "ZAR", scale: 100 },
    ILa: { code: "ILS", scale: 100 }
  };
  const minor = MINOR_UNITS[trimmed];
  if (minor) return minor;

  const upper = trimmed.toUpperCase();
  if (/^[A-Z]{3}$/.test(upper)) {
    return { code: upper, scale: 1 };
  }
  return undefined;
}

function sortAscending(points: DailyPricePoint[]): DailyPricePoint[] {
  return [...points].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * Fetch a daily FX series (BASE per NATIVE) for the given currency pair.
 * Returns null when native === base (rate is implicitly 1). Throws on fetch
 * failure so callers can drop the affected symbols.
 */
export async function fetchFxSeries(
  nativeCode: string,
  baseCode: string,
  startDate: Date,
  endDate: Date,
  logger: Logger
): Promise<DailyPricePoint[] | null> {
  if (nativeCode === baseCode) return null;

  const pair = `${nativeCode}${baseCode}=X`;
  const cacheKey = `${FX_CACHE_PREFIX}${pair}`;

  const cached = await getCached(cacheKey, startDate, endDate);
  if (cached) {
    logger.verbose(`[fx cache hit] ${pair}`);
    return sortAscending(cached.data);
  }

  const data = await fetchFromYahoo(pair, startDate, endDate);
  const sorted = sortAscending(data);
  setCached(cacheKey, startDate, endDate, sorted, "yahoo-fx");
  logger.verbose(`Fetched ${sorted.length} FX points for ${pair}`);
  return sorted;
}

/**
 * Convert a native-currency price series into the base currency using a
 * forward-filled FX series (most recent rate on/before each price date). Points
 * with no FX rate on/before their date are dropped to avoid lookahead bias.
 *
 * @param fxSeries base-per-native daily rates, ascending by date; null => rate 1
 * @param scale divide native prices by this before applying FX (100 for pence)
 */
export function convertSeriesToBase(
  prices: DailyPricePoint[],
  fxSeries: DailyPricePoint[] | null,
  scale: number
): DailyPricePoint[] {
  if (!fxSeries && scale === 1) return prices;

  const sortedFx = fxSeries ? sortAscending(fxSeries) : null;
  const out: DailyPricePoint[] = [];

  for (const point of prices) {
    let rate = 1;
    if (sortedFx) {
      // Binary search for the most recent FX rate on/before this price date.
      let lo = 0;
      let hi = sortedFx.length - 1;
      let best: number | undefined;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const midPoint = sortedFx[mid]!;
        if (midPoint.date <= point.date) {
          best = midPoint.close;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (best === undefined) continue; // no prior FX rate — skip (no future backfill)
      rate = best;
    }
    out.push({ date: point.date, close: (point.close / scale) * rate });
  }

  return out;
}
