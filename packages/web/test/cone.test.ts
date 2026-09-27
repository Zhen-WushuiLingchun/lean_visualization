import { describe, expect, it } from "vitest";
import { buildCone, combineSite, packageNodeId, type ConeOptions } from "../src/graph/cone";
import { buildIndex } from "../src/graph/graphIndex";
import { graphOf, node, sample } from "./fixtures";

const base: ConeOptions = { mode: "cone", targets: [], depthLimit: null, hideAux: false, external: "expand", site: "all" };

/** a <- b <- c (stmt), c <- d (proof), aux x between b and d, external e. */
function chain() {
  return buildIndex(
    graphOf(
      [
        node("ax", { kind: "axiom", isLocal: false, module: "Init.Core", package: "Init", depsComplete: false, axioms: ["ax"] }),
        node("T.a", { proof: ["ax"] }),
        node("T.b", { stmt: ["T.a"] }),
        node("T.x", { isAux: true, kind: "definition", proof: ["T.b"] }),
        node("T.c", { stmt: ["T.b"] }),
        node("T.d", { proof: ["T.c", "T.x", "Ext.e"] }),
        node("Ext.e", { isLocal: false, module: "Ext.Mod", package: "Ext", depsComplete: false, stmt: ["Ext.hidden"], axioms: ["ax"] }),
        node("T.unrelated", { proof: ["T.a"] }),
      ],
      ["T.d", "T.unrelated"],
    ),
  );
}

const ids = (c: { nodes: { id: string }[] }): string[] => c.nodes.map((n) => n.id).sort();
const hasEdge = (c: { edges: { source: string; target: string }[] }, s: string, t: string): boolean => c.edges.some((e) => e.source === s && e.target === t);

describe("buildCone", () => {
  it("is the backward closure of the targets", () => {
    const c = buildCone(chain(), { ...base, targets: ["T.d"] });
    expect(ids(c)).toEqual(["Ext.e", "T.a", "T.b", "T.c", "T.d", "T.x", "ax"]);
    expect(c.nodes.find((n) => n.id === "T.d")?.isTarget).toBe(true);
    expect(ids(c)).not.toContain("T.unrelated");
  });

  it("respects the depth limit and marks cut nodes", () => {
    const c = buildCone(chain(), { ...base, targets: ["T.d"], depthLimit: 1 });
    expect(ids(c)).toEqual(["Ext.e", "T.c", "T.d", "T.x"]);
    expect(c.nodes.find((n) => n.id === "T.c")?.truncated).toBe(true);
    expect(c.counts.truncated).toBeGreaterThan(0);
  });

  it("does not count hidden aux nodes towards the depth", () => {
    const c = buildCone(chain(), { ...base, targets: ["T.d"], depthLimit: 1, hideAux: true });
    // T.b is reached through the hidden T.x at depth 1.
    expect(ids(c)).toContain("T.b");
  });

  it("folds aux nodes while preserving connectivity", () => {
    const c = buildCone(chain(), { ...base, targets: ["T.d"], hideAux: true });
    expect(ids(c)).not.toContain("T.x");
    expect(c.counts.hiddenAux).toBe(1);
    const folded = c.edges.find((e) => e.source === "T.b" && e.target === "T.d");
    expect(folded).toBeDefined();
    expect(folded?.folded).toBe(true);
    expect(folded?.site).toBe("proof");
    // Every node that could reach the target through aux nodes still can.
    const reach = new Set(["T.d"]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of c.edges) if (reach.has(e.target) && !reach.has(e.source)) (reach.add(e.source), (grew = true));
    }
    expect([...reach].sort()).toEqual(ids(c));
  });

  it("collapses external declarations into one node per package, keeping axioms", () => {
    const c = buildCone(chain(), { ...base, targets: ["T.d"], external: "collapse" });
    const pid = packageNodeId("Ext");
    expect(ids(c)).toContain(pid);
    expect(ids(c)).not.toContain("Ext.e");
    expect(ids(c)).toContain("ax");
    const pkg = c.byId.get(pid);
    expect(pkg?.type).toBe("package");
    expect(pkg?.members).toEqual(["Ext.e"]);
    expect(hasEdge(c, pid, "T.d")).toBe(true);
    expect(hasEdge(c, "ax", pid)).toBe(true);
    expect(c.counts.collapsedExternal).toBe(1);
  });

  it("draws implied axiom edges into unexpanded boundary nodes", () => {
    const c = buildCone(chain(), { ...base, targets: ["T.d"] });
    expect(c.edges.find((e) => e.source === "ax" && e.target === "Ext.e")?.site).toBe("axiom");
  });

  it("hides externals by folding through them", () => {
    const c = buildCone(chain(), { ...base, targets: ["T.d"], external: "hide" });
    expect(ids(c)).not.toContain("Ext.e");
    const e = c.edges.find((x) => x.source === "ax" && x.target === "T.d");
    expect(e?.site).toBe("axiom");
  });

  it("filters by edge site", () => {
    const c = buildCone(chain(), { ...base, targets: ["T.c"], site: "stmt" });
    expect(ids(c)).toEqual(["T.a", "T.b", "T.c"]);
    const p = buildCone(chain(), { ...base, targets: ["T.c"], site: "proof" });
    expect(ids(p)).toEqual(["T.c"]);
  });

  it("reports missing targets and project mode seeds", () => {
    const c = buildCone(chain(), { ...base, targets: ["T.d", "Nope"] });
    expect(c.missingTargets).toEqual(["Nope"]);
    const p = buildCone(chain(), { ...base, mode: "project", external: "collapse" });
    expect(ids(p)).toContain("T.unrelated");
    expect(p.targets.sort()).toEqual(["T.d", "T.unrelated"]);
  });

  it("merges sites of parallel edges", () => {
    expect(combineSite("stmt", "proof")).toBe("both");
    expect(combineSite("axiom", "proof")).toBe("proof");
    expect(combineSite("stmt", "stmt")).toBe("stmt");
  });

  it("drops edges into axioms and synthesises axioms missing from the file", () => {
    const idx = buildIndex(
      graphOf([
        node("T.myAx", { kind: "axiom", stmt: ["T.def"], axioms: ["T.myAx"] }),
        node("T.def", { kind: "definition" }),
        node("B.ext", { isLocal: false, package: "B", depsComplete: false, axioms: ["Classical.choice"] }),
        node("T.t", { proof: ["T.myAx", "B.ext"] }),
      ]),
    );
    expect(idx.droppedAxiomInEdges).toBe(1);
    expect(idx.synthetic.has("Classical.choice")).toBe(true);
    const c = buildCone(idx, { ...base, targets: ["T.t"] });
    expect(ids(c)).toEqual(["B.ext", "Classical.choice", "T.myAx", "T.t"]);
    expect(c.byId.get("Classical.choice")?.isSynthetic).toBe(true);
  });

  it("builds the default view of the sample", () => {
    const idx = buildIndex(sample);
    const c = buildCone(idx, { ...base, targets: idx.localSinks, hideAux: true, external: "collapse" });
    expect(c.targets.sort()).toEqual(["Demo.Main.clean_result", "Demo.Main.main_theorem"]);
    expect(c.nodes.some((n) => n.isAux)).toBe(false);
    expect(ids(c)).toContain(packageNodeId("Init"));
    expect(ids(c)).toContain(packageNodeId("Mathlib"));
    for (const a of ["propext", "Classical.choice", "Quot.sound", "sorryAx", "Demo.Axioms.oracle"]) expect(ids(c)).toContain(a);
  });
});
