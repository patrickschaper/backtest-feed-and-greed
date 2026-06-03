import { Command } from "commander";
import { OPTIMIZER_STRATEGIES } from "./backtest/optimize.js";
import type { OptimizerStrategy } from "./backtest/optimize.js";
import type { BacktestMode, PriceMode } from "./types.js";

export type { PriceMode };

export interface CliConfig {
  mode: BacktestMode;
  symbols?: string[];
  periodDays?: number;
  priceProvider: PriceMode;
  buyThresholds: number[];
  sellThresholds: number[];
  initialCash: number;
  optimizerStrategy: OptimizerStrategy;
  maxThresholds: number;
  baseCurrency: string;
  verbose: boolean;
}

interface RawCliConfig {
  symbols?: string;
  portfolio?: boolean;
  time?: string;
  priceProvider?: string;
  buyThreshold?: string;
  sellThreshold?: string;
  initialCash?: string;
  optimizerStrategy?: string;
  maxThresholds?: string;
  baseCurrency?: string;
  verbose?: boolean;
}

function parseOptionalNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`${name} must be a number`);
  }
  return parsed;
}

function parseThresholds(
  value: string | undefined,
  name: string,
  defaultValue: number[]
): number[] {
  if (value === undefined) return defaultValue;
  const parts = value.split(",");
  return parts.map((p, i) => {
    const n = Number(p.trim());
    if (Number.isNaN(n)) {
      throw new Error(`${name} value at position ${i + 1} is not a number`);
    }
    return n;
  });
}

function parseSymbols(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function daysInUtcMonth(year: number, monthZeroBased: number): number {
  return new Date(Date.UTC(year, monthZeroBased + 1, 0)).getUTCDate();
}

function subtractCalendarMonths(anchor: Date, months: number): Date {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  const day = anchor.getUTCDate();

  const totalMonths = year * 12 + month - months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;
  const targetDay = Math.min(day, daysInUtcMonth(targetYear, targetMonth));
  return new Date(Date.UTC(targetYear, targetMonth, targetDay));
}

function subtractCalendarYears(anchor: Date, years: number): Date {
  const targetYear = anchor.getUTCFullYear() - years;
  const targetMonth = anchor.getUTCMonth();
  const targetDay = Math.min(anchor.getUTCDate(), daysInUtcMonth(targetYear, targetMonth));
  return new Date(Date.UTC(targetYear, targetMonth, targetDay));
}

function toCalendarDays(value: number, unit: string, referenceDate: Date): number {
  const anchor = new Date(startOfUtcDay(referenceDate));
  let target: Date;
  switch (unit) {
    case "d":
      target = new Date(startOfUtcDay(referenceDate) - value * 24 * 60 * 60 * 1000);
      break;
    case "w":
      target = new Date(startOfUtcDay(referenceDate) - value * 7 * 24 * 60 * 60 * 1000);
      break;
    case "m":
      target = subtractCalendarMonths(anchor, value);
      break;
    case "y":
      target = subtractCalendarYears(anchor, value);
      break;
    default:
      throw new Error(`Invalid time unit: "${unit}"`);
  }

  const dayDelta = (startOfUtcDay(anchor) - startOfUtcDay(target)) / (24 * 60 * 60 * 1000);
  return Math.max(1, Math.round(dayDelta));
}

function parseTimeFormat(value: string | undefined, referenceDate: Date): number | undefined {
  if (value === undefined) {
    return toCalendarDays(1, "y", referenceDate); // default to 1 calendar year
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return toCalendarDays(1, "y", referenceDate); // default to 1 calendar year
  }

  // Match number + optional unit (d, w, m, y)
  const match = trimmed.match(/^(\d+)([dwmy])?$/i);
  if (!match) {
    throw new Error(
      `Invalid time format: "${value}". Use format like: 365 (days), 7d, 52w, 2m, or 2y`
    );
  }

  const number = Number(match[1]);
  if (Number.isNaN(number) || number <= 0) {
    throw new Error(`Time value must be a positive number`);
  }

  const unit = match[2]?.toLowerCase() || "d"; // default to days
  return toCalendarDays(number, unit, referenceDate);
}

function normalizePeriod(raw: RawCliConfig, referenceDate: Date): number | undefined {
  return parseTimeFormat(raw.time, referenceDate);
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("backtest-feed-and-greed")
    .description(
      "Backtest a Fear & Greed-driven strategy for one or more symbols (default MSFT) or your Trading212 pie"
    )
    .option(
      "--symbols <symbols>",
      "Stock ticker(s), comma-separated (e.g. AAPL,MSFT,TSLA); defaults to MSFT"
    )
    .option(
      "--portfolio",
      "Backtest your Trading212 pie instead of explicit symbols (requires TRADING212_API_TOKEN)",
      false
    )
    .option(
      "--time <time>",
      "Backtest time range (e.g., 365, 7d, 52w, 2m, 2y; calendar-based)",
      "1y"
    )
    .option(
      "--price-provider <provider>",
      "Price provider: yahoo | tradingview | hybrid (tries tradingview then yahoo)",
      "hybrid"
    )
    .option(
      "--buy-threshold <values>",
      "Buy threshold(s) (0-100), comma-separated for multiple",
      "55"
    )
    .option(
      "--sell-threshold <values>",
      "Sell threshold(s) (0-100), comma-separated for multiple",
      "45"
    )
    .option("--initial-cash <value>", "Initial portfolio cash", "10000")
    .option(
      "--optimizer-strategy <strategy>",
      "Threshold search: greedy | coarse | single-expand | full",
      "full"
    )
    .option("--max-thresholds <n>", "Max thresholds per side the optimizer may use (1 to 3)", "1")
    .option(
      "--base-currency <currency>",
      "Base currency for FX normalization; all prices converted into it (e.g. USD, EUR)",
      "USD"
    )
    .option("-v, --verbose", "Enable verbose output with detailed error messages", false);
  return program;
}

export function parseCliConfig(argv: string[], referenceDate = new Date()): CliConfig {
  const program = buildProgram();
  const options = program.parse(argv).opts<RawCliConfig>();

  const validProviders: PriceMode[] = ["yahoo", "tradingview", "hybrid"];
  if (!validProviders.includes(options.priceProvider as PriceMode)) {
    throw new Error("--price-provider must be one of: yahoo, tradingview, hybrid");
  }

  if (!OPTIMIZER_STRATEGIES.includes(options.optimizerStrategy as OptimizerStrategy)) {
    throw new Error("--optimizer-strategy must be one of: greedy, coarse, single-expand, full");
  }

  const maxThresholds = parseOptionalNumber(options.maxThresholds, "--max-thresholds") ?? 1;
  if (!Number.isInteger(maxThresholds) || maxThresholds <= 0 || maxThresholds > 3) {
    throw new Error("--max-thresholds must be an integer between 1 and 3");
  }

  const baseCurrency = (options.baseCurrency ?? "USD").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(baseCurrency)) {
    throw new Error("--base-currency must be a 3-letter currency code (e.g. EUR, USD)");
  }

  const buyThresholds = parseThresholds(options.buyThreshold, "--buy-threshold", [55]);
  const sellThresholds = parseThresholds(options.sellThreshold, "--sell-threshold", [45]);
  const initialCash = parseOptionalNumber(options.initialCash, "--initial-cash") ?? 10_000;

  for (const t of buyThresholds) {
    if (t < 0 || t > 100) {
      throw new Error("--buy-threshold values must be between 0 and 100");
    }
  }
  for (const t of sellThresholds) {
    if (t < 0 || t > 100) {
      throw new Error("--sell-threshold values must be between 0 and 100");
    }
  }
  if (initialCash <= 0) {
    throw new Error("--initial-cash must be greater than 0");
  }

  const periodDays = normalizePeriod(options, referenceDate);
  const usePortfolio = Boolean(options.portfolio);
  const parsedSymbols = parseSymbols(options.symbols);

  if (usePortfolio && parsedSymbols?.length) {
    throw new Error("cannot combine --portfolio with --symbols");
  }

  const mode: BacktestMode = usePortfolio ? "portfolio" : "symbols";
  const symbols = usePortfolio ? undefined : parsedSymbols?.length ? parsedSymbols : ["MSFT"];

  return {
    mode,
    symbols,
    periodDays,
    priceProvider: options.priceProvider as PriceMode,
    buyThresholds,
    sellThresholds,
    initialCash,
    optimizerStrategy: options.optimizerStrategy as OptimizerStrategy,
    maxThresholds,
    baseCurrency,
    verbose: Boolean(options.verbose)
  };
}
