import { describe, expect, it } from "vitest";
import { buildCone } from "../src/graph/cone";
import { buildIndex } from "../src/graph/graphIndex";
import { assignLayers } from "../src/graph/layers";
import { sample } from "./fixtures";

describe("assignLayers", () => {
  const idx = buildIndex(sample);
  for (const variant of [
    { hideAux: true, external: "collapse" as const },
    { hideAux: false, external: "expand" as const },
    { hideAux: true, external: "hide" as const },
  ]) {
    it(`puts axioms first, sinks last and edges left to right (${variant.external}, aux ${variant.hideAux ? "hidden" : "shown"})`, () => {
      const cone = buildCone(idx, { mode: "cone", targets: idx.localSinks, depthLimit: null, site: "all", ...variant });
      const L = assignLayers(
        cone.nodes.map((n) => n.id),
        cone.edges,
        (id) => !!cone.byId.get(id)?.isTarget,
      );
      expect(L.feedback.size).toBe(0);
      for (const n of cone.nodes) if (n.decl?.kind === "axiom") expect(L.layer.get(n.id)).toBe(0);
      for (const t of cone.targets) expect(L.layer.get(t)).toBe(L.maxLayer);
      for (const e of cone.edges) expect(L.layer.get(e.source) ?? -1).toBeLessThan(L.layer.get(e.target) ?? -1);
      expect(L.order).toHaveLength(cone.nodes.length);
      const pos = new Map(L.order.map((id, i) => [id, i]));
      for (const e of cone.edges) expect(pos.get(e.source) ?? 0).toBeLessThan(pos.get(e.target) ?? 0);
    });
  }

  it("uses the longest path, not the shortest", () => {
    const L = assignLayers(["a", "b", "c", "d"], [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "a", target: "c" },
      { source: "c", target: "d" },
    ]);
    expect([L.layer.get("a"), L.layer.get("b"), L.layer.get("c"), L.layer.get("d")]).toEqual([0, 1, 2, 3]);
  });

  it("pushes every sink to the last column", () => {
    const L = assignLayers(["a", "b", "c", "s"], [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "a", target: "s" },
    ]);
    expect(L.layer.get("s")).toBe(2);
    expect(L.layer.get("c")).toBe(2);
  });

  it("breaks cycles instead of looping", () => {
    const edges = [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "c", target: "b" },
      { source: "c", target: "d" },
    ];
    const L = assignLayers(["a", "b", "c", "d"], edges);
    expect(L.feedback.size).toBe(1);
    edges.forEach((e, k) => {
      if (!L.feedback.has(k)) expect(L.layer.get(e.source) ?? 0).toBeLessThan(L.layer.get(e.target) ?? 0);
    });
  });
});
