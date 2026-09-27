import type { Size } from "./measure";

export interface Box { id: string; x: number; y: number; width: number; height: number }
export interface Rect { x: number; y: number; width: number; height: number }
export interface Transform { x: number; y: number; zoom: number }

export function viewRect(t: Transform, width: number, height: number, margin = 0): Rect {
  return {
    x: (-t.x - margin) / t.zoom,
    y: (-t.y - margin) / t.zoom,
    width: (width + 2 * margin) / t.zoom,
    height: (height + 2 * margin) / t.zoom,
  };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

/** A fixed world-space grid: viewport queries do not scan every laid-out node. */
export class SpatialGrid {
  readonly byId = new Map<string, Box>();
  private readonly cells = new Map<string, Box[]>();
  constructor(positions: ReadonlyMap<string, { x: number; y: number }>, sizes: ReadonlyMap<string, Size>, readonly cellSize = 512) {
    for (const [id, p] of positions) {
      const size = sizes.get(id) ?? { width: 160, height: 74 };
      const box = { id, x: p.x, y: p.y, width: size.width, height: size.height };
      this.byId.set(id, box);
      const x0 = Math.floor(box.x / cellSize), x1 = Math.floor((box.x + box.width) / cellSize);
      const y0 = Math.floor(box.y / cellSize), y1 = Math.floor((box.y + box.height) / cellSize);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const key = `${x},${y}`;
        let bucket = this.cells.get(key);
        if (!bucket) this.cells.set(key, (bucket = []));
        bucket.push(box);
      }
    }
  }
  query(rect: Rect): Box[] {
    const found = new Map<string, Box>();
    const x0 = Math.floor(rect.x / this.cellSize), x1 = Math.floor((rect.x + rect.width) / this.cellSize);
    const y0 = Math.floor(rect.y / this.cellSize), y1 = Math.floor((rect.y + rect.height) / this.cellSize);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.cells.size * 4) {
      for (const box of this.byId.values()) if (intersects(box, rect)) found.set(box.id, box);
      return [...found.values()];
    }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      for (const box of this.cells.get(`${x},${y}`) ?? []) if (intersects(box, rect)) found.set(box.id, box);
    }
    return [...found.values()];
  }
  hit(x: number, y: number, tolerance = 0): Box | null {
    const boxes = this.query({ x: x - tolerance, y: y - tolerance, width: tolerance * 2, height: tolerance * 2 });
    let nearest: Box | null = null;
    let distance = Infinity;
    for (const b of boxes) {
      const dx = Math.max(b.x - x, 0, x - b.x - b.width);
      const dy = Math.max(b.y - y, 0, y - b.y - b.height);
      const d = dx * dx + dy * dy;
      if (dx <= tolerance && dy <= tolerance && d < distance) { nearest = b; distance = d; }
    }
    return nearest;
  }
}
