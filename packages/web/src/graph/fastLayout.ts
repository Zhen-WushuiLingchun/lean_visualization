import type { LayoutInput } from "./layout";

/**
 * Fast layered layout for big cones (ELK needs tens of seconds above a few hundred nodes).
 *
 * Columns are the longest-path layers from `layers.ts` (axioms in column 0, targets last). Inside a
 * column, nodes are ordered by barycenter sweeps (down using dependencies, up using dependents),
 * then placed vertically as close as possible to the mean of their neighbours while keeping the
 * order and a minimum gap; that 1-D problem is solved exactly by isotonic regression (pool adjacent
 * violators). Every pass is O(E) plus a sort per column. No edge routing: React Flow draws beziers.
 */

export interface FastLayoutOptions {
  /** Ordering sweeps (each is one down and one up pass). */
  sweeps?: number;
  /** Vertical placement passes after ordering. */
  placementPasses?: number;
  gapX?: number;
  gapY?: number;
  padding?: number;
}

export interface FastLayoutOutput {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

interface Item {
  id: string;
  w: number;
  h: number;
  layer: number;
  preds: number[];
  succs: number[];
  /** Order key and rank inside its column. */
  key: number;
  y: number;
}

/**
 * Isotonic placement: minimise sum (y_i - d_i)^2 subject to y_i >= y_{i-1} + h_{i-1} + gap,
 * via z_i = y_i - offset_i, which turns the constraint into z_i >= z_{i-1} (PAV).
 */
export function placeColumn(desired: readonly number[], heights: readonly number[], gap: number): number[] {
  const n = desired.length;
  const offset: number[] = new Array<number>(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    offset[i] = acc;
    acc += (heights[i] ?? 0) + gap;
  }
  // Blocks of pooled values: [sum, count, start index].
  const sums: number[] = [];
  const counts: number[] = [];
  const starts: number[] = [];
  for (let i = 0; i < n; i++) {
    sums.push((desired[i] ?? 0) - (offset[i] ?? 0));
    counts.push(1);
    starts.push(i);
    while (sums.length > 1) {
      const k = sums.length - 1;
      if ((sums[k - 1] as number) / (counts[k - 1] as number) <= (sums[k] as number) / (counts[k] as number)) break;
      sums[k - 1] = (sums[k - 1] as number) + (sums[k] as number);
      counts[k - 1] = (counts[k - 1] as number) + (counts[k] as number);
      sums.pop();
      counts.pop();
      starts.pop();
    }
  }
  const out = new Array<number>(n);
  for (let b = 0; b < sums.length; b++) {
    const z = (sums[b] as number) / (counts[b] as number);
    const end = b + 1 < starts.length ? (starts[b + 1] as number) : n;
    for (let i = starts[b] as number; i < end; i++) out[i] = z + (offset[i] as number);
  }
  return out;
}

export function fastLayered(input: LayoutInput, opts: FastLayoutOptions = {}): FastLayoutOutput {
  const sweeps = opts.sweeps ?? 5;
  const passes = opts.placementPasses ?? 3;
  const gapX = opts.gapX ?? 90;
  const gapY = opts.gapY ?? 18;
  const pad = opts.padding ?? 12;

  const index = new Map<string, number>();
  const items: Item[] = input.nodes.map((n, i) => {
    index.set(n.id, i);
    return { id: n.id, w: n.width, h: n.height, layer: n.layer, preds: [], succs: [], key: i, y: 0 };
  });
  for (const e of input.edges) {
    const s = index.get(e.source);
    const t = index.get(e.target);
    if (s === undefined || t === undefined || s === t) continue;
    const a = items[s] as Item;
    const b = items[t] as Item;
    if (a.layer >= b.layer) continue; // feedback edges do not steer the layout
    a.succs.push(t);
    b.preds.push(s);
  }

  let maxLayer = 0;
  for (const it of items) maxLayer = Math.max(maxLayer, it.layer);
  const columns: number[][] = Array.from({ length: maxLayer + 1 }, () => []);
  items.forEach((it, i) => columns[it.layer]?.push(i));

  // Relative position of each node inside its column, in [0, 1].
  const rel = new Float64Array(items.length);
  const setRel = (col: number[]): void => {
    const d = Math.max(1, col.length - 1);
    col.forEach((i, r) => {
      rel[i] = col.length === 1 ? 0.5 : r / d;
    });
  };
  columns.forEach(setRel);

  const reorder = (col: number[], neighbours: (it: Item) => number[]): void => {
    for (const i of col) {
      const it = items[i] as Item;
      const ns = neighbours(it);
      if (ns.length === 0) {
        it.key = rel[i] as number;
        continue;
      }
      let s = 0;
      for (const n of ns) s += rel[n] as number;
      it.key = s / ns.length;
    }
    // Stable: ties keep the current order.
    const rank = new Map(col.map((i, r) => [i, r]));
    col.sort((a, b) => (items[a] as Item).key - (items[b] as Item).key || (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
    setRel(col);
  };
  for (let s = 0; s < sweeps; s++) {
    for (let l = 1; l <= maxLayer; l++) reorder(columns[l] as number[], (it) => it.preds);
    for (let l = maxLayer - 1; l >= 0; l--) reorder(columns[l] as number[], (it) => it.succs);
  }

  // Initial y: stack each column, centred on 0.
  for (const col of columns) {
    let total = 0;
    for (const i of col) total += (items[i] as Item).h + gapY;
    let y = -total / 2;
    for (const i of col) {
      const it = items[i] as Item;
      it.y = y;
      y += it.h + gapY;
    }
  }
  const centre = (i: number): number => (items[i] as Item).y + (items[i] as Item).h / 2;
  const place = (col: number[], neighbours: (it: Item) => number[]): void => {
    if (col.length === 0) return;
    const desired = col.map((i) => {
      const it = items[i] as Item;
      const ns = neighbours(it);
      if (ns.length === 0) return it.y;
      let s = 0;
      for (const n of ns) s += centre(n);
      return s / ns.length - it.h / 2;
    });
    const ys = placeColumn(
      desired,
      col.map((i) => (items[i] as Item).h),
      gapY,
    );
    col.forEach((i, r) => {
      (items[i] as Item).y = ys[r] as number;
    });
  };
  for (let p = 0; p < passes; p++) {
    for (let l = 1; l <= maxLayer; l++) place(columns[l] as number[], (it) => it.preds);
    for (let l = maxLayer - 1; l >= 0; l--) place(columns[l] as number[], (it) => it.succs);
  }

  // x by column: each column as wide as its widest node; nodes right-aligned like ELK.
  const colX: number[] = [];
  const colW: number[] = [];
  let x = pad;
  for (const col of columns) {
    let w = 0;
    for (const i of col) w = Math.max(w, (items[i] as Item).w);
    colX.push(x);
    colW.push(w);
    x += w + gapX;
  }
  let minY = Infinity;
  for (const it of items) minY = Math.min(minY, it.y);
  if (!Number.isFinite(minY)) minY = 0;
  const positions = new Map<string, { x: number; y: number }>();
  let width = 0;
  let height = 0;
  for (const it of items) {
    const px = (colX[it.layer] ?? pad) + (colW[it.layer] ?? 0) - it.w;
    const py = it.y - minY + pad;
    positions.set(it.id, { x: px, y: py });
    width = Math.max(width, px + it.w + pad);
    height = Math.max(height, py + it.h + pad);
  }
  return { positions, width, height };
}
