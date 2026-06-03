import os from "node:os";
import { Worker } from "node:worker_threads";
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

/**
 * Pure, stateless computation of ComboMetrics for a contiguous buy-threshold range
 * (buyStart..buyEnd inclusive) crossed with the full sell-threshold range (min..max).
 * Shared by the synchronous path and the worker so results are identical.
 */
export function computeCombosForRange(
  timeline: TimelinePoint[],
  config: OptimizeConfig,
  buyStart: number,
  buyEnd: number
): ComboMetrics[] {
  const min = config.minThreshold ?? 0;
  const max = config.maxThreshold ?? 100;

  const combos: ComboMetrics[] = [];
  for (let buy = buyStart; buy <= buyEnd; buy += 1) {
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
  return combos;
}

/** Synchronous, single-threaded optimization over the full integer grid. */
export function runOptimizationSync(
  timeline: TimelinePoint[],
  config: OptimizeConfig
): Optimization {
  const min = config.minThreshold ?? 0;
  const max = config.maxThreshold ?? 100;
  const combos = computeCombosForRange(timeline, config, min, max);
  return {
    results: selectBest(combos),
    combosTested: combos.length
  };
}

/** Detects usable parallelism in a cross-platform, container-aware way (>= 1). */
function detectWorkerCount(): number {
  let cores: number;
  try {
    cores =
      typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  } catch {
    cores = 1;
  }
  return Number.isFinite(cores) && cores > 0 ? Math.floor(cores) : 1;
}

/** Splits [start, end] into at most `parts` contiguous, near-equal integer ranges. */
function partitionRange(start: number, end: number, parts: number): [number, number][] {
  const total = end - start + 1;
  const chunks = Math.max(1, Math.min(parts, total));
  const per = Math.ceil(total / chunks);
  const ranges: [number, number][] = [];
  for (let s = start; s <= end; s += per) {
    ranges.push([s, Math.min(end, s + per - 1)]);
  }
  return ranges;
}

/** Resolves the worker module URL, matching this module's extension (.ts dev / .js dist). */
function workerUrl(): URL {
  const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new URL(`./optimizeWorker.${ext}`, import.meta.url);
}

function runRangeInWorker(
  url: URL,
  timeline: TimelinePoint[],
  config: OptimizeConfig,
  buyStart: number,
  buyEnd: number
): Promise<ComboMetrics[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(url, {
      workerData: { timeline, config, buyStart, buyEnd }
    });
    worker.once("message", (combos: ComboMetrics[]) => {
      resolve(combos);
      void worker.terminate();
    });
    worker.once("error", (err) => {
      reject(err);
      void worker.terminate();
    });
  });
}

/**
 * Optimizes across the full integer grid using a worker-thread pool when more than
 * one core is available. Cross-platform and any-CPU safe: falls back to the
 * synchronous path on a single core, a tiny grid, or any worker failure.
 */
export async function runOptimization(
  timeline: TimelinePoint[],
  config: OptimizeConfig
): Promise<Optimization> {
  const min = config.minThreshold ?? 0;
  const max = config.maxThreshold ?? 100;
  const buyCount = max - min + 1;

  const workerCount = Math.min(detectWorkerCount(), buyCount);

  // Not worth the worker overhead for a single core or a tiny grid.
  if (workerCount <= 1 || buyCount < 8) {
    return runOptimizationSync(timeline, config);
  }

  try {
    const url = workerUrl();
    const ranges = partitionRange(min, max, workerCount);
    const slices = await Promise.all(
      ranges.map(([start, end]) => runRangeInWorker(url, timeline, config, start, end))
    );
    // Slices arrive in buy order, reproducing the serial ordering exactly.
    const combos = slices.flat();
    return {
      results: selectBest(combos),
      combosTested: combos.length
    };
  } catch {
    // Workers unavailable on this runtime — degrade gracefully to single-threaded.
    return runOptimizationSync(timeline, config);
  }
}
