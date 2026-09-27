import { L1_CHECKERS, L2_CHECKERS } from "@proofflow/schema";
import { BORDER_PALETTE, KIND_PALETTE, type BorderKey, type KindColorKey } from "../graph/colors";
import { CHECKER_INFO } from "../graph/trust";
import { useApp } from "../state/appState";
import { VerifyBadge } from "./Badges";

function EdgeSample({ site }: { site: "stmt" | "proof" | "both" | "axiom" }) {
  const dash = site === "proof" ? "6 4" : site === "axiom" ? "1.5 3.5" : undefined;
  return (
    <svg width="34" height="10" aria-hidden="true">
      <line x1="2" y1="5" x2="32" y2="5" stroke="currentColor" strokeWidth={site === "both" ? 2.8 : 1.4} strokeDasharray={dash} strokeLinecap={site === "axiom" ? "round" : undefined} />
    </svg>
  );
}

/** Checkers with their level and, when the server answered /api/checkers, availability and note. */
function CheckerLegend() {
  const { checkers } = useApp();
  return (
    <>
      <h2>Checkers</h2>
      {[...L1_CHECKERS, ...L2_CHECKERS].map((c) => {
        const info = CHECKER_INFO[c];
        const server = checkers?.find((i) => i.checker === c);
        const state = checkers ? (server?.available ? "available" : "not installed") : null;
        return (
          <div key={c} className="pf-legend__checker" title={server?.note ? `${info.explain}\n${server.note}` : info.explain}>
            <div>
              <code>{c}</code> <span className="pf-muted">{info.level}</span>
              {info.label && <span className="pf-muted">, {info.label}</span>}
              {state && <span className={server?.available ? "pf-muted" : "pf-warn-text"}>, {state}</span>}
            </div>
            {server?.note && <div className="pf-muted pf-small">{server.note}</div>}
          </div>
        );
      })}
    </>
  );
}

export function Legend() {
  return (
    <div className="pf-legend">
      <h2>Header: kind</h2>
      {(Object.keys(KIND_PALETTE) as KindColorKey[]).map((k) => (
        <div key={k} className="pf-legend__row">
          <span className="pf-legend__swatch" data-kind={k} />
          {KIND_PALETTE[k].label}
        </div>
      ))}
      <h2>Border: worst taint</h2>
      {(Object.keys(BORDER_PALETTE) as BorderKey[]).map((k) => (
        <div key={k} className="pf-legend__row">
          <span className="pf-legend__border" data-border={k} />
          {BORDER_PALETTE[k].label}
        </div>
      ))}
      <h2>Badge: verification</h2>
      <div className="pf-legend__row">
        <VerifyBadge inline badge={{ kind: "ok", label: "Accepted", reason: "kernel and every requested checker" }} /> Kernel and every requested checker accepted
      </div>
      <div className="pf-legend__row">
        <VerifyBadge inline badge={{ kind: "rejected", label: "Rejected", reason: "a checker rejected" }} /> A checker rejected
      </div>
      <div className="pf-legend__row">
        <VerifyBadge inline badge={{ kind: "error", label: "Error", reason: "error or timeout" }} /> Error or timeout
      </div>
      <div className="pf-legend__row">
        <VerifyBadge inline badge={{ kind: "dash", label: "Incomplete", reason: "declined or unavailable" }} /> Declined, unavailable or no kernel run
      </div>
      <h2>Edges: dependency to dependent</h2>
      <div className="pf-legend__row">
        <EdgeSample site="stmt" /> Used in the statement
      </div>
      <div className="pf-legend__row">
        <EdgeSample site="proof" /> Used in the proof or body
      </div>
      <div className="pf-legend__row">
        <EdgeSample site="both" /> Used in both
      </div>
      <div className="pf-legend__row">
        <EdgeSample site="axiom" /> Axiom reached through an unexpanded external
      </div>
      <p className="pf-note">Edge colour is the colour of the dependency. External nodes are muted and italic. Auto-generated nodes are drawn at 70 %.</p>
      <CheckerLegend />
    </div>
  );
}
