export type PriceProviderName = "yahoo" | "tradingview";

/** Yahoo is tried first; TradingView is the fallback. */
export const HYBRID_CHAIN: PriceProviderName[] = ["yahoo", "tradingview"];

/**
 * Provider-wide failure that disables the provider for the entire run
 * (e.g. search API unreachable, WebSocket init failure).
 * In hybrid mode: disable + log WARN once, try next provider.
 * In single mode: fail immediately.
 */
export class ProviderGlobalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderGlobalError";
  }
}
