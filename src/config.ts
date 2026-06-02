import { Command } from "commander";
import type { BacktestMode, PriceMode } from "./types.js";

export type { PriceMode };

export interface CliConfig {
  mode: BacktestMode;
  symbol?: string;
  periodDays?: number;
  priceProvider: PriceMode;
  buyThreshold: number;
  sellThreshold: number;
  initialCash: number;
  verbose: boolean;
}

interface RawCliConfig {
  symbol?: string;
  time?: string;
  priceProvider?: string;
  buyThreshold?: string;
  sellThreshold?: string;
  initialCash?: string;
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
    .description("Backtest a Fear & Greed-driven strategy for Trading212 portfolio or a symbol")
    .option("--symbol <symbol>", "Stock ticker (sets single-symbol mode automatically)")
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
    .option("--buy-threshold <value>", "Buy threshold (0-100)", "55")
    .option("--sell-threshold <value>", "Sell threshold (0-100)", "45")
    .option("--initial-cash <value>", "Initial portfolio cash", "10000")
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

  const buyThreshold = parseOptionalNumber(options.buyThreshold, "--buy-threshold") ?? 55;
  const sellThreshold = parseOptionalNumber(options.sellThreshold, "--sell-threshold") ?? 45;
  const initialCash = parseOptionalNumber(options.initialCash, "--initial-cash") ?? 10_000;

  if (buyThreshold < 0 || buyThreshold > 100) {
    throw new Error("--buy-threshold must be between 0 and 100");
  }
  if (sellThreshold < 0 || sellThreshold > 100) {
    throw new Error("--sell-threshold must be between 0 and 100");
  }
  if (initialCash <= 0) {
    throw new Error("--initial-cash must be greater than 0");
  }

  const periodDays = normalizePeriod(options, referenceDate);
  const normalizedSymbol = options.symbol?.trim().toUpperCase();
  const mode: BacktestMode = normalizedSymbol ? "single" : "portfolio";

  return {
    mode,
    symbol: normalizedSymbol,
    periodDays,
    priceProvider: options.priceProvider as PriceMode,
    buyThreshold,
    sellThreshold,
    initialCash,
    verbose: Boolean(options.verbose)
  };
}
