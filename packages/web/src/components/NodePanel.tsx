import { useEffect, useMemo, useRef, useState } from "react";
import { L1_CHECKERS, L2_CHECKERS, classifyAxiom, type CheckerName, type CheckerResult, type Node, type VerifyResult } from "@proofflow/schema";
import { fetchSource, type SourceSnippet } from "../api/client";
import { badgeOf, effectiveResult, nonStandardAxioms, type BadgeKind } from "../graph/badge";
import { axiomColorKey, kindColorKey, kindLabel } from "../graph/colors";
import { ancestorsInView, type Cone, type ViewNode } from "../graph/cone";
import type { Layering } from "../graph/layers";
import { AXIOM_CLASS_INFO, CHECKER_INFO, LEVEL_INFO, TAINT_INFO } from "../graph/trust";
import { STANDALONE_REASON, useApp } from "../state/appState";
import { isActive, useConeRun, useDeclVerify } from "../state/verifyStore";
import { TaintPill, VerifyBadge } from "./Badges";

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function fmtBytes(b: number): string {
  return b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/** First 12 hex characters and an ellipsis; the full value goes in a tooltip. */
function short(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

/** Facts parsed by the server from the export itself, independent of graph.json. */
function ExportAudit({ result }: { result: VerifyResult }) {
  const a = result.exportAudit;
  if (!a) {
    return (
      <div className="pf-audit" aria-label="Export audit">
        <h3>Export audit</h3>
        <p className="pf-note">No export (module replay).</p>
      </div>
    );
  }
  const ns = nonStandardAxioms(result);
  return (
    <div className="pf-audit" aria-label="Export audit">
      <h3>Export audit</h3>
      {a.targetFound ? (
        <p>Target found: yes{a.targetKind ? ` (${a.targetKind})` : ""}</p>
      ) : (
        <p className="pf-error">Target NOT found in export</p>
      )}
      {a.targetTypeSha256 && (
        <p>
          Type sha256: <code title={a.targetTypeSha256}>{short(a.targetTypeSha256)}</code>
        </p>
      )}
      <p>
        Axioms in closure: {a.axioms.length > 0 ? a.axioms.join(", ") : "none"}{" "}
        {a.standardAxiomsOnly ? (
          <span className="pf-flag pf-flag--ok">standard only</span>
        ) : (
          <span className="pf-flag pf-flag--bad" title="Axioms outside propext, Classical.choice, Quot.sound">
            {ns.length > 0 ? ns.join(", ") : "non-standard"}
          </span>
        )}
      </p>
      <p>Declarations: {a.declCount}</p>
    </div>
  );
}

function DepChips({ ids, empty }: { ids: readonly string[]; empty: string }) {
  const { index, dispatch } = useApp();
  if (ids.length === 0) return <p className="pf-note">{empty}</p>;
  return (
    <div className="pf-chips">
      {ids.map((id) => {
        const n = index?.byId.get(id);
        return n ? (
          <button key={id} type="button" className="pf-chip" data-kind={kindColorKey(n)} title={`${id}\nClick to inspect`} onClick={() => dispatch({ type: "select", id })}>
            {id}
          </button>
        ) : (
          <span key={id} className="pf-chip is-missing" title="Not in graph.json (boundary dependency that was not emitted)">
            {id}
          </span>
        );
      })}
    </div>
  );
}

function SourceSection({ node }: { node: Node }) {
  const { serverMode } = useApp();
  const [state, setState] = useState<{ status: "idle" | "loading" | "done" | "error"; snip?: SourceSnippet; error?: string }>({ status: "idle" });
  useEffect(() => setState({ status: "idle" }), [node.id]);
  const load = (): void => {
    setState({ status: "loading" });
    fetchSource(node.id)
      .then((snip) => setState({ status: "done", snip }))
      .catch((e: unknown) => setState({ status: "error", error: e instanceof Error ? e.message : String(e) }));
  };
  const where = node.src ? `${node.src.file}:${node.src.line}` : null;
  const canFetch = serverMode && node.isLocal && node.src !== null;
  return (
    <>
      <p className="pf-note">
        Module <code>{node.module || "(unknown)"}</code>
        {where && (
          <>
            {" "}
            at <code>{where}</code>
          </>
        )}
      </p>
      {canFetch ? (
        state.status === "done" && state.snip ? (
          <>
            <p className="pf-note">
              {state.snip.file} lines {state.snip.line} to {state.snip.endLine}{" "}
              <button type="button" className="pf-link" onClick={() => setState({ status: "idle" })}>
                Hide
              </button>
            </p>
            <pre className="pf-source-snippet">{state.snip.text}</pre>
          </>
        ) : (
          <button type="button" onClick={load} disabled={state.status === "loading"}>
            {state.status === "loading" ? "Loading source..." : "Show source"}
          </button>
        )
      ) : (
        <p className="pf-note">{!node.isLocal ? "Source is shown for local declarations only." : !serverMode ? "Source needs the server." : "No source range recorded."}</p>
      )}
      {state.status === "error" && <p className="pf-error">{state.error}</p>}
    </>
  );
}

const STATUS_BADGE: Record<string, BadgeKind> = {
  accepted: "ok",
  rejected: "rejected",
  error: "error",
  timeout: "error",
  declined: "dash",
  unavailable: "dash",
};

function CheckerRow({
  name,
  row,
  requested,
  running,
  availability,
  note,
}: {
  name: CheckerName;
  row: CheckerResult | undefined;
  requested: boolean;
  running: boolean;
  availability: boolean | null;
  /** `CheckerInfo.note` from the server: why it is unavailable, or what it checks instead. */
  note: string | null;
}) {
  const [open, setOpen] = useState(false);
  const info = CHECKER_INFO[name];
  let status: string;
  let badge: BadgeKind = "none";
  if (row && row.status !== "skipped") {
    status = row.status;
    badge = STATUS_BADGE[row.status] ?? "none";
  } else if (running && requested) {
    status = "running";
    badge = "running";
  } else if (availability === false) {
    status = "not installed";
    badge = "dash";
  } else status = "not run";
  return (
    <>
      <tr>
        <td title={note ? `${info.explain}\n${note}` : info.explain}>
          {name} <span className="pf-muted pf-small">{info.level}</span>
          {info.label && <div className="pf-muted pf-small">{info.label}</div>}
          {note && <div className="pf-muted pf-small pf-checker-note">{note}</div>}
        </td>
        <td>
          <span className="pf-status-cell" title={status === "not installed" && note ? note : undefined}>
            <VerifyBadge inline badge={{ kind: badge, label: status, reason: row ? `exit ${row.exitCode ?? "none"}` : (note ?? status) }} />
            {status}
          </span>
        </td>
        <td className="num">{row ? fmtMs(row.durationMs) : ""}</td>
        <td className="num">{row ? (row.exitCode ?? "none") : ""}</td>
        <td>
          {row && (
            <button type="button" className="pf-link" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? "Hide log" : "Log"}
            </button>
          )}
        </td>
      </tr>
      {row && open && (
        <tr className="pf-logrow">
          <td colSpan={5}>
            <p className="pf-note">
              <code>{row.command.join(" ")}</code>
            </p>
            <p className="pf-note">
              Binary sha256{" "}
              {row.binarySha256 ? <code title={row.binarySha256}>{short(row.binarySha256)}</code> : "not recorded"}
              {row.ranAt ? `, ran ${new Date(row.ranAt).toLocaleString()}` : ""}.
            </p>
            {row.rejectedDecl && <p className="pf-note">Rejected declaration: <code>{row.rejectedDecl}</code></p>}
            {row.stdoutTail && (
              <>
                <p className="pf-note">stdout (tail)</p>
                <pre>{row.stdoutTail}</pre>
              </>
            )}
            {row.stderrTail && (
              <>
                <p className="pf-note">stderr (tail)</p>
                <pre>{row.stderrTail}</pre>
              </>
            )}
            {!row.stdoutTail && !row.stderrTail && <p className="pf-note">No output.</p>}
          </td>
        </tr>
      )}
    </>
  );
}

function VerifySection({ node, cone, layering }: { node: Node; cone: Cone | null; layering: Layering | null }) {
  const { verify, serverMode, checkers } = useApp();
  const st = useDeclVerify(verify, node.id);
  const coneRun = useConeRun(verify);
  const [coneAll, setConeAll] = useState(false);
  const [reuse, setReuse] = useState(true);
  const logRef = useRef<HTMLPreElement>(null);
  const result = useMemo(() => effectiveResult(st.results), [st.results]);
  const badge = isActive(st.job) ? { kind: "running" as const, label: "Running", reason: "Verification in progress." } : badgeOf(result);
  const running = isActive(st.job);

  useEffect(() => {
    if (serverMode) void verify.loadCached(node.id);
  }, [serverMode, verify, node.id]);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [st.job?.log.length]);

  const coneDecls = useMemo(() => {
    if (!cone || !layering || !cone.byId.has(node.id)) return [];
    const anc = ancestorsInView(cone, node.id);
    return layering.order.filter((id) => {
      if (!anc.has(id)) return false;
      const v = cone.byId.get(id);
      return v?.type === "decl" && !v.isSynthetic && v.isLocal;
    });
  }, [cone, layering, node.id]);

  const disabledReason = !serverMode ? STANDALONE_REASON : null;
  const coneBusy = coneRun !== null && !coneRun.finished;
  const infoOf = (c: CheckerName) => checkers?.find((i) => i.checker === c);
  const availability = (c: CheckerName): boolean | null => (checkers ? (infoOf(c)?.available ?? false) : null);
  // Requests come from /api/checkers (`checkers` in context re-renders this panel when it arrives).
  const kernelReq = verify.kernelRequest();
  const allReq = verify.allRequest();
  const kernelOff = disabledReason ?? verify.kernelUnavailable();
  const allOff = disabledReason ?? verify.allUnavailable();
  const coneOff = coneAll ? allOff : kernelOff;
  const kernelNames = Array.isArray(kernelReq) ? kernelReq.join(", ") : "the server's default kernel checker";
  const jobReq = st.job?.checkers;
  const isRequested = (c: CheckerName): boolean =>
    jobReq === undefined
      ? false
      : jobReq === "all"
        ? availability(c) !== false
        : jobReq === null
          ? (L1_CHECKERS as readonly string[]).includes(c) && availability(c) !== false
          : jobReq.includes(c);

  return (
    <section>
      <h2>Verification</h2>
      <div className="pf-verify-buttons">
        <VerifyBadge inline badge={badge} />
        <span>{badge.kind === "none" ? "Not verified" : badge.label}</span>
      </div>
      {badge.kind !== "none" && badge.kind !== "running" && <p className="pf-note">{badge.reason}</p>}
      <div className="pf-verify-buttons" style={{ marginTop: 6 }}>
        <button
          type="button"
          className="pf-primary"
          disabled={!!kernelOff || running}
          title={kernelOff ?? `L1 with ${kernelNames}. ${LEVEL_INFO.L1}`}
          onClick={() => void verify.verify(node.id, kernelReq)}
        >
          Verify (kernel)
        </button>
        <button
          type="button"
          disabled={!!allOff || running}
          title={allOff ?? `L1 + L2 with ${Array.isArray(allReq) ? allReq.join(", ") : "every available checker"}. ${LEVEL_INFO.L2}`}
          onClick={() => void verify.verify(node.id, allReq)}
        >
          Verify (all checkers)
        </button>
        <button
          type="button"
          disabled={!!coneOff || coneBusy || coneDecls.length === 0}
          title={coneOff ?? (coneDecls.length === 0 ? "This node is not in the displayed cone." : "Verify this node and its local dependencies in the displayed cone, dependencies first, one at a time.")}
          onClick={() => void verify.runCone(coneDecls, coneAll ? allReq : kernelReq, reuse)}
        >
          Verify cone ({coneDecls.length})
        </button>
      </div>
      <div className="pf-verify-buttons pf-small" style={{ marginTop: 4 }}>
        <label title="Use every available checker for the cone run, not only the kernel">
          <input type="checkbox" checked={coneAll} onChange={(e) => setConeAll(e.target.checked)} disabled={!!disabledReason} /> all checkers for cone
        </label>
        <label title="Skip declarations whose cached result already covers the requested checkers">
          <input type="checkbox" checked={reuse} onChange={(e) => setReuse(e.target.checked)} disabled={!!disabledReason} /> reuse cached results
        </label>
      </div>
      {coneRun?.scope === "cone" && (
        <p className="pf-note">
          Cone run: {coneRun.done} of {coneRun.total} done, {coneRun.reused} from cache, {coneRun.outcomes.ok} accepted, {coneRun.outcomes.rejected} rejected,{" "}
          {coneRun.outcomes.error} errors, {coneRun.outcomes.dash} incomplete.
          {coneRun.current && !coneRun.finished && (
            <>
              {" "}
              Now: <code>{coneRun.current}</code>.
            </>
          )}
          {coneRun.cancelled && (coneRun.finished ? " Stopped." : " Stop requested.")}
          {coneBusy && !coneRun.cancelled && (
            <>
              {" "}
              <button type="button" className="pf-link" onClick={() => verify.cancelCone()}>
                Stop after current
              </button>
            </>
          )}
        </p>
      )}
      {st.job && (st.job.status === "failed" || st.job.error) && <p className="pf-error">{st.job.error ?? "Job failed."}</p>}

      <div className="pf-table-wrap" style={{ marginTop: 8 }}>
        <table className="pf-table">
          <thead>
            <tr>
              <th>Checker</th>
              <th>Status</th>
              <th className="num">Time</th>
              <th className="num">Exit</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {[...L1_CHECKERS, ...L2_CHECKERS].map((c) => (
              <CheckerRow
                key={c}
                name={c}
                row={result?.checkers.find((r) => r.checker === c)}
                requested={isRequested(c)}
                running={running}
                availability={availability(c)}
                note={infoOf(c)?.note ?? null}
              />
            ))}
          </tbody>
        </table>
      </div>
      {result && <ExportAudit result={result} />}
      {result && (
        <p className="pf-note">
          Verified {new Date(result.verifiedAt).toLocaleString()} on Lean {result.leanVersion}.{" "}
          {result.exportDecls === null ? (
            <>
              Module replay of <code>{result.module}</code> (imports trusted, hash <code title={result.exportHash}>{result.exportHash.slice(0, 12)}</code>).
            </>
          ) : (
            <>
              Export <code title={result.exportHash}>{result.exportHash.slice(0, 12)}</code> from <code>{result.module}</code>, {fmtBytes(result.exportBytes)}, {result.exportDecls}{" "}
              declarations, exported in {fmtMs(result.exportDurationMs)}.
            </>
          )}{" "}
          {result.binding.oleanSha256 ? (
            <>
              Bound to .olean <code title={result.binding.oleanSha256}>{short(result.binding.oleanSha256)}</code> on {result.binding.toolchain ?? "an unknown toolchain"}.
            </>
          ) : (
            "No .olean binding recorded."
          )}{" "}
          Server verdict: {result.verdict}. Rows only speak for the checker that produced them.
        </p>
      )}
      {st.job && (st.job.log.length > 0 || running) && (
        <>
          <p className="pf-note">
            Job {st.job.id ? <code>{st.job.id.slice(0, 8)}</code> : ""} {st.job.status}
          </p>
          <pre ref={logRef} className="pf-joblog">
            {st.job.log.join("\n") || "Waiting for output..."}
          </pre>
        </>
      )}
      <details style={{ marginTop: 8 }}>
        <summary className="pf-small">What does each level prove?</summary>
        <p className="pf-note">
          <b>L0</b> {LEVEL_INFO.L0}
        </p>
        <p className="pf-note">
          <b>L1</b> {LEVEL_INFO.L1}
        </p>
        <p className="pf-note">
          <b>L2</b> {LEVEL_INFO.L2}
        </p>
        <p className="pf-note">{LEVEL_INFO.none}</p>
        <p className="pf-note">
          A green badge needs a kernel replay (L1: leanchecker, or leanchecker-module on older toolchains) and every other requested checker to accept. Taints are shown
          regardless: a sorry proof can still be kernel-accepted.
        </p>
      </details>
    </section>
  );
}

function TrustSection({ axioms, taints, node }: { axioms: readonly string[]; taints: ViewNode["taints"]; node: Node | null }) {
  const { index, dispatch } = useApp();
  const flags = node ? Object.entries(node.flags).filter(([, v]) => v).map(([k]) => k) : [];
  return (
    <section>
      <h2>Trust profile (L0)</h2>
      {axioms.length === 0 ? (
        <p className="pf-note">No axioms. Nothing below this node is assumed.</p>
      ) : (
        <div className="pf-chips">
          {axioms.map((a) => {
            const cls = classifyAxiom(a);
            return (
              <button
                key={a}
                type="button"
                className="pf-chip"
                data-kind={axiomColorKey(a)}
                title={`${AXIOM_CLASS_INFO[cls].label}: ${AXIOM_CLASS_INFO[cls].explain}`}
                onClick={() => index?.byId.has(a) && dispatch({ type: "select", id: a })}
              >
                {a}
              </button>
            );
          })}
        </div>
      )}
      {taints.length > 0 ? (
        <ul className="pf-taint-list" style={{ marginTop: 8 }}>
          {[...taints].reverse().map((t) => (
            <li key={t}>
              <TaintPill taint={t} />
              <span>{TAINT_INFO[t].explain}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pf-note">No taints: rests only on the standard axioms (or none).</p>
      )}
      {flags.length > 0 && <p className="pf-note">Direct flags: {flags.join(", ")}.</p>}
    </section>
  );
}

export interface NodePanelProps {
  cone: Cone | null;
  layering: Layering | null;
}

export function NodePanel({ cone, layering }: NodePanelProps) {
  const { state, dispatch, index } = useApp();
  const id = state.selected;
  if (!id || !index) return null;
  const node = index.byId.get(id) ?? null;
  const view = cone?.byId.get(id) ?? null;
  const close = (
    <button type="button" aria-label="Close panel (Esc)" title="Close (Esc)" onClick={() => dispatch({ type: "select", id: null })}>
      Close
    </button>
  );

  if (!node && view?.type === "package") {
    return (
      <aside className="pf-panel" aria-label="Node details">
        <div className="pf-panel__head">
          <div className="pf-panel__title">
            <span className="pf-panel__kind" data-kind="package">
              external package
            </span>
            <p className="pf-panel__id">{view.label}</p>
          </div>
          {close}
        </div>
        <p className="pf-note">
          {view.members.length} external declarations of <code>{view.label}</code> are collapsed into this node. It carries the union of their trust profiles. Switch External to
          Expand in the toolbar to see them.
        </p>
        <TrustSection axioms={view.axioms} taints={view.taints} node={null} />
        <section>
          <h2>Collapsed declarations</h2>
          <DepChips ids={view.members} empty="None." />
        </section>
      </aside>
    );
  }
  if (!node) {
    return (
      <aside className="pf-panel" aria-label="Node details">
        <div className="pf-panel__head">
          <p className="pf-panel__id pf-panel__title">{id}</p>
          {close}
        </div>
        <p className="pf-note">Not in graph.json.</p>
      </aside>
    );
  }

  const isTarget = state.mode === "cone" && state.targets.includes(id);
  const synthetic = index.synthetic.has(id);
  const usedBy = cone?.view.hasNode(id) ? cone.view.outNeighbors(id) : [];
  const tags: string[] = [node.isLocal ? "local" : `external (${node.package})`];
  if (node.isAux) tags.push("auto-generated");
  if (!node.depsComplete) tags.push("boundary: own dependencies not emitted");
  if (node.levelParams.length) tags.push(`universes ${node.levelParams.join(", ")}`);

  return (
    <aside className="pf-panel" aria-label="Node details">
      <div className="pf-panel__head">
        <div className="pf-panel__title">
          <span className="pf-panel__kind" data-kind={kindColorKey(node)}>
            {kindLabel(node)}
          </span>
          <p className="pf-panel__id">{node.id}</p>
          <p className="pf-note">{tags.join(" · ")}</p>
        </div>
        {close}
      </div>
      <div className="pf-verify-buttons">
        <button type="button" onClick={() => dispatch({ type: "setTargets", targets: [id] })} title="Show only this declaration's cone (double-click on the graph does the same)">
          Show its cone
        </button>
        {isTarget ? (
          <button type="button" onClick={() => dispatch({ type: "removeTarget", id })}>
            Remove target
          </button>
        ) : (
          <button type="button" onClick={() => dispatch({ type: "addTarget", id })}>
            Add as target
          </button>
        )}
      </div>

      {synthetic ? (
        <p className="pf-note">
          This axiom appears in trust profiles but graph.json has no node for it. It is drawn so every axiom is a visible source. Dotted edges point to the boundary nodes whose
          closure uses it.
        </p>
      ) : (
        <section>
          <h2>Statement</h2>
          <pre>{node.statement}</pre>
          {node.statementTruncated && <p className="pf-note">Truncated by the extractor (statementMaxChars).</p>}
          {node.doc && (
            <>
              <h2>Docstring</h2>
              <p className="pf-doc">{node.doc}</p>
            </>
          )}
          <h2>Source</h2>
          <SourceSection node={node} />
        </section>
      )}

      <TrustSection axioms={node.axioms} taints={node.taints} node={node} />

      {!synthetic && (
        <>
          <section>
            <h2>Statement uses ({node.deps.stmt.length})</h2>
            <DepChips ids={node.deps.stmt} empty={node.depsComplete ? "Nothing." : "Not emitted for boundary nodes."} />
            <h2>Proof uses ({node.deps.proof.length})</h2>
            <DepChips ids={node.deps.proof} empty={node.depsComplete ? "Nothing." : "Not emitted for boundary nodes."} />
            {cone?.view.hasNode(id) && (
              <>
                <h2>Used by, in this view ({usedBy.length})</h2>
                <DepChips ids={usedBy.filter((u) => index.byId.has(u))} empty="Nothing in this view." />
              </>
            )}
          </section>
          <VerifySection node={node} cone={cone} layering={layering} />
        </>
      )}
    </aside>
  );
}
