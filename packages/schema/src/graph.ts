import { z } from "zod";

/** Bump when the on-disk shape of graph.json changes incompatibly. */
export const SCHEMA_VERSION = 1 as const;

/** Kind of a Lean constant, mirroring `Lean.ConstantInfo` constructors. */
export const DeclKindSchema = z.enum([
  "axiom",
  "theorem",
  "definition",
  "opaque",
  "inductive",
  "constructor",
  "recursor",
  "quot",
]);
export type DeclKind = z.infer<typeof DeclKindSchema>;

/** Refinement of `kind` from attributes and structure info. `none` when nothing applies. */
export const DeclSubKindSchema = z.enum([
  "none",
  "abbrev",
  "instance",
  "structure",
  "class",
]);
export type DeclSubKind = z.infer<typeof DeclSubKindSchema>;

/**
 * Transitive trust taints. A taint on a node means the node, or something it depends on
 * (through statement or proof), has the property.
 */
export const TaintSchema = z.enum([
  "sorry", // sorryAx reachable
  "nativeDecide", // Lean.ofReduceBool or Lean.ofReduceNat reachable
  "customAxiom", // an axiom outside the standard three and the two above is reachable
  "unsafe", // an `unsafe` declaration is reachable
  "partial", // a `partial def` is reachable
  "extern", // an `@[extern]` declaration is reachable
  "implementedBy", // an `@[implemented_by]` declaration is reachable
]);
export type Taint = z.infer<typeof TaintSchema>;

/** Ordered from least to most severe. Used by `worstTaint`. */
export const TAINT_SEVERITY: readonly Taint[] = [
  "implementedBy",
  "extern",
  "partial",
  "unsafe",
  "nativeDecide",
  "customAxiom",
  "sorry",
];

export const STANDARD_AXIOMS = ["propext", "Classical.choice", "Quot.sound"] as const;
export const SORRY_AXIOM = "sorryAx" as const;
/**
 * `Lean.trustCompiler` is the axiom `Lean.ofReduceBool` / `ofReduceNat` rest on in Lean ≤ 4.34;
 * it means the same thing (the compiler was trusted), so it is classified with them.
 */
export const NATIVE_DECIDE_AXIOMS = ["Lean.ofReduceBool", "Lean.ofReduceNat", "Lean.trustCompiler"] as const;

export const SourceRangeSchema = z.object({
  /**
   * Local declarations: path relative to the audited project root. External declarations: path
   * relative to the source search-path root that contains the module (e.g. `Init/Prelude.lean`),
   * so the value is the same on every machine. Forward slashes.
   */
  file: z.string(),
  line: z.number().int().nonnegative(),
  col: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  endCol: z.number().int().nonnegative(),
});
export type SourceRange = z.infer<typeof SourceRangeSchema>;

/** Direct (non-transitive) properties of the declaration itself. */
export const NodeFlagsSchema = z.object({
  unsafe: z.boolean(),
  partial: z.boolean(),
  noncomputable: z.boolean(),
  extern: z.boolean(),
  implementedBy: z.boolean(),
  private: z.boolean(),
  protected: z.boolean(),
  instance: z.boolean(),
  /** `sorryAx` appears directly in this declaration's type or value. */
  directSorry: z.boolean(),
  /** `Lean.ofReduceBool`/`ofReduceNat` appears directly in this declaration's value. */
  directNativeDecide: z.boolean(),
});
export type NodeFlags = z.infer<typeof NodeFlagsSchema>;

export const NodeSchema = z.object({
  /** Fully qualified Lean name, `Name.toString`. Unique. */
  id: z.string().min(1),
  /** Last name component, for labels. */
  shortName: z.string(),
  kind: DeclKindSchema,
  subKind: DeclSubKindSchema,
  /** Module the declaration lives in, e.g. `Mathlib.Data.Nat.Basic`. */
  module: z.string(),
  /** First module component (`Init`, `Std`, `Lean`, `Mathlib`, ...) or the project library name. */
  package: z.string(),
  /** True when `module` belongs to the audited project's own libraries. */
  isLocal: z.boolean(),
  /** Auto-generated companion (recursor, casesOn, eq lemma, match aux, ...). Hidden by default. */
  isAux: z.boolean(),
  src: SourceRangeSchema.nullable(),
  doc: z.string().nullable(),
  /** Pretty-printed type, possibly truncated. */
  statement: z.string(),
  statementTruncated: z.boolean(),
  levelParams: z.array(z.string()),
  flags: NodeFlagsSchema,
  /** Complete transitive set of axiom constants reachable from this declaration. Sorted. */
  axioms: z.array(z.string()),
  /** Transitive taints, see `TaintSchema`. Sorted by severity ascending. */
  taints: z.array(TaintSchema),
  /**
   * Direct dependencies by site. `stmt` = constants used in the type; `proof` = constants used in
   * the value (`allowOpaque := true`). They may overlap. Ids only; targets may be absent from
   * `nodes` when the node is an unexpanded boundary node.
   */
  deps: z.object({
    stmt: z.array(z.string()),
    proof: z.array(z.string()),
  }),
  /** False for boundary (external, unexpanded) nodes whose own dependencies were not emitted. */
  depsComplete: z.boolean(),
});
export type Node = z.infer<typeof NodeSchema>;

export const GraphMetaSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  /** ISO-8601 timestamp. */
  generatedAt: z.string(),
  extractor: z.object({ name: z.string(), version: z.string() }),
  lean: z.object({ version: z.string(), githash: z.string() }),
  project: z.object({
    name: z.string(),
    /** Absolute path of the audited project root, forward slashes. */
    dir: z.string(),
    /** Root modules that were imported. */
    roots: z.array(z.string()),
    /** Module-name prefixes considered local. */
    localPrefixes: z.array(z.string()),
  }),
  options: z.object({
    expandExternal: z.boolean(),
    statementMaxChars: z.number().int().positive(),
  }),
});
export type GraphMeta = z.infer<typeof GraphMetaSchema>;

export const GraphStatsSchema = z.object({
  nodes: z.number().int().nonnegative(),
  localNodes: z.number().int().nonnegative(),
  externalNodes: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
  byKind: z.record(z.string(), z.number().int().nonnegative()),
  /** Number of local nodes carrying each taint. */
  byTaint: z.record(z.string(), z.number().int().nonnegative()),
  /** Local nodes that no other local node depends on: the project's "final results". */
  localSinks: z.array(z.string()),
  /** Axiom nodes reachable from local nodes, including standard ones. */
  axiomNodes: z.array(z.string()),
});
export type GraphStats = z.infer<typeof GraphStatsSchema>;

/** The whole `graph.json` file. Edges are not stored; derive them with `edgesOf`. */
export const GraphFileSchema = z.object({
  meta: GraphMetaSchema,
  stats: GraphStatsSchema,
  nodes: z.array(NodeSchema),
});
export type GraphFile = z.infer<typeof GraphFileSchema>;

export const EdgeSiteSchema = z.enum(["stmt", "proof", "both"]);
export type EdgeSite = z.infer<typeof EdgeSiteSchema>;

/** Direction is fixed: `source` is the dependency, `target` is the dependent (axiom → theorem). */
export interface Edge {
  source: string;
  target: string;
  site: EdgeSite;
}

/**
 * Derive the edge list from node dependencies. Edges whose source is not present in `graph.nodes`
 * are dropped unless `keepDangling` is true.
 */
export function edgesOf(graph: Pick<GraphFile, "nodes">, keepDangling = false): Edge[] {
  const present = new Set(graph.nodes.map((n) => n.id));
  const out: Edge[] = [];
  for (const node of graph.nodes) {
    const stmt = new Set(node.deps.stmt);
    const proof = new Set(node.deps.proof);
    const all = new Set([...stmt, ...proof]);
    for (const dep of all) {
      if (!keepDangling && !present.has(dep)) continue;
      const site: EdgeSite = stmt.has(dep) ? (proof.has(dep) ? "both" : "stmt") : "proof";
      out.push({ source: dep, target: node.id, site });
    }
  }
  return out;
}

export function isStandardAxiom(name: string): boolean {
  return (STANDARD_AXIOMS as readonly string[]).includes(name);
}

/**
 * `native_decide` support. Lean ≤ 4.34 adds `Lean.ofReduceBool` / `Lean.ofReduceNat`; Lean 4.35+
 * mints a per-use auxiliary axiom named `<decl>._native.native_decide.ax_<i>_<j>` (verified on
 * v4.35.0-rc3, where `#print axioms` lists only that axiom).
 */
export function isNativeDecideAxiom(name: string): boolean {
  if ((NATIVE_DECIDE_AXIOMS as readonly string[]).includes(name)) return true;
  return name.includes("._native.");
}

/** Classify an axiom name the way the viewer colours it. */
export type AxiomClass = "standard" | "sorry" | "nativeDecide" | "custom";
export function classifyAxiom(name: string): AxiomClass {
  if (isStandardAxiom(name)) return "standard";
  if (name === SORRY_AXIOM) return "sorry";
  if (isNativeDecideAxiom(name)) return "nativeDecide";
  return "custom";
}

/** Most severe taint in the list, or null when the node rests only on standard axioms. */
export function worstTaint(taints: readonly Taint[]): Taint | null {
  let worst: Taint | null = null;
  let worstIdx = -1;
  for (const t of taints) {
    const idx = TAINT_SEVERITY.indexOf(t);
    if (idx > worstIdx) {
      worst = t;
      worstIdx = idx;
    }
  }
  return worst;
}

/** Recompute taints from an axiom set plus flag taints; the extractor and tests use the same rule. */
export function taintsFromAxioms(axioms: readonly string[], flagTaints: readonly Taint[] = []): Taint[] {
  const set = new Set<Taint>(flagTaints);
  for (const a of axioms) {
    const c = classifyAxiom(a);
    if (c === "sorry") set.add("sorry");
    else if (c === "nativeDecide") set.add("nativeDecide");
    else if (c === "custom") set.add("customAxiom");
  }
  return TAINT_SEVERITY.filter((t) => set.has(t));
}
