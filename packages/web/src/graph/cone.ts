import Graph from "graphology";
import { TAINT_SEVERITY, type Node, type Taint } from "@proofflow/schema";
import type { GraphIndex, ViewSite } from "./graphIndex";

/**
 * The displayed cone: backward closure from the selected targets, restricted to the loaded graph,
 * with aux nodes folded, external nodes optionally collapsed per package, and a depth limit.
 * Everything here runs over the cone only, never over the whole file.
 */

export type ExternalMode = "expand" | "collapse" | "hide";
export type SiteFilter = "all" | "stmt" | "proof";
export type ViewMode = "cone" | "project";

export interface ConeOptions {
  mode: ViewMode;
  /** Ignored in project mode (the seeds are all local nodes). */
  targets: readonly string[];
  /** Maximum distance from a target, counted in visible nodes. `null` = unlimited. */
  depthLimit: number | null;
  hideAux: boolean;
  external: ExternalMode;
  site: SiteFilter;
}

export const SCALE_LIMIT = 3000;
export const PACKAGE_PREFIX = "external:";

export interface ViewNode {
  id: string;
  type: "decl" | "package";
  /** The declaration, or null for a collapsed package node. */
  decl: Node | null;
  label: string;
  package: string;
  /** Collapsed declaration ids (package nodes only). */
  members: string[];
  taints: Taint[];
  axioms: string[];
  isTarget: boolean;
  isLocal: boolean;
  isAux: boolean;
  isSynthetic: boolean;
  /** Some dependencies are not shown because of the depth limit. */
  truncated: boolean;
}

export interface ViewEdge {
  id: string;
  source: string;
  target: string;
  site: ViewSite;
  /** Derived by folding through hidden aux or external nodes. */
  folded: boolean;
}

export interface Cone {
  nodes: ViewNode[];
  edges: ViewEdge[];
  byId: Map<string, ViewNode>;
  /** Targets present in the graph (view ids). */
  targets: string[];
  /** Every declaration in the closure, including hidden and collapsed ones. */
  closureIds: string[];
  missingTargets: string[];
  /** View graph over `nodes`/`edges` (graphology), for highlight and ordering. */
  view: Graph<Record<string, never>, { site: ViewSite }>;
  counts: {
    /** Declarations in the closure before hiding and collapsing. */
    closure: number;
    hiddenAux: number;
    hiddenExternal: number;
    collapsedExternal: number;
    truncated: number;
  };
}

export function siteAllowed(site: ViewSite, filter: SiteFilter): boolean {
  if (filter === "all" || site === "axiom" || site === "both") return true;
  return site === filter;
}

/** Merge two sites of parallel edges: a real site beats an implied one; stmt + proof = both. */
export function combineSite(a: ViewSite, b: ViewSite): ViewSite {
  if (a === b) return a;
  if (a === "axiom") return b;
  if (b === "axiom") return a;
  return "both";
}

export const packageNodeId = (pkg: string): string => `${PACKAGE_PREFIX}${pkg || "(unknown)"}`;

function sortTaints(set: Set<Taint>): Taint[] {
  return TAINT_SEVERITY.filter((t) => set.has(t));
}

export function buildCone(index: GraphIndex, opts: ConeOptions): Cone {
  const { byId, graph } = index;

  // 1. Seeds and targets.
  let seeds: string[];
  let targets: string[];
  const missingTargets: string[] = [];
  if (opts.mode === "project") {
    seeds = index.localIds;
    targets = index.localSinks;
  } else {
    seeds = [];
    for (const t of opts.targets) {
      if (byId.has(t)) {
        if (!seeds.includes(t)) seeds.push(t);
      } else missingTargets.push(t);
    }
    targets = seeds;
  }
  const targetSet = new Set(targets);

  const hiddenKind = (n: Node): "aux" | "external" | null => {
    if (n.kind === "axiom") return null;
    if (opts.hideAux && n.isAux) return "aux";
    if (opts.external === "hide" && !n.isLocal) return "external";
    return null;
  };
  const isHidden = (id: string): boolean => {
    if (targetSet.has(id)) return false;
    const n = byId.get(id);
    return n ? hiddenKind(n) !== null : false;
  };

  // 2. Backward closure. 0-1 BFS: hidden nodes do not consume depth.
  const dist = new Map<string, number>();
  const front: string[] = [];
  const back: string[] = [];
  let head = 0;
  for (const s of seeds) {
    dist.set(s, 0);
    back.push(s);
  }
  const limit = opts.depthLimit;
  while (front.length > 0 || head < back.length) {
    const v = front.length > 0 ? (front.pop() as string) : (back[head++] as string);
    const d = dist.get(v) ?? 0;
    graph.forEachInEdge(v, (_e, attrs, u) => {
      if (!siteAllowed(attrs.site, opts.site)) return;
      const w = isHidden(u) ? 0 : 1;
      const nd = d + w;
      if (limit !== null && nd > limit) return;
      const old = dist.get(u);
      if (old !== undefined && old <= nd) return;
      dist.set(u, nd);
      if (w === 0) front.push(u);
      else back.push(u);
    });
  }
  const inClosure = (id: string): boolean => dist.has(id);

  // 3. Visible nodes and folded edges.
  type Acc = { site: ViewSite; folded: boolean };
  const declEdges = new Map<string, Acc>();
  const addEdge = (map: Map<string, Acc>, s: string, t: string, site: ViewSite, folded: boolean): void => {
    const key = `${s}\u0000${t}`;
    const prev = map.get(key);
    if (prev) {
      prev.site = combineSite(prev.site, site);
      prev.folded = prev.folded && folded;
    } else map.set(key, { site, folded });
  };

  // Visible ancestors of a hidden node through hidden-only paths. Value: true if every path is implied.
  const through = new Map<string, Map<string, boolean>>();
  const truncatedHidden = new Set<string>();
  const ancestorsThrough = (h: string): Map<string, boolean> => {
    const memo = through.get(h);
    if (memo) return memo;
    const out = new Map<string, boolean>();
    through.set(h, out); // cycle guard
    graph.forEachInEdge(h, (_e, attrs, u) => {
      if (!siteAllowed(attrs.site, opts.site)) return;
      if (!inClosure(u)) {
        truncatedHidden.add(h);
        return;
      }
      const implied = attrs.site === "axiom";
      const merge = (w: string, imp: boolean): void => {
        const prev = out.get(w);
        out.set(w, prev === undefined ? imp : prev && imp);
      };
      if (!isHidden(u)) merge(u, implied);
      else {
        for (const [w, imp] of ancestorsThrough(u)) merge(w, imp || implied);
        if (truncatedHidden.has(u)) truncatedHidden.add(h);
      }
    });
    return out;
  };

  let hiddenAux = 0;
  let hiddenExternal = 0;
  const visibleDecls: string[] = [];
  const truncated = new Set<string>();
  for (const id of dist.keys()) {
    if (isHidden(id)) {
      const n = byId.get(id);
      if (n && hiddenKind(n) === "aux") hiddenAux++;
      else hiddenExternal++;
      continue;
    }
    visibleDecls.push(id);
    graph.forEachInEdge(id, (_e, attrs, u) => {
      if (!siteAllowed(attrs.site, opts.site)) return;
      if (!inClosure(u)) {
        truncated.add(id);
        return;
      }
      if (!isHidden(u)) addEdge(declEdges, u, id, attrs.site, false);
      else {
        for (const [w, imp] of ancestorsThrough(u)) addEdge(declEdges, w, id, imp ? "axiom" : attrs.site, true);
        if (truncatedHidden.has(u)) truncated.add(id);
      }
    });
  }

  // 4. Collapse external declarations into one node per package.
  const collapse = opts.external === "collapse";
  const rep = new Map<string, string>();
  const packages = new Map<string, { members: string[]; taints: Set<Taint>; axioms: Set<string>; order: number; truncated: boolean }>();
  for (const id of visibleDecls) {
    const n = byId.get(id);
    if (collapse && n && !n.isLocal && n.kind !== "axiom" && !targetSet.has(id)) {
      const pid = packageNodeId(n.package);
      rep.set(id, pid);
      let p = packages.get(pid);
      if (!p) {
        p = { members: [], taints: new Set(), axioms: new Set(), order: index.order.get(id) ?? 0, truncated: false };
        packages.set(pid, p);
      }
      p.members.push(id);
      n.taints.forEach((t) => p.taints.add(t));
      n.axioms.forEach((a) => p.axioms.add(a));
      p.order = Math.min(p.order, index.order.get(id) ?? p.order);
      if (truncated.has(id)) p.truncated = true;
    } else rep.set(id, id);
  }
  let edgeAcc = declEdges;
  if (collapse && packages.size > 0) {
    edgeAcc = new Map();
    for (const [key, acc] of declEdges) {
      const [s, t] = key.split("\u0000") as [string, string];
      const rs = rep.get(s) ?? s;
      const rt = rep.get(t) ?? t;
      if (rs === rt) continue;
      addEdge(edgeAcc, rs, rt, acc.site, acc.folded);
    }
  }

  // 5. Assemble.
  const nodes: ViewNode[] = [];
  const orderOf = new Map<string, number>();
  for (const id of visibleDecls) {
    if (rep.get(id) !== id) continue;
    const n = byId.get(id);
    if (!n) continue;
    orderOf.set(id, index.order.get(id) ?? 0);
    nodes.push({
      id,
      type: "decl",
      decl: n,
      label: n.shortName || id,
      package: n.package,
      members: [],
      taints: n.taints,
      axioms: n.axioms,
      isTarget: targetSet.has(id),
      isLocal: n.isLocal,
      isAux: n.isAux,
      isSynthetic: index.synthetic.has(id),
      truncated: truncated.has(id),
    });
  }
  for (const [pid, p] of packages) {
    orderOf.set(pid, p.order);
    nodes.push({
      id: pid,
      type: "package",
      decl: null,
      label: pid.slice(PACKAGE_PREFIX.length),
      package: pid.slice(PACKAGE_PREFIX.length),
      members: p.members,
      taints: sortTaints(p.taints),
      axioms: [...p.axioms].sort(),
      isTarget: false,
      isLocal: false,
      isAux: false,
      isSynthetic: false,
      truncated: p.truncated,
    });
  }
  nodes.sort((a, b) => (orderOf.get(a.id) ?? 0) - (orderOf.get(b.id) ?? 0));

  const byIdView = new Map(nodes.map((n) => [n.id, n]));
  const view: Cone["view"] = new Graph({ type: "directed", multi: false, allowSelfLoops: false });
  for (const n of nodes) view.addNode(n.id);
  const edges: ViewEdge[] = [];
  for (const [key, acc] of edgeAcc) {
    const [s, t] = key.split("\u0000") as [string, string];
    if (!byIdView.has(s) || !byIdView.has(t)) continue;
    const id = `e${edges.length}`;
    edges.push({ id, source: s, target: t, site: acc.site, folded: acc.folded });
    view.addEdgeWithKey(id, s, t, { site: acc.site });
  }

  return {
    nodes,
    edges,
    byId: byIdView,
    targets: targets.filter((t) => byIdView.has(t)),
    closureIds: [...dist.keys()],
    missingTargets,
    view,
    counts: {
      closure: dist.size,
      hiddenAux,
      hiddenExternal,
      collapsedExternal: [...packages.values()].reduce((s, p) => s + p.members.length, 0),
      truncated: nodes.filter((n) => n.truncated).length,
    },
  };
}

/** Ancestors and descendants of `id` inside the displayed cone (for hover highlight). */
export function relatedInView(cone: Cone, id: string): Set<string> {
  const out = new Set<string>([id]);
  if (!cone.view.hasNode(id)) return out;
  const walk = (start: string, dir: "in" | "out"): void => {
    const stack = [start];
    const seen = new Set<string>([start]);
    while (stack.length > 0) {
      const v = stack.pop() as string;
      const next = dir === "in" ? cone.view.inNeighbors(v) : cone.view.outNeighbors(v);
      for (const u of next) {
        if (seen.has(u)) continue;
        seen.add(u);
        out.add(u);
        stack.push(u);
      }
    }
  };
  walk(id, "in");
  walk(id, "out");
  return out;
}

/** Ancestors of `id` in the displayed cone, including itself. */
export function ancestorsInView(cone: Cone, id: string): Set<string> {
  const out = new Set<string>([id]);
  if (!cone.view.hasNode(id)) return out;
  const stack = [id];
  while (stack.length > 0) {
    const v = stack.pop() as string;
    for (const u of cone.view.inNeighbors(v)) {
      if (out.has(u)) continue;
      out.add(u);
      stack.push(u);
    }
  }
  return out;
}
