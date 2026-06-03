import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/backtest/engine.js";
import { signalFromFearGreed } from "../src/backtest/strategy.js";

describe("signalFromFearGreed", () => {
  it("returns buy only on strict upward crossing of buy threshold", () => {
    expect(signalFromFearGreed(54, 56, { buyThresholds: [55], sellThresholds: [45] })).toEqual({
      action: "buy",
      fraction: 1
    });
    expect(signalFromFearGreed(55, 56, { buyThresholds: [55], sellThresholds: [45] })).toEqual({
      action: "hold",
      fraction: 0
    });
    expect(signalFromFearGreed(54, 55, { buyThresholds: [55], sellThresholds: [45] })).toEqual({
      action: "hold",
      fraction: 0
    });
  });

  it("returns sell only on strict downward crossing of sell threshold", () => {
    expect(signalFromFearGreed(46, 44, { buyThresholds: [55], sellThresholds: [45] })).toEqual({
      action: "sell",
      fraction: 1
    });
    expect(signalFromFearGreed(45, 44, { buyThresholds: [55], sellThresholds: [45] })).toEqual({
      action: "hold",
      fraction: 0
    });
    expect(signalFromFearGreed(46, 45, { buyThresholds: [55], sellThresholds: [45] })).toEqual({
      action: "hold",
      fraction: 0
    });
  });

  it("returns hold when there is no strict crossing", () => {
    expect(signalFromFearGreed(50, 52, { buyThresholds: [55], sellThresholds: [45] })).toEqual({
      action: "hold",
      fraction: 0
    });
  });

  it("returns partial buy fraction when 2 of 3 buy thresholds are crossed", () => {
    // prev=40, curr=56: crosses 45 and 55 but not 70
    expect(
      signalFromFearGreed(40, 56, { buyThresholds: [45, 55, 70], sellThresholds: [30] })
    ).toEqual({ action: "buy", fraction: 2 / 3 });
  });

  it("returns partial sell fraction when 2 of 3 sell thresholds are crossed", () => {
    // prev=70, curr=44: crosses 65 and 50 but not 30
    expect(
      signalFromFearGreed(70, 44, { buyThresholds: [80], sellThresholds: [65, 50, 30] })
    ).toEqual({ action: "sell", fraction: 2 / 3 });
  });

  it("returns fraction=1 when all thresholds are crossed in one move", () => {
    expect(
      signalFromFearGreed(20, 80, { buyThresholds: [30, 45, 55], sellThresholds: [60] })
    ).toEqual({ action: "buy", fraction: 1 });
  });
});

describe("runBacktest comparison output", () => {
  it("includes buy-and-hold comparison metrics and forced first/last trades", () => {
    const timeline = [
      { date: "2026-01-01", fearGreed: 60, prices: { AAPL: 100 } },
      { date: "2026-01-02", fearGreed: 50, prices: { AAPL: 110 } },
      { date: "2026-01-03", fearGreed: 40, prices: { AAPL: 90 } }
    ];

    const result = runBacktest(timeline, {
      mode: "single",
      buyThresholds: [55],
      sellThresholds: [45],
      initialCash: 10_000,
      symbolWeights: { AAPL: 1 }
    });

    expect(result.trades[0]?.action).toBe("buy");
    expect(result.trades[0]?.date).toBe("2026-01-01");
    expect(result.trades.at(-1)?.action).toBe("sell");
    expect(result.trades.at(-1)?.date).toBe("2026-01-03");
    expect(result.strategy.finalEquity).toBeCloseTo(9000, 2);
    expect(result.comparison.buyAndHold.finalEquity).toBeCloseTo(9000, 2);
    expect(result.comparison.delta.finalEquity).toBeCloseTo(0, 2);
    expect(result.comparison.buyAndHoldEquityCurve).toHaveLength(timeline.length);
    expect(result.comparison.buyAndHoldEquityCurve[0]?.equity).toBeCloseTo(10000, 2);
    expect(result.comparison.buyAndHoldEquityCurve.at(-1)?.equity).toBeCloseTo(9000, 2);
  });

  it("does not add a duplicate terminal sell when already out of market", () => {
    const timeline = [
      { date: "2026-01-01", fearGreed: 50, prices: { AAPL: 100 } },
      { date: "2026-01-02", fearGreed: 40, prices: { AAPL: 110 } },
      { date: "2026-01-03", fearGreed: 50, prices: { AAPL: 90 } },
      { date: "2026-01-04", fearGreed: 50, prices: { AAPL: 95 } }
    ];

    const result = runBacktest(timeline, {
      mode: "single",
      buyThresholds: [55],
      sellThresholds: [45],
      initialCash: 10_000,
      symbolWeights: { AAPL: 1 }
    });

    const sellTrades = result.trades.filter((trade) => trade.action === "sell");
    expect(sellTrades).toHaveLength(1);
    expect(sellTrades[0]?.date).toBe("2026-01-03");
  });
});
