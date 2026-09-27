import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ReactFlowProvider, useReactFlow, useStoreApi } from "@xyflow/react";
import type { CheckerInfo, GraphFile } from "@proofflow/schema";
import { fetchCheckers, fetchGraph } from "./api/client";
import { Breadcrumb } from "./components/Breadcrumb";
import { canvasMinZoom, GraphCanvas } from "./components/GraphCanvas";
import { Landing, loadSampleGraph } from "./components/Landing";
import { NodePanel } from "./components/NodePanel";
import { Stats } from "./components/Stats";
import { Toolbar, type LayoutStatus } from "./components/Toolbar";
import { currentTheme } from "./graph/colors";
import { type ConeOptions, type ViewNode } from "./graph/cone";
import { coneToGraphFile, coneToSvg, downloadText, viewColorKey } from "./graph/exportView";
import { buildIndex } from "./graph/graphIndex";
import { chooseEngine, fitViewportFor, layoutBounds } from "./graph/layout";
import { prepareView, ViewPipeline, type PreparedView } from "./graph/viewPipeline";
import { AppContext, initialState, reducer, ServicesContext, useApp, type AppContextValue, type GraphSource, type Services } from "./state/appState";
import { HighlightStore } from "./state/highlight";
import { initialView } from "./state/initialView";
import { VerifyStore } from "./state/verifyStore";

const ALWAYS = (): boolean => true;

interface ShownLayout {
  key: string;
  view: PreparedView;
}

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  return el.tagName === "INPUT" && !["checkbox", "radio", "button", "submit"].includes((el as HTMLInputElement).type);
}

function Workspace() {
  const { state, dispatch, index, highlight } = useApp();
  const rf = useReactFlow();
  const store = useStoreApi();
  const searchRef = useRef<HTMLInputElement>(null);
  const o = state.options;

  const options = useMemo<ConeOptions>(
    () => ({ mode: state.mode, targets: state.targets, depthLimit: o.depthLimit, hideAux: o.hideAux, external: o.external, site: o.site }),
    [state.mode, state.targets, o.depthLimit, o.hideAux, o.external, o.site],
  );
  const viewKey = useMemo(() => JSON.stringify([options, o.layoutChoice]), [options, o.layoutChoice]);
  const pipeline = useMemo(() => state.graph && index ? new ViewPipeline(state.graph, index) : null, [state.graph, index]);
  useEffect(() => () => pipeline?.stop(), [pipeline]);
  const [shown, setShown] = useState<ShownLayout | null>(null);
  const [status, setStatus] = useState<LayoutStatus>({ phase: "idle", nodes: 0 });
  const current = shown?.key === viewKey ? shown.view : null;
  const cone = current?.cone ?? null;
  const layering = current?.layering ?? null;
  useEffect(() => {
    if (!index) return;
    const ctrl = new AbortController();
    const estimate = options.mode === "project" ? index.localIds.length : options.targets.length;
    setShown(null);
    setStatus({ phase: "running", nodes: estimate, engine: chooseEngine(o.layoutChoice, estimate) });
    const useWorker = typeof Worker !== "undefined" && pipeline;
    const task = useWorker ? pipeline.prepare(options, o.layoutChoice, ctrl.signal) :
      index.byId.size <= 600 ? prepareView(index, options, o.layoutChoice) : Promise.reject(new Error("A Web Worker is required to open this large graph"));
    task
      .then((view) => {
        if (ctrl.signal.aborted) return;
        if (view.cone.nodes.length === 0) {
          setStatus({ phase: "empty", nodes: 0 });
          return;
        }
        setShown({ key: viewKey, view });
        setStatus({ phase: "done", nodes: view.cone.nodes.length, engine: view.result.engine, ms: view.result.durationMs });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setStatus({ phase: "error", nodes: estimate, error: e instanceof Error ? e.message : String(e) });
      });
    return () => ctrl.abort();
  }, [index, pipeline, options, o.layoutChoice, viewKey]);

  const matches = useMemo(() => {
    const tf = o.taintFilter;
    const kf = o.kindFilter;
    if (tf.length === 0 && kf.length === 0) return ALWAYS;
    return (v: ViewNode): boolean => (tf.length === 0 || v.taints.some((t) => tf.includes(t))) && (kf.length === 0 || kf.includes(viewColorKey(v)));
  }, [o.taintFilter, o.kindFilter]);

  useEffect(() => highlight.setSelected(state.selected), [highlight, state.selected]);

  // Deterministic fit from the known layout bounds (same function as the automatic fit in GraphCanvas).
  const fit = useCallback(() => {
    if (!current) return;
    const { width, height } = store.getState();
    void rf.setViewport(fitViewportFor(layoutBounds(current.result.positions, current.sizes), width, height, canvasMinZoom(current.cone)), { duration: 200 });
  }, [rf, store, current]);
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
    if (current) downloadText(`${projectName}-cone.svg`, "image/svg+xml", coneToSvg(current.cone, current.result, current.sizes, currentTheme()));
  };

  return (
    <div className="pf-app">
      <Toolbar searchRef={searchRef} layout={status} visibleIds={cone?.byId} canExport={current !== null} onExportJson={exportJson} onExportSvg={exportSvg} onFit={fit} />
      <Breadcrumb cone={cone} />
      <div className="pf-main">
        <Stats />
        <section className="pf-center" aria-label="Dependency graph">
          {current && status.phase !== "empty" && <GraphCanvas cone={current.cone} layout={current.result} sizes={current.sizes} matches={matches} />}
          {status.phase === "running" && !current && (
            <div className="pf-overlay">
              <div className="pf-card pf-status is-busy">
                Layouting {status.nodes} nodes ({status.engine === "fast" ? "fast layout" : "ELK"})...
              </div>
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
  const index = state.index;

  const onGraph = useCallback(
    (graph: GraphFile, source: GraphSource, label: string) => {
      verify.reset();
      verify.enabled = source === "server";
      const idx = buildIndex(graph, { metadataOnly: typeof Worker !== "undefined" });
      const { initialTargets, mode } = initialView(idx);
      dispatch({ type: "loaded", graph, index: idx, source, label, defaultTargets: idx.localSinks, initialTargets, narrowed: null, initialMode: mode });
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
