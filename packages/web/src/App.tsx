import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import type { CheckerInfo, GraphFile } from "@proofflow/schema";
import { fetchCheckers, fetchGraph } from "./api/client";
import { Breadcrumb } from "./components/Breadcrumb";
import { GraphCanvas } from "./components/GraphCanvas";
import { Landing, loadSampleGraph } from "./components/Landing";
import { NodePanel } from "./components/NodePanel";
import { ScaleGuard } from "./components/ScaleGuard";
import { Stats } from "./components/Stats";
import { Toolbar, type LayoutStatus } from "./components/Toolbar";
import { currentTheme } from "./graph/colors";
import { buildCone, SCALE_LIMIT, type Cone, type ViewNode } from "./graph/cone";
import { coneToGraphFile, coneToSvg, downloadText, viewColorKey } from "./graph/exportView";
import { buildIndex, localSinksOf } from "./graph/graphIndex";
import { assignLayers } from "./graph/layers";
import { LayoutCancelled, runLayout, type LayoutResult } from "./graph/layout";
import { measureAll, type Size } from "./graph/measure";
import { AppContext, initialState, reducer, ServicesContext, useApp, type AppContextValue, type GraphSource, type Services } from "./state/appState";
import { HighlightStore } from "./state/highlight";
import { VerifyStore } from "./state/verifyStore";

const ALWAYS = (): boolean => true;

interface ShownLayout {
  cone: Cone;
  result: LayoutResult;
  sizes: Map<string, Size>;
}

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  return el.tagName === "INPUT" && !["checkbox", "radio", "button", "submit"].includes((el as HTMLInputElement).type);
}

function Workspace() {
  const { state, dispatch, index, highlight } = useApp();
  const rf = useReactFlow();
  const searchRef = useRef<HTMLInputElement>(null);
  const o = state.options;

  // Cone, layers and sizes depend only on targets and structural options, never on selection.
  const cone = useMemo(
    () =>
      index
        ? buildCone(index, { mode: state.mode, targets: state.targets, depthLimit: o.depthLimit, hideAux: o.hideAux, external: o.external, site: o.site })
        : null,
    [index, state.mode, state.targets, o.depthLimit, o.hideAux, o.external, o.site],
  );
  const tooBig = cone !== null && cone.nodes.length > SCALE_LIMIT;
  const layering = useMemo(() => {
    if (!cone || tooBig) return null;
    return assignLayers(
      cone.nodes.map((n) => n.id),
      cone.edges,
      (id) => {
        const v = cone.byId.get(id);
        return !!v && v.isTarget && v.decl?.kind !== "axiom";
      },
    );
  }, [cone, tooBig]);
  const sizes = useMemo(() => (cone && !tooBig ? measureAll(cone.nodes) : null), [cone, tooBig]);

  const [shown, setShown] = useState<ShownLayout | null>(null);
  const [status, setStatus] = useState<LayoutStatus>({ phase: "idle", nodes: 0 });
  useEffect(() => {
    if (!cone) return;
    if (tooBig) {
      setStatus({ phase: "guard", nodes: cone.nodes.length });
      return;
    }
    if (cone.nodes.length === 0) {
      setShown(null);
      setStatus({ phase: "empty", nodes: 0 });
      return;
    }
    if (!layering || !sizes) return;
    const ctrl = new AbortController();
    setStatus({ phase: "running", nodes: cone.nodes.length });
    const input = {
      nodes: cone.nodes.map((n) => {
        const s = sizes.get(n.id) ?? { width: 160, height: 74 };
        return { id: n.id, width: s.width, height: s.height, layer: layering.layer.get(n.id) ?? 0 };
      }),
      edges: cone.edges.filter((_e, k) => !layering.feedback.has(k)),
    };
    runLayout(input, { signal: ctrl.signal })
      .then((result) => {
        if (ctrl.signal.aborted) return;
        setShown({ cone, result, sizes });
        setStatus({ phase: "done", nodes: cone.nodes.length, engine: result.engine, ms: result.durationMs });
      })
      .catch((e: unknown) => {
        if (e instanceof LayoutCancelled || ctrl.signal.aborted) return;
        setStatus({ phase: "error", nodes: cone.nodes.length, error: e instanceof Error ? e.message : String(e) });
      });
    return () => ctrl.abort();
  }, [cone, tooBig, layering, sizes]);

  const matches = useMemo(() => {
    const tf = o.taintFilter;
    const kf = o.kindFilter;
    if (tf.length === 0 && kf.length === 0) return ALWAYS;
    return (v: ViewNode): boolean => (tf.length === 0 || v.taints.some((t) => tf.includes(t))) && (kf.length === 0 || kf.includes(viewColorKey(v)));
  }, [o.taintFilter, o.kindFilter]);

  useEffect(() => highlight.setSelected(state.selected), [highlight, state.selected]);

  const fit = useCallback(() => void rf.fitView({ padding: 0.08, maxZoom: 1.2, duration: 200 }), [rf]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        if (!isTyping(e.target)) {
          dispatch({ type: "select", id: null });
          highlight.setHover(null, null);
        }
        return;
      }
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        fit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch, highlight, fit]);

  const projectName = state.graph?.meta.project.name || "proofflow";
  const exportJson = (): void => {
    if (index && cone) downloadText(`${projectName}-cone.json`, "application/json", `${JSON.stringify(coneToGraphFile(index, cone), null, 2)}\n`);
  };
  const exportSvg = (): void => {
    if (shown) downloadText(`${projectName}-cone.svg`, "image/svg+xml", coneToSvg(shown.cone, shown.result, shown.sizes, currentTheme()));
  };

  return (
    <div className="pf-app">
      <Toolbar searchRef={searchRef} layout={status} canExport={shown !== null && !tooBig} onExportJson={exportJson} onExportSvg={exportSvg} onFit={fit} />
      <Breadcrumb cone={cone} />
      <div className="pf-main">
        <Stats />
        <section className="pf-center" aria-label="Dependency graph">
          {shown && !tooBig && status.phase !== "empty" && <GraphCanvas cone={shown.cone} layout={shown.result} sizes={shown.sizes} matches={matches} />}
          {tooBig && cone && <ScaleGuard cone={cone} />}
          {status.phase === "running" && !shown && (
            <div className="pf-overlay">
              <div className="pf-card pf-status is-busy">Layouting {status.nodes} nodes...</div>
            </div>
          )}
          {status.phase === "empty" && (
            <div className="pf-overlay">
              <div className="pf-card">
                <h2>Nothing to show</h2>
                <p>Search for a declaration with / or pick a final theorem on the left.</p>
              </div>
            </div>
          )}
          {status.phase === "error" && (
            <div className="pf-overlay">
              <div className="pf-card" role="alert">
                <h2>Layout failed</h2>
                <p className="pf-error">{status.error}</p>
              </div>
            </div>
          )}
        </section>
        <NodePanel cone={cone} layering={layering} />
      </div>
    </div>
  );
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const verify = useMemo(() => new VerifyStore(), []);
  const highlight = useMemo(() => new HighlightStore(), []);
  const [checkers, setCheckers] = useState<CheckerInfo[] | null>(null);
  const index = useMemo(() => (state.graph ? buildIndex(state.graph) : null), [state.graph]);

  const onGraph = useCallback(
    (graph: GraphFile, source: GraphSource, label: string) => {
      verify.reset();
      verify.enabled = source === "server";
      dispatch({ type: "loaded", graph, source, label, defaultTargets: localSinksOf(graph) });
    },
    [verify],
  );

  useEffect(() => {
    let cancelled = false;
    fetchGraph()
      .then((graph) => {
        if (cancelled) return;
        onGraph(graph, "server", "server");
        fetchCheckers()
          .then((c) => {
            verify.checkers = c;
            if (!cancelled) setCheckers(c);
          })
          .catch(() => {
            verify.checkers = null;
          });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        dispatch({ type: "landing", error: e instanceof Error ? e.message : String(e) });
        if (new URLSearchParams(window.location.search).has("sample")) {
          loadSampleGraph()
            .then((g) => {
              if (!cancelled) onGraph(g, "sample", "sample.json");
            })
            .catch(() => undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [onGraph, verify]);

  const serverMode = state.source === "server";
  const ctx = useMemo<AppContextValue>(
    () => ({ state, dispatch, index, verify, highlight, serverMode, checkers }),
    [state, index, verify, highlight, serverMode, checkers],
  );
  const services = useMemo<Services>(() => ({ dispatch, verify, highlight, serverMode }), [verify, highlight, serverMode]);

  return (
    <ServicesContext.Provider value={services}>
    <AppContext.Provider value={ctx}>
      {state.phase === "loading" && <div className="pf-loading">Loading graph...</div>}
      {state.phase === "landing" && <Landing serverError={state.loadError} onGraph={onGraph} />}
      {state.phase === "ready" && index && (
        <ReactFlowProvider>
          <Workspace />
        </ReactFlowProvider>
      )}
    </AppContext.Provider>
    </ServicesContext.Provider>
  );
}
