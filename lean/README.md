# `lean/`: the ProofFlow extractor

`Extract.lean` reads a built Lean 4 project and writes `graph.json`, the only interface between
Lean and the TypeScript side. The file shape is defined in `packages/schema/src/graph.ts`
(`GraphFileSchema`). `CrossCheck.lean` is a test tool that checks the `axioms` of every node in a
`graph.json` against Lean's own `collectAxioms`.

Both are single files with no Lake dependency (`import Lean` only). They never import the audited
project statically: they load it at run time with `importModules`, so the same file works for any
project.

## Running

From the audited project's root, after `lake build`:

```
lake env lean --run <repo>/lean/Extract.lean -- \
  --out .proofflow/graph.json --project-dir <abs path of project> --project-name <name> \
  --root <Module> [--root <Module> ...] [--local-prefix <Name> ...] \
  [--expand-external] [--statement-max-chars <N>] [--no-statements] [--core-flag-taints]
```

`lake env` is required. It sets `LEAN_PATH` (to find the `.olean` files) and `LEAN_SRC_PATH` (to
find source files for `src`). The leading `--` is passed through to `main` and ignored.

| Option | Default | Meaning |
|---|---|---|
| `--out <path>` | required | Output file. Parent directories are created. The file is written to `<path>.tmp` and then renamed over `<path>`, so a reader never sees a half-written file. |
| `--project-dir <path>` | required | Project root. Stored in `meta.project.dir` (resolved, forward slashes) and used to make local `src.file` paths relative. |
| `--project-name <name>` | required | Stored in `meta.project.name`. |
| `--root <Module>` | required, repeatable | Modules to import. Everything they import transitively is loaded. |
| `--local-prefix <Name>` | the roots, repeatable | A module is local when one of these is a component-wise prefix of its name (`Toy` matches `Toy` and `Toy.Defs`, not `ToyBox`). |
| `--expand-external` | off | Emit the whole dependency closure of the local nodes and of their axioms, with `depsComplete: true` everywhere. |
| `--statement-max-chars <N>` | 2000 | Truncate `statement` to `N` Unicode code points and set `statementTruncated`. |
| `--no-statements` | off | Write `""` for every `statement` (skips the pretty printer, the slowest per-node step). |
| `--core-flag-taints` | off | Let `unsafe`/`partial`/`extern`/`implemented_by` declarations of the toolchain packages start flag taints too. See "Flag taints". |
| `--help` | | Print usage to stderr and exit 0. |

Exit codes: `0` success, `1` runtime error (for example an unknown root module, or no imported
module matching the local prefixes), `2` usage error. Errors go to stderr as
`proofflow-extract: error: ...`. Progress goes to stderr, four lines per run:

```
proofflow-extract: imported 658 modules in 513 ms
proofflow-extract: 128 local constants, 2028 reachable constants in 71 ms
proofflow-extract: trust profiles over 19967 kernel edges, 2 implementation edges, 1889 components, 13 distinct axiom sets in 57 ms
proofflow-extract: wrote 290 nodes (128 local, 162 external), 1374 edges to expected/graph.json in 148 ms (total 789 ms)
```

Nothing is written to stdout.

`meta.generatedAt` is `SOURCE_DATE_EPOCH` (seconds since the epoch) when that variable is set.
Otherwise it is the modification time of the output file this run has just created. Core Lean
has no portable wall-clock API that `import Lean` provides on every supported toolchain.

### Cross-check

```
lake env lean --run <repo>/lean/CrossCheck.lean -- <graph.json> <RootModule> [<RootModule> ...]
```

This compares every node's `axioms` with `Lean.collectAxioms` in two modes. In "fresh" mode the
project is imported without extensions, so `collectAxioms` walks every body itself. In
"#print axioms" mode it is imported with extensions, exactly as an ordinary Lean file sees it.
Any disagreement is settled by a naive, cache-free breadth-first search over the same edges.
Exit code 0 means the graph agrees with `collectAxioms` or, where they differ, with the reference.

## Output

Which nodes are emitted:

- Default mode: every local constant, every external constant that a local one uses directly
  (boundary nodes), and every axiom reachable from a local node (`stats.axiomNodes`), even when it
  is reached only through external declarations. The graph is therefore self-contained: every
  axiom a local node rests on is a node. External axioms are emitted as pure sources (below).
- `--expand-external`: the whole `deps` closure of the local nodes and of those axioms.

Format:

- One JSON value per line: the `meta` line, the `stats` line, then one node per line inside
  `"nodes":[...]`. Keys inside objects are in alphabetical order, because `Lean.Json` stores
  objects sorted.
- Nodes are sorted by `id` (string order). `deps.stmt`, `deps.proof`, `axioms`, `localSinks` and
  `axiomNodes` are sorted by string. `taints` are in `TAINT_SEVERITY` order.
- The output is deterministic and machine-independent: no absolute paths anywhere except
  `meta.project.dir`. Two runs on different machines differ only in `meta.generatedAt` and
  `meta.project.dir`.

## Field semantics

| Field | How it is computed |
|---|---|
| `id` | `Name.toString` (with `«»` escaping). Private names keep their mangled form, e.g. `_private.Toy.Defs.0.Toy.double`. |
| `shortName` | Last component of the name with the private prefix removed (`double`). |
| `kind` | The `ConstantInfo` constructor. |
| `subKind` | First match of: `class` (`isClass`), `structure` (`isStructure`), `instance` (instance extension), `abbrev` (`ReducibilityHints.abbrev`, structure projections excluded because Lean gives every projection those hints), else `none`. |
| `module` | `env.getModuleIdxFor?`. A realised constant such as an equation lemma `f.eq_1` belongs to the module that first realised it, which can differ from the module of `f`. |
| `package` | First component of `module` (`Init`, `Mathlib`, `Toy`). |
| `isLocal` | `module` has a `--local-prefix` as a component-wise prefix. |
| `isAux` | Name heuristics, see below. |
| `src` | `findDeclarationRanges?` gives `range` (the whole declaration, including its doc comment and modifiers). `line`/`endLine` are 1-based and `col`/`endCol` are 0-based Unicode code-point columns, as in Lean's `Position`. The file is the module's `.lean` source, found through `LEAN_SRC_PATH` plus the toolchain's own `src/lean`. It is never absolute, and always uses forward slashes. For local modules it is relative to `--project-dir` (`Toy/Defs.lean`). For external modules it is relative to the source search path entry that contains the module, which is the module name as a path (`Init/Prelude.lean`, `Mathlib/Data/Nat/Basic.lean`). A local module outside the project directory also gets that form. `null` when Lean has no range (most generated declarations) or the source file does not exist. |
| `doc` | `findDocString?`. For notation declarations this includes the text Lean appends about recommended spellings. |
| `statement` | `Meta.ppExpr` of the type at width 100 with `pp.proofs false` and `pp.deepTerms false`, under a fresh heartbeat budget per node. If the delaborator fails or runs out of heartbeats, the raw `Expr` is printed instead. |
| `levelParams` | `ci.levelParams`. |
| `deps.stmt` | Constants used by the type. Empty for an external axiom in default mode (below). |
| `deps.proof` | Constants used by the value (`value? (allowOpaque := true)`), so theorem proofs and `opaque` bodies count. For a recursor: constants of its rules' right-hand sides. Empty for axioms, inductives, constructors and `quot`. |
| `depsComplete` | `true` for local nodes, for every axiom, and for every node under `--expand-external`; `false` for the other boundary nodes. |
| `axioms` | Every axiom reachable through kernel edges (below). |
| `taints` | Derived from `axioms` with the schema's `classifyAxiom`, plus the transitive flag taints. |

`deps` never contains the node itself. Self references occur in recursors, in `unsafe` recursive
definitions and in `_unsafe_rec` companions; they carry no dependency information and would be
self-loops in the DAG. Otherwise `deps` are the used constants of the type and the value, deduplicated.

**External axioms in default mode are pure sources.** Their `deps` are empty and `depsComplete` is
`true`, so they have no incoming edges and sit in the first column of the workflow. This applies
whether they were reached directly (`sorryAx`) or only transitively (`propext`). Their `module`,
`package`, `src`, `doc`, `statement`, `axioms` and `taints` are real. Local axioms (`Toy.oracle`)
and all axioms under `--expand-external` keep the constants of their type as `deps.stmt`. The
direct flags `directSorry`/`directNativeDecide` always look at the constants really used, not at
the emitted `deps`.

### Direct flags

| Flag | Definition |
|---|---|
| `unsafe` | `ci.isUnsafe` |
| `partial` | A definition with `DefinitionSafety.partial`, or an `opaque` whose `_unsafe_rec` companion is one. A `partial def f` is elaborated as `opaque f` (what the kernel sees) plus `f._unsafe_rec` (what the compiler runs); both are flagged. Structural and well-founded recursion also create a `partial`-safety `f._unsafe_rec` copy of a safe definition `f`; such copies are not flagged, because the kernel checked the real `f`. |
| `noncomputable` | `isNoncomputable` |
| `extern` | `isExtern` |
| `implementedBy` | `Compiler.implementedByAttr.getParam?` is set |
| `private` | `isPrivateName` |
| `protected` | `isProtected` |
| `instance` | `Meta.isInstanceCore` |
| `directSorry` | `sorryAx` is in `deps.stmt ∪ deps.proof` |
| `directNativeDecide` | A native-decide axiom (schema classifier) is in `deps.stmt ∪ deps.proof`. On Lean ≤ 4.34 `native_decide` puts `Lean.ofReduceBool` into an auxiliary `_proof_<n>` theorem, so the flag is set on that aux node and not on the user's theorem. The transitive `nativeDecide` taint is set on both. |

### Kernel edges and `axioms`

The trust traversal follows the constants of the type and of the value (`allowOpaque := true`,
recursor rules included), plus the constructors of an inductive type. These are exactly the
edges `Lean.collectAxioms` follows, so `axioms` is what `#print axioms` should print.

The constructor edges are not part of `deps`. An inductive type's `axioms` can therefore include
axioms reached only through its constructors, with no path to them in the emitted edges.
`Toy.Certified` is an example: its constructor mentions `Toy.oracle`. Adding the constructors to
`deps` would create a cycle between every inductive type and its constructors.

**`#print axioms` can under-report; the extractor does not.** On v4.35.0-rc3 (not on
v4.23.0-rc2), `collectAxioms` looks up imported declarations in a per-module table written into
the `.olean`. That table is
filled with a shared cache that marks a declaration as "in progress" with an empty entry. When a
module's export visits a constructor before its inductive type, the inductive is cached while
still in progress, and the entry misses the axioms of its constructors. Everything that reaches
those axioms only through that inductive inherits the gap (lean4#15226). The toy project
reproduces it: `#print axioms Toy.Signed` says "does not depend on any axioms", while
`#print axioms Toy.Signed.mk` prints `[Toy.oracle]`. On the whole `Lean` package, 618 of 94 954
nodes differ from `#print axioms`. In every case the graph is a strict superset, and a cache-free
breadth-first search agrees with the graph. On the `Lean.Elab.Tactic` slice (9 963 nodes),
`collectAxioms` in fresh mode (without the table) agrees with the graph on every node. The
extractor never reads that table.

### Taints

`sorry`, `nativeDecide` and `customAxiom` come from `axioms`, classified exactly as `classifyAxiom`
in `packages/schema/src/graph.ts` does:

- standard: `propext`, `Classical.choice`, `Quot.sound`;
- `sorryAx`;
- native decide: exactly `Lean.ofReduceBool`, `Lean.ofReduceNat`, `Lean.trustCompiler` (the
  axiom those two rest on in Lean ≤ 4.34), or the axiom Lean 4.35 mints per `native_decide` use,
  `<decl>._native.native_decide.ax_<i>_<j>`. The minted form must match exactly: a non-empty
  `<decl>`, then the components `_native`, `native_decide` and `ax_<digits>_<digits>`, in that order
  and at the end of the name. This is the schema's regex `\._native\.native_decide\.ax_\d+_\d+$`,
  checked on name components. `Foo._native.bar` or `Foo._native.native_decide.ax_1` is custom;
- everything else is custom.

The flag taints `implementedBy`, `extern`, `partial` and `unsafe` start at declarations whose
direct flag is set. They propagate along kernel edges and along implementation edges:
`@[implemented_by g] def f` has an edge `f → g`, and a `partial def f` has an edge
`f → f._unsafe_rec`. Implementation edges carry flag taints only, never axioms, so `axioms`
still agrees with `collectAxioms`. They are what make the runtime implementation of a safe
reference definition visible. For example, `Toy.fastEq` is `@[implemented_by Toy.fastEqImpl]`
and `fastEqImpl` is `unsafe`, so `fastEq` and everything that uses it carry `unsafe`. Without
these edges, a safe declaration could never carry `unsafe`, because the kernel rejects safe
references to unsafe constants.

**Core exemption (default).** Declarations from the toolchain packages (`Init`, `Std`, `Lean`,
`Lake`, unless they are local) keep their direct `flags`, but they do not start flag taints and
their implementation edges are not followed. Without this, `extern` would be on almost every
theorem about numbers (`Nat.add` is `@[extern "lean_nat_add"]`), and `implementedBy`/`unsafe` on
almost every proof that touches `Array`. In the toy project, `--core-flag-taints` (literal
propagation) puts `extern` on `Toy.lemma1 : n + 0 = n`, and `implementedBy, extern, unsafe` on
an `omega` proof. It also reduces the local, non-aux nodes with no taint at all from 27 of 50 to
17. The toolchain is trusted anyway by anyone who trusts `native_decide` or compiled code. Third-party
packages such as Mathlib and Batteries are not exempt.

### `isAux`

An axiom is aux only when it is the minted `native_decide` axiom above. Every other axiom is
never aux, whatever its name. A custom axiom called `Foo._native.bar` or `_oracle` is therefore
never hidden by the viewer's "hide aux" default. The rules below apply to all other declarations.

A name is aux when its user name (private prefix removed) has a component starting with `_`
(`_unsafe_rec`, `_private`, `_hyg`, `_native`, `_sizeOf_<n>`, `_proof_<n>`, `_flat_ctor`,
`_sunfold`, `_cstage<n>`, ...). It is also aux when it, or any of its prefixes, is a generated
companion of an existing declaration:

- of an inductive type or constructor: `rec`, `recOn`, `casesOn`, `brecOn`, `binductionOn`,
  `below`, `ibelow`, `noConfusion`, `noConfusionType`, `ctorIdx`, `toCtorIdx`, `ctorElim`,
  `ctorElimType`, `elim`, `inj`, `injEq`, `sizeOf_spec`;
- of any declaration: `eq_<n>`, `eq_def`, `eq_unfold`, `match_<n>`, `proof_<n>`, `induct`,
  `mutual_induct`, `fun_cases`, `congr_simp`, `splitter`;
- a last component starting with `instSizeOf`.

The parent check prevents false positives such as a user theorem `Foo.inj` in a namespace that
is not a constructor. The prefix rule catches companions of companions, for example
`Toy.Color.next.match_1.splitter`. A hand-written `private def` is not aux. Deviation from
`docs/ARCHITECTURE.md` §2 item 7, which lists `_private` as aux: that rule would hide every
private lemma a user wrote. The `flags.private` flag remains available for filtering.

### Stats

- `nodes`, `localNodes`, `externalNodes`: counts of emitted nodes.
- `edges`: distinct `(dependency, dependent)` pairs among emitted nodes, as `edgesOf` computes.
- `byKind`: all emitted nodes. All eight kinds are present, zeros included.
- `byTaint`: local nodes, aux included. All seven taints are present, zeros included.
- `localSinks`: local non-aux nodes that no other local node (aux included) has in its `deps`.
- `axiomNodes`: the union of the `axioms` of the local nodes. Every one of them is emitted as a
  node, in both modes.

## Design and performance

1. `importModules` with `loadExts := true`, after `enableInitializersExecution`. Extension state is
   needed for `isInstanceCore`, `isClass` and notation-aware `ppExpr`. `trustLevel := 1024` and
   `leakEnv := true`.
2. Seeds: the `constNames` of every local module, each attributed with `getModuleIdxFor?`.
3. Discovery: a depth-first walk with an explicit work list over the kernel edges (and
   implementation edges of non-core declarations). Constants get dense indices, and successor
   lists are `Array Nat`, with kernel successors deduplicated by a per-node mark.
4. One iterative Tarjan pass over the whole reachable graph. Each node carries an accumulator
   holding its own axiom and flags. An edge to a completed component folds in that component's
   profile. A DFS child that returns while still on the stack folds its accumulator into its
   parent's, so the component root ends up holding the union. Components complete in reverse
   topological order. Axiom sets are interned (id `0` is the empty set) and unions are memoised,
   so the common per-edge cost is one comparison of two ids. If an implementation edge closes a
   cycle, the axioms are recomputed with a kernel-only pass. There is no recursion anywhere, so
   chains of any depth are safe.
5. Emission sorts by id and streams node by node through one `MetaM` session. Only `meta` and
   `stats` are built as `Json` values in full.

`lean --run` interprets the script, so interpreter overhead dominates the graph phases. The code
threads one state structure through small functions rather than using many `let mut` variables,
because the interpreter rebuilds the tuple of all mutated variables on every loop iteration.
That change roughly halved discovery and cut the profile pass to about a third.

Measured on Windows 11 with v4.35.0-rc3 (24 logical CPUs; other builds were running, so timings
varied by up to about 40 % between identical runs). Wall time includes about 2.5 s for `lean` to
elaborate the script itself.

| Run | Local | Reachable | Kernel edges | Nodes written | Phases (import / discover / profiles / write) | Wall |
|---|---|---|---|---|---|---|
| `examples/toy` | 128 | 2 028 | 19 967 | 290 | 0.5 / 0.07 / 0.06 / 0.15 s | 3.3 s |
| `examples/toy --expand-external` | 128 | 2 028 | 19 967 | 2 023 | 0.6 / 0.09 / 0.07 / 1.0 s | 4.5 s |
| `examples/toy --no-statements` | 128 | 2 028 | 19 967 | 290 | 0.5 / 0.06 / 0.05 / 0.09 s | 3.3 s |
| `--root Lean --local-prefix Lean.Elab.Tactic` | 5 957 | 36 141 | 640 386 | 9 963 | 2.6–3.2 / 1.6–2.4 / 1.2–2.1 / 4.4–6.2 s | 13–16 s |
| same, `--no-statements` | 5 957 | 36 141 | 640 386 | 9 963 | 2.6–3.2 / 1.6–2.4 / 1.2–2.1 / 2.2 s | about 10 s |
| `--root Lean --local-prefix Lean --no-statements` | 90 955 | 111 386 | 1 806 610 | 94 954 | 2.6 / 6.4 / 11.1 / about 20 s | 43 s |

The two `Lean` rows were measured before external axioms were emitted as nodes, which adds at
most a handful of nodes. The last row is a stress test: the entire compiler is treated as local,
and the output is 110 MB.
Implementation edges close cycles there, so the profile phase includes the kernel-only rerun.
The pretty printer costs about 0.4 ms per node.

No Mathlib checkout was available, so the Mathlib target (5k local declarations in under 60 s)
is an extrapolation, not a measurement. Discovery plus profiles cost about 4.5–7 µs per kernel
edge. A closure of 200k constants and 4M edges would take 18–28 s, or up to about 1.6 times that
if an implementation edge closes a cycle and forces the rerun. Add the Mathlib import (not
measured here), about 0.5 ms per emitted node, and 2.5 s of script elaboration. The estimate is
30–45 s, with no margin to spare if the closure is larger.

## Known limitations

- `deps` can contain cycles, but only among `unsafe` or `_unsafe_rec` definitions that call each
  other (mutual unsafe recursion). Safe declarations cannot form cycles in `deps`.
- Axioms reached through an inductive's constructors have no visible path in `deps` (see
  "Kernel edges").
- `generatedAt` comes from the file system clock when `SOURCE_DATE_EPOCH` is not set.
- The server runs this file as is; there is no template or import splicing.

## Lean version floor

The script and `CrossCheck.lean` elaborate without errors or warnings on v4.22.0, v4.23.0-rc2 and
v4.35.0-rc3. Both have been run end to end on v4.23.0-rc2 and v4.35.0-rc3 against the toy
project. APIs used that are not ancient: `ConstantInfo.value? (allowOpaque := true)`,
`importModules (loadExts := ...)`, `getSrcSearchPath`, `ModuleIdx.toNat`, `Array.replicate`,
`tryCatchRuntimeEx`, `withCurrHeartbeats`. No API newer than v4.22 is required, so the floor of
v4.28 in `AGENTS.md` holds with margin.
