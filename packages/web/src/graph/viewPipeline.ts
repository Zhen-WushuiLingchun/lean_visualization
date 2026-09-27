import type { GraphFile } from "@proofflow/schema";
import { CsrConeAdjacency } from "./adjacency";
import { buildCone, type Cone, type ConeOptions, type ViewEdge, type ViewNode } from "./cone";
import { buildIndex, type GraphIndex } from "./graphIndex";
import { assignLayers, type Layering } from "./layers";
import { runLayout, type LayoutChoice, type LayoutResult } from "./layout";
import { measureAll, type Size } from "./measure";

export interface PreparedView {
  cone: Cone;
  layering: Layering;
  sizes: Map<string, Size>;
  result: LayoutResult;
}

/** Graphology instances cannot be cloned across a worker boundary. */
export type WireViewNode = Omit<ViewNode, "decl">;
export type WireCone = Omit<Cone, "view" | "byId" | "nodes"> & { nodes: WireViewNode[] };
export interface WireView extends Omit<PreparedView, "cone"> {
  cone: WireCone;
}

export function toWireView(view: PreparedView): WireView {
  const { view: _view, byId: _byId, nodes, ...cone } = view.cone;
  return { ...view, cone: { ...cone, nodes: nodes.map(({ decl: _decl, ...node }) => node) } };
}

export function fromWireView(wire: WireView, index: GraphIndex): PreparedView {
  const nodes: ViewNode[] = wire.cone.nodes.map((n) => ({ ...n, decl: n.type === "decl" ? index.byId.get(n.id) ?? null : null }));
  const byId = new Map<string, ViewNode>(nodes.map((n) => [n.id, n]));
  const view = new CsrConeAdjacency(nodes.map((n) => n.id), wire.cone.edges);
  return { ...wire, cone: { ...wire.cone, nodes, byId, view } };
}

export async function prepareView(index: GraphIndex, options: ConeOptions, choice: LayoutChoice): Promise<PreparedView> {
  const cone = buildCone(index, options);
  const layering = assignLayers(
    cone.nodes.map((n) => n.id),
    cone.edges,
    (id) => {
      const v = cone.byId.get(id);
      return !!v && v.isTarget && v.decl?.kind !== "axiom";
    },
  );
  const sizes = measureAll(cone.nodes);
  const input = {
    nodes: cone.nodes.map((n) => {
      const s = sizes.get(n.id) ?? { width: 160, height: 74 };
      return { id: n.id, width: s.width, height: s.height, layer: layering.layer.get(n.id) ?? 0 };
    }),
    edges: cone.edges.filter((_e: ViewEdge, k: number) => !layering.feedback.has(k)),
  };
  // ELK's own worker can be nested under the view worker. The bundled ELK build assumes a
  // browser main thread and cannot construct its internal worker from a module worker.
  const result = await runLayout(input, { choice });
  return { cone, layering, sizes, result };
}

export type ViewWorkerRequest =
  | { type: "init"; graph: GraphFile }
  | { type: "prepare"; id: number; options: ConeOptions; choice: LayoutChoice };
export type ViewWorkerResponse =
  | { type: "ready" }
  | { type: "result"; id: number; view: WireView }
  | { type: "error"; id: number; error: string };

/** One initialized worker per source. Cancellation terminates the running computation. */
export class ViewPipeline {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private sequence = 0;
  private pending: { id: number; resolve: (v: PreparedView) => void; reject: (e: Error) => void } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private initTimer: ReturnType<typeof setTimeout> | null = null;
  private initReject: ((error: Error) => void) | null = null;
  private readonly timeoutMs = 60_000;

  constructor(private readonly graph: GraphFile, private readonly index: GraphIndex) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const worker = new Worker(new URL("./view.worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    this.ready = new Promise<void>((resolve, reject) => {
      this.initReject = reject;
      const stopThisWorker = (error: Error): void => {
        if (this.worker === worker) this.stop(error);
      };
      this.initTimer = setTimeout(() => stopThisWorker(new Error("View worker initialization timed out")), this.timeoutMs);
      worker.onmessage = (event: MessageEvent<ViewWorkerResponse>) => {
        if (this.worker !== worker) return;
        const message = event.data;
        if (message.type === "ready") {
          if (this.initTimer) clearTimeout(this.initTimer);
          this.initTimer = null;
          this.initReject = null;
          resolve();
          return;
        }
        if (!this.pending || this.pending.id !== message.id) return;
        const pending = this.pending;
        this.pending = null;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (message.type === "error") pending.reject(new Error(message.error));
        else {
          try { pending.resolve(fromWireView(message.view, this.index)); }
          catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))); }
        }
      };
      worker.onerror = (event) => {
        const error = new Error(event.message || "View worker failed");
        stopThisWorker(error);
      };
      try {
        worker.postMessage({ type: "init", graph: this.graph } satisfies ViewWorkerRequest);
      } catch (error) {
        queueMicrotask(() => stopThisWorker(error instanceof Error ? error : new Error(String(error))));
      }
    });
    return this.ready;
  }

  async prepare(options: ConeOptions, choice: LayoutChoice, signal?: AbortSignal): Promise<PreparedView> {
    if (signal?.aborted) throw new Error("View preparation cancelled");
    const onAbort = (): void => this.stop(new Error("View preparation cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await this.start();
      if (signal?.aborted) throw new Error("View preparation cancelled");
      const id = ++this.sequence;
      return await new Promise<PreparedView>((resolve, reject) => {
        this.pending = { id, resolve, reject };
        this.timer = setTimeout(() => this.stop(new Error("View preparation timed out")), this.timeoutMs);
        try {
          this.worker?.postMessage({ type: "prepare", id, options, choice } satisfies ViewWorkerRequest);
        } catch (error) {
          this.stop(error instanceof Error ? error : new Error(String(error)));
        }
      });
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  stop(reason = new Error("View preparation cancelled")): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.initTimer) clearTimeout(this.initTimer);
    this.timer = null;
    this.initTimer = null;
    this.initReject?.(reason);
    this.initReject = null;
    this.pending?.reject(reason);
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
  }
}
