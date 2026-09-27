import { useState } from "react";
import { TAINT_SEVERITY, classifyAxiom, type AxiomClass, type Taint } from "@proofflow/schema";
import { axiomColorKey, kindColorKey } from "../graph/colors";
import { AXIOM_CLASS_INFO, TAINT_INFO } from "../graph/trust";
import { useApp } from "../state/appState";
import { Legend } from "./Legend";

const CLASS_ORDER: AxiomClass[] = ["custom", "sorry", "nativeDecide", "standard"];

export function Stats() {
  const { state, dispatch, index } = useApp();
  const [collapsed, setCollapsed] = useState(false);
  const graph = state.graph;
  if (!graph || !index) return null;
  if (collapsed) {
    return (
      <aside className="pf-side is-collapsed">
        <button type="button" aria-label="Show project summary" title="Show project summary" onClick={() => setCollapsed(false)}>
          &gt;
        </button>
      </aside>
    );
  }
  const s = graph.stats;
  const axiomIds = [...new Set([...s.axiomNodes, ...index.synthetic])];
  const groups = new Map<AxiomClass, string[]>();
  for (const a of axiomIds) {
    const c = classifyAxiom(a);
    groups.set(c, [...(groups.get(c) ?? []), a]);
  }
  const taintRows = [...TAINT_SEVERITY].reverse().filter((t) => (s.byTaint[t] ?? 0) > 0);

  return (
    <aside className="pf-side" aria-label="Project summary">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>Project</h2>
        <button type="button" aria-label="Hide project summary" title="Hide" onClick={() => setCollapsed(true)}>
          &lt;
        </button>
      </div>
      <dl className="pf-kv">
        <dt>Name</dt>
        <dd>{graph.meta.project.name}</dd>
        <dt>Lean</dt>
        <dd>{graph.meta.lean.version}</dd>
        <dt>Extracted</dt>
        <dd title={graph.meta.generatedAt}>{new Date(graph.meta.generatedAt).toLocaleDateString()}</dd>
        <dt>Declarations</dt>
        <dd>{s.nodes}</dd>
        <dt>Local</dt>
        <dd>{s.localNodes}</dd>
        <dt>External</dt>
        <dd>{s.externalNodes}</dd>
        <dt>Edges</dt>
        <dd>{s.edges}</dd>
      </dl>

      <h2>Local nodes by taint</h2>
      {taintRows.length === 0 ? (
        <p className="pf-note">None. Every local node rests only on standard axioms.</p>
      ) : (
        <ul className="pf-list">
          {taintRows.map((t: Taint) => (
            <li key={t}>
              <button
                type="button"
                className="pf-link"
                style={{ textDecoration: "none", color: "inherit" }}
                title={`${TAINT_INFO[t].explain} Click to highlight.`}
                onClick={() => dispatch({ type: "setOptions", patch: { taintFilter: [t] } })}
              >
                <span className="pf-taint" data-border={TAINT_INFO[t].border}>
                  {TAINT_INFO[t].badge}
                </span>{" "}
                {TAINT_INFO[t].label}
              </button>
              <span>{s.byTaint[t]}</span>
            </li>
          ))}
        </ul>
      )}

      <h2>Final theorems ({index.localSinks.length})</h2>
      <ul className="pf-list">
        {index.localSinks.slice(0, 200).map((id) => {
          const n = index.byId.get(id);
          return (
            <li key={id}>
              <button type="button" className="pf-chip" data-kind={n ? kindColorKey(n) : undefined} title={`${id}\nClick to show only this cone`} onClick={() => {
                dispatch({ type: "setTargets", targets: [id] });
                dispatch({ type: "select", id });
              }}>
                {n?.shortName ?? id}
              </button>
              <button type="button" aria-label={`Add ${id} as a target`} title="Add as target" onClick={() => dispatch({ type: "addTarget", id })}>
                +
              </button>
            </li>
          );
        })}
      </ul>
      {index.localSinks.length > 200 && <p className="pf-note">{index.localSinks.length - 200} more. Use search.</p>}

      <h2>Axioms ({axiomIds.length})</h2>
      {CLASS_ORDER.filter((c) => groups.has(c)).map((c) => (
        <div key={c} style={{ marginBottom: 6 }}>
          <p className="pf-note" title={AXIOM_CLASS_INFO[c].explain}>
            {AXIOM_CLASS_INFO[c].label}
          </p>
          <div className="pf-chips">
            {(groups.get(c) ?? []).map((a) => (
              <button key={a} type="button" className="pf-chip" data-kind={axiomColorKey(a)} title={a} onClick={() => dispatch({ type: "select", id: a })}>
                {a}
              </button>
            ))}
          </div>
        </div>
      ))}

      <Legend />
    </aside>
  );
}
