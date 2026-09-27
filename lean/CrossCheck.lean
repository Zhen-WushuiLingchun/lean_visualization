import Lean

/-!
# Cross-check of `graph.json` axioms (`proofflow-crosscheck`)

Test tool, not used by the server. Compares the `axioms` field of every node in a `graph.json`
with `Lean.collectAxioms` (the function behind `#print axioms`) in two modes:

* `fresh`: environment imported without extensions. `collectAxioms` then walks every body itself.
* `#print axioms`: environment imported with extensions, as in an ordinary Lean file. On Lean
  ≥ 4.35 `collectAxioms` then reads, for imported declarations, a per-module axiom table computed
  when the `.olean` was written, which under-reports some inductive types (lean4#15226).

When a mode disagrees with the graph, the axioms are recomputed with a naive breadth-first search
that follows exactly the edges `collectAxioms` follows (constants of the type, of the value with
`allowOpaque := true`, and the constructors of an inductive type), without any cache, and the
tool reports which side that reference agrees with.

    lake env lean --run <path>/CrossCheck.lean -- <graph.json> <RootModule> [<RootModule>...]

Exit code 0 when, for every node, the graph agrees with `collectAxioms` or with the reference.
Exit code 1 when the graph disagrees with the reference, or when a node is not found. The project
is imported twice, so memory use is about twice that of the extractor.
-/

open Lean

namespace ProofFlow.CrossCheck

/-- Axioms reachable from `src`, by plain breadth-first search. Slow; used only to adjudicate. -/
def referenceAxioms (env : Environment) (src : Name) : Array String := Id.run do
  let mut seen : Std.HashSet Name := ({} : Std.HashSet Name).insert src
  let mut queue : Array Name := #[src]
  let mut head := 0
  let mut axs : Array String := #[]
  while head < queue.size do
    let n := queue[head]!
    head := head + 1
    let some ci := env.find? n | continue
    if ci matches .axiomInfo _ then axs := axs.push (toString n)
    let mut cs := ci.type.getUsedConstants
    if let some v := ci.value? (allowOpaque := true) then cs := cs ++ v.getUsedConstants
    if let .inductInfo v := ci then cs := cs ++ v.ctors.toArray
    for c in cs do
      if !seen.contains c then
        seen := seen.insert c
        queue := queue.push c
  return axs.qsort (· < ·)

/-- Compare every node with `collectAxioms` in `env`; returns `true` when no node contradicts
the reference. -/
def checkMode (label : String) (env : Environment) (want : Std.HashMap String (Array String)) :
    IO Bool := do
  let ctx : Core.Context := { fileName := "<proofflow-crosscheck>", fileMap := default }
  let mut seen := 0
  let mut agree := 0
  let mut other : Array String := #[]
  let mut wrong : Array String := #[]
  -- Node ids are `Name.toString` (escaped); private names cannot be parsed back reliably, so walk
  -- the environment and match by string.
  for (n, _) in env.constants.map₁.toList do
    let id := toString n
    let some expected := want[id]? | continue
    seen := seen + 1
    let (got, _) ← (collectAxioms n : CoreM (Array Name)).toIO ctx { env }
    let got := (got.map toString).qsort (· < ·)
    if got == expected then
      agree := agree + 1
    else
      let ref := referenceAxioms env n
      if ref == expected then
        other := other.push s!"{id}: graph {expected}, collectAxioms {got}"
      else
        wrong := wrong.push s!"{id}: graph {expected}, collectAxioms {got}, reference {ref}"
  IO.println s!"[{label}] {seen}/{want.size} nodes found; {agree} agree with collectAxioms"
  unless other.isEmpty do
    IO.println s!"[{label}] {other.size} nodes where collectAxioms differs and the reference agrees with graph.json (lean4#15226):"
    for l in other do IO.println s!"  {l}"
  unless wrong.isEmpty do
    IO.println s!"[{label}] {wrong.size} nodes where graph.json disagrees with the reference:"
    for l in wrong do IO.println s!"  {l}"
  return wrong.isEmpty && seen == want.size

def run (path : String) (roots : Array Name) : IO UInt32 := do
  let json ← IO.ofExcept (Json.parse (← IO.FS.readFile path))
  let nodes ← IO.ofExcept (json.getObjValAs? (Array Json) "nodes")
  let mut want : Std.HashMap String (Array String) := {}
  for n in nodes do
    let id ← IO.ofExcept (n.getObjValAs? String "id")
    let axs ← IO.ofExcept (n.getObjValAs? (Array String) "axioms")
    want := want.insert id (axs.qsort (· < ·))
  initSearchPath (← findSysroot)
  let imports := roots.map fun r => { module := r }
  let fresh ← importModules imports {} (trustLevel := 1024)
  let ok1 ← checkMode "fresh" fresh want
  unsafe enableInitializersExecution
  let printEnv ← importModules imports {} (trustLevel := 1024) (loadExts := true)
  let ok2 ← checkMode "#print axioms" printEnv want
  return if ok1 && ok2 then 0 else 1

end ProofFlow.CrossCheck

def main (args : List String) : IO UInt32 := do
  match args.filter (· != "--") with
  | path :: roots@(_ :: _) =>
    try
      ProofFlow.CrossCheck.run path (roots.toArray.map String.toName)
    catch e =>
      IO.eprintln s!"proofflow-crosscheck: error: {e}"
      return (1 : UInt32)
  | _ =>
    IO.eprintln "usage: lake env lean --run CrossCheck.lean -- <graph.json> <RootModule> [<RootModule>...]"
    return (2 : UInt32)
