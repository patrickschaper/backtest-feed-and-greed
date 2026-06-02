export type StrategySignal = "buy" | "sell" | "hold";

export interface ThresholdConfig {
  buyThreshold: number;
  sellThreshold: number;
}

export function signalFromFearGreed(
  previousValue: number,
  currentValue: number,
  config: ThresholdConfig
): StrategySignal {
  if (previousValue < config.buyThreshold && currentValue > config.buyThreshold) {
    return "buy";
  }
  if (previousValue > config.sellThreshold && currentValue < config.sellThreshold) {
    return "sell";
  }
  return "hold";
}
