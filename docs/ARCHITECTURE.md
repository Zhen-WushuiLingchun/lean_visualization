# ProofFlow architecture

## 1. Components and data flow

```
 audited Lean project (built with lake)
        │
        │  lake env lean --run lean/Extract.lean -- --root <Root> --out .proofflow/graph.json [...]
        ▼
 graph.json  (packages/schema: GraphFile)          ← the only Lean ↔ TypeScript interface
        │
        │  read + zod-validate
        ▼
 @proofflow/server  (Node, Hono)  ── /api/graph, /api/source, /api/verify, /api/jobs, /api/checkers
        │                             │
        │ static files                │ spawn: lake env leanexport <Root> -- <decl>
        ▼                             │        lake env leanchecker --from-export …
 @proofflow/web  (Vite/React)         │        con-leche/con-ron/nanoda_bin/lean4lean/leanchecker-paranoid
   workflow DAG (xyflow + elk)        ▼
   node panel, verify buttons     .proofflow/cache/<decl>/<exportHash>.json
```

Three processes, one file format. The Lean side never knows about the web; the web never knows about
Lean. The server is the only piece that spawns subprocesses.

## 2. Extractor (`lean/Extract.lean`)

A single Lean file with `main : List String → IO UInt32`, run as
`lake env lean --run lean/Extract.lean -- <args>` from the project root. It has no static import of
the audited project: the roots given on the command line are loaded at run time with
`importModules`, so the same file works for any project without a Lake dependency.

Steps:
1. `initSearchPath (← findSysroot)`; `importModules` the roots; obtain `env`.
2. Decide which modules are **local**: module names whose first component is one of `--root` names
   (or `--local-prefix` overrides). Everything else is external.
3. Walk every constant of `env` once. Build `deps.stmt = getUsedConstants(type)`,
   `deps.proof = getUsedConstants(value? (allowOpaque := true))`.
4. One shared-cache DFS over the whole environment computing, per constant, the transitive axiom set
   and the transitive flag taints (`unsafe`, `partial`, `extern`, `implementedBy`). Memoised in a
   `HashMap Name (Array Name × TaintBits)`; iterative, not recursive, to survive Mathlib-depth chains.
5. Emit nodes for every local constant plus every external constant referenced directly by a local one
   (boundary). With `--expand-external` emit the entire transitive closure instead.
6. Per node: kind/subkind, module, `package` (first module component, or the library name for local),
   source range via `findDeclarationRanges?`, docstring via `findDocString?`, pretty-printed statement
   via `ppExpr` under `MetaM` (truncated to `--statement-max-chars`, default 2000), flags from attributes
   (`Lean.Compiler.implementedByAttr`, `externAttr`, `isNoncomputable`, `isInstance`, `isPrivateName`,
   `isProtected`, `isUnsafe`, `partial` is detected via the `_unsafe_rec` companion or `DefinitionSafety.partial`).
7. `isAux`: companions of inductives and definitions (`.rec`, `.recOn`, `.casesOn`, `.brecOn`,
   `.below`, `.noConfusion`, `.noConfusionType`, `.sizeOf_spec`, `.eq_<n>`, `.eq_def`, `.match_<n>`,
   `.proof_<n>`, `.injEq`, `.inj`, `._unsafe_rec`, `.ctorElim`, `.elim`, `.splitter`, hygienic `_hyg`
   names, …) matched by parent kind plus prefix rules. A hand-written `private def` is *not* aux. Aux
   nodes are emitted (they carry real dependencies) but the viewer hides them by default and folds their
   edges through.
8. Flag taints do not propagate out of core packages by default (see AGENTS.md §2, `--core-flag-taints`).
   `@[implemented_by]` and `partial` add implementation edges that carry flag taints only, never axioms.
9. Every axiom reachable from a local node is emitted as a node even in default mode, so `graph.json` is
   self-contained and the viewer's column 0 needs no synthetic nodes.
8. Write `graph.json` with `Lean.Json` (streamed with a handle, not built as one giant `Json` value).

Performance target: a project of 5k local declarations over Mathlib in under 60 s including import.
Full-closure mode over Mathlib is out of scope for v1 (leanviz/gonzalgo already cover it).

## 3. Server (`packages/server`)

- `proofflow extract [--project DIR] [--root Name]... [--expand-external] [--no-build]`
  Runs `lake build` (unless `--no-build`), materialises the script, runs it, validates the output.
- `proofflow serve [--project DIR] [--port 4870] [--host 127.0.0.1] [--open]` serves the built web app and the API.
- `proofflow verify <decl> [--checkers a,b,c]` runs the verification pipeline from the CLI and prints the
  `VerifyResult` as JSON (usable in CI).
- `proofflow checkers` lists which checkers exist in the active toolchain.

API (all JSON):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/graph` | validated `GraphFile` |
| GET | `/api/source?decl=` | `{ file, line, endLine, text }` snippet of the declaration (local only) |
| GET | `/api/checkers` | `CheckerInfo[]` (availability + version) |
| POST | `/api/verify` | body `{ decl, checkers?: CheckerName[] \| "all", force?: boolean }` → `{ jobId }` (202; 409 when no graph yet) |
| GET | `/api/jobs` | list of jobs |
| GET | `/api/jobs/:id` | `Job` (status, log tail, result) |
| GET | `/api/jobs/:id/events` | Server-Sent Events stream of log lines and the final result |
| GET | `/api/results?decl=` | cached `VerifyResult[]` for a declaration |
| POST | `/api/extract` | re-run extraction; SSE progress on `/api/jobs/:id/events` |

Verification pipeline for one declaration:
1. Resolve which root module to export from (the node's module).
2. `lake env leanexport <Module> -- <decl>` → `.proofflow/export/<slug>.ndjson` where `<slug>` is an
   ASCII-safe form of the name plus a short hash; sha256 of the stream → `exportHash`. An export is
   reused only when it is newer than `graph.json`. If cached results for `(decl, exportHash)` cover
   the requested checkers with `accepted`/`rejected`/`declined` and `force` is false, return them.
3. Run requested checkers concurrently (default concurrency 2), each with a timeout (default 600 s),
   capturing stdout/stderr tails (last 4 KB). Exact commands are in `docs/CHECKERS.md`.
4. Persist `VerifyResult` to `.proofflow/cache/<slug>/<exportHash>.json` (merging checker results
   for the same hash) and return it.

One job queue: extraction is exclusive (it rebuilds the `.olean`s that exports read), verification
runs two at a time. Jobs survive only in memory; results survive on disk.

SSE contract for `/api/jobs/:id/events`: `event: log` with one raw line, `event: done` with the `Job`
JSON after which the stream closes, a `: ping` comment every 15 s; a finished job replays its log.

## 4. Web viewer (`packages/web`)

Stack: Vite, React 19, TypeScript, `@xyflow/react` (React Flow 12), `elkjs` for layered layout,
`graphology` for dependency indexing in a worker, and compact read-only CSR adjacency for displayed cones.

Views:
- **Cone view (default for small graphs).** Pick one or more target declarations (search box; defaults to the local
  sinks, i.e. local nodes nothing local depends on). Show the backward closure within the loaded graph.
  Layout: ELK `layered`, direction `RIGHT`, with `partitioning` enabled and each node's partition equal
  to its longest-path distance from the cone's sources, so axioms sit in column 0 and targets in the last
  column regardless of ELK's own layering choices. Edges drawn source→target (dependency → dependent).
- **Whole-project view (default above 600 local declarations).** Same layout over all local nodes with external nodes collapsed into one
  node per external package (`Mathlib`, `Init`, …) that carries the union of their taints.
- **Node panel.** Full statement, docstring, source snippet (fetched lazily), direct dependencies split
  into statement/proof, transitive axioms, taints, and the verification table (one row per checker with
  status, time, and a log toggle). Buttons: `Verify (kernel)` = L1 only, `Verify (all checkers)` = L1+L2,
  `Verify cone` = topological order over the displayed cone with cached results reused.
- **Verify all (toolbar, server mode).** Queues every real declaration in the loaded graph file,
  including auxiliary and external declarations regardless of display filters. Options limit the
  queue to local declarations or request kernel-only checking; the default requests all available
  checkers. Uses a rolling window of 2 in-flight declarations by default (selectable 1, 2, or 4)
  through the existing per-declaration API. The server still limits execution to 2 jobs by default;
  a larger browser window can queue requests but does not raise the server's limit. Each request lets the server
  validate cache bindings; browser badges never skip a request. Progress distinguishes accepted,
  rejected, errors and incomplete results. Stop prevents further submissions and waits for already
  submitted jobs to finish. Keep the page open while running; restarting submits the scope again and the server can
  reuse valid cached results. Full closure exports still take time and disk space on large projects.
- **Filters.** Edge site (statement / proof / both), hide aux, hide external, taint filter, kind filter,
  depth limit from targets.
- **Export.** Download the displayed cone as JSON and PNG (xyflow's `toPng` via `html-to-image` is not
  allowed by AGENTS.md dependency policy; use the SVG serialisation of the viewport instead).

Visual language (must be consistent, and must keep contrast in light and dark themes):

| Element | Encoding |
|---|---|
| Node header colour | kind: axiom-standard slate, axiom-sorry orange, axiom-native purple, axiom-custom red, theorem blue, definition teal, opaque brown, inductive/structure amber, constructor/recursor pale amber, instance pale teal, quot slate |
| Node border | worst transitive taint: none = green, nativeDecide = purple, customAxiom = red, sorry = orange, unsafe/partial/extern/implementedBy = grey dashed |
| Verification badge (top-right) | none, spinner, green check (all requested accepted), red cross (any rejected), amber bang (error/timeout), grey dash (unavailable) |
| Edge style | statement = solid, proof = dashed, both = solid thick; colour inherits the source node's kind colour at 60 % |
| External node | muted fill, italic name, package tag |
| Aux node | 70 % scale, hidden by default |

Large graphs are no longer rejected at 3000 nodes or silently narrowed to twelve final theorems.
The main thread builds only declaration metadata; a persistent Web Worker builds dependency indexes,
cones, layers, measurements and layout. Initialization and each request have 60-second timeouts;
cancelled computations terminate their worker, and completed views have a two-entry worker cache.
Large files require Worker support; unsupported environments report a visible error rather than
attempting a blocking large computation. The small-file fallback remains available.

Above 1500 displayed nodes or 10000 displayed edges, the viewer uses a Canvas overview with the same
React Flow camera and existing node detail components. It retains every view node and edge, draws
lightweight nodes at overview scale, names at intermediate scale, and at most 80 HTML cards at reading
scale. A spatial grid culls offscreen nodes; a lightweight minimap retains full-project navigation.
Default edge drawing is explicitly labelled simplified; an all-edge mode draws in cancellable frame
batches and reports progress until complete. Selected and
hovered incident edges bypass simplification. Full trust profiles, external boundaries, exports, and
the dependency closures used by verification are independent of the drawing budget. No graph schema,
server verification or checker behavior changes are involved.

Project-mode search locates a visible declaration without rebuilding the map. Shift+Enter or a hidden
declaration opens its cone. To show every declaration already present in the file, disable Hide aux
and choose External: Expand. This cannot expand dependencies that the extractor never emitted.
See `docs/PERFORMANCE.md` for measured scope and resource limitations.

## 5. Schema (`packages/schema`)

`GraphFile` (what the extractor writes), `VerifyResult`, `Job`, `CheckerInfo`, and helper functions
(`edgesOf(graph)`, `worstTaint(taints)`, `isStandardAxiom(name)`). Zod is the source of truth; TS types
are inferred from it. The package has no runtime dependency other than zod and is consumed by both the
server and the web app.

## 6. Development workflow

```
pnpm install
pnpm build                      # schema → server → web
pnpm test                       # vitest in every package
pnpm proofflow extract --project examples/toy
pnpm proofflow serve  --project examples/toy --open
```

`examples/toy` is a Lean project on `leanprover/lean4:v4.35.0-rc3` with no Mathlib dependency so CI can
build it in seconds. It contains every trust case (custom axiom, sorry, native_decide, unsafe, partial,
extern/implemented_by, opaque, inductive, structure, instance, a clean chain of lemmas, and a final
theorem that transitively touches everything). `examples/toy/expected/graph.json` is the golden output.

## 7. Roadmap after v1

- Lazy expansion of external nodes (`/api/expand?decl=` runs the extractor in slice mode).
- Diff mode: two `graph.json` files, highlight nodes whose statement or trust profile changed.
- `proofflow report` producing a static HTML audit report for a set of targets (CI artefact).
- Optional Lake facet so `lake exe proofflow` works for users who prefer that.
