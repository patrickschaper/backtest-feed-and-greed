import { parentPort, workerData } from "node:worker_threads";
import { computeCombosForRange } from "./optimize.js";
import type { ComboMetrics, OptimizeConfig } from "./optimize.js";
import type { TimelinePoint } from "../types.js";

interface OptimizeWorkerData {
  timeline: TimelinePoint[];
  config: OptimizeConfig;
  buyStart: number;
  buyEnd: number;
}

if (!parentPort) {
  throw new Error("optimizeWorker must be run as a worker thread");
}

const port = parentPort;
const { timeline, config, buyStart, buyEnd } = workerData as OptimizeWorkerData;
const combos: ComboMetrics[] = computeCombosForRange(timeline, config, buyStart, buyEnd, (done) =>
  port.postMessage({ type: "progress", done })
);
port.postMessage({ type: "result", combos });
