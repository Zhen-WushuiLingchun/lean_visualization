# Golden output for `examples/toy`

`graph.json` is the extractor's output on the toy project. Regenerate it from `examples/toy`
after `lake build`:

```
lake env lean --run ../../lean/Extract.lean -- --out expected/graph.json \
  --project-dir <absolute path of examples/toy> --project-name toy --root Toy
```

Toolchain: `leanprover/lean4:v4.35.0-rc3`. The file has one JSON value per line (`meta`, `stats`,
then one node per line). Nodes are sorted by `id`. Two runs, on any machine, differ only in the
volatile fields below.

## Volatile fields: normalise before comparing

| Field | Why it varies | Suggested normalisation |
|---|---|---|
| `meta.generatedAt` | Time of the run (or `SOURCE_DATE_EPOCH` when set). | Replace with a constant. |
| `meta.project.dir` | Absolute path of the checkout. | Replace with a constant. |

There are no other absolute paths. `src.file` is relative to the project for local nodes
(`Toy/Defs.lean`) and relative to the source search path root for external nodes
(`Init/Prelude.lean`). Everything else, including `doc` and `statement` of external nodes, is
fixed by the pinned toolchain.

## Summary

290 nodes: 128 local (78 of them aux) and 162 external, 1374 edges. The external nodes are the
boundary nodes that local declarations use directly, plus `propext` and `Quot.sound`, which no
local declaration uses directly but which are reachable from local nodes; every axiom is a node.
`stats.axiomNodes` = `Classical.choice`, `Quot.sound`,
`Toy.bigPower._native.native_decide.ax_1_1`, `Toy.oracle`, `propext`, `sorryAx`. The four
external ones (`Classical.choice`, `Quot.sound`, `propext`, `sorryAx`) are pure sources: empty
`deps`, `depsComplete: true`.

Every trust case in the brief, and where it lives:

| Case | Declarations |
|---|---|
| Custom axiom and a theorem using it | `Toy.oracle`, `Toy.usesOracle` |
| `sorry` and a lemma depending on it | `Toy.unfinished`, `Toy.usesUnfinished` |
| `native_decide` | `Toy.bigPower` (Lean 4.35 mints the axiom `Toy.bigPower._native.native_decide.ax_1_1`) |
| Clean chain | `Toy.lemma1` → `Toy.lemma2` → `Toy.cleanMain` (no axioms at all) |
| `noncomputable` + `Classical.choice` | `Toy.pick`, `Toy.pick_self` (standard axiom only, no taint) |
| `unsafe` + `@[implemented_by]` | `Toy.fastEqImpl`, `Toy.fastEq` |
| `partial def` | `Toy.collatz` (kernel: `opaque`; compiler: `Toy.collatz._unsafe_rec`) |
| `@[extern]` | `Toy.cMix` |
| `opaque` with a value | `Toy.secret` |
| `inductive`, `structure`, `class` + `instance`, `abbrev` | `Toy.Color`, `Toy.Point`, `Toy.HasSize` + `Toy.instHasSizePoint`, `Toy.Grid` |
| `private`, `protected` | `_private.Toy.Defs.0.Toy.double`, `Toy.Color.red_ne_green` |
| `match` (aux `match_1`, `eq_n`) | `Toy.Color.next` (+ `Toy.next_red`, which realises `Toy.Color.next.eq_1..3`) |
| Recursive definition (aux `_unsafe_rec`, equation lemmas) | `Toy.sumTo` (+ `Toy.sumTo_succ`) |
| Inductive whose constructor type mentions the custom axiom | `Toy.Certified`, `Toy.Signed` (direct mention), `Toy.Bounded` (through `Toy.squareBound`) |
| lean4#15226 regression that actually triggers | `Toy.Signed`, `Toy.signed_trivial` |
| Everything at once | `Toy.everything`: all seven taints |

## Comparison with `#print axioms`

"`#print axioms`" is the output of `lake env lean Check.lean` (in `examples/toy`), which prints
the axioms of every declaration named there. "Agree" compares it with `axioms` in `graph.json`.
The table lists every local node that is not aux. `_private.Toy.Defs.0.Toy.double` cannot be
named from another file. "Flags" lists the direct flags that are set. "Sink" marks
`stats.localSinks`.

| Declaration | Kind | Axioms (graph.json) | `#print axioms` | Agree | Taints | Flags | Sink |
|---|---|---|---|---|---|---|---|
| `Toy.Bounded` | inductive (structure) | `Toy.oracle` | `Toy.oracle` | yes | customAxiom |  |  |
| `Toy.Bounded.bound` | theorem | `Toy.oracle` | `Toy.oracle` | yes | customAxiom |  | yes |
| `Toy.Bounded.mk` | constructor | `Toy.oracle` | `Toy.oracle` | yes | customAxiom |  |  |
| `Toy.Bounded.n` | definition | `Toy.oracle` | `Toy.oracle` | yes | customAxiom |  |  |
| `Toy.Certified` | inductive | `Toy.oracle` | `Toy.oracle` | yes | customAxiom |  |  |
| `Toy.Certified.mk` | constructor | `Toy.oracle` | `Toy.oracle` | yes | customAxiom |  |  |
| `Toy.Color` | inductive | none | none | yes | none |  |  |
| `Toy.Color.blue` | constructor | none | none | yes | none |  |  |
| `Toy.Color.green` | constructor | none | none | yes | none |  |  |
| `Toy.Color.next` | definition | none | none | yes | none |  |  |
| `Toy.Color.red` | constructor | none | none | yes | none |  |  |
| `Toy.Color.red_ne_green` | theorem | none | none | yes | none | protected | yes |
| `Toy.Grid` | definition (abbrev) | none | none | yes | none |  | yes |
| `Toy.HasSize` | inductive (class) | none | none | yes | none |  |  |
| `Toy.HasSize.mk` | constructor | none | none | yes | none |  |  |
| `Toy.HasSize.size` | definition | none | none | yes | none |  | yes |
| `Toy.Point` | inductive (structure) | none | none | yes | none |  |  |
| `Toy.Point.mk` | constructor | none | none | yes | none |  |  |
| `Toy.Point.x` | definition | none | none | yes | none |  |  |
| `Toy.Point.y` | definition | none | none | yes | none |  |  |
| `Toy.Signed` | inductive | `Toy.oracle` | none | **no** (lean4#15226) | customAxiom |  |  |
| `Toy.Signed.mk` | constructor | `Toy.oracle` | `Toy.oracle` | yes | customAxiom |  |  |
| `Toy.bigPower` | theorem | `Toy.bigPower._native.native_decide.ax_1_1` | `Toy.bigPower._native.native_decide.ax_1_1` | yes | nativeDecide | directNativeDecide |  |
| `Toy.boundedFive` | definition | `Toy.oracle` | `Toy.oracle` | yes | customAxiom |  | yes |
| `Toy.cMix` | opaque | none | none | yes | extern | extern |  |
| `Toy.certified_five` | theorem | `Toy.oracle` | `Toy.oracle` | yes | customAxiom |  | yes |
| `Toy.certified_trivial` | theorem | `Toy.oracle` | `Toy.oracle` | yes | customAxiom |  | yes |
| `Toy.cleanMain` | theorem | none | none | yes | none |  | yes |
| `Toy.collatz` | opaque | none | none | yes | partial | partial |  |
| `Toy.everything` | theorem | `Toy.bigPower._native.native_decide.ax_1_1`, `Toy.oracle`, `sorryAx` | `Toy.bigPower._native.native_decide.ax_1_1`, `Toy.oracle`, `sorryAx` | yes | implementedBy, extern, partial, unsafe, nativeDecide, customAxiom, sorry |  | yes |
| `Toy.fastEq` | definition | none | none | yes | implementedBy, unsafe | implementedBy |  |
| `Toy.fastEqImpl` | definition | `Classical.choice`, `Quot.sound`, `propext` | `Classical.choice`, `Quot.sound`, `propext` | yes | unsafe | unsafe | yes |
| `Toy.instHasSizePoint` | definition (instance) | none | none | yes | none | instance | yes |
| `Toy.lemma1` | theorem | none | none | yes | none |  |  |
| `Toy.lemma2` | theorem | none | none | yes | none |  |  |
| `Toy.next_red` | theorem | `propext` | `propext` | yes | none |  | yes |
| `Toy.oracle` | axiom | `Toy.oracle` | `Toy.oracle` | yes | customAxiom |  |  |
| `Toy.pick` | definition | `Classical.choice` | `Classical.choice` | yes | none | noncomputable |  |
| `Toy.pick_self` | theorem | `Classical.choice` | `Classical.choice` | yes | none |  | yes |
| `Toy.quadruple` | definition | none | none | yes | none |  |  |
| `Toy.quadruple_eq` | theorem | `Quot.sound`, `propext` | `Quot.sound`, `propext` | yes | none |  | yes |
| `Toy.secret` | opaque | none | none | yes | none |  | yes |
| `Toy.signed_trivial` | theorem | `Toy.oracle` | none | **no** (lean4#15226) | customAxiom |  | yes |
| `Toy.squareBound` | definition | `Toy.oracle` | `Toy.oracle` | yes | customAxiom |  |  |
| `Toy.sumTo` | definition | none | none | yes | none |  |  |
| `Toy.sumTo_succ` | theorem | `propext` | `propext` | yes | none |  | yes |
| `Toy.unfinished` | theorem | `sorryAx` | `sorryAx` | yes | sorry | directSorry |  |
| `Toy.usesOracle` | theorem | `Toy.oracle` | `Toy.oracle` | yes | customAxiom |  |  |
| `Toy.usesUnfinished` | theorem | `sorryAx` | `sorryAx` | yes | sorry |  |  |
| `_private.Toy.Defs.0.Toy.double` | definition | none | n/a | not named | none | private |  |

The two disagreements are the lean4#15226 regression and are expected. On v4.35.0-rc3,
`#print axioms` reads imported declarations from a per-module table written into the `.olean`.
That table is filled with a shared cache that visited `Toy.Signed.mk` before `Toy.Signed`, so the
entry for `Toy.Signed` lacks its constructor's axioms. `#print axioms Toy.Signed.mk` in the same
run prints `[Toy.oracle]`, and `collectAxioms` walks an inductive's constructors by definition, so
`Toy.Signed` depends on `Toy.oracle`. `Toy.signed_trivial` inherits the gap. The extractor
computes its own closure and reports `Toy.oracle` for both. `Toy.Certified` has exactly the same
shape but is not affected, because its name hashes to a different visiting order.

Automated version, covering all 290 nodes (aux, private and external included):

```
$ lake env lean --run ../../lean/CrossCheck.lean -- expected/graph.json Toy
[fresh] 290/290 nodes found; 290 agree with collectAxioms
[#print axioms] 290/290 nodes found; 288 agree with collectAxioms
[#print axioms] 2 nodes where collectAxioms differs and the reference agrees with graph.json (lean4#15226):
  Toy.Signed: graph #[Toy.oracle], collectAxioms #[]
  Toy.signed_trivial: graph #[Toy.oracle], collectAxioms #[]
```

"fresh" imports without environment extensions, so `collectAxioms` walks every body instead of
reading the table. It agrees with the graph everywhere.

## Notes on specific nodes

- `Toy.fastEq` carries `unsafe` although it is a safe definition. Its runtime implementation
  `Toy.fastEqImpl` is `unsafe`, and the extractor follows `@[implemented_by]` edges for flag
  taints. `Toy.everything` gets `unsafe` the same way.
- `Toy.collatz` (`partial`) and `Toy.collatz._unsafe_rec` both have the `partial` flag.
  `Toy.sumTo._unsafe_rec` (structural recursion) is not flagged.
- `Toy.lemma1`, `Toy.cleanMain` and `Toy.sumTo` have no taint. `Nat.add` is `@[extern]`, but
  toolchain declarations do not start flag taints by default. Pass `--core-flag-taints` to
  change that; they then get `extern`.
- `Toy.fastEqImpl` is a local sink: only `@[implemented_by]` refers to it, and that is not a
  kernel dependency.
- `Toy.Color.next.eq_1..3` and `Toy.sumTo.eq_1/eq_2/eq_def` are realised on demand by `simp` in
  `Toy.Lemmas`, so their `module` is `Toy.Lemmas` and their `src` is `null`.
- Tainted aux nodes: the companions of `Toy.Bounded`, `Toy.Certified` and `Toy.Signed` carry
  `customAxiom`; `Toy.boundedFive._proof_1` (`customAxiom`),
  `Toy.bigPower._native.native_decide.ax_1_1` (`nativeDecide`, kind `axiom`) and
  `Toy.collatz._unsafe_rec` (`partial`).
