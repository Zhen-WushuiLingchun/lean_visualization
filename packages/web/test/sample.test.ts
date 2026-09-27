import { describe, expect, it } from "vitest";
import { GraphFileSchema, edgesOf, taintsFromAxioms } from "@proofflow/schema";
import raw from "../public/fixtures/sample.json";

describe("public/fixtures/sample.json", () => {
  const parsed = GraphFileSchema.safeParse(raw);

  it("is a schema-valid GraphFile", () => {
    expect(parsed.success).toBe(true);
  });

  const g = GraphFileSchema.parse(raw);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));

  it("covers every trust case the viewer draws", () => {
    for (const a of ["propext", "Classical.choice", "Quot.sound", "sorryAx", "Demo.Axioms.oracle"]) expect(byId.get(a)?.kind).toBe("axiom");
    expect(g.nodes.some((n) => n.kind === "axiom" && n.id.includes("._native."))).toBe(true);
    expect(g.nodes.some((n) => n.isAux)).toBe(true);
    expect(g.nodes.some((n) => n.package === "Init" && !n.isLocal && n.kind !== "axiom")).toBe(true);
    expect(g.nodes.some((n) => n.package === "Mathlib" && !n.isLocal)).toBe(true);
    expect(g.nodes.some((n) => n.kind === "inductive" && n.subKind === "structure")).toBe(true);
    expect(g.nodes.some((n) => n.subKind === "instance")).toBe(true);
    expect(g.stats.localSinks).toHaveLength(2);
  });

  it("has consistent stats and taints", () => {
    expect(g.stats.nodes).toBe(g.nodes.length);
    expect(g.stats.edges).toBe(edgesOf(g).length);
    for (const n of g.nodes) {
      const flagTaints = n.taints.filter((t) => t === "unsafe" || t === "partial" || t === "extern" || t === "implementedBy");
      expect(n.taints).toEqual(taintsFromAxioms(n.axioms, flagTaints));
    }
    // Axioms have no incoming edges; local sinks have no local dependents.
    const edges = edgesOf(g);
    for (const e of edges) expect(byId.get(e.target)?.kind).not.toBe("axiom");
    for (const s of g.stats.localSinks) expect(edges.some((e) => e.source === s && byId.get(e.target)?.isLocal)).toBe(false);
  });
});
