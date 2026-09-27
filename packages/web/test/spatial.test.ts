import { describe, expect, it } from "vitest";
import { SpatialGrid, viewRect } from "../src/graph/spatial";

describe("large graph spatial queries", () => {
  const positions = new Map([
    ["A", { x: -100, y: 10 }],
    ["B", { x: 620, y: 700 }],
    ["C", { x: 5000, y: 50 }],
  ]);
  const sizes = new Map([...positions.keys()].map((id) => [id, { width: 180, height: 80 }] as const));
  const grid = new SpatialGrid(positions, sizes, 256);

  it("culls by world viewport while retaining boxes across cell boundaries", () => {
    expect(grid.query({ x: 50, y: 0, width: 100, height: 120 }).map((b) => b.id)).toEqual(["A"]);
    expect(grid.query({ x: 600, y: 680, width: 100, height: 100 }).map((b) => b.id)).toEqual(["B"]);
    expect(grid.query({ x: 1000, y: 0, width: 100, height: 100 })).toEqual([]);
  });

  it("finds nodes with screen-sized hit tolerance at any zoom", () => {
    expect(grid.hit(0, 40)?.id).toBe("A");
    expect(grid.hit(83, 40, 3)?.id).toBe("A");
    expect(grid.hit(90, 40, 3)).toBeNull();
  });

  it("converts a panned and zoomed pane to world coordinates", () => {
    expect(viewRect({ x: -100, y: 20, zoom: 0.5 }, 800, 600)).toEqual({ x: 200, y: -40, width: 1600, height: 1200 });
  });

  it("handles an overview that spans far more empty cells than occupied cells", () => {
    expect(grid.query({ x: -100000, y: -100000, width: 200000, height: 200000 })).toHaveLength(3);
  });
});
