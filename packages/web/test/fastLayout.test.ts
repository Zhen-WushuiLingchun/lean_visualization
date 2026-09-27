import { describe, expect, it } from "vitest";
import { buildCone } from "../src/graph/cone";
import { fastLayered, placeColumn } from "../src/graph/fastLayout";
import { buildIndex } from "../src/graph/graphIndex";
import { assignLayers } from "../src/graph/layers";
import { chooseEngine, ELK_AUTO_LIMIT, fitViewportFor, layoutBounds, runLayout, type LayoutInput } from "../src/graph/layout";
import { measureAll } from "../src/graph/measure";
import { layeredGraph, sample } from "./fixtures";
import type { GraphFile } from "@proofflow/schema";

function inputFor(g: GraphFile): { input: LayoutInput; targets: string[] } {
  const idx = buildIndex(g);
  const cone = buildCone(idx, { mode: "cone", targets: idx.localSinks, depthLimit: null, hideAux: true, external: "collapse", site: "all" });
  const L = assignLayers(
    cone.nodes.map((n) => n.id),
    cone.edges,
    (id) => !!cone.byId.get(id)?.isTarget,
  );
  const sizes = measureAll(cone.nodes);
  return {
    input: {
      nodes: cone.nodes.map((n) => ({ id: n.id, ...(sizes.get(n.id) ?? { width: 1, height: 1 }), layer: L.layer.get(n.id) ?? 0 })),
      edges: cone.edges.filter((_e, k) => !L.feedback.has(k)),
    },
    targets: cone.targets,
  };
}

function checkGeometry(input: LayoutInput, positions: Map<string, { x: number; y: number }>): void {
  const box = new Map(input.nodes.map((n) => [n.id, { ...n, ...(positions.get(n.id) ?? { x: NaN, y: NaN }) }]));
  for (const b of box.values()) {
    expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true);
  }
  // Edges strictly left to right.
  for (const e of input.edges) {
    const a = box.get(e.source);
    const b = box.get(e.target);
    if (a && b) expect(a.x + a.width).toBeLessThan(b.x);
  }
  // Same layer, same column (right edges aligned); no vertical overlap inside a column.
  const byLayer = new Map<number, typeof input.nodes[number][]>();
  for (const n of input.nodes) byLayer.set(n.layer, [...(byLayer.get(n.layer) ?? []), n]);
  for (const col of byLayer.values()) {
    const rights = new Set(col.map((n) => Math.round((box.get(n.id)?.x ?? 0) + n.width)));
    expect(rights.size).toBe(1);
    const sorted = col.map((n) => box.get(n.id) as { y: number; height: number }).sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1] as { y: number; height: number };
      expect((sorted[i] as { y: number }).y).toBeGreaterThanOrEqual(prev.y + prev.height - 1e-6);
    }
  }
}

describe("placeColumn (isotonic placement)", () => {
  it("keeps desired positions when they already fit", () => {
    expect(placeColumn([0, 100, 300], [50, 50, 50], 10)).toEqual([0, 100, 300]);
  });
  it("spreads overlapping nodes around their mean, preserving order", () => {
    const ys = placeColumn([100, 100, 100], [40, 40, 40], 10);
    expect(ys).toEqual([50, 100, 150]);
  });
  it("only pools the violating block", () => {
    // offsets 0, 30, 60, 90; z = [0, 170, 130, 410]; the middle pair pools to 150.
    expect(placeColumn([0, 200, 190, 500], [20, 20, 20, 20], 10)).toEqual([0, 180, 210, 500]);
  });
});

describe("fast layered layout", () => {
  it("chooses ELK only for small cones in auto mode", () => {
    expect(chooseEngine("auto", ELK_AUTO_LIMIT)).toBe("elk");
    expect(chooseEngine("auto", ELK_AUTO_LIMIT + 1)).toBe("fast");
    expect(chooseEngine("elk", 5000)).toBe("elk");
    expect(chooseEngine("fast", 3)).toBe("fast");
  });

  it("lays out the sample with columns, no overlaps and left-to-right edges", async () => {
    const { input } = inputFor(sample);
    const res = await runLayout(input, { choice: "fast" });
    expect(res.engine).toBe("fast");
    checkGeometry(input, res.positions);
  });

  it("handles 3000 nodes well under the 3 s target", () => {
    const { input } = inputFor(layeredGraph(60, 50)); // 3001 nodes, about 6000 edges
    expect(input.nodes.length).toBe(3001);
    const t0 = performance.now();
    const res = fastLayered(input);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(3000);
    checkGeometry(input, res.positions);
    // Barycenter placement keeps the single target near the middle of its dependencies.
    const final = res.positions.get("T.final");
    const b = layoutBounds(res.positions, new Map(input.nodes.map((n) => [n.id, n])));
    expect(final?.y ?? 0).toBeGreaterThan(b.y);
    expect(final?.y ?? 0).toBeLessThan(b.y + b.height);
  });
});

describe("fitViewportFor", () => {
  it("centres the bounds and contains them when the zoom is not clamped", () => {
    const b = { x: 12, y: 40, width: 9000, height: 4000 };
    const vp = fitViewportFor(b, 1200, 800);
    const toScreen = (x: number, y: number) => ({ x: x * vp.zoom + vp.x, y: y * vp.zoom + vp.y });
    const tl = toScreen(b.x, b.y);
    const br = toScreen(b.x + b.width, b.y + b.height);
    expect(tl.x).toBeGreaterThanOrEqual(0);
    expect(tl.y).toBeGreaterThanOrEqual(0);
    expect(br.x).toBeLessThanOrEqual(1200);
    expect(br.y).toBeLessThanOrEqual(800);
    expect((tl.x + br.x) / 2).toBeCloseTo(600, 6);
  });
  it("clamps the zoom for huge graphs but still centres them", () => {
    const vp = fitViewportFor({ x: 0, y: 0, width: 400_000, height: 1000 }, 1000, 800);
    expect(vp.zoom).toBe(0.02);
    expect(0 + 200_000 * vp.zoom + vp.x).toBeCloseTo(500, 6);
  });
});
