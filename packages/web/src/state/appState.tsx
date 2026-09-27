import { createContext, useContext, type Dispatch } from "react";
import type { CheckerInfo, GraphFile, Taint } from "@proofflow/schema";
import type { ExternalMode, SiteFilter, ViewMode } from "../graph/cone";
import type { KindColorKey } from "../graph/colors";
import type { GraphIndex } from "../graph/graphIndex";
import type { LayoutChoice } from "../graph/layout";
import type { HighlightStore } from "./highlight";
import type { VerifyStore } from "./verifyStore";

export type GraphSource = "server" | "file" | "sample";

export interface ViewOptions {
  depthLimit: number | null;
  hideAux: boolean;
  external: ExternalMode;
  site: SiteFilter;
  /** Highlight filters: nodes that do not match are dimmed, the layout is unchanged. */
  taintFilter: Taint[];
  /** Highlight only these header colours; empty means all. */
  kindFilter: KindColorKey[];
  /** Layout engine: auto picks ELK for small cones and the fast layered layout for big ones. */
  layoutChoice: LayoutChoice;
}

/** Set when the default view (all final theorems) was too big and only the first few are shown. */
export interface Narrowed {
  targets: string[];
  total: number;
}

export interface TargetState {
  mode: ViewMode;
  targets: string[];
}

export interface AppState {
  phase: "loading" | "landing" | "ready";
  source: GraphSource | null;
  sourceLabel: string;
  /** Why the server graph could not be loaded (shown on the landing panel). */
  loadError: string | null;
  graph: GraphFile | null;
  /** Built once per loaded graph. */
  index: GraphIndex | null;
  /** All final theorems (local sinks). */
  defaultTargets: string[];
  narrowed: Narrowed | null;
  mode: ViewMode;
  targets: string[];
  /** Previous target sets, oldest first (breadcrumb). */
  history: TargetState[];
  options: ViewOptions;
  selected: string | null;
}

export const DEFAULT_OPTIONS: ViewOptions = {
  depthLimit: null,
  hideAux: true,
  external: "collapse",
  site: "all",
  taintFilter: [],
  kindFilter: [],
  layoutChoice: "auto",
};

export const initialState: AppState = {
  phase: "loading",
  source: null,
  sourceLabel: "",
  loadError: null,
  graph: null,
  index: null,
  defaultTargets: [],
  narrowed: null,
  mode: "cone",
  targets: [],
  history: [],
  options: DEFAULT_OPTIONS,
  selected: null,
};

export type Action =
  | {
      type: "loaded";
      graph: GraphFile;
      index: GraphIndex;
      source: GraphSource;
      label: string;
      defaultTargets: string[];
      initialTargets: string[];
      narrowed: Narrowed | null;
      initialMode?: ViewMode;
    }
  | { type: "landing"; error: string | null }
  | { type: "unload" }
  | { type: "setTargets"; targets: string[] }
  | { type: "addTarget"; id: string }
  | { type: "removeTarget"; id: string }
  | { type: "resetTargets" }
  | { type: "setMode"; mode: ViewMode }
  | { type: "back"; index: number }
  | { type: "setOptions"; patch: Partial<ViewOptions> }
  | { type: "select"; id: string | null };

const HISTORY_LIMIT = 20;

function sameTargets(a: TargetState, b: TargetState): boolean {
  return a.mode === b.mode && a.targets.length === b.targets.length && a.targets.every((t, i) => t === b.targets[i]);
}

function navigate(state: AppState, next: TargetState): AppState {
  const cur: TargetState = { mode: state.mode, targets: state.targets };
  if (sameTargets(cur, next)) return state;
  const history = [...state.history, cur].slice(-HISTORY_LIMIT);
  return { ...state, mode: next.mode, targets: next.targets, history };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "loaded":
      return {
        ...initialState,
        phase: "ready",
        graph: action.graph,
        index: action.index,
        source: action.source,
        sourceLabel: action.label,
        defaultTargets: action.defaultTargets,
        narrowed: action.narrowed,
        mode: action.initialMode ?? "cone",
        targets: action.initialTargets,
      };
    case "landing":
      return { ...initialState, phase: "landing", loadError: action.error };
    case "unload":
      return { ...initialState, phase: "landing", loadError: state.loadError };
    case "setTargets":
      return navigate(state, { mode: "cone", targets: [...new Set(action.targets)] });
    case "addTarget":
      if (state.mode === "cone" && state.targets.includes(action.id)) return state;
      return navigate(state, { mode: "cone", targets: state.mode === "cone" ? [...state.targets, action.id] : [action.id] });
    case "removeTarget":
      return navigate(state, { mode: "cone", targets: state.targets.filter((t) => t !== action.id) });
    case "resetTargets":
      return navigate(state, { mode: "cone", targets: state.defaultTargets });
    case "setMode":
      if (action.mode === state.mode) return state;
      if (action.mode === "project") {
        const next = navigate(state, { mode: "project", targets: state.targets });
        return { ...next, options: { ...next.options, external: "collapse" } };
      }
      return navigate(state, { mode: "cone", targets: state.targets.length ? state.targets : state.defaultTargets });
    case "back": {
      const entry = state.history[action.index];
      if (!entry) return state;
      return { ...state, mode: entry.mode, targets: entry.targets, history: state.history.slice(0, action.index) };
    }
    case "setOptions":
      return { ...state, options: { ...state.options, ...action.patch } };
    case "select":
      return state.selected === action.id ? state : { ...state, selected: action.id };
  }
}

export interface AppContextValue {
  state: AppState;
  dispatch: Dispatch<Action>;
  index: GraphIndex | null;
  verify: VerifyStore;
  highlight: HighlightStore;
  /** True when the graph came from the server; verification needs it. */
  serverMode: boolean;
  checkers: CheckerInfo[] | null;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside AppContext");
  return ctx;
}

/**
 * Stable services for per-node components. Its value changes only when the graph source changes,
 * so selecting or filtering does not re-render every node and edge.
 */
export interface Services {
  dispatch: Dispatch<Action>;
  verify: VerifyStore;
  highlight: HighlightStore;
  serverMode: boolean;
}

export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const ctx = useContext(ServicesContext);
  if (!ctx) throw new Error("useServices outside ServicesContext");
  return ctx;
}

export const STANDALONE_REASON =
  "Verification needs the ProofFlow server. This graph was loaded from a file. Run: pnpm proofflow serve --project <dir>";
