# ProofFlow

**Auditable axiom-to-theorem workflow graphs for Lean 4 projects, with per-node kernel verification.**

ProofFlow reads a built Lean 4 project and draws it as a left-to-right workflow: the axioms the project
rests on sit in the first column (Lean's standard axioms, `sorryAx`, `native_decide` axioms, and any
custom `axiom`), definitions and lemmas fill the middle, and the project's final theorems sit at the
right edge. Every node is coloured by kind and bordered by its transitive trust profile, and every node
has a **Verify** button that exports its dependency closure with `leanexport` and replays it through
Lean's kernel and the independent checkers bundled with the toolchain (`lean4lean`, `nanoda`,
`con-leche`, `con-ron`, `leanchecker-paranoid`).

Status: early development (2026-09). See `docs/ARCHITECTURE.md` for the design and `docs/SURVEY.md` for
how it differs from Lean Atlas, LeanDepViz, lean-graph, leanviz, axiom-audit and gonzalgo.

## Requirements

- A Lean 4 project built with `lake build`. On toolchain `v4.35.0-rc3` or newer every bundled checker
  is available. On older toolchains (≥ 4.28) you still get the graph, the trust profile, and a kernel
  replay of each node's module (`leanchecker <Module>`), but no per-declaration export or external kernels.
- Node.js 22+ and pnpm 10+.

## Measured (2026-09-27, one Windows machine)

| Project | Extract | Verify one theorem, six checkers |
|---|---|---|
| `examples/toy` (288 nodes) | 4 s | 1.4 s |
| `examples/mathlib-demo` (6 local theorems over Mathlib, Lean 4.35.0-rc3) | 15 s | 23 s for `sqrt_two_irrational` (closure of 10 410 declarations, 41 MB export) |
| a 50-module research project over Mathlib (Lean 4.33, 4507 nodes, 144 k edges) | 29 s | module replay only (toolchain has no `leanexport`) |

## Quick start

One-click launchers (they install dependencies and build on first run, then open the web UI):

```
proofflow.cmd  D:\path\to\lean\project        (Windows; double-click for the bundled example)
./proofflow.sh /path/to/lean/project          (Linux, macOS, Git Bash)
```

Manual equivalent:

```bash
pnpm install
pnpm build
pnpm proofflow extract --project path/to/lean/project
pnpm proofflow serve   --project path/to/lean/project --open
```

Try it on the bundled example: `pnpm proofflow serve --project examples/toy --open`.
`examples/mathlib-demo` is a small project over Mathlib (run `lake exe cache get` inside it first).

## Layout

```
lean/Extract.lean      Lean script that writes graph.json (run through `lake env lean --run`)
packages/schema        shared zod schema for graph.json and verification results
packages/server        `proofflow` CLI and local HTTP API (extraction, verification, caching)
packages/web           the viewer (React, xyflow, elk)
examples/toy           small Lean project used as the golden test fixture
docs/                  architecture, verification semantics, checker CLI notes, survey
```

## 中文简介

ProofFlow 把已构建的 Lean 4 工程画成一张从左到右的“证明工作流”图：最左边是这个工程真正依赖的公理
（Lean 三条标准公理、`sorryAx`、`native_decide` 产生的公理、以及用户自己声明的 `axiom`），中间是定义与引理，
最右边是最终定理。每个节点按种类着色，边框按传递信任状态着色（是否碰到 sorry、自定义公理、native_decide、
unsafe/partial 等），并且每个节点都可以点击“验证”：用工具链自带的 `leanexport` 导出该节点的依赖闭包，
再交给 Lean 内核以及独立实现的检查器（`lean4lean`、`nanoda`、`con-leche`、`con-ron`）重新检查。

## License

MIT
