import { afterEach, describe, expect, it, vi } from "vitest";
import Graph from "graphology";
import { ancestorsInView, buildCone, relatedInView } from "../src/graph/cone";
import { buildIndex } from "../src/graph/graphIndex";
import { fromWireView, prepareView, toWireView, ViewPipeline, type ViewWorkerResponse } from "../src/graph/viewPipeline";
import { sample } from "./fixtures";

const options = { mode: "cone" as const, targets: ["Demo.Main.clean_result"], depthLimit: null, hideAux: true, external: "collapse" as const, site: "all" as const };

afterEach(() => vi.unstubAllGlobals());

describe("view worker boundary", () => {
  it("preserves the cone and layout while reusing main-thread declarations", async () => {
    const full = buildIndex(sample);
    const metadata = buildIndex(sample, { metadataOnly: true });
    expect(() => buildCone(metadata, options)).toThrow(/view worker/);
    const prepared = await prepareView(full, options, "fast");
    const wire = toWireView(prepared);
    expect(wire.cone.nodes.every((n) => !("decl" in n))).toBe(true);
    const restored = fromWireView(wire, metadata);
    expect(restored.cone.nodes.map((n) => n.id)).toEqual(prepared.cone.nodes.map((n) => n.id));
    expect(restored.cone.edges).toEqual(prepared.cone.edges);
    expect(restored.cone.counts).toEqual(prepared.cone.counts);
    expect(restored.cone.targets).toEqual(prepared.cone.targets);
    expect(restored.layering.layer).toEqual(prepared.layering.layer);
    expect(restored.sizes).toEqual(prepared.sizes);
    expect(restored.result.positions).toEqual(prepared.result.positions);
    const baseline = new Graph({ type: "directed", multi: false, allowSelfLoops: false });
    for (const node of prepared.cone.nodes) baseline.addNode(node.id);
    for (const edge of prepared.cone.edges) baseline.addEdgeWithKey(edge.id, edge.source, edge.target);
    expect(restored.cone.view.order).toBe(baseline.order);
    expect(restored.cone.view.size).toBe(baseline.size);
    for (const node of prepared.cone.nodes) {
      expect(restored.cone.view.inNeighbors(node.id)).toEqual(baseline.inNeighbors(node.id));
      expect(restored.cone.view.outNeighbors(node.id)).toEqual(baseline.outNeighbors(node.id));
      expect(relatedInView(restored.cone, node.id)).toEqual(relatedInView(prepared.cone, node.id));
      expect(ancestorsInView(restored.cone, node.id)).toEqual(ancestorsInView(prepared.cone, node.id));
    }
    const decl = restored.cone.nodes.find((n) => n.id === "Demo.Main.clean_result")?.decl;
    expect(decl).toBe(metadata.byId.get("Demo.Main.clean_result"));
  });

  it("cancels a worker stuck during initialization", async () => {
    class StuckWorker {
      static instance: StuckWorker;
      onmessage: ((event: MessageEvent<ViewWorkerResponse>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      terminated = false;
      constructor() { StuckWorker.instance = this; }
      postMessage(): void {}
      terminate(): void { this.terminated = true; }
    }
    vi.stubGlobal("Worker", StuckWorker);
    const pipeline = new ViewPipeline(sample, buildIndex(sample, { metadataOnly: true }));
    const ctrl = new AbortController();
    const task = pipeline.prepare(options, "fast", ctrl.signal);
    ctrl.abort();
    await expect(task).rejects.toThrow(/cancelled/);
    expect(StuckWorker.instance.terminated).toBe(true);
  });

  it("keeps the replacement worker alive after a rapid cancellation during init", async () => {
    const wire = toWireView(await prepareView(buildIndex(sample), options, "fast"));
    class ReplacingWorker {
      static instances: ReplacingWorker[] = [];
      onmessage: ((event: MessageEvent<ViewWorkerResponse>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      terminated = false;
      constructor() { ReplacingWorker.instances.push(this); }
      postMessage(message: { type: string; id?: number }): void {
        if (ReplacingWorker.instances[0] === this) return; // first init hangs
        if (message.type === "init") queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } } as MessageEvent<ViewWorkerResponse>));
        if (message.type === "prepare") queueMicrotask(() => this.onmessage?.({ data: { type: "result", id: message.id, view: wire } } as MessageEvent<ViewWorkerResponse>));
      }
      terminate(): void { this.terminated = true; }
    }
    vi.stubGlobal("Worker", ReplacingWorker);
    const pipeline = new ViewPipeline(sample, buildIndex(sample, { metadataOnly: true }));
    const ctrl = new AbortController();
    const stale = pipeline.prepare(options, "fast", ctrl.signal);
    ctrl.abort();
    const fresh = pipeline.prepare(options, "fast");
    await expect(stale).rejects.toThrow(/cancelled/);
    expect((await fresh).cone.nodes.length).toBeGreaterThan(0);
    expect(ReplacingWorker.instances).toHaveLength(2);
    expect(ReplacingWorker.instances[0]?.terminated).toBe(true);
    expect(ReplacingWorker.instances[1]?.terminated).toBe(false);
    pipeline.stop();
  });

  it("reports worker crashes and allows a fresh worker on retry", async () => {
    class FailingWorker {
      static instances: FailingWorker[] = [];
      onmessage: ((event: MessageEvent<ViewWorkerResponse>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      terminated = false;
      constructor() { FailingWorker.instances.push(this); }
      postMessage(): void {
        queueMicrotask(() => this.onerror?.({ message: "worker crashed" } as ErrorEvent));
      }
      terminate(): void { this.terminated = true; }
    }
    vi.stubGlobal("Worker", FailingWorker);
    const pipeline = new ViewPipeline(sample, buildIndex(sample, { metadataOnly: true }));
    await expect(pipeline.prepare(options, "fast")).rejects.toThrow(/worker crashed/);
    expect(FailingWorker.instances[0]?.terminated).toBe(true);
    await expect(pipeline.prepare(options, "fast")).rejects.toThrow(/worker crashed/);
    expect(FailingWorker.instances).toHaveLength(2);
  });
});
