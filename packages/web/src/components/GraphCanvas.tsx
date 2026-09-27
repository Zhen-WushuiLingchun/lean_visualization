import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  getBezierPath,
  useReactFlow,
  useStore,
  useStoreApi,
  type Edge,
  type EdgeProps,
  type Node as FlowNode,
  type NodeMouseHandler,
  type NodeProps,
} from "@xyflow/react";
import { BORDER_PALETTE, KIND_PALETTE, UI_PALETTE, borderKey, currentTheme, edgeColor, edgeColorVar, kindVar, type KindColorKey } from "../graph/colors";
import { relatedInView, type Cone, type ViewNode } from "../graph/cone";
import { viewColorKey } from "../graph/exportView";
import { runFrameWork } from "../graph/frameWork";
import type { ViewSite } from "../graph/graphIndex";
import { fitViewportFor, layoutBounds, MIN_ZOOM, type LayoutResult } from "../graph/layout";
import { headerText, type Size } from "../graph/measure";
import { SpatialGrid, viewRect, type Box } from "../graph/spatial";
import { useApp, useServices } from "../state/appState";
import { useEdgeHighlight, useNodeHighlight } from "../state/highlight";
import { useBadge } from "../state/verifyStore";
import { TaintPill, VerifyBadge } from "./Badges";

interface PFNodeData extends Record<string, unknown> {
  view: ViewNode;
  colorKey: KindColorKey;
  filtered: boolean;
}

const LARGE_MIN_ZOOM = 0.0001;
const DETAIL_ZOOM = 0.65;
const NAME_ZOOM = 0.28;
const MAX_DETAIL_CARDS = 80;

/** Canvas uses the same React Flow viewport as toolbar fit and search navigation. */
function LargeGraphCanvas({ cone, layout, sizes, matches }: GraphCanvasProps) {
  const { dispatch, highlight, state } = useApp();
  const rf = useReactFlow();
  const store = useStoreApi();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const edgeCanvasRef = useRef<HTMLCanvasElement>(null);
  const miniRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);
  const edgeCancel = useRef<(() => void) | null>(null);
  const [detailNodes, setDetailNodes] = useState<PFNode[]>([]);
  const [edgeMode, setEdgeMode] = useState<"simplified" | "all">("simplified");
  const [edgeState, setEdgeState] = useState<"simplified" | "drawing" | "complete">("simplified");
  const [detailNote, setDetailNote] = useState(false);
  const grid = useMemo(() => new SpatialGrid(layout.positions, sizes), [layout, sizes]);
  const bounds = useMemo(() => layoutBounds(layout.positions, sizes), [layout, sizes]);
  const incident = useMemo(() => {
    const map = new Map<string, number[]>();
    cone.edges.forEach((e, i) => {
      let a = map.get(e.source);
      if (!a) map.set(e.source, (a = []));
      a.push(i);
      let b = map.get(e.target);
      if (!b) map.set(e.target, (b = []));
      b.push(i);
    });
    return map;
  }, [cone]);
  const paneW = useStore((s) => s.width);
  const paneH = useStore((s) => s.height);
  const zoomReady = useStore((s) => s.panZoom !== null);
  const fitted = useRef<LayoutResult | null>(null);
  useEffect(() => {
    if (!zoomReady || paneW <= 0 || paneH <= 0 || fitted.current === layout) return;
    fitted.current = layout;
    void rf.setViewport(fitViewportFor(bounds, paneW, paneH, LARGE_MIN_ZOOM), { duration: 0 });
  }, [bounds, layout, paneW, paneH, rf, zoomReady]);

  const selected = state.selected;
  useEffect(() => {
    if (!selected) return;
    const b = grid.byId.get(selected);
    if (!b) return;
    const timer = setTimeout(() => {
      void rf.setCenter(b.x + b.width / 2, b.y + b.height / 2, { zoom: Math.max(rf.getZoom(), 0.8), duration: 250 });
    }, 60);
    return () => clearTimeout(timer);
  }, [selected, grid, rf]);

  const draw = useCallback(() => {
    edgeCancel.current?.();
    edgeCancel.current = null;
    const canvas = canvasRef.current;
    const edgeCanvas = edgeCanvasRef.current;
    const host = hostRef.current;
    if (!canvas || !edgeCanvas || !host) return;
    const ctx = canvas.getContext("2d");
    const edgeCtx = edgeCanvas.getContext("2d");
    if (!ctx || !edgeCtx) return;
    const width = host.clientWidth, height = host.clientHeight;
    if (width <= 0 || height <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelW = Math.ceil(width * dpr), pixelH = Math.ceil(height * dpr);
    if (canvas.width !== pixelW || canvas.height !== pixelH) { canvas.width = pixelW; canvas.height = pixelH; }
    if (edgeCanvas.width !== pixelW || edgeCanvas.height !== pixelH) { edgeCanvas.width = pixelW; edgeCanvas.height = pixelH; }
    const [x, y, zoom] = store.getState().transform;
    const rect = viewRect({ x, y, zoom }, width, height, 16);
    const visible = grid.query(rect);
    const visibleIds = new Set(visible.map((b) => b.id));
    const theme = currentTheme();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    edgeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    edgeCtx.clearRect(0, 0, width, height);
    const stride = edgeMode === "all" ? 1 : Math.max(1, Math.ceil(cone.edges.length / 2500));
    const picked = new Set([...(incident.get(selected ?? "") ?? []), ...(incident.get(hoverId.current ?? "") ?? [])]);
    const drawEdge = (targetCtx: CanvasRenderingContext2D, index: number, exact: boolean): void => {
      const e = cone.edges[index];
      if (!e) return;
      const a = grid.byId.get(e.source), b = grid.byId.get(e.target);
      if (!a || !b) return;
      const sx = x + (a.x + a.width) * zoom, sy = y + (a.y + a.height / 2) * zoom;
      const tx = x + b.x * zoom, ty = y + (b.y + b.height / 2) * zoom;
      const bend = Math.max(12, Math.abs(tx - sx) * 0.4);
      const c1x = sx + bend, c2x = tx - bend;
      if (Math.max(sx, tx, c1x, c2x) < -16 || Math.min(sx, tx, c1x, c2x) > width + 16 || Math.max(sy, ty) < -16 || Math.min(sy, ty) > height + 16) return;
      targetCtx.strokeStyle = exact ? UI_PALETTE.accent[theme] : edgeColor(viewColorKey(cone.byId.get(e.source)), theme);
      targetCtx.globalAlpha = exact ? 0.9 : edgeMode === "all" ? 0.24 : 0.32;
      targetCtx.lineWidth = exact ? 2.8 : e.site === "both" ? 2.8 : 1;
      targetCtx.setLineDash(e.site === "proof" ? [5, 3] : e.site === "axiom" ? [2, 3] : []);
      targetCtx.beginPath();
      targetCtx.moveTo(sx, sy);
      targetCtx.bezierCurveTo(c1x, sy, c2x, ty, tx, ty);
      targetCtx.stroke();
    };
    for (const i of picked) drawEdge(ctx, i, true);
    ctx.setLineDash([]);
    if (edgeMode === "all") {
      setEdgeState("drawing");
      edgeCancel.current = runFrameWork(cone.edges.length, (i) => {
        if (!picked.has(i)) drawEdge(edgeCtx, i, false);
      }, () => {
        edgeCancel.current = null;
        edgeCtx.setLineDash([]);
        setEdgeState("complete");
      });
    } else {
      for (let i = 0; i < cone.edges.length; i += stride) if (!picked.has(i)) drawEdge(edgeCtx, i, false);
      edgeCtx.setLineDash([]);
      setEdgeState("simplified");
    }
    for (const b of visible) {
      const v = cone.byId.get(b.id);
      if (!v) continue;
      const sx = x + b.x * zoom, sy = y + b.y * zoom;
      const sw = Math.max(2, b.width * zoom), sh = Math.max(2, b.height * zoom);
      const key = viewColorKey(v);
      const faded = !matches(v);
      ctx.globalAlpha = faded ? 0.24 : v.isLocal ? 1 : 0.72;
      ctx.fillStyle = KIND_PALETTE[key][theme].fill;
      ctx.fillRect(sx, sy, sw, sh);
      if (zoom >= NAME_ZOOM && zoom < DETAIL_ZOOM) {
        ctx.fillStyle = KIND_PALETTE[key][theme].text;
        ctx.font = `${Math.max(10, Math.min(13, 12 * zoom + 7))}px system-ui`;
        const name = v.label.length > 30 ? `${v.label.slice(0, 27)}...` : v.label;
        ctx.fillText(name, sx + 5, sy + Math.min(sh - 3, 15), Math.max(0, sw - 10));
      }
      if (b.id === selected || b.id === hoverId.current || v.isTarget) {
        ctx.strokeStyle = b.id === selected || b.id === hoverId.current ? UI_PALETTE.text[theme] : UI_PALETTE.accent[theme];
        ctx.lineWidth = b.id === selected || b.id === hoverId.current ? 3 : 2;
        ctx.strokeRect(sx - 2, sy - 2, sw + 4, sh + 4);
      }
      ctx.strokeStyle = BORDER_PALETTE[borderKey(v.taints)][theme];
      ctx.lineWidth = zoom >= NAME_ZOOM ? 1.5 : 1;
      ctx.setLineDash(borderKey(v.taints) === "flag" ? [4, 3] : []);
      ctx.strokeRect(sx, sy, sw, sh);
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
    const mini = miniRef.current;
    const mctx = mini?.getContext("2d");
    if (mini && mctx && bounds.width > 0 && bounds.height > 0) {
      const mw = mini.clientWidth, mh = mini.clientHeight;
      mini.width = Math.ceil(mw * dpr); mini.height = Math.ceil(mh * dpr);
      mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      mctx.clearRect(0, 0, mw, mh);
      const mz = Math.min(mw / bounds.width, mh / bounds.height);
      const ox = (mw - bounds.width * mz) / 2 - bounds.x * mz;
      const oy = (mh - bounds.height * mz) / 2 - bounds.y * mz;
      for (const b of grid.byId.values()) {
        const v = cone.byId.get(b.id);
        if (!v) continue;
        mctx.fillStyle = KIND_PALETTE[viewColorKey(v)][theme].fill;
        mctx.fillRect(ox + b.x * mz, oy + b.y * mz, Math.max(1, b.width * mz), Math.max(1, b.height * mz));
      }
      mctx.strokeStyle = UI_PALETTE.accent[theme]; mctx.lineWidth = 1.5;
      mctx.strokeRect(ox + rect.x * mz, oy + rect.y * mz, rect.width * mz, rect.height * mz);
    }
    if (zoom >= DETAIL_ZOOM) {
      const cardBoxes = visible.slice(0, MAX_DETAIL_CARDS);
      const selectedBox = selected ? grid.byId.get(selected) : null;
      if (selectedBox && visibleIds.has(selectedBox.id) && !cardBoxes.some((b) => b.id === selectedBox.id)) cardBoxes[MAX_DETAIL_CARDS - 1] = selectedBox;
      setDetailNote(visible.length > MAX_DETAIL_CARDS);
      setDetailNodes((prev) => {
        const next = cardBoxes.map((b) => {
          const v = cone.byId.get(b.id) as ViewNode;
          return makeFlowNode(v, b, matches);
        });
        return prev.length === next.length && prev.every((n, i) => {
          const other = next[i];
          return other && n.id === other.id && n.position.x === other.position.x && n.position.y === other.position.y && n.data.filtered === other.data.filtered;
        }) ? prev : next;
      });
    } else {
      setDetailNote(false);
      setDetailNodes((prev) => prev.length ? [] : prev);
    }
  }, [bounds, cone, edgeMode, grid, incident, matches, selected, store]);

  const schedule = useCallback(() => {
    edgeCancel.current?.();
    edgeCancel.current = null;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => { frame.current = null; draw(); });
  }, [draw]);
  useEffect(() => {
    schedule();
    const unsub = store.subscribe((next, prev) => { if (next.transform !== prev.transform || next.width !== prev.width || next.height !== prev.height) schedule(); });
    const observer = new ResizeObserver(schedule);
    if (hostRef.current) observer.observe(hostRef.current);
    const onTheme = () => schedule();
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", onTheme);
    return () => {
      unsub(); observer.disconnect();
      window.matchMedia("(prefers-color-scheme: dark)").removeEventListener("change", onTheme);
      if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
      edgeCancel.current?.(); edgeCancel.current = null;
    };
  }, [schedule, store]);

  const relatedCache = useRef(new Map<string, Set<string>>());
  useEffect(() => { relatedCache.current.clear(); highlight.setHover(null, null); }, [cone, highlight]);
  const hoverId = useRef<string | null>(null);
  const atEvent = useCallback((e: React.MouseEvent): string | null => {
    const host = hostRef.current;
    if (!host) return null;
    const pane = host.getBoundingClientRect();
    const [x, y, zoom] = store.getState().transform;
    return grid.hit((e.clientX - pane.left - x) / zoom, (e.clientY - pane.top - y) / zoom, 3 / zoom)?.id ?? null;
  }, [grid, store]);
  const onMove = useCallback((e: React.MouseEvent) => {
    const id = atEvent(e);
    if (id === hoverId.current) return;
    hoverId.current = id;
    if (!id) { highlight.setHover(null, null); schedule(); return; }
    let rel = relatedCache.current.get(id);
    if (!rel) {
      rel = new Set([id]);
      for (const i of incident.get(id) ?? []) {
        const edge = cone.edges[i];
        if (edge) { rel.add(edge.source); rel.add(edge.target); }
      }
      if (relatedCache.current.size >= 16) relatedCache.current.clear();
      relatedCache.current.set(id, rel);
    }
    highlight.setHover(id, rel);
    schedule();
  }, [atEvent, cone, highlight, incident, schedule]);
  const onClick = useCallback((e: React.MouseEvent) => {
    const id = atEvent(e);
    if (id) dispatch({ type: "select", id });
  }, [atEvent, dispatch]);
  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    const id = atEvent(e);
    if (id && cone.byId.get(id)?.type === "decl") dispatch({ type: "setTargets", targets: [id] });
  }, [atEvent, cone, dispatch]);

  const isChrome = (e: React.MouseEvent): boolean => e.target instanceof Element && !!e.target.closest(".react-flow__controls, .pf-large-flow__notice, .pf-large-flow__minimap");
  const isCard = (e: React.MouseEvent): boolean => e.target instanceof Element && !!e.target.closest(".react-flow__node");
  const down = useRef<{ x: number; y: number } | null>(null);
  const wasDrag = (e: React.MouseEvent): boolean => !!down.current && Math.hypot(e.clientX - down.current.x, e.clientY - down.current.y) > 4;
  const onMiniClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    const mini = miniRef.current;
    if (!mini || bounds.width <= 0 || bounds.height <= 0) return;
    const r = mini.getBoundingClientRect();
    const mz = Math.min(r.width / bounds.width, r.height / bounds.height);
    const ox = (r.width - bounds.width * mz) / 2 - bounds.x * mz;
    const oy = (r.height - bounds.height * mz) / 2 - bounds.y * mz;
    void rf.setCenter((e.clientX - r.left - ox) / mz, (e.clientY - r.top - oy) / mz, { zoom: rf.getZoom(), duration: 200 });
  };
  return <div className="pf-large-flow" ref={hostRef} onMouseMove={(e) => { if (!isChrome(e)) onMove(e); }} onMouseLeave={() => { hoverId.current = null; highlight.setHover(null, null); schedule(); }} onMouseDown={(e) => { down.current = { x: e.clientX, y: e.clientY }; }} onClick={(e) => { if (!isChrome(e) && !isCard(e) && !wasDrag(e)) onClick(e); }} onDoubleClick={(e) => { if (!isChrome(e) && !isCard(e) && !wasDrag(e)) onDoubleClick(e); }}>
    <ReactFlow<PFNode, PFEdge> className="pf-flow" nodes={detailNodes} edges={[]} nodeTypes={nodeTypes}
      onNodeClick={(_e, n) => dispatch({ type: "select", id: n.id })}
      onNodeDoubleClick={(_e, n) => { if (n.data.view.type === "decl") dispatch({ type: "setTargets", targets: [n.id] }); }}
      nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} zoomOnDoubleClick={false}
      minZoom={LARGE_MIN_ZOOM} maxZoom={2.5} colorMode="system">
      <Background gap={24} size={1} />
      <Controls showInteractive={false} onFitView={() => void rf.setViewport(fitViewportFor(bounds, paneW, paneH, LARGE_MIN_ZOOM), { duration: 200 })} />
    </ReactFlow>
    <canvas ref={edgeCanvasRef} className="pf-large-flow__edges" aria-hidden="true" />
    <canvas ref={canvasRef} className="pf-large-flow__canvas" aria-hidden="true" />
    <canvas ref={miniRef} className="pf-large-flow__minimap" onClick={onMiniClick} title="Click to center the graph" aria-label="Graph minimap" />
    <div className="pf-large-flow__notice" data-edge-state={edgeState} onClick={(e) => e.stopPropagation()}>
      <span>{cone.nodes.length.toLocaleString()} nodes, {cone.edges.length.toLocaleString()} edges. {edgeState === "simplified" ? "Edges simplified; selected node links are exact." : edgeState === "drawing" ? "Drawing all edges..." : "All edges shown."}</span>
      <button type="button" onClick={() => setEdgeMode((m) => m === "all" ? "simplified" : "all")}>{edgeMode === "all" ? "Simplify edges" : "Show all edges"}</button>
      {detailNote && <span>Dense view: showing {MAX_DETAIL_CARDS} cards. Zoom in for more.</span>}
    </div>
  </div>;
}

function makeFlowNode(v: ViewNode, b: Box, matches: (v: ViewNode) => boolean): PFNode {
  const width = b.width, height = b.height;
  return {
    id: v.id, type: "pf", position: { x: b.x, y: b.y }, width, height,
    measured: { width, height },
    handles: [
      { type: "target", position: Position.Left, x: 0, y: height / 2 - 0.5, width: 1, height: 1 },
      { type: "source", position: Position.Right, x: width - 1, y: height / 2 - 0.5, width: 1, height: 1 },
    ],
    data: { view: v, colorKey: viewColorKey(v), filtered: !matches(v) },
    draggable: false, connectable: false, selectable: false,
  };
}
type PFNode = FlowNode<PFNodeData, "pf">;

interface PFEdgeData extends Record<string, unknown> {
  site: ViewSite;
  folded: boolean;
  colorKey: KindColorKey;
}
type PFEdge = Edge<PFEdgeData, "site">;

export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const ProofNode = memo(function ProofNode({ id, data }: NodeProps<PFNode>) {
  const { verify, highlight, serverMode } = useServices();
  const v = data.view;
  const badgeable = serverMode && v.type === "decl" && !v.isSynthetic;
  const autoFetch = badgeable && v.isLocal;
  const hl = useNodeHighlight(highlight, id);
  const badge = useBadge(verify, badgeable ? id : null);
  useEffect(() => {
    // Nodes mount when they become visible (onlyRenderVisibleElements): fetch cached results then.
    if (autoFetch) verify.requestCached(id);
  }, [autoFetch, verify, id]);

  const cls = ["pf-node"];
  if (!v.isLocal) cls.push("pf-node--external");
  if (v.isAux) cls.push("pf-node--aux");
  if (v.isTarget) cls.push("pf-node--target");
  if (data.filtered) cls.push("is-filtered");
  for (const s of hl.split(" ")) if (s) cls.push(`is-${s}`);
  const statement = v.decl ? (v.isSynthetic ? "not in graph.json" : oneLine(v.decl.statement)) : `${v.members.length} declarations`;
  return (
    <div className={cls.join(" ")} data-kind={data.colorKey} data-border={borderKey(v.taints)} title={v.id} data-testid="pf-node" data-id={v.id}>
      <Handle type="target" position={Position.Left} isConnectable={false} className="pf-handle" />
      <div className="pf-node__head">
        <span className="pf-node__kind">{headerText(v)}</span>
        {badgeable && <VerifyBadge badge={badge} />}
      </div>
      <div className="pf-node__name">{v.label}</div>
      <div className="pf-node__stmt">{statement}</div>
      <div className="pf-node__badges">
        {v.taints.map((t) => (
          <TaintPill key={t} taint={t} />
        ))}
        {v.truncated && (
          <span className="pf-more" title="More dependencies are cut by the depth limit">
            +deps
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} className="pf-handle" />
    </div>
  );
});

const SiteEdge = memo(function SiteEdge(props: EdgeProps<PFEdge>) {
  const { highlight } = useServices();
  const { source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  const hl = useEdgeHighlight(highlight, source, target);
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const site = data?.site ?? "stmt";
  return (
    <path
      d={path}
      className={`pf-edge pf-edge--${site}${hl ? ` is-${hl}` : ""}`}
      style={{ stroke: edgeColorVar(data?.colorKey ?? "package") }}
    />
  );
});

const nodeTypes = { pf: ProofNode };
const edgeTypes = { site: SiteEdge };

export interface GraphCanvasProps {
  cone: Cone;
  layout: LayoutResult;
  sizes: Map<string, Size>;
  /** Taint/kind highlight filter; non-matching nodes are dimmed. */
  matches: (v: ViewNode) => boolean;
}

export function usesLargeGraphCanvas(cone: Pick<Cone, "nodes" | "edges">): boolean {
  return cone.nodes.length > 1500 || cone.edges.length > 10_000;
}

export function canvasMinZoom(cone: Pick<Cone, "nodes" | "edges">): number {
  return usesLargeGraphCanvas(cone) ? LARGE_MIN_ZOOM : MIN_ZOOM;
}

export function GraphCanvas(props: GraphCanvasProps) {
  return usesLargeGraphCanvas(props.cone)
    ? <LargeGraphCanvas {...props} />
    : <SmallGraphCanvas {...props} />;
}

function SmallGraphCanvas({ cone, layout, sizes, matches }: GraphCanvasProps) {
  const { dispatch, highlight, state } = useApp();
  const rf = useReactFlow();

  const nodes = useMemo<PFNode[]>(
    () =>
      cone.nodes.map((v) => {
        const size = sizes.get(v.id) ?? { width: 160, height: 74 };
        const { width, height } = size;
        return {
          id: v.id,
          type: "pf",
          position: layout.positions.get(v.id) ?? { x: 0, y: 0 },
          width,
          height,
          // Sizes are measured before layout and the node renders at exactly this size. Declaring
          // them (and the handles) lets fitView and edges work for nodes culled by
          // onlyRenderVisibleElements, which are never measured in the DOM.
          measured: { width, height },
          handles: [
            { type: "target", position: Position.Left, x: 0, y: height / 2 - 0.5, width: 1, height: 1 },
            { type: "source", position: Position.Right, x: width - 1, y: height / 2 - 0.5, width: 1, height: 1 },
          ],
          data: { view: v, colorKey: viewColorKey(v), filtered: !matches(v) },
          draggable: false,
          connectable: false,
          selectable: false,
        };
      }),
    [cone, layout, sizes, matches],
  );
  const edges = useMemo<PFEdge[]>(
    () =>
      cone.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: "site",
        data: { site: e.site, folded: e.folded, colorKey: viewColorKey(cone.byId.get(e.source)) },
        selectable: false,
        focusable: false,
      })),
    [cone],
  );

  // Fit once per new layout, never on selection. The viewport is computed from the known layout
  // bounds and applied with setViewport as soon as React Flow has a pan-zoom instance and a pane
  // size. (xyflow's own fitView is queued behind node measurement and silently dropped when it
  // fires before the pan-zoom exists; with 1000+ nodes that left the canvas unfitted and empty.)
  const paneW = useStore((s) => s.width);
  const paneH = useStore((s) => s.height);
  const zoomReady = useStore((s) => s.panZoom !== null);
  const bounds = useMemo(() => layoutBounds(layout.positions, sizes), [layout, sizes]);
  const fitted = useRef<LayoutResult | null>(null);
  useEffect(() => {
    if (!zoomReady || paneW <= 0 || paneH <= 0 || fitted.current === layout) return;
    fitted.current = layout;
    void rf.setViewport(fitViewportFor(bounds, paneW, paneH), { duration: 0 });
  }, [layout, bounds, zoomReady, paneW, paneH, rf]);

  // Keep the selected node on screen when the panel opens and narrows the canvas (pan only, same zoom).
  const selected = state.selected;
  useEffect(() => {
    if (!selected) return;
    const t = setTimeout(() => {
      const b = layout.positions.get(selected);
      const size = sizes.get(selected);
      const pane = document.querySelector(".pf-flow")?.getBoundingClientRect();
      if (!b || !size || !pane) return;
      const tl = rf.flowToScreenPosition(b);
      const br = rf.flowToScreenPosition({ x: b.x + size.width, y: b.y + size.height });
      const inside = tl.x >= pane.left && tl.y >= pane.top && br.x <= pane.right && br.y <= pane.bottom;
      if (!inside) void rf.setCenter(b.x + size.width / 2, b.y + size.height / 2, { zoom: rf.getZoom(), duration: 250 });
    }, 60);
    return () => clearTimeout(t);
  }, [selected, rf, layout, sizes]);

  const relatedCache = useRef(new Map<string, Set<string>>());
  useEffect(() => {
    relatedCache.current = new Map();
    highlight.setHover(null, null);
  }, [cone, highlight]);

  const onEnter = useCallback<NodeMouseHandler<PFNode>>(
    (_e, n) => {
      let rel = relatedCache.current.get(n.id);
      if (!rel) {
        rel = relatedInView(cone, n.id);
        if (relatedCache.current.size >= 32) relatedCache.current.clear();
        relatedCache.current.set(n.id, rel);
      }
      highlight.setHover(n.id, rel);
    },
    [cone, highlight],
  );
  const onLeave = useCallback<NodeMouseHandler<PFNode>>(() => highlight.setHover(null, null), [highlight]);
  const onClick = useCallback<NodeMouseHandler<PFNode>>((_e, n) => dispatch({ type: "select", id: n.id }), [dispatch]);
  const onDoubleClick = useCallback<NodeMouseHandler<PFNode>>(
    (_e, n) => {
      if (n.data.view.type === "decl") dispatch({ type: "setTargets", targets: [n.id] });
    },
    [dispatch],
  );

  return (
    <ReactFlow<PFNode, PFEdge>
      className="pf-flow"
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodeClick={onClick}
      onNodeDoubleClick={onDoubleClick}
      onNodeMouseEnter={onEnter}
      onNodeMouseLeave={onLeave}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      zoomOnDoubleClick={false}
      onlyRenderVisibleElements
      minZoom={MIN_ZOOM}
      maxZoom={2.5}
      colorMode="system"
    >
      <Background gap={24} size={1} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeColor={(n) => kindVar((n.data as PFNodeData).colorKey, "fill")} nodeStrokeWidth={0} />
    </ReactFlow>
  );
}
