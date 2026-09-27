import { kindLabel } from "./colors";
import type { ViewNode } from "./cone";

/**
 * Node sizes are measured before layout. Height is fixed per variant; width follows the label,
 * measured with a canvas in the same font the node uses (see `.pf-node` in styles.css).
 */

export const NODE_FONT_PX = 12;
export const NODE_HEIGHT = 80;
export const NODE_MIN_WIDTH = 160;
export const NODE_MAX_WIDTH = 300;
export const NODE_PAD_X = 10;
/** Aux nodes are drawn at 70 % scale. */
export const AUX_SCALE = 0.7;
export const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif';

const NAME_FONT = `600 13px ${FONT_STACK}`;
const HEAD_FONT = `600 10.5px ${FONT_STACK}`;

type Ctx = { font: string; measureText(text: string): { width: number } };
let ctx: Ctx | null | undefined;

function getCtx(): Ctx | null {
  if (ctx !== undefined) return ctx;
  ctx = null;
  try {
    if (typeof OffscreenCanvas !== "undefined") ctx = new OffscreenCanvas(1, 1).getContext("2d");
  } catch {
    ctx = null;
  }
  return ctx;
}

export function textWidth(text: string, font: string, px: number): number {
  const c = getCtx();
  if (c) {
    c.font = font;
    return c.measureText(text).width;
  }
  return text.length * px * 0.62;
}

export function headerText(v: ViewNode): string {
  if (v.type === "package") return `external package · ${v.members.length}`;
  const kind = v.decl ? kindLabel(v.decl) : "";
  return v.isLocal ? kind : `${kind} · ${v.package}`;
}

export interface Size {
  width: number;
  height: number;
}

export function nodeSize(v: ViewNode): Size {
  const scale = v.isAux ? AUX_SCALE : 1;
  const nameW = textWidth(v.label, NAME_FONT, 13);
  // Header also holds the verification badge (about 22 px).
  const headW = textWidth(headerText(v), HEAD_FONT, 10.5) + 26;
  const inner = Math.max(nameW, headW);
  const width = Math.min(NODE_MAX_WIDTH, Math.max(NODE_MIN_WIDTH, Math.ceil(inner + 2 * NODE_PAD_X + 6)));
  return { width: Math.round(width * scale), height: Math.round(NODE_HEIGHT * scale) };
}

export function measureAll(nodes: readonly ViewNode[]): Map<string, Size> {
  const out = new Map<string, Size>();
  for (const n of nodes) out.set(n.id, nodeSize(n));
  return out;
}
