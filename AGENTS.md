# AGENTS.md — ProofFlow

Guidance for every agent (human or AI) working in this repository. Read fully before editing.
The architecture is in `docs/ARCHITECTURE.md`; the related-work decision is in `docs/SURVEY.md`.

## 1. What ProofFlow is

ProofFlow turns a built Lean 4 project into an **auditable proof workflow**: a left-to-right DAG whose
sources are the axioms a project rests on (Lean's three standard axioms, `sorryAx`, `Lean.ofReduceBool`
from `native_decide`, and any user-declared `axiom`), whose interior is definitions and lemmas, and whose
sinks are the project's final theorems. Every node carries its full transitive **trust profile** (axioms,
sorry, native_decide, unsafe/partial/extern) and can be **re-verified in-app** by exporting its
dependency closure with `leanexport` and replaying it through the official kernel and the independent
kernels bundled with the toolchain (`lean4lean`, `nanoda`, `con-leche`, `con-ron`, `leanchecker-paranoid`).

The audience is someone auditing a formalization (their own, a collaborator's, or an AI-generated one):
"what does this theorem really rest on, and does an independent checker agree?"

### Non-goals (v1)
- Tactic-level proof trees inside a single proof (Paperproof does this).
- Semantic review workflow / confidence attributes (Lean Atlas does this).
- Hosting all of Mathlib as a browsable site (keithadler/leanviz does this).
- Editing Lean code. ProofFlow is read-only over `.olean` files plus source display.

## 2. Ground truth about the toolchain (verified 2026-09-27 on Windows 11)

- Toolchain used for development and the example project: `leanprover/lean4:v4.35.0-rc3`
  (Mathlib master is on the same version). Installed via `elan`; `~/.elan/bin` must be on PATH.
- Binaries bundled in that toolchain's `bin/`: `lean`, `lake`, `leanexport` (the former `lean4export`,
  NDJSON export format 3.1.0), `leanchecker` (kernel replay; `--fresh`, `--from-export <file.ndjson>`),
  `leanchecker-paranoid`, `lean4lean`, `nanoda_bin`, `con-leche`, `con-ron`.
  Exact CLI usage of each checker is recorded in `docs/CHECKERS.md`. Read it; do not guess flags.
- `lake check` (v4.35+) builds, exports, replays through the kernel and fails on non-standard axioms;
  `lake check --paranoid` also runs every bundled external checker. ProofFlow's per-node verification is
  the per-declaration analogue of this.
- Since v4.32, `ConstantInfo.value?` on theorems returns `none` unless called as
  `ci.value? (allowOpaque := true)`. Always use `allowOpaque := true` when collecting proof dependencies.
- `Lean.collectAxioms` is correct but slow when called per declaration (rebuilds its cache each call).
  The extractor must do one shared-cache traversal (see `leanprover-community/axiom-audit`).
  `collectAxiomsMany` (lean4 PR #14157) is not merged; do not depend on it.
- Known core bug: `#print axioms` may under-report axioms of imported inductives in some versions
  (lean4 issue #15226). Our own traversal walks `ConstantInfo.getUsedConstantsAsSet` directly and is not
  affected, but keep a regression test for an inductive that reaches a custom axiom through an import.
- `leanexport <Module> -- <decl>` exports only that declaration and its transitive closure (verified:
  183 lines for a trivial theorem, 1 s). `leanchecker --from-export file.ndjson` prints
  `Lean default kernel accepts the solution` and exits 0 on success (verified, 0.2 s).
- `lake env <cmd>` runs `<cmd>` with `LEAN_PATH` set so the project's `.olean`s and the toolchain
  binaries are found. Every Lean-side invocation from the server goes through `lake env`.
- Lean scripts are executed as `lake env lean --run <file.lean> -- <args>`; `main : List String → IO Unit`
  receives `<args>` (verified). The script must `initSearchPath (← findSysroot)` and then
  `importModules #[{module := `Root}] {} 0` to obtain the environment.
- Windows paths: prefer forward slashes internally; quote every path passed to a subprocess; never rely
  on a POSIX shell. Node `child_process.spawn` with an args array, `shell: false`.

## 3. Repository layout

```
AGENTS.md                 this file
README.md                 user-facing intro (EN + ZH summary)
docs/SURVEY.md            related tools and why ProofFlow exists
docs/ARCHITECTURE.md      components, data flow, API, layout, scale strategy
docs/CHECKERS.md          verified CLI usage of leanexport/leanchecker/lean4lean/nanoda/con-leche/con-ron
docs/VERIFICATION.md      what each verification level proves and does not prove
lean/Extract.lean         extractor script (no Lake dependency for users; run via `lake env lean --run`)
lean/README.md
examples/toy/             small Lean project exercising every trust case; golden test fixture
packages/schema/          @proofflow/schema — zod schemas + TS types for graph.json and verify results
packages/server/          @proofflow/server — CLI (`proofflow`), Hono HTTP API, extraction + verification
packages/web/             @proofflow/web — Vite + React + @xyflow/react + elkjs viewer
```

Package manager: `pnpm` (workspace). Node ≥ 22. TypeScript strict, ESM only, `"type": "module"`.

## 4. Contracts every package must respect

1. **`graph.json` is the only interface between Lean and TypeScript.** Its shape is defined once in
   `packages/schema/src/graph.ts`. The extractor writes it; the server validates it with zod before serving;
   the web app types against it. Never add a field on one side without adding it to the schema first.
2. **Edge direction is dependency → dependent.** `source` is the thing used, `target` is the thing that
   uses it. Axioms have no incoming edges. Final theorems have no outgoing edges (within the project).
   This is the workflow reading order (left → right) and it is fixed.
3. **Node id = fully qualified Lean name** as printed by `Name.toString` (with «» escaping when needed).
4. **Trust profile is computed in the extractor, transitively, once.** `axioms` is the complete transitive
   axiom set. `taints` is derived (see schema) and is also transitive. The web app must not recompute
   transitive closures over the full graph; it may compute them over the currently displayed cone.
5. **Verification results are per (declaration, exportHash)** and cached under `.proofflow/cache/` in
   the audited project. A result for one checker never implies another checker's result.
6. **Local vs external.** Declarations whose module belongs to the audited project's own libraries are
   `isLocal: true` and fully expanded. External declarations directly referenced by local ones are emitted
   as boundary nodes with their own trust profile but `depsComplete: false` unless `--expand-external`.

## 5. Verification levels (the "can this node be verified by its predecessors" feature)

| Level | Name | What runs | What it proves |
|---|---|---|---|
| L0 | Trust profile | nothing (from graph.json) | which axioms/sorry/native_decide/unsafe the node transitively rests on |
| L1 | Kernel replay | `leanexport Root -- decl` → `leanchecker --from-export` | the node and its whole closure re-typecheck in a fresh environment with Lean's own kernel (catches environment hacking) |
| L2 | Independent kernels | same export → `lean4lean`, `nanoda_bin`, `con-leche`, `con-ron`, `leanchecker-paranoid` | independent implementations agree; disagreement is a finding, not noise |

A node is shown **green** only when L1 is accepted and every *requested* L2 checker accepted. L0 taints are
displayed regardless (a `sorry`-tainted theorem can still be kernel-accepted; that is exactly what the
audience needs to see).

## 6. Working rules

- Run the real pipeline on `examples/toy` before claiming anything works:
  `pnpm build && pnpm proofflow extract --project examples/toy` then `pnpm proofflow serve --project examples/toy`.
- Tests: `pnpm test` at the root runs every package's vitest suite. Lean-side golden tests live in
  `packages/server/test/` and compare extractor output on `examples/toy` against `examples/toy/expected/`.
  If you change extractor output intentionally, regenerate goldens and explain why in the commit.
- Never mark a checker as "accepted" on a non-zero exit code. Unknown exit codes are `error`, not `rejected`.
- Long subprocesses (extraction, checkers) must have timeouts and must stream logs; the UI must never hang.
- Do not add dependencies casually. Allowed: `zod`, `hono`, `@hono/node-server`, `commander`,
  `child_process` (built-in), `@xyflow/react`, `elkjs`, `graphology` (+`graphology-dag`,
  `graphology-types`), `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `vitest`, `jsdom`,
  `@testing-library/react`, `typescript`, `tsx`, `@types/*`. Anything else needs a one-line
  justification in the commit message. The root `pnpm-lock.yaml` is shared: add a dependency by
  editing the package's `package.json` and running `pnpm install` from the repo root once.
- Ports: the server listens on `4870` by default; the Vite dev server on `5173` proxies `/api` to it.
- Line endings are LF everywhere (`.gitattributes` enforces it).
- Keep Lean code dependency-free (only `import Lean` plus the audited project's root). It must compile on
  any toolchain ≥ v4.28; if you use an API introduced later, guard it or document the floor bump.
- Style: no em-dashes in user-facing UI strings; short sentences; English identifiers and comments.
- Commit messages: imperative subject ≤ 72 chars, body explains why. Sign as instructed by the harness.

## 7. Ownership map (initial build, 2026-09-27)

| Area | Owner | Deliverable |
|---|---|---|
| Contracts, survey, architecture, audit | lead (Claude Fable 5.1) | `AGENTS.md`, `docs/*`, `packages/schema` |
| Lean extractor + toy project + goldens | subagent A (Opus 5.5) | `lean/Extract.lean`, `examples/toy`, `examples/toy/expected/graph.json` |
| Server, CLI, verification orchestration | subagent B (Opus 5.5) | `packages/server` |
| Web viewer | subagent C (Opus 5.5) | `packages/web` |

The lead audits every deliverable against sections 4 and 5 before it is merged.
