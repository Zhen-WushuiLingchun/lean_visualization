import type { ViewEdge } from "./cone";

/** The read-only operations the displayed cone needs after layout. */
export interface ConeAdjacency {
  readonly order: number;
  readonly size: number;
  hasNode(id: string): boolean;
  inNeighbors(id: string): string[];
  outNeighbors(id: string): string[];
}

/**
 * Compact sparse adjacency for a cone returned by the view worker. Edge order is retained, so
 * hover traversal and the node panel see the same neighbors as Graphology's insertion order.
 */
export class CsrConeAdjacency implements ConeAdjacency {
  readonly order: number;
  readonly size: number;
  private readonly ids: string[];
  private readonly index: Map<string, number>;
  private readonly inOffsets: Uint32Array;
  private readonly outOffsets: Uint32Array;
  private readonly inIndices: Uint32Array;
  private readonly outIndices: Uint32Array;

  constructor(ids: readonly string[], edges: readonly ViewEdge[]) {
    this.ids = [...ids];
    this.index = new Map(ids.map((id, i) => [id, i]));
    this.order = ids.length;
    const inCounts = new Uint32Array(ids.length);
    const outCounts = new Uint32Array(ids.length);
    let valid = 0;
    for (const edge of edges) {
      const s = this.index.get(edge.source);
      const t = this.index.get(edge.target);
      if (s === undefined || t === undefined || s === t) continue;
      outCounts[s] = (outCounts[s] ?? 0) + 1;
      inCounts[t] = (inCounts[t] ?? 0) + 1;
      valid++;
    }
    this.size = valid;
    this.inOffsets = new Uint32Array(ids.length + 1);
    this.outOffsets = new Uint32Array(ids.length + 1);
    for (let i = 0; i < ids.length; i++) {
      this.inOffsets[i + 1] = (this.inOffsets[i] ?? 0) + (inCounts[i] ?? 0);
      this.outOffsets[i + 1] = (this.outOffsets[i] ?? 0) + (outCounts[i] ?? 0);
    }
    this.inIndices = new Uint32Array(valid);
    this.outIndices = new Uint32Array(valid);
    const inNext = this.inOffsets.slice(0, ids.length);
    const outNext = this.outOffsets.slice(0, ids.length);
    for (const edge of edges) {
      const s = this.index.get(edge.source);
      const t = this.index.get(edge.target);
      if (s === undefined || t === undefined || s === t) continue;
      this.outIndices[outNext[s] as number] = t;
      this.inIndices[inNext[t] as number] = s;
      outNext[s] = (outNext[s] ?? 0) + 1;
      inNext[t] = (inNext[t] ?? 0) + 1;
    }
  }

  hasNode(id: string): boolean { return this.index.has(id); }

  inNeighbors(id: string): string[] { return this.neighbors(id, this.inOffsets, this.inIndices); }

  outNeighbors(id: string): string[] { return this.neighbors(id, this.outOffsets, this.outIndices); }

  private neighbors(id: string, offsets: Uint32Array, indices: Uint32Array): string[] {
    const i = this.index.get(id);
    if (i === undefined) return [];
    const out: string[] = [];
    for (let k = offsets[i] as number; k < (offsets[i + 1] as number); k++) out.push(this.ids[indices[k] as number] as string);
    return out;
  }
}
