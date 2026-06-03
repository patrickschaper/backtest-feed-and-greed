import { describe, expect, it } from "vitest";
import { formatResult } from "../src/app.js";
import type { Optimization } from "../src/backtest/optimize.js";
import type { BacktestResult, SymbolInfo } from "../src/types.js";

function createResult(): BacktestResult {
  return {
    mode: "symbols",
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
    const graphIndex = output.indexOf("Equity Curve (Manual strategy vs Buy & Hold)");
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

  it("places legend under chart (before table) and CAGR note under table", () => {
    const output = formatResult(createResult());
    const chartHeaderIndex = output.indexOf("Equity Curve (Manual strategy vs Buy & Hold)");
    const legendIndex = output.indexOf("Legend:");
    const tableIndex = output.indexOf("Scenario");
    const cagrNoteIndex = output.indexOf("CAGR = Compound Annual Growth Rate.");
    expect(legendIndex).toBeGreaterThan(chartHeaderIndex);
    expect(legendIndex).toBeLessThan(tableIndex);
    expect(cagrNoteIndex).toBeGreaterThan(tableIndex);
  });

  it("shows Buy & Hold as the top row above Strategy and has no Delta row", () => {
    const output = formatResult(createResult());
    const tableSlice = output.slice(output.lastIndexOf("Scenario"));
    expect(tableSlice).not.toContain("Delta");
    const buyHoldIndex = tableSlice.indexOf("Buy & Hold");
    const strategyIndex = tableSlice.indexOf("Manual strategy");
    expect(buyHoldIndex).toBeGreaterThan(-1);
    expect(strategyIndex).toBeGreaterThan(-1);
    expect(buyHoldIndex).toBeLessThan(strategyIndex);
  });

  it("appends inline signed deltas to the Strategy row", () => {
    const output = formatResult(createResult());
    // Fixture deltas: finalEquity 100, totalReturnPct 1, cagrPct 1
    expect(output).toContain("(\u0394+100.00)");
    expect(output).toContain("(\u0394+1.00%)");
  });

  it("includes Buy and Sell columns and shows given thresholds on the Strategy row", () => {
    const output = formatResult(createResult(), {
      buyThresholds: [55],
      sellThresholds: [45]
    });
    const tableSlice = output.slice(output.lastIndexOf("Scenario"));
    expect(tableSlice).toContain("Buy");
    expect(tableSlice).toContain("Sell");
    // Thresholds rendered in the Strategy row
    expect(tableSlice).toContain("55");
    expect(tableSlice).toContain("45");
  });

  it("adds optimizer rows only when optimization is provided, sorted by total return", () => {
    const withoutOpt = formatResult(createResult());
    expect(withoutOpt).not.toContain("Max Return");
    expect(withoutOpt).not.toContain("Optimizer rows");

    const optimization: Optimization = {
      combosTested: 10201,
      results: [
        {
          key: "return",
          label: "Max Return",
          considers: "return only",
          score: 12,
          best: {
            buyThreshold: 30,
            sellThreshold: 60,
            finalEquity: 11200,
            totalReturnPct: 12,
            cagrPct: 6,
            maxDrawdownPct: 8,
            winRatePct: 70,
            tradeCount: 4
          }
        }
      ]
    };
    const withOpt = formatResult(createResult(), { optimization });
    const tableSlice = withOpt.slice(withOpt.lastIndexOf("Scenario"));
    // Fixture: Strategy return 4%, Max Return 12% -> Max Return sorts above Strategy.
    const strategyIndex = tableSlice.indexOf("Manual strategy");
    const optIndex = tableSlice.indexOf("Max Return");
    expect(optIndex).toBeGreaterThan(-1);
    expect(optIndex).toBeLessThan(strategyIndex);
    expect(tableSlice).toContain("11200.00");
    expect(withOpt).toContain("Optimizer rows");
    expect(withOpt).toContain("10201 exhaustive combinations");
  });

  it("pins Buy & Hold on top and sorts other rows by total return descending", () => {
    const optimization: Optimization = {
      combosTested: 10201,
      results: [
        {
          key: "returnWinRate",
          label: "Low Opt",
          considers: "win rate",
          score: 1,
          best: {
            buyThreshold: 20,
            sellThreshold: 40,
            finalEquity: 10050,
            totalReturnPct: 0.5,
            cagrPct: 0.5,
            maxDrawdownPct: 3,
            winRatePct: 60,
            tradeCount: 2
          }
        },
        {
          key: "return",
          label: "High Opt",
          considers: "return only",
          score: 50,
          best: {
            buyThreshold: 25,
            sellThreshold: 55,
            finalEquity: 15000,
            totalReturnPct: 50,
            cagrPct: 20,
            maxDrawdownPct: 10,
            winRatePct: 80,
            tradeCount: 5
          }
        }
      ]
    };
    const output = formatResult(createResult(), { optimization });
    const tableSlice = output.slice(output.lastIndexOf("Scenario"));
    // Buy & Hold (3%) pinned top; then High Opt (50%) > Strategy (4%) > Low Opt (0.5%).
    const buyHold = tableSlice.indexOf("Buy & Hold");
    const high = tableSlice.indexOf("High Opt");
    const strategy = tableSlice.indexOf("Manual strategy");
    const low = tableSlice.indexOf("Low Opt");
    expect(buyHold).toBeLessThan(high);
    expect(high).toBeLessThan(strategy);
    expect(strategy).toBeLessThan(low);
  });

  it("appends inline deltas (vs Buy & Hold) to optimizer rows", () => {
    const optimization: Optimization = {
      combosTested: 10201,
      results: [
        {
          key: "return",
          label: "Max Return",
          considers: "return only",
          score: 12,
          best: {
            buyThreshold: 30,
            sellThreshold: 60,
            finalEquity: 11200,
            totalReturnPct: 12,
            cagrPct: 6,
            maxDrawdownPct: 8,
            winRatePct: 70,
            tradeCount: 4
          }
        }
      ]
    };
    // Fixture Buy & Hold: finalEquity 10300, return 3%, cagr 3%
    const output = formatResult(createResult(), { optimization });
    expect(output).toContain("(\u0394+900.00)");
    expect(output).toContain("(\u0394+9.00%)");
    expect(output).toContain("(\u0394+3.00%)");
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
