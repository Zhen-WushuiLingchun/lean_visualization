import { L1_CHECKERS, type CheckerResult, type VerifyResult } from "@proofflow/schema";

/**
 * Verification badge, exactly as AGENTS.md section 5 and docs/VERIFICATION.md:
 * green only when L1 (leanchecker) accepted and every other requested checker accepted;
 * any rejection is red; error or timeout is amber; declined or unavailable is a grey dash with the
 * reason. The server's `verdict` is shown in the panel but never used to paint the badge green.
 */

export type BadgeKind = "none" | "running" | "ok" | "rejected" | "error" | "dash";

export interface Badge {
  kind: BadgeKind;
  /** Short label, e.g. "Accepted". */
  label: string;
  /** One-line explanation for tooltips. */
  reason: string;
}

export const NO_BADGE: Badge = { kind: "none", label: "Not verified", reason: "No verification result yet." };
export const RUNNING_BADGE: Badge = { kind: "running", label: "Running", reason: "Verification in progress." };

/** Last non-empty line of a checker's output, used as the human reason for a decline or error. */
export function lastLine(r: Pick<CheckerResult, "stdoutTail" | "stderrTail">): string {
  for (const text of [r.stderrTail, r.stdoutTail]) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    if (last) return last.length > 160 ? `${last.slice(0, 157)}...` : last;
  }
  return "";
}

function describe(r: CheckerResult): string {
  const why = lastLine(r);
  const code = r.exitCode === null ? "" : ` (exit ${r.exitCode})`;
  return `${r.checker} ${r.status}${code}${why ? `: ${why}` : ""}`;
}

export function badgeOf(result: VerifyResult | null | undefined): Badge {
  if (!result) return NO_BADGE;
  const considered = result.checkers.filter((c) => c.status !== "skipped");
  if (considered.length === 0) return { kind: "dash", label: "Nothing ran", reason: "No checker was run for this result." };

  const rejected = considered.filter((c) => c.status === "rejected");
  if (rejected.length > 0) {
    const who = rejected.map((c) => c.checker + (c.rejectedDecl ? ` on ${c.rejectedDecl}` : "")).join(", ");
    return { kind: "rejected", label: "Rejected", reason: `Rejected by ${who}.` };
  }
  const failed = considered.filter((c) => c.status === "error" || c.status === "timeout");
  if (failed.length > 0) {
    return { kind: "error", label: failed.some((c) => c.status === "timeout") ? "Timeout" : "Error", reason: failed.map(describe).join("; ") };
  }
  const l1 = considered.filter((c) => (L1_CHECKERS as readonly string[]).includes(c.checker));
  const notAccepted = considered.filter((c) => c.status !== "accepted");
  if (l1.length === 0 || l1.some((c) => c.status !== "accepted")) {
    const reason = l1.length === 0 ? "Kernel replay (leanchecker) was not run." : l1.map(describe).join("; ");
    return { kind: "dash", label: "Incomplete", reason };
  }
  if (notAccepted.length > 0) {
    const label = notAccepted.every((c) => c.status === "declined") ? "Declined" : "Incomplete";
    return { kind: "dash", label, reason: notAccepted.map(describe).join("; ") };
  }
  return { kind: "ok", label: "Accepted", reason: `Accepted by ${considered.map((c) => c.checker).join(", ")}.` };
}

/**
 * Collapse cached results for one declaration into the one to display: the newest result, with
 * checker rows from older results of the same export hash filled in where the newest did not run
 * that checker. Rows from a different export hash are never mixed in.
 */
export function effectiveResult(results: readonly VerifyResult[]): VerifyResult | null {
  if (results.length === 0) return null;
  const sorted = [...results].sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt));
  const newest = sorted[0] as VerifyResult;
  const rows = new Map<string, CheckerResult>();
  for (const c of newest.checkers) if (c.status !== "skipped") rows.set(c.checker, c);
  for (const older of sorted.slice(1)) {
    if (older.exportHash !== newest.exportHash) continue;
    for (const c of older.checkers) if (c.status !== "skipped" && !rows.has(c.checker)) rows.set(c.checker, c);
  }
  return { ...newest, checkers: [...rows.values()] };
}
