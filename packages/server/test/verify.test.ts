import { createHash } from "node:crypto";
import path from "node:path";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { VerifyResultSchema, type CheckerResult } from "@proofflow/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  VerifyError,
  cacheFileOf,
  mapLimit,
  mergeCheckerResults,
  moduleCacheFileOf,
  moduleFingerprint,
  parseCheckerList,
  readCachedResults,
  resolveCheckerSelection,
  toolchainIdentity,
  verifyDecl,
} from "../src/verify.js";
import { exeName } from "../src/project.js";
import {
  FakeRunner,
  fakeExport,
  fakeOlean,
  fakeProject,
  fakeToolchain,
  loadToyGraph,
  pipelineHandler,
  removeDir,
  tempDir,
} from "./helpers.js";

const graph = loadToyGraph();

function result(checker: CheckerResult["checker"], status: CheckerResult["status"], durationMs = 1): CheckerResult {
  return { checker, status, exitCode: 0, durationMs, command: [checker], binarySha256: null, ranAt: null, stdoutTail: "", stderrTail: "", rejectedDecl: null };
}

describe("checker selection", () => {
  it("parses CLI lists, `all` and `L1`", () => {
    expect(parseCheckerList("L1")).toBe("L1");
    expect(parseCheckerList("all")).toBe("all");
    expect(parseCheckerList("con-ron, leanchecker,nanoda_bin")).toEqual(["leanchecker", "nanoda", "con-ron"]);
    expect(() => parseCheckerList("leanchecker,bogus")).toThrow(VerifyError);
  });

  it("defaults to L1 and expands `all` to L1 plus available L2", () => {
    const dir = tempDir();
    try {
      const tc = fakeToolchain(dir, ["leanchecker", "lean4lean", "con-ron"]);
      expect(resolveCheckerSelection(undefined, tc)).toEqual(["leanchecker"]);
      expect(resolveCheckerSelection("L1", tc)).toEqual(["leanchecker"]);
      expect(resolveCheckerSelection("all", tc)).toEqual(["leanchecker", "lean4lean", "con-ron"]);
      expect(resolveCheckerSelection(["leanchecker-module"], tc)).toEqual(["leanchecker-module"]);
      expect(resolveCheckerSelection(["nanoda", "leanchecker"], tc)).toEqual(["leanchecker", "nanoda"]);
    } finally {
      removeDir(dir);
    }
  });

  it("`all` omits every missing binary, including the L1 checker", () => {
    const dir = tempDir();
    try {
      const tc = fakeToolchain(dir, ["nanoda", "con-leche"]);
      expect(resolveCheckerSelection("all", tc)).toEqual(["nanoda", "con-leche"]);
    } finally {
      removeDir(dir);
    }
  });
});

describe("mergeCheckerResults", () => {
  it("keeps one result per checker, newest wins, canonical order", () => {
    const merged = mergeCheckerResults(
      [result("nanoda", "error"), result("leanchecker", "accepted", 5)],
      [result("nanoda", "accepted"), result("con-leche", "declined")],
    );
    expect(merged.map((r) => `${r.checker}:${r.status}`)).toEqual(["leanchecker:accepted", "nanoda:accepted", "con-leche:declined"]);
  });
});

describe("mapLimit", () => {
  it("never exceeds the limit and preserves order", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (x) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return x * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(2);
  });
});

describe("verifyDecl", () => {
  let dir = "";
  beforeEach(() => {
    dir = tempDir();
    // The modules of the fixture graph are "built": exports get bound to these .oleans.
    for (const m of ["Toy.Basic", "Toy.Main", "Toy.Axioms"]) fakeOlean(dir, m);
  });
  afterEach(() => removeDir(dir));

  it("runs L1 by default and persists the result under cache/<slug>/<exportHash>.json", async () => {
    const project = fakeProject(dir);
    const toolchain = fakeToolchain(dir);
    const runner = new FakeRunner(pipelineHandler(toolchain));
    const r = await verifyDecl({ project, graph, decl: "Toy.clean_lemma", toolchain, runner });
    expect(r.verdict).toBe("accepted");
    expect(r.checkers.map((c) => c.checker)).toEqual(["leanchecker"]);
    expect(r.module).toBe("Toy.Basic");
    expect(r.exportDecls).toBe(2);
    expect(r.leanVersion).toBe("4.35.0-rc3");
    const stored = VerifyResultSchema.parse(JSON.parse(readFileSync(cacheFileOf(project, "Toy.clean_lemma", r.exportHash), "utf8")));
    expect(stored.checkers.map((c) => c.checker)).toEqual(["leanchecker"]);
  });

  it("merges with cached results: reuses final statuses, runs only what is missing, stores the union", async () => {
    const project = fakeProject(dir);
    const toolchain = fakeToolchain(dir);
    const runner = new FakeRunner(
      pipelineHandler(toolchain, {
        nanoda: { exitCode: 101, stderr: "declaration not found in infer_const, sorryAx" },
        "con-leche": { exitCode: 2, stderr: "con-leche: declined ... via sorryAx" },
        "con-ron": { timedOut: true },
      }),
    );
    const first = await verifyDecl({ project, graph, decl: "Toy.unfinished", toolchain, runner });
    expect(first.verdict).toBe("accepted");
    expect(runner.callsTo("leanchecker")).toHaveLength(1);

    const all = await verifyDecl({ project, graph, decl: "Toy.unfinished", toolchain, runner, checkers: "all" });
    expect(all.exportHash).toBe(first.exportHash);
    expect(all.checkers.map((c) => `${c.checker}:${c.status}`)).toEqual([
      "leanchecker:accepted",
      "leanchecker-paranoid:accepted",
      "lean4lean:accepted",
      "nanoda:declined",
      "con-leche:declined",
      "con-ron:timeout",
    ]);
    expect(all.verdict).toBe("error");
    // leanchecker came from the cache: still one call, and the export was reused (one leanexport).
    expect(runner.callsTo("leanchecker")).toHaveLength(2); // leanchecker + leanchecker-paranoid
    expect(runner.calls.filter((c) => c.args[1] === "leanexport")).toHaveLength(1);

    // Only the L1 checker requested: verdict reflects the request, not the union.
    const l1 = await verifyDecl({ project, graph, decl: "Toy.unfinished", toolchain, runner });
    expect(l1.checkers.map((c) => c.checker)).toEqual(["leanchecker"]);
    expect(l1.verdict).toBe("accepted");

    // The timeout is retried, final statuses are not.
    const before = runner.calls.length;
    await verifyDecl({ project, graph, decl: "Toy.unfinished", toolchain, runner, checkers: ["nanoda", "con-ron"] });
    const retried = runner.calls.slice(before).map((c) => c.cmd);
    expect(retried.some((c) => /con-ron/.test(c))).toBe(true);
    expect(retried.some((c) => /nanoda/.test(c))).toBe(false);

    const cached = await readCachedResults(project, "Toy.unfinished");
    expect(cached).toHaveLength(1);
    expect(cached[0]?.checkers).toHaveLength(6);
    expect(cached[0]?.verdict).toBe("error");
  });

  it("force re-exports and re-runs everything requested", async () => {
    const project = fakeProject(dir);
    const toolchain = fakeToolchain(dir);
    const runner = new FakeRunner(pipelineHandler(toolchain));
    await verifyDecl({ project, graph, decl: "Toy.main", toolchain, runner });
    await verifyDecl({ project, graph, decl: "Toy.main", toolchain, runner, force: true });
    expect(runner.calls.filter((c) => c.args[1] === "leanexport")).toHaveLength(2);
    expect(runner.callsTo("leanchecker")).toHaveLength(2);
  });

  it("reports rejection with the rejected declaration, and unavailable checkers as partial", async () => {
    const project = fakeProject(dir);
    const toolchain = fakeToolchain(dir, ["leanchecker", "con-leche"]);
    const runner = new FakeRunner(
      pipelineHandler(toolchain, { "con-leche": { exitCode: 1, stderr: "con-leche: invalid: type mismatch in theorem Toy.main [at theorem Toy.main, fold position 3]" } }),
    );
    const r = await verifyDecl({ project, graph, decl: "Toy.main", toolchain, runner, checkers: ["leanchecker", "con-leche", "lean4lean"] });
    expect(r.verdict).toBe("rejected");
    expect(r.checkers.find((c) => c.checker === "con-leche")?.rejectedDecl).toBe("Toy.main");
    expect(r.checkers.find((c) => c.checker === "lean4lean")?.status).toBe("unavailable");

    const partial = await verifyDecl({ project, graph, decl: "Toy.double", toolchain, runner, checkers: ["leanchecker", "nanoda"] });
    expect(partial.verdict).toBe("partial");
  });

  it("without leanexport: defaults to module replay, never exports, keys the cache on the .olean", async () => {
    const project = fakeProject(dir);
    const toolchain = fakeToolchain(dir, ["leanchecker"], { leanexport: false });
    const olean = fakeOlean(dir, "Toy.Basic", "binary olean bytes");
    const runner = new FakeRunner(pipelineHandler(toolchain));
    const logs: string[] = [];
    expect(resolveCheckerSelection(undefined, toolchain)).toEqual(["leanchecker-module"]);
    expect(resolveCheckerSelection("all", toolchain)).toEqual(["leanchecker-module"]);

    const r = await verifyDecl({ project, graph, decl: "Toy.double_eq", toolchain, runner, log: (l) => logs.push(l) });
    expect(r.checkers.map((c) => `${c.checker}:${c.status}`)).toEqual(["leanchecker-module:accepted"]);
    expect(r.verdict).toBe("accepted");
    expect(r.module).toBe("Toy.Basic");
    expect(r.exportHash).toBe(createHash("sha256").update("binary olean bytes").digest("hex"));
    expect(r.exportBytes).toBe(statSync(olean).size);
    expect(r.exportDecls).toBeNull();
    expect(r.exportDurationMs).toBe(0);
    expect(runner.calls.some((c) => c.args.includes("leanexport"))).toBe(false);
    expect(runner.calls.map((c) => c.args)).toEqual([["env", "leanchecker", "Toy.Basic"]]);
    expect(logs.some((l) => l.startsWith("module replay of Toy.Basic"))).toBe(true);
    expect(existsSync(cacheFileOf(project, "Toy.double_eq", r.exportHash))).toBe(true);
    expect(existsSync(moduleCacheFileOf(project, "Toy.Basic", r.exportHash))).toBe(true);

    // Another declaration of the same module reuses the module replay.
    const again = await verifyDecl({ project, graph, decl: "Toy.clean_lemma", toolchain, runner, log: (l) => logs.push(l) });
    expect(again.checkers[0]?.status).toBe("accepted");
    expect(runner.calls).toHaveLength(1);
    expect(logs).toContain("leanchecker-module: cached for module accepted");

    // A rebuilt module (new .olean) is replayed again.
    fakeOlean(dir, "Toy.Basic", "rebuilt olean");
    const rebuilt = await verifyDecl({ project, graph, decl: "Toy.double_eq", toolchain, runner });
    expect(rebuilt.exportHash).not.toBe(r.exportHash);
    expect(runner.calls).toHaveLength(2);
  });

  it("without leanexport: export-based checkers in a mixed request are unavailable", async () => {
    const project = fakeProject(dir);
    const toolchain = fakeToolchain(dir, ["leanchecker", "nanoda"], { leanexport: false });
    fakeOlean(dir, "Toy.Main");
    const runner = new FakeRunner(pipelineHandler(toolchain));
    const r = await verifyDecl({
      project,
      graph,
      decl: "Toy.main",
      toolchain,
      runner,
      checkers: ["leanchecker", "leanchecker-module", "nanoda"],
    });
    expect(r.checkers.map((c) => `${c.checker}:${c.status}`)).toEqual([
      "leanchecker:unavailable",
      "leanchecker-module:accepted",
      "nanoda:unavailable",
    ]);
    expect(r.verdict).toBe("partial");
    expect(r.exportDecls).toBeNull();
    expect(runner.calls).toHaveLength(1);
  });

  it("with leanexport: a mixed request exports for the export-based checkers and replays the module", async () => {
    const project = fakeProject(dir);
    const toolchain = fakeToolchain(dir);
    fakeOlean(dir, "Toy.Basic");
    const runner = new FakeRunner(pipelineHandler(toolchain));
    const r = await verifyDecl({ project, graph, decl: "Toy.double", toolchain, runner, checkers: ["leanchecker", "leanchecker-module"] });
    expect(r.checkers.map((c) => `${c.checker}:${c.status}`)).toEqual(["leanchecker:accepted", "leanchecker-module:accepted"]);
    expect(r.exportDecls).toBe(2); // the export's hash is the cache key
    expect(runner.calls.filter((c) => c.args[1] === "leanexport")).toHaveLength(1);
    // Module-only requests on a 4.35 toolchain skip the export entirely.
    const before = runner.calls.length;
    const m = await verifyDecl({ project, graph, decl: "Toy.double_eq", toolchain, runner, checkers: ["leanchecker-module"] });
    expect(m.exportDecls).toBeNull();
    expect(runner.calls.length).toBe(before); // module replay cached from Toy.double's run
  });

  it("moduleFingerprint hashes the .olean, or falls back to module name and Lean version", async () => {
    const project = fakeProject(dir);
    const toolchain = fakeToolchain(dir);
    const missing = await moduleFingerprint(project, "Toy.Nowhere", toolchain);
    expect(missing).toMatchObject({ file: null, bytes: 0, synthetic: true });
    expect(missing.sha256).toBe(createHash("sha256").update("module:Toy.Nowhere\nlean:4.35.0-rc3").digest("hex"));
    const file = fakeOlean(dir, "Toy.Nowhere", "x".repeat(70_000));
    const found = await moduleFingerprint(project, "Toy.Nowhere", toolchain);
    expect(found).toMatchObject({ file, bytes: 70_000, synthetic: false });
    expect(found.sha256).toBe(createHash("sha256").update(readFileSync(file)).digest("hex"));
  });

  it("binds the export to the .olean: a rebuilt .olean with unchanged graph mtime triggers a fresh export", async () => {
    const project = fakeProject(dir);
    const toolchain = fakeToolchain(dir);
    const runner = new FakeRunner(pipelineHandler(toolchain));
    const graphMtimeMs = Date.now() - 3_600_000;
    const exports = () => runner.calls.filter((c) => c.args[1] === "leanexport").length;
    const first = await verifyDecl({ project, graph, decl: "Toy.double_eq", toolchain, runner, graphMtimeMs });
    expect(first.binding.oleanSha256).toBe(createHash("sha256").update("olean of Toy.Basic").digest("hex"));
    expect(first.binding.toolchain).toBe(toolchainIdentity(toolchain));
    expect(first.exportAudit).toMatchObject({ targetFound: true, targetKind: "thm", axioms: ["propext"], standardAxiomsOnly: true, declCount: 2 });
    await verifyDecl({ project, graph, decl: "Toy.double_eq", toolchain, runner, graphMtimeMs });
    expect(exports()).toBe(1);
    fakeOlean(dir, "Toy.Basic", "rebuilt");
    const again = await verifyDecl({ project, graph, decl: "Toy.double_eq", toolchain, runner, graphMtimeMs });
    expect(exports()).toBe(2);
    expect(again.binding.oleanSha256).toBe(createHash("sha256").update("rebuilt").digest("hex"));
  });

  it("re-runs a checker whose binary changed, and records binary sha256 and ranAt", async () => {
    const project = fakeProject(dir);
    const toolchain = fakeToolchain(dir);
    const runner = new FakeRunner(pipelineHandler(toolchain));
    const bin = path.join(toolchain.binDir, exeName("leanchecker"));
    const r1 = await verifyDecl({ project, graph, decl: "Toy.double_eq", toolchain, runner });
    const lc = r1.checkers[0];
    expect(lc?.binarySha256).toBe(createHash("sha256").update(readFileSync(bin)).digest("hex"));
    expect(Date.parse(lc?.ranAt ?? "")).not.toBeNaN();
    await verifyDecl({ project, graph, decl: "Toy.double_eq", toolchain, runner });
    expect(runner.callsTo("leanchecker")).toHaveLength(1);
    writeFileSync(bin, "a patched leanchecker");
    const r3 = await verifyDecl({ project, graph, decl: "Toy.double_eq", toolchain, runner });
    expect(runner.callsTo("leanchecker")).toHaveLength(2);
    expect(r3.checkers[0]?.binarySha256).toBe(createHash("sha256").update("a patched leanchecker").digest("hex"));
  });

  it("refuses to run checkers when the export does not contain the target", async () => {
    const project = fakeProject(dir);
    const toolchain = fakeToolchain(dir);
    const runner = new FakeRunner(({ args }) =>
      args[1] === "leanexport" ? { exitCode: 0, stdout: fakeExport("Toy.main", { omitTarget: true }) } : { exitCode: 0 },
    );
    await expect(verifyDecl({ project, graph, decl: "Toy.main", toolchain, runner })).rejects.toThrow(
      /target declaration not found in export/,
    );
    expect(runner.calls).toHaveLength(1);
  });

  it("reports the exact export axioms, and never accepts without an L1 replay", async () => {
    const project = fakeProject(dir);
    const toolchain = fakeToolchain(dir);
    const base = pipelineHandler(toolchain);
    const runner = new FakeRunner((call) =>
      call.args[1] === "leanexport"
        ? { exitCode: 0, stdout: fakeExport("Toy.unfinished", { axioms: ["propext", "sorryAx"] }) }
        : base(call),
    );
    const r = await verifyDecl({ project, graph, decl: "Toy.unfinished", toolchain, runner, checkers: ["nanoda", "con-ron"] });
    expect(r.checkers.every((c) => c.status === "accepted")).toBe(true);
    expect(r.verdict).toBe("partial");
    expect(r.exportAudit).toMatchObject({ axioms: ["propext", "sorryAx"], standardAxiomsOnly: false });
  });

  it("passes a zero timeout through (no wall-clock kill)", async () => {
    const project = fakeProject(dir);
    const toolchain = fakeToolchain(dir);
    const runner = new FakeRunner(pipelineHandler(toolchain));
    await verifyDecl({ project, graph, decl: "Toy.double", toolchain, runner, exportTimeoutMs: 0, checkerTimeoutMs: 0 });
    expect(runner.calls.map((c) => c.opts.timeoutMs)).toEqual([0, 0]);
  });

  it("refuses unknown declarations", async () => {
    const project = fakeProject(dir);
    const toolchain = fakeToolchain(dir);
    const runner = new FakeRunner(pipelineHandler(toolchain));
    await expect(verifyDecl({ project, graph, decl: "nope", toolchain, runner })).rejects.toThrow(/not in graph.json/);
    expect(runner.calls).toHaveLength(0);
  });

  it("serialises concurrent verifications of the same declaration", async () => {
    const project = fakeProject(dir);
    const toolchain = fakeToolchain(dir);
    const runner = new FakeRunner(pipelineHandler(toolchain));
    const [a, b] = await Promise.all([
      verifyDecl({ project, graph, decl: "Toy.double_eq", toolchain, runner }),
      verifyDecl({ project, graph, decl: "Toy.double_eq", toolchain, runner }),
    ]);
    expect(a.exportHash).toBe(b.exportHash);
    expect(runner.calls.filter((c) => c.args[1] === "leanexport")).toHaveLength(1);
    expect(runner.callsTo("leanchecker")).toHaveLength(1);
  });
});
