import asciichart from "asciichart";
import type { Trade } from "../types.js";

export const GRAPH_HEIGHT = 30;
const DEFAULT_GRAPH_WIDTH = 60;
const MIN_GRAPH_WIDTH = 20;
const GRAPH_HORIZONTAL_PADDING = 22;

// Simple standard ANSI colors (16-color, work on every terminal)
const COLOR_STRATEGY = "\u001b[32m"; // green
const COLOR_BUY_AND_HOLD = "\u001b[33m"; // yellow
const COLOR_FEAR_AND_GREED = "\u001b[36m"; // cyan

export function resolveGraphWidth(terminalColumns?: number): number {
  if (!terminalColumns || terminalColumns <= 0) {
    return DEFAULT_GRAPH_WIDTH;
  }

  return Math.max(MIN_GRAPH_WIDTH, terminalColumns - GRAPH_HORIZONTAL_PADDING);
}

export function compressSeriesForWidth(values: number[], targetWidth: number): number[] {
  return compressArrayForWidth(values, targetWidth);
}

export function compressArrayForWidth<T>(values: T[], targetWidth: number): T[] {
  if (values.length <= targetWidth || targetWidth < 2) {
    return values;
  }

  const compressed: T[] = [];
  const step = (values.length - 1) / (targetWidth - 1);
  for (let index = 0; index < targetWidth; index += 1) {
    const sourceIndex = Math.round(index * step);
    const value = values[sourceIndex];
    if (value !== undefined) {
      compressed.push(value);
    }
  }
  return compressed;
}

export function renderMergedEquityGraph(
  strategyValues: number[],
  buyAndHoldValues: number[],
  useColors: boolean,
  height: number = GRAPH_HEIGHT
): string {
  const width = Math.min(strategyValues.length, buyAndHoldValues.length);
  if (width === 0) {
    return "";
  }

  const buyAndHold = buyAndHoldValues.slice(0, width);
  const strategy = strategyValues.slice(0, width);
  return asciichart.plot([buyAndHold, strategy], {
    height,
    colors: useColors ? [COLOR_BUY_AND_HOLD, COLOR_STRATEGY] : undefined
  });
}

function placeLabel(buffer: string[], label: string, position: number): void {
  for (let index = 0; index < label.length; index += 1) {
    const cursor = position + index;
    if (cursor >= 0 && cursor < buffer.length) {
      buffer[cursor] = label[index]!;
    }
  }
}

export function renderTimeAxis(graph: string, dateLabels: string[]): string {
  if (!graph || dateLabels.length === 0) {
    return "";
  }

  const graphLines = graph.split("\n");
  const baseline = graphLines[graphLines.length - 1] ?? "";
  const yAxisIndex = baseline.indexOf("┼");
  const plotStart = yAxisIndex >= 0 ? Math.max(0, yAxisIndex + 1 - 6) : 0;
  const width = dateLabels.length;
  const mid = Math.floor((width - 1) / 2);
  const formattedLabels =
    width >= 40
      ? dateLabels
      : dateLabels.map((label) => (label.length >= 10 ? label.slice(5) : label));

  const axisLine = `${" ".repeat(plotStart)}└${"─".repeat(Math.max(0, width - 1))}`;
  const tickChars = Array.from({ length: width }, () => " ");
  tickChars[0] = "┬";
  tickChars[mid] = "┬";
  tickChars[width - 1] = "┬";
  const tickLine = `${" ".repeat(plotStart)}${tickChars.join("")}`;

  const labelChars = Array.from({ length: width }, () => " ");
  placeLabel(labelChars, formattedLabels[0] ?? "", 0);
  if (width >= 28) {
    const midLabel = formattedLabels[mid] ?? "";
    placeLabel(labelChars, midLabel, Math.max(0, mid - Math.floor(midLabel.length / 2)));
  }
  const endLabel = formattedLabels[width - 1] ?? "";
  placeLabel(labelChars, endLabel, Math.max(0, width - endLabel.length));
  const labelLine = `${" ".repeat(plotStart)}${labelChars.join("")}`;

  return [axisLine, tickLine, labelLine].join("\n");
}

function visibleLength(value: string): number {
  let count = 0;
  let index = 0;
  while (index < value.length) {
    const char = value[index];
    if (char === "\u001B" && value[index + 1] === "[") {
      index += 2;
      while (index < value.length && value[index] !== "m") {
        index += 1;
      }
      if (index < value.length && value[index] === "m") {
        index += 1;
      }
      continue;
    }
    count += 1;
    index += 1;
  }
  return count;
}

export function frameBlock(content: string): string {
  const lines = content.split("\n");
  const width = lines.reduce((max, line) => Math.max(max, visibleLength(line)), 0);
  const top = `┌${"─".repeat(width + 2)}┐`;
  const bottom = `└${"─".repeat(width + 2)}┘`;
  const body = lines.map((line) => {
    const pad = width - visibleLength(line);
    return `│ ${line}${" ".repeat(Math.max(0, pad))} │`;
  });
  return [top, ...body, bottom].join("\n");
}

// ── Equity chart with F&G overlay and trade markers ───────────────────────

export interface EquityChartConfig {
  strategySeries: number[];
  buyAndHoldSeries: number[];
  strategyDates: string[];
  fearGreedSeries?: number[];
  useColors: boolean;
  height?: number;
}

function normalizeFearGreed(fearGreed: number[], equityMin: number, equityMax: number): number[] {
  const range = equityMax - equityMin || 1;
  return fearGreed.map((fg) => equityMin + (fg / 100) * range);
}

/** Returns the position (0-indexed) of the first plot character after the y-axis label. */
function detectPlotStart(chartLines: string[]): number {
  for (const line of chartLines) {
    const idx = line.indexOf("┼");
    if (idx >= 0) return idx + 1;
    const idx2 = line.indexOf("┤");
    if (idx2 >= 0) return idx2 + 1;
  }
  return 0;
}

/** Append right-axis F&G labels (0, 25, 50, 75, 100) to each chart line. */
function appendFearGreedAxis(chartLines: string[], height: number, useColors: boolean): string[] {
  const colorize = (text: string, code: string) =>
    useColors ? `\u001B[${code}m${text}\u001B[0m` : text;
  const maxVisLen = chartLines.reduce((max, l) => Math.max(max, visibleLength(l)), 0);

  return chartLines.map((line, rowIndex) => {
    const fg = Math.round(100 - (rowIndex / height) * 100);
    const isLabel = fg % 25 === 0;
    const pad = " ".repeat(Math.max(0, maxVisLen - visibleLength(line)));
    const separator = colorize(" │", "90");
    const label = isLabel ? colorize(` ${String(fg).padStart(3)}`, "90") : "";
    return `${line}${pad}${separator}${label}`;
  });
}

/**
 * Find the nearest column in the compressed date array for a given trade date.
 * Returns -1 if the trade date is out of range.
 */
function findNearestColumn(tradeDate: string, compressedDates: string[]): number {
  if (compressedDates.length === 0) return -1;
  let lo = 0;
  let hi = compressedDates.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((compressedDates[mid] ?? "") < tradeDate) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  // lo points to the first element >= tradeDate; compare with lo-1
  if (lo > 0) {
    const before = compressedDates[lo - 1]!;
    const after = compressedDates[lo]!;
    lo = tradeDate.localeCompare(after) < tradeDate.localeCompare(before) ? lo : lo - 1;
  }
  return lo;
}

/** Build a trade-marker row string (same width as chart plot area). */
function buildTradeMarkerRow(
  trades: Trade[],
  compressedDates: string[],
  plotStart: number,
  useColors: boolean
): string {
  const colorize = (text: string, code: string) =>
    useColors ? `\u001B[${code}m${text}\u001B[0m` : text;
  const cells = Array.from<string>({ length: compressedDates.length }).fill(" ");
  for (const trade of trades) {
    const col = findNearestColumn(trade.date, compressedDates);
    if (col < 0 || col >= cells.length) continue;
    const marker = trade.action === "buy" ? "▲" : "▼";
    const color = trade.action === "buy" ? "32" : "91";
    cells[col] = colorize(marker, color);
  }
  return `${" ".repeat(plotStart)}${cells.join("")}`;
}

export function renderEquityChart(config: EquityChartConfig): string {
  const {
    strategySeries,
    buyAndHoldSeries,
    fearGreedSeries,
    useColors,
    height = GRAPH_HEIGHT
  } = config;

  const width = Math.min(strategySeries.length, buyAndHoldSeries.length);
  if (width === 0) return "";

  const strategy = strategySeries.slice(0, width);
  const buyAndHold = buyAndHoldSeries.slice(0, width);

  // Stack order: F&G index (bottom) → buy & hold (middle) → strategy (top, most visible).
  const seriesForPlot: number[][] = [];
  const colors: string[] | undefined = useColors ? [] : undefined;

  if (fearGreedSeries && fearGreedSeries.length >= width) {
    const allEquity = [...strategy, ...buyAndHold];
    const eMin = Math.min(...allEquity);
    const eMax = Math.max(...allEquity);
    const normalizedFG = normalizeFearGreed(fearGreedSeries.slice(0, width), eMin, eMax);
    seriesForPlot.push(normalizedFG);
    colors?.push(COLOR_FEAR_AND_GREED); // cyan
  }

  seriesForPlot.push(buyAndHold, strategy);
  colors?.push(COLOR_BUY_AND_HOLD, COLOR_STRATEGY);

  const chartStr = asciichart.plot(seriesForPlot, { height, colors });

  let chartLines = chartStr.split("\n");
  if (fearGreedSeries) {
    chartLines = appendFearGreedAxis(chartLines, height, useColors);
  }

  return chartLines.join("\n");
}

/**
 * Builds a trade-marker row (▲ buy / ▼ sell) aligned to the plot area.
 * Pass the chart string produced by renderEquityChart so the plot-start offset
 * can be detected automatically.
 */
export function renderTradeMarkerRow(
  chartStr: string,
  trades: Trade[],
  compressedDates: string[],
  useColors: boolean
): string {
  const chartLines = chartStr.split("\n");
  const plotStart = detectPlotStart(chartLines);
  return buildTradeMarkerRow(trades, compressedDates, plotStart, useColors);
}
