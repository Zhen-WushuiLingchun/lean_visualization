import { classifyAxiom, worstTaint, type AxiomClass, type Node, type Taint } from "@proofflow/schema";

/**
 * The visual language of ARCHITECTURE.md section 4, as data. Every colour the viewer uses is defined
 * here once, for a light and a dark theme, and emitted as CSS custom properties by `paletteCss()`.
 * `test/colors.test.ts` checks the contrast of every pair in both themes.
 */

export interface Swatch {
  /** Header background. */
  fill: string;
  /** Text drawn on `fill`. */
  text: string;
}

export type KindColorKey =
  | "axiomStandard"
  | "axiomSorry"
  | "axiomNative"
  | "axiomCustom"
  | "theorem"
  | "definition"
  | "opaque"
  | "inductive"
  | "ctor"
  | "instance"
  | "quot"
  | "package";

export const KIND_PALETTE: Record<KindColorKey, { label: string; light: Swatch; dark: Swatch }> = {
  axiomStandard: { label: "Standard axiom", light: { fill: "#475569", text: "#ffffff" }, dark: { fill: "#94a3b8", text: "#0f172a" } },
  axiomSorry: { label: "sorryAx", light: { fill: "#c2410c", text: "#ffffff" }, dark: { fill: "#fb923c", text: "#1c1917" } },
  axiomNative: { label: "native_decide axiom", light: { fill: "#7e22ce", text: "#ffffff" }, dark: { fill: "#c084fc", text: "#1e1b4b" } },
  axiomCustom: { label: "Custom axiom", light: { fill: "#b91c1c", text: "#ffffff" }, dark: { fill: "#f87171", text: "#1c1917" } },
  theorem: { label: "Theorem", light: { fill: "#1d4ed8", text: "#ffffff" }, dark: { fill: "#60a5fa", text: "#0f172a" } },
  definition: { label: "Definition", light: { fill: "#0f766e", text: "#ffffff" }, dark: { fill: "#2dd4bf", text: "#042f2e" } },
  opaque: { label: "Opaque", light: { fill: "#795548", text: "#ffffff" }, dark: { fill: "#d4a373", text: "#1c1917" } },
  inductive: { label: "Inductive / structure", light: { fill: "#a16207", text: "#ffffff" }, dark: { fill: "#facc15", text: "#1c1917" } },
  ctor: { label: "Constructor / recursor", light: { fill: "#fde68a", text: "#713f12" }, dark: { fill: "#713f12", text: "#fef3c7" } },
  instance: { label: "Instance", light: { fill: "#99f6e4", text: "#134e4a" }, dark: { fill: "#134e4a", text: "#ccfbf1" } },
  quot: { label: "Quot", light: { fill: "#64748b", text: "#ffffff" }, dark: { fill: "#7c8aa0", text: "#0f172a" } },
  package: { label: "External package", light: { fill: "#e2e8f0", text: "#334155" }, dark: { fill: "#334155", text: "#e2e8f0" } },
};

/** Node border: the worst transitive taint. Flag taints share one dashed grey. */
export type BorderKey = "clean" | "nativeDecide" | "customAxiom" | "sorry" | "flag";

export const BORDER_PALETTE: Record<BorderKey, { label: string; light: string; dark: string; dashed: boolean }> = {
  clean: { label: "Standard axioms only", light: "#15803d", dark: "#4ade80", dashed: false },
  nativeDecide: { label: "native_decide", light: "#7e22ce", dark: "#c084fc", dashed: false },
  customAxiom: { label: "Custom axiom", light: "#b91c1c", dark: "#f87171", dashed: false },
  sorry: { label: "sorry", light: "#c2410c", dark: "#fb923c", dashed: false },
  flag: { label: "unsafe, partial, extern or implemented_by", light: "#6b7280", dark: "#9ca3af", dashed: true },
};

/** Surfaces, text and status colours. */
export const UI_PALETTE = {
  canvas: { light: "#f8fafc", dark: "#0f172a" },
  surface: { light: "#ffffff", dark: "#1e293b" },
  surface2: { light: "#f1f5f9", dark: "#273449" },
  text: { light: "#0f172a", dark: "#e2e8f0" },
  muted: { light: "#475569", dark: "#94a3b8" },
  line: { light: "#cbd5e1", dark: "#475569" },
  accent: { light: "#1d4ed8", dark: "#60a5fa" },
  ok: { light: "#15803d", dark: "#4ade80" },
  bad: { light: "#b91c1c", dark: "#f87171" },
  warn: { light: "#b45309", dark: "#fbbf24" },
  na: { light: "#6b7280", dark: "#9ca3af" },
  run: { light: "#1d4ed8", dark: "#60a5fa" },
  /** Text on a filled status pill. */
  onStatus: { light: "#ffffff", dark: "#0f172a" },
} as const;
export type UiColorKey = keyof typeof UI_PALETTE;

export const kindVar = (key: KindColorKey, part: "fill" | "text"): string => `var(--pf-kind-${key}-${part})`;

/**
 * Edge colour of a dependency: its kind colour, except for the pale kinds whose fill has no contrast
 * against the canvas; those use their text colour (dark on light, light on dark).
 */
export const PALE_KINDS: ReadonlySet<KindColorKey> = new Set<KindColorKey>(["ctor", "instance", "package"]);
export const edgeColorVar = (key: KindColorKey): string => kindVar(key, PALE_KINDS.has(key) ? "text" : "fill");
export function edgeColor(key: KindColorKey, theme: "light" | "dark"): string {
  const sw = KIND_PALETTE[key][theme];
  return PALE_KINDS.has(key) ? sw.text : sw.fill;
}
export const borderVar = (key: BorderKey): string => `var(--pf-border-${key})`;
export const uiVar = (key: UiColorKey): string => `var(--pf-${key})`;

const AXIOM_CLASS_KEY: Record<AxiomClass, KindColorKey> = {
  standard: "axiomStandard",
  sorry: "axiomSorry",
  nativeDecide: "axiomNative",
  custom: "axiomCustom",
};

export function axiomColorKey(name: string): KindColorKey {
  return AXIOM_CLASS_KEY[classifyAxiom(name)];
}

/** Header colour of a declaration node. */
export function kindColorKey(node: Pick<Node, "id" | "kind" | "subKind" | "flags">): KindColorKey {
  switch (node.kind) {
    case "axiom":
      return axiomColorKey(node.id);
    case "theorem":
      return node.subKind === "instance" || node.flags.instance ? "instance" : "theorem";
    case "definition":
      return node.subKind === "instance" || node.flags.instance ? "instance" : "definition";
    case "opaque":
      return "opaque";
    case "inductive":
      return "inductive";
    case "constructor":
    case "recursor":
      return "ctor";
    case "quot":
      return "quot";
  }
}

/** Short kind label shown in the node header. */
export function kindLabel(node: Pick<Node, "id" | "kind" | "subKind" | "flags">): string {
  if (node.kind === "axiom") {
    const c = classifyAxiom(node.id);
    return c === "standard" ? "axiom" : c === "sorry" ? "sorry axiom" : c === "nativeDecide" ? "native axiom" : "custom axiom";
  }
  if (node.subKind === "instance" || node.flags.instance) return "instance";
  if (node.kind === "inductive") return node.subKind === "structure" ? "structure" : node.subKind === "class" ? "class" : "inductive";
  if (node.kind === "definition") return node.subKind === "abbrev" ? "abbrev" : "def";
  if (node.kind === "constructor") return "ctor";
  return node.kind;
}

export function borderKey(taints: readonly Taint[]): BorderKey {
  const w = worstTaint(taints);
  if (w === null) return "clean";
  if (w === "sorry" || w === "customAxiom" || w === "nativeDecide") return w;
  return "flag";
}

function block(theme: "light" | "dark"): string {
  const lines: string[] = [];
  for (const [key, v] of Object.entries(KIND_PALETTE)) {
    lines.push(`--pf-kind-${key}-fill: ${v[theme].fill};`, `--pf-kind-${key}-text: ${v[theme].text};`);
  }
  for (const [key, v] of Object.entries(BORDER_PALETTE)) lines.push(`--pf-border-${key}: ${v[theme]};`);
  for (const [key, v] of Object.entries(UI_PALETTE)) lines.push(`--pf-${key}: ${v[theme]};`);
  lines.push(`color-scheme: ${theme};`);
  return lines.map((l) => `  ${l}`).join("\n");
}

/** `[data-kind]` and `[data-border]` hooks so components only set a data attribute. */
function selectors(): string {
  const lines: string[] = [];
  for (const key of Object.keys(KIND_PALETTE)) {
    lines.push(`[data-kind="${key}"] { --kind-fill: var(--pf-kind-${key}-fill); --kind-text: var(--pf-kind-${key}-text); }`);
  }
  for (const key of Object.keys(BORDER_PALETTE)) lines.push(`[data-border="${key}"] { --border: var(--pf-border-${key}); }`);
  return lines.join("\n");
}

/** The palette as CSS custom properties, light by default and dark under `prefers-color-scheme`. */
export function paletteCss(): string {
  return `:root {\n${block("light")}\n}\n@media (prefers-color-scheme: dark) {\n:root {\n${block("dark")}\n}\n}\n${selectors()}\n`;
}

/** Inject the palette once into `document.head`. */
export function ensurePaletteStyle(doc: Document = document): void {
  if (doc.getElementById("pf-palette")) return;
  const style = doc.createElement("style");
  style.id = "pf-palette";
  style.textContent = paletteCss();
  doc.head.appendChild(style);
}

/** Current theme, used when exporting SVG with concrete colours. */
export function currentTheme(win: Window = window): "light" | "dark" {
  try {
    return win.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

// WCAG 2.x relative luminance and contrast ratio.
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m?.[1]) throw new Error(`not a #rrggbb colour: ${hex}`);
  const v = parseInt(m[1], 16);
  return 0.2126 * channel((v >> 16) & 255) + 0.7152 * channel((v >> 8) & 255) + 0.0722 * channel(v & 255);
}
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
