import os from "node:os";
import { Worker } from "node:worker_threads";
import { runBacktest } from "./engine.js";
import type { BacktestMode, TimelinePoint } from "../types.js";

export type OptimizerStrategy = "greedy" | "coarse" | "single-expand" | "full";

export const OPTIMIZER_STRATEGIES: OptimizerStrategy[] = [
  "greedy",
  "coarse",
  "single-expand",
  "full"
];

export interface OptimizeConfig {
  mode: BacktestMode;
  initialCash: number;
  symbolWeights: Record<string, number>;
  strategy?: OptimizerStrategy;
  minThreshold?: number;
  maxThreshold?: number;
  /** Optional progress callback invoked during the heavy search phase. */
  onProgress?: (done: number, total: number) => void;
}

export interface ComboMetrics {
  buyThresholds: number[];
  sellThresholds: number[];
  finalEquity: number;
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
  strategy: OptimizerStrategy;
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

/** Compares two threshold sets: fewer elements first, then lexicographically ascending. */
function compareThresholdSets(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    return a.length - b.length;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return (a[i] as number) - (b[i] as number);
    }
  }
  return 0;
}

/**
 * Returns true when candidate should replace the current best for EQUAL scores.
 * Deterministic tie-break: higher return, then lower drawdown, then higher CAGR,
 * then fewer/lexicographically-smaller buy thresholds, then sell thresholds.
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
  const buyCmp = compareThresholdSets(candidate.buyThresholds, current.buyThresholds);
  if (buyCmp !== 0) {
    return buyCmp < 0;
  }
  return compareThresholdSets(candidate.sellThresholds, current.sellThresholds) < 0;
}

/**
 * Single shared comparator used by every code path (tracker, greedy/single-expand
 * expansion, and worker merge) so parallel and sync runs are always identical.
 */
function isBetter(
  candidate: ComboMetrics,
  candidateScore: number,
  current: ComboMetrics,
  currentScore: number
): boolean {
  if (candidateScore !== currentScore) {
    return candidateScore > currentScore;
  }
  return breaksTie(candidate, current);
}

interface TrackerEntry {
  combo: ComboMetrics;
  score: number;
}

export type SerializedBests = Partial<Record<ObjectiveKey, TrackerEntry>>;

/**
 * Online, memory-bounded best-per-objective tracker. Streaming combos in (and
 * merging worker results) never materializes the full search space, which keeps
 * coarse/full searches within memory. The shared `isBetter` comparator guarantees
 * the merged winner is independent of arrival order.
 */
export class BestTracker {
  private entries = new Map<ObjectiveKey, TrackerEntry>();

  update(combo: ComboMetrics): void {
    for (const objective of OBJECTIVES) {
      const score = objective.score(combo);
      const current = this.entries.get(objective.key);
      if (!current || isBetter(combo, score, current.combo, current.score)) {
        this.entries.set(objective.key, { combo, score });
      }
    }
  }

  private mergeEntry(key: ObjectiveKey, entry: TrackerEntry): void {
    const current = this.entries.get(key);
    if (!current || isBetter(entry.combo, entry.score, current.combo, current.score)) {
      this.entries.set(key, entry);
    }
  }

  merge(other: SerializedBests): void {
    for (const objective of OBJECTIVES) {
      const entry = other[objective.key];
      if (entry) {
        this.mergeEntry(objective.key, entry);
      }
    }
  }

  serialize(): SerializedBests {
    const out: SerializedBests = {};
    for (const objective of OBJECTIVES) {
      const entry = this.entries.get(objective.key);
      if (entry) {
        out[objective.key] = entry;
      }
    }
    return out;
  }

  results(): OptimizationResult[] {
    return OBJECTIVES.map((objective) => {
      const entry = this.entries.get(objective.key);
      if (!entry) {
        throw new Error("No combos to optimize over");
      }
      return {
        key: objective.key,
        label: objective.label,
        considers: objective.considers,
        best: entry.combo,
        score: entry.score
      };
    });
  }
}

/** Selects the best combo per objective from an in-memory array (used by tests/sync). */
export function selectBest(combos: ComboMetrics[]): OptimizationResult[] {
  if (combos.length === 0) {
    throw new Error("No combos to optimize over");
  }
  const tracker = new BestTracker();
  for (const combo of combos) {
    tracker.update(combo);
  }
  return tracker.results();
}

/** Runs a single backtest for a given threshold set and projects it to ComboMetrics. */
export function evaluateCombo(
  timeline: TimelinePoint[],
  config: OptimizeConfig,
  buyThresholds: number[],
  sellThresholds: number[]
): ComboMetrics {
  const result = runBacktest(timeline, {
    mode: config.mode,
    buyThresholds,
    sellThresholds,
    initialCash: config.initialCash,
    symbolWeights: config.symbolWeights
  });
  return {
    buyThresholds,
    sellThresholds,
    finalEquity: result.finalEquity,
    totalReturnPct: result.totalReturnPct,
    cagrPct: result.cagrPct,
    maxDrawdownPct: result.maxDrawdownPct,
    winRatePct: result.winRatePct,
    tradeCount: result.tradeCount
  };
}

/** Builds an ascending, unique level list from min..max with the given step (max always included). */
export function buildLevels(min: number, max: number, step: number): number[] {
  const levels: number[] = [];
  for (let value = min; value <= max; value += step) {
    levels.push(value);
  }
  if (levels.length === 0 || levels[levels.length - 1] !== max) {
    levels.push(max);
  }
  return levels;
}

/** Yields all size-`minSize`..`maxSize` subsets of `levels` as sorted, unique arrays. */
export function* subsets(levels: number[], minSize: number, maxSize: number): Generator<number[]> {
  const n = levels.length;
  for (let size = minSize; size <= maxSize; size += 1) {
    if (size > n) {
      continue;
    }
    const idx = Array.from({ length: size }, (_, i) => i);
    for (;;) {
      yield idx.map((i) => levels[i] as number);
      let k = size - 1;
      while (k >= 0 && idx[k] === n - size + k) {
        k -= 1;
      }
      if (k < 0) {
        break;
      }
      idx[k] = (idx[k] as number) + 1;
      for (let j = k + 1; j < size; j += 1) {
        idx[j] = (idx[j - 1] as number) + 1;
      }
    }
  }
}

/** Counts size-1..3 subsets of `n` levels (C(n,1)+C(n,2)+C(n,3)) without enumerating. */
export function countSubsetsUpTo3(n: number): number {
  if (n <= 0) {
    return 0;
  }
  const c1 = n;
  const c2 = n >= 2 ? (n * (n - 1)) / 2 : 0;
  const c3 = n >= 3 ? (n * (n - 1) * (n - 2)) / 6 : 0;
  return c1 + c2 + c3;
}

/**
 * Pure, stateless computation of single-threshold ComboMetrics for a contiguous buy
 * range (buyStart..buyEnd inclusive) crossed with the full sell range (min..max).
 * Shared by the synchronous path and the worker so results are identical.
 */
export function computeCombosForRange(
  timeline: TimelinePoint[],
  config: OptimizeConfig,
  buyStart: number,
  buyEnd: number,
  onProgress?: (done: number) => void
): ComboMetrics[] {
  const min = config.minThreshold ?? 0;
  const max = config.maxThreshold ?? 100;

  const combos: ComboMetrics[] = [];
  let done = 0;
  for (let buy = buyStart; buy <= buyEnd; buy += 1) {
    for (let sell = min; sell <= max; sell += 1) {
      combos.push(evaluateCombo(timeline, config, [buy], [sell]));
      done += 1;
      if (onProgress && done % 200 === 0) {
        onProgress(done);
      }
    }
  }
  if (onProgress) {
    onProgress(done);
  }
  return combos;
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
  const total = Number.isFinite(cores) && cores > 0 ? Math.floor(cores) : 1;
  // Leave one core free so the main thread can keep rendering the progress
  // spinner and the system stays responsive under a heavy optimization run.
  return Math.max(1, total - 1);
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

/** Splits a list into at most `parts` near-equal contiguous chunks. */
function partitionList<T>(items: T[], parts: number): T[][] {
  const n = items.length;
  if (n === 0) {
    return [[]];
  }
  const chunkCount = Math.max(1, Math.min(parts, n));
  const per = Math.ceil(n / chunkCount);
  const chunks: T[][] = [];
  for (let i = 0; i < n; i += per) {
    chunks.push(items.slice(i, i + per));
  }
  return chunks;
}

/** Strips non-cloneable fields (functions) so the config can cross the worker boundary. */
function toWorkerConfig(config: OptimizeConfig): OptimizeConfig {
  const clone: OptimizeConfig = {
    mode: config.mode,
    initialCash: config.initialCash,
    symbolWeights: config.symbolWeights,
    strategy: config.strategy
  };
  if (config.minThreshold !== undefined) {
    clone.minThreshold = config.minThreshold;
  }
  if (config.maxThreshold !== undefined) {
    clone.maxThreshold = config.maxThreshold;
  }
  return clone;
}

/** Resolves a worker module URL, matching this module's extension (.ts dev / .js dist). */
function workerUrl(name: string): URL {
  const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new URL(`./${name}.${ext}`, import.meta.url);
}

interface RangeProgress {
  type: "progress";
  done: number;
}
interface RangeResult {
  type: "result";
  combos: ComboMetrics[];
}
type RangeMessage = RangeProgress | RangeResult;

function runRangeInWorker(
  url: URL,
  timeline: TimelinePoint[],
  config: OptimizeConfig,
  buyStart: number,
  buyEnd: number,
  onProgress: (done: number) => void
): Promise<ComboMetrics[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(url, {
      workerData: { timeline, config: toWorkerConfig(config), buyStart, buyEnd }
    });
    worker.on("message", (msg: RangeMessage) => {
      if (msg.type === "progress") {
        onProgress(msg.done);
      } else {
        resolve(msg.combos);
        void worker.terminate();
      }
    });
    worker.once("error", (err) => {
      reject(err);
      void worker.terminate();
    });
  });
}

interface SubsetProgress {
  type: "progress";
  done: number;
}
interface SubsetResult {
  type: "result";
  bests: SerializedBests;
  count: number;
}
type SubsetMessage = SubsetProgress | SubsetResult;

function runSubsetWorker(
  url: URL,
  timeline: TimelinePoint[],
  config: OptimizeConfig,
  levels: number[],
  buySubsets: number[][],
  onProgress: (done: number) => void
): Promise<SerializedBests> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(url, {
      workerData: { timeline, config: toWorkerConfig(config), levels, buySubsets }
    });
    worker.on("message", (msg: SubsetMessage) => {
      if (msg.type === "progress") {
        onProgress(msg.done);
      } else {
        resolve(msg.bests);
        void worker.terminate();
      }
    });
    worker.once("error", (err) => {
      reject(err);
      void worker.terminate();
    });
  });
}

interface GridBase {
  tracker: BestTracker;
  count: number;
}

/** Builds the single-threshold grid tracker (parallel when possible, sync fallback). */
async function buildSingleGridTracker(
  timeline: TimelinePoint[],
  config: OptimizeConfig,
  parallel: boolean
): Promise<GridBase> {
  const min = config.minThreshold ?? 0;
  const max = config.maxThreshold ?? 100;
  const buyCount = max - min + 1;
  const total = buyCount * (max - min + 1);

  const runSync = (): GridBase => {
    const combos = computeCombosForRange(timeline, config, min, max, (done) =>
      config.onProgress?.(done, total)
    );
    const tracker = new BestTracker();
    for (const combo of combos) {
      tracker.update(combo);
    }
    return { tracker, count: combos.length };
  };

  const workerCount = Math.min(detectWorkerCount(), buyCount);
  if (!parallel || workerCount <= 1 || buyCount < 8) {
    return runSync();
  }

  try {
    const url = workerUrl("optimizeWorker");
    const ranges = partitionRange(min, max, workerCount);
    const doneByWorker = new Array<number>(ranges.length).fill(0);
    const reportAgg = (): void => {
      config.onProgress?.(
        doneByWorker.reduce((sum, value) => sum + value, 0),
        total
      );
    };
    const slices = await Promise.all(
      ranges.map(([start, end], i) =>
        runRangeInWorker(url, timeline, config, start, end, (done) => {
          doneByWorker[i] = done;
          reportAgg();
        })
      )
    );
    const tracker = new BestTracker();
    for (const slice of slices) {
      for (const combo of slice) {
        tracker.update(combo);
      }
    }
    return { tracker, count: total };
  } catch {
    return runSync();
  }
}

type ExpandFn = (
  timeline: TimelinePoint[],
  config: OptimizeConfig,
  anchor: ComboMetrics,
  objective: Objective,
  levels: number[],
  evalCount: { n: number }
) => ComboMetrics;

/**
 * Greedy expansion: from the per-objective best single combo, repeatedly add the
 * single best-improving buy OR sell threshold until no improvement or both sides
 * reach size 3. Anchoring + `isBetter`-only replacement guarantees the result is
 * never worse than the single-threshold winner. Heuristic: it may miss combos that
 * require a temporarily non-improving addition first.
 */
const expandGreedy: ExpandFn = (timeline, config, anchor, objective, levels, evalCount) => {
  let current = anchor;
  let currentScore = objective.score(current);

  while (current.buyThresholds.length < 3 || current.sellThresholds.length < 3) {
    let best = current;
    let bestScore = currentScore;

    const consider = (buy: number[], sell: number[]): void => {
      const candidate = evaluateCombo(timeline, config, buy, sell);
      evalCount.n += 1;
      const score = objective.score(candidate);
      if (isBetter(candidate, score, best, bestScore)) {
        best = candidate;
        bestScore = score;
      }
    };

    if (current.buyThresholds.length < 3) {
      for (const level of levels) {
        if (current.buyThresholds.includes(level)) {
          continue;
        }
        consider(
          [...current.buyThresholds, level].sort((a, b) => a - b),
          current.sellThresholds
        );
      }
    }
    if (current.sellThresholds.length < 3) {
      for (const level of levels) {
        if (current.sellThresholds.includes(level)) {
          continue;
        }
        consider(
          current.buyThresholds,
          [...current.sellThresholds, level].sort((a, b) => a - b)
        );
      }
    }

    if (best === current) {
      break;
    }
    current = best;
    currentScore = bestScore;
  }

  return current;
};

/**
 * Single-expand: anchor at the best single combo, add up to 2 more buy thresholds
 * (one full scan per step), then up to 2 more sell thresholds. Ordered heuristic —
 * cheaper than greedy and biased toward expanding buys before sells.
 */
const expandSingle: ExpandFn = (timeline, config, anchor, objective, levels, evalCount) => {
  let current = anchor;
  let currentScore = objective.score(current);

  const expandSide = (side: "buy" | "sell"): void => {
    for (let step = 0; step < 2; step += 1) {
      const set = side === "buy" ? current.buyThresholds : current.sellThresholds;
      if (set.length >= 3) {
        break;
      }
      let best = current;
      let bestScore = currentScore;
      for (const level of levels) {
        if (set.includes(level)) {
          continue;
        }
        const expanded = [...set, level].sort((a, b) => a - b);
        const candidate =
          side === "buy"
            ? evaluateCombo(timeline, config, expanded, current.sellThresholds)
            : evaluateCombo(timeline, config, current.buyThresholds, expanded);
        evalCount.n += 1;
        const score = objective.score(candidate);
        if (isBetter(candidate, score, best, bestScore)) {
          best = candidate;
          bestScore = score;
        }
      }
      if (best === current) {
        break;
      }
      current = best;
      currentScore = bestScore;
    }
  };

  expandSide("buy");
  expandSide("sell");
  return current;
};

/** Expands each objective's single-threshold anchor into a multi-threshold winner. */
function runExpansion(
  timeline: TimelinePoint[],
  config: OptimizeConfig,
  base: GridBase,
  expand: ExpandFn
): Optimization {
  const min = config.minThreshold ?? 0;
  const max = config.maxThreshold ?? 100;
  const levels = buildLevels(min, max, 1);
  const anchors = base.tracker.results();
  const evalCount = { n: base.count };

  const results: OptimizationResult[] = OBJECTIVES.map((objective) => {
    const anchor = anchors.find((a) => a.key === objective.key);
    if (!anchor) {
      throw new Error("No combos to optimize over");
    }
    const expanded = expand(timeline, config, anchor.best, objective, levels, evalCount);
    return {
      key: objective.key,
      label: objective.label,
      considers: objective.considers,
      best: expanded,
      score: objective.score(expanded)
    };
  });

  return {
    results,
    combosTested: evalCount.n,
    strategy: config.strategy ?? "greedy"
  };
}

/** Exhaustive search over all size-1..3 subsets of `levels` on both sides (sync). */
function runSubsetsSync(
  timeline: TimelinePoint[],
  config: OptimizeConfig,
  levels: number[],
  strategy: OptimizerStrategy
): Optimization {
  const buySubsets = [...subsets(levels, 1, 3)];
  const sellSubsets = [...subsets(levels, 1, 3)];
  const total = buySubsets.length * sellSubsets.length;
  const step = Math.max(1, Math.min(Math.floor(total / 100), 20_000));
  const tracker = new BestTracker();
  let done = 0;
  for (const buy of buySubsets) {
    for (const sell of sellSubsets) {
      tracker.update(evaluateCombo(timeline, config, buy, sell));
      done += 1;
      if (done % step === 0) {
        config.onProgress?.(done, total);
      }
    }
  }
  config.onProgress?.(total, total);
  return { results: tracker.results(), combosTested: total, strategy };
}

/** Exhaustive subset search, parallelized over buy-subset chunks (worker pool). */
async function runSubsets(
  timeline: TimelinePoint[],
  config: OptimizeConfig,
  levels: number[],
  strategy: OptimizerStrategy
): Promise<Optimization> {
  const buySubsets = [...subsets(levels, 1, 3)];
  const sellSubsetCount = countSubsetsUpTo3(levels.length);
  const total = buySubsets.length * sellSubsetCount;

  const workerCount = Math.min(detectWorkerCount(), buySubsets.length);
  if (workerCount <= 1) {
    return runSubsetsSync(timeline, config, levels, strategy);
  }

  try {
    const url = workerUrl("optimizeSubsetWorker");
    const chunks = partitionList(buySubsets, workerCount);
    const doneByWorker = new Array<number>(chunks.length).fill(0);
    const reportAgg = (): void => {
      config.onProgress?.(
        doneByWorker.reduce((sum, value) => sum + value, 0),
        total
      );
    };
    const partials = await Promise.all(
      chunks.map((chunk, i) =>
        runSubsetWorker(url, timeline, config, levels, chunk, (done) => {
          doneByWorker[i] = done;
          reportAgg();
        })
      )
    );
    const tracker = new BestTracker();
    for (const bests of partials) {
      tracker.merge(bests);
    }
    return { results: tracker.results(), combosTested: total, strategy };
  } catch {
    return runSubsetsSync(timeline, config, levels, strategy);
  }
}

/** Synchronous, single-threaded optimization (used as a fallback and by tests). */
export function runOptimizationSync(
  timeline: TimelinePoint[],
  config: OptimizeConfig
): Optimization {
  const strategy = config.strategy ?? "greedy";
  const min = config.minThreshold ?? 0;
  const max = config.maxThreshold ?? 100;

  if (strategy === "coarse") {
    return runSubsetsSync(timeline, config, buildLevels(min, max, 5), strategy);
  }
  if (strategy === "full") {
    return runSubsetsSync(timeline, config, buildLevels(min, max, 1), strategy);
  }

  const combos = computeCombosForRange(timeline, config, min, max);
  const tracker = new BestTracker();
  for (const combo of combos) {
    tracker.update(combo);
  }
  const expand = strategy === "single-expand" ? expandSingle : expandGreedy;
  return runExpansion(timeline, config, { tracker, count: combos.length }, expand);
}

/**
 * Optimizes thresholds using the selected strategy, with a worker-thread pool for
 * the heavy phases. Falls back to the synchronous path on a single core or any
 * worker failure.
 */
export async function runOptimization(
  timeline: TimelinePoint[],
  config: OptimizeConfig
): Promise<Optimization> {
  const strategy = config.strategy ?? "greedy";
  const min = config.minThreshold ?? 0;
  const max = config.maxThreshold ?? 100;
  const parallel = detectWorkerCount() > 1;

  if (strategy === "coarse") {
    return runSubsets(timeline, config, buildLevels(min, max, 5), strategy);
  }
  if (strategy === "full") {
    return runSubsets(timeline, config, buildLevels(min, max, 1), strategy);
  }

  const base = await buildSingleGridTracker(timeline, config, parallel);
  const expand = strategy === "single-expand" ? expandSingle : expandGreedy;
  return runExpansion(timeline, config, base, expand);
}
