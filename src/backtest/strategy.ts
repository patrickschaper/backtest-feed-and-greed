export type StrategySignal = "buy" | "sell" | "hold";

export interface ThresholdConfig {
  buyThresholds: number[];
  sellThresholds: number[];
}

export interface StrategyDecision {
  action: StrategySignal;
  fraction: number;
}

export function signalFromFearGreed(
  previousValue: number,
  currentValue: number,
  config: ThresholdConfig
): StrategyDecision {
  const buyCount = config.buyThresholds.filter((t) => previousValue < t && currentValue > t).length;
  if (buyCount > 0) {
    return { action: "buy", fraction: buyCount / config.buyThresholds.length };
  }

  const sellCount = config.sellThresholds.filter(
    (t) => previousValue > t && currentValue < t
  ).length;
  if (sellCount > 0) {
    return { action: "sell", fraction: sellCount / config.sellThresholds.length };
  }

  return { action: "hold", fraction: 0 };
}
