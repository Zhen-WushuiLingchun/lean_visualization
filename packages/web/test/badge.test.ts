import { describe, expect, it } from "vitest";
import { badgeOf, effectiveResult } from "../src/graph/badge";
import { covers } from "../src/state/verifyStore";
import { audit, result, row } from "./fixtures";

describe("badgeOf", () => {
  it("is green only when L1 and every requested checker accepted", () => {
    expect(badgeOf(result([row("leanchecker", "accepted")])).kind).toBe("ok");
    expect(badgeOf(result([row("leanchecker", "accepted"), row("nanoda", "accepted"), row("con-ron", "skipped")])).kind).toBe("ok");
  });
  it("accepts the module-replay fallback as the kernel check", () => {
    const b = badgeOf(result([row("leanchecker-module", "accepted")], { exportDecls: null }));
    expect(b.kind).toBe("ok");
    expect(b.reason).toContain("module replay");
    expect(badgeOf(result([row("leanchecker-module", "accepted"), row("nanoda", "accepted")])).kind).toBe("ok");
    expect(badgeOf(result([row("leanchecker", "accepted"), row("leanchecker-module", "accepted")])).kind).toBe("ok");
  });
  it("needs every requested checker, including a second kernel checker", () => {
    expect(badgeOf(result([row("leanchecker", "accepted"), row("leanchecker-module", "unavailable")])).kind).toBe("dash");
    expect(badgeOf(result([row("leanchecker-module", "rejected"), row("leanchecker", "accepted")])).kind).toBe("rejected");
    expect(badgeOf(result([row("leanchecker-module", "timeout")])).kind).toBe("error");
    expect(badgeOf(result([row("leanchecker-module", "declined"), row("nanoda", "accepted")])).kind).toBe("dash");
  });
  it("is never green without the kernel", () => {
    expect(badgeOf(result([row("lean4lean", "accepted")])).kind).toBe("dash");
    expect(badgeOf(result([row("leanchecker", "skipped"), row("nanoda", "accepted")])).kind).toBe("dash");
  });
  it("shows declines as a grey dash with the reason", () => {
    const b = badgeOf(
      result([row("leanchecker", "accepted"), row("con-leche", "declined", { stdoutTail: "con-leche: not implemented yet: non-standard axiom (Demo.Axioms.oracle)\n" })]),
    );
    expect(b.kind).toBe("dash");
    expect(b.label).toBe("Declined");
    expect(b.reason).toContain("non-standard axiom");
  });
  it("shows unavailable checkers as a grey dash", () => {
    expect(badgeOf(result([row("leanchecker", "accepted"), row("nanoda", "unavailable")])).kind).toBe("dash");
  });
  it("is red on any rejection, even if others accepted", () => {
    const b = badgeOf(result([row("leanchecker", "accepted"), row("lean4lean", "rejected", { rejectedDecl: "Demo.bad" }), row("nanoda", "error")]));
    expect(b.kind).toBe("rejected");
    expect(b.reason).toContain("Demo.bad");
  });
  it("is amber on error or timeout", () => {
    expect(badgeOf(result([row("leanchecker", "timeout")])).kind).toBe("error");
    expect(badgeOf(result([row("leanchecker", "accepted"), row("nanoda", "error", { exitCode: 134 })])).kind).toBe("error");
  });
  it("ignores the server verdict", () => {
    expect(badgeOf(result([row("lean4lean", "accepted")], { verdict: "accepted" })).kind).toBe("dash");
  });
  it("is red Export mismatch when the target is missing from the export, whatever the checkers say", () => {
    const b = badgeOf(result([row("leanchecker", "accepted"), row("nanoda", "accepted")], { exportAudit: audit({ targetFound: false, targetKind: null, targetTypeSha256: null }) }));
    expect(b.kind).toBe("rejected");
    expect(b.label).toBe("Export mismatch");
    expect(b.reason).toContain("Demo.x");
    expect(badgeOf(result([row("leanchecker", "error")], { exportAudit: audit({ targetFound: false }) })).label).toBe("Export mismatch");
  });
  it("keeps its kind but names non-standard axioms from the export audit", () => {
    const withCustom = audit({ axioms: ["Demo.Axioms.oracle", "propext", "sorryAx"], standardAxiomsOnly: false });
    const ok = badgeOf(result([row("leanchecker", "accepted")], { exportAudit: withCustom }));
    expect(ok.kind).toBe("ok");
    expect(ok.reason).toContain("Non-standard axioms in the export: Demo.Axioms.oracle, sorryAx.");
    const dash = badgeOf(result([row("leanchecker", "accepted"), row("con-leche", "declined")], { exportAudit: withCustom }));
    expect(dash.kind).toBe("dash");
    expect(dash.reason).toContain("Demo.Axioms.oracle");
    expect(badgeOf(result([row("leanchecker", "accepted")], { exportAudit: audit() })).reason).not.toContain("Non-standard");
  });
  it("has no badge without a result", () => {
    expect(badgeOf(null).kind).toBe("none");
  });
});

describe("effectiveResult", () => {
  it("fills missing checkers from older results with the same export hash only", () => {
    const newest = result([row("leanchecker", "accepted")], { verifiedAt: "2026-09-27T12:00:00Z" });
    const olderSame = result([row("leanchecker", "rejected"), row("nanoda", "accepted")], { verifiedAt: "2026-09-27T11:00:00Z" });
    const olderOther = result([row("con-ron", "rejected")], { verifiedAt: "2026-09-27T10:00:00Z", exportHash: "zzz" });
    const eff = effectiveResult([olderOther, olderSame, newest]);
    expect(eff?.checkers.map((c) => [c.checker, c.status])).toEqual([
      ["leanchecker", "accepted"],
      ["nanoda", "accepted"],
    ]);
    expect(badgeOf(eff).kind).toBe("ok");
  });
  it("tells whether a cached result covers a request", () => {
    const r = result([row("leanchecker", "accepted"), row("nanoda", "timeout")]);
    expect(covers(r, ["leanchecker"])).toBe(true);
    expect(covers(r, ["leanchecker", "nanoda"])).toBe(false);
    expect(covers(r, ["leanchecker", "con-ron"])).toBe(false);
    expect(covers(result([row("leanchecker", "accepted"), row("con-leche", "declined")]), ["leanchecker", "con-leche"])).toBe(true);
    expect(covers(result([row("leanchecker", "unavailable")]), ["leanchecker"])).toBe(false);
    // Server-resolved requests: any definitive kernel row answers the L1 default.
    expect(covers(result([row("leanchecker-module", "accepted")]), null)).toBe(true);
    expect(covers(result([row("nanoda", "accepted")]), null)).toBe(false);
    expect(covers(result([row("leanchecker-module", "accepted")]), "all")).toBe(false);
    expect(covers(result([row("leanchecker-module", "accepted"), ...(["leanchecker-paranoid", "lean4lean", "nanoda", "con-leche", "con-ron"] as const).map((c) => row(c, "unavailable"))]), "all")).toBe(true);
  });
});
