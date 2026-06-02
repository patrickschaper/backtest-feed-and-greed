import type { DailyPricePoint, PriceMode } from "../types.js";
import type { Logger } from "../utils/logger.js";
import { getCached, pruneOldCache, setCached } from "./priceCache.js";
import { fetchFromTradingView } from "./providers/tradingview.js";
import { HYBRID_CHAIN, ProviderGlobalError } from "./providers/types.js";
import type { PriceProviderName } from "./providers/types.js";
import { fetchFromYahoo } from "./providers/yahoo.js";

export type { PriceMode } from "../types.js";
export { ProviderGlobalError } from "./providers/types.js";

async function callProvider(
  name: PriceProviderName,
  symbol: string,
  startDate: Date,
  endDate: Date,
  env: NodeJS.ProcessEnv
): Promise<DailyPricePoint[]> {
  switch (name) {
    case "yahoo":
      return fetchFromYahoo(symbol, startDate, endDate);
    case "tradingview":
      return fetchFromTradingView(
        symbol,
        startDate,
        endDate,
        env["TRADINGVIEW_SESSION"],
        env["TRADINGVIEW_SIGNATURE"]
      );
  }
}

export interface PriceOrchestrator {
  fetchSymbol(symbol: string, startDate: Date, endDate: Date): Promise<DailyPricePoint[]>;
  getProviderForSymbol(symbol: string): string;
}

export function createPriceOrchestrator(
  mode: PriceMode,
  env: NodeJS.ProcessEnv,
  logger: Logger
): PriceOrchestrator {
  pruneOldCache();

  const disabledProviders = new Map<PriceProviderName, string>();
  const warnedProviders = new Set<PriceProviderName>();
  const providerBySymbol = new Map<string, string>();

  function isDisabled(name: PriceProviderName): boolean {
    return disabledProviders.has(name);
  }

  function disableProvider(name: PriceProviderName, reason: string): void {
    disabledProviders.set(name, reason);
  }

  function warnOnce(name: PriceProviderName, message: string): void {
    if (!warnedProviders.has(name)) {
      warnedProviders.add(name);
      logger.warn(message);
    }
  }

  async function fetchHybrid(
    symbol: string,
    startDate: Date,
    endDate: Date
  ): Promise<{ data: DailyPricePoint[]; provider: PriceProviderName }> {
    const symbolErrors: string[] = [];

    for (const name of HYBRID_CHAIN) {
      if (isDisabled(name)) continue;

      try {
        const data = await callProvider(name, symbol, startDate, endDate, env);
        return { data, provider: name };
      } catch (error) {
        const isGlobal = error instanceof ProviderGlobalError;
        const msg = error instanceof Error ? error.message : String(error);

        if (isGlobal) {
          disableProvider(name, msg);
          warnOnce(name, `${name} provider disabled for this run: ${msg}`);
          continue;
        }

        symbolErrors.push(`${name}: ${msg}`);
      }
    }

    const allDisabled = HYBRID_CHAIN.every((n) => isDisabled(n));
    if (allDisabled) {
      throw new Error(
        `All hybrid providers were skipped or failed. ${[...disabledProviders.values()].join("; ")}`
      );
    }

    throw new Error(`All providers failed for ${symbol}: ${symbolErrors.join(" | ")}`);
  }

  async function fetchSingle(
    name: PriceProviderName,
    symbol: string,
    startDate: Date,
    endDate: Date
  ): Promise<{ data: DailyPricePoint[]; provider: PriceProviderName }> {
    if (isDisabled(name)) {
      const reason = disabledProviders.get(name) ?? "unknown error";
      throw new Error(`Provider ${name} is unavailable: ${reason}`);
    }

    try {
      const data = await callProvider(name, symbol, startDate, endDate, env);
      return { data, provider: name };
    } catch (error) {
      const isGlobal = error instanceof ProviderGlobalError;
      const msg = error instanceof Error ? error.message : String(error);

      if (isGlobal) {
        disableProvider(name, msg);
        throw new Error(`Provider ${name} failed: ${msg}`, { cause: error });
      }

      throw error;
    }
  }

  return {
    getProviderForSymbol(symbol: string): string {
      return providerBySymbol.get(symbol) ?? "unknown";
    },

    async fetchSymbol(symbol: string, startDate: Date, endDate: Date): Promise<DailyPricePoint[]> {
      const cached = await getCached(symbol, startDate, endDate);
      if (cached) {
        logger.verbose(`[cache hit] ${symbol}`);
        providerBySymbol.set(symbol, cached.provider);
        return cached.data;
      }

      const { data, provider } =
        mode === "hybrid"
          ? await fetchHybrid(symbol, startDate, endDate)
          : await fetchSingle(mode as PriceProviderName, symbol, startDate, endDate);

      providerBySymbol.set(symbol, provider);
      setCached(symbol, startDate, endDate, data, provider);
      return data;
    }
  };
}
