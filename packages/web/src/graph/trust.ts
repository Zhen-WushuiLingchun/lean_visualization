import type { AxiomClass, CheckerName, Taint } from "@proofflow/schema";
import type { BorderKey } from "./colors";

/** One-line explanations of each taint, following docs/VERIFICATION.md. */
export const TAINT_INFO: Record<Taint, { label: string; badge: string; explain: string; border: BorderKey }> = {
  sorry: {
    label: "sorry",
    badge: "sorry",
    explain: "Rests on sorryAx: a proof below this node is unfinished.",
    border: "sorry",
  },
  customAxiom: {
    label: "Custom axiom",
    badge: "axiom",
    explain: "Rests on a user-declared axiom. No checker can tell whether it is consistent.",
    border: "customAxiom",
  },
  nativeDecide: {
    label: "native_decide",
    badge: "native",
    explain: "Trusts compiled code through native_decide. The kernel did not check that step.",
    border: "nativeDecide",
  },
  unsafe: {
    label: "unsafe",
    badge: "unsafe",
    explain: "Reaches an unsafe declaration. The kernel never checks its body.",
    border: "flag",
  },
  partial: {
    label: "partial",
    badge: "partial",
    explain: "Reaches a partial def. The kernel sees it as opaque, not its body.",
    border: "flag",
  },
  extern: {
    label: "extern",
    badge: "extern",
    explain: "Reaches an @[extern] declaration. Compiled code is native, not kernel-checked.",
    border: "flag",
  },
  implementedBy: {
    label: "implemented_by",
    badge: "impl",
    explain: "Reaches an @[implemented_by] declaration. Compiled code may differ from the logic.",
    border: "flag",
  },
};

export const AXIOM_CLASS_INFO: Record<AxiomClass, { label: string; explain: string }> = {
  standard: { label: "Standard", explain: "propext, Classical.choice, Quot.sound: Lean's usual foundations." },
  sorry: { label: "sorry", explain: "sorryAx marks an unfinished proof." },
  nativeDecide: { label: "native_decide", explain: "Trusts the compiler (Lean.ofReduceBool or a _native axiom)." },
  custom: { label: "Custom", explain: "Declared by the project. Its consistency is not checked." },
};

export const CHECKER_INFO: Record<CheckerName, { level: "L1" | "L2"; explain: string }> = {
  leanchecker: { level: "L1", explain: "Lean's own kernel replays the exported closure in a fresh environment." },
  "leanchecker-paranoid": { level: "L2", explain: "Lean's kernel with extra checks." },
  lean4lean: { level: "L2", explain: "Typechecker written in Lean." },
  nanoda: { level: "L2", explain: "Independent typechecker written in Rust." },
  "con-leche": { level: "L2", explain: "Independent checker. Declines on non-standard axioms." },
  "con-ron": { level: "L2", explain: "Port of con-leche. Declines on non-standard axioms." },
};

export const LEVEL_INFO = {
  L0: "Trust profile from graph.json: which axioms, sorry, native_decide and unsafe code this rests on. Always shown.",
  L1: "Kernel replay: the node and its whole closure re-typecheck from scratch with Lean's kernel. Catches environment tampering. Shares the kernel with Lean.",
  L2: "Independent kernels check the same export. Agreement is strong evidence. Disagreement is a finding.",
  none: "No level proves that the statement means what you intend, that a custom axiom is consistent, or anything about unsafe, partial, extern or implemented_by bodies.",
} as const;
