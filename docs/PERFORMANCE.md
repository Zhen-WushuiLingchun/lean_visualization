# Large-project viewer performance (2026-09-27)

The first sections record a Node computation baseline, not a browser frame-rate measurement. They use the real
`YMEYMCompatibility435` graph read-only from the audited project's `.proofflow/graph.json`.
The research graph and machine-specific paths are not included in this repository; supply your own
graph path when reproducing the benchmark procedure.
The file has SHA-256 `b2dd7a3c8b4da1566c037c4eac30f2e730d95ddf928a628429e8bb194a80fb7c`;
its last write time was `2026-09-27T08:57:48Z`. No audited-project files were changed.

Reproduce from the ProofFlow root on Node 22 or newer:

```powershell
node --expose-gc --import tsx packages/web/scripts/benchmark-graph.ts --path '<project>/.proofflow/graph.json' --force-layout
```

The benchmark explicitly tests the first 12 local sinks, all local sinks, and project mode. This
keeps the cases stable if the app's default view policy changes. It invokes `buildIndex`, `buildCone`,
`assignLayers`, `measureAll`, and `fastLayered`; it does not render React Flow or run ELK. Timings are
single-run wall times on Windows 11, Node 26.7.0, with `--expose-gc` between stages. Heap numbers are
process heap snapshots and include live objects from earlier stages, not isolated allocations.

| Stage or view | Nodes | Edges | Time |
|---|---:|---:|---:|
| JSON parse + zod | 12,896 | 597,276 raw | 139 ms |
| `buildIndex` | 12,896 | 601,995 indexed | 833 ms |
| First 12 sinks: `buildCone` | 1,367 | 10,851 | 212 ms |
| First 12 sinks: layers + measure + fast layout | 1,367 | 10,851 | 21 ms |
| All 418 sinks: `buildCone` | 5,191 | 41,626 | 852 ms |
| All sinks: layers + measure + fast layout | 5,191 | 41,626 | 50 ms |
| Project mode: `buildCone` | 5,197 | 41,676 | 870 ms |
| Project mode: layers + measure + fast layout | 5,197 | 41,676 | 46 ms |

The input has 9,212 local declarations and 3,684 external declarations. The indexed edge count exceeds
the raw count because boundary declarations gain implied axiom edges. No synthetic axiom nodes or axiom
incoming edges were present. A digest of each node's id, axiom list, and taint list in file order is
`c69f42e8c06edcc59f7a15853cec469cc3c84e5dc0d97b71b5d392bee6c8d01d`.

`buildIndex` raised observed heap from about 90 MiB to 371 MiB before GC; about 258 MiB remained after
GC. Project cone construction raised the observed heap from about 259 MiB to 384 MiB before GC.
The former `SCALE_LIMIT` of 3,000 prevented both full views from reaching layout in the UI; the
benchmark's `--force-layout` bypasses that guard only inside the script. The 60,276 px project layout
height and 41,676 drawn edges make browser paint, viewport culling, and interaction the next performance
risks to measure. This baseline alone does not establish that the viewer is responsive.

Trust semantics require separate checks during optimization. Hidden auxiliary nodes produce folded
edges; collapsed external packages union their members' taints and axioms. A faster renderer must keep
the 41,676 project edges and the node trust profiles available to the audit UI, even if it draws fewer
elements in the current viewport. Graph serialization should preserve the original graph's trust data,
not infer it from visible edges.

## Worker wire parity

Run the same script with `--parity`. It builds both a full dependency index and a metadata-only index,
then checks `buildCone → toWireView → structuredClone → fromWireView` on the default project view and
on the fully expanded project view (`hideAux: false`, external `expand`). The digest covers ordered node
IDs and display fields, original declaration axioms/taints/flags, every edge with its site and folded
flag, targets, closure IDs, counts, layers, node sizes, and positions. The reconstructed Graphology
node and edge counts also agree; every declaration refers back to the original metadata node. The
input graph trust digest remains unchanged.

On the same real file both cases passed. The default project view had 5,197 nodes, 41,676 edges, and
1,241 folded edges; its wire clone took 49 ms and `fromWireView` took 62 ms. The expanded view had
12,896 nodes and 601,995 edges; its wire clone took 550 ms and `fromWireView` took 953 ms. The
metadata-only index took 6 ms versus 845 ms for the full index. Cloning the source graph for worker
initialization took 158 ms. These are Node measurements; browser structured-clone and rendering costs
may differ. The expanded reconstruction briefly raised observed main-process heap to about 841 MiB.

## CSR adjacency revision

The previous paragraph records the Graphology reconstruction baseline. After replacing the displayed
cone's Graphology object with compact CSR adjacency, both `--force-layout` and `--parity` passed again
on the same SHA-256 input. The ordered view digests stayed exactly the same in default and expanded
project modes. In the expanded case the script also rebuilt the former Graphology view from all
601,995 visible edges and compared every node's ordered incoming and outgoing neighbor lists to CSR;
all 12,896 nodes matched.

On one post-change `--parity` run, default project `fromWireView` took 18 ms, down from 41–62 ms in
the earlier Graphology runs. Expanded `fromWireView` took 163 ms, down from 930–953 ms. The expanded
view's observed heap after reconstruction was 507 MiB, down from about 840 MiB; the heap before
reconstruction was also lower (487 versus 631 MiB). Expanded `buildCone` took 1.1 s in this run,
versus 1.9–2.1 s before CSR, while the separate `--force-layout` run took 1.1 s. Single-run timings
vary and include GC behavior, so these are directional results rather than controlled speedup ratios.
The source graph trust digest remains `c69f42e8c06edcc59f7a15853cec469cc3c84e5dc0d97b71b5d392bee6c8d01d`.

The worker persists across view changes after a completed request: `prepare` removes its abort listener
in `finally`, so the previous view's effect cleanup cannot stop that worker. A change while preparation
is still pending aborts the request and terminates the worker; the next request then clones the source
graph and rebuilds its dependency index. The source graph clone measured 143 ms in the CSR run, while
full index construction measured 846 ms. These costs apply to initialization and interrupted requests,
not every view change.

## Browser verification of the final renderer

Real Chromium on Windows, a 1440 by 1000 viewport, the production Vite build, and the exact graph
above were exercised using `packages/web/scripts/browser-large-view.cjs`. The local toy server
provided application assets; the harness substituted the actual project graph for `/api/graph` and
returned empty read-only verification cache responses. No user-project verification was triggered.

Reproduce with an existing Playwright installation and Chromium binary (neither is an app dependency):

```powershell
node packages/web/scripts/browser-large-view.cjs '<graph.json>' '<playwright-module-directory>' '<chromium.exe>' 'http://127.0.0.1:4871' '.proofflow/browser'
```

Before the change, choosing Whole project displayed `This cone has 5197 nodes` and rejected layout.
After the change, single-run browser observations were:

| Observation | Result |
|---|---:|
| Default whole-project map | 5,197 nodes, 41,676 edges retained |
| First map display | 2.5 to 3.3 s across runs |
| Overview DOM elements | 892 |
| Overview HTML detail cards / cache requests | 0 / 0 |
| Main-thread retained JavaScript heap after GC | about 55 MiB |
| Cards mounted after locating a theorem | 13 (limit 80) |
| Fully expanded view | all 12,896 nodes, 601,995 edges retained |
| Switching to fully expanded view | about 2.8 s |
| All 601,995 edges drawn, with cooperative frame work | about 4.0 s |
| Cancelling that optional drawing | 147 ms |
| Main-thread long tasks during optional all-edge drawing | 0 observed above 50 ms |
| Browser JavaScript errors | 0 |

The main-thread heap excludes the Worker, DOM, Canvas/GPU storage and other browser processes; it is
not total application memory. Initial loading and expanded-view preparation still produced a roughly
354 ms maximum long task in the final run. These observations are not a universal frame-rate or
memory guarantee. All-edge rasterization still costs work; simplified drawing remains the default.
The all-edge mode draws in cancellable batches and reports `Drawing all edges...` until complete.
It schedules no drawing frames when the view is static and complete.

Browser checks also covered search without leaving project mode, original HTML card text remaining
visible above the Canvas, pan, fit, all-edge toggling and cancellation, and the dark theme. Screenshots
and raw measurements are written under `.proofflow/browser/` and kept local. Graph simplification does
not alter the original declaration details or the dependency arrays supplied to verification.

## Verification boundaries and regression checks

- `pnpm build` and `pnpm test` passed: schema 13, server 194, web 120 tests (integration is opt-in).
- `PROOFFLOW_INTEGRATION=1 pnpm --filter @proofflow/server test` passed: 196 tests, including golden
  extraction equality and a real six-checker run; one disabled-mode placeholder is skipped.
- Real toy extraction and serving completed. `Toy.cleanMain` was accepted by all six export checkers.
- A separate real browser run drove `Toy.everything` verification through the API: four export
  kernels accepted, con-leche and con-ron declined, and the node badge was the grey dash.
- `packages/server`, `packages/schema`, `lean`, examples and dependency lockfile have no source diff.
  The audited project graph retains the SHA-256 recorded above. No checker verdict, trust
  classification, backend cache binding, graph schema or user proof source was changed.
