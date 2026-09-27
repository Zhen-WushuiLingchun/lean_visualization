import type { Taint } from "@proofflow/schema";
import type { Badge, BadgeKind } from "../graph/badge";
import { TAINT_INFO } from "../graph/trust";

function Icon({ kind }: { kind: BadgeKind }) {
  switch (kind) {
    case "ok":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.2 8.4 6.4 11.4 12.8 4.8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "rejected":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
      );
    case "error":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 3.2v6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="8" cy="12.6" r="1.4" fill="currentColor" />
        </svg>
      );
    case "dash":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 8h8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
      );
    default:
      return null;
  }
}

export function VerifyBadge({ badge, inline = false }: { badge: Badge; inline?: boolean }) {
  const text = badge.kind === "none" ? "Not verified" : `${badge.label}: ${badge.reason}`;
  return (
    <span className={`pf-vbadge${inline ? " is-inline" : ""}`} data-badge={badge.kind} title={text} role="img" aria-label={text}>
      <Icon kind={badge.kind} />
    </span>
  );
}

export function TaintPill({ taint }: { taint: Taint }) {
  const info = TAINT_INFO[taint];
  return (
    <span className="pf-taint" data-border={info.border} title={info.explain}>
      {info.badge}
    </span>
  );
}
