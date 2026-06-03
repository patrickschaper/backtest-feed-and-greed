import { describe, expect, it } from "vitest";
import {
  compressArrayForWidth,
  compressSeriesForWidth,
  frameBlock,
  GRAPH_HEIGHT,
  renderEquityChart,
  renderMergedEquityGraph,
  renderTimeAxis,
  renderTradeMarkerRow,
  resolveGraphWidth
} from "../src/utils/graph.js";

describe("graph sizing", () => {
  it("uses fixed graph height of 30", () => {
    expect(GRAPH_HEIGHT).toBe(30);
  });

  it("uses terminal width when available", () => {
    expect(resolveGraphWidth(140)).toBe(118);
  });

  it("uses minimum width for narrow terminals", () => {
    expect(resolveGraphWidth(15)).toBe(20);
  });

  it("uses fallback width when terminal width is unavailable", () => {
    expect(resolveGraphWidth(undefined)).toBe(60);
  });

  it("compresses series to fit terminal-derived width", () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    const compressed = compressSeriesForWidth(values, 20);
    expect(compressed).toHaveLength(20);
    expect(compressed[0]).toBe(1);
    expect(compressed.at(-1)).toBe(100);
  });

  it("compresses generic arrays to width", () => {
    const values = ["a", "b", "c", "d", "e"];
    const compressed = compressArrayForWidth(values, 3);
    expect(compressed).toEqual(["a", "c", "e"]);
  });

  it("renders merged graph using configured height", () => {
    const strategy = Array.from({ length: 50 }, (_, index) => 100 + index);
    const buyAndHold = Array.from({ length: 50 }, (_, index) => 100 + index / 2);
    const graph = renderMergedEquityGraph(strategy, buyAndHold, false, GRAPH_HEIGHT);
    expect(graph.split("\n")).toHaveLength(GRAPH_HEIGHT + 1);
  });

  it("renders axis in old chart style", () => {
    const strategy = [100, 110, 120, 130];
    const buyAndHold = [100, 105, 110, 115];
    const graph = renderMergedEquityGraph(strategy, buyAndHold, false, 8);
    expect(graph).toContain("┤");
  });

  it("renders strategy and buy-and-hold colors when enabled", () => {
    const strategy = [100, 130, 140, 120];
    const buyAndHold = [140, 120, 100, 90];
    const graph = renderMergedEquityGraph(strategy, buyAndHold, true, 10);
    expect(graph).toContain("\u001B[33m"); // yellow for strategy
    expect(graph).toContain("\u001B[");
  });

  it("prefers strategy styling on overlap", () => {
    const strategy = [100, 110, 120, 130];
    const buyAndHold = [100, 110, 120, 130];
    const graph = renderMergedEquityGraph(strategy, buyAndHold, true, 10);
    expect(graph).toContain("\u001B[33m"); // yellow for strategy
  });

  it("renders a time axis with start and end labels", () => {
    const strategy = Array.from({ length: 12 }, (_, index) => 100 + index * 2);
    const buyAndHold = Array.from({ length: 12 }, (_, index) => 98 + index);
    const labels = Array.from(
      { length: 12 },
      (_, index) => `2026-01-${String(index + 1).padStart(2, "0")}`
    );
    const graph = renderMergedEquityGraph(strategy, buyAndHold, false, 8);
    const axis = renderTimeAxis(graph, labels);
    expect(axis).toContain("└");
    expect(axis).toContain("01-01");
    expect(axis).toContain("01-12");
  });

  it("frames chart output with a box", () => {
    const framed = frameBlock("line1\nline2");
    expect(framed).toContain("┌");
    expect(framed).toContain("┐");
    expect(framed).toContain("└");
    expect(framed).toContain("┘");
    expect(framed).toContain("│ line1");
  });
});

describe("renderEquityChart", () => {
  const strategy = Array.from({ length: 30 }, (_, i) => 10000 + i * 10);
  const buyAndHold = Array.from({ length: 30 }, (_, i) => 10000 + i * 5);
  const dates = Array.from({ length: 30 }, (_, i) => `2026-01-${String(i + 1).padStart(2, "0")}`);

  it("renders a chart string with the correct number of lines", () => {
    const result = renderEquityChart({
      strategySeries: strategy,
      buyAndHoldSeries: buyAndHold,
      strategyDates: dates,
      useColors: false,
      height: 10
    });
    const lines = result.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(10);
  });

  it("appends right-axis F&G labels when fearGreedSeries provided", () => {
    const fearGreed = Array.from({ length: 30 }, (_, i) => 30 + i);
    const result = renderEquityChart({
      strategySeries: strategy,
      buyAndHoldSeries: buyAndHold,
      strategyDates: dates,
      fearGreedSeries: fearGreed,
      useColors: false,
      height: 10
    });
    expect(result).toContain("│");
    // Should show at least one F&G milestone label (0, 25, 50, 75, 100)
    const hasMilestone = ["  0", " 25", " 50", " 75", "100"].some((label) =>
      result.includes(label)
    );
    expect(hasMilestone).toBe(true);
  });

  it("renderTradeMarkerRow places ▲/▼ after time axis", () => {
    const trades = [
      { date: "2026-01-05", action: "buy" as const, equityAfterTrade: 10050 },
      { date: "2026-01-15", action: "sell" as const, equityAfterTrade: 10200 }
    ];
    const chart = renderEquityChart({
      strategySeries: strategy,
      buyAndHoldSeries: buyAndHold,
      strategyDates: dates,
      useColors: false,
      height: 10
    });
    const markerRow = renderTradeMarkerRow(chart, trades, dates, false);
    expect(markerRow).toContain("▲");
    expect(markerRow).toContain("▼");
    // Markers must not appear in the chart itself
    expect(chart).not.toContain("▲");
    expect(chart).not.toContain("▼");
  });

  it("returns empty string for empty series", () => {
    const result = renderEquityChart({
      strategySeries: [],
      buyAndHoldSeries: [],
      strategyDates: [],
      useColors: false
    });
    expect(result).toBe("");
  });
});
