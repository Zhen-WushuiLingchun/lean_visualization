import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExportError, NdjsonStats, declSlug, digestFile, exportDecl, exportPaths } from "../src/export.js";
import { FIXTURES, FakeRunner, fakeExport, fakeProject, fakeToolchain, loadToyGraph, removeDir, tempDir } from "./helpers.js";

describe("declSlug", () => {
  const names = [
    "Foo.«bar baz».x'",
    "Foo.bar",
    "Foo.«bar/baz»",
    "Foo.«..».«..».secret",
    "CON",
    "con.foo",
    "nul",
    "a\\b:c*d?e\"f<g>h|i",
    "λ.α₁",
    "_private.Toy.Basic.0.Toy.helper",
    ".hidden",
    "x".repeat(500),
  ];

  it("is safe ASCII, bounded, and ends with 8 hex chars of sha1(name)", () => {
    for (const n of names) {
      const s = declSlug(n);
      expect(s).toMatch(/^[A-Za-z0-9._-]+-[0-9a-f]{8}$/);
      expect(s.endsWith(createHash("sha1").update(n, "utf8").digest("hex").slice(0, 8))).toBe(true);
      expect(s).not.toMatch(/^\./);
      expect(s).not.toContain("..");
      expect(s).not.toMatch(/[\\/]/);
      expect(s.length).toBeLessThanOrEqual(80 + 1 + 8 + 1);
      expect(s.split(".")[0]?.toLowerCase()).not.toMatch(/^(con|prn|aux|nul|com\d|lpt\d)$/);
    }
  });

  it("keeps the readable part of the example name", () => {
    expect(declSlug("Foo.«bar baz».x'")).toMatch(/^Foo\._bar_baz_\.x_-[0-9a-f]{8}$/);
  });

  it("is injective on names whose readable parts collide", () => {
    expect(declSlug("a b")).not.toBe(declSlug("a_b"));
    expect(new Set(names.map(declSlug)).size).toBe(names.length);
  });

  it("stays inside the export dir", () => {
    const p = exportPaths({ stateDir: path.resolve("state") }, "Foo.«..».«..».secret");
    expect(path.dirname(p.file)).toBe(path.resolve("state", "export"));
  });
});

describe("NdjsonStats (streaming sha256 and record count)", () => {
  const file = path.join(FIXTURES, "small.ndjson");
  const buf = readFileSync(file);
  const expectedHash = createHash("sha256").update(buf).digest("hex");
  const expectedDecls = buf
    .toString("utf8")
    .split("\n")
    .filter((l) => /^\{"(axiom|def|thm|opaque|quot|inductive)":/.test(l)).length;

  it("the fixture is a real export with 8 declaration records", () => {
    expect(expectedDecls).toBe(8);
  });

  it.each([1, 3, 7, 32, 33, 4096, buf.length])("gives the same result for chunk size %i", (size) => {
    const s = new NdjsonStats();
    for (let i = 0; i < buf.length; i += size) s.push(buf.subarray(i, i + size));
    s.end();
    expect(s.digest()).toBe(expectedHash);
    expect(s.bytes).toBe(buf.length);
    expect(s.decls).toBe(expectedDecls);
    expect(s.leanVersion()).toBe("4.35.0-rc3");
  });

  it("counts only records whose first key is a declaration kind", () => {
    const s = new NdjsonStats();
    s.push(Buffer.from('{"meta":{}}\n{"const":{"name":1},"ie":1}\n{ "def" : {}}\n{"in":2,"str":{"pre":0,"str":"thm"}}\n{"quot":{}}'));
    s.end();
    expect(s.decls).toBe(2);
    expect(s.lines).toBe(5);
  });

  it("digestFile streams a file from disk", async () => {
    const d = await digestFile(file);
    expect(d).toEqual({ sha256: expectedHash, bytes: buf.length, decls: 8, leanVersion: "4.35.0-rc3" });
  });
});

describe("exportDecl", () => {
  let dir = "";
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => removeDir(dir));

  const graph = loadToyGraph();

  it("runs `lake env leanexport <module> -- <decl>` and streams stdout to the export file", async () => {
    const project = fakeProject(dir);
    const toolchain = fakeToolchain(dir);
    const content = fakeExport("Toy.main");
    const runner = new FakeRunner(() => ({ exitCode: 0, stdout: content }));
    const info = await exportDecl({ project, graph, decl: "Toy.main", toolchain, runner });
    expect(runner.calls[0]?.cmd).toBe(toolchain.lake);
    expect(runner.calls[0]?.args).toEqual(["env", "leanexport", "Toy.Main", "--", "Toy.main"]);
    expect(runner.calls[0]?.opts.cwd).toBe(project.dir);
    expect(runner.calls[0]?.opts.stdin).toBe("ignore");
    expect(info.file).toBe(exportPaths(project, "Toy.main").file);
    expect(readFileSync(info.file, "utf8")).toBe(content);
    expect(info.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(info.decls).toBe(2);
    expect(info.leanVersion).toBe("4.35.0-rc3");
    expect(info.reused).toBe(false);
  });

  it("treats PANIC on stderr as failure even with exit 0, and leaves no file behind", async () => {
    const project = fakeProject(dir);
    const toolchain = fakeToolchain(dir);
    const runner = new FakeRunner(() => ({
      exitCode: 0,
      stdout: '{"meta":{}}\n',
      stderr: "PANIC at LeanExport.dumpConstant LeanExport.Basic:254:48: Constant Toy.main not found in environment.\n",
    }));
    const err = await exportDecl({ project, graph, decl: "Toy.main", toolchain, runner }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportError);
    expect((err as ExportError).code).toBe("panic");
    expect((err as ExportError).message).toMatch(/PANIC/);
    const files = existsSync(path.join(project.stateDir, "export")) ? readdirSync(path.join(project.stateDir, "export")) : [];
    expect(files.filter((f) => f.endsWith(".ndjson") || f.endsWith(".partial"))).toEqual([]);
  });

  it("treats a non-zero exit, a timeout and an empty export as failures", async () => {
    const project = fakeProject(dir);
    const toolchain = fakeToolchain(dir);
    const codes: Array<[Record<string, unknown>, string]> = [
      [{ exitCode: 1, stderr: "unknown module" }, "failed"],
      [{ timedOut: true }, "timeout"],
      [{ exitCode: 0, stdout: '{"meta":{}}\n' }, "empty"],
    ];
    for (const [reply, code] of codes) {
      const runner = new FakeRunner(() => reply);
      const err = await exportDecl({ project, graph, decl: "Toy.main", toolchain, runner }).catch((e: unknown) => e);
      expect((err as ExportError).code).toBe(code);
    }
  });

  it("refuses a declaration that is not in graph.json without spawning anything", async () => {
    const runner = new FakeRunner(() => ({ exitCode: 0 }));
    const err = await exportDecl({
      project: fakeProject(dir),
      graph,
      decl: "doesNotExist",
      toolchain: fakeToolchain(dir),
      runner,
    }).catch((e: unknown) => e);
    expect((err as ExportError).code).toBe("unknown-decl");
    expect(runner.calls).toHaveLength(0);
  });

  it("reuses an export only when it is bound to the same .olean and toolchain", async () => {
    const project = fakeProject(dir);
    const toolchain = fakeToolchain(dir);
    const runner = new FakeRunner(() => ({ exitCode: 0, stdout: fakeExport("Toy.main") }));
    const binding = { oleanSha256: "a".repeat(64), toolchain: "lean 4.35.0-rc3 at /tc" };
    const run = (extra: Partial<Parameters<typeof exportDecl>[0]> = {}) =>
      exportDecl({ project, graph, decl: "Toy.main", toolchain, runner, binding, ...extra });
    const first = await run();
    expect(first.binding).toEqual(binding);
    const second = await run();
    expect(runner.calls).toHaveLength(1);
    expect(second.reused).toBe(true);
    expect(second.sha256).toBe(first.sha256);
    expect(second.audit.targetFound).toBe(true);
    await run({ force: true });
    expect(runner.calls).toHaveLength(2);
    // Rebuilt .olean (graph mtime unchanged): fresh export.
    await run({ binding: { ...binding, oleanSha256: "b".repeat(64) } });
    expect(runner.calls).toHaveLength(3);
    // Different toolchain: fresh export.
    await run({ binding: { oleanSha256: "b".repeat(64), toolchain: "lean 4.36.0 at /tc2" } });
    expect(runner.calls).toHaveLength(4);
    // Unknown .olean (null) or no binding at all: never reused.
    await run({ binding: { oleanSha256: null, toolchain: "lean 4.36.0 at /tc2" } });
    await run({ binding: { oleanSha256: null, toolchain: "lean 4.36.0 at /tc2" } });
    expect(runner.calls).toHaveLength(6);
    await exportDecl({ project, graph, decl: "Toy.main", toolchain, runner });
    expect(runner.calls).toHaveLength(7);
    // Graph mtime stays an extra condition.
    await run();
    const past = new Date(Date.now() - 60_000);
    utimesSync(first.file, past, past);
    await run({ graphMtimeMs: Date.now() });
    expect(runner.calls).toHaveLength(9);
  });

  it("refuses an export that does not contain the requested declaration", async () => {
    const project = fakeProject(dir);
    const toolchain = fakeToolchain(dir);
    const runner = new FakeRunner(() => ({ exitCode: 0, stdout: fakeExport("Toy.main", { omitTarget: true }) }));
    const err = await exportDecl({ project, graph, decl: "Toy.main", toolchain, runner }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportError);
    expect((err as ExportError).code).toBe("target-missing");
    expect((err as Error).message).toMatch(/target declaration not found in export/);
    expect(existsSync(exportPaths(project, "Toy.main").file)).toBe(false);
  });
});
