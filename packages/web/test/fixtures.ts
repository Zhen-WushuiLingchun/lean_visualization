import { GraphFileSchema, type CheckerName, type CheckerResult, type CheckerStatus, type GraphFile, type Node, type VerifyResult } from "@proofflow/schema";
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
