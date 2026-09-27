import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExtractError, IMPORTS_MARKER, extractProject, extractorArgs, locateExtractScript, parseGraph } from "../src/extract.js";
import { exeName } from "../src/project.js";
import { FakeRunner, fakeOlean, fakeProject, loadToyGraph, removeDir, tempDir, type FakeCall, type FakeReply } from "./helpers.js";

describe("extractor CLI contract", () => {
  it("builds the argument list in the documented shape", () => {
    expect(
      extractorArgs({
        out: "/p/.proofflow/graph.json.tmp",
        projectDir: "F:/my proj",
        projectName: "toy",
        roots: ["Toy", "Extra.A"],
        localPrefixes: ["Toy", "Extra"],
        expandExternal: true,
        statements: false,
        statementMaxChars: 500,
      }),
    ).toEqual([
      "--out",
      "/p/.proofflow/graph.json.tmp",
      "--project-dir",
      "F:/my proj",
      "--project-name",
      "toy",
      "--root",
      "Toy",
      "--root",
      "Extra.A",
      "--local-prefix",
      "Toy",
      "--local-prefix",
      "Extra",
      "--expand-external",
      "--statement-max-chars",
      "500",
      "--no-statements",
    ]);
    expect(extractorArgs({ out: "o", projectDir: "d", projectName: "n", roots: ["R"] })).toEqual([
      "--out",
      "o",
      "--project-dir",
      "d",
      "--project-name",
      "n",
      "--root",
      "R",
    ]);
  });
});

describe("parseGraph", () => {
  it("returns at most 10 issues", () => {
    const bad = { meta: {}, stats: {}, nodes: Array.from({ length: 30 }, () => ({ id: "" })) };
    try {
      parseGraph(JSON.stringify(bad));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ExtractError);
      expect((e as ExtractError).issues).toHaveLength(10);
      expect((e as ExtractError).message).toMatch(/first 10 shown/);
    }
  });
  it("rejects non-JSON", () => {
    expect(() => parseGraph("{")).toThrow(/not valid JSON/);
  });
});

describe("locateExtractScript", () => {
  let dir = "";
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => removeDir(dir));

  it("prefers PROOFFLOW_EXTRACT_SCRIPT", () => {
    const f = path.join(dir, "Custom.lean");
    writeFileSync(f, "");
    expect(locateExtractScript({ PROOFFLOW_EXTRACT_SCRIPT: f })).toBe(f);
    expect(() => locateExtractScript({ PROOFFLOW_EXTRACT_SCRIPT: path.join(dir, "missing.lean") })).toThrow(ExtractError);
  });

  it("walks up from the module until lean/Extract.lean exists", () => {
    mkdirSync(path.join(dir, "lean"), { recursive: true });
    mkdirSync(path.join(dir, "packages", "server", "dist"), { recursive: true });
    writeFileSync(path.join(dir, "lean", "Extract.lean"), "");
    const from = pathToFileURL(path.join(dir, "packages", "server", "dist", "extract.js")).href;
    expect(locateExtractScript({}, from)).toBe(path.join(dir, "lean", "Extract.lean"));
  });
});

describe("extractProject", () => {
  let dir = "";
  let env: NodeJS.ProcessEnv = {};
  let lake = "";
  let script = "";
  beforeEach(() => {
    dir = tempDir();
    const bin = path.join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    lake = path.join(bin, exeName("lake"));
    writeFileSync(lake, "", { mode: 0o755 });
    env = { PATH: bin };
    script = path.join(dir, "Extract.lean");
    for (const m of ["Toy", "Toy.Main", "Extra"]) fakeOlean(dir, m);
    writeFileSync(script, "def main (args : List String) : IO Unit := pure ()\n");
  });
  afterEach(() => removeDir(dir));

  function handler(graphText: string, extra: { build?: FakeReply; extract?: FakeReply } = {}) {
    return (call: FakeCall): FakeReply => {
      if (call.args[0] === "build") return extra.build ?? { exitCode: 0, stdout: "Build completed successfully.\n" };
      const out = call.args[call.args.indexOf("--out") + 1] ?? "";
      return extra.extract ?? { exitCode: 0, stderr: "progress 1/2\nprogress 2/2\n", effect: () => writeFileSync(out, graphText) };
    };
  }

  it("runs lake build, then `lake env lean --run <script> -- ...`, validates and writes graph.json", async () => {
    const project = fakeProject(dir);
    const graph = loadToyGraph();
    const runner = new FakeRunner(handler(JSON.stringify(graph)));
    const logs: string[] = [];
    const res = await extractProject({ project, runner, env, scriptPath: script, log: (l) => logs.push(l) });
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]?.cmd).toBe(lake);
    expect(runner.calls[0]?.args).toEqual(["build"]);
    const args = runner.calls[1]?.args ?? [];
    expect(args.slice(0, 5)).toEqual(["env", "lean", "--run", script, "--"]);
    expect(args).toContain("--project-dir");
    expect(args[args.indexOf("--project-dir") + 1]).toBe(project.dirPosix);
    expect(args[args.indexOf("--root") + 1]).toBe("Toy");
    expect(args[args.indexOf("--statement-max-chars") + 1]).toBe("2000");
    expect(runner.calls[1]?.opts.cwd).toBe(project.dir);
    expect(runner.calls.every((c) => c.opts.stdin === "ignore" && c.opts.timeoutMs > 0)).toBe(true);
    expect(res.outPath).toBe(path.join(project.stateDir, "graph.json"));
    expect(JSON.parse(readFileSync(res.outPath, "utf8"))).toEqual(graph);
    expect(res.graph.stats.nodes).toBe(graph.nodes.length);
    expect(logs).toContain("progress 2/2");
    expect(existsSync(path.join(project.stateDir, ".gitignore"))).toBe(true);
  });

  it("skips the build with build: false and passes flags through", async () => {
    const project = fakeProject(dir);
    const runner = new FakeRunner(handler(JSON.stringify(loadToyGraph())));
    await extractProject({
      project,
      runner,
      env,
      scriptPath: script,
      build: false,
      roots: ["Toy.Main"],
      expandExternal: true,
      statements: false,
    });
    expect(runner.calls).toHaveLength(1);
    const args = runner.calls[0]?.args ?? [];
    expect(args).toContain("--expand-external");
    expect(args).toContain("--no-statements");
    expect(args[args.indexOf("--root") + 1]).toBe("Toy.Main");
  });

  it("keeps the previous graph.json when the output is invalid", async () => {
    const project = fakeProject(dir);
    mkdirSync(project.stateDir, { recursive: true });
    const graphPath = path.join(project.stateDir, "graph.json");
    writeFileSync(graphPath, "previous");
    const runner = new FakeRunner(handler(JSON.stringify({ meta: { schemaVersion: 2 }, nodes: [] })));
    const err = await extractProject({ project, runner, env, scriptPath: script, build: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtractError);
    expect((err as ExtractError).issues.length).toBeGreaterThan(0);
    expect((err as ExtractError).issues.length).toBeLessThanOrEqual(10);
    expect(readFileSync(graphPath, "utf8")).toBe("previous");
    expect(existsSync(`${graphPath}.invalid.json`)).toBe(true);
  });

  it("fails on a build error without running the extractor, and on extractor errors", async () => {
    const project = fakeProject(dir);
    const r1 = new FakeRunner(handler("{}", { build: { exitCode: 1, stderr: "error: Toy/Basic.lean:3:0: unknown identifier" } }));
    await expect(extractProject({ project, runner: r1, env, scriptPath: script })).rejects.toThrow(/lake build failed.*unknown identifier/);
    expect(r1.calls).toHaveLength(1);
    const r2 = new FakeRunner(handler("{}", { extract: { exitCode: 1, stderr: "uncaught exception: unknown module prefix 'Toy'" } }));
    await expect(extractProject({ project, runner: r2, env, scriptPath: script, build: false })).rejects.toThrow(/extractor failed/);
    const r3 = new FakeRunner(handler("{}", { extract: { timedOut: true } }));
    await expect(extractProject({ project, runner: r3, env, scriptPath: script, build: false })).rejects.toThrow(/timed out/);
  });

  it("passes every library name as --local-prefix by default, and explicit prefixes instead when given", async () => {
    const project = { ...fakeProject(dir), libs: [{ name: "Toy", srcDir: null, roots: [], globs: ["Toy.+"] }] };
    const runner = new FakeRunner(handler(JSON.stringify(loadToyGraph())));
    await extractProject({ project, runner, env, scriptPath: script, build: false, roots: ["Toy.Main"] });
    const args = runner.calls[0]?.args ?? [];
    expect(args.filter((_, i) => args[i - 1] === "--local-prefix")).toEqual(["Toy"]);
    await extractProject({ project, runner, env, scriptPath: script, build: false, roots: ["Toy.Main"], localPrefixes: ["Toy.Main"] });
    const args2 = runner.calls[1]?.args ?? [];
    expect(args2.filter((_, i) => args2[i - 1] === "--local-prefix")).toEqual(["Toy.Main"]);
  });

  it("fails before running the extractor when a root module has no .olean", async () => {
    const project = fakeProject(dir);
    const runner = new FakeRunner(handler(JSON.stringify(loadToyGraph())));
    const err = await extractProject({ project, runner, env, scriptPath: script, build: false, roots: ["YMEYM"] }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ExtractError);
    expect((err as Error).message).toMatch(/No \.olean for root module YMEYM/);
    expect((err as Error).message).toMatch(/--root/);
    expect(runner.calls).toHaveLength(0);
    // Core modules live in the toolchain, not the project: not checked.
    await extractProject({ project, runner, env, scriptPath: script, build: false, roots: ["Init.Core"] });
    expect(runner.calls).toHaveLength(1);
  });

  it("materialises a template that contains the imports marker", async () => {
    const project = fakeProject(dir);
    const template = path.join(dir, "Template.lean");
    writeFileSync(template, `${IMPORTS_MARKER}\nimport Lean\ndef main : IO Unit := pure ()\n`);
    const runner = new FakeRunner(handler(JSON.stringify(loadToyGraph())));
    await extractProject({ project, runner, env, scriptPath: template, build: false, roots: ["Toy", "Extra"] });
    const used = runner.calls[0]?.args[3] ?? "";
    expect(used).toBe(path.join(project.stateDir, "Extract.lean"));
    expect(readFileSync(used, "utf8").startsWith("import Toy\nimport Extra\n")).toBe(true);
  });
});
