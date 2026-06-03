import { parentPort, workerData } from "node:worker_threads";
import { BestTracker, evaluateCombo, subsets } from "./optimize.js";
import type { OptimizeConfig } from "./optimize.js";
import type { TimelinePoint } from "../types.js";

interface SubsetWorkerData {
  timeline: TimelinePoint[];
  config: OptimizeConfig;
  levels: number[];
  buySubsets: number[][];
}

if (!parentPort) {
  throw new Error("optimizeSubsetWorker must be run as a worker thread");
}

const port = parentPort;
const { timeline, config, levels, buySubsets } = workerData as SubsetWorkerData;

const cap = Math.max(1, Math.min(3, Math.floor(config.maxThresholds ?? 3)));
const sellSubsets = [...subsets(levels, 1, cap)];
const total = buySubsets.length * sellSubsets.length;
// Post progress at least every 1% but no less often than every 20k evaluations, so
// huge searches (e.g. `full`) still surface frequent updates instead of appearing
// frozen for tens of millions of backtests between posts.
const step = Math.max(1, Math.min(Math.floor(total / 100), 20_000));
const tracker = new BestTracker();

let done = 0;
for (const buy of buySubsets) {
  for (const sell of sellSubsets) {
    tracker.update(evaluateCombo(timeline, config, buy, sell));
    done += 1;
    if (done % step === 0) {
      port.postMessage({ type: "progress", done });
    }
  }
}

port.postMessage({ type: "result", bests: tracker.serialize(), count: total });
