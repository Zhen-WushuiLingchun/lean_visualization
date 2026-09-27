import type { Cone } from "../graph/cone";
import { useApp, type Narrowed, type TargetState } from "../state/appState";

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

function label(t: TargetState, defaults: readonly string[], shortName: (id: string) => string, narrowed: Narrowed | null): string {
  if (t.mode === "project") return "Whole project";
  if (t.targets.length === 0) return "No targets";
  if (sameSet(t.targets, defaults)) return "Final theorems";
  if (narrowed && sameSet(t.targets, narrowed.targets)) return `First ${narrowed.targets.length} final theorems`;
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
              {label(h, state.defaultTargets, shortName, state.narrowed)}
            </button>
          </li>
        ))}
        <li className="is-current" aria-current="page" title={state.mode === "project" ? "Whole project" : state.targets.join("\n")}>
          {label(current, state.defaultTargets, shortName, state.narrowed)}
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

/**
 * Shown while the view is the narrowed default (the first few final theorems), because all of them
 * together were too big to open with.
 */
export function NarrowNotice() {
  const { state, dispatch } = useApp();
  const n = state.narrowed;
  if (!n || state.mode !== "cone" || !sameSet(state.targets, n.targets)) return null;
  return (
    <div className="pf-notice" role="status">
      Showing {n.targets.length} of {n.total} final theorems; add more from the list or switch to whole project.{" "}
      <button type="button" onClick={() => dispatch({ type: "setTargets", targets: state.defaultTargets })}>
        Show all {n.total}
      </button>{" "}
      <button type="button" onClick={() => dispatch({ type: "setMode", mode: "project" })}>
        Whole project
      </button>
    </div>
  );
}
