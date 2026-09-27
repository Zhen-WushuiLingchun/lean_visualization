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
import { chainsGraph, CHECKERS_435, CHECKERS_NONE, CHECKERS_OLD, layeredGraph, result, row, sample } from "./fixtures";

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

describe("big cones", () => {
  it("fits a 1000-node cone after the fast layout so that every node is in view", async () => {
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

  it("narrows a big default view to the first 12 final theorems, one click from all", async () => {
    mockFetch(true, { graph: chainsGraph(40, 20) }); // 840 nodes for all 40 final theorems
    render(<App />);
    const notice = await screen.findByText(/Showing 12 of 40 final theorems; add more from the list or switch to whole project/, {}, { timeout: 20_000 });
    expect(screen.getByLabelText("Target history").textContent).toContain("First 12 final theorems");
    await waitFor(() => expect(layoutStatus()).toMatch(/^252 nodes/), { timeout: 20_000 });
    fireEvent.click(within(notice.closest(".pf-notice") as HTMLElement).getByRole("button", { name: "Show all 40" }));
    await waitFor(() => expect(layoutStatus()).toMatch(/^840 nodes, fast layout/), { timeout: 20_000 });
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
