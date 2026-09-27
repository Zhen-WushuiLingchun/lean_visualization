import { useMemo, useState } from "react";
import { STANDALONE_REASON, useApp } from "../state/appState";
import { useConeRun } from "../state/verifyStore";

/** Project verification uses the loaded graph, regardless of the displayed cone and filters. */
export function VerifyAll() {
  const { state, serverMode, verify } = useApp();
  const run = useConeRun(verify);
  const [scope, setScope] = useState<"all" | "local">("all");
  const [checkerMode, setCheckerMode] = useState<"all" | "kernel">("all");
  const [maxInFlight, setMaxInFlight] = useState<1 | 2 | 4>(2);
  const ids = useMemo(() => (state.graph?.nodes ?? []).filter((node) => scope === "all" || node.isLocal).map((node) => node.id), [state.graph, scope]);
  const busy = run !== null && !run.finished;
  const unavailable = !serverMode ? STANDALONE_REASON : verify.kernelUnavailable();
  const request = checkerMode === "all" ? verify.allRequest() : verify.kernelRequest();
  const disabledReason = unavailable ?? (ids.length === 0 ? "No declarations in this scope." : null);
  const label = run?.scope === "cone" ? "Cone run" : run?.scope === "local" ? "Local run" : "Project run";

  return (
    <>
    <div className="pf-group" aria-label="Project verification" style={{ flexWrap: "wrap" }}>
      <label>
        Scope
        <select aria-label="Verification scope" value={scope} onChange={(event) => setScope(event.target.value as "all" | "local")} disabled={busy || !serverMode}>
          <option value="all">All declarations</option>
          <option value="local">Local declarations only</option>
        </select>
      </label>
      <label>
        Checkers
        <select aria-label="Verification checkers" value={checkerMode} onChange={(event) => setCheckerMode(event.target.value as "all" | "kernel")} disabled={busy || !serverMode}>
          <option value="all">All available checkers</option>
          <option value="kernel">Kernel only</option>
        </select>
      </label>
      <label title="Browser request limit. The server runs up to 2 verification jobs by default; a limit of 4 may leave extra requests queued there.">
        In flight
        <select aria-label="In-flight verification limit" value={maxInFlight} onChange={(event) => setMaxInFlight(Number(event.target.value) as 1 | 2 | 4)} disabled={busy || !serverMode}>
          <option value={1}>1</option>
          <option value={2}>2</option>
          <option value={4}>4</option>
        </select>
      </label>
      <button type="button" className="pf-primary" disabled={busy || !!disabledReason} title={disabledReason ?? `Verify ${ids.length} declarations with up to ${maxInFlight} requests in flight.`} onClick={() => void verify.runAll(ids, request, scope, maxInFlight)}>
        Verify all ({ids.length})
      </button>
    </div>
      {run && (
        <span className={`pf-status${busy ? " is-busy" : ""}`} style={{ whiteSpace: "normal", overflowWrap: "anywhere", maxWidth: "100%" }} role="status" aria-live="polite">
          {label}: {run.done}/{run.total} done, {run.outcomes.ok} accepted, {run.outcomes.rejected} rejected, {run.outcomes.error} errors, {run.outcomes.dash} incomplete
          {run.reused > 0 && `, ${run.reused} from cache`}
          {run.scope === "cone" && run.current && !run.finished && <>. Now: <code>{run.current}</code></>}
          {run.scope !== "cone" && !run.finished && <>. {run.active.length} in flight{run.maxInFlight ? ` (limit ${run.maxInFlight})` : ""}{run.active.length > 0 && <>: <code>{run.active.join(", ")}</code></>}</>}
          {run.cancelled ? run.finished ? ". Stopped." : ". Stop requested." : run.finished ? ". Finished." : "."}
          {busy && (
            <> {run.cancelled ? run.scope === "cone" ? "Stopping after current..." : "Waiting for active jobs..." : <button type="button" className="pf-link" onClick={() => verify.cancelCone()}>{run.scope === "cone" ? "Stop after current" : "Stop after active"}</button>}</>
          )}
        </span>
      )}
    </>
  );
}
