import { useDeferredValue, useId, useMemo, useState, type KeyboardEvent, type RefObject } from "react";
import { TAINT_SEVERITY, type Taint } from "@proofflow/schema";
import { KIND_PALETTE, kindColorKey, type KindColorKey } from "../graph/colors";
import type { ExternalMode, SiteFilter } from "../graph/cone";
import { fuzzySearch } from "../graph/search";
import { TAINT_INFO } from "../graph/trust";
import { useApp } from "../state/appState";
import { useConeRun } from "../state/verifyStore";

function TargetSearch({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
  const { index, dispatch } = useApp();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const deferred = useDeferredValue(query);
  const listId = useId();
  const hits = useMemo(() => (index && deferred.trim() ? fuzzySearch(deferred, index.searchIds, 40) : []), [index, deferred]);

  const choose = (id: string, sole: boolean): void => {
    dispatch(sole ? { type: "setTargets", targets: [id] } : { type: "addTarget", id });
    dispatch({ type: "select", id });
    setQuery("");
    setOpen(false);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      const hit = hits[active] ?? hits[0];
      if (hit) {
        e.preventDefault();
        choose(hit.id, e.shiftKey);
      }
    } else if (e.key === "Escape") {
      setQuery("");
      setOpen(false);
      e.currentTarget.blur();
    }
  };

  return (
    <div className="pf-search">
      <input
        ref={inputRef}
        type="search"
        placeholder="Search declarations ( / )"
        aria-label="Search declarations to add as targets"
        role="combobox"
        aria-expanded={open && hits.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKey}
      />
      {open && hits.length > 0 && (
        <ul className="pf-search__results" id={listId} role="listbox">
          {hits.map((h, i) => {
            const n = index?.byId.get(h.id);
            return (
              <li
                key={h.id}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(h.id, e.shiftKey || e.ctrlKey || e.metaKey);
                }}
                onMouseEnter={() => setActive(i)}
                title="Click adds a target. Shift-click shows only this one."
              >
                <span className="pf-dot" data-kind={n ? kindColorKey(n) : "package"} />
                <span className="pf-search__id">{h.id}</span>
                <span className="pf-search__mod">{n?.isLocal ? n.module : `${n?.package ?? ""} (external)`}</span>
              </li>
            );
          })}
          <li className="pf-muted pf-small" aria-disabled="true" style={{ cursor: "default" }}>
            Enter adds a target. Shift+Enter shows only this one.
          </li>
        </ul>
      )}
    </div>
  );
}

function Targets() {
  const { state, dispatch, index } = useApp();
  if (state.mode === "project") {
    return <span className="pf-muted">Whole project: {index?.localIds.length ?? 0} local declarations</span>;
  }
  const isDefault = state.targets.length === state.defaultTargets.length && state.targets.every((t) => state.defaultTargets.includes(t));
  return (
    <div className="pf-target-chips" aria-label="Targets">
      {state.targets.length > 6 && isDefault ? (
        <span className="pf-chip" title={state.targets.join("\n")}>
          {state.targets.length} final theorems
        </span>
      ) : (
        state.targets.map((t) => {
          const n = index?.byId.get(t);
          return (
            <span key={t} className={`pf-chip${n ? "" : " is-missing"}`} data-kind={n ? kindColorKey(n) : undefined} title={t}>
              <button type="button" className="pf-link" style={{ textDecoration: "none", color: "inherit" }} onClick={() => dispatch({ type: "select", id: t })}>
                {n?.shortName ?? t}
              </button>
              <button type="button" className="pf-x" aria-label={`Remove target ${t}`} onClick={() => dispatch({ type: "removeTarget", id: t })}>
                x
              </button>
            </span>
          );
        })
      )}
      {!isDefault && (
        <button type="button" onClick={() => dispatch({ type: "resetTargets" })} title="Back to the project's final theorems (local sinks)">
          Final theorems
        </button>
      )}
    </div>
  );
}

const KIND_KEYS = Object.keys(KIND_PALETTE) as KindColorKey[];

function FilterPopover() {
  const { state, dispatch } = useApp();
  const { taintFilter, kindFilter } = state.options;
  const toggleTaint = (t: Taint): void =>
    dispatch({ type: "setOptions", patch: { taintFilter: taintFilter.includes(t) ? taintFilter.filter((x) => x !== t) : [...taintFilter, t] } });
  const toggleKind = (k: KindColorKey): void =>
    dispatch({ type: "setOptions", patch: { kindFilter: kindFilter.includes(k) ? kindFilter.filter((x) => x !== k) : [...kindFilter, k] } });
  const count = taintFilter.length + kindFilter.length;
  return (
    <details className="pf-pop">
      <summary title="Highlight nodes by taint or kind. Others are dimmed; the layout does not change.">Filter{count ? ` (${count})` : ""}</summary>
      <div className="pf-pop__body">
        <strong className="pf-small">Taints (any of)</strong>
        {[...TAINT_SEVERITY].reverse().map((t) => (
          <label key={t} title={TAINT_INFO[t].explain}>
            <input type="checkbox" checked={taintFilter.includes(t)} onChange={() => toggleTaint(t)} />
            <span className="pf-taint" data-border={TAINT_INFO[t].border}>
              {TAINT_INFO[t].badge}
            </span>
            {TAINT_INFO[t].label}
          </label>
        ))}
        <strong className="pf-small" style={{ marginTop: 6 }}>
          Kinds (any of)
        </strong>
        {KIND_KEYS.map((k) => (
          <label key={k}>
            <input type="checkbox" checked={kindFilter.includes(k)} onChange={() => toggleKind(k)} />
            <span className="pf-dot" data-kind={k} />
            {KIND_PALETTE[k].label}
          </label>
        ))}
        {count > 0 && (
          <button type="button" onClick={() => dispatch({ type: "setOptions", patch: { taintFilter: [], kindFilter: [] } })}>
            Clear filters
          </button>
        )}
      </div>
    </details>
  );
}

export interface LayoutStatus {
  phase: "idle" | "running" | "done" | "error" | "guard" | "empty";
  nodes: number;
  engine?: string;
  ms?: number;
  error?: string;
}

export interface ToolbarProps {
  searchRef: RefObject<HTMLInputElement | null>;
  layout: LayoutStatus;
  canExport: boolean;
  onExportJson(): void;
  onExportSvg(): void;
  onFit(): void;
}

export function Toolbar({ searchRef, layout, canExport, onExportJson, onExportSvg, onFit }: ToolbarProps) {
  const { state, dispatch, serverMode, verify } = useApp();
  const coneRun = useConeRun(verify);
  const o = state.options;
  const set = (patch: Partial<typeof o>): void => dispatch({ type: "setOptions", patch });
  const [depthText, setDepthText] = useState(o.depthLimit === null ? "" : String(o.depthLimit));
  const [lastDepth, setLastDepth] = useState(o.depthLimit);
  if (lastDepth !== o.depthLimit) {
    setLastDepth(o.depthLimit);
    setDepthText(o.depthLimit === null ? "" : String(o.depthLimit));
  }
  const status =
    layout.phase === "running"
      ? `Layouting ${layout.nodes} nodes...`
      : layout.phase === "done"
        ? `${layout.nodes} nodes, ${layout.engine === "worker" ? "worker" : "main thread"} layout ${((layout.ms ?? 0) / 1000).toFixed(2)} s`
        : layout.phase === "guard"
          ? `${layout.nodes} nodes: too many to lay out`
          : layout.phase === "error"
            ? `Layout failed: ${layout.error ?? ""}`
            : layout.phase === "empty"
              ? "Nothing to show"
              : "";

  return (
    <header className="pf-toolbar">
      <span className="pf-brand">
        ProofFlow
        <small>
          {state.graph?.meta.project.name} {serverMode ? "(server)" : state.source === "sample" ? "(sample, standalone)" : "(file, standalone)"}
        </small>
      </span>
      <TargetSearch inputRef={searchRef} />
      <Targets />
      <div className="pf-group pf-seg" role="group" aria-label="View mode">
        <button type="button" aria-pressed={state.mode === "cone"} onClick={() => dispatch({ type: "setMode", mode: "cone" })} title="Backward closure of the targets">
          Cone
        </button>
        <button type="button" aria-pressed={state.mode === "project"} onClick={() => dispatch({ type: "setMode", mode: "project" })} title="All local declarations, externals collapsed">
          Whole project
        </button>
      </div>
      <div className="pf-group">
        <label title="Maximum distance from a target, in visible nodes. Empty means unlimited.">
          Depth
          <input
            className="pf-depth"
            type="number"
            min={1}
            placeholder="all"
            value={depthText}
            onChange={(e) => {
              setDepthText(e.target.value);
              const v = parseInt(e.target.value, 10);
              set({ depthLimit: Number.isFinite(v) && v > 0 ? v : null });
            }}
          />
        </label>
        <label title="Hide auto-generated declarations (recursors, match and eq lemmas). Their edges are folded through.">
          <input type="checkbox" checked={o.hideAux} onChange={(e) => set({ hideAux: e.target.checked })} />
          Hide aux
        </label>
        <label title="External declarations: show each, collapse into one node per package, or hide and fold edges through">
          External
          <select value={o.external} onChange={(e) => set({ external: e.target.value as ExternalMode })}>
            <option value="collapse">Collapse</option>
            <option value="expand">Expand</option>
            <option value="hide">Hide</option>
          </select>
        </label>
        <label title="Follow statement dependencies, proof dependencies, or both">
          Edges
          <select value={o.site} onChange={(e) => set({ site: e.target.value as SiteFilter })}>
            <option value="all">All</option>
            <option value="stmt">Statement</option>
            <option value="proof">Proof</option>
          </select>
        </label>
        <FilterPopover />
      </div>
      <div className="pf-group">
        <button type="button" onClick={onFit} title="Fit view (f)">
          Fit
        </button>
        <details className="pf-pop">
          <summary>Export</summary>
          <div className="pf-pop__body">
            <button type="button" disabled={!canExport} onClick={onExportJson} title="The displayed cone as a graph.json you can load again">
              Cone as JSON
            </button>
            <button type="button" disabled={!canExport} onClick={onExportSvg} title="The laid-out cone as a standalone SVG">
              Cone as SVG
            </button>
          </div>
        </details>
      </div>
      <span className="pf-spacer" />
      {coneRun && !coneRun.finished && (
        <span className="pf-status is-busy">
          Verifying cone {coneRun.done}/{coneRun.total}{" "}
          <button type="button" className="pf-link" onClick={() => verify.cancelCone()}>
            Stop
          </button>
        </span>
      )}
      <span className={`pf-status${layout.phase === "running" ? " is-busy" : ""}`} role="status" aria-live="polite">
        {status}
      </span>
    </header>
  );
}
