# Related work and the decision to build ProofFlow

Surveyed 2026-09-27. Star counts and dates are from the GitHub API on that day.

## Tools that overlap with the idea

| Tool | What it does | Extraction | Viewer | Per-node verification | Status |
|---|---|---|---|---|---|
| [Lean Atlas](https://github.com/NyxFoundation/lean-atlas) (NyxFoundation, MIT, 21 stars, last push 2026-05) | Dependency graph viewer for a project; edges classified type-vs-value; "Lean Compass" prunes to the nodes whose *meaning* affects a target theorem; confidence/progress attributes for semantic review. Paper: arXiv 2604.16347. | Lake dependency (`lake exe atlas`), per-node BFS for axioms | Next.js + React Flow + Dagre, 12 filter axes | No kernel re-check. Shows sorry and axiom sets. | Research prototype, "not seeking contributions", pinned v4.28 |
| [LeanDepViz](https://github.com/cameronfreer/LeanDepViz) (MIT, 10 stars, last push 2026-01) | Dependency extraction + multi-checker verification (LeanParanoia policy, lean4checker, SafeVerify) with a unified per-declaration table | `lake exe depviz` (Lean), Python glue | Static Graphviz DOT/SVG + HTML table with zoom | Per-declaration *policy* status; kernel replay is whole-module; SafeVerify demo uses mock data | Closest in spirit; table-centric, graph is static |
| [lean-graph](https://github.com/patrik-cihal/lean-graph) (54 stars, last push 2026-02) | Interactive dependency graph of a chosen constant | copy a `DependencyExtractor.lean` into the project, `#eval` | Rust/egui native + web build | None | Visualization only |
| [keithadler/leanviz](https://github.com/keithadler/leanviz) (MIT, 4 stars, created 2026-09) | Static per-declaration navigator for Mathlib: statement, doc, uses/used-by, axioms, neighborhood picture, axiom/holes/unused pages | .NET reader (Tenet) over `.olean`, no Lean toolchain | Static HTML/JS bundle (82 MB for Mathlib) | Bundle-level Tenet verdict, not per node in the UI | Browsing, not auditing a workflow |
| [axiom-audit](https://github.com/leanprover-community/axiom-audit) (Apache-2.0) | CI fail on sorry / native_decide / non-allowlisted axioms; shared-cache axiom traversal | `lake exe axiom-audit` | none (JSON) | project-level | The right algorithm for transitive axioms; no UI |
| [gonzalgo](https://github.com/vince-gonzalez/gonzalgo) (Apache-2.0, PyPI) | Axiom provenance: which step *spends* an axiom, shortest path decl→axiom, impact analysis, MCP server; also Metamath | Lean script dump (TSV), Python analysis | none (CLI, website tables) | none | Analysis, not visualization |
| [lean4-lens](https://github.com/holgerdell/lean4-lens) (MIT, 0 stars) | "Review cone" HTML report with verified/tainted/sorry badges | Lean elaborator script | static HTML | none | Report generator |
| [leanblueprint](https://github.com/PatrickMassot/leanblueprint) | LaTeX-authored blueprint with a dependency graph from manual `\uses` | manual | Graphviz in HTML | none (only "Lean-ok" ticks) | Different input: prose, not the kernel |
| [Paperproof](https://github.com/Paper-Proof/paperproof) | Tactic-level proof tree inside one proof | Lean infoview widget | VS Code | n/a | Different granularity |
| [importGraph](https://reservoir.lean-lang.org/@leanprover-community/importGraph) | Module import graph | `lake exe graph` | Graphviz | n/a | Module level |
| `lake check --paranoid` (Lean ≥ 4.35) | Build, export, replay through the kernel and every bundled external checker; fail on non-standard axioms | toolchain | none | whole project pass/fail | The verification primitive we build on |

## What nobody does

1. **Axiom-first workflow layout with per-node trust colouring.** Every existing viewer draws a
   dependency graph; none lays it out as a workflow whose layer 0 is the axiom set (standard, `sorryAx`,
   `ofReduceBool`, custom) and whose last layer is the project's final theorems, with the transitive trust
   profile driving node colour.
2. **Click-to-verify a node with independent kernels.** LeanDepViz runs checkers over whole modules and
   reports in a table; Lean Atlas does not run checkers. Since v4.35 the toolchain itself bundles
   `leanexport`, `leanchecker --from-export`, `lean4lean`, `nanoda`, `con-leche`, `con-ron`, so a
   per-declaration export + multi-kernel replay needs no extra install. No tool exposes this per node in a UI.
3. **Statement-vs-proof edges *and* verification in one view.** Lean Atlas has the edge classification
   (useful for "what affects the meaning"); LeanDepViz has the checkers; nobody has both.

## Decision

Build ProofFlow as a small, opinionated tool with exactly those three differentiators, and reuse ideas
rather than code: the shared-cache axiom traversal from axiom-audit, the type/value edge split from
Lean Atlas and gonzalgo, and the multi-checker table idea from LeanDepViz. Extraction is a single Lean
script (no Lake dependency for users, like gonzalgo and lean-graph), because Lake-dependency tools break
whenever the user's toolchain and the tool's pin diverge.

If Lean Atlas opened to contributions, the verification layer could be contributed there instead; it is
not, and its focus (semantic review attributes) is orthogonal.
