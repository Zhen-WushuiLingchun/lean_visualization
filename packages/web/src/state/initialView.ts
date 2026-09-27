import type { GraphIndex } from "../graph/graphIndex";
import type { ViewMode } from "../graph/cone";

/** Large projects open with every local declaration visible. */
export const PROJECT_DEFAULT_THRESHOLD = 600;

/**
 * Small projects open on all final theorems; large projects open on all local declarations.
 */
export function initialView(index: GraphIndex): { initialTargets: string[]; mode: ViewMode } {
  return { initialTargets: index.localSinks, mode: index.localIds.length > PROJECT_DEFAULT_THRESHOLD ? "project" : "cone" };
}
