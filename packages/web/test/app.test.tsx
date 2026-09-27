import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "../src/App";
import { GraphFileSchema, type CheckerInfo, type GraphFile, type VerifyResult } from "@proofflow/schema";
import { coneToGraphFile, coneToSvg } from "../src/graph/exportView";
import { buildCone } from "../src/graph/cone";
import { buildIndex } from "../src/graph/graphIndex";
import { assignLayers } from "../src/graph/layers";
import { runLayout } from "../src/graph/layout";
import { measureAll } from "../src/graph/measure";
import { prepareView, toWireView, type ViewWorkerRequest, type ViewWorkerResponse } from "../src/graph/viewPipeline";
import { audit, chainsGraph, CHECKERS_435, CHECKERS_NONE, CHECKERS_OLD, layeredGraph, result, row, sample } from "./fixtures";

const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

function mockFetch(server: boolean, opts: { checkers?: CheckerInfo[]; results?: Record<string, VerifyResult[]>; graph?: GraphFile } = {}) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/graph")) return server ? json(opts.graph ?? sample) : new Response("no server", { status: 502 });
    if (url.startsWith("/api/checkers")) return json(opts.checkers ?? CHECKERS_435);
    if (url.startsWith("/api/results")) return json(opts.results?.[new URL(url, "http://x").searchParams.get("decl") ?? ""] ?? []);
    if (url.includes("fixtures/sample.json")) return json(sample);
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Runs the real worker computation behind the Worker message contract in jsdom. */
function stubViewWorker(): void {
  class InProcessViewWorker {
    onmessage: ((event: MessageEvent<ViewWorkerResponse>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    private index: ReturnType<typeof buildIndex> | null = null;
    private terminated = false;
    postMessage(request: ViewWorkerRequest): void {
      if (request.type === "init") {
        this.index = buildIndex(request.graph);
        queueMicrotask(() => this.send({ type: "ready" }));
      } else if (this.index) {
        void prepareView(this.index, request.options, request.choice)
          .then((view) => this.send({ type: "result", id: request.id, view: toWireView(view) }))
          .catch((error: unknown) => this.send({ type: "error", id: request.id, error: String(error) }));
      }
    }
    terminate(): void { this.terminated = true; }
    private send(message: ViewWorkerResponse): void {
      if (!this.terminated) this.onmessage?.({ data: message } as MessageEvent<ViewWorkerResponse>);
    }
  }
  vi.stubGlobal("Worker", InProcessViewWorker);
}

async function expectGraphShowsTargets(): Promise<void> {
  // Wait for ELK and the first fitView (before it, most nodes are culled as off-screen).
  await waitFor(() => expect(screen.queryAllByTestId("pf-node").length).toBeGreaterThan(5), { timeout: 20_000 });
  const canvas = screen.getByLabelText("Dependency graph");
  expect(within(canvas).getAllByText("main_theorem").length).toBeGreaterThan(0);
  expect(within(canvas).getAllByText("clean_result").length).toBeGreaterThan(0);
  expect(within(canvas).getAllByText("propext").length).toBeGreaterThan(0);
}

describe("App", () => {
  it("falls back to the landing panel and loads the bundled sample", async () => {
    mockFetch(false);
    render(<App />);
    const button = await screen.findByRole("button", { name: "Load sample" });
    fireEvent.click(button);
    await expectGraphShowsTargets();
    // Standalone: verification is disabled with an explanation.
    fireEvent.click(within(screen.getByLabelText("Dependency graph")).getAllByText("main_theorem")[0] as HTMLElement);
    const panel = await screen.findByLabelText("Node details");
    const verifyBtn = within(panel).getByRole("button", { name: "Verify (kernel)" });
    expect(verifyBtn).toHaveProperty("disabled", true);
    expect(verifyBtn.getAttribute("title")).toMatch(/needs the ProofFlow server/);
    expect(within(panel).getByText(/Rests on sorryAx/)).toBeTruthy();
  });

  it("loads the graph from the server and enables verification", async () => {
    const f = mockFetch(true);
    render(<App />);
    await expectGraphShowsTargets();
    expect(screen.getByText(/\(server\)/)).toBeTruthy();
    fireEvent.click(within(screen.getByLabelText("Dependency graph")).getAllByText("clean_result")[0] as HTMLElement);
    const panel = await screen.findByLabelText("Node details");
    expect(within(panel).getByRole("button", { name: "Verify (kernel)" })).toHaveProperty("disabled", false);
    // Visible nodes ask for cached results (debounced).
    await waitFor(() => expect(f.mock.calls.some((c) => String(c[0]).startsWith("/api/results?decl="))).toBe(true));
    // Esc closes the panel.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByLabelText("Node details")).toBeNull());
  });
});

describe("kernel checker availability", () => {
  const openPanel = async (name: string): Promise<HTMLElement> => {
    await expectGraphShowsTargets();
    fireEvent.click(within(screen.getByLabelText("Dependency graph")).getAllByText(name)[0] as HTMLElement);
    return screen.findByLabelText("Node details");
  };

  it("uses module replay on older toolchains and says so", async () => {
    const decl = "Demo.Main.clean_result";
    const cached = result([row("leanchecker-module", "accepted")], { decl, module: "Demo.Main", exportDecls: null, exportBytes: 0 });
    mockFetch(true, { checkers: CHECKERS_OLD, results: { [decl]: [cached] } });
    render(<App />);
    const panel = await openPanel("clean_result");
    await waitFor(() => expect(within(panel).getByRole("button", { name: "Verify (kernel)" }).getAttribute("title")).toContain("leanchecker-module"));
    expect(within(panel).getByRole("button", { name: "Verify (kernel)" })).toHaveProperty("disabled", false);
    expect(within(panel).getAllByText("kernel, module replay").length).toBeGreaterThan(0);
    expect(within(panel).getByText(/Replays the whole module from its .olean/)).toBeTruthy();
    await waitFor(() => expect(within(panel).getByText(/Module replay of/)).toBeTruthy());
    expect(within(panel).queryByText(/declarations, exported in/)).toBeNull();
    expect(within(within(panel).getByLabelText("Export audit")).getByText("No export (module replay).")).toBeTruthy();
    expect(within(panel).getByText("Accepted")).toBeTruthy();
    // The checker legend in the side bar shows the label too.
    expect(within(screen.getByLabelText("Project summary")).getByText(/kernel, module replay/)).toBeTruthy();
  });

  it("disables kernel verification with the server note when no L1 checker is available", async () => {
    mockFetch(true, { checkers: CHECKERS_NONE });
    render(<App />);
    const panel = await openPanel("main_theorem");
    await waitFor(() => expect(within(panel).getByRole("button", { name: "Verify (kernel)" })).toHaveProperty("disabled", true));
    const title = within(panel).getByRole("button", { name: "Verify (kernel)" }).getAttribute("title") ?? "";
    expect(title).toContain("leanexport is missing");
    expect(within(panel).getByRole("button", { name: "Verify (all checkers)" })).toHaveProperty("disabled", true);
  });
});

const layoutStatus = (): string => document.querySelector(".pf-toolbar [role=status]")?.textContent ?? "";

function viewport(): { x: number; y: number; zoom: number } {
  const t = (document.querySelector(".react-flow__viewport") as HTMLElement | null)?.style.transform ?? "";
  const m = /translate\(([-0-9.e]+)px,\s*([-0-9.e]+)px\)\s*scale\(([-0-9.e]+)\)/.exec(t);
  return m ? { x: Number(m[1]), y: Number(m[2]), zoom: Number(m[3]) } : { x: 0, y: 0, zoom: 1 };
}

describe("export audit", () => {
  const openPanel = async (name: string): Promise<HTMLElement> => {
    await expectGraphShowsTargets();
    fireEvent.click(within(screen.getByLabelText("Dependency graph")).getAllByText(name)[0] as HTMLElement);
    return screen.findByLabelText("Node details");
  };

  it("shows the audit, the .olean binding and checker provenance", async () => {
    const decl = "Demo.Main.clean_result";
    const r = result([row("leanchecker", "accepted", { binarySha256: "feedfacecafebeef00112233", ranAt: "2026-09-27T10:00:05Z" })], {
      decl,
      module: "Demo.Main",
      exportAudit: audit(),
      binding: { oleanSha256: "aabbccddeeff00112233445566778899", toolchain: "leanprover/lean4:v4.35.0-rc3" },
    });
    mockFetch(true, { results: { [decl]: [r] } });
    render(<App />);
    const panel = await openPanel("clean_result");
    const box = await within(panel).findByLabelText("Export audit");
    expect(within(box).getByText("Target found: yes (thm)")).toBeTruthy();
    expect(within(box).getByText("0123456789ab\u2026").getAttribute("title")).toBe(audit().targetTypeSha256);
    expect(within(box).getByText(/Axioms in closure: Classical.choice, Quot.sound, propext/)).toBeTruthy();
    expect(within(box).getByText("standard only")).toBeTruthy();
    expect(within(box).getByText("Declarations: 183")).toBeTruthy();
    expect(within(panel).getByText(/Bound to .olean/).textContent).toContain("aabbccddeeff\u2026 on leanprover/lean4:v4.35.0-rc3");
    fireEvent.click(within(panel).getAllByRole("button", { name: "Log" })[0] as HTMLElement);
    const prov = within(panel).getByText(/Binary sha256/);
    expect(prov.textContent).toContain("feedfacecafe\u2026");
    expect(prov.textContent).toContain("ran ");
  });

  it("flags a missing target and non-standard axioms in red", async () => {
    const decl = "Demo.Main.clean_result";
    const r = result([row("leanchecker", "accepted")], {
      decl,
      module: "Demo.Main",
      exportAudit: audit({ targetFound: false, targetKind: null, targetTypeSha256: null, axioms: ["Demo.Axioms.oracle", "propext"], standardAxiomsOnly: false }),
    });
    mockFetch(true, { results: { [decl]: [r] } });
    render(<App />);
    const panel = await openPanel("clean_result");
    const box = await within(panel).findByLabelText("Export audit");
    expect(within(box).getByText("Target NOT found in export").className).toContain("pf-error");
    expect(within(box).getByText("Demo.Axioms.oracle").className).toContain("pf-flag--bad");
    expect(within(panel).getByText("Export mismatch")).toBeTruthy();
    await waitFor(() => expect(document.querySelector('[data-id="Demo.Main.clean_result"] .pf-vbadge')?.getAttribute("data-badge")).toBe("rejected"));
  });
});

describe("big cones", () => {
  it("locates a visible declaration without leaving project mode and opens its cone on Shift+Enter", async () => {
    mockFetch(true);
    render(<App />);
    await expectGraphShowsTargets();
    fireEvent.click(screen.getByRole("button", { name: "Whole project" }));
    await waitFor(() => expect(layoutStatus()).toMatch(/nodes, /));
    const search = screen.getByRole("combobox", { name: "Search declarations to locate" });
    fireEvent.change(search, { target: { value: "Demo.Main.clean_result" } });
    await within(await screen.findByRole("listbox")).findByRole("option");
    fireEvent.keyDown(search, { key: "Enter" });
    const panel = await screen.findByLabelText("Node details");
    expect(within(panel).getByText("Demo.Main.clean_result")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Whole project" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(search, { target: { value: "Demo.Main.clean_result" } });
    await within(await screen.findByRole("listbox")).findByRole("option");
    fireEvent.keyDown(search, { key: "Enter", shiftKey: true });
    expect(screen.getByRole("button", { name: "Cone" }).getAttribute("aria-pressed")).toBe("true");
  }, 60_000);

  it("fits a 1000-node cone after the fast layout so that every node is in view", async () => {
    stubViewWorker();
    mockFetch(true, { graph: layeredGraph(25, 40) }); // 1001 nodes, one final theorem
    render(<App />);
    await waitFor(() => expect(layoutStatus()).toMatch(/^1001 nodes, fast layout/), { timeout: 20_000 });
    // With onlyRenderVisibleElements, nodes outside the viewport are not rendered: all must be.
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node")).toHaveLength(1001), { timeout: 20_000 });
    const vp = viewport();
    expect(vp.zoom).toBeLessThan(1);
    for (const el of document.querySelectorAll<HTMLElement>(".react-flow__node")) {
      const m = /translate\(([-0-9.e]+)px,\s*([-0-9.e]+)px\)/.exec(el.style.transform);
      const x = Number(m?.[1]) * vp.zoom + vp.x;
      const y = Number(m?.[2]) * vp.zoom + vp.y;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1200);
      expect(y).toBeLessThanOrEqual(800);
    }
  }, 60_000);

  it("opens a large graph in whole-project mode with every local declaration", async () => {
    stubViewWorker();
    mockFetch(true, { graph: chainsGraph(40, 20) }); // 840 nodes for all 40 final theorems
    render(<App />);
    await waitFor(() => expect(layoutStatus()).toMatch(/^840 nodes, fast layout/), { timeout: 20_000 });
    expect(screen.getByRole("button", { name: "Whole project" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/Whole project: 840 local declarations/)).toBeTruthy();
    expect(screen.queryByText(/Showing 12 of 40/)).toBeNull();
  }, 60_000);
});

describe("export", () => {
  it("exports the cone as a schema-valid graph.json and as SVG", async () => {
    const idx = buildIndex(sample);
    const cone = buildCone(idx, { mode: "cone", targets: ["Demo.Main.clean_result"], depthLimit: null, hideAux: true, external: "collapse", site: "all" });
    const g = coneToGraphFile(idx, cone);
    expect(GraphFileSchema.safeParse(JSON.parse(JSON.stringify(g))).success).toBe(true);
    expect(g.stats.localSinks).toEqual(["Demo.Main.clean_result"]);
    expect(g.nodes.some((n) => n.id === "Demo.Color.casesOn")).toBe(true); // folded aux is kept in the export
    const L = assignLayers(cone.nodes.map((n) => n.id), cone.edges);
    const sizes = measureAll(cone.nodes);
    const res = await runLayout(
      { nodes: cone.nodes.map((n) => ({ id: n.id, ...(sizes.get(n.id) ?? { width: 1, height: 1 }), layer: L.layer.get(n.id) ?? 0 })), edges: cone.edges },
      { choice: "elk", elkThread: "main" },
    );
    const svg = coneToSvg(cone, res, sizes, "dark");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("clean_result");
    expect(new DOMParser().parseFromString(svg, "image/svg+xml").getElementsByTagName("parsererror")).toHaveLength(0);
  }, 60_000);
});
