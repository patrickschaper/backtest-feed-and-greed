import type { Logger } from "../utils/logger.js";
import type { PieHolding } from "../types.js";

interface PortfolioPosition {
  instrument?: {
    ticker?: string;
    [key: string]: unknown;
  };
  quantity?: number;
  ticker?: string;
  symbol?: string;
  [key: string]: unknown;
}

function normalizeWeight(quantity: number, totalValue: number): number {
  if (totalValue <= 0) {
    throw new Error("Total portfolio value must be positive");
  }
  return quantity / totalValue;
}

function extractSymbolFromTicker(ticker: string): string {
  // Trading212 tickers format:
  // - STX_US_EQ → STX (no variant)
  // - ASMLa_EQ → ASML (lowercase 'a' is variant indicator)
  // - ENRd_EQ → ENR (lowercase 'd' is variant indicator)
  // Strategy: take everything before the first underscore, then remove trailing lowercase letters

  let symbol = ticker.split("_")[0] || ticker;

  // Remove trailing lowercase letters (variant indicators like a, d, p, etc.)
  symbol = symbol.replace(/[a-z]+$/, "");

  return symbol.toUpperCase();
}

function parseSymbol(position: PortfolioPosition): string | undefined {
  // Try nested instrument ticker first
  let ticker = position.instrument?.ticker;
  // Fall back to top-level ticker or symbol
  if (!ticker) {
    ticker = position.ticker || position.symbol;
  }
  if (typeof ticker === "string" && ticker.trim().length > 0) {
    return extractSymbolFromTicker(ticker);
  }
  return undefined;
}

export class PortfolioClient {
  private readonly authHeader: string;
  private readonly baseUrl: string;
  private readonly logger?: Logger;

  constructor(
    credentials: string,
    baseUrl = "https://live.trading212.com/api/v0/equity",
    logger?: Logger
  ) {
    // credentials should be in format: API_KEY:API_SECRET
    // Convert to Base64 for Basic auth header
    const encoded = Buffer.from(credentials).toString("base64");
    this.authHeader = `Basic ${encoded}`;
    this.baseUrl = baseUrl;
    this.logger = logger;
  }

  private async requestJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: this.authHeader
      }
    });
    if (!response.ok) {
      let errorMessage = `Trading212 request failed (${response.status}) for ${path}`;
      try {
        const body = await response.text();
        if (this.logger) {
          this.logger.verbose(`API response body: ${body.substring(0, 500)}`);
        }
        if (body) {
          errorMessage += `: ${body.substring(0, 200)}`;
        }
      } catch {
        // If we can't read the body, just continue with the basic error message
      }
      throw new Error(errorMessage);
    }
    return (await response.json()) as T;
  }

  async fetchPortfolioPositions(): Promise<PieHolding[]> {
    const response = await this.requestJson<unknown>("/positions");

    if (!Array.isArray(response)) {
      throw new Error(`Trading212 /positions response is not an array. Got: ${typeof response}`);
    }

    const positions: PortfolioPosition[] = [];
    for (const item of response) {
      if (typeof item === "object" && item !== null) {
        positions.push(item as PortfolioPosition);
      }
    }

    if (positions.length === 0) {
      throw new Error("No open positions found in Trading212 account");
    }

    const holdings: PieHolding[] = [];
    let totalValue = 0;

    for (const position of positions) {
      const symbol = parseSymbol(position);
      const quantity = position.quantity;

      if (!symbol || typeof quantity !== "number" || quantity <= 0) {
        continue;
      }

      totalValue += quantity;
    }

    if (totalValue <= 0) {
      throw new Error("No valid holdings found in portfolio (total value is 0 or negative)");
    }

    for (const position of positions) {
      const symbol = parseSymbol(position);
      const quantity = position.quantity;

      if (!symbol || typeof quantity !== "number" || quantity <= 0) {
        continue;
      }

      const weight = normalizeWeight(quantity, totalValue);
      holdings.push({ symbol, weight });
    }

    if (holdings.length === 0) {
      throw new Error("No usable holdings found in Trading212 portfolio");
    }

    return holdings;
  }
}
