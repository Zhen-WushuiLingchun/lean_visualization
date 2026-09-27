import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { GraphCanvas, canvasMinZoom, usesLargeGraphCanvas } from "../src/components/GraphCanvas";
import { BORDER_PALETTE } from "../src/graph/colors";
import type { Cone, ViewNode } from "../src/graph/cone";
import type { LayoutResult } from "../src/graph/layout";
import { AppContext, ServicesContext, initialState } from "../src/state/appState";
import { HighlightStore } from "../src/state/highlight";
import { VerifyStore } from "../src/state/verifyStore";
import { sample } from "./fixtures";

const baseDecl = sample.nodes.find((n) => n.kind === "theorem");
if (!baseDecl) throw new Error("sample theorem missing");

function fixture() {
  const nodes: ViewNode[] = Array.from({ length: 1501 }, (_, i) => {
    const id = `Test.n${i}`;
    return {
      id, type: "decl", decl: { ...baseDecl!, id, shortName: `n${i}` }, label: `n${i}`,
      package: "Test", members: [], taints: i === 0 ? ["sorry"] : [], axioms: [],
      isTarget: i === 0, isLocal: true, isAux: false, isSynthetic: false, truncated: false,
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const cone = { nodes, edges: [{ id: "e0", source: "Test.n1", target: "Test.n0", site: "proof", folded: false }], byId } as unknown as Cone;
  const positions = new Map(nodes.map((n, i) => [n.id, { x: (i % 50) * 210, y: Math.floor(i / 50) * 130 }] as const));
  const sizes = new Map(nodes.map((n) => [n.id, { width: 170, height: 80 }] as const));
  const layout: LayoutResult = { positions, width: 10460, height: 3980, engine: "fast", durationMs: 1 };
  return { cone, layout, sizes };
}

const widthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
const heightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
afterEach(() => {
  cleanup(); vi.restoreAllMocks();
  if (widthDesc) Object.defineProperty(HTMLElement.prototype, "clientWidth", widthDesc);
  if (heightDesc) Object.defineProperty(HTMLElement.prototype, "clientHeight", heightDesc);
});

describe("large Canvas renderer", () => {
  it("shares its threshold and zoom floor with toolbar fit", () => {
    const f = fixture();
    expect(usesLargeGraphCanvas(f.cone)).toBe(true);
    expect(canvasMinZoom(f.cone)).toBe(0.0001);
    expect(usesLargeGraphCanvas({ nodes: f.cone.nodes.slice(0, 10), edges: [] })).toBe(false);
  });

  it("draws trust borders at overview, idles without new frames, then shows the selected original card", async () => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1200 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
    const strokes: string[] = [];
    let fills = 0;
    const ctx = new Proxy({ strokeStyle: "" }, {
      get(target, key) {
        if (key === "fillRect") return () => { fills++; };
        if (typeof key === "string" && key in target) return target[key as keyof typeof target];
        return () => undefined;
      },
      set(target, key, value) {
        if (key === "strokeStyle") strokes.push(String(value));
        Reflect.set(target, key, value);
        return true;
      },
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const f = fixture();
    const verify = new VerifyStore();
    const highlight = new HighlightStore();
    const dispatch = vi.fn();
    const tree = (selected: string | null) => <ServicesContext.Provider value={{ dispatch, verify, highlight, serverMode: false }}>
      <AppContext.Provider value={{ state: { ...initialState, selected }, dispatch, index: null, verify, highlight, serverMode: false, checkers: null }}>
        <ReactFlowProvider><div style={{ width: 1200, height: 800 }}><GraphCanvas {...f} matches={() => true} /></div></ReactFlowProvider>
      </AppContext.Provider>
    </ServicesContext.Provider>;
    const view = render(tree(null));
    await waitFor(() => expect(fills).toBeGreaterThan(1500));
    expect(strokes).toContain(BORDER_PALETTE.sorry.light);
    expect(screen.getByText(/Edges simplified/)).toBeTruthy();
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const idleCount = raf.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(raf.mock.calls.length).toBe(idleCount);
    view.rerender(tree("Test.n0"));
    await waitFor(() => expect(document.querySelector('[data-testid="pf-node"][data-id="Test.n0"]')).toBeTruthy(), { timeout: 3000 });
    expect(document.querySelectorAll(".react-flow__node").length).toBeLessThanOrEqual(80);
  });
});
