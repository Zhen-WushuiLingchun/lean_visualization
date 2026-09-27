import type { ELK, ElkNode, LayoutOptions } from "elkjs/lib/elk-api";
import { fastLayered } from "./fastLayout";

/**
 * ELK `layered` layout, direction RIGHT, with partitioning: each node's partition is its layer
 * index from `layers.ts`, so axioms sit in column 0 and targets in the last column.
 *
 * ELK runs in a Web Worker (elkjs' own `elk-worker.min.js`, loaded as a classic worker from a Vite
 * asset URL). If workers are unavailable or the worker fails to load, it falls back to the bundled
 * build on the main thread; the UI shows a "layouting" state in both cases.
 */

export interface LayoutNodeInput {
  id: string;
  width: number;
  height: number;
  layer: number;
}

export interface LayoutEdgeInput {
  id: string;
  source: string;
  target: string;
}

export interface LayoutInput {
  nodes: readonly LayoutNodeInput[];
  edges: readonly LayoutEdgeInput[];
}

/** Which engine produced a layout. */
export type LayoutEngine = "elk-worker" | "elk-main" | "fast";
/** User choice in the toolbar. `auto` uses ELK up to `ELK_AUTO_LIMIT` nodes, the fast layout above. */
export type LayoutChoice = "auto" | "elk" | "fast";
/** ELK takes about 3 s at 300 nodes and 20 to 40 s at 1000 (measured); the fast layout stays under 0.2 s. */
export const ELK_AUTO_LIMIT = 300;

export function chooseEngine(choice: LayoutChoice, nodeCount: number): "elk" | "fast" {
  if (choice === "elk" || choice === "fast") return choice;
  return nodeCount <= ELK_AUTO_LIMIT ? "elk" : "fast";
}

export function engineLabel(engine: LayoutEngine): string {
  return engine === "fast" ? "fast layout" : engine === "elk-worker" ? "ELK layout (worker)" : "ELK layout (main thread)";
}

export interface LayoutResult {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
  engine: LayoutEngine;
  durationMs: number;
}

export class LayoutCancelled extends Error {
  constructor() {
    super("layout cancelled");
  }
}

/** Crossing minimisation dominates ELK's cost; lower thoroughness on big cones (measured: 3000 nodes about 12 s). */
export function elkOptionsFor(nodeCount: number): LayoutOptions {
  const opts: LayoutOptions = {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
    "elk.partitioning.activate": "true",
    "elk.spacing.nodeNode": "18",
    "elk.layered.spacing.nodeNodeBetweenLayers": "70",
    "elk.layered.spacing.edgeNodeBetweenLayers": "20",
    "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    "elk.edgeRouting": "POLYLINE",
  };
  if (nodeCount > 1200) {
    opts["elk.layered.thoroughness"] = "1";
    opts["elk.layered.crossingMinimization.greedySwitch.type"] = "OFF";
  } else if (nodeCount > 400) {
    opts["elk.layered.thoroughness"] = "3";
    opts["elk.layered.crossingMinimization.greedySwitch.type"] = "OFF";
  }
  return opts;
}

/** Dummy nodes ELK may create for long edges, per node. */
export const DUMMY_BUDGET_PER_NODE = 4;

/**
 * Pick the edges ELK sees. Columns are fixed by partitioning, so edges only steer the vertical
 * order; but every edge spanning k columns costs k - 1 dummy nodes, and long edges (a basic lemma
 * used by the final theorem, or the many sinks pushed to the last column) blow ELK up: 1000 nodes
 * take 19 s with all edges and 3 s with this budget. The budget is a hard cap:
 *   1. every edge between adjacent columns (free);
 *   2. the shortest edge of each node that has no edge yet, shortest first;
 *   3. the remaining edges, shortest first.
 * Nodes left without edges keep model (file) order in their column. React Flow draws every edge.
 */
export function selectLayoutEdges(input: LayoutInput, budgetPerNode = DUMMY_BUDGET_PER_NODE): LayoutEdgeInput[] {
  const layer = new Map(input.nodes.map((n) => [n.id, n.layer]));
  const cost = (e: LayoutEdgeInput): number => Math.max(0, (layer.get(e.target) ?? 0) - (layer.get(e.source) ?? 0) - 1);
  const edges = input.edges.filter((e) => layer.has(e.source) && layer.has(e.target));
  const sorted = [...edges].sort((a, b) => cost(a) - cost(b));
  let left = budgetPerNode * input.nodes.length;
  const kept = new Set<LayoutEdgeInput>();
  const touched = new Set<string>();
  const keep = (e: LayoutEdgeInput): void => {
    kept.add(e);
    left -= cost(e);
    touched.add(e.source);
    touched.add(e.target);
  };
  for (const e of sorted) if (cost(e) === 0) keep(e);
  for (const e of sorted) {
    if (kept.has(e) || cost(e) > left) continue;
    if (!touched.has(e.target) || !touched.has(e.source)) keep(e);
  }
  for (const e of sorted) if (!kept.has(e) && cost(e) <= left) keep(e);
  return edges.filter((e) => kept.has(e));
}

export function toElkGraph(input: LayoutInput): ElkNode {
  const ids = new Set(input.nodes.map((n) => n.id));
  return {
    id: "root",
    children: input.nodes.map((n) => ({
      id: n.id,
      width: n.width,
      height: n.height,
      layoutOptions: { "elk.partitioning.partition": String(n.layer) },
    })),
    edges: selectLayoutEdges(input)
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
}

function fromElk(res: ElkNode, engine: LayoutEngine, durationMs: number): LayoutResult {
  const positions = new Map<string, { x: number; y: number }>();
  let width = 0;
  let height = 0;
  for (const c of res.children ?? []) {
    const x = c.x ?? 0;
    const y = c.y ?? 0;
    positions.set(c.id, { x, y });
    width = Math.max(width, x + (c.width ?? 0));
    height = Math.max(height, y + (c.height ?? 0));
  }
  return { positions, width, height, engine, durationMs };
}

type ElkCtor = new (args?: { workerFactory?: (url?: string) => Worker; workerUrl?: string }) => ELK;

function ctorOf(mod: unknown): ElkCtor {
  // CJS interop differs between Vite dev, the production bundle and Node (tests).
  let m = mod as { default?: unknown };
  while (typeof m !== "function" && m && typeof m === "object" && "default" in m) m = m.default as { default?: unknown };
  return m as unknown as ElkCtor;
}

interface WorkerElk {
  elk: ELK;
  worker: Worker;
  failed: Promise<never>;
}

let workerElk: WorkerElk | null = null;
let workerBroken = false;
let mainElk: ELK | null = null;
let lastEngine: LayoutEngine | null = null;

export function lastLayoutEngine(): LayoutEngine | null {
  return lastEngine;
}

async function getWorkerElk(): Promise<WorkerElk> {
  if (workerElk) return workerElk;
  const [api, urlMod] = await Promise.all([import("elkjs/lib/elk-api.js"), import("elkjs/lib/elk-worker.min.js?url")]);
  const ELKApi = ctorOf(api);
  const url = urlMod.default;
  let worker: Worker | null = null;
  const elk = new ELKApi({
    workerFactory: () => {
      worker = new Worker(url);
      return worker;
    },
  });
  if (!worker) throw new Error("ELK did not create a worker");
  const w: Worker = worker;
  const failed = new Promise<never>((_, reject) => {
    w.addEventListener("error", (ev) => reject(new Error(ev.message || "ELK worker failed to load")));
  });
  failed.catch(() => undefined);
  workerElk = { elk, worker: w, failed };
  return workerElk;
}

async function getMainElk(): Promise<ELK> {
  if (mainElk) return mainElk;
  const mod = await import("elkjs/lib/elk.bundled.js");
  const ELKBundled = ctorOf(mod);
  mainElk = new ELKBundled();
  return mainElk;
}

function abortPromise(signal: AbortSignal | undefined): Promise<never> | null {
  if (!signal) return null;
  const p = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new LayoutCancelled());
    signal.addEventListener("abort", () => reject(new LayoutCancelled()), { once: true });
  });
  // The abort may fire before this promise joins a race (or after the race settled).
  p.catch(() => undefined);
  return p;
}

export interface RunLayoutOptions {
  signal?: AbortSignal;
  /** auto (default), elk or fast. */
  choice?: LayoutChoice;
  /** Run ELK on the main thread (tests, or when workers are known not to work). */
  elkThread?: "worker" | "main";
}

export async function runLayout(input: LayoutInput, opts: RunLayoutOptions = {}): Promise<LayoutResult> {
  if (chooseEngine(opts.choice ?? "auto", input.nodes.length) === "fast") {
    const t0 = performance.now();
    if (opts.signal?.aborted) throw new LayoutCancelled();
    const res = fastLayered(input);
    lastEngine = "fast";
    return { ...res, engine: "fast", durationMs: performance.now() - t0 };
  }
  const graph = toElkGraph(input);
  const layoutOptions = elkOptionsFor(input.nodes.length);
  const aborted = abortPromise(opts.signal);
  const t0 = performance.now();
  const wantWorker = opts.elkThread !== "main" && !workerBroken && typeof Worker !== "undefined";

  if (wantWorker) {
    try {
      const w = await getWorkerElk();
      const race: Promise<ElkNode>[] = [w.elk.layout(graph, { layoutOptions }), w.failed];
      if (aborted) race.push(aborted);
      const res = await Promise.race(race);
      lastEngine = "elk-worker";
      return fromElk(res, "elk-worker", performance.now() - t0);
    } catch (e) {
      if (e instanceof LayoutCancelled) {
        // The worker may still be busy with the stale graph: drop it, the next layout starts fresh.
        workerElk?.elk.terminateWorker();
        workerElk = null;
        throw e;
      }
      console.warn("ProofFlow: ELK worker unavailable, laying out on the main thread.", e);
      workerElk?.elk.terminateWorker();
      workerElk = null;
      workerBroken = true;
    }
  }

  const elk = await getMainElk();
  // Let the "layouting" state paint before the main thread is busy.
  await new Promise((r) => setTimeout(r, 0));
  if (opts.signal?.aborted) throw new LayoutCancelled();
  const race: Promise<ElkNode>[] = [elk.layout(graph, { layoutOptions })];
  if (aborted) race.push(aborted);
  const res = await Promise.race(race);
  lastEngine = "elk-main";
  return fromElk(res, "elk-main", performance.now() - t0);
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Bounding box of laid-out nodes. */
export function layoutBounds(positions: ReadonlyMap<string, { x: number; y: number }>, sizes: ReadonlyMap<string, { width: number; height: number }>): Bounds {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [id, p] of positions) {
    const s = sizes.get(id) ?? { width: 0, height: 0 };
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + s.width);
    y1 = Math.max(y1, p.y + s.height);
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export const MIN_ZOOM = 0.02;
export const FIT_MAX_ZOOM = 1.2;
export const FIT_PADDING = 0.06;

/**
 * Viewport that fits `b` into a pane of `w` x `h` (same maths as xyflow's getViewportForBounds,
 * kept here so the fit is a pure function we can test and apply with setViewport directly).
 */
export function fitViewportFor(b: Bounds, w: number, h: number, minZoom = MIN_ZOOM, maxZoom = FIT_MAX_ZOOM, padding = FIT_PADDING): { x: number; y: number; zoom: number } {
  if (w <= 0 || h <= 0 || b.width <= 0 || b.height <= 0) return { x: 0, y: 0, zoom: 1 };
  const zoomX = w / (b.width * (1 + 2 * padding));
  const zoomY = h / (b.height * (1 + 2 * padding));
  const zoom = Math.min(maxZoom, Math.max(minZoom, Math.min(zoomX, zoomY)));
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  return { x: w / 2 - cx * zoom, y: h / 2 - cy * zoom, zoom };
}
