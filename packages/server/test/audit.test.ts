import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditExport, parseNameComponents, renderName } from "../src/audit.js";
import { EXPORT_META, FIXTURES, fakeExport, removeDir, tempDir } from "./helpers.js";

const small = path.join(FIXTURES, "small.ndjson"); // real export of `t1 t4` (Lean 4.35.0-rc3)
const t4Only = path.join(FIXTURES, "t4-only.ndjson"); // real export of `t4` alone

let dir = "";
beforeAll(() => {
  dir = tempDir();
});
afterAll(() => removeDir(dir));

function write(name: string, text: string): string {
  const f = path.join(dir, name);
  writeFileSync(f, text);
  return f;
}

describe("auditExport on real exports", () => {
  it("finds the target, its kind, the axiom set and the declaration count", async () => {
    const pass = await auditExport(small, "t4");
    expect(pass.audit).toMatchObject({
      targetFound: true,
      targetKind: "thm",
      axioms: [],
      standardAxiomsOnly: true,
      declCount: 8,
    });
    expect(pass.audit.targetTypeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pass.sha256).toBe(createHash("sha256").update(readFileSync(small)).digest("hex"));
    expect(pass.bytes).toBe(readFileSync(small).length);
    expect(pass.leanVersion).toBe("4.35.0-rc3");
  });

  it("hashes the type independently of interning ids (t4 has type id 149 in one export, 140 in the other)", async () => {
    const inPair = await auditExport(small, "t4");
    const alone = await auditExport(t4Only, "t4");
    expect(alone.audit.targetFound).toBe(true);
    expect(alone.audit.targetTypeSha256).toBe(inPair.audit.targetTypeSha256);
    // A different statement (t1 : 1 = 1 vs t4 : 2 = 2) hashes differently.
    const t1 = await auditExport(small, "t1");
    expect(t1.audit.targetTypeSha256).not.toBe(inPair.audit.targetTypeSha256);
    // Inductives in the closure are found as group members.
    expect((await auditExport(small, "Nat.succ")).audit).toMatchObject({ targetFound: true, targetKind: "ctor" });
    expect((await auditExport(small, "Nat")).audit.targetKind).toBe("inductive");
    expect((await auditExport(small, "Nat.rec")).audit.targetKind).toBe("rec");
  });
});

describe("auditExport on synthetic exports", () => {
  it("reports a missing target", async () => {
    const f = write("missing.ndjson", fakeExport("Toy.main", { omitTarget: true }));
    const { audit } = await auditExport(f, "Toy.main");
    expect(audit).toMatchObject({ targetFound: false, targetKind: null, targetTypeSha256: null, declCount: 2 });
  });

  it("lists the exact axioms and flags sorryAx and custom axioms as non-standard", async () => {
    const f = write("sorry.ndjson", fakeExport("Toy.main", { axioms: ["propext", "sorryAx", "Toy.«my axiom»"] }));
    const { audit } = await auditExport(f, "Toy.main");
    expect(audit.axioms).toEqual(["Toy.«my axiom»", "propext", "sorryAx"]);
    expect(audit.standardAxiomsOnly).toBe(false);
    const std = write("std.ndjson", fakeExport("Toy.main", { axioms: ["propext", "Classical.choice", "Quot.sound"] }));
    expect((await auditExport(std, "Toy.main")).audit.standardAxiomsOnly).toBe(true);
  });

  it("matches names with «» and numeric components", async () => {
    const decl = "_private.Toy.Basic.0.Foo.«bar baz».x'";
    expect(parseNameComponents(decl)).toEqual(["_private", "Toy", "Basic", 0, "Foo", "bar baz", "x'"]);
    expect(renderName(parseNameComponents(decl))).toBe(decl);
    const f = write("names.ndjson", fakeExport(decl));
    expect((await auditExport(f, decl)).audit.targetFound).toBe(true);
    expect((await auditExport(f, "_private.Toy.Basic.0.Foo.bar")).audit.targetFound).toBe(false);
  });

  it("is alpha-invariant: binder names, binder info and id order do not change the type hash", async () => {
    // theorem T : ∀ (p : Prop), p → p   written twice with different ids, binder names and info.
    const a = [
      EXPORT_META,
      '{"in":1,"str":{"pre":0,"str":"T"}}',
      '{"in":2,"str":{"pre":0,"str":"p"}}',
      '{"in":3,"str":{"pre":0,"str":"h"}}',
      '{"ie":0,"sort":0}',
      '{"bvar":0,"ie":1}',
      '{"bvar":1,"ie":2}',
      '{"forallE":{"binderInfo":"default","body":2,"name":3,"type":1},"ie":3}',
      '{"forallE":{"binderInfo":"default","body":3,"name":2,"type":0},"ie":4}',
      '{"thm":{"all":[1],"levelParams":[],"name":1,"type":4,"value":4}}',
    ].join("\n");
    const b = [
      EXPORT_META,
      '{"in":7,"str":{"pre":0,"str":"q"}}',
      '{"in":9,"str":{"pre":0,"str":"T"}}',
      '{"bvar":1,"ie":20}',
      '{"bvar":0,"ie":21}',
      '{"ie":22,"sort":0}',
      '{"forallE":{"binderInfo":"implicit","body":20,"name":0,"type":21},"ie":23}',
      '{"forallE":{"binderInfo":"strictImplicit","body":23,"name":7,"type":22},"ie":24}',
      '{"thm":{"all":[9],"levelParams":[],"name":9,"type":24,"value":24}}',
    ].join("\n");
    // ∀ (p : Prop), p → Prop  differs.
    const c = a.replace('"body":2,"name":3,"type":1', '"body":0,"name":3,"type":1');
    const ha = (await auditExport(write("a.ndjson", a), "T")).audit.targetTypeSha256;
    const hb = (await auditExport(write("b.ndjson", b), "T")).audit.targetTypeSha256;
    const hc = (await auditExport(write("c.ndjson", c), "T")).audit.targetTypeSha256;
    expect(ha).toMatch(/^[0-9a-f]{64}$/);
    expect(hb).toBe(ha);
    expect(hc).not.toBe(ha);
  });

  it("walks very deep and very shared types without recursion", async () => {
    // A 200 000-deep chain of `app` (would overflow a recursive walk) plus heavy sharing.
    const n = 200_000;
    const lines = [EXPORT_META, '{"in":1,"str":{"pre":0,"str":"Deep"}}', '{"ie":0,"sort":0}'];
    for (let i = 1; i <= n; i++) lines.push(`{"app":{"arg":${i - 1},"fn":${i - 1}},"ie":${i}}`);
    lines.push(`{"thm":{"all":[1],"levelParams":[],"name":1,"type":${n},"value":0}}`);
    const t0 = performance.now();
    const { audit } = await auditExport(write("deep.ndjson", lines.join("\n")), "Deep");
    expect(audit.targetFound).toBe(true);
    expect(audit.targetTypeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(performance.now() - t0).toBeLessThan(15_000);
  });

  it("reports a null type hash (not a crash) when the type references a missing id", async () => {
    const f = write(
      "dangling.ndjson",
      [EXPORT_META, '{"in":1,"str":{"pre":0,"str":"X"}}', '{"thm":{"all":[1],"levelParams":[],"name":1,"type":99,"value":99}}'].join("\n"),
    );
    expect((await auditExport(f, "X")).audit).toMatchObject({ targetFound: true, targetTypeSha256: null });
  });
});
