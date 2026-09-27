import type { Cone } from "../graph/cone";
import { useApp, type TargetState } from "../state/appState";

function label(t: TargetState, defaults: readonly string[], shortName: (id: string) => string): string {
  if (t.mode === "project") return "Whole project";
  if (t.targets.length === 0) return "No targets";
  if (t.targets.length === defaults.length && t.targets.every((x) => defaults.includes(x))) return "Final theorems";
  const first = shortName(t.targets[0] as string);
  return t.targets.length === 1 ? first : `${first} +${t.targets.length - 1}`;
}

export function Breadcrumb({ cone }: { cone: Cone | null }) {
  const { state, dispatch, index } = useApp();
  const shortName = (id: string): string => index?.byId.get(id)?.shortName ?? id;
  const current: TargetState = { mode: state.mode, targets: state.targets };
  return (
    <nav className="pf-crumbs" aria-label="Target history">
      <ol>
        {state.history.map((h, i) => (
          <li key={i}>
            <button type="button" className="pf-link" onClick={() => dispatch({ type: "back", index: i })} title={h.mode === "project" ? "Whole project" : h.targets.join("\n")}>
              {label(h, state.defaultTargets, shortName)}
            </button>
          </li>
        ))}
        <li className="is-current" aria-current="page" title={state.mode === "project" ? "Whole project" : state.targets.join("\n")}>
          {label(current, state.defaultTargets, shortName)}
        </li>
      </ol>
      {cone && (
        <span className="pf-crumbs__info">
          {cone.nodes.length} nodes, {cone.edges.length} edges
          {cone.counts.hiddenAux > 0 && `, ${cone.counts.hiddenAux} aux folded`}
          {cone.counts.collapsedExternal > 0 && `, ${cone.counts.collapsedExternal} external collapsed`}
          {cone.counts.hiddenExternal > 0 && `, ${cone.counts.hiddenExternal} external hidden`}
          {cone.counts.truncated > 0 && `, ${cone.counts.truncated} cut by depth`}
          {cone.missingTargets.length > 0 && <span className="pf-warn-text">. Not in graph: {cone.missingTargets.join(", ")}</span>}
        </span>
      )}
    </nav>
  );
}
