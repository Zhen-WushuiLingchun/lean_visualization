import { describe, expect, it } from "vitest";
import { fuzzyScore, fuzzySearch } from "../src/graph/search";
import { sample } from "./fixtures";

const ids = sample.nodes.map((n) => n.id);

describe("fuzzy search", () => {
  it("ranks exact names and last components first", () => {
    expect(fuzzySearch("propext", ids)[0]?.id).toBe("propext");
    expect(fuzzySearch("main_theorem", ids)[0]?.id).toBe("Demo.Main.main_theorem");
  });
  it("matches subsequences across components", () => {
    expect(fuzzySearch("DMmain", ids).map((h) => h.id)).toContain("Demo.Main.main_theorem");
    expect(fuzzyScore("xyz", "Demo.Main.main_theorem")).toBeNull();
  });
  it("is case-insensitive and bounded", () => {
    expect(fuzzySearch("POINT", ids).length).toBeGreaterThan(0);
    expect(fuzzySearch("e", ids, 5)).toHaveLength(5);
    expect(fuzzySearch("   ", ids)).toEqual([]);
  });
});
