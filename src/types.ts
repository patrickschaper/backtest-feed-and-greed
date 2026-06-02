export type BacktestMode = "portfolio" | "single";
export type PriceMode = "yahoo" | "tradingview" | "hybrid";

export interface SymbolInfo {
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  source: string;
  startPrice: number;
  endPrice: number;
  capitalAllocated: number;
  capitalWeightPct: number;
}

export interface PieHolding {
  symbol: string;
  weight: number;
}

export interface FearGreedPoint {
  date: string;
  value: number;
}

export interface DailyPricePoint {
  date: string;
  close: number;
}

export interface TimelinePoint {
  date: string;
  fearGreed: number;
  prices: Record<string, number>;
}

export interface Trade {
  date: string;
  action: "buy" | "sell";
  equityAfterTrade: number;
}

export interface BacktestResult {
  mode: BacktestMode;
  startDate: string;
  endDate: string;
  timelineDays: number;
  initialCash: number;
  trades: Trade[];
  finalEquity: number;
  totalReturnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  tradeCount: number;
  winRatePct: number;
  equityCurve: Array<{ date: string; equity: number }>;
  fearGreedSeries: number[];
  strategy: BacktestPerformanceSummary;
  comparison: BacktestComparison;
}

export interface BacktestPerformanceSummary {
  finalEquity: number;
  totalReturnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  tradeCount: number;
  winRatePct: number;
}

export interface BacktestComparison {
  buyAndHold: BacktestPerformanceSummary;
  buyAndHoldEquityCurve: Array<{ date: string; equity: number }>;
  delta: {
    finalEquity: number;
    totalReturnPct: number;
    cagrPct: number;
    winRatePct: number;
  };
}
