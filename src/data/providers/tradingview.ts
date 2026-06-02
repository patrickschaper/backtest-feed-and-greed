import { createRequire } from "module";

import type { DailyPricePoint } from "../../types.js";
import { ProviderGlobalError } from "./types.js";

// @mathieuc/tradingview is a CommonJS package with no TypeScript declarations.

const TradingView = createRequire(import.meta.url)("@mathieuc/tradingview") as TradingViewModule;

// ─── Minimal type declarations for @mathieuc/tradingview ──────────────────────

interface TvPeriod {
  time: number; // Unix seconds
  open: number;
  close: number;
  max: number;
  min: number;
}

interface TvSetMarketOptions {
  timeframe?: string;
  range?: number;
  to?: number; // Unix seconds — load `range` candles ending at this timestamp
}

interface TvChart {
  readonly periods: TvPeriod[]; // sorted descending (newest first)
  onUpdate(cb: () => void): void;
  onError(cb: (...args: unknown[]) => void): void;
  setMarket(symbol: string, options?: TvSetMarketOptions): void;
  delete(): void;
}

interface TvSession {
  readonly Chart: new () => TvChart;
}

interface TvClient {
  readonly Session: TvSession;
  onError(cb: (...args: unknown[]) => void): void;
  end(): void;
}

interface TvSearchResult {
  id: string; // Full TradingView identifier, e.g. "NASDAQ:AAPL"
  symbol: string; // Ticker only, e.g. "AAPL"
  type: string; // "stock", "crypto", etc.
  exchange: string;
  description: string;
}

interface TradingViewModule {
  Client: new (opts?: { token?: string; signature?: string }) => TvClient;
  searchMarketV3(query: string, filter?: string): Promise<TvSearchResult[]>;
}

// ─── Raw symbol search types (fields the library strips out) ──────────────────

interface TvRawSource2 {
  id: string;
  name: string;
  description: string;
}

interface TvRawSymbol {
  symbol: string;
  description?: string;
  currency_code?: string;
  country?: string;
  source_id?: string;
  source2?: TvRawSource2;
  exchange?: string;
  is_primary_listing?: boolean;
}

interface TvRawSearchResponse {
  symbols: TvRawSymbol[];
}

// ─── Exchange-to-city map for TradingView source_id codes ─────────────────────

const TV_SOURCE_CITY: Record<string, string> = {
  NASDAQ: "New York",
  NYSE: "New York",
  AMEX: "New York",
  ARCA: "New York",
  CBOE: "Chicago",
  OTC: "OTC",
  LSE: "London",
  XETR: "Frankfurt",
  FWB: "Frankfurt",
  EPA: "Paris",
  AMS: "Amsterdam",
  STO: "Stockholm",
  HEL: "Helsinki",
  CPH: "Copenhagen",
  OSL: "Oslo",
  MIL: "Milan",
  BIT: "Milan",
  VIE: "Vienna",
  BRU: "Brussels",
  LIS: "Lisbon",
  ATH: "Athens",
  IST: "Istanbul",
  TSE: "Tokyo",
  TYO: "Tokyo",
  JPX: "Tokyo",
  OSA: "Osaka",
  KRX: "Seoul",
  NSE: "Mumbai",
  BSE: "Mumbai",
  ASX: "Sydney",
  NZX: "Auckland",
  SGX: "Singapore",
  HKEX: "Hong Kong",
  SEHK: "Hong Kong",
  SSE: "Shanghai",
  SZSE: "Shenzhen",
  TSX: "Toronto",
  TSXV: "Toronto",
  BCBA: "Buenos Aires",
  BYMA: "Buenos Aires",
  BMV: "Mexico City",
  BVMF: "São Paulo",
  BMF: "São Paulo"
};

export interface TvSymbolMeta {
  name: string;
  exchange: string;
  currency: string;
}

const tvMetaCache = new Map<string, TvSymbolMeta>();

/** Fetch symbol name, exchange and currency directly from the TradingView search REST endpoint. */
export async function fetchSymbolMetaFromTradingView(ticker: string): Promise<TvSymbolMeta> {
  const key = ticker.toUpperCase();
  const hit = tvMetaCache.get(key);
  if (hit) return hit;

  try {
    const url = `https://symbol-search.tradingview.com/symbol_search/v3?text=${encodeURIComponent(ticker)}&search_type=stock&start=0`;
    const res = await fetch(url, {
      headers: {
        origin: "https://www.tradingview.com",
        referer: "https://www.tradingview.com/"
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = (await res.json()) as TvRawSearchResponse;
    const symbols: TvRawSymbol[] = data.symbols ?? [];

    // Prefer exact ticker match with is_primary_listing, then any exact match, then first result
    const exactPrimary = symbols.find(
      (s) => s.symbol.toUpperCase() === key && s.is_primary_listing === true
    );
    const exactAny = symbols.find((s) => s.symbol.toUpperCase() === key);
    const best = exactPrimary ?? exactAny ?? symbols[0];

    if (!best) {
      const meta: TvSymbolMeta = { name: ticker, exchange: "—", currency: "—" };
      tvMetaCache.set(key, meta);
      return meta;
    }

    const name = best.description || ticker;
    const currency = best.currency_code || "—";
    const sourceId = (best.source_id || best.exchange || "").toUpperCase();
    const sourceName = best.source2?.name || sourceId;
    const country = best.country || "";
    const city = TV_SOURCE_CITY[sourceId] ?? "";
    const exchangeStr = city
      ? `${sourceName}, ${city} (${country})`
      : country
        ? `${sourceName} (${country})`
        : sourceName || "—";

    const meta: TvSymbolMeta = { name, exchange: exchangeStr, currency };
    tvMetaCache.set(key, meta);
    return meta;
  } catch {
    return { name: ticker, exchange: "—", currency: "—" };
  }
}

// ─── Shared client singleton ──────────────────────────────────────────────────
//
// Opening a new WebSocket per symbol causes concurrent connection bursts that
// trigger TradingView's 429 rate limit. Instead, we share one Client (one
// WebSocket) across all concurrent fetches for the current process lifetime,
// multiplexing them as separate Session.Chart instances on the same connection.
//
// State is tracked per client-generation so that a 429 / reconnect on one
// generation cannot corrupt ref-counts of a subsequent generation.

interface PendingAbort {
  abort: (error: Error) => void;
}

interface ClientState {
  client: TvClient;
  optKey: string;
  pendingAborts: Set<PendingAbort>;
  chartCount: number;
  ended: boolean;
}

let currentState: ClientState | null = null;

// Latched after a client-level error (429, connection failure).
// Causes all subsequent fetchFromTradingView calls to fail fast with
// ProviderGlobalError so the orchestrator can fall back to Yahoo immediately.
let globalFailure: ProviderGlobalError | null = null;

function buildOptKey(opts: { token?: string; signature?: string }): string {
  return `${opts.token ?? ""}|${opts.signature ?? ""}`;
}

function abortAllPending(state: ClientState, error: Error): void {
  const toAbort = [...state.pendingAborts];
  state.pendingAborts.clear();
  for (const p of toAbort) {
    p.abort(error);
  }
}

function endClientState(state: ClientState): void {
  if (!state.ended) {
    state.ended = true;
    try {
      state.client.end();
    } catch {
      /* ignore */
    }
  }
}

function ensureClient(opts: { token?: string; signature?: string }): ClientState {
  if (globalFailure) throw globalFailure;

  const optKey = buildOptKey(opts);

  if (currentState && currentState.optKey !== optKey) {
    // Auth options changed between fetches — restart with new credentials.
    abortAllPending(
      currentState,
      new ProviderGlobalError("TradingView client restarted due to auth change")
    );
    endClientState(currentState);
    currentState = null;
  }

  if (!currentState) {
    const client = new TradingView.Client(opts);
    const state: ClientState = {
      client,
      optKey,
      pendingAborts: new Set(),
      chartCount: 0,
      ended: false
    };

    // Registering onError prevents the library from falling back to console.error
    // and routes all WebSocket-level errors (including 429) through our handler.
    client.onError((...args: unknown[]) => {
      const msg = args.map(String).join(" ");
      const error = msg.includes("429")
        ? new ProviderGlobalError(
            `TradingView rate limited (429) — unauthenticated WebSocket connections are throttled. Set TRADINGVIEW_SESSION/TRADINGVIEW_SIGNATURE to increase limits.`
          )
        : new ProviderGlobalError(`TradingView connection error: ${msg}`);

      // Latch globally — all subsequent fetchFromTradingView calls fast-fail.
      if (!globalFailure) globalFailure = error;

      // End this specific client (captured by closure, not via mutable currentState).
      endClientState(state);

      // Clear the shared ref if it still points at this generation.
      if (currentState === state) currentState = null;

      // Abort all in-flight fetches on this client (synchronous; finish/cleanup are sync).
      abortAllPending(state, error);
    });

    currentState = state;
  }

  return currentState;
}

// ─── Symbol resolution ────────────────────────────────────────────────────────

const symbolCache = new Map<string, string>();

async function resolveSymbol(ticker: string): Promise<string> {
  if (ticker.includes(":")) return ticker;

  const cached = symbolCache.get(ticker);
  if (cached) return cached;

  let results: TvSearchResult[];
  try {
    results = await TradingView.searchMarketV3(ticker, "stock");
  } catch (err) {
    throw new ProviderGlobalError(
      `TradingView symbol search unavailable: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!results || results.length === 0) {
    throw new Error(`Symbol "${ticker}" not found on TradingView`);
  }

  // Prefer exact symbol match; fall back to first result
  const exact = results.find((r) => r.symbol.toUpperCase() === ticker.toUpperCase());
  const best = exact ?? results[0];
  if (!best) {
    throw new Error(`Symbol "${ticker}" not found on TradingView`);
  }
  symbolCache.set(ticker, best.id);
  return best.id;
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 10_000;
const DATA_SETTLE_MS = 300;

export async function fetchFromTradingView(
  symbol: string,
  startDate: Date,
  endDate: Date,
  sessionToken?: string,
  signature?: string
): Promise<DailyPricePoint[]> {
  // Fast-fail if this provider is already globally unavailable for the run.
  if (globalFailure) throw globalFailure;

  const fullSymbol = await resolveSymbol(symbol);

  // Check again after the async symbol resolution — another concurrent fetch
  // may have hit a 429 while we were awaiting the HTTP search request.
  if (globalFailure) throw globalFailure;

  const calendarDays = Math.ceil((endDate.getTime() - startDate.getTime()) / 86_400_000);
  // Calendar days is already an upper bound for trading days; add buffer for safety
  const range = calendarDays + 40;

  return new Promise<DailyPricePoint[]>((resolve, reject) => {
    const opts: { token?: string; signature?: string } = {};
    if (sessionToken) {
      opts.token = sessionToken;
      if (signature) opts.signature = signature;
    }

    let state: ClientState;
    try {
      state = ensureClient(opts);
    } catch (err) {
      reject(
        err instanceof ProviderGlobalError
          ? err
          : new ProviderGlobalError(
              `TradingView client init failed: ${err instanceof Error ? err.message : String(err)}`
            )
      );
      return;
    }

    let chart: TvChart;
    try {
      chart = new state.client.Session.Chart();
    } catch (err) {
      reject(
        new ProviderGlobalError(
          `TradingView session init failed: ${err instanceof Error ? err.message : String(err)}`
        )
      );
      return;
    }

    state.chartCount++;

    let settled = false;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    // eslint-disable-next-line prefer-const
    let globalTimer: ReturnType<typeof setTimeout>;

    const pendingAbort: PendingAbort = {
      abort(error: Error) {
        finish(() => reject(error));
      }
    };
    state.pendingAborts.add(pendingAbort);

    function cleanup(): void {
      state.pendingAborts.delete(pendingAbort);
      try {
        chart.delete();
      } catch {
        /* ignore */
      }
      state.chartCount--;
      // End and release the shared client once the last chart on this generation completes.
      if (state.chartCount <= 0 && !state.ended) {
        endClientState(state);
        if (currentState === state) currentState = null;
      }
    }

    function finish(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(debounceTimer);
      clearTimeout(globalTimer);
      cleanup();
      fn();
    }

    function processAndSettle(): void {
      const points: DailyPricePoint[] = [];
      for (const p of chart.periods) {
        const d = new Date(p.time * 1000);
        if (d < startDate || d > endDate) continue;
        if (typeof p.close === "number" && p.close > 0) {
          points.push({ date: d.toISOString().slice(0, 10), close: p.close });
        }
      }
      points.sort((a, b) => (a.date < b.date ? -1 : 1));

      if (points.length === 0) {
        reject(new Error(`No data in date range for "${symbol}" on TradingView`));
      } else {
        resolve(points);
      }
    }

    globalTimer = setTimeout(() => {
      finish(() => reject(new Error(`Timeout fetching TradingView data for "${symbol}"`)));
    }, FETCH_TIMEOUT_MS);

    chart.onError((...err: unknown[]) => {
      const msg = err.map(String).join(" ");
      // 429 at the chart level (e.g. chart session rejected) also disables the provider.
      if (msg.includes("429")) {
        finish(() =>
          reject(
            new ProviderGlobalError(
              `TradingView rate limited (429) — unauthenticated WebSocket connections are throttled. Set TRADINGVIEW_SESSION/TRADINGVIEW_SIGNATURE to increase limits.`
            )
          )
        );
      } else {
        finish(() => reject(new Error(`TradingView chart error for "${symbol}": ${msg}`)));
      }
    });

    chart.onUpdate(() => {
      if (settled || !chart.periods?.length) return;

      // periods are sorted descending; last entry is the oldest candle
      const oldest = chart.periods[chart.periods.length - 1];
      if (oldest && new Date(oldest.time * 1000) <= startDate) {
        // Full coverage confirmed — settle immediately
        finish(processAndSettle);
        return;
      }

      // Coverage not yet confirmed; wait for further batches before settling
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => finish(processAndSettle), DATA_SETTLE_MS);
    });

    try {
      chart.setMarket(fullSymbol, {
        timeframe: "D",
        to: Math.floor(endDate.getTime() / 1000),
        range
      });
    } catch (err) {
      finish(() =>
        reject(
          new Error(
            `TradingView setMarket failed for "${symbol}": ${err instanceof Error ? err.message : String(err)}`
          )
        )
      );
    }
  });
}
