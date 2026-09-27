import { describe, expect, it } from "vitest";
import { buildCone } from "../src/graph/cone";
import { buildIndex } from "../src/graph/graphIndex";
import { assignLayers } from "../src/graph/layers";
import { elkOptionsFor, runLayout, selectLayoutEdges, toElkGraph } from "../src/graph/layout";
import { measureAll, NODE_HEIGHT, NODE_MAX_WIDTH, NODE_MIN_WIDTH } from "../src/graph/measure";
import { sample } from "./fixtures";

describe("layout", () => {
  const idx = buildIndex(sample);
  const cone = buildCone(idx, { mode: "cone", targets: idx.localSinks, depthLimit: null, hideAux: false, external: "collapse", site: "all" });
  const L = assignLayers(
    cone.nodes.map((n) => n.id),
    cone.edges,
    (id) => !!cone.byId.get(id)?.isTarget,
  );
  const sizes = measureAll(cone.nodes);

  it("measures every node before layout", () => {
    for (const n of cone.nodes) {
      const s = sizes.get(n.id);
      expect(s).toBeDefined();
      const scale = n.isAux ? 0.7 : 1;
      expect(s?.height).toBe(Math.round(NODE_HEIGHT * scale));
      expect(s?.width ?? 0).toBeGreaterThanOrEqual(Math.round(NODE_MIN_WIDTH * scale));
      expect(s?.width ?? 0).toBeLessThanOrEqual(Math.round(NODE_MAX_WIDTH * scale));
    }
  });

  it("passes the layer index as the ELK partition", () => {
    const g = toElkGraph({
      nodes: cone.nodes.map((n) => ({ id: n.id, width: 10, height: 10, layer: L.layer.get(n.id) ?? 0 })),
      edges: cone.edges,
    });
    expect(g.children?.find((c) => c.id === "propext")?.layoutOptions?.["elk.partitioning.partition"]).toBe("0");
    expect(elkOptionsFor(10)["elk.partitioning.activate"]).toBe("true");
    expect(elkOptionsFor(10)["elk.direction"]).toBe("RIGHT");
    expect(elkOptionsFor(2500)["elk.layered.thoroughness"]).toBe("1");
  });

  it("keeps adjacent-column edges and bounds dummy nodes for long ones", () => {
    // a chain of 6 columns plus long edges from the source to every node
    const nodes = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, width: 10, height: 10, layer: i }));
    const edges = [
      ...nodes.slice(1).map((n, i) => ({ id: `c${i}`, source: `n${i}`, target: n.id })),
      ...nodes.slice(2).map((n) => ({ id: `l${n.id}`, source: "n0", target: n.id })),
      { id: "iso", source: "x0", target: "x1" },
    ];
    const all = selectLayoutEdges({ nodes, edges }, 100);
    expect(all).toHaveLength(9);
    const tight = selectLayoutEdges({ nodes, edges }, 0.5); // budget 3 dummies
    expect(tight.filter((e) => e.id.startsWith("c"))).toHaveLength(5);
    const dummies = tight.reduce((s, e) => s + Math.max(0, Number(e.target.slice(1)) - Number(e.source.slice(1)) - 1), 0);
    expect(dummies).toBeLessThanOrEqual(3);
    // An unconnected node gets its edge before extra long edges, but never beyond the budget.
    const sink = { nodes: [...nodes, { id: "s", width: 10, height: 10, layer: 5 }], edges: [...edges, { id: "far", source: "n2", target: "s" }] };
    const withRoom = selectLayoutEdges(sink, 3 / 7); // 3 dummies: n2 -> s (2) beats n0 -> n3 (2)
    expect(withRoom.some((e) => e.target === "s")).toBe(true);
    expect(selectLayoutEdges(sink, 0).some((e) => e.target === "s")).toBe(false);
  });

  it("places columns in layer order with ELK (main thread in tests)", async () => {
    const res = await runLayout(
      {
        nodes: cone.nodes.map((n) => ({ id: n.id, ...(sizes.get(n.id) ?? { width: 100, height: 50 }), layer: L.layer.get(n.id) ?? 0 })),
        edges: cone.edges,
      },
      { choice: "elk", elkThread: "main" },
    );
    expect(res.engine).toBe("elk-main");
    expect(res.positions.size).toBe(cone.nodes.length);
    for (const e of cone.edges) {
      const a = res.positions.get(e.source);
      const b = res.positions.get(e.target);
      expect((a?.x ?? 0) + (sizes.get(e.source)?.width ?? 0)).toBeLessThanOrEqual(b?.x ?? 0);
    }
    // ELK right-aligns the nodes of a layer: axioms form the leftmost column, targets the rightmost.
    const right = (id: string): number => (res.positions.get(id)?.x ?? 0) + (sizes.get(id)?.width ?? 0);
    const left = (id: string): number => res.positions.get(id)?.x ?? 0;
    const axioms = cone.nodes.filter((n) => n.decl?.kind === "axiom").map((n) => n.id);
    expect(new Set(axioms.map(right)).size).toBe(1);
    const axiomRight = right(axioms[0] as string);
    for (const n of cone.nodes) {
      if ((L.layer.get(n.id) ?? 0) === 0) expect(right(n.id)).toBe(axiomRight);
      else expect(left(n.id)).toBeGreaterThan(axiomRight);
    }
    expect(new Set(cone.targets.map(right)).size).toBe(1);
    const targetLeft = Math.min(...cone.targets.map(left));
    for (const n of cone.nodes) if (!cone.targets.includes(n.id)) expect(right(n.id)).toBeLessThan(targetLeft);
  }, 60_000);
});
