import { SCALE_LIMIT, type Cone } from "../graph/cone";
import { useApp } from "../state/appState";

/** Shown instead of the graph when the cone is too large to lay out. */
export function ScaleGuard({ cone }: { cone: Cone }) {
  const { state, dispatch } = useApp();
  const o = state.options;
  const set = (patch: Partial<typeof o>): void => dispatch({ type: "setOptions", patch });
  const current = o.depthLimit;
  return (
    <div className="pf-overlay">
      <div className="pf-card" role="alert">
        <h2>This cone has {cone.nodes.length} nodes</h2>
        <p>
          The viewer lays out at most {SCALE_LIMIT} nodes. Add a depth limit, collapse more, or pick fewer targets.
        </p>
        <div className="pf-actions">
          {[2, 3, 5, 8].map((d) => (
            <button key={d} type="button" disabled={current !== null && current <= d} onClick={() => set({ depthLimit: d })}>
              Depth {d}
            </button>
          ))}
          {o.external !== "collapse" && (
            <button type="button" onClick={() => set({ external: "collapse" })}>
              Collapse externals
            </button>
          )}
          {!o.hideAux && (
            <button type="button" onClick={() => set({ hideAux: true })}>
              Hide aux
            </button>
          )}
          {o.site === "all" && (
            <button type="button" onClick={() => set({ site: "stmt" })}>
              Statement edges only
            </button>
          )}
          {state.mode === "project" && (
            <button type="button" onClick={() => dispatch({ type: "setMode", mode: "cone" })}>
              Back to cone view
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
