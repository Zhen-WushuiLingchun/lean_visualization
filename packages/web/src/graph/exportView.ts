import { edgesOf, type GraphFile, type Node } from "@proofflow/schema";
import { getBezierPath, Position } from "@xyflow/react";
import { BORDER_PALETTE, KIND_PALETTE, UI_PALETTE, borderKey, edgeColor, kindColorKey, type KindColorKey } from "./colors";
import type { Cone, ViewNode } from "./cone";
import type { GraphIndex } from "./graphIndex";
import type { LayoutResult } from "./layout";
import { headerText, type Size } from "./measure";

/**
 * The displayed cone as a valid `GraphFile` (schema-checked by the caller's tests), so it can be
 * loaded back into the viewer. It contains every real declaration in the closure, including folded
 * aux and collapsed external nodes; synthetic axiom nodes are not written.
 */
export function coneToGraphFile(index: GraphIndex, cone: Cone): GraphFile {
  const ids = new Set(cone.closureIds.filter((id) => !index.synthetic.has(id)));
  const nodes: Node[] = index.file.nodes.filter((n) => ids.has(n.id));
  const edges = edgesOf({ nodes });
  const local = nodes.filter((n) => n.isLocal);
  const localSet = new Set(local.map((n) => n.id));
  const usedByLocal = new Set<string>();
  for (const e of edges) if (localSet.has(e.target)) usedByLocal.add(e.source);
  const byKind: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const n of nodes) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
  const byTaint: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const n of local) for (const t of n.taints) byTaint[t] = (byTaint[t] ?? 0) + 1;
  return {
    meta: index.file.meta,
    stats: {
      nodes: nodes.length,
      localNodes: local.length,
      externalNodes: nodes.length - local.length,
      edges: edges.length,
      byKind: { ...byKind },
      byTaint: { ...byTaint },
      localSinks: local.filter((n) => !usedByLocal.has(n.id)).map((n) => n.id),
      axiomNodes: nodes.filter((n) => n.kind === "axiom").map((n) => n.id),
    },
    nodes,
  };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function clip(s: string, maxChars: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > maxChars ? `${one.slice(0, Math.max(0, maxChars - 3))}...` : one;
}

export function viewColorKey(v: ViewNode | undefined): KindColorKey {
  if (!v || v.type === "package" || !v.decl) return "package";
  return kindColorKey(v.decl);
}

/**
 * Serialise the laid-out cone as a standalone SVG with concrete colours for the given theme
 * (xyflow's `toPng` needs html-to-image, which the dependency policy does not allow).
 */
export function coneToSvg(cone: Cone, layout: LayoutResult, sizes: Map<string, Size>, theme: "light" | "dark"): string {
  const pad = 24;
  const W = Math.ceil(layout.width + 2 * pad);
  const H = Math.ceil(layout.height + 2 * pad);
  const ui = (k: keyof typeof UI_PALETTE): string => UI_PALETTE[k][theme];
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif">`,
    `<rect width="100%" height="100%" fill="${ui("canvas")}"/>`,
    `<g transform="translate(${pad},${pad})">`,
  );
  const box = (id: string): { x: number; y: number; w: number; h: number } | null => {
    const p = layout.positions.get(id);
    const s = sizes.get(id);
    return p && s ? { x: p.x, y: p.y, w: s.width, h: s.height } : null;
  };
  out.push(`<g fill="none">`);
  for (const e of cone.edges) {
    const a = box(e.source);
    const b = box(e.target);
    if (!a || !b) continue;
    const [d] = getBezierPath({
      sourceX: a.x + a.w,
      sourceY: a.y + a.h / 2,
      sourcePosition: Position.Right,
      targetX: b.x,
      targetY: b.y + b.h / 2,
      targetPosition: Position.Left,
    });
    const colour = edgeColor(viewColorKey(cone.byId.get(e.source)), theme);
    const width = e.site === "both" ? 2.8 : 1.4;
    const dash = e.site === "proof" ? ` stroke-dasharray="6 4"` : e.site === "axiom" ? ` stroke-dasharray="1.5 3.5" stroke-linecap="round"` : "";
    out.push(`<path d="${d}" stroke="${colour}" stroke-opacity="0.6" stroke-width="${width}"${dash}/>`);
  }
  out.push(`</g>`);
  cone.nodes.forEach((v, i) => {
    const b = box(v.id);
    if (!b) return;
    const scale = v.isAux ? 0.7 : 1;
    const clipId = `c${v.id.replace(/[^A-Za-z0-9_-]/g, "_")}_${i}`;
    const kind = KIND_PALETTE[viewColorKey(v)][theme];
    const bk = borderKey(v.taints);
    const border = BORDER_PALETTE[bk];
    const headH = 21 * scale;
    const fill = v.isLocal ? ui("surface") : ui("surface2");
    const chars = Math.floor((b.w - 16 * scale) / (6.4 * scale));
    out.push(
      `<g transform="translate(${b.x.toFixed(1)},${b.y.toFixed(1)})">`,
      `<title>${esc(v.id)}</title>`,
      `<clipPath id="${clipId}"><rect width="${b.w}" height="${b.h}" rx="6"/></clipPath>`,
      `<rect width="${b.w}" height="${b.h}" rx="6" fill="${fill}"/>`,
      `<rect width="${b.w}" height="${headH.toFixed(1)}" fill="${kind.fill}" clip-path="url(#${clipId})"/>`,
      `<rect x="1" y="1" width="${b.w - 2}" height="${b.h - 2}" rx="6" fill="none" stroke="${border[theme]}" stroke-width="2"${border.dashed ? ` stroke-dasharray="5 3"` : ""}/>`,
      `<text x="${(9 * scale).toFixed(1)}" y="${(14.5 * scale).toFixed(1)}" font-size="${(10.5 * scale).toFixed(1)}" font-weight="600" fill="${kind.text}">${esc(clip(headerText(v), chars + 4))}</text>`,
      `<text x="${(9 * scale).toFixed(1)}" y="${(38 * scale).toFixed(1)}" font-size="${(13 * scale).toFixed(1)}" font-weight="600" fill="${ui("text")}"${v.isLocal ? "" : ` font-style="italic"`}>${esc(clip(v.label, chars))}</text>`,
      `<text x="${(9 * scale).toFixed(1)}" y="${(55 * scale).toFixed(1)}" font-size="${(11 * scale).toFixed(1)}" font-family="ui-monospace, Consolas, monospace" fill="${ui("muted")}">${esc(clip(v.decl?.statement ?? `${v.members.length} declarations`, chars))}</text>`,
    );
    if (v.taints.length > 0) {
      out.push(
        `<text x="${(9 * scale).toFixed(1)}" y="${(69 * scale).toFixed(1)}" font-size="${(9.5 * scale).toFixed(1)}" font-weight="600" fill="${border[theme]}">${esc(clip(v.taints.join(" "), chars + 6))}</text>`,
      );
    }
    out.push(`</g>`);
  });
  out.push(`</g></svg>`);
  return out.join("\n");
}

/** Trigger a browser download of a text file. */
export function downloadText(filename: string, mime: string, text: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
