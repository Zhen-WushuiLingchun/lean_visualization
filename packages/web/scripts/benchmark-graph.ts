/** Run: node --expose-gc --import tsx packages/web/scripts/benchmark-graph.ts --path <graph.json> */
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import Graph from "graphology";
import { GraphFileSchema, edgesOf, type GraphFile } from "@proofflow/schema";
import { buildIndex } from "../src/graph/graphIndex";
import { buildCone, type Cone, type ConeOptions } from "../src/graph/cone";
import { assignLayers } from "../src/graph/layers";
import { measureAll } from "../src/graph/measure";
import { fastLayered } from "../src/graph/fastLayout";
import { DEFAULT_OPTIONS } from "../src/state/appState";
import { fromWireView, toWireView, type PreparedView } from "../src/graph/viewPipeline";

const args = process.argv.slice(2);
const path = args[args.indexOf("--path") + 1];
if (!path || args.indexOf("--path") < 0) {
  console.error("Usage: node --expose-gc --import tsx packages/web/scripts/benchmark-graph.ts --path <graph.json> [--target <id>]");
  process.exit(2);
}
const target = args.includes("--target") ? args[args.indexOf("--target") + 1] : undefined;
const forceLayout = args.includes("--force-layout");
// Historical baseline threshold only; the viewer no longer imposes this node limit.
const SCALE_LIMIT = 3000;
const parity = args.includes("--parity");
const mb = (bytes: number): number => Math.round((bytes / 2 ** 20) * 10) / 10;
const heap = (): number => mb(process.memoryUsage().heapUsed);
const gc = (): void => { global.gc?.(); };
const timed = <T>(name: string, f: () => T): T => {
  gc();
  const before = heap();
  const start = performance.now();
  const value = f();
  console.log(JSON.stringify({ stage: name, ms: Math.round((performance.now() - start) * 10) / 10, heapBeforeMiB: before, heapAfterMiB: heap() }));
  return value;
};
const raw = timed("read", () => readFileSync(path));
const fileHash = createHash("sha256").update(raw).digest("hex");
const file = timed("parse+schema", () => GraphFileSchema.parse(JSON.parse(raw.toString("utf8"))) as GraphFile);
const trustHash = createHash("sha256");
for (const n of file.nodes) trustHash.update(`${n.id}\0${n.axioms.join("\0")}\0${n.taints.join("\0")}\n`);
const expectedTrustHash = trustHash.digest("hex");
const rawEdges = timed("edgesOf", () => edgesOf(file));
console.log(JSON.stringify({ fileSha256: fileHash, bytes: raw.length, nodes: file.nodes.length, local: file.nodes.filter((n) => n.isLocal).length, edges: rawEdges.length, trustSha256: expectedTrustHash, localSinks: file.stats.localSinks.length }));
const index = timed("buildIndex", () => buildIndex(file));
console.log(JSON.stringify({ indexedNodes: index.graph.order, indexedEdges: index.graph.size, synthetic: index.synthetic.size, droppedAxiomInEdges: index.droppedAxiomInEdges }));
const metadata = timed("buildIndex:metadataOnly", () => buildIndex(file, { metadataOnly: true }));
assert.equal(metadata.dependenciesLoaded, false);
assert.equal(metadata.graph.order, 0);
assert.equal(metadata.graph.size, 0);
assert.deepEqual(metadata.localSinks, index.localSinks);
assert.deepEqual(metadata.searchIds, index.searchIds);
assert.equal(metadata.byId.size, index.byId.size);
// Explicit scenarios keep runs comparable when the app's initial view policy changes.
console.log(JSON.stringify({ localSinks: index.localSinks.length, headTargets: Math.min(12, index.localSinks.length) }));

function digestView(view: PreparedView): string {
  const h = createHash("sha256");
  const add = (value: unknown): void => { h.update(JSON.stringify(value)); h.update("\n"); };
  for (const n of view.cone.nodes) {
    const { decl, ...display } = n;
    add(display);
    // Check the node's full original trust metadata, not only display taint labels.
    add(decl && { id: decl.id, axioms: decl.axioms, taints: decl.taints, flags: decl.flags, depsComplete: decl.depsComplete });
  }
  for (const e of view.cone.edges) add(e);
  add(view.cone.targets);
  add(view.cone.closureIds);
  add(view.cone.missingTargets);
  add(view.cone.counts);
  for (const [id, layer] of view.layering.layer) add([id, layer]);
  add(view.layering.maxLayer);
  add([...view.layering.feedback]);
  add(view.layering.order);
  for (const [id, size] of view.sizes) add([id, size]);
  for (const [id, position] of view.result.positions) add([id, position]);
  add([view.result.width, view.result.height, view.result.engine, view.result.durationMs]);
  return h.digest("hex");
}

function parityCase(label: string, options: ConeOptions): void {
  const cone = timed(`${label}:cone`, () => buildCone(index, options));
  const layering = timed(`${label}:layers`, () => assignLayers(cone.nodes.map((n) => n.id), cone.edges, (id) => {
    const v = cone.byId.get(id);
    return !!v && v.isTarget && v.decl?.kind !== "axiom";
  }));
  const sizes = timed(`${label}:measure`, () => measureAll(cone.nodes));
  const input = {
    nodes: cone.nodes.map((n) => {
      const s = sizes.get(n.id) ?? { width: 160, height: 74 };
      return { id: n.id, width: s.width, height: s.height, layer: layering.layer.get(n.id) ?? 0 };
    }),
    edges: cone.edges.filter((_e, k) => !layering.feedback.has(k)),
  };
  const layout = timed(`${label}:fastLayered`, () => fastLayered(input));
  const original: PreparedView = { cone, layering, sizes, result: { ...layout, engine: "fast", durationMs: 0 } };
  const before = digestView(original);
  const wire = timed(`${label}:toWireView`, () => toWireView(original));
  const cloned = timed(`${label}:structuredClone`, () => structuredClone(wire));
  const restored = timed(`${label}:fromWireView`, () => fromWireView(cloned, metadata));
  const after = digestView(restored);
  assert.equal(after, before, `${label}: view digest changed across worker wire`);
  assert.equal(restored.cone.view.order, cone.view.order);
  assert.equal(restored.cone.view.size, cone.view.size);
  for (const n of restored.cone.nodes) {
    assert.deepEqual(restored.cone.view.inNeighbors(n.id), cone.view.inNeighbors(n.id));
    assert.deepEqual(restored.cone.view.outNeighbors(n.id), cone.view.outNeighbors(n.id));
  }
  if (label === "project-expanded") {
    // Model the previous Graphology cone construction on the full real graph.
    const baseline = timed(`${label}:graphologyBaseline`, () => {
      const graph = new Graph({ type: "directed", multi: false, allowSelfLoops: false });
      for (const n of cone.nodes) graph.addNode(n.id);
      for (const e of cone.edges) graph.addEdgeWithKey(e.id, e.source, e.target, { site: e.site });
      return graph;
    });
    assert.equal(baseline.order, restored.cone.view.order);
    assert.equal(baseline.size, restored.cone.view.size);
    timed(`${label}:neighborOrderParity`, () => {
      for (const n of cone.nodes) {
        assert.deepEqual(restored.cone.view.inNeighbors(n.id), baseline.inNeighbors(n.id), `inNeighbors ${n.id}`);
        assert.deepEqual(restored.cone.view.outNeighbors(n.id), baseline.outNeighbors(n.id), `outNeighbors ${n.id}`);
      }
    });
  }
  for (const n of restored.cone.nodes) {
    assert.strictEqual(restored.cone.byId.get(n.id), n);
    if (n.type === "decl") assert.strictEqual(n.decl, metadata.byId.get(n.id));
  }
  console.log(JSON.stringify({ parity: label, ok: true, nodes: cone.nodes.length, edges: cone.edges.length, folded: cone.edges.filter((e) => e.folded).length, closure: cone.closureIds.length, feedback: layering.feedback.size, digest: before }));
}

if (parity) {
  assert.equal(timed("graph:structuredClone", () => structuredClone(file).nodes.length), file.nodes.length);
  const o = DEFAULT_OPTIONS;
  parityCase("project-default", { mode: "project", targets: [], depthLimit: o.depthLimit, hideAux: o.hideAux, external: o.external, site: o.site });
  gc();
  parityCase("project-expanded", { mode: "project", targets: [], depthLimit: null, hideAux: false, external: "expand", site: "all" });
  const trustHashAgain = createHash("sha256");
  for (const n of file.nodes) trustHashAgain.update(`${n.id}\0${n.axioms.join("\0")}\0${n.taints.join("\0")}\n`);
  assert.equal(trustHashAgain.digest("hex"), expectedTrustHash);
  console.log(JSON.stringify({ graphTrustUnchanged: true }));
  process.exit(0);
}

function runCone(label: string, options: ConeOptions): void {
  const cone: Cone = timed(`${label}:cone`, () => buildCone(index, options));
  console.log(JSON.stringify({ view: label, nodes: cone.nodes.length, edges: cone.edges.length, counts: cone.counts, targets: cone.targets.length, missingTargets: cone.missingTargets.length }));
  if (cone.nodes.length > SCALE_LIMIT && !forceLayout) return;
  const layering = timed(`${label}:layers`, () => assignLayers(cone.nodes.map((n) => n.id), cone.edges, (id) => {
    const v = cone.byId.get(id);
    return v?.isTarget ?? false;
  }));
  const sizes = timed(`${label}:measure`, () => measureAll(cone.nodes));
  const input = {
    nodes: cone.nodes.map((n) => {
      const s = sizes.get(n.id) ?? { width: 160, height: 74 };
      return { id: n.id, width: s.width, height: s.height, layer: layering.layer.get(n.id) ?? 0 };
    }),
    edges: cone.edges.filter((_e, k) => !layering.feedback.has(k)),
  };
  const layout = timed(`${label}:fastLayered`, () => fastLayered(input));
  console.log(JSON.stringify({ view: label, layers: layering.maxLayer + 1, feedback: layering.feedback.size, layoutEdges: input.edges.length, positioned: layout.positions.size, width: Math.round(layout.width), height: Math.round(layout.height) }));
}

const o = DEFAULT_OPTIONS;
const base = { mode: "cone" as const, depthLimit: o.depthLimit, hideAux: o.hideAux, external: o.external, site: o.site };
runCone("head12", { ...base, targets: index.localSinks.slice(0, 12) });
runCone("allSinks", { ...base, targets: index.localSinks });
if (target) runCone("target", { ...base, targets: [target] });
runCone("project", { ...base, mode: "project", targets: [] });
