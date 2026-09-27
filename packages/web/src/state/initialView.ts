import { buildCone } from "../graph/cone";
import type { GraphIndex } from "../graph/graphIndex";
import { DEFAULT_OPTIONS, type Narrowed } from "./appState";

/** Above this many visible nodes, the default view (all final theorems) is narrowed on load. */
export const NARROW_THRESHOLD = 600;
/** How many final theorems the narrowed default view starts with (in `stats.localSinks` order). */
export const NARROW_COUNT = 12;

/**
 * Targets to open with: every final theorem, unless their cone under the default options exceeds
 * `NARROW_THRESHOLD` visible nodes, in which case only the first `NARROW_COUNT` are shown.
 */
export function initialView(index: GraphIndex): { initialTargets: string[]; narrowed: Narrowed | null } {
  const sinks = index.localSinks;
  if (sinks.length <= NARROW_COUNT) return { initialTargets: sinks, narrowed: null };
  const o = DEFAULT_OPTIONS;
  const cone = buildCone(index, { mode: "cone", targets: sinks, depthLimit: o.depthLimit, hideAux: o.hideAux, external: o.external, site: o.site });
  if (cone.nodes.length <= NARROW_THRESHOLD) return { initialTargets: sinks, narrowed: null };
  const first = sinks.slice(0, NARROW_COUNT);
  return { initialTargets: first, narrowed: { targets: first, total: sinks.length } };
}
