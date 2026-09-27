/**
 * Longest-path layering of the displayed cone. Sources (no in-edges inside the cone: axioms and
 * boundary nodes) get layer 0; every other node sits one column right of its furthest dependency;
 * sinks (the targets) are pushed to the last column. Every kept edge goes strictly left to right.
 *
 * The cone is a DAG unless external collapsing merged packages that import each other; such cycles
 * are broken by dropping the fewest edges greedily (reported as `feedback`).
 */

export interface LayerEdge {
  source: string;
  target: string;
}

export interface Layering {
  layer: Map<string, number>;
  maxLayer: number;
  /** Indices into the input edge array that were ignored to break cycles. */
  feedback: Set<number>;
  /** A topological order of the ids (dependencies first). */
  order: string[];
}

export function assignLayers(
  ids: readonly string[],
  edges: readonly LayerEdge[],
  lastColumn: (id: string) => boolean = () => false,
): Layering {
  const n = ids.length;
  const idx = new Map<string, number>();
  ids.forEach((id, i) => idx.set(id, i));
  const src: number[] = [];
  const tgt: number[] = [];
  const outE: number[][] = Array.from({ length: n }, () => []);
  const inE: number[][] = Array.from({ length: n }, () => []);
  const indeg = new Int32Array(n);
  edges.forEach((e, k) => {
    const s = idx.get(e.source);
    const t = idx.get(e.target);
    src[k] = s ?? -1;
    tgt[k] = t ?? -1;
    if (s === undefined || t === undefined || s === t) return;
    outE[s]?.push(k);
    inE[t]?.push(k);
    indeg[t] = (indeg[t] ?? 0) + 1;
  });

  const layer = new Int32Array(n);
  const done = new Uint8Array(n);
  const feedback = new Set<number>();
  const queue: number[] = [];
  let head = 0;
  for (let i = 0; i < n; i++) if (indeg[i] === 0) queue.push(i);
  const order: string[] = [];

  while (order.length < n) {
    if (head >= queue.length) {
      // Cycle: release the unprocessed node with the fewest remaining dependencies.
      let best = -1;
      for (let i = 0; i < n; i++) {
        if (done[i]) continue;
        if (best < 0 || (indeg[i] ?? 0) < (indeg[best] ?? 0)) best = i;
      }
      for (const k of inE[best] ?? []) if (!done[src[k] ?? 0]) feedback.add(k);
      indeg[best] = 0;
      queue.push(best);
    }
    const v = queue[head++] as number;
    if (done[v]) continue;
    done[v] = 1;
    order.push(ids[v] as string);
    for (const k of outE[v] ?? []) {
      if (feedback.has(k)) continue;
      const t = tgt[k] as number;
      if (done[t]) {
        feedback.add(k);
        continue;
      }
      layer[t] = Math.max(layer[t] ?? 0, (layer[v] ?? 0) + 1);
      indeg[t] = (indeg[t] ?? 0) - 1;
      if (indeg[t] === 0) queue.push(t);
    }
  }

  let maxLayer = 0;
  for (let i = 0; i < n; i++) maxLayer = Math.max(maxLayer, layer[i] ?? 0);
  // Sinks go to the last column so the targets line up on the right.
  const outDeg = new Int32Array(n);
  const inDeg = new Int32Array(n);
  edges.forEach((_e, k) => {
    if (feedback.has(k)) return;
    const s = src[k] ?? -1;
    const t = tgt[k] ?? -1;
    if (s < 0 || t < 0 || s === t) return;
    outDeg[s] = (outDeg[s] ?? 0) + 1;
    inDeg[t] = (inDeg[t] ?? 0) + 1;
  });
  const result = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const id = ids[i] as string;
    const isSink = outDeg[i] === 0 && ((inDeg[i] ?? 0) > 0 || lastColumn(id));
    result.set(id, isSink ? maxLayer : (layer[i] ?? 0));
  }
  return { layer: result, maxLayer, feedback, order };
}
