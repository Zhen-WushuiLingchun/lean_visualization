import { memo, useCallback, useEffect, useMemo, useRef } from "react";
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
  type Edge,
  type EdgeProps,
  type Node as FlowNode,
  type NodeMouseHandler,
  type NodeProps,
} from "@xyflow/react";
import { borderKey, edgeColorVar, kindVar, type KindColorKey } from "../graph/colors";
import { relatedInView, type Cone, type ViewNode } from "../graph/cone";
import { viewColorKey } from "../graph/exportView";
import type { ViewSite } from "../graph/graphIndex";
import { fitViewportFor, layoutBounds, MIN_ZOOM, type LayoutResult } from "../graph/layout";
import { headerText, type Size } from "../graph/measure";
import { useApp, useServices } from "../state/appState";
import { useEdgeHighlight, useNodeHighlight } from "../state/highlight";
import { useBadge } from "../state/verifyStore";
import { TaintPill, VerifyBadge } from "./Badges";

interface PFNodeData extends Record<string, unknown> {
  view: ViewNode;
  colorKey: KindColorKey;
  filtered: boolean;
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

export function GraphCanvas({ cone, layout, sizes, matches }: GraphCanvasProps) {
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
      const n = rf.getInternalNode(selected);
      const pane = document.querySelector(".pf-flow")?.getBoundingClientRect();
      if (!n || !pane) return;
      const w = n.measured.width ?? 0;
      const h = n.measured.height ?? 0;
      const tl = rf.flowToScreenPosition(n.internals.positionAbsolute);
      const br = rf.flowToScreenPosition({ x: n.internals.positionAbsolute.x + w, y: n.internals.positionAbsolute.y + h });
      const inside = tl.x >= pane.left && tl.y >= pane.top && br.x <= pane.right && br.y <= pane.bottom;
      if (!inside) void rf.setCenter(n.internals.positionAbsolute.x + w / 2, n.internals.positionAbsolute.y + h / 2, { zoom: rf.getZoom(), duration: 250 });
    }, 60);
    return () => clearTimeout(t);
  }, [selected, rf]);

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
