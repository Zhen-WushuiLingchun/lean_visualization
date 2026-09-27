# What ProofFlow verification does and does not prove

## L0: trust profile (always available)

Computed by the extractor from the compiled environment, transitively over `ConstantInfo.getUsedConstants`
of both the type and the value (`allowOpaque := true`).

- `axioms`: every axiom constant reachable from the declaration. Lean's standard three are `propext`,
  `Classical.choice`, `Quot.sound`. `sorryAx` means an unfinished proof somewhere below. `Lean.ofReduceBool`
  and `Lean.ofReduceNat` mean a `native_decide` / `decide +native` step trusted the compiler.
  Anything else is a **custom axiom** and is shown red.
- `taints` (transitive): `sorry`, `nativeDecide`, `customAxiom`, `unsafe`, `partial`, `extern`,
  `implementedBy`. The last four are flags of definitions, not axioms; they are propagated so that a
  theorem whose *statement* mentions a `partial def` is visibly resting on an opaque implementation.
- What L0 does **not** prove: that the statement means what you think (semantic review), or that the
  `.olean` was produced by an honest kernel (environment hacking).

## L1: kernel replay of the closure

`lake env leanexport <Root> -- <decl>` writes the declaration and its transitive closure in the NDJSON
export format. `lake env leanchecker --from-export <file>` replays it into a fresh environment with Lean's
own C++ kernel. Accept means every constant in the closure typechecks from scratch. This catches
metaprogram-level tampering with the environment but shares the kernel with Lean itself.

## L2: independent kernels

The same NDJSON is fed to `lean4lean` (a typechecker written in Lean, connected to a verified model),
`nanoda_bin` (Rust), `con-leche` and `con-ron` (bundled independent checkers), and
`leanchecker-paranoid` (the official kernel with extra checks). Each returns accept/reject. Agreement of
several unrelated implementations is the strongest evidence available today that a proof is a proof of
the exported statement. Disagreement is reported as such and never averaged.

## What an `accepted` verdict means (tightened 2026-09-27 after an external audit)

A `VerifyResult.verdict` of `accepted` requires all of the following; anything less is `partial`,
`error` or `rejected`:

1. a fresh or **bound** export: the NDJSON was produced from the module's current `.olean`
   (sha256 recorded in `binding.oleanSha256`) on the recorded toolchain; a cached export is reused only
   when both still match, never on file timestamps alone;
2. the requested declaration is present in that export (`exportAudit.targetFound`), with its record
   kind and a canonical hash of its type (`exportAudit.targetTypeSha256`) so the statement that was
   checked can be pinned and compared later;
3. the exact set of axiom names in the export is recorded (`exportAudit.axioms`) and
   `standardAxiomsOnly` says whether it is within `{propext, Classical.choice, Quot.sound}`; this is
   computed from the export, independently of `graph.json`;
4. at least one L1 kernel replay (`leanchecker` on the export, or `leanchecker-module`) accepted, and
   every other requested checker accepted; each checker result carries the sha256 of the binary that
   produced it and is reused from the cache only for the same binary;
5. no checker crash is counted as a mathematical rejection: nanoda's exit 101 is `rejected` only with
   recognised typechecking failure text, otherwise `error`.

`--checkers all` means "every checker available in this toolchain". For a claimed six-checker run,
request the six export-based names explicitly and read the six per-checker rows; the verdict alone is
not a substitute. Timeouts can be disabled with `--checker-timeout 0` / `--export-timeout 0`.

## What no level proves

- That the *exported statement* is the statement you care about. Read it in the node panel.
- Anything about `unsafe` / `partial` / `@[extern]` / `@[implemented_by]` bodies: the kernel does not see them.
- That a custom `axiom` is consistent. It is shown red for that reason.
