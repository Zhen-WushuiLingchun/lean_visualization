import Graph from "graphology";
import { classifyAxiom, edgesOf, taintsFromAxioms, type EdgeSite, type GraphFile, type Node } from "@proofflow/schema";

/**
 * Edge site in the viewer. `axiom` is an implied edge: a boundary node (`depsComplete: false`) whose
 * own dependencies were not emitted still lists its transitive `axioms`, computed by the extractor.
 * Drawing those as edges keeps every axiom a source of the workflow. Nothing is recomputed here.
 */
export type ViewSite = EdgeSite | "axiom";

export interface EdgeAttrs {
  site: ViewSite;
}

export type DepGraph = Graph<Record<string, never>, EdgeAttrs>;

export interface GraphIndex {
  file: GraphFile;
  byId: Map<string, Node>;
  /** Position in `file.nodes`, for stable ordering. Synthetic nodes come last. */
  order: Map<string, number>;
  /** Whole-file dependency graph, edges dependency → dependent. */
  graph: DepGraph;
  /** False for the main-thread metadata index; dependency traversal must run in the worker. */
  dependenciesLoaded: boolean;
  /** Axiom ids that appear in a trust profile but have no node in graph.json. */
  synthetic: Set<string>;
  /** Edges into axiom nodes, dropped because the contract says axioms have no incoming edges. */
  droppedAxiomInEdges: number;
  /** `stats.localSinks` that exist in the graph (or a computed fallback when the list is empty). */
  localSinks: string[];
  localIds: string[];
  /** Every id, local first, for search. */
  searchIds: string[];
}

const NO_FLAGS: Node["flags"] = {
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

export function lastComponent(id: string): string {
  // Good enough for labels; «» escaped components with dots are rare.
  const i = id.lastIndexOf(".");
  return i >= 0 && i < id.length - 1 ? id.slice(i + 1) : id;
}

function syntheticAxiom(id: string): Node {
  const cls = classifyAxiom(id);
  return {
    id,
    shortName: lastComponent(id),
    kind: "axiom",
    subKind: "none",
    module: "",
    package: cls === "custom" ? "" : "Init",
    isLocal: false,
    isAux: false,
    src: null,
    doc: null,
    statement: "",
    statementTruncated: false,
    levelParams: [],
    flags: NO_FLAGS,
    axioms: [id],
    taints: taintsFromAxioms([id]),
    deps: { stmt: [], proof: [] },
    depsComplete: false,
  };
}

export function buildIndex(file: GraphFile, options: { metadataOnly?: boolean } = {}): GraphIndex {
  const byId = new Map<string, Node>();
  const order = new Map<string, number>();
  file.nodes.forEach((n, i) => {
    if (!byId.has(n.id)) {
      byId.set(n.id, n);
      order.set(n.id, i);
    }
  });

  // Axioms listed in trust profiles of boundary nodes (or in stats) but absent from `nodes`.
  const synthetic = new Set<string>();
  const wanted = new Set<string>(file.stats.axiomNodes);
  for (const n of file.nodes) if (!n.depsComplete) for (const a of n.axioms) wanted.add(a);
  for (const a of wanted) {
    if (byId.has(a)) continue;
    byId.set(a, syntheticAxiom(a));
    order.set(a, order.size);
    synthetic.add(a);
  }

  const graph: DepGraph = new Graph({ type: "directed", multi: false, allowSelfLoops: false });
  let droppedAxiomInEdges = 0;
  if (!options.metadataOnly) {
    for (const id of byId.keys()) graph.addNode(id);
    for (const e of edgesOf({ nodes: [...byId.values()] })) {
      if (e.source === e.target) continue;
      const target = byId.get(e.target);
      if (target?.kind === "axiom") {
        droppedAxiomInEdges++;
        continue;
      }
      if (!graph.hasEdge(e.source, e.target)) graph.addEdge(e.source, e.target, { site: e.site });
    }
    for (const n of file.nodes) {
      if (n.depsComplete || n.kind === "axiom") continue;
      for (const a of n.axioms) {
        if (a !== n.id && byId.has(a) && !graph.hasEdge(a, n.id)) graph.addEdge(a, n.id, { site: "axiom" });
      }
    }
  }

  const localIds = file.nodes.filter((n) => n.isLocal).map((n) => n.id);
  const localSinks = localSinksOf(file);
  const searchIds = [...localIds, ...[...byId.keys()].filter((id) => !byId.get(id)?.isLocal)];
  return { file, byId, order, graph, dependenciesLoaded: !options.metadataOnly, synthetic, droppedAxiomInEdges, localSinks, localIds, searchIds };
}

/**
 * The project's final theorems: `stats.localSinks` restricted to ids present in the file, or, when
 * the list is empty, local nodes that no other local node depends on.
 */
export function localSinksOf(file: GraphFile): string[] {
  const ids = new Set(file.nodes.map((n) => n.id));
  const listed = file.stats.localSinks.filter((id) => ids.has(id));
  if (listed.length > 0) return listed;
  const local = new Set(file.nodes.filter((n) => n.isLocal).map((n) => n.id));
  const used = new Set<string>();
  for (const e of edgesOf(file)) if (local.has(e.target) && e.source !== e.target) used.add(e.source);
  return [...local].filter((id) => !used.has(id));
}
