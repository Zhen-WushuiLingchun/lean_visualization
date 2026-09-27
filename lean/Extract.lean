import Lean

/-!
# ProofFlow extractor (`proofflow-extract`)

Reads a built Lean 4 project and writes `graph.json` (shape: `packages/schema/src/graph.ts`).
Run it from the audited project's root so that `lake env` sets `LEAN_PATH` and `LEAN_SRC_PATH`:

    lake env lean --run <path>/Extract.lean -- --out <path> --project-dir <abs path> \
      --project-name <name> --root <Module> [--root <Module>...] [--local-prefix <Name>...] \
      [--expand-external] [--statement-max-chars <N>] [--no-statements] [--core-flag-taints]

The script never imports the audited project statically. It loads the `--root` modules at run
time with `importModules`, so one copy of this file works for every project.

Pipeline:
1. Import the roots (with environment extensions loaded, so attributes and notations work).
2. Collect the local constants: every constant whose module has a `--local-prefix` as a
   component-wise prefix (the prefixes default to the roots).
3. Discover the reachable subgraph from the local constants. Kernel edges are the constants used
   by the type and the value (`allowOpaque := true`), plus the constructors of an inductive type
   (exactly the edges `Lean.collectAxioms` follows). Implementation edges (`@[implemented_by]`
   targets and the `_unsafe_rec` body of a `partial def`) are followed for flag taints only.
4. One iterative Tarjan SCC pass over the whole reachable graph computes, once per component,
   the union of the axioms (kernel edges) and of the flag taints (kernel + implementation edges).
5. Emit local nodes, boundary nodes and every axiom reachable from a local node (or the whole
   closure with `--expand-external`), streamed node by node, sorted by id.

See `lean/README.md` for the full CLI reference and the design notes.
-/

open Lean Meta

namespace ProofFlow

def extractorName : String := "proofflow-extract"
def extractorVersion : String := "0.1.0"
def schemaVersion : Nat := 1

/-- Toolchain packages. Their `unsafe`/`partial`/`extern`/`implemented_by` flags do not start a
flag taint unless `--core-flag-taints` is given (see README, "Flag taints"). -/
def corePackages : Array String := #["Init", "Std", "Lean", "Lake"]

/-! ## Command line -/

structure Config where
  out : String := ""
  projectDir : String := ""
  projectName : String := ""
  roots : Array Name := #[]
  localPrefixes : Array Name := #[]
  expandExternal : Bool := false
  statementMaxChars : Nat := 2000
  noStatements : Bool := false
  coreFlagTaints : Bool := false
  help : Bool := false
  deriving Inhabited

def usage : String :=
  "usage: lake env lean --run Extract.lean -- --out <path> --project-dir <abs path> " ++
  "--project-name <name> --root <Module> [--root <Module>...] [--local-prefix <Name>...] " ++
  "[--expand-external] [--statement-max-chars <N>] [--no-statements] [--core-flag-taints]"

partial def parseArgs : List String → Config → Except String Config
  | [], cfg => .ok cfg
  | "--" :: rest, cfg => parseArgs rest cfg
  | "--help" :: rest, cfg => parseArgs rest { cfg with help := true }
  | "-h" :: rest, cfg => parseArgs rest { cfg with help := true }
  | "--out" :: v :: rest, cfg => parseArgs rest { cfg with out := v }
  | "--project-dir" :: v :: rest, cfg => parseArgs rest { cfg with projectDir := v }
  | "--project-name" :: v :: rest, cfg => parseArgs rest { cfg with projectName := v }
  | "--root" :: v :: rest, cfg => parseArgs rest { cfg with roots := cfg.roots.push v.toName }
  | "--local-prefix" :: v :: rest, cfg =>
    parseArgs rest { cfg with localPrefixes := cfg.localPrefixes.push v.toName }
  | "--expand-external" :: rest, cfg => parseArgs rest { cfg with expandExternal := true }
  | "--no-statements" :: rest, cfg => parseArgs rest { cfg with noStatements := true }
  | "--core-flag-taints" :: rest, cfg => parseArgs rest { cfg with coreFlagTaints := true }
  | "--statement-max-chars" :: v :: rest, cfg =>
    match v.toNat? with
    | some k =>
      if k == 0 then .error "--statement-max-chars must be a positive integer"
      else parseArgs rest { cfg with statementMaxChars := k }
    | none => .error s!"--statement-max-chars expects a positive integer, got '{v}'"
  | a :: _, _ => .error s!"unknown or incomplete argument '{a}'"

def validate (cfg : Config) : Except String Config := do
  if cfg.out.isEmpty then throw "missing --out <path>"
  if cfg.projectDir.isEmpty then throw "missing --project-dir <abs path>"
  if cfg.projectName.isEmpty then throw "missing --project-name <name>"
  if cfg.roots.isEmpty then throw "missing --root <Module> (at least one)"
  if cfg.roots.any (·.isAnonymous) then throw "--root expects a module name"
  if cfg.localPrefixes.any (·.isAnonymous) then throw "--local-prefix expects a module name prefix"
  let prefixes := if cfg.localPrefixes.isEmpty then cfg.roots else cfg.localPrefixes
  return { cfg with localPrefixes := prefixes }

/-! ## Small utilities -/

def log (msg : String) : IO Unit := IO.eprintln s!"{extractorName}: {msg}"

/-- Remove adjacent duplicates of a sorted array. -/
def dedupSorted (a : Array Nat) : Array Nat := Id.run do
  let mut out : Array Nat := Array.mkEmpty a.size
  for x in a do
    if out.isEmpty || out.back! != x then out := out.push x
  return out

def sortDedup (a : Array Nat) : Array Nat :=
  if a.size ≤ 1 then a else dedupSorted (a.qsort (· < ·))

/-- Union of two sorted, duplicate-free arrays. Returns `a` itself when `b ⊆ a`. -/
def mergeSorted (a b : Array Nat) : Array Nat := Id.run do
  if b.isEmpty then return a
  if a.isEmpty then return b
  let mut out : Array Nat := Array.mkEmpty (a.size + b.size)
  let mut i := 0
  let mut j := 0
  while i < a.size && j < b.size do
    let x := a[i]!
    let y := b[j]!
    if x < y then
      out := out.push x
      i := i + 1
    else if y < x then
      out := out.push y
      j := j + 1
    else
      out := out.push x
      i := i + 1
      j := j + 1
  while i < a.size do
    out := out.push a[i]!
    i := i + 1
  while j < b.size do
    out := out.push b[j]!
    j := j + 1
  return if out.size == a.size then a else out

def padNat (n width : Nat) : String :=
  let s := toString n
  "".pushn '0' (width - s.length) ++ s

/-- Civil date from days since 1970-01-01 (Howard Hinnant's algorithm, non-negative input). -/
def civilFromDays (days : Nat) : Nat × Nat × Nat :=
  let z := days + 719468
  let era := z / 146097
  let doe := z - era * 146097
  let yoe := (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
  let doy := doe - (365 * yoe + yoe / 4 - yoe / 100)
  let mp := (5 * doy + 2) / 153
  let d := doy - (153 * mp + 2) / 5 + 1
  let m := if mp < 10 then mp + 3 else mp - 9
  let y := yoe + era * 400 + (if m ≤ 2 then 1 else 0)
  (y, m, d)

/-- ISO-8601 UTC timestamp with milliseconds, e.g. `2026-09-27T10:00:00.000Z`. -/
def isoOfMillis (ms : Nat) : String :=
  let (y, mo, d) := civilFromDays (ms / 86400000)
  let dayMs := ms % 86400000
  let h := dayMs / 3600000
  let mi := (dayMs % 3600000) / 60000
  let s := (dayMs % 60000) / 1000
  let milli := dayMs % 1000
  s!"{padNat y 4}-{padNat mo 2}-{padNat d 2}T{padNat h 2}:{padNat mi 2}:{padNat s 2}.{padNat milli 3}Z"

/-- Generation time. `SOURCE_DATE_EPOCH` (seconds, the reproducible-builds convention) wins when
set; otherwise the wall clock is read from the modification time of `probe`, a file this run has
just written. Core Lean has no portable wall-clock API before `Std.Time`, which `import Lean`
does not bring in on older toolchains. -/
def generatedAt (probe : System.FilePath) : IO String := do
  if let some s := (← IO.getEnv "SOURCE_DATE_EPOCH") then
    if let some secs := s.toNat? then return isoOfMillis (secs * 1000)
  let t := (← probe.metadata).modified
  return isoOfMillis (t.sec.toNat * 1000 + t.nsec.toNat / 1000000)

/-- Forward slashes, `.`/`..` resolved, upper-case drive letter. No file system access. -/
def normalizePath (p : String) : String := Id.run do
  let s := p.map fun c => if c == '\\' then '/' else c
  let absUnix := s.startsWith "/"
  let mut out : Array String := #[]
  for part in s.splitOn "/" do
    if part.isEmpty || part == "." then continue
    if part == ".." && !out.isEmpty && out.back! != ".." && !(out.size == 1 && out[0]!.endsWith ":") then
      out := out.pop
    else
      out := out.push part
  let joined := "/".intercalate out.toList
  let joined := match joined.toList with
    | c :: ':' :: _ => String.singleton c.toUpper ++ toString (joined.drop 1)
    | _ => joined
  return if absUnix then "/" ++ joined else joined

def realNormalized (p : String) : IO String := do
  try
    return normalizePath (← IO.FS.realPath p).toString
  catch _ =>
    return normalizePath p

/-- `file` relative to `dir` (both normalised) when it is inside it, else `file`. The comparison is
case-insensitive on Windows. -/
def relativeTo (dir file : String) : String :=
  let fold (s : String) : String := if System.Platform.isWindows then s.map Char.toLower else s
  let pre := if dir.endsWith "/" then dir else dir ++ "/"
  if (fold file).startsWith (fold pre) then toString (file.drop pre.length) else file

/-! ## Classification -/

/-- Axiom classes, mirroring `classifyAxiom` in `packages/schema/src/graph.ts`. -/
inductive AxClass where
  | standard | sorry | nativeDecide | custom
  deriving BEq, Inhabited

/-- `ax_<digits>_<digits>`. -/
def isMintedAxSuffix (s : String) : Bool :=
  match s.splitOn "_" with
  | ["ax", i, j] => !i.isEmpty && i.all Char.isDigit && !j.isEmpty && j.all Char.isDigit
  | _ => false

/-- The axiom Lean ≥ 4.35 mints for each `native_decide` use: `<decl>._native.native_decide.ax_<i>_<j>`
with a non-empty `<decl>`. Same rule as the schema's regex `\._native\.native_decide\.ax_\d+_\d+$`,
checked on name components rather than on the printed string. -/
def isMintedNativeDecideAxiom : Name → Bool
  | .str (.str (.str p "_native") "native_decide") s => !p.isAnonymous && isMintedAxSuffix s
  | _ => false

def classifyAxiom (n : Name) (s : String) : AxClass :=
  if s == "propext" || s == "Classical.choice" || s == "Quot.sound" then .standard
  else if s == "sorryAx" then .sorry
  -- `Lean.trustCompiler` is the axiom `ofReduceBool`/`ofReduceNat` rest on in Lean ≤ 4.34.
  else if s == "Lean.ofReduceBool" || s == "Lean.ofReduceNat" || s == "Lean.trustCompiler" then
    .nativeDecide
  else if isMintedNativeDecideAxiom n then .nativeDecide
  else .custom

/-- Flag-taint bits, in `TAINT_SEVERITY` order. -/
def bitImplementedBy : UInt8 := 1
def bitExtern : UInt8 := 2
def bitPartial : UInt8 := 4
def bitUnsafe : UInt8 := 8

def kindOf : ConstantInfo → String
  | .axiomInfo _ => "axiom"
  | .thmInfo _ => "theorem"
  | .defnInfo _ => "definition"
  | .opaqueInfo _ => "opaque"
  | .inductInfo _ => "inductive"
  | .ctorInfo _ => "constructor"
  | .recInfo _ => "recursor"
  | .quotInfo _ => "quot"

def allKinds : Array String :=
  #["axiom", "theorem", "definition", "opaque", "inductive", "constructor", "recursor", "quot"]

def allTaints : Array String :=
  #["implementedBy", "extern", "partial", "unsafe", "nativeDecide", "customAxiom", "sorry"]

/-- `partial` flag. A `partial def f` is elaborated to an `opaque f` (what the kernel sees) plus
`f._unsafe_rec`, a definition with `DefinitionSafety.partial` that the compiler runs. Structural
and well-founded recursion also create a `partial`-safety `_unsafe_rec` copy of a safe definition;
that copy is not flagged because the kernel checked the real definition. -/
def isPartialFlag (env : Environment) (n : Name) (ci : ConstantInfo) : Bool :=
  match ci with
  | .defnInfo v =>
    v.safety == .partial &&
      match Compiler.isUnsafeRecName? n with
      | some parent => !(env.find? parent |>.any fun p => p matches .defnInfo _)
      | none => true
  | .opaqueInfo v =>
    !v.isUnsafe && (env.find? (Compiler.mkUnsafeRecName n) |>.any (·.isPartial))
  | _ => false

def isNumberedSuffix (s pre : String) : Bool :=
  s.startsWith pre && s.length > pre.length && (toString (s.drop pre.length)).all Char.isDigit

/-- Companions generated for an inductive type or one of its constructors. -/
def typeCompanions : Array String :=
  #["rec", "recOn", "casesOn", "brecOn", "binductionOn", "below", "ibelow", "noConfusion",
    "noConfusionType", "ctorIdx", "toCtorIdx", "ctorElim", "ctorElimType", "elim", "inj", "injEq",
    "sizeOf_spec"]

/-- Companions generated for a definition or theorem (equation lemmas, matchers, ...). -/
def declCompanions : Array String :=
  #["eq_def", "eq_unfold", "induct", "mutual_induct", "fun_cases", "congr_simp", "splitter"]

/-- Auto-generated companion heuristics (`docs/ARCHITECTURE.md` §2 item 7). A name is aux when
it, or one of its prefixes, is a companion of an existing declaration. The heuristics look at the
user name, so a hand-written `private def` is not aux but its generated companions are. -/
def isAuxName (env : Environment) (n : Name) : Bool :=
  -- Any component starting with `_`: `_unsafe_rec`, `_private`, `_hyg`, `_native`, `_sizeOf_<n>`,
  -- `_proof_<n>`, `_flat_ctor`, `_sunfold`, `_f`, `_cstage<n>`, `_auxLemma`, ...
  if (privateToUserName n).isInternal then true else go n
where
  parent? (p : Name) : Option ConstantInfo :=
    env.find? p <|> (if isPrivateName p then env.find? (privateToUserName p) else none)
  go : Name → Bool
    | .str p s =>
      let isCompanion :=
        if typeCompanions.contains s then
          (parent? p).any fun ci => ci matches .inductInfo _ | .ctorInfo _
        else if declCompanions.contains s || isNumberedSuffix s "eq_" ||
            isNumberedSuffix s "match_" || isNumberedSuffix s "proof_" then
          (parent? p).isSome
        else
          s.startsWith "instSizeOf"
      isCompanion || go p
    | .num p _ => go p
    | .anonymous => false

def shortNameOf : Name → String
  | .str _ s => s
  | .num _ k => toString k
  | .anonymous => ""

/-! ## Reachable graph -/

/-- The reachable subgraph with dense indices. -/
structure Graph where
  names : Array Name := #[]
  infos : Array ConstantInfo := #[]
  /-- Constants used by the type (self excluded, unsorted, no duplicates). -/
  stmt : Array (Array Nat) := #[]
  /-- Constants used by the value, or by the recursor rules (self excluded, unsorted, no duplicates). -/
  proof : Array (Array Nat) := #[]
  /-- Kernel trust edges: `stmt ∪ proof ∪ ctors` (deduplicated, unsorted). -/
  ksucc : Array (Array Nat) := #[]
  /-- Implementation edges, followed for flag taints only. -/
  impl : Array (Array Nat) := #[]
  /-- Referenced names absent from the environment (should stay empty). -/
  missing : Array Name := #[]

def recRuleConsts (v : RecursorVal) : Array Name := Id.run do
  let mut seen : Std.HashSet Name := {}
  let mut out : Array Name := #[]
  for r in v.rules do
    for c in r.rhs.getUsedConstants do
      if !seen.contains c then
        seen := seen.insert c
        out := out.push c
  return out

def valueConsts (ci : ConstantInfo) : Array Name :=
  match ci.value? (allowOpaque := true) with
  | some v => v.getUsedConstants
  | none =>
    match ci with
    | .recInfo v => recRuleConsts v
    | _ => #[]

def implTargets (env : Environment) (n : Name) (ci : ConstantInfo) : Array Name := Id.run do
  let mut out : Array Name := #[]
  if let some t := Compiler.implementedByAttr.getParam? env n then
    out := out.push t
  if ci matches .opaqueInfo _ then
    let r := Compiler.mkUnsafeRecName n
    if env.contains r then out := out.push r
  return out

/-- Mutable state of the discovery pass, threaded as one value (see `SccState` for why). -/
structure DiscState where
  names : Array Name := #[]
  infos : Array ConstantInfo := #[]
  idx : Std.HashMap Name Nat := {}
  stmt : Array (Array Nat) := #[]
  proof : Array (Array Nat) := #[]
  ksucc : Array (Array Nat) := #[]
  impl : Array (Array Nat) := #[]
  /-- `mark[j] = i` when `j` is already in the kernel successors of `i`; initialised to `j`,
  which is never a successor of itself. -/
  mark : Array Nat := #[]
  missing : Array Name := #[]
  work : Array Nat := #[]
  -- Successors of the node being expanded.
  curSt : Array Nat := #[]
  curPr : Array Nat := #[]
  curKs : Array Nat := #[]
  curIm : Array Nat := #[]

/-- Index of `c`, allocating it (and scheduling it for expansion) when new. -/
def DiscState.intern (env : Environment) (st : DiscState) (c : Name) : DiscState × Nat :=
  match st.idx[c]? with
  | some j => (st, j)
  | none =>
    match env.find? c with
    | none => ({ st with missing := st.missing.push c }, st.names.size + 1)
    | some ci =>
      let j := st.names.size
      ({ st with
        names := st.names.push c, infos := st.infos.push ci, idx := st.idx.insert c j,
        mark := st.mark.push j, work := st.work.push j,
        stmt := st.stmt.push #[], proof := st.proof.push #[], ksucc := st.ksucc.push #[],
        impl := st.impl.push #[] }, j)

/-- Record that node `i` uses `c` at site `k` (0 type, 1 value, 2 constructor, 3 implementation). -/
def DiscState.addRef (env : Environment) (i k : Nat) (st : DiscState) (c : Name) : DiscState :=
  let (st, j) := st.intern env c
  -- `j > names.size` flags a missing constant; `j == i` is a self reference.
  if j == i || j > st.names.size then st
  else
    let st :=
      if k == 0 then { st with curSt := st.curSt.push j }
      else if k == 1 then { st with curPr := st.curPr.push j }
      else if k == 3 then { st with curIm := st.curIm.push j }
      else st
    if k < 3 && st.mark[j]! != i then
      { st with mark := st.mark.set! j i, curKs := st.curKs.push j }
    else st

/-- Expand the next node of the work list. -/
def DiscState.expand (env : Environment) (followImpl : Name → Bool) (st : DiscState) : DiscState :=
  let i := st.work.back!
  let st := { st with work := st.work.pop, curSt := #[], curPr := #[], curKs := #[], curIm := #[] }
  let n := st.names[i]!
  let ci := st.infos[i]!
  let st := ci.type.getUsedConstants.foldl (addRef env i 0) st
  let st := (valueConsts ci).foldl (addRef env i 1) st
  let st := match ci with
    | .inductInfo v => v.ctors.foldl (addRef env i 2) st
    | _ => st
  let st := if followImpl n then (implTargets env n ci).foldl (addRef env i 3) st else st
  { st with
    stmt := st.stmt.set! i st.curSt, proof := st.proof.set! i st.curPr,
    ksucc := st.ksucc.set! i st.curKs, impl := st.impl.set! i st.curIm,
    curSt := #[], curPr := #[], curKs := #[], curIm := #[] }

/-- Depth-first discovery of everything reachable from `seeds`, with an explicit work list.
`followImpl n` decides whether the implementation edges of `n` are followed (they only matter
when `n` can originate a flag taint). Successor lists are unsorted (the SCC pass does not care);
`ksucc` is de-duplicated with a per-node mark so the overlap of type and value costs nothing. -/
def discover (env : Environment) (seeds : Array Name) (followImpl : Name → Bool) : Graph := Id.run do
  let mut st : DiscState := {}
  for n in seeds do
    st := (st.intern env n).1
  while !st.work.isEmpty do
    st := st.expand env followImpl
  return {
    names := st.names, infos := st.infos, stmt := st.stmt, proof := st.proof,
    ksucc := st.ksucc, impl := st.impl, missing := st.missing }

/-! ## Strongly connected components and trust profiles -/

/-- Interned axiom sets. Id `0` is the empty set; unions are memoised, so the per-edge cost of the
profile pass is a comparison of two ids in the common case. -/
structure AxSets where
  sets : Array (Array Nat) := #[#[]]
  ids : Std.HashMap (Array Nat) Nat := ({} : Std.HashMap (Array Nat) Nat).insert #[] 0
  memo : Std.HashMap (Nat × Nat) Nat := {}

def AxSets.intern (s : AxSets) (a : Array Nat) : AxSets × Nat :=
  match s.ids[a]? with
  | some i => (s, i)
  | none =>
    let i := s.sets.size
    ({ s with sets := s.sets.push a, ids := s.ids.insert a i }, i)

def AxSets.union (s : AxSets) (a b : Nat) : AxSets × Nat :=
  if a == b || b == 0 then (s, a)
  else if a == 0 then (s, b)
  else
    let key := if a < b then (a, b) else (b, a)
    match s.memo[key]? with
    | some r => (s, r)
    | none =>
      let (s, r) := s.intern (mergeSorted s.sets[a]! s.sets[b]!)
      ({ s with memo := s.memo.insert key r }, r)

/-- Result of one SCC pass. -/
structure Profiles where
  /-- Axiom-set id (into `sets`) per node; all zero when axioms were not requested. -/
  ax : Array Nat
  /-- Flag-taint bits per node. -/
  flags : Array UInt8
  sets : AxSets
  numComps : Nat
  /-- Some implementation edge lies inside a strongly connected component. Axiom sets are then
  not trustworthy (they must follow kernel edges only) and need a kernel-only pass. -/
  implInCycle : Bool

/-- Read-only inputs of the SCC pass. -/
structure SccInput where
  ksucc : Array (Array Nat)
  impl : Array (Array Nat)
  isAxiom : Array Bool
  /-- Sentinel for "no index yet" / "no component yet": the number of nodes. -/
  unset : Nat
  withAxioms : Bool
  followImpl : Bool

/-- Mutable state of the SCC pass. It is threaded through small functions as one value (instead of
many `let mut` variables) because the interpreter that runs `lean --run` rebuilds the tuple of all
mutable variables on every loop iteration; one structure updated in place is much cheaper. -/
structure SccState where
  index : Array Nat
  low : Array Nat
  comp : Array Nat
  accAx : Array Nat
  accFl : Array UInt8
  compAx : Array Nat
  compFl : Array UInt8
  sets : AxSets
  stk : Array Nat
  callV : Array Nat
  callPos : Array Nat
  counter : Nat
  implInCycle : Bool

def SccState.enter (I : SccInput) (st : SccState) (w : Nat) : SccState :=
  let st := { st with
    index := st.index.set! w st.counter, low := st.low.set! w st.counter,
    counter := st.counter + 1, stk := st.stk.push w, callV := st.callV.push w,
    callPos := st.callPos.push 0 }
  if I.withAxioms && I.isAxiom[w]! then
    let (sets, a) := st.sets.intern #[w]
    { st with sets, accAx := st.accAx.set! w a }
  else st

/-- The top node `v` has no edge left: close its component if it is a root, then fold it into
its DFS parent. -/
def SccState.finish (I : SccInput) (st : SccState) (v : Nat) : SccState := Id.run do
  let mut st := { st with callV := st.callV.pop, callPos := st.callPos.pop }
  let lv := st.low[v]!
  if lv == st.index[v]! then
    let c := st.compAx.size
    let mut done := false
    while !done do
      let w := st.stk.back!
      st := { st with stk := st.stk.pop, comp := st.comp.set! w c }
      done := w == v
    st := { st with compAx := st.compAx.push st.accAx[v]!, compFl := st.compFl.push st.accFl[v]! }
  if st.callV.isEmpty then return st
  let ptop := st.callV.size - 1
  let u := st.callV[ptop]!
  if lv < st.low[u]! then st := { st with low := st.low.set! u lv }
  -- The tree edge `u → v` is the one just before `callPos[ptop]`.
  let edgeKernel := st.callPos[ptop]! - 1 < I.ksucc[u]!.size
  let cv := st.comp[v]!
  let sameComp := cv == I.unset
  let fl := if sameComp then st.accFl[v]! else st.compFl[cv]!
  let fu := st.accFl[u]!
  if (fu ||| fl) != fu then st := { st with accFl := st.accFl.set! u (fu ||| fl) }
  if sameComp && !edgeKernel then st := { st with implInCycle := true }
  if I.withAxioms && (edgeKernel || sameComp) then
    let a := if sameComp then st.accAx[v]! else st.compAx[cv]!
    let au := st.accAx[u]!
    if a != au then
      let (sets, r) := st.sets.union au a
      st := { st with sets, accAx := st.accAx.set! u r }
  return st

/-- Consume one edge of the top node, or finish it. -/
def SccState.step (I : SccInput) (st : SccState) : SccState :=
  let top := st.callV.size - 1
  let v := st.callV[top]!
  let pos := st.callPos[top]!
  let ks := I.ksucc[v]!
  let nk := ks.size
  let nImpl := if I.followImpl then I.impl[v]!.size else 0
  if pos < nk + nImpl then
    let st := { st with callPos := st.callPos.set! top (pos + 1) }
    let isKernel := pos < nk
    let w := if isKernel then ks[pos]! else I.impl[v]![pos - nk]!
    let iw := st.index[w]!
    if iw == I.unset then st.enter I w
    else
      let cw := st.comp[w]!
      if cw == I.unset then
        -- `w` is on the stack: same component as `v`.
        let st := if iw < st.low[v]! then { st with low := st.low.set! v iw } else st
        if isKernel then st else { st with implInCycle := true }
      else
        -- `w` belongs to a completed component: fold its profile.
        let fv := st.accFl[v]!
        let f := fv ||| st.compFl[cw]!
        let st := if f != fv then { st with accFl := st.accFl.set! v f } else st
        if I.withAxioms && isKernel then
          let a := st.compAx[cw]!
          let av := st.accAx[v]!
          if a == av then st
          else
            let (sets, r) := st.sets.union av a
            { st with sets, accAx := st.accAx.set! v r }
        else st
  else st.finish I v

/-- Iterative Tarjan over `ksucc` (kernel edges) plus, when `followImpl`, `impl` (implementation
edges), computing trust profiles on the fly. No recursion: dependency chains of any depth are fine.

Every node carries an accumulator initialised with its own flags (and its own axiom when it is an
axiom). An edge to an already completed component folds that component's profile into the
accumulator: flags always, axioms only along kernel edges. When a DFS child returns while still on
the stack (same component as its parent) its accumulator is folded into the parent's, so the root
of a component ends up holding the union for the whole component. Components complete in reverse
topological order, which makes every successor's profile final when it is read.

Axioms of a component are exact when no implementation edge closes a cycle (then the components
of the extended graph are those of the kernel graph); otherwise `implInCycle` is set. -/
def sccProfiles (ksucc impl : Array (Array Nat)) (isAxiom : Array Bool) (own : Array UInt8)
    (withAxioms followImpl : Bool) : Profiles := Id.run do
  let n := ksucc.size
  let I : SccInput := { ksucc, impl, isAxiom, unset := n, withAxioms, followImpl }
  let mut st : SccState := {
    index := Array.replicate n n, low := Array.replicate n 0, comp := Array.replicate n n,
    accAx := Array.replicate n 0, accFl := own, compAx := #[], compFl := #[], sets := {},
    stk := #[], callV := #[], callPos := #[], counter := 0, implInCycle := false }
  for s in [0:n] do
    if st.index[s]! != n then continue
    st := st.enter I s
    while !st.callV.isEmpty do
      st := st.step I
  return {
    ax := st.comp.map (st.compAx[·]!), flags := st.comp.map (st.compFl[·]!), sets := st.sets,
    numComps := st.compAx.size, implInCycle := st.implInCycle }

/-! ## Output -/

def jStrs (xs : Array String) : Json := .arr (xs.map Json.str)

def ppOptions : Options :=
  ({} : Options).setBool `pp.proofs false |>.setBool `pp.deepTerms false

/-- Pretty-printed type at width 100, falling back to the raw expression if the delaborator
fails or runs out of heartbeats. -/
def ppStatement (ci : ConstantInfo) : MetaM String :=
  tryCatchRuntimeEx
    (withCurrHeartbeats do
      let fmt ← ppExpr ci.type
      return fmt.pretty 100)
    (fun _ => return toString ci.type)

def truncateChars (s : String) (maxChars : Nat) : String × Bool :=
  if s.length ≤ maxChars then (s, false) else (toString (s.take maxChars), true)

/-- Everything about the run that the node writer needs. -/
structure Ctx where
  cfg : Config
  env : Environment
  g : Graph
  strs : Array String
  modName : Array String
  pkg : Array String
  isLocal : Array Bool
  isAux : Array Bool
  axProf : Array (Array Nat)
  axClass : Array AxClass
  flagProf : Array UInt8
  projectDir : String
  /-- Module index of every node (`none` only for constants without a module). -/
  modIdx : Array (Option Nat)
  /-- Imported module names and whether each is local, by module index. -/
  modules : Array Name
  modIsLocal : Array Bool

/-- Direct dependencies as emitted: `(stmt, proof)`. In default mode an external axiom is emitted
as a pure source, with no dependencies and `depsComplete: true`, so every axiom sits in the first
column of the workflow. -/
def emittedDeps (cfg : Config) (g : Graph) (isLocal : Array Bool) (i : Nat) :
    Array Nat × Array Nat :=
  if !cfg.expandExternal && !isLocal[i]! && g.infos[i]! matches .axiomInfo _ then (#[], #[])
  else (g.stmt[i]!, g.proof[i]!)

def sortByStr (strs : Array String) (xs : Array Nat) : Array Nat :=
  xs.qsort fun a b => strs[a]! < strs[b]!

def taintsOf (c : Ctx) (i : Nat) : Array String := Id.run do
  let bits := c.flagProf[i]!
  let mut hasNative := false
  let mut hasCustom := false
  let mut hasSorry := false
  for a in c.axProf[i]! do
    match c.axClass[a]! with
    | .nativeDecide => hasNative := true
    | .custom => hasCustom := true
    | .sorry => hasSorry := true
    | .standard => pure ()
  let mut out : Array String := #[]
  if bits &&& bitImplementedBy != 0 then out := out.push "implementedBy"
  if bits &&& bitExtern != 0 then out := out.push "extern"
  if bits &&& bitPartial != 0 then out := out.push "partial"
  if bits &&& bitUnsafe != 0 then out := out.push "unsafe"
  if hasNative then out := out.push "nativeDecide"
  if hasCustom then out := out.push "customAxiom"
  if hasSorry then out := out.push "sorry"
  return out

def subKindOf (env : Environment) (n : Name) (ci : ConstantInfo) : String :=
  if isClass env n then "class"
  else if isStructure env n then "structure"
  else if Meta.isInstanceCore env n then "instance"
  else match ci with
    | .defnInfo { hints := .abbrev, .. } => if env.isProjectionFn n then "none" else "abbrev"
    | _ => "none"

/-- Source file of a module, cached per module index. Never an absolute path, so the output is the
same on every machine:
* local modules: relative to `--project-dir` (e.g. `Toy/Defs.lean`);
* external modules, and local ones outside the project directory: relative to the source search
  path entry that contains them, which is the module name as a path (e.g. `Init/Prelude.lean`,
  `Mathlib/Data/Nat/Basic.lean`).
`none` when the source file does not exist. -/
def srcFileOf (c : Ctx) (sp : SearchPath) (cache : IO.Ref (Std.HashMap Nat (Option String)))
    (mi : Nat) : IO (Option String) := do
  if let some r := (← cache.get)[mi]? then return r
  let mod := c.modules[mi]!
  let r ← do
    match ← sp.findWithExt "lean" mod with
    | some p =>
      if ← p.pathExists then
        let inSearchRoot :=
          "/".intercalate (mod.components.map (·.toString (escape := false))) ++ ".lean"
        if c.modIsLocal[mi]! then
          let abs ← realNormalized p.toString
          let rel := relativeTo c.projectDir abs
          pure (some (if rel == abs then inSearchRoot else rel))
        else pure (some inSearchRoot)
      else pure none
    | none => pure none
  cache.modify (·.insert mi r)
  return r

def nodeJson (c : Ctx) (sp : SearchPath) (cache : IO.Ref (Std.HashMap Nat (Option String)))
    (i : Nat) : MetaM Json := do
  let env := c.env
  let n := c.g.names[i]!
  let ci := c.g.infos[i]!
  let mod := c.modName[i]!
  -- Source range: 1-based lines, 0-based columns in Unicode code points (Lean's `Position`).
  let src ← do
    match ← findDeclarationRanges? n with
    | none => pure Json.null
    | some r =>
      let file? : Option String ← match c.modIdx[i]! with
        | some mi => srcFileOf c sp cache mi
        | none => pure none
      match file? with
      | none => pure Json.null
      | some file =>
        pure <| Json.mkObj [
          ("file", .str file),
          ("line", toJson r.range.pos.line), ("col", toJson r.range.pos.column),
          ("endLine", toJson r.range.endPos.line), ("endCol", toJson r.range.endPos.column)]
  let doc ← do
    match ← findDocString? env n with
    | some d => pure (Json.str d)
    | none => pure Json.null
  let (statement, truncated) ←
    if c.cfg.noStatements then pure ("", false)
    else pure (truncateChars (← ppStatement ci) c.cfg.statementMaxChars)
  -- Direct flags look at the constants the declaration really uses; `deps` is what is emitted.
  let usesAx (p : AxClass → Bool) : Bool :=
    c.g.stmt[i]!.any (fun j => c.g.infos[j]! matches .axiomInfo _ && p c.axClass[j]!) ||
      c.g.proof[i]!.any (fun j => c.g.infos[j]! matches .axiomInfo _ && p c.axClass[j]!)
  let (stmtDeps, proofDeps) := emittedDeps c.cfg c.g c.isLocal i
  let flags := Json.mkObj [
    ("unsafe", .bool ci.isUnsafe),
    ("partial", .bool (isPartialFlag env n ci)),
    ("noncomputable", .bool (isNoncomputable env n)),
    ("extern", .bool (isExtern env n)),
    ("implementedBy", .bool (Compiler.implementedByAttr.getParam? env n).isSome),
    ("private", .bool (isPrivateName n)),
    ("protected", .bool (isProtected env n)),
    ("instance", .bool (Meta.isInstanceCore env n)),
    ("directSorry", .bool (usesAx (· == .sorry))),
    ("directNativeDecide", .bool (usesAx (· == .nativeDecide)))]
  let axioms := (c.axProf[i]!.map (c.strs[·]!)).qsort (· < ·)
  let depStrs (xs : Array Nat) : Array String := (sortByStr c.strs xs).map (c.strs[·]!)
  return Json.mkObj [
    ("id", .str c.strs[i]!),
    ("shortName", .str (shortNameOf (privateToUserName n))),
    ("kind", .str (kindOf ci)),
    ("subKind", .str (subKindOf env n ci)),
    ("module", .str mod),
    ("package", .str c.pkg[i]!),
    ("isLocal", .bool c.isLocal[i]!),
    ("isAux", .bool c.isAux[i]!),
    ("src", src),
    ("doc", doc),
    ("statement", .str statement),
    ("statementTruncated", .bool truncated),
    ("levelParams", jStrs (ci.levelParams.toArray.map toString)),
    ("flags", flags),
    ("axioms", jStrs axioms),
    ("taints", jStrs (taintsOf c i)),
    ("deps", Json.mkObj [("stmt", jStrs (depStrs stmtDeps)), ("proof", jStrs (depStrs proofDeps))]),
    ("depsComplete", .bool (c.isLocal[i]! || c.cfg.expandExternal || ci matches .axiomInfo _))]

/-! ## Main -/

def run (cfg : Config) : IO UInt32 := do
  let t0 ← IO.monoMsNow
  let projectDir ← realNormalized cfg.projectDir
  initSearchPath (← findSysroot)
  -- Loading extensions runs `initialize` blocks of the imported modules; required for instance,
  -- class and notation data (`isInstanceCore`, `isClass`, `ppExpr`).
  unsafe enableInitializersExecution
  let env ← importModules (cfg.roots.map fun r => { module := r }) {} (trustLevel := 1024)
    (leakEnv := true) (loadExts := true)
  let modules := env.allImportedModuleNames
  let t1 ← IO.monoMsNow
  log s!"imported {modules.size} modules in {t1 - t0} ms"

  -- Per-module facts.
  let modIsLocal := modules.map fun m => cfg.localPrefixes.any (·.isPrefixOf m)
  let modStr := modules.map toString
  let modPkg := modules.map fun m => toString m.getRoot
  -- A module is core when it belongs to the toolchain and is not local.
  let modIsCore := (modPkg.zip modIsLocal).map fun (p, l) => !l && corePackages.contains p
  let canTaint (n : Name) : Bool :=
    cfg.coreFlagTaints || !((env.getModuleIdxFor? n).any fun mi => modIsCore[mi.toNat]!)
  if !modIsLocal.any id then
    throw <| IO.userError s!"no imported module matches the local prefixes {cfg.localPrefixes.toList}"

  -- Seeds: every constant of every local module, attributed by `getModuleIdxFor?`.
  let mut seeds : Array Name := #[]
  for mi in [0:modules.size] do
    if modIsLocal[mi]! then
      for n in env.header.moduleData[mi]!.constNames do
        if (env.getModuleIdxFor? n).map (·.toNat) == some mi then seeds := seeds.push n
  let g := discover env seeds canTaint
  let t2 ← IO.monoMsNow
  log s!"{seeds.size} local constants, {g.names.size} reachable constants in {t2 - t1} ms"
  unless g.missing.isEmpty do
    log s!"warning: {g.missing.size} referenced constants are missing from the environment, e.g. {g.missing.toList.take 5}"

  let size := g.names.size
  let modIdx : Array (Option Nat) := g.names.map fun n => (env.getModuleIdxFor? n).map (·.toNat)
  let isLocal := modIdx.map fun m? => m?.any (modIsLocal[·]!)
  let modName := modIdx.map fun m? => m?.elim "" (modStr[·]!)
  let pkg := modIdx.map fun m? => m?.elim "" (modPkg[·]!)
  let strs := g.names.map toString

  -- Own flag-taint bits (origins), respecting the core-package exemption.
  let mut own : Array UInt8 := Array.replicate size 0
  for i in [0:size] do
    let n := g.names[i]!
    if canTaint n then
      let ci := g.infos[i]!
      let mut b : UInt8 := 0
      if (Compiler.implementedByAttr.getParam? env n).isSome then b := b ||| bitImplementedBy
      if isExtern env n then b := b ||| bitExtern
      if isPartialFlag env n ci then b := b ||| bitPartial
      if ci.isUnsafe then b := b ||| bitUnsafe
      own := own.set! i b
  let isAxiom := g.infos.map (· matches .axiomInfo _)
  -- One pass over kernel + implementation edges computes flags (which follow both) and axioms
  -- (which follow kernel edges only, so they agree with `#print axioms`). If an implementation
  -- edge closes a cycle, the axioms are recomputed by a kernel-only pass.
  let prof := sccProfiles g.ksucc g.impl isAxiom own (withAxioms := true) (followImpl := true)
  let kernel :=
    if prof.implInCycle then
      sccProfiles g.ksucc g.impl isAxiom own (withAxioms := true) (followImpl := false)
    else prof
  let flagProf := prof.flags
  let axProf : Array (Array Nat) := kernel.ax.map (kernel.sets.sets[·]!)
  let axClass := (g.names.zip isAxiom).mapIdx fun i (_, isAx) =>
    if isAx then classifyAxiom g.names[i]! strs[i]! else AxClass.standard
  let t3 ← IO.monoMsNow
  let nEdges := g.ksucc.foldl (· + ·.size) 0
  let nImpl := g.impl.foldl (· + ·.size) 0
  log s!"trust profiles over {nEdges} kernel edges, {nImpl} implementation edges, {kernel.numComps} components, {kernel.sets.sets.size} distinct axiom sets{if prof.implInCycle then " (kernel-only rerun)" else ""} in {t3 - t2} ms"

  -- Every axiom reachable from a local node (`stats.axiomNodes`). All of them are emitted, so the
  -- graph is self-contained and every axiom is a node.
  let mut reachableAxioms : Array Nat := #[]
  for i in [0:size] do
    if isLocal[i]! then reachableAxioms := mergeSorted reachableAxioms axProf[i]!

  -- Emitted set.
  let mut emit : Array Bool := isLocal
  if cfg.expandExternal then
    -- The closure of the local nodes and of the reachable axioms. An axiom can be reachable only
    -- through the constructors of an inductive type, which are not `deps` edges, so seeding with
    -- the axioms keeps `depsComplete: true` truthful.
    let mut work : Array Nat := #[]
    for i in [0:size] do
      if isLocal[i]! then work := work.push i
    for a in reachableAxioms do
      if !emit[a]! then
        emit := emit.set! a true
        work := work.push a
    while !work.isEmpty do
      let i := work.back!
      work := work.pop
      for j in g.stmt[i]! ++ g.proof[i]! do
        if !emit[j]! then
          emit := emit.set! j true
          work := work.push j
  else
    for i in [0:size] do
      if isLocal[i]! then
        for j in g.stmt[i]! ++ g.proof[i]! do
          emit := emit.set! j true
    -- External axioms are emitted as pure sources (see `emittedDeps`).
    for a in reachableAxioms do
      emit := emit.set! a true
  let mut emittedRaw : Array Nat := #[]
  for i in [0:size] do
    if emit[i]! then emittedRaw := emittedRaw.push i
  let emitted := sortByStr strs emittedRaw
  -- An axiom is never hidden as aux unless it is the axiom `native_decide` mints: a custom axiom
  -- with an internal-looking name (`Foo._native.bar`, `_oracle`) stays visible.
  let isAux := g.names.mapIdx fun i n =>
    emit[i]! && (if isAxiom[i]! then isMintedNativeDecideAxiom n else isAuxName env n)

  -- Stats.
  let mut hasLocalDependent : Array Bool := Array.replicate size false
  let mut edges := 0
  for i in emitted do
    let (st, pr) := emittedDeps cfg g isLocal i
    let deps := sortDedup (st ++ pr)
    for j in deps do
      if emit[j]! then edges := edges + 1
      if isLocal[i]! then hasLocalDependent := hasLocalDependent.set! j true
  let mut byKind : Std.HashMap String Nat := {}
  for i in emitted do
    let k := kindOf g.infos[i]!
    byKind := byKind.insert k (byKind.getD k 0 + 1)
  let ctx : Ctx := {
    cfg, env, g, strs, modName, pkg, isLocal, isAux, axProf, axClass, flagProf, projectDir,
    modIdx, modules, modIsLocal }
  let mut byTaint : Std.HashMap String Nat := {}
  let mut localSinks : Array Nat := #[]
  let mut nLocal := 0
  for i in emitted do
    if isLocal[i]! then
      nLocal := nLocal + 1
      for t in taintsOf ctx i do
        byTaint := byTaint.insert t (byTaint.getD t 0 + 1)
      if !isAux[i]! && !hasLocalDependent[i]! then localSinks := localSinks.push i
  let stats := Json.mkObj [
    ("nodes", toJson emitted.size),
    ("localNodes", toJson nLocal),
    ("externalNodes", toJson (emitted.size - nLocal)),
    ("edges", toJson edges),
    ("byKind", Json.mkObj (allKinds.toList.map fun k => (k, toJson (byKind.getD k 0)))),
    ("byTaint", Json.mkObj (allTaints.toList.map fun t => (t, toJson (byTaint.getD t 0)))),
    ("localSinks", jStrs ((sortByStr strs localSinks).map (strs[·]!))),
    ("axiomNodes", jStrs ((sortByStr strs reachableAxioms).map (strs[·]!)))]

  -- Stream the file: one JSON value per line, nodes sorted by id. The temporary file is created
  -- first because its modification time doubles as the generation timestamp.
  let outPath : System.FilePath := cfg.out
  if let some parent := outPath.parent then
    if !parent.toString.isEmpty then IO.FS.createDirAll parent
  let tmpPath : System.FilePath := cfg.out ++ ".tmp"
  IO.FS.writeFile tmpPath ""
  let metaJson := Json.mkObj [
    ("schemaVersion", toJson schemaVersion),
    ("generatedAt", .str (← generatedAt tmpPath)),
    ("extractor", Json.mkObj [("name", .str extractorName), ("version", .str extractorVersion)]),
    ("lean", Json.mkObj [("version", .str Lean.versionString), ("githash", .str Lean.githash)]),
    ("project", Json.mkObj [
      ("name", .str cfg.projectName),
      ("dir", .str projectDir),
      ("roots", jStrs (cfg.roots.map toString)),
      ("localPrefixes", jStrs (cfg.localPrefixes.map toString))]),
    ("options", Json.mkObj [
      ("expandExternal", .bool cfg.expandExternal),
      ("statementMaxChars", toJson cfg.statementMaxChars)])]
  let sp ← getSrcSearchPath
  let cache ← IO.mkRef ({} : Std.HashMap Nat (Option String))
  let coreCtx : Core.Context := {
    fileName := "<proofflow-extract>", fileMap := default, options := ppOptions }
  let coreState : Core.State := { env }
  let writeAll : IO Unit := do
    let h ← IO.FS.Handle.mk tmpPath .write
    h.putStr s!"\{\"meta\":{metaJson.compress},\n\"stats\":{stats.compress},\n\"nodes\":["
    let write : MetaM Unit := do
      let mut first := true
      for i in emitted do
        let j ← nodeJson ctx sp cache i
        h.putStr ((if first then "\n" else ",\n") ++ j.compress)
        first := false
    discard <| write.toIO coreCtx coreState
    h.putStr "\n]}\n"
    h.flush
  try
    writeAll
  catch e =>
    try IO.FS.removeFile tmpPath catch _ => pure ()
    throw e
  -- The handle is closed once `writeAll` returns; replace the target in one step.
  try
    IO.FS.rename tmpPath outPath
  catch _ =>
    if ← outPath.pathExists then IO.FS.removeFile outPath
    IO.FS.rename tmpPath outPath
  let t4 ← IO.monoMsNow
  log s!"wrote {emitted.size} nodes ({nLocal} local, {emitted.size - nLocal} external), {edges} edges to {cfg.out} in {t4 - t3} ms (total {t4 - t0} ms)"
  return 0

end ProofFlow

def main (args : List String) : IO UInt32 := do
  match ProofFlow.parseArgs args {} with
  | .error e =>
    IO.eprintln s!"{ProofFlow.extractorName}: error: {e}\n{ProofFlow.usage}"
    return (2 : UInt32)
  | .ok cfg =>
    if cfg.help then
      IO.eprintln ProofFlow.usage
      return (0 : UInt32)
    match ProofFlow.validate cfg with
    | .error e =>
      IO.eprintln s!"{ProofFlow.extractorName}: error: {e}\n{ProofFlow.usage}"
      return (2 : UInt32)
    | .ok cfg =>
      try
        ProofFlow.run cfg
      catch e =>
        IO.eprintln s!"{ProofFlow.extractorName}: error: {e}"
        return (1 : UInt32)
