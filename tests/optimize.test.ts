import { describe, expect, it } from "vitest";
import { runOptimization, selectBest } from "../src/backtest/optimize.js";
import type { ComboMetrics } from "../src/backtest/optimize.js";

function combo(overrides: Partial<ComboMetrics>): ComboMetrics {
  return {
    buyThreshold: 0,
    sellThreshold: 0,
    totalReturnPct: 0,
    cagrPct: 0,
    maxDrawdownPct: 0,
    winRatePct: 0,
    tradeCount: 0,
    ...overrides
  };
}

function pick(combos: ComboMetrics[], key: string): ComboMetrics {
  const result = selectBest(combos).find((r) => r.key === key);
  if (!result) throw new Error(`missing objective ${key}`);
  return result.best;
}

describe("selectBest scoring", () => {
  it("Max Return picks the highest total return regardless of drawdown/win rate", () => {
    const combos = [
      combo({ buyThreshold: 1, totalReturnPct: 10, maxDrawdownPct: 1, winRatePct: 100 }),
      combo({ buyThreshold: 2, totalReturnPct: 50, maxDrawdownPct: 40, winRatePct: 50 }),
      combo({ buyThreshold: 3, totalReturnPct: 30, maxDrawdownPct: 5, winRatePct: 100 })
    ];
    expect(pick(combos, "return").totalReturnPct).toBe(50);
  });

  it("Return / Drawdown prefers high return-to-drawdown ratio", () => {
    const combos = [
      combo({ buyThreshold: 1, totalReturnPct: 50, maxDrawdownPct: 40 }), // 1.25
      combo({ buyThreshold: 2, totalReturnPct: 20, maxDrawdownPct: 5 }) // 4.0
    ];
    expect(pick(combos, "returnDrawdown").buyThreshold).toBe(2);
  });

  it("Return / Drawdown treats zero-drawdown positive return as ideal", () => {
    const combos = [
      combo({ buyThreshold: 1, totalReturnPct: 80, maxDrawdownPct: 10 }), // 8
      combo({ buyThreshold: 2, totalReturnPct: 5, maxDrawdownPct: 0 }) // Infinity
    ];
    expect(pick(combos, "returnDrawdown").buyThreshold).toBe(2);
  });

  it("Return x Win Rate weights return by win rate", () => {
    const combos = [
      combo({ buyThreshold: 1, totalReturnPct: 40, winRatePct: 0 }), // 0
      combo({ buyThreshold: 2, totalReturnPct: 30, winRatePct: 100 }) // 30
    ];
    expect(pick(combos, "returnWinRate").buyThreshold).toBe(2);
  });

  it("gates negative returns: never prefers a worse return via larger drawdown", () => {
    const combos = [
      combo({ buyThreshold: 1, totalReturnPct: -1, maxDrawdownPct: 50 }),
      combo({ buyThreshold: 2, totalReturnPct: -20, maxDrawdownPct: 1 })
    ];
    // Ungated ratio would pick -20/1 = -20 > -1/50 = -0.02; gating picks least-bad return.
    expect(pick(combos, "returnDrawdown").totalReturnPct).toBe(-1);
  });

  it("gates negative returns for win-rate objective too", () => {
    const combos = [
      combo({ buyThreshold: 1, totalReturnPct: -50, winRatePct: 0 }),
      combo({ buyThreshold: 2, totalReturnPct: -1, winRatePct: 100 })
    ];
    expect(pick(combos, "returnWinRate").totalReturnPct).toBe(-1);
  });

  it("breaks score ties by higher return then lower drawdown", () => {
    const combos = [
      combo({ buyThreshold: 1, totalReturnPct: 10, maxDrawdownPct: 5, winRatePct: 100 }),
      combo({ buyThreshold: 2, totalReturnPct: 10, maxDrawdownPct: 2, winRatePct: 100 })
    ];
    // Same Return x WinRate score (10); tie-break prefers lower drawdown.
    expect(pick(combos, "returnWinRate").buyThreshold).toBe(2);
  });

  it("returns one result per objective", () => {
    const results = selectBest([combo({ totalReturnPct: 5 })]);
    expect(results.map((r) => r.key)).toEqual([
      "return",
      "returnDrawdown",
      "returnWinRate",
      "combined"
    ]);
  });
});

describe("runOptimization", () => {
  it("exhaustively tests the full integer grid and returns 4 objective winners", () => {
    const timeline = [
      { date: "2026-01-01", fearGreed: 60, prices: { AAPL: 100 } },
      { date: "2026-01-02", fearGreed: 50, prices: { AAPL: 110 } },
      { date: "2026-01-03", fearGreed: 40, prices: { AAPL: 90 } }
    ];

    const optimization = runOptimization(timeline, {
      mode: "symbols",
      initialCash: 10_000,
      symbolWeights: { AAPL: 1 },
      minThreshold: 0,
      maxThreshold: 100
    });

    expect(optimization.combosTested).toBe(101 * 101);
    expect(optimization.results).toHaveLength(4);
    for (const result of optimization.results) {
      expect(result.best.buyThreshold).toBeGreaterThanOrEqual(0);
      expect(result.best.buyThreshold).toBeLessThanOrEqual(100);
      expect(result.best.sellThreshold).toBeGreaterThanOrEqual(0);
      expect(result.best.sellThreshold).toBeLessThanOrEqual(100);
    }
  });
});
