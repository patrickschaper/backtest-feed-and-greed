import YahooFinance from "yahoo-finance2";
import type { DailyPricePoint } from "../../types.js";

const yahooFinance = new YahooFinance({
  suppressNotices: ["ripHistorical", "yahooSurvey"],
  validation: { logErrors: false }
});

function normalizeDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseDateValue(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) return parsed;
  }
  return undefined;
}

function pushPricePoint(target: DailyPricePoint[], dateValue: unknown, closeValue: unknown): void {
  const date = parseDateValue(dateValue);
  if (!date) return;
  if (typeof closeValue !== "number" || Number.isNaN(closeValue) || closeValue <= 0) return;
  target.push({ date: normalizeDate(date), close: closeValue });
}

function parseChartArrayResult(result: unknown): DailyPricePoint[] {
  if (!isObject(result) || !Array.isArray(result.quotes)) return [];
  const points: DailyPricePoint[] = [];
  for (const quote of result.quotes) {
    if (!isObject(quote)) continue;
    const closeValue =
      typeof quote.adjclose === "number" && !Number.isNaN(quote.adjclose)
        ? quote.adjclose
        : quote.close;
    pushPricePoint(points, quote.date, closeValue);
  }
  return points;
}

function parseChartObjectResult(result: unknown): DailyPricePoint[] {
  if (!isObject(result) || !Array.isArray(result.timestamp)) return [];
  if (!isObject(result.indicators) || !Array.isArray(result.indicators.quote)) return [];
  const quote0 = result.indicators.quote[0];
  if (!isObject(quote0) || !Array.isArray(quote0.close)) return [];

  const adjclose =
    Array.isArray(result.indicators.adjclose) &&
    isObject(result.indicators.adjclose[0]) &&
    Array.isArray(result.indicators.adjclose[0].adjclose)
      ? result.indicators.adjclose[0].adjclose
      : undefined;

  const points: DailyPricePoint[] = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const ts = result.timestamp[i];
    const adj = adjclose?.[i];
    const close = quote0.close[i];
    const closeValue = typeof adj === "number" && !Number.isNaN(adj) ? adj : close;
    if (typeof ts === "number") {
      pushPricePoint(points, new Date(ts * 1000), closeValue);
    }
  }
  return points;
}

function dedupeAndSort(points: DailyPricePoint[]): DailyPricePoint[] {
  const byDate = new Map<string, DailyPricePoint>();
  for (const point of points) byDate.set(point.date, point);
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

function isValidationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("did not validate with schema") ||
    msg.includes("failed validation") ||
    msg.includes("schema validation") ||
    msg.includes("validation error")
  );
}

export async function fetchFromYahoo(
  symbol: string,
  startDate: Date,
  endDate: Date,
  _apiKey?: string
): Promise<DailyPricePoint[]> {
  let prices: DailyPricePoint[] = [];
  let firstError: unknown;

  try {
    prices = parseChartArrayResult(
      await yahooFinance.chart(symbol, {
        period1: startDate,
        period2: endDate,
        interval: "1d",
        return: "array"
      })
    );
  } catch (error) {
    firstError = error;
    if (!isValidationError(error)) {
      const msg = error instanceof Error ? error.message.toLowerCase() : "";
      if (msg.includes("no data found") || msg.includes("not found")) {
        throw new Error(`No data found for symbol ${symbol} on Yahoo Finance`, { cause: error });
      }
      // Treat unexpected errors as symbol-local so Yahoo stays active for other symbols.
      throw new Error(
        `Yahoo Finance error for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  if (prices.length === 0) {
    try {
      prices = parseChartObjectResult(
        await yahooFinance.chart(
          symbol,
          { period1: startDate, period2: endDate, interval: "1d", return: "object" },
          { validateResult: false }
        )
      );
    } catch (error) {
      if (firstError instanceof Error) throw firstError;
      throw error;
    }
  }

  prices = dedupeAndSort(prices);
  if (prices.length === 0) {
    throw new Error(`No historical prices returned for symbol ${symbol} on Yahoo Finance`);
  }
  return prices;
}

export interface SymbolMeta {
  name: string;
  exchange: string;
  currency: string;
}

/** Map Yahoo exchange codes to exchange name + city. */
interface ExchangeInfo {
  name: string;
  city: string;
}

const EXCHANGE_CODE_TO_INFO: Record<string, ExchangeInfo> = {
  // United States
  NMS: { name: "NASDAQ Global Select", city: "New York (US)" },
  NGM: { name: "NASDAQ Global Market", city: "New York (US)" },
  NCM: { name: "NASDAQ Capital Market", city: "New York (US)" },
  NYQ: { name: "NYSE", city: "New York (US)" },
  PCX: { name: "NYSE Arca", city: "New York (US)" },
  ASE: { name: "NYSE American", city: "New York (US)" },
  BTS: { name: "OTC Markets", city: "OTC (US)" },
  OBB: { name: "OTC Bulletin Board", city: "OTC (US)" },
  // United Kingdom
  LSE: { name: "London Stock Exchange", city: "London (GB)" },
  IOB: { name: "London Stock Exchange IOB", city: "London (GB)" },
  // Germany
  GER: { name: "XETRA", city: "Frankfurt (DE)" },
  FRA: { name: "Frankfurt Stock Exchange", city: "Frankfurt (DE)" },
  XETRA: { name: "XETRA", city: "Frankfurt (DE)" },
  // France
  EPA: { name: "Euronext Paris", city: "Paris (FR)" },
  PAR: { name: "Euronext Paris", city: "Paris (FR)" },
  // Netherlands
  AMS: { name: "Euronext Amsterdam", city: "Amsterdam (NL)" },
  // Spain
  MCE: { name: "Bolsa de Madrid", city: "Madrid (ES)" },
  BME: { name: "Bolsa de Madrid", city: "Madrid (ES)" },
  // Sweden
  STO: { name: "Nasdaq Stockholm", city: "Stockholm (SE)" },
  // Finland
  HEL: { name: "Nasdaq Helsinki", city: "Helsinki (FI)" },
  // Denmark
  CPH: { name: "Nasdaq Copenhagen", city: "Copenhagen (DK)" },
  // Norway
  OSL: { name: "Oslo Børs", city: "Oslo (NO)" },
  // Austria
  VIE: { name: "Wiener Börse", city: "Vienna (AT)" },
  // Belgium
  BRU: { name: "Euronext Brussels", city: "Brussels (BE)" },
  // Italy
  MIL: { name: "Borsa Italiana", city: "Milan (IT)" },
  BIT: { name: "Borsa Italiana", city: "Milan (IT)" },
  // Switzerland
  SWX: { name: "SIX Swiss Exchange", city: "Zurich (CH)" },
  ZRH: { name: "SIX Swiss Exchange", city: "Zurich (CH)" },
  EBS: { name: "SIX Swiss Exchange", city: "Zurich (CH)" },
  // Portugal
  LIS: { name: "Euronext Lisbon", city: "Lisbon (PT)" },
  // Greece
  ATH: { name: "Athens Exchange", city: "Athens (GR)" },
  // Turkey
  IST: { name: "Borsa Istanbul", city: "Istanbul (TR)" },
  // Japan
  TYO: { name: "Tokyo Stock Exchange", city: "Tokyo (JP)" },
  JPX: { name: "Japan Exchange Group", city: "Tokyo (JP)" },
  // China
  SHH: { name: "Shanghai Stock Exchange", city: "Shanghai (CN)" },
  SHZ: { name: "Shenzhen Stock Exchange", city: "Shenzhen (CN)" },
  // Hong Kong
  HKG: { name: "Hong Kong Stock Exchange", city: "Hong Kong (HK)" },
  // South Korea
  KRX: { name: "Korea Exchange", city: "Seoul (KR)" },
  // India
  NSI: { name: "National Stock Exchange of India", city: "Mumbai (IN)" },
  BSE: { name: "Bombay Stock Exchange", city: "Mumbai (IN)" },
  // Australia
  ASX: { name: "Australian Securities Exchange", city: "Sydney (AU)" },
  // New Zealand
  NZX: { name: "New Zealand Exchange", city: "Auckland (NZ)" },
  // Singapore
  SGX: { name: "Singapore Exchange", city: "Singapore (SG)" },
  // Canada
  TOR: { name: "Toronto Stock Exchange", city: "Toronto (CA)" },
  TSX: { name: "Toronto Stock Exchange", city: "Toronto (CA)" },
  CVE: { name: "TSX Venture Exchange", city: "Toronto (CA)" },
  VAN: { name: "TSX Venture Exchange", city: "Vancouver (CA)" },
  // Brazil
  SAO: { name: "B3", city: "São Paulo (BR)" }
};

/** Fallback map from Yahoo fullExchangeName to exchange info. */
const EXCHANGE_NAME_TO_INFO: Record<string, ExchangeInfo> = {
  NasdaqGS: { name: "NASDAQ Global Select", city: "New York (US)" },
  NasdaqCM: { name: "NASDAQ Capital Market", city: "New York (US)" },
  NasdaqNM: { name: "NASDAQ National Market", city: "New York (US)" },
  Nasdaq: { name: "NASDAQ", city: "New York (US)" },
  NYSE: { name: "NYSE", city: "New York (US)" },
  "NYSE Arca": { name: "NYSE Arca", city: "New York (US)" },
  "NYSE American": { name: "NYSE American", city: "New York (US)" },
  "OTC Markets": { name: "OTC Markets", city: "OTC (US)" },
  CBOE: { name: "CBOE", city: "Chicago (US)" },
  London: { name: "London Stock Exchange", city: "London (GB)" },
  "London Stock Exchange": { name: "London Stock Exchange", city: "London (GB)" },
  XETRA: { name: "XETRA", city: "Frankfurt (DE)" },
  "Frankfurt Stock Exchange": { name: "Frankfurt Stock Exchange", city: "Frankfurt (DE)" },
  Euronext: { name: "Euronext", city: "Amsterdam (NL)" },
  "Euronext Amsterdam": { name: "Euronext Amsterdam", city: "Amsterdam (NL)" },
  "Euronext Paris": { name: "Euronext Paris", city: "Paris (FR)" },
  "Euronext Brussels": { name: "Euronext Brussels", city: "Brussels (BE)" },
  "Euronext Lisbon": { name: "Euronext Lisbon", city: "Lisbon (PT)" },
  Madrid: { name: "Bolsa de Madrid", city: "Madrid (ES)" },
  Stockholm: { name: "Nasdaq Stockholm", city: "Stockholm (SE)" },
  Helsinki: { name: "Nasdaq Helsinki", city: "Helsinki (FI)" },
  Copenhagen: { name: "Nasdaq Copenhagen", city: "Copenhagen (DK)" },
  Oslo: { name: "Oslo Børs", city: "Oslo (NO)" },
  Vienna: { name: "Wiener Börse", city: "Vienna (AT)" },
  Milan: { name: "Borsa Italiana", city: "Milan (IT)" },
  "Borsa Italiana": { name: "Borsa Italiana", city: "Milan (IT)" },
  Zurich: { name: "SIX Swiss Exchange", city: "Zurich (CH)" },
  "Swiss Exchange": { name: "SIX Swiss Exchange", city: "Zurich (CH)" },
  Istanbul: { name: "Borsa Istanbul", city: "Istanbul (TR)" },
  Athens: { name: "Athens Exchange", city: "Athens (GR)" },
  Tokyo: { name: "Tokyo Stock Exchange", city: "Tokyo (JP)" },
  Shanghai: { name: "Shanghai Stock Exchange", city: "Shanghai (CN)" },
  Shenzhen: { name: "Shenzhen Stock Exchange", city: "Shenzhen (CN)" },
  "Hong Kong": { name: "Hong Kong Stock Exchange", city: "Hong Kong (HK)" },
  Seoul: { name: "Korea Exchange", city: "Seoul (KR)" },
  Bombay: { name: "Bombay Stock Exchange", city: "Mumbai (IN)" },
  "National India": { name: "National Stock Exchange of India", city: "Mumbai (IN)" },
  Australia: { name: "Australian Securities Exchange", city: "Sydney (AU)" },
  "New Zealand": { name: "New Zealand Exchange", city: "Auckland (NZ)" },
  Singapore: { name: "Singapore Exchange", city: "Singapore (SG)" },
  Toronto: { name: "Toronto Stock Exchange", city: "Toronto (CA)" },
  "Toronto Stock Exchange": { name: "Toronto Stock Exchange", city: "Toronto (CA)" },
  "São Paulo": { name: "B3", city: "São Paulo (BR)" }
};

function resolveExchange(exchangeCode: string, fullName: string): string {
  const byCode = EXCHANGE_CODE_TO_INFO[exchangeCode];
  if (byCode) return `${byCode.name}, ${byCode.city}`;
  for (const [key, info] of Object.entries(EXCHANGE_NAME_TO_INFO)) {
    if (fullName.startsWith(key) || key.startsWith(fullName)) return `${info.name}, ${info.city}`;
  }
  return fullName || exchangeCode || "—";
}

export async function fetchSymbolMeta(symbol: string): Promise<SymbolMeta> {
  try {
    const quote = await yahooFinance.quote(symbol, {
      fields: [
        "longName",
        "shortName",
        "displayName",
        "fullExchangeName",
        "exchange",
        "currency",
        "region"
      ]
    });
    const q = quote as Record<string, unknown>;
    const name =
      (typeof q.longName === "string" && q.longName) ||
      (typeof q.displayName === "string" && q.displayName) ||
      (typeof q.shortName === "string" && q.shortName) ||
      symbol;
    const exchangeCode = typeof q.exchange === "string" ? q.exchange : "";
    const fullExchangeName = typeof q.fullExchangeName === "string" ? q.fullExchangeName : "";
    const exchange = resolveExchange(exchangeCode, fullExchangeName);
    const currency = typeof q.currency === "string" ? q.currency : "—";
    return { name, exchange, currency };
  } catch {
    return { name: symbol, exchange: "—", currency: "—" };
  }
}
