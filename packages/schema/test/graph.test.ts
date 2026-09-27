import { describe, expect, it } from "vitest";
import {
  GraphFileSchema,
  classifyAxiom,
  edgesOf,
  taintsFromAxioms,
  verdictOf,
  worstTaint,
  type CheckerResult,
  type GraphFile,
} from "../src/index.js";

function node(id: string, deps: { stmt?: string[]; proof?: string[] } = {}, extra: Partial<GraphFile["nodes"][number]> = {}) {
  return {
    id,
    shortName: id.split(".").pop() ?? id,
    kind: "theorem" as const,
    subKind: "none" as const,
    module: "Toy.Basic",
    package: "Toy",
    isLocal: true,
    isAux: false,
    src: null,
    doc: null,
    statement: "True",
    statementTruncated: false,
    levelParams: [],
    flags: {
      unsafe: false,
      partial: false,
      noncomputable: false,
      extern: false,
      implementedBy: false,
      private: false,
      protected: false,
      instance: false,
      directSorry: false,
      directNativeDecide: false,
    },
    axioms: [],
    taints: [],
    deps: { stmt: deps.stmt ?? [], proof: deps.proof ?? [] },
    depsComplete: true,
    ...extra,
  };
}

const sample: GraphFile = {
  meta: {
    schemaVersion: 1,
    generatedAt: "2026-09-27T00:00:00Z",
    extractor: { name: "proofflow-extract", version: "0.1.0" },
    lean: { version: "4.35.0-rc3", githash: "470d5ce" },
    project: { name: "toy", dir: "F:/toy", roots: ["Toy"], localPrefixes: ["Toy"] },
    options: { expandExternal: false, statementMaxChars: 2000 },
  },
  stats: {
    nodes: 3,
    localNodes: 2,
    externalNodes: 1,
    edges: 2,
    byKind: { theorem: 2, axiom: 1 },
    byTaint: {},
    localSinks: ["Toy.main"],
    axiomNodes: ["propext"],
  },
  nodes: [
    node("propext", {}, { kind: "axiom", isLocal: false, module: "Init.Core", package: "Init", depsComplete: false }),
    node("Toy.lemma", { proof: ["propext"] }, { axioms: ["propext"] }),
    node("Toy.main", { stmt: ["Toy.lemma"], proof: ["Toy.lemma", "Toy.missing"] }, { axioms: ["propext"] }),
  ],
};

describe("GraphFileSchema", () => {
  it("accepts a well-formed graph", () => {
    expect(GraphFileSchema.safeParse(sample).success).toBe(true);
  });
  it("rejects an unknown schema version", () => {
    const bad = { ...sample, meta: { ...sample.meta, schemaVersion: 2 } };
    expect(GraphFileSchema.safeParse(bad).success).toBe(false);
  });
});

describe("edgesOf", () => {
  it("derives dependency → dependent edges with the right site", () => {
    const edges = edgesOf(sample);
    expect(edges).toContainEqual({ source: "propext", target: "Toy.lemma", site: "proof" });
    expect(edges).toContainEqual({ source: "Toy.lemma", target: "Toy.main", site: "both" });
    expect(edges.some((e) => e.source === "Toy.missing")).toBe(false);
  });
  it("keeps dangling edges on request", () => {
    const edges = edgesOf(sample, true);
    expect(edges).toContainEqual({ source: "Toy.missing", target: "Toy.main", site: "proof" });
  });
});

describe("axiom classification", () => {
  it("knows the standard axioms", () => {
    expect(classifyAxiom("propext")).toBe("standard");
    expect(classifyAxiom("Classical.choice")).toBe("standard");
    expect(classifyAxiom("Quot.sound")).toBe("standard");
  });
  it("recognises sorry and both native_decide encodings", () => {
    expect(classifyAxiom("sorryAx")).toBe("sorry");
    expect(classifyAxiom("Lean.ofReduceBool")).toBe("nativeDecide");
    expect(classifyAxiom("t3._native.native_decide.ax_1_1")).toBe("nativeDecide");
  });
  it("treats everything else as custom", () => {
    expect(classifyAxiom("Toy.myAxiom")).toBe("custom");
  });
});

describe("taints", () => {
  it("derives taints from axioms and orders them by severity", () => {
    const t = taintsFromAxioms(["sorryAx", "Toy.ax", "propext"], ["unsafe"]);
    expect(t).toEqual(["unsafe", "customAxiom", "sorry"]);
    expect(worstTaint(t)).toBe("sorry");
    expect(worstTaint([])).toBeNull();
  });
});

describe("verdictOf", () => {
  const base = (checker: CheckerResult["checker"], status: CheckerResult["status"]): CheckerResult => ({
    checker,
    status,
    exitCode: status === "accepted" ? 0 : 1,
    durationMs: 1,
    command: [checker],
    stdoutTail: "",
    stderrTail: "",
    rejectedDecl: null,
  });
  it("is accepted only when every non-skipped checker accepted", () => {
    expect(verdictOf([base("leanchecker", "accepted"), base("nanoda", "skipped")])).toBe("accepted");
  });
  it("prefers rejected over error over partial", () => {
    expect(verdictOf([base("leanchecker", "accepted"), base("con-ron", "rejected"), base("nanoda", "error")])).toBe("rejected");
    expect(verdictOf([base("leanchecker", "accepted"), base("nanoda", "timeout")])).toBe("error");
    expect(verdictOf([base("leanchecker", "accepted"), base("con-leche", "declined")])).toBe("partial");
    expect(verdictOf([base("leanchecker", "accepted"), base("lean4lean", "unavailable")])).toBe("partial");
  });
  it("is partial when nothing ran", () => {
    expect(verdictOf([base("nanoda", "skipped")])).toBe("partial");
  });
});
