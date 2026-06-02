import { describe, expect, it } from "vitest";
import { formatResult } from "../src/app.js";
import type { BacktestResult, SymbolInfo } from "../src/types.js";

function createResult(): BacktestResult {
  return {
    mode: "single",
    startDate: "2026-01-01",
    endDate: "2026-01-05",
    timelineDays: 5,
    initialCash: 10000,
    trades: [
      { date: "2026-01-02", action: "buy", equityAfterTrade: 10000 },
      { date: "2026-01-04", action: "sell", equityAfterTrade: 10400 }
    ],
    finalEquity: 10400,
    totalReturnPct: 4,
    cagrPct: 4,
    maxDrawdownPct: 1,
    tradeCount: 2,
    winRatePct: 100,
    equityCurve: [
      { date: "2026-01-01", equity: 10000 },
      { date: "2026-01-02", equity: 10100 },
      { date: "2026-01-03", equity: 10200 },
      { date: "2026-01-04", equity: 10300 },
      { date: "2026-01-05", equity: 10400 }
    ],
    fearGreedSeries: [50, 55, 60, 65, 70],
    strategy: {
      finalEquity: 10400,
      totalReturnPct: 4,
      cagrPct: 4,
      maxDrawdownPct: 1,
      tradeCount: 2,
      winRatePct: 100
    },
    comparison: {
      buyAndHold: {
        finalEquity: 10300,
        totalReturnPct: 3,
        cagrPct: 3,
        maxDrawdownPct: 2,
        tradeCount: 1,
        winRatePct: 0
      },
      buyAndHoldEquityCurve: [
        { date: "2026-01-01", equity: 10000 },
        { date: "2026-01-02", equity: 10050 },
        { date: "2026-01-03", equity: 10100 },
        { date: "2026-01-04", equity: 10200 },
        { date: "2026-01-05", equity: 10300 }
      ],
      delta: {
        finalEquity: 100,
        totalReturnPct: 1,
        cagrPct: 1,
        winRatePct: 100
      }
    }
  };
}

describe("formatResult", () => {
  it("renders merged graph above table", () => {
    const output = formatResult(createResult());
    const graphIndex = output.indexOf("Equity Curve (Strategy vs Buy & Hold)");
    const timeAxisIndex = output.indexOf("01-01");
    const tableIndex = output.indexOf("Scenario");
    expect(graphIndex).toBeGreaterThan(-1);
    expect(timeAxisIndex).toBeGreaterThan(-1);
    expect(tableIndex).toBeGreaterThan(-1);
    expect(graphIndex).toBeLessThan(tableIndex);
    expect(timeAxisIndex).toBeLessThan(tableIndex);
  });

  it("uses short CAGR header and dash for buy-and-hold win rate", () => {
    const output = formatResult(createResult());
    expect(output).toContain("CAGR");
    expect(output).not.toContain("Compound Annual Growth Rate (CAGR)");
    expect(output).toContain("Buy & Hold");
    expect(output).toContain(" - ");
  });

  it("places legend directly under table and excludes win rate from delta", () => {
    const output = formatResult(createResult());
    const tableIndex = output.indexOf("└");
    const legendIndex = output.indexOf("Legend: Strategy=green, Buy & Hold=yellow");
    const deltaIndex = output.indexOf("Delta (Strategy - Buy & Hold):");
    const deltaLine = output
      .split("\n")
      .find((line) => line.startsWith("Delta (Strategy - Buy & Hold):"));
    expect(legendIndex).toBeGreaterThan(tableIndex);
    expect(legendIndex).toBeLessThan(deltaIndex);
    expect(deltaLine).toBeDefined();
    expect(deltaLine).not.toContain("Win Rate");
  });

  it("renders symbol table before chart when symbolInfos provided", () => {
    const symbolInfos: SymbolInfo[] = [
      {
        symbol: "AAPL",
        name: "Apple Inc.",
        exchange: "NASDAQ Global Select, New York (US)",
        currency: "USD",
        source: "yahoo",
        startPrice: 150,
        endPrice: 180,
        capitalAllocated: 10000,
        capitalWeightPct: 100
      }
    ];
    const output = formatResult(createResult(), { symbolInfos });
    const holdingsIndex = output.indexOf("Holdings");
    const equityIndex = output.indexOf("Equity Curve");
    expect(holdingsIndex).toBeGreaterThan(-1);
    expect(equityIndex).toBeGreaterThan(-1);
    expect(holdingsIndex).toBeLessThan(equityIndex);
    expect(output).toContain("AAPL");
    expect(output).toContain("Apple Inc.");
    // Total row appears in holdings
    expect(output).toContain("Total");
  });

  it("omits symbol table when no symbolInfos provided", () => {
    const output = formatResult(createResult());
    expect(output).not.toContain("Holdings");
  });

  it("shows Start Equity column in performance table", () => {
    const output = formatResult(createResult());
    expect(output).toContain("Start Equity");
    expect(output).toContain("10000.00");
  });

  it("shows Total row with summed capital in holdings table", () => {
    const symbolInfos: SymbolInfo[] = [
      {
        symbol: "AAPL",
        name: "Apple Inc.",
        exchange: "NASDAQ Global Select, New York (US)",
        currency: "USD",
        source: "yahoo",
        startPrice: 150,
        endPrice: 180,
        capitalAllocated: 5000,
        capitalWeightPct: 50
      },
      {
        symbol: "MSFT",
        name: "Microsoft Corp.",
        exchange: "NASDAQ Global Select, New York (US)",
        currency: "USD",
        source: "yahoo",
        startPrice: 300,
        endPrice: 350,
        capitalAllocated: 5000,
        capitalWeightPct: 50
      }
    ];
    const output = formatResult(createResult(), { symbolInfos });
    expect(output).toContain("Total");
    expect(output).toContain("10000.00");
    expect(output).toContain("100.0%");
  });
});
