import { GraphFileSchema, L1_CHECKERS, type CheckerInfo, type CheckerName, type CheckerResult, type CheckerStatus, type GraphFile, type Node, type VerifyResult } from "@proofflow/schema";
import raw from "../public/fixtures/sample.json";

/** The bundled sample, validated. */
export const sample: GraphFile = GraphFileSchema.parse(raw);

const FLAGS: Node["flags"] = {
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
};

/** Build a node with sensible defaults for synthetic test graphs. */
export function node(id: string, extra: Partial<Node> & { stmt?: string[]; proof?: string[] } = {}): Node {
  const { stmt, proof, ...rest } = extra;
  return {
    id,
    shortName: id.split(".").pop() ?? id,
    kind: "theorem",
    subKind: "none",
    module: "T.Basic",
    package: "T",
    isLocal: true,
    isAux: false,
    src: null,
    doc: null,
    statement: "True",
    statementTruncated: false,
    levelParams: [],
    flags: FLAGS,
    axioms: [],
    taints: [],
    deps: { stmt: stmt ?? [], proof: proof ?? [] },
    depsComplete: true,
    ...rest,
  };
}

export function graphOf(nodes: Node[], localSinks: string[] = []): GraphFile {
  return {
    meta: {
      schemaVersion: 1,
      generatedAt: "2026-09-27T00:00:00Z",
      extractor: { name: "test", version: "0" },
      lean: { version: "4.35.0-rc3", githash: "x" },
      project: { name: "t", dir: "/t", roots: ["T"], localPrefixes: ["T"] },
      options: { expandExternal: false, statementMaxChars: 2000 },
    },
    stats: {
      nodes: nodes.length,
      localNodes: nodes.filter((n) => n.isLocal).length,
      externalNodes: nodes.filter((n) => !n.isLocal).length,
      edges: 0,
      byKind: {},
      byTaint: {},
      localSinks,
      axiomNodes: nodes.filter((n) => n.kind === "axiom").map((n) => n.id),
    },
    nodes,
  };
}

export function row(checker: CheckerName, status: CheckerStatus, extra: Partial<CheckerResult> = {}): CheckerResult {
  return {
    checker,
    status,
    exitCode: status === "accepted" ? 0 : status === "rejected" ? 1 : status === "declined" ? 2 : null,
    durationMs: 120,
    command: [checker],
    stdoutTail: "",
    stderrTail: "",
    rejectedDecl: null,
    ...extra,
  };
}

export function result(checkers: CheckerResult[], extra: Partial<VerifyResult> = {}): VerifyResult {
  return {
    decl: "Demo.x",
    module: "Demo",
    exportHash: "abc123",
    exportBytes: 1000,
    exportDecls: 10,
    exportDurationMs: 900,
    verifiedAt: "2026-09-27T10:00:00.000Z",
    leanVersion: "4.35.0-rc3",
    checkers,
    verdict: "accepted",
    ...extra,
  };
}

export function checkerInfo(checker: CheckerName, available: boolean, note: string | null = null): CheckerInfo {
  return {
    checker,
    available,
    path: available ? `C:/elan/bin/${checker}` : null,
    version: available ? "4.35.0-rc3" : null,
    level: (L1_CHECKERS as readonly string[]).includes(checker) ? "L1" : "L2",
    note,
  };
}

/** /api/checkers on Lean 4.35+: export replay available, module replay offered as an alternative. */
export const CHECKERS_435: CheckerInfo[] = [
  checkerInfo("leanchecker", true),
  checkerInfo("leanchecker-module", false, "Not needed: leanexport is available."),
  checkerInfo("leanchecker-paranoid", false, "Binary not found in this toolchain."),
  checkerInfo("lean4lean", true),
  checkerInfo("nanoda", true),
  checkerInfo("con-leche", true),
  checkerInfo("con-ron", true),
];

/** /api/checkers on an older toolchain without leanexport. */
export const CHECKERS_OLD: CheckerInfo[] = [
  checkerInfo("leanchecker", false, "leanexport is missing (Lean < 4.35)."),
  checkerInfo("leanchecker-module", true, "Replays the whole module from its .olean; imports are trusted."),
  checkerInfo("leanchecker-paranoid", false, "Needs leanexport."),
  checkerInfo("lean4lean", false, "Needs leanexport."),
  checkerInfo("nanoda", false, "Needs leanexport."),
  checkerInfo("con-leche", false, "Needs leanexport."),
  checkerInfo("con-ron", false, "Needs leanexport."),
];

/** /api/checkers when no kernel replay is possible. */
export const CHECKERS_NONE: CheckerInfo[] = CHECKERS_OLD.map((c) =>
  c.checker === "leanchecker-module" ? checkerInfo("leanchecker-module", false, "lake env leanchecker failed: toolchain not found.") : c,
);

/** `layers` columns of `perLayer` theorems, each using two nodes of the previous column, plus one final theorem. */
export function layeredGraph(layers: number, perLayer: number): GraphFile {
  const nodes: Node[] = [];
  for (let i = 0; i < layers; i++) {
    for (let j = 0; j < perLayer; j++) {
      const proof = i === 0 ? [] : [`T.l${i - 1}n${j}`, `T.l${i - 1}n${(j + 1) % perLayer}`];
      nodes.push(node(`T.l${i}n${j}`, { proof }));
    }
  }
  nodes.push(node("T.final", { proof: Array.from({ length: perLayer }, (_, j) => `T.l${layers - 1}n${j}`) }));
  return graphOf(nodes, ["T.final"]);
}

/** `sinks` final theorems, each on top of its own chain of `depth` lemmas. */
export function chainsGraph(sinks: number, depth: number): GraphFile {
  const nodes: Node[] = [];
  const sinkIds: string[] = [];
  for (let k = 0; k < sinks; k++) {
    for (let i = 0; i < depth; i++) nodes.push(node(`T.c${k}x${i}`, { proof: i === 0 ? [] : [`T.c${k}x${i - 1}`] }));
    nodes.push(node(`T.s${k}`, { proof: [`T.c${k}x${depth - 1}`] }));
    sinkIds.push(`T.s${k}`);
  }
  return graphOf(nodes, sinkIds);
}
