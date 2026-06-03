import { runBacktest } from "./engine.js";
import type { BacktestMode, TimelinePoint } from "../types.js";

export interface OptimizeConfig {
  mode: BacktestMode;
  initialCash: number;
  symbolWeights: Record<string, number>;
  minThreshold?: number;
  maxThreshold?: number;
}

export interface ComboMetrics {
  buyThreshold: number;
  sellThreshold: number;
  totalReturnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  winRatePct: number;
  tradeCount: number;
}

export type ObjectiveKey = "return" | "returnDrawdown" | "returnWinRate" | "combined";

export interface OptimizationResult {
  key: ObjectiveKey;
  label: string;
  considers: string;
  best: ComboMetrics;
  score: number;
}

export interface Optimization {
  results: OptimizationResult[];
  combosTested: number;
}

function returnOverDrawdown(m: ComboMetrics): number {
  if (m.totalReturnPct <= 0) {
    return m.totalReturnPct;
  }
  if (m.maxDrawdownPct === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return m.totalReturnPct / m.maxDrawdownPct;
}

function returnTimesWinRate(m: ComboMetrics): number {
  if (m.totalReturnPct <= 0) {
    return m.totalReturnPct;
  }
  return m.totalReturnPct * (m.winRatePct / 100);
}

function combinedScore(m: ComboMetrics): number {
  if (m.totalReturnPct <= 0) {
    return m.totalReturnPct;
  }
  const rod =
    m.maxDrawdownPct === 0 ? Number.POSITIVE_INFINITY : m.totalReturnPct / m.maxDrawdownPct;
  return rod * (m.winRatePct / 100);
}

interface Objective {
  key: ObjectiveKey;
  label: string;
  considers: string;
  score: (m: ComboMetrics) => number;
}

const OBJECTIVES: Objective[] = [
  {
    key: "return",
    label: "Max Return",
    considers: "return only",
    score: (m) => m.totalReturnPct
  },
  {
    key: "returnDrawdown",
    label: "Return / Drawdown",
    considers: "low drawdown",
    score: returnOverDrawdown
  },
  {
    key: "returnWinRate",
    label: "Return x Win Rate",
    considers: "win rate",
    score: returnTimesWinRate
  },
  {
    key: "combined",
    label: "Return / DD x Win Rate",
    considers: "drawdown + win rate",
    score: combinedScore
  }
];

/**
 * Returns true when candidate should replace the current best for equal scores.
 * Deterministic tie-break: higher return, then lower drawdown, then higher CAGR,
 * then lower buy threshold, then lower sell threshold.
 */
function breaksTie(candidate: ComboMetrics, current: ComboMetrics): boolean {
  if (candidate.totalReturnPct !== current.totalReturnPct) {
    return candidate.totalReturnPct > current.totalReturnPct;
  }
  if (candidate.maxDrawdownPct !== current.maxDrawdownPct) {
    return candidate.maxDrawdownPct < current.maxDrawdownPct;
  }
  if (candidate.cagrPct !== current.cagrPct) {
    return candidate.cagrPct > current.cagrPct;
  }
  if (candidate.buyThreshold !== current.buyThreshold) {
    return candidate.buyThreshold < current.buyThreshold;
  }
  return candidate.sellThreshold < current.sellThreshold;
}

export function selectBest(combos: ComboMetrics[]): OptimizationResult[] {
  if (combos.length === 0) {
    throw new Error("No combos to optimize over");
  }

  return OBJECTIVES.map((objective) => {
    let best = combos[0]!;
    let bestScore = objective.score(best);

    for (let i = 1; i < combos.length; i += 1) {
      const candidate = combos[i]!;
      const candidateScore = objective.score(candidate);
      if (
        candidateScore > bestScore ||
        (candidateScore === bestScore && breaksTie(candidate, best))
      ) {
        best = candidate;
        bestScore = candidateScore;
      }
    }

    return {
      key: objective.key,
      label: objective.label,
      considers: objective.considers,
      best,
      score: bestScore
    };
  });
}

export function runOptimization(timeline: TimelinePoint[], config: OptimizeConfig): Optimization {
  const min = config.minThreshold ?? 0;
  const max = config.maxThreshold ?? 100;

  const combos: ComboMetrics[] = [];
  for (let buy = min; buy <= max; buy += 1) {
    for (let sell = min; sell <= max; sell += 1) {
      const result = runBacktest(timeline, {
        mode: config.mode,
        buyThresholds: [buy],
        sellThresholds: [sell],
        initialCash: config.initialCash,
        symbolWeights: config.symbolWeights
      });
      combos.push({
        buyThreshold: buy,
        sellThreshold: sell,
        totalReturnPct: result.totalReturnPct,
        cagrPct: result.cagrPct,
        maxDrawdownPct: result.maxDrawdownPct,
        winRatePct: result.winRatePct,
        tradeCount: result.tradeCount
      });
    }
  }

  return {
    results: selectBest(combos),
    combosTested: combos.length
  };
}
