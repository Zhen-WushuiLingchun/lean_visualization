import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "../src/App";
import { GraphFileSchema } from "@proofflow/schema";
import { coneToGraphFile, coneToSvg } from "../src/graph/exportView";
import { buildCone } from "../src/graph/cone";
import { buildIndex } from "../src/graph/graphIndex";
import { assignLayers } from "../src/graph/layers";
import { runLayout } from "../src/graph/layout";
import { measureAll } from "../src/graph/measure";
import { sample } from "./fixtures";

const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

function mockFetch(server: boolean) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/graph")) return server ? json(sample) : new Response("no server", { status: 502 });
    if (url.startsWith("/api/checkers")) return json([]);
    if (url.startsWith("/api/results")) return json([]);
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
      { engine: "main" },
    );
    const svg = coneToSvg(cone, res, sizes, "dark");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("clean_result");
    expect(new DOMParser().parseFromString(svg, "image/svg+xml").getElementsByTagName("parsererror")).toHaveLength(0);
  }, 60_000);
});
