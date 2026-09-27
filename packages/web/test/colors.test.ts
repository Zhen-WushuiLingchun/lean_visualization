import { describe, expect, it } from "vitest";
import { classifyAxiom, worstTaint, type Taint } from "@proofflow/schema";
import {
  BORDER_PALETTE,
  KIND_PALETTE,
  UI_PALETTE,
  axiomColorKey,
  borderKey,
  contrastRatio,
  edgeColor,
  kindColorKey,
  kindLabel,
  paletteCss,
} from "../src/graph/colors";
import { node } from "./fixtures";

describe("axiom classification and colour", () => {
  it.each([
    ["propext", "standard", "axiomStandard"],
    ["Classical.choice", "standard", "axiomStandard"],
    ["Quot.sound", "standard", "axiomStandard"],
    ["sorryAx", "sorry", "axiomSorry"],
    ["Lean.ofReduceBool", "nativeDecide", "axiomNative"],
    ["Lean.ofReduceNat", "nativeDecide", "axiomNative"],
    ["Demo.t._native.native_decide.ax_1_1", "nativeDecide", "axiomNative"],
    ["Demo.Axioms.oracle", "custom", "axiomCustom"],
  ])("%s is %s", (name, cls, key) => {
    expect(classifyAxiom(name)).toBe(cls);
    expect(axiomColorKey(name)).toBe(key);
    expect(kindColorKey(node(name, { kind: "axiom" }))).toBe(key);
  });

  it("maps declaration kinds to header colours", () => {
    expect(kindColorKey(node("t"))).toBe("theorem");
    expect(kindColorKey(node("d", { kind: "definition" }))).toBe("definition");
    expect(kindColorKey(node("i", { kind: "definition", subKind: "instance" }))).toBe("instance");
    expect(kindColorKey(node("o", { kind: "opaque" }))).toBe("opaque");
    expect(kindColorKey(node("s", { kind: "inductive", subKind: "structure" }))).toBe("inductive");
    expect(kindColorKey(node("c", { kind: "constructor" }))).toBe("ctor");
    expect(kindColorKey(node("r", { kind: "recursor" }))).toBe("ctor");
    expect(kindColorKey(node("q", { kind: "quot" }))).toBe("quot");
    expect(kindLabel(node("s", { kind: "inductive", subKind: "structure" }))).toBe("structure");
    expect(kindLabel(node("sorryAx", { kind: "axiom" }))).toBe("sorry axiom");
  });
});

describe("border from worst taint", () => {
  const cases: [Taint[], string][] = [
    [[], "clean"],
    [["implementedBy"], "flag"],
    [["extern", "partial", "unsafe"], "flag"],
    [["unsafe", "nativeDecide"], "nativeDecide"],
    [["nativeDecide", "customAxiom"], "customAxiom"],
    [["implementedBy", "customAxiom", "sorry"], "sorry"],
  ];
  it.each(cases)("%j gives %s", (taints, key) => {
    expect(borderKey(taints)).toBe(key);
  });
  it("agrees with the schema's worstTaint", () => {
    expect(worstTaint(["partial", "sorry", "nativeDecide"])).toBe("sorry");
    expect(BORDER_PALETTE.flag.dashed).toBe(true);
    expect(BORDER_PALETTE.sorry.dashed).toBe(false);
  });
});

describe("contrast in both themes", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`${theme}: header text on every kind colour is at least 4.5:1`, () => {
      for (const [key, v] of Object.entries(KIND_PALETTE)) {
        expect(contrastRatio(v[theme].text, v[theme].fill), `${key}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${theme}: borders and status colours are at least 3:1 against canvas and node surface`, () => {
      const bg = [UI_PALETTE.canvas[theme], UI_PALETTE.surface[theme], UI_PALETTE.surface2[theme]];
      const fg = [...Object.values(BORDER_PALETTE).map((b) => b[theme]), UI_PALETTE.ok[theme], UI_PALETTE.bad[theme], UI_PALETTE.warn[theme], UI_PALETTE.na[theme]];
      for (const f of fg) for (const b of bg) expect(contrastRatio(f, b), `${f} on ${b}`).toBeGreaterThanOrEqual(3);
    });
    it(`${theme}: every edge colour is at least 3:1 against the canvas`, () => {
      for (const key of Object.keys(KIND_PALETTE) as (keyof typeof KIND_PALETTE)[]) {
        expect(contrastRatio(edgeColor(key, theme), UI_PALETTE.canvas[theme]), key).toBeGreaterThanOrEqual(3);
      }
    });
    it(`${theme}: body and muted text are at least 4.5:1`, () => {
      for (const b of [UI_PALETTE.canvas[theme], UI_PALETTE.surface[theme], UI_PALETTE.surface2[theme]]) {
        expect(contrastRatio(UI_PALETTE.text[theme], b)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(UI_PALETTE.muted[theme], b)).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${theme}: pill text on taint and status colours is at least 4.5:1`, () => {
      const on = UI_PALETTE.onStatus[theme];
      for (const b of Object.values(BORDER_PALETTE)) expect(contrastRatio(on, b[theme]), b.label).toBeGreaterThanOrEqual(4.5);
      for (const k of ["ok", "bad", "warn", "na", "accent"] as const) expect(contrastRatio(on, UI_PALETTE[k][theme]), k).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("emits CSS variables for both themes", () => {
    const css = paletteCss();
    expect(css).toContain("--pf-kind-theorem-fill: #1d4ed8;");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain("--pf-kind-theorem-fill: #60a5fa;");
    expect(css).toContain('[data-border="sorry"] { --border: var(--pf-border-sorry); }');
  });
});
