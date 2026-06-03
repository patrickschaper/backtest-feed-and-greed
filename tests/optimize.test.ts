import { describe, expect, it } from "vitest";
import {
  buildLevels,
  computeCombosForRange,
  countSubsetsUpTo3,
  runOptimization,
  runOptimizationSync,
  selectBest,
  subsets
} from "../src/backtest/optimize.js";
import type { ComboMetrics, OptimizeConfig } from "../src/backtest/optimize.js";

function combo(overrides: Partial<ComboMetrics>): ComboMetrics {
  return {
    buyThresholds: [0],
    sellThresholds: [0],
    finalEquity: 0,
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
      combo({ buyThresholds: [1], totalReturnPct: 10, maxDrawdownPct: 1, winRatePct: 100 }),
      combo({ buyThresholds: [2], totalReturnPct: 50, maxDrawdownPct: 40, winRatePct: 50 }),
      combo({ buyThresholds: [3], totalReturnPct: 30, maxDrawdownPct: 5, winRatePct: 100 })
    ];
    expect(pick(combos, "return").totalReturnPct).toBe(50);
  });

  it("Return / Drawdown prefers high return-to-drawdown ratio", () => {
    const combos = [
      combo({ buyThresholds: [1], totalReturnPct: 50, maxDrawdownPct: 40 }), // 1.25
      combo({ buyThresholds: [2], totalReturnPct: 20, maxDrawdownPct: 5 }) // 4.0
    ];
    expect(pick(combos, "returnDrawdown").buyThresholds).toEqual([2]);
  });

  it("Return / Drawdown treats zero-drawdown positive return as ideal", () => {
    const combos = [
      combo({ buyThresholds: [1], totalReturnPct: 80, maxDrawdownPct: 10 }), // 8
      combo({ buyThresholds: [2], totalReturnPct: 5, maxDrawdownPct: 0 }) // Infinity
    ];
    expect(pick(combos, "returnDrawdown").buyThresholds).toEqual([2]);
  });

  it("Return x Win Rate weights return by win rate", () => {
    const combos = [
      combo({ buyThresholds: [1], totalReturnPct: 40, winRatePct: 0 }), // 0
      combo({ buyThresholds: [2], totalReturnPct: 30, winRatePct: 100 }) // 30
    ];
    expect(pick(combos, "returnWinRate").buyThresholds).toEqual([2]);
  });

  it("gates negative returns: never prefers a worse return via larger drawdown", () => {
    const combos = [
      combo({ buyThresholds: [1], totalReturnPct: -1, maxDrawdownPct: 50 }),
      combo({ buyThresholds: [2], totalReturnPct: -20, maxDrawdownPct: 1 })
    ];
    // Ungated ratio would pick -20/1 = -20 > -1/50 = -0.02; gating picks least-bad return.
    expect(pick(combos, "returnDrawdown").totalReturnPct).toBe(-1);
  });

  it("gates negative returns for win-rate objective too", () => {
    const combos = [
      combo({ buyThresholds: [1], totalReturnPct: -50, winRatePct: 0 }),
      combo({ buyThresholds: [2], totalReturnPct: -1, winRatePct: 100 })
    ];
    expect(pick(combos, "returnWinRate").totalReturnPct).toBe(-1);
  });

  it("breaks score ties by higher return then lower drawdown", () => {
    const combos = [
      combo({ buyThresholds: [1], totalReturnPct: 10, maxDrawdownPct: 5, winRatePct: 100 }),
      combo({ buyThresholds: [2], totalReturnPct: 10, maxDrawdownPct: 2, winRatePct: 100 })
    ];
    // Same Return x WinRate score (10); tie-break prefers lower drawdown.
    expect(pick(combos, "returnWinRate").buyThresholds).toEqual([2]);
  });

  it("breaks score+metric ties by fewer thresholds then lexicographic order", () => {
    const combos = [
      combo({ buyThresholds: [10, 20], totalReturnPct: 10, maxDrawdownPct: 5, winRatePct: 100 }),
      combo({ buyThresholds: [5], totalReturnPct: 10, maxDrawdownPct: 5, winRatePct: 100 })
    ];
    // Fully tied on return/drawdown/cagr; prefer the smaller (fewer-element) set.
    expect(pick(combos, "returnWinRate").buyThresholds).toEqual([5]);
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

describe("subset helpers", () => {
  it("yields only sorted, unique size-1..3 subsets in deterministic order", () => {
    expect([...subsets([0, 5, 10], 1, 3)]).toEqual([
      [0],
      [5],
      [10],
      [0, 5],
      [0, 10],
      [5, 10],
      [0, 5, 10]
    ]);
  });

  it("counts size-1..3 subsets without enumerating", () => {
    for (const n of [1, 2, 3, 5, 21]) {
      const levels = Array.from({ length: n }, (_, i) => i);
      expect(countSubsetsUpTo3(n)).toBe([...subsets(levels, 1, 3)].length);
    }
  });

  it("builds ascending unique levels that always include the max", () => {
    expect(buildLevels(0, 100, 5)).toEqual(Array.from({ length: 21 }, (_, i) => i * 5));
    expect(buildLevels(0, 10, 3)).toEqual([0, 3, 6, 9, 10]);
  });
});

const TINY_TIMELINE = [
  { date: "2026-01-01", fearGreed: 60, prices: { AAPL: 100 } },
  { date: "2026-01-02", fearGreed: 50, prices: { AAPL: 110 } },
  { date: "2026-01-03", fearGreed: 40, prices: { AAPL: 90 } }
];

describe("runOptimization", () => {
  it("greedy covers the single-threshold grid and returns 4 multi-threshold winners", () => {
    const optimization = runOptimizationSync(TINY_TIMELINE, {
      mode: "symbols",
      initialCash: 10_000,
      symbolWeights: { AAPL: 1 },
      strategy: "greedy",
      minThreshold: 0,
      maxThreshold: 100
    });

    expect(optimization.strategy).toBe("greedy");
    // Greedy seeds from the exhaustive single grid, then expands.
    expect(optimization.combosTested).toBeGreaterThanOrEqual(101 * 101);
    expect(optimization.results).toHaveLength(4);
    for (const result of optimization.results) {
      expect(result.best.buyThresholds.length).toBeGreaterThanOrEqual(1);
      expect(result.best.buyThresholds.length).toBeLessThanOrEqual(3);
      expect(result.best.sellThresholds.length).toBeGreaterThanOrEqual(1);
      expect(result.best.sellThresholds.length).toBeLessThanOrEqual(3);
      for (const t of [...result.best.buyThresholds, ...result.best.sellThresholds]) {
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThanOrEqual(100);
      }
    }
  });

  it("never returns a worse return than the best single-threshold combo (floor)", () => {
    const config: OptimizeConfig = {
      mode: "symbols",
      initialCash: 10_000,
      symbolWeights: { AAPL: 1 },
      strategy: "greedy",
      minThreshold: 0,
      maxThreshold: 100
    };
    const singleGrid = computeCombosForRange(TINY_TIMELINE, config, 0, 100);
    const bestSingleReturn = selectBest(singleGrid).find((r) => r.key === "return")!.best
      .totalReturnPct;
    const greedy = runOptimizationSync(TINY_TIMELINE, config);
    const greedyReturn = greedy.results.find((r) => r.key === "return")!.best.totalReturnPct;
    expect(greedyReturn).toBeGreaterThanOrEqual(bestSingleReturn);
  });

  it("matches sync output via the parallel worker pool (greedy)", async () => {
    const timeline = Array.from({ length: 40 }, (_, i) => ({
      date: `2026-02-${String(i + 1).padStart(2, "0")}`,
      fearGreed: Math.round(40 + 30 * Math.sin(i / 4)),
      prices: { AAPL: 100 + 5 * Math.sin(i / 3) }
    }));
    const config: OptimizeConfig = {
      mode: "symbols",
      initialCash: 10_000,
      symbolWeights: { AAPL: 1 },
      strategy: "greedy",
      minThreshold: 0,
      maxThreshold: 100
    };

    const parallel = await runOptimization(timeline, config);
    const sync = runOptimizationSync(timeline, config);

    expect(parallel.combosTested).toBe(sync.combosTested);
    expect(parallel.results).toEqual(sync.results);
  });

  it("matches sync output via the parallel worker pool (coarse subsets)", async () => {
    const timeline = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-03-${String(i + 1).padStart(2, "0")}`,
      fearGreed: Math.round(45 + 25 * Math.sin(i / 3)),
      prices: { AAPL: 100 + 8 * Math.sin(i / 2) }
    }));
    const config: OptimizeConfig = {
      mode: "symbols",
      initialCash: 10_000,
      symbolWeights: { AAPL: 1 },
      strategy: "coarse",
      minThreshold: 40,
      maxThreshold: 50
    };

    const parallel = await runOptimization(timeline, config);
    const sync = runOptimizationSync(timeline, config);

    expect(parallel.combosTested).toBe(sync.combosTested);
    expect(parallel.results).toEqual(sync.results);
  });

  it("single-expand returns valid multi-threshold winners", () => {
    const optimization = runOptimizationSync(TINY_TIMELINE, {
      mode: "symbols",
      initialCash: 10_000,
      symbolWeights: { AAPL: 1 },
      strategy: "single-expand",
      minThreshold: 0,
      maxThreshold: 100
    });
    expect(optimization.strategy).toBe("single-expand");
    expect(optimization.results).toHaveLength(4);
    for (const result of optimization.results) {
      expect(result.best.buyThresholds.length).toBeLessThanOrEqual(3);
      expect(result.best.sellThresholds.length).toBeLessThanOrEqual(3);
    }
  });
});
