# Large project viewer implementation plan

**Goal:** Browse the complete local project without a 3000-node rejection, retaining ProofFlow's existing visual style and audit semantics.

**Architecture:** Keep the current detail components and small-graph renderer. Large graphs use a cancellable worker for view preparation and a canvas overview with semantic zoom, bounded HTML detail cards, and explicit edge simplification. The original graph and view dependencies remain available to search, details, exports, and verification.

**Tech stack:** Existing React, React Flow, TypeScript, Graphology, browser Canvas and Web Workers. No new runtime dependencies.

## Non-negotiable boundaries

- Do not change `packages/server`, `packages/schema`, `lean`, the graph contract, checker invocation, cache provenance, verification verdicts, or trust classification.
- Preserve the existing toolbar, sidebar, detailed node cards, trust labels, and verification panel.
- Visual culling and simplified edges must not change the graph used for audit or verification. Clearly identify simplified rendering; provide all-edge rendering and exact selected incident edges.
- No automatic green/accepted status for unread verification results. Preserve external dependency boundary markers.
- Do not rewrite or extract the user's audited project; use its existing graph read-only for performance checks.

## Task 1: Background view preparation

Files: `packages/web/src/App.tsx`, `src/graph/*worker*`, pipeline helpers, `src/state/initialView.ts`, `src/state/appState.tsx`, corresponding tests.

- Remove the hard node rejection and default large projects to all local declarations.
- Keep auxiliary and external visibility controls explicit; stop silently selecting only twelve sinks.
- Prepare exact cones, layers, sizes and fast layout off the UI thread. Bound cancellation, timeout and retained views.
- Keep stale results from replacing newer requests or changing the verification scope.
- Test serialization parity, full local coverage, cancellation and failure behavior.

## Task 2: Scalable rendering

Files: `packages/web/src/components/GraphCanvas.tsx`, new canvas/spatial helpers and tests, additive styles only.

- Keep React Flow camera controls and the existing small view.
- Use lightweight canvas nodes at overview scale, labels at intermediate scale and the existing cards at reading scale.
- Draw canvas edges with an explicit simplified/all toggle, without changing cone edges.
- Use spatial queries, bounded hover caching and event-driven redraws. Do not auto-fetch verification for overview dots.
- Test hit testing, viewport geometry and detail budgets. Check all-node fit and selection navigation.

## Task 3: Integration and evidence

Files: search interaction in `Toolbar.tsx`, reusable frontend benchmark script and performance documentation.

- Search selects and locates a declaration in project mode; hidden declarations can open their exact cone.
- Compare old and new graph preparation outputs and trust data on the user's real graph when available.
- Run `pnpm build`, `pnpm test`, real toy extraction and serve. Exercise browser selection, zoom, all edges, trust details and verification without changing backend behavior.
- Record actual timing, node/edge counts, DOM count and memory where measurable. Distinguish CPU-only benchmarks from browser evidence; do not promise performance for untested sizes.

## Delegation

GPT-6 Sol agents have disjoint production ownership: background pipeline; canvas renderer. A third Sol agent measures data and audits performance risks. The lead owns integration, review and final verification. All agents must honor the boundaries above; no external publication or commits are requested.
