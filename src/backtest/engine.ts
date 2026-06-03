import { signalFromFearGreed } from "./strategy.js";
import type {
  BacktestMode,
  BacktestPerformanceSummary,
  BacktestResult,
  TimelinePoint,
  Trade
} from "../types.js";

export interface EngineConfig {
  mode: BacktestMode;
  buyThresholds: number[];
  sellThresholds: number[];
  initialCash: number;
  symbolWeights: Record<string, number>;
}

function hasHoldings(holdings: Record<string, number>): boolean {
  return Object.values(holdings).some((shares) => shares > 0);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function computeEquity(
  holdings: Record<string, number>,
  cash: number,
  prices: Record<string, number>
): number {
  const holdingsValue = Object.entries(holdings).reduce((sum, [symbol, shares]) => {
    const price = prices[symbol];
    if (price === undefined) {
      return sum;
    }
    return sum + shares * price;
  }, 0);
  return cash + holdingsValue;
}

function maxDrawdownPercent(equityCurve: Array<{ date: string; equity: number }>): number {
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    if (peak <= 0) {
      continue;
    }
    const drawdown = ((peak - point.equity) / peak) * 100;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }
  return round2(maxDrawdown);
}

function computeWinRate(trades: Trade[]): number {
  const buySellPairs: Array<{ buy: number; sell: number }> = [];
  let lastBuyEquity: number | undefined;
  for (const trade of trades) {
    if (trade.action === "buy") {
      lastBuyEquity = trade.equityAfterTrade;
    }
    if (trade.action === "sell" && lastBuyEquity !== undefined) {
      buySellPairs.push({ buy: lastBuyEquity, sell: trade.equityAfterTrade });
      lastBuyEquity = undefined;
    }
  }
  if (buySellPairs.length === 0) {
    return 0;
  }
  const wins = buySellPairs.filter((pair) => pair.sell > pair.buy).length;
  return round2((wins / buySellPairs.length) * 100);
}

function computePeriodYears(startDate: string, endDate: string): number {
  const elapsedDays = Math.max(
    1,
    (Date.parse(endDate) - Date.parse(startDate)) / (24 * 60 * 60 * 1000)
  );
  return elapsedDays / 365;
}

function buildSummary(
  initialCash: number,
  finalEquity: number,
  years: number,
  equityCurve: Array<{ date: string; equity: number }>,
  trades: Trade[]
): BacktestPerformanceSummary {
  const totalReturnPct = round2(((finalEquity - initialCash) / initialCash) * 100);
  const cagrPct =
    years > 0 ? round2((Math.pow(finalEquity / initialCash, 1 / years) - 1) * 100) : 0;
  return {
    finalEquity,
    totalReturnPct,
    cagrPct,
    maxDrawdownPct: maxDrawdownPercent(equityCurve),
    tradeCount: trades.length,
    winRatePct: computeWinRate(trades)
  };
}

function runBuyAndHoldBaseline(
  timeline: TimelinePoint[],
  initialCash: number,
  symbolWeights: Record<string, number>
): { summary: BacktestPerformanceSummary; equityCurve: Array<{ date: string; equity: number }> } {
  const firstDay = timeline[0]!;
  const holdings: Record<string, number> = {};
  for (const [symbol, weight] of Object.entries(symbolWeights)) {
    const initialPrice = firstDay.prices[symbol];
    if (!initialPrice || initialPrice <= 0) {
      throw new Error(`Missing initial-day price for ${symbol} on ${firstDay.date}`);
    }
    const budget = initialCash * weight;
    holdings[symbol] = budget / initialPrice;
  }

  const equityCurve: Array<{ date: string; equity: number }> = timeline.map((day) => ({
    date: day.date,
    equity: round2(computeEquity(holdings, 0, day.prices))
  }));
  const finalEquity = equityCurve[equityCurve.length - 1]!.equity;
  const years = computePeriodYears(firstDay.date, timeline[timeline.length - 1]!.date);
  const baselineTrades: Trade[] = [
    {
      date: firstDay.date,
      action: "buy",
      equityAfterTrade: round2(initialCash)
    }
  ];

  return {
    summary: buildSummary(initialCash, finalEquity, years, equityCurve, baselineTrades),
    equityCurve
  };
}

export function runBacktest(timeline: TimelinePoint[], config: EngineConfig): BacktestResult {
  if (timeline.length < 2) {
    throw new Error("Need at least 2 aligned timeline days to backtest");
  }

  const holdings: Record<string, number> = {};
  for (const symbol of Object.keys(config.symbolWeights)) {
    holdings[symbol] = 0;
  }

  let cash = config.initialCash;
  const trades: Trade[] = [];
  const equityCurve: Array<{ date: string; equity: number }> = [];
  const fearGreedSeries: number[] = [];

  const firstDay = timeline[0]!;
  for (const [symbol, weight] of Object.entries(config.symbolWeights)) {
    const firstPrice = firstDay.prices[symbol];
    if (!firstPrice || firstPrice <= 0) {
      throw new Error(`Missing first-day price for ${symbol} on ${firstDay.date}`);
    }
    const budget = cash * weight;
    holdings[symbol] = (holdings[symbol] ?? 0) + budget / firstPrice;
  }
  cash = 0;
  trades.push({
    date: firstDay.date,
    action: "buy",
    equityAfterTrade: round2(computeEquity(holdings, cash, firstDay.prices))
  });
  equityCurve.push({
    date: firstDay.date,
    equity: round2(computeEquity(holdings, cash, firstDay.prices))
  });
  fearGreedSeries.push(firstDay.fearGreed);

  for (let index = 1; index < timeline.length - 1; index += 1) {
    const previousDay = timeline[index - 1]!;
    const day = timeline[index]!;
    const nextDay = timeline[index + 1]!;
    const equityToday = computeEquity(holdings, cash, day.prices);
    equityCurve.push({ date: day.date, equity: round2(equityToday) });
    fearGreedSeries.push(day.fearGreed);

    const decision = signalFromFearGreed(previousDay.fearGreed, day.fearGreed, {
      buyThresholds: config.buyThresholds,
      sellThresholds: config.sellThresholds
    });

    if (decision.action === "buy" && cash > 0) {
      const budgetToSpend = cash * decision.fraction;
      for (const [symbol, weight] of Object.entries(config.symbolWeights)) {
        const nextPrice = nextDay.prices[symbol];
        if (!nextPrice || nextPrice <= 0) {
          throw new Error(`Missing next-day price for ${symbol} on ${nextDay.date}`);
        }
        const budget = budgetToSpend * weight;
        holdings[symbol] = (holdings[symbol] ?? 0) + budget / nextPrice;
      }
      cash -= budgetToSpend;
      const equityAfterTrade = computeEquity(holdings, cash, nextDay.prices);
      trades.push({
        date: nextDay.date,
        action: "buy",
        equityAfterTrade: round2(equityAfterTrade)
      });
    } else if (decision.action === "sell" && hasHoldings(holdings)) {
      let liquidation = 0;
      for (const [symbol, shares] of Object.entries(holdings)) {
        const nextPrice = nextDay.prices[symbol];
        if (!nextPrice || nextPrice <= 0) {
          throw new Error(`Missing next-day price for ${symbol} on ${nextDay.date}`);
        }
        const sharesToSell = shares * decision.fraction;
        liquidation += sharesToSell * nextPrice;
        holdings[symbol] = shares - sharesToSell;
      }
      cash += liquidation;
      trades.push({
        date: nextDay.date,
        action: "sell",
        equityAfterTrade: round2(computeEquity(holdings, cash, nextDay.prices))
      });
    }
  }

  const lastDay = timeline[timeline.length - 1]!;
  let finalEquity = round2(computeEquity(holdings, cash, lastDay.prices));
  equityCurve.push({ date: lastDay.date, equity: finalEquity });
  fearGreedSeries.push(lastDay.fearGreed);

  if (hasHoldings(holdings)) {
    let liquidation = 0;
    for (const [symbol, shares] of Object.entries(holdings)) {
      const price = lastDay.prices[symbol];
      if (!price || price <= 0) {
        throw new Error(`Missing final-day price for ${symbol} on ${lastDay.date}`);
      }
      liquidation += shares * price;
      holdings[symbol] = 0;
    }
    cash += liquidation;
    finalEquity = round2(cash);
    trades.push({
      date: lastDay.date,
      action: "sell",
      equityAfterTrade: finalEquity
    });
    equityCurve[equityCurve.length - 1] = { date: lastDay.date, equity: finalEquity };
  }

  const startDate = firstDay.date;
  const endDate = lastDay.date;
  const years = computePeriodYears(startDate, endDate);
  const strategySummary = buildSummary(config.initialCash, finalEquity, years, equityCurve, trades);
  const { summary: buyAndHoldSummary, equityCurve: buyAndHoldEquityCurve } = runBuyAndHoldBaseline(
    timeline,
    config.initialCash,
    config.symbolWeights
  );

  return {
    mode: config.mode,
    startDate,
    endDate,
    timelineDays: timeline.length,
    initialCash: config.initialCash,
    trades,
    finalEquity: strategySummary.finalEquity,
    totalReturnPct: strategySummary.totalReturnPct,
    cagrPct: strategySummary.cagrPct,
    maxDrawdownPct: strategySummary.maxDrawdownPct,
    tradeCount: strategySummary.tradeCount,
    winRatePct: strategySummary.winRatePct,
    equityCurve,
    fearGreedSeries,
    strategy: strategySummary,
    comparison: {
      buyAndHold: buyAndHoldSummary,
      buyAndHoldEquityCurve,
      delta: {
        finalEquity: round2(strategySummary.finalEquity - buyAndHoldSummary.finalEquity),
        totalReturnPct: round2(strategySummary.totalReturnPct - buyAndHoldSummary.totalReturnPct),
        cagrPct: round2(strategySummary.cagrPct - buyAndHoldSummary.cagrPct),
        winRatePct: round2(strategySummary.winRatePct - buyAndHoldSummary.winRatePct)
      }
    }
  };
}
