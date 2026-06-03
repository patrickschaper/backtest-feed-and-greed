import { config as loadEnv } from "dotenv";
import Table from "cli-table3";
import { runBacktest } from "./backtest/engine.js";
import { runOptimization } from "./backtest/optimize.js";
import type { ComboMetrics, Optimization } from "./backtest/optimize.js";
import { parseCliConfig } from "./config.js";
import { fetchFearGreedHistory } from "./data/fearGreedProvider.js";
import { createPriceOrchestrator } from "./data/priceProvider.js";
import { fetchSymbolMeta } from "./data/providers/yahoo.js";
import { fetchSymbolMetaFromTradingView } from "./data/providers/tradingview.js";
import { PortfolioClient } from "./data/portfolioClient.js";
import type {
  BacktestPerformanceSummary,
  BacktestResult,
  DailyPricePoint,
  PieHolding,
  SymbolInfo,
  TimelinePoint
} from "./types.js";
import { normalizeDate, subtractDays } from "./utils/date.js";
import {
  compressArrayForWidth,
  compressSeriesForWidth,
  frameBlock,
  GRAPH_HEIGHT,
  renderEquityChart,
  renderTimeAxis,
  renderTradeMarkerRow,
  resolveGraphWidth
} from "./utils/graph.js";
import { createLogger } from "./utils/logger.js";
import { createProgressReporter } from "./progress.js";

const STRATEGY_LABEL = "Manual strategy";
const BUY_AND_HOLD_LABEL = "Buy & Hold";
const OPTIMIZED_LABEL = "Optimized";

function toDateMap<T extends { date: string }>(rows: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    map.set(row.date, row);
  }
  return map;
}

function filterByRange<T extends { date: string }>(rows: T[], startDate: Date, endDate: Date): T[] {
  const startKey = normalizeDate(startDate);
  const endKey = normalizeDate(endDate);
  return rows.filter((row) => row.date >= startKey && row.date <= endKey);
}

function buildTimeline(
  fearGreedRows: Array<{ date: string; value: number }>,
  pricesBySymbol: Record<string, Array<{ date: string; close: number }>>,
  symbols: string[]
): TimelinePoint[] {
  const fearGreedMap = toDateMap(fearGreedRows);

  // Build sorted price arrays per symbol for forward-fill lookup
  const sortedPricesPerSymbol = new Map<string, Array<{ date: string; close: number }>>();
  for (const symbol of symbols) {
    const rows = pricesBySymbol[symbol];
    if (!rows) {
      throw new Error(`Missing price rows for symbol ${symbol}`);
    }
    sortedPricesPerSymbol.set(
      symbol,
      [...rows].sort((a, b) => (a.date < b.date ? -1 : 1))
    );
  }

  const dates = [...fearGreedMap.keys()].sort();
  const timeline: TimelinePoint[] = [];

  // Track the last known price per symbol for forward-fill
  const lastKnownPrice = new Map<string, number>();

  for (const date of dates) {
    const fg = fearGreedMap.get(date);
    if (!fg) continue;

    const prices: Record<string, number> = {};
    let hasAllPrices = true;

    for (const symbol of symbols) {
      const sortedPrices = sortedPricesPerSymbol.get(symbol)!;

      // Find the most recent price on or before this date (binary search)
      let lo = 0;
      let hi = sortedPrices.length - 1;
      let bestPrice: number | undefined;

      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const midDate = sortedPrices[mid]!.date;
        if (midDate <= date) {
          bestPrice = sortedPrices[mid]!.close;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }

      if (bestPrice !== undefined) {
        lastKnownPrice.set(symbol, bestPrice);
        prices[symbol] = bestPrice;
      } else {
        // No price on or before this date — use last known if available
        const carried = lastKnownPrice.get(symbol);
        if (carried !== undefined) {
          prices[symbol] = carried;
        } else {
          hasAllPrices = false;
          break;
        }
      }
    }

    if (!hasAllPrices) continue;

    timeline.push({ date, fearGreed: fg.value, prices });
  }

  return timeline;
}

export interface DisplayContext {
  symbolInfos?: SymbolInfo[];
  buyThresholds?: number[];
  sellThresholds?: number[];
  optimization?: Optimization;
  optimizedEquitySeries?: number[];
}

export function formatResult(result: BacktestResult, displayContext?: DisplayContext): string {
  const useColors = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
  const colorize = (value: string, colorCode: string): string =>
    useColors ? `\u001B[${colorCode}m${value}\u001B[0m` : value;
  const NEGATIVE_COLOR = "91";
  // Strategy labels share the equity-chart series colors: Manual strategy = yellow,
  // Buy & Hold = cyan. Other rows use the terminal's default foreground color.
  const labelCell = (label: string): string => {
    if (label === STRATEGY_LABEL) {
      return colorize(label, "33");
    }
    if (label === BUY_AND_HOLD_LABEL) {
      return colorize(label, "36");
    }
    return label;
  };
  const colorizeSignedPercent = (value: number): string => {
    const text = `${value.toFixed(2)}%`;
    if (value > 0) {
      return colorize(text, "32");
    }
    if (value < 0) {
      return colorize(text, NEGATIVE_COLOR);
    }
    return text;
  };
  const row = (
    label: string,
    summary: BacktestPerformanceSummary,
    buyCell: string,
    sellCell: string,
    hideWinRate: boolean = false
  ): Array<string | number> => [
    labelCell(label),
    buyCell,
    sellCell,
    result.initialCash.toFixed(2),
    summary.finalEquity.toFixed(2),
    colorizeSignedPercent(summary.totalReturnPct),
    colorizeSignedPercent(summary.cagrPct),
    `${summary.maxDrawdownPct.toFixed(2)}%`,
    summary.tradeCount.toString(),
    hideWinRate ? "-" : `${summary.winRatePct.toFixed(2)}%`
  ];

  const thresholdCell = (values?: number[]): string =>
    values && values.length > 0 ? values.join(",") : "-";
  const buyCell = thresholdCell(displayContext?.buyThresholds);
  const sellCell = thresholdCell(displayContext?.sellThresholds);

  const strategySummary = result.strategy ?? {
    finalEquity: result.finalEquity,
    totalReturnPct: result.totalReturnPct,
    cagrPct: result.cagrPct,
    maxDrawdownPct: result.maxDrawdownPct,
    tradeCount: result.tradeCount,
    winRatePct: result.winRatePct
  };

  // All rows participate in the sort, each paired with its total return so they can
  // be ordered descending.
  const sortableRows: Array<{ totalReturnPct: number; cells: Array<string | number> }> = [];

  // Buy & Hold baseline row.
  sortableRows.push({
    totalReturnPct: result.comparison.buyAndHold.totalReturnPct,
    cells: row(BUY_AND_HOLD_LABEL, result.comparison.buyAndHold, "-", "-", true)
  });

  // Strategy row mirrors `row` using the given (CLI/default) buy/sell thresholds.
  sortableRows.push({
    totalReturnPct: strategySummary.totalReturnPct,
    cells: [
      labelCell(STRATEGY_LABEL),
      buyCell,
      sellCell,
      result.initialCash.toFixed(2),
      strategySummary.finalEquity.toFixed(2),
      colorizeSignedPercent(strategySummary.totalReturnPct),
      colorizeSignedPercent(strategySummary.cagrPct),
      `${strategySummary.maxDrawdownPct.toFixed(2)}%`,
      strategySummary.tradeCount.toString(),
      `${strategySummary.winRatePct.toFixed(2)}%`
    ]
  });

  const perfTable = new Table({
    head: [
      "Strategy",
      "Buy",
      "Sell",
      "Start Equity",
      "Final Equity",
      "Total Return",
      "CAGR",
      "Max Drawdown",
      "Trades",
      "Win Rate"
    ],
    colAligns: [
      "left",
      "right",
      "right",
      "right",
      "right",
      "right",
      "right",
      "right",
      "right",
      "right"
    ],
    style: {
      head: [],
      border: []
    }
  });

  // Optimizer rows: best buy/sell threshold set per objective.
  const optimization = displayContext?.optimization;
  if (optimization && optimization.results.length > 0) {
    // The chart overlays the single best-by-total-return combo in magenta; color the
    // matching table row's label the same way. Uses the same first-max selection as run().
    const bestByReturn = optimization.results.reduce((best, candidate) =>
      candidate.best.totalReturnPct > best.best.totalReturnPct ? candidate : best
    );
    const optRow = (
      label: string,
      best: ComboMetrics,
      highlight: boolean
    ): Array<string | number> => [
      highlight ? colorize(label, "35") : labelCell(label),
      thresholdCell(best.buyThresholds),
      thresholdCell(best.sellThresholds),
      result.initialCash.toFixed(2),
      best.finalEquity.toFixed(2),
      colorizeSignedPercent(best.totalReturnPct),
      colorizeSignedPercent(best.cagrPct),
      `${best.maxDrawdownPct.toFixed(2)}%`,
      best.tradeCount.toString(),
      `${best.winRatePct.toFixed(2)}%`
    ];
    for (const objective of optimization.results) {
      sortableRows.push({
        totalReturnPct: objective.best.totalReturnPct,
        cells: optRow(objective.label, objective.best, objective === bestByReturn)
      });
    }
  }

  // All rows are sorted by total return (descending). Stable for equal returns.
  sortableRows.sort((a, b) => b.totalReturnPct - a.totalReturnPct);
  for (const sortableRow of sortableRows) {
    perfTable.push(sortableRow.cells);
  }

  const graphWidth = resolveGraphWidth(process.stdout.columns);
  const strategySeries = compressSeriesForWidth(
    result.equityCurve.map((point) => point.equity),
    graphWidth
  );
  const buyAndHoldSeries = compressSeriesForWidth(
    result.comparison.buyAndHoldEquityCurve.map((point) => point.equity),
    graphWidth
  );
  const compressedDates = compressArrayForWidth(
    result.equityCurve.map((point) => point.date),
    graphWidth
  );
  const fearGreedCompressed =
    result.fearGreedSeries && result.fearGreedSeries.length > 0
      ? compressSeriesForWidth(result.fearGreedSeries, graphWidth)
      : undefined;
  const optimizedCompressed =
    displayContext?.optimizedEquitySeries && displayContext.optimizedEquitySeries.length > 0
      ? compressSeriesForWidth(displayContext.optimizedEquitySeries, graphWidth)
      : undefined;

  const equityChart = renderEquityChart({
    strategySeries,
    buyAndHoldSeries,
    strategyDates: compressedDates,
    fearGreedSeries: fearGreedCompressed,
    optimizedSeries: optimizedCompressed,
    useColors,
    height: GRAPH_HEIGHT
  });
  const timeAxis = renderTimeAxis(equityChart, compressedDates);
  const tradeMarkers =
    result.trades && result.trades.length > 0
      ? renderTradeMarkerRow(equityChart, result.trades, compressedDates, useColors)
      : "";
  const chartParts = [equityChart, timeAxis];
  if (tradeMarkers) chartParts.push(tradeMarkers);
  const framedChart = frameBlock(chartParts.join("\n"));

  // Symbol table (rendered before results if context provided)
  let symbolTableBlock = "";
  if (displayContext?.symbolInfos && displayContext.symbolInfos.length > 0) {
    const symTable = new Table({
      head: [
        "Symbol",
        "Name",
        "Exchange",
        "Currency",
        "Source",
        "Weight",
        "Start Capital",
        "Start Price",
        "End Price",
        "Gain/Loss",
        "End Capital"
      ],
      colAligns: [
        "left",
        "left",
        "left",
        "left",
        "left",
        "right",
        "right",
        "right",
        "right",
        "right",
        "right"
      ],
      style: { head: [], border: [] }
    });
    // Gain/Loss is the percentage change from start to end price, colored green/red by sign.
    const gainLossCell = (startPrice: number, endPrice: number): string => {
      const gainLossPct = startPrice > 0 ? ((endPrice - startPrice) / startPrice) * 100 : 0;
      const pctText = `${gainLossPct > 0 ? "+" : ""}${gainLossPct.toFixed(2)}%`;
      if (gainLossPct > 0) {
        return colorize(pctText, "32");
      }
      if (gainLossPct < 0) {
        return colorize(pctText, NEGATIVE_COLOR);
      }
      return pctText;
    };
    const endCapital = (info: SymbolInfo): number =>
      info.startPrice > 0 ? info.capitalAllocated * (info.endPrice / info.startPrice) : 0;
    for (const info of displayContext.symbolInfos) {
      symTable.push([
        info.symbol,
        info.name,
        info.exchange,
        info.currency,
        info.source,
        `${info.capitalWeightPct.toFixed(1)}%`,
        info.capitalAllocated.toFixed(2),
        info.startPrice.toFixed(2),
        info.endPrice.toFixed(2),
        gainLossCell(info.startPrice, info.endPrice),
        endCapital(info).toFixed(2)
      ]);
    }
    const totalCapital = displayContext.symbolInfos.reduce(
      (sum, info) => sum + info.capitalAllocated,
      0
    );
    const totalWeightPct = displayContext.symbolInfos.reduce(
      (sum, info) => sum + info.capitalWeightPct,
      0
    );
    const totalEndCapital = displayContext.symbolInfos.reduce(
      (sum, info) => sum + endCapital(info),
      0
    );
    const totalGainLossPct =
      totalCapital > 0 ? ((totalEndCapital - totalCapital) / totalCapital) * 100 : 0;
    const totalGainLossText = `${totalGainLossPct > 0 ? "+" : ""}${totalGainLossPct.toFixed(2)}%`;
    const totalGainLossCell =
      totalGainLossPct > 0
        ? colorize(totalGainLossText, "32")
        : totalGainLossPct < 0
          ? colorize(totalGainLossText, NEGATIVE_COLOR)
          : totalGainLossText;
    symTable.push([
      "Total",
      "",
      "",
      "",
      "",
      `${totalWeightPct.toFixed(1)}%`,
      totalCapital.toFixed(2),
      "",
      "",
      totalGainLossCell,
      totalEndCapital.toFixed(2)
    ]);
    symbolTableBlock = ["", "Holdings", symTable.toString()].join("\n");
  }

  const C_RESET = "\u001b[0m";
  const C_STRATEGY = "\u001b[33m";
  const C_BUY_AND_HOLD = "\u001b[36m";
  const C_INDEX = "\u001b[90m";
  const C_OPTIMIZED = "\u001b[35m"; // magenta

  const C_BUY_MARKER = "\u001b[32m"; // green
  const C_SELL_MARKER = "\u001b[91m"; // red

  const legendSeries = [
    optimizedCompressed ? `${C_OPTIMIZED}${OPTIMIZED_LABEL}${C_RESET}` : undefined,
    `${C_STRATEGY}${STRATEGY_LABEL}${C_RESET}`,
    `${C_BUY_AND_HOLD}${BUY_AND_HOLD_LABEL}${C_RESET}`,
    fearGreedCompressed ? `${C_INDEX}Fear & Greed${C_RESET} (right axis 0–100)` : undefined
  ].filter((entry): entry is string => entry !== undefined);
  const legend = `Legend: ${legendSeries.join(", ")}. ${C_BUY_MARKER}▲${C_RESET}=buy  ${C_SELL_MARKER}▼${C_RESET}=sell`;

  const optimizerNote =
    optimization && optimization.results.length > 0
      ? `Optimizer rows show the best buy/sell threshold set per objective (${optimization.strategy} search, ${optimization.combosTested} combinations evaluated); they do not change the featured ${STRATEGY_LABEL} run.`
      : undefined;

  return [
    symbolTableBlock,
    "",
    `Mode: ${result.mode}`,
    `Date range: ${result.startDate} -> ${result.endDate} (${result.timelineDays} trading days)`,
    "",
    `Equity Curve (${STRATEGY_LABEL} vs ${BUY_AND_HOLD_LABEL})`,
    framedChart,
    legend,
    "",
    perfTable.toString(),
    "CAGR = Compound Annual Growth Rate.",
    ...(optimizerNote ? [optimizerNote] : [])
  ]
    .join("\n")
    .replace(/^\n/, "");
}

function resolveSymbolsAndWeights(
  mode: "portfolio" | "symbols",
  symbols?: string[],
  holdings?: PieHolding[]
) {
  if (mode === "symbols") {
    if (!symbols || symbols.length === 0) {
      throw new Error("Symbol mode requires at least one --symbols value");
    }
    const weights: Record<string, number> = {};
    for (const sym of symbols) {
      weights[sym] = 1;
    }
    return { symbols, weights };
  }

  if (!holdings || holdings.length === 0) {
    throw new Error("Portfolio mode requires holdings from Trading212");
  }
  const portfolioSymbols = holdings.map((item) => item.symbol);
  const weights: Record<string, number> = {};
  for (const item of holdings) {
    weights[item.symbol] = 1; // equal weighting — normalization happens downstream
  }
  return { symbols: portfolioSymbols, weights };
}

export async function run(argv: string[]): Promise<void> {
  loadEnv({ quiet: true });
  const cli = parseCliConfig(argv);
  const logger = createLogger(cli.verbose);
  const reporter = createProgressReporter({
    enabled: Boolean(process.stderr.isTTY) && !cli.verbose
  });

  const now = new Date();
  const startDate = subtractDays(now, cli.periodDays ?? 365);

  try {
    let holdings: PieHolding[] | undefined;
    if (cli.mode === "portfolio") {
      const token = process.env.TRADING212_API_TOKEN;
      if (!token) {
        throw new Error("TRADING212_API_TOKEN is required for portfolio backtests");
      }
      const client = new PortfolioClient(token, undefined, logger);
      try {
        reporter.stage("Fetching Trading212 portfolio");
        logger.verbose("Fetching portfolio positions from Trading212...");
        holdings = await client.fetchPortfolioPositions();
        logger.verbose(`Loaded ${holdings.length} holdings from Trading212 portfolio`);
      } catch (error) {
        logger.verbose("Failed to fetch Trading212 portfolio data", error);
        throw error;
      }
    }

    const { symbols, weights } = resolveSymbolsAndWeights(cli.mode, cli.symbols, holdings);
    logger.verbose(`Backtesting symbols: ${symbols.join(", ")}`);

    reporter.stage("Downloading Fear & Greed Index");
    logger.verbose("Fetching Fear & Greed history...");
    const fearGreedRows = await fetchFearGreedHistory();
    logger.verbose(`Loaded ${fearGreedRows.length} Fear & Greed data points`);
    const rangedFearGreed = filterByRange(fearGreedRows, startDate, now);
    if (rangedFearGreed.length < 2) {
      throw new Error("Fear & Greed data range is too short for backtesting");
    }
    logger.verbose(`Using ${rangedFearGreed.length} Fear & Greed points in range`);

    logger.verbose(`Fetching historical prices for ${symbols.length} symbol(s)...`);
    reporter.stage(
      symbols.length === 1
        ? `Downloading prices: ${symbols[0]}`
        : `Downloading prices (${symbols.length} symbols)`
    );

    const priceOrchestrator = createPriceOrchestrator(cli.priceProvider, process.env, logger);

    const priceRowsSettled = await Promise.allSettled(
      symbols.map(async (symbol) => {
        logger.verbose(`Fetching prices for ${symbol}...`);
        const prices = await priceOrchestrator.fetchSymbol(symbol, subtractDays(startDate, 7), now);
        logger.verbose(`Loaded ${prices.length} price points for ${symbol}`);
        return [symbol, prices] as [string, DailyPricePoint[]];
      })
    );

    const priceRowsEntries: Array<[string, DailyPricePoint[]]> = [];
    const failedSymbols: string[] = [];
    const failedDetails: string[] = [];

    for (let i = 0; i < priceRowsSettled.length; i++) {
      const settledResult = priceRowsSettled[i];
      if (settledResult && settledResult.status === "fulfilled") {
        const entry = settledResult.value;
        priceRowsEntries.push(entry);
      } else if (settledResult && settledResult.status === "rejected") {
        const symbol = symbols[i];
        if (symbol) {
          failedSymbols.push(symbol);
          const reason = settledResult.reason as Error | undefined;
          const detail = reason?.message || "Unknown error";
          failedDetails.push(`${symbol}: ${detail}`);
          logger.verbose(`Failed to fetch prices for ${symbol}: ${detail}`);
        }
      }
    }

    if (priceRowsEntries.length === 0) {
      throw new Error(
        "Failed to fetch prices for all symbols. Check your portfolio symbols are valid for the selected price provider."
      );
    }

    if (failedSymbols.length > 0) {
      logger.warn(
        `Skipped ${failedSymbols.length} symbol(s) due to price fetch issues: ${failedSymbols.join(", ")}`
      );
      logger.warn(`Price fetch issues: ${failedDetails.join(" | ")}`);
    }

    const pricesBySymbol = Object.fromEntries(priceRowsEntries) as Record<
      string,
      DailyPricePoint[]
    >;
    const availableSymbols = Object.keys(pricesBySymbol);

    const timeline = buildTimeline(rangedFearGreed, pricesBySymbol, availableSymbols);
    if (timeline.length < 2) {
      throw new Error("Not enough aligned timeline points after merging data sources");
    }
    logger.verbose(`Built timeline with ${timeline.length} aligned days`);

    // Reweight symbols based on available data
    const weightsArray = Object.entries(weights)
      .filter(([symbol]) => availableSymbols.includes(symbol))
      .map(([symbol, weight]) => ({ symbol, weight }));

    let totalWeight = 0;
    for (const item of weightsArray) {
      totalWeight += item.weight;
    }

    const normalizedWeightObj: Record<string, number> = {};
    for (const item of weightsArray) {
      normalizedWeightObj[item.symbol] = item.weight / totalWeight;
    }

    if (cli.optimizerStrategy === "full" && cli.maxThresholds >= 3) {
      logger.warn(
        "--optimizer-strategy full with --max-thresholds 3 evaluates billions of combinations and may not finish; consider 'coarse' or a lower --max-thresholds."
      );
    }
    reporter.stage("Optimizing");
    logger.verbose(`Running threshold optimization (${cli.optimizerStrategy} search)...`);
    const optimization = await runOptimization(timeline, {
      mode: cli.mode,
      initialCash: cli.initialCash,
      symbolWeights: normalizedWeightObj,
      strategy: cli.optimizerStrategy,
      maxThresholds: cli.maxThresholds,
      onProgress: (done, total) => {
        reporter.percent(total > 0 ? (done / total) * 100 : 0);
      }
    });
    logger.verbose(`Optimization tested ${optimization.combosTested} threshold combinations`);

    const result = runBacktest(timeline, {
      mode: cli.mode,
      buyThresholds: cli.buyThresholds,
      sellThresholds: cli.sellThresholds,
      initialCash: cli.initialCash,
      symbolWeights: normalizedWeightObj
    });

    // Re-run the single best-by-total-return optimized combo to obtain its equity
    // curve, so it can be overlaid on the chart (magenta, drawn on top).
    let optimizedEquitySeries: number[] | undefined;
    if (optimization.results.length > 0) {
      const bestByReturn = optimization.results.reduce((best, candidate) =>
        candidate.best.totalReturnPct > best.best.totalReturnPct ? candidate : best
      );
      const optimizedResult = runBacktest(timeline, {
        mode: cli.mode,
        buyThresholds: bestByReturn.best.buyThresholds,
        sellThresholds: bestByReturn.best.sellThresholds,
        initialCash: cli.initialCash,
        symbolWeights: normalizedWeightObj
      });
      optimizedEquitySeries = optimizedResult.equityCurve.map((point) => point.equity);
    }
    // Fetch symbol metadata for the holdings table
    reporter.stage("Fetching symbol metadata");
    const firstDay = timeline[0];
    const lastDay = timeline[timeline.length - 1];
    const metaSettled = await Promise.allSettled(
      availableSymbols.map((symbol) => {
        const provider = priceOrchestrator.getProviderForSymbol(symbol);
        return provider === "tradingview"
          ? fetchSymbolMetaFromTradingView(symbol)
          : fetchSymbolMeta(symbol);
      })
    );
    const symbolInfos: SymbolInfo[] = availableSymbols.map((symbol, i) => {
      const metaResult = metaSettled[i];
      const meta =
        metaResult?.status === "fulfilled"
          ? metaResult.value
          : { name: symbol, exchange: "—", currency: "—" };
      const startPrice = firstDay?.prices[symbol] ?? 0;
      const endPrice = lastDay?.prices[symbol] ?? 0;
      const weight = normalizedWeightObj[symbol] ?? 0;
      return {
        symbol,
        name: meta.name,
        exchange: meta.exchange,
        currency: meta.currency,
        source: priceOrchestrator.getProviderForSymbol(symbol),
        startPrice,
        endPrice,
        capitalAllocated: weight * cli.initialCash,
        capitalWeightPct: weight * 100
      };
    });

    reporter.stop();
    process.stdout.write(
      `${formatResult(result, {
        symbolInfos,
        buyThresholds: cli.buyThresholds,
        sellThresholds: cli.sellThresholds,
        optimization,
        optimizedEquitySeries
      })}\n`
    );
  } catch (error) {
    logger.verbose("Failed during data fetching or backtesting", error);
    throw error;
  } finally {
    reporter.stop();
  }
}
