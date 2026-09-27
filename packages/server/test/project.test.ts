import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProjectError,
  ToolchainError,
  baseEnv,
  defaultRootsOf,
  detectProject,
  exeName,
  parseLakefileLean,
  parseTomlSubset,
  pathKey,
  resolveExecutable,
  resolveToolchain,
  unescapeLeanIdent,
} from "../src/project.js";
import { FIXTURES, FakeRunner, removeDir, tempDir } from "./helpers.js";

const projects = path.join(FIXTURES, "projects");

describe("detectProject: lakefile.toml", () => {
  it("reads name, libraries, roots, srcDir, toolchain and manifest", async () => {
    const p = await detectProject(path.join(projects, "toml-proj"));
    expect(p.name).toBe("toy-toml");
    expect(p.lakefile.kind).toBe("toml");
    expect(p.libs).toEqual([
      { name: "Toy", srcDir: null, roots: [] },
      { name: "Extra", srcDir: "src/extra", roots: ["Extra.A", "Extra.B"] },
    ]);
    expect(p.defaultRoots).toEqual(["Toy", "Extra.A", "Extra.B"]);
    expect(p.toolchain).toBe("leanprover/lean4:v4.35.0-rc3");
    expect((p.manifest as { name: string }).name).toBe("toy-toml");
    expect(p.dirPosix).not.toContain("\\");
    expect(p.stateDir).toBe(path.join(p.dir, ".proofflow"));
  });

  it("honours a stateDir override", async () => {
    const p = await detectProject(path.join(projects, "toml-proj"), { stateDir: "some/where" });
    expect(p.stateDir).toBe(path.resolve("some/where"));
  });
});

describe("detectProject: lakefile.lean", () => {
  it("reads «package», lean_lib names, roots and srcDir, ignoring comments and lean_exe", async () => {
    const p = await detectProject(path.join(projects, "lean-proj"));
    expect(p.lakefile.kind).toBe("lean");
    expect(p.name).toBe("«toy lean»");
    expect(p.libs.map((l) => l.name)).toEqual(["Toy", "Extra"]);
    expect(p.libs[1]).toEqual({ name: "Extra", srcDir: "extra", roots: ["Extra.A", "Extra.«B c»"] });
    expect(p.defaultRoots).toEqual(["Toy", "Extra.A", "Extra.«B c»"]);
    expect(p.toolchain).toBeNull();
    expect(p.manifest).toBeNull();
  });

  it("handles plain identifiers and quoted package names", () => {
    const info = parseLakefileLean('package "my-pkg"\nlean_lib Foo\n@[default_target] lean_lib «Bar»\n');
    expect(info.name).toBe("my-pkg");
    expect(info.libs.map((l) => l.name)).toEqual(["Foo", "Bar"]);
  });

  it("fails clearly without a lakefile", async () => {
    await expect(detectProject(path.join(projects, "empty-proj"))).rejects.toBeInstanceOf(ProjectError);
    await expect(detectProject(path.join(projects, "does-not-exist"))).rejects.toThrow(/not found/);
  });
});

describe("TOML subset", () => {
  it("parses strings, escapes, numbers, booleans, arrays and inline tables", () => {
    const doc = parseTomlSubset(
      [
        'a = "x # not a comment" # comment',
        "b = 'lit\\eral'",
        'c = "tab\\tq\\"u"',
        "d = 42",
        "e = true",
        'f = ["x", "y"]',
        'g = { k = "v", n = 1 }',
        "[t]",
        'h = """',
        "multi",
        'line"""',
      ].join("\n"),
    );
    expect(doc.top).toEqual({
      a: "x # not a comment",
      b: "lit\\eral",
      c: 'tab\tq"u',
      d: 42,
      e: true,
      f: ["x", "y"],
      g: { k: "v", n: 1 },
    });
    expect(doc.tables[0]?.values["h"]).toBe("multi\nline");
  });

  it("defaults a library's roots to its name", () => {
    expect(defaultRootsOf([{ name: "A", srcDir: null, roots: [] }, { name: "B", srcDir: null, roots: ["B.X", "A"] }])).toEqual([
      "A",
      "B.X",
    ]);
  });

  it("unescapes «» only when the name does not need it", () => {
    expect(unescapeLeanIdent("«Toy»")).toBe("Toy");
    expect(unescapeLeanIdent("«my lib»")).toBe("«my lib»");
    expect(unescapeLeanIdent("Foo.«Bar»")).toBe("Foo.Bar");
  });
});

describe("executables and PATH", () => {
  let dir = "";
  afterEach(() => {
    if (dir) removeDir(dir);
  });

  it("prepends ~/.elan/bin (ELAN_HOME) when lake is not on PATH", () => {
    dir = tempDir();
    const elanBin = path.join(dir, "elan", "bin");
    mkdirSync(elanBin, { recursive: true });
    const lake = path.join(elanBin, exeName("lake"));
    writeFileSync(lake, "", { mode: 0o755 });
    const env = baseEnv({ PATH: path.join(dir, "nothing-here"), ELAN_HOME: path.join(dir, "elan") });
    expect(env[pathKey(env)]?.split(path.delimiter)[0]).toBe(elanBin);
    expect(resolveExecutable("lake", env)).toBe(lake);
  });

  it("leaves PATH alone when lake is already found", () => {
    dir = tempDir();
    const bin = path.join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, exeName("lake")), "", { mode: 0o755 });
    const env = baseEnv({ PATH: bin, ELAN_HOME: path.join(dir, "elan") });
    expect(env[pathKey(env)]).toBe(bin);
  });

  it("uses the existing PATH key casing (Windows `Path`)", () => {
    expect(pathKey({ Path: "x" })).toBe("Path");
    expect(pathKey({})).toBe("PATH");
  });
});

describe("resolveToolchain", () => {
  let dir = "";
  afterEach(() => {
    if (dir) removeDir(dir);
  });

  it("takes the last stdout line of `lake env lean --print-prefix` and parses lean --version", async () => {
    dir = tempDir();
    const elanBin = path.join(dir, "elan", "bin");
    mkdirSync(elanBin, { recursive: true });
    writeFileSync(path.join(elanBin, exeName("lake")), "", { mode: 0o755 });
    const project = await detectProject(path.join(projects, "toml-proj"));
    const prefix = path.join(dir, "toolchains", "v4.35.0-rc3");
    const runner = new FakeRunner(({ args }) => {
      if (args.join(" ") === "env lean --print-prefix") return { stdout: `info: toolchain not updated\n${prefix}\n` };
      if (args[0] === "--version") {
        return { stdout: "Lean (version 4.35.0-rc3, x86_64-w64-windows-gnu, commit 470d5ce, Release)\n" };
      }
      return { exitCode: 1 };
    });
    const tc = await resolveToolchain(project, { runner, env: { PATH: "", ELAN_HOME: path.join(dir, "elan") } });
    expect(tc.prefix).toBe(prefix);
    expect(tc.binDir).toBe(path.join(prefix, "bin"));
    expect(tc.leanVersion).toBe("4.35.0-rc3");
    expect(tc.checkerEnv["LEAN_ABORT_ON_PANIC"]).toBe("1");
    expect(tc.checkerEnv[pathKey(tc.checkerEnv)]?.split(path.delimiter)[0]).toBe(tc.binDir);
    expect(runner.calls[0]?.opts.cwd).toBe(project.dir);
    expect(runner.calls[0]?.opts.stdin).toBe("ignore");
  });

  it("reports a missing lake clearly", async () => {
    dir = tempDir();
    const project = await detectProject(path.join(projects, "toml-proj"));
    await expect(
      resolveToolchain(project, { runner: new FakeRunner(() => ({})), env: { PATH: "", ELAN_HOME: path.join(dir, "none") } }),
    ).rejects.toBeInstanceOf(ToolchainError);
  });
});
