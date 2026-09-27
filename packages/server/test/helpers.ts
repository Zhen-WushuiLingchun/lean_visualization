import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckerName, GraphFile } from "@proofflow/schema";
import { parseNameComponents } from "../src/audit.js";
import { ALL_CHECKERS, CHECKER_SPECS } from "../src/checkers.js";
import { exeName, type ProjectInfo, type Toolchain } from "../src/project.js";
import { TAIL_LIMIT, type RunOptions, type RunResult, type Runner } from "../src/runner.js";

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

export function loadToyGraph(): GraphFile {
  return JSON.parse(readFileSync(path.join(FIXTURES, "toy-graph.json"), "utf8")) as GraphFile;
}

/** Temp dir whose name contains a space and non-ASCII characters, like real Windows paths. */
export function tempDir(prefix = "pf test ü"): string {
  return mkdtempSync(path.join(tmpdir(), `${prefix}-`));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export interface FakeReply {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  spawnError?: string | null;
  durationMs?: number;
  /** Side effect before replying (e.g. write the extractor's output file). */
  effect?: () => void;
}

export interface FakeCall {
  cmd: string;
  args: string[];
  opts: RunOptions;
}

export type FakeHandler = (call: FakeCall) => FakeReply | Promise<FakeReply>;

const tail = (s: string): string => (s.length > TAIL_LIMIT ? s.slice(s.length - TAIL_LIMIT) : s);

/** Scripted Runner: streams lines to `onLine`, writes stdout to `stdoutSink` when given. */
export class FakeRunner implements Runner {
  readonly calls: FakeCall[] = [];
  constructor(private readonly handler: FakeHandler) {}
  async run(cmd: string, args: readonly string[], opts: RunOptions): Promise<RunResult> {
    const call: FakeCall = { cmd, args: [...args], opts };
    this.calls.push(call);
    const reply = await this.handler(call);
    reply.effect?.();
    const stdout = reply.stdout ?? "";
    const stderr = reply.stderr ?? "";
    if (opts.stdoutSink) {
      await new Promise<void>((resolve) => opts.stdoutSink?.end(stdout, () => resolve()));
    } else {
      for (const l of stdout.split(/\r?\n/)) if (l.length > 0) opts.onLine?.("stdout", l);
    }
    for (const l of stderr.split(/\r?\n/)) if (l.length > 0) opts.onLine?.("stderr", l);
    const timedOut = reply.timedOut ?? false;
    const spawnError = reply.spawnError ?? null;
    return {
      exitCode: timedOut || spawnError ? null : reply.exitCode === undefined ? 0 : reply.exitCode,
      signal: null,
      timedOut,
      spawnError,
      stdout: opts.stdoutSink ? "" : tail(stdout),
      stderr: tail(stderr),
      durationMs: reply.durationMs ?? 7,
    };
  }
  /** Calls whose binary basename starts with `name`. */
  callsTo(name: string): FakeCall[] {
    return this.calls.filter((c) => path.basename(c.cmd).startsWith(name));
  }
}

/**
 * A toolchain in a temp dir whose `bin/` holds empty stand-ins for the requested checkers, plus
 * `leanexport` unless `leanexport: false` (a pre-4.35 toolchain).
 */
export function fakeToolchain(
  root: string,
  available: readonly CheckerName[] = ALL_CHECKERS,
  opts: { leanexport?: boolean } = {},
): Toolchain {
  const binDir = path.join(root, "toolchain", "bin");
  mkdirSync(binDir, { recursive: true });
  for (const c of available) writeFileSync(path.join(binDir, exeName(CHECKER_SPECS[c].binary)), "");
  if (opts.leanexport !== false) writeFileSync(path.join(binDir, exeName("leanexport")), "");
  return {
    prefix: path.join(root, "toolchain"),
    binDir,
    leanVersion: "4.35.0-rc3",
    lake: path.join(root, "fake-lake"),
    env: { PATH: "" },
    checkerEnv: { PATH: binDir, LEAN_ABORT_ON_PANIC: "1" },
  };
}

export function fakeProject(dir: string, stateDir = path.join(dir, ".proofflow")): ProjectInfo {
  return {
    dir,
    dirPosix: dir.replace(/\\/g, "/"),
    name: "toy",
    lakefile: { kind: "toml", path: path.join(dir, "lakefile.toml") },
    libs: [{ name: "Toy", srcDir: null, roots: [], globs: [] }],
    srcDir: null,
    defaultRoots: ["Toy"],
    defaultLocalPrefixes: ["Toy"],
    toolchain: "leanprover/lean4:v4.35.0-rc3",
    manifest: null,
    stateDir,
  };
}

/** Write a stand-in `.olean` at the Lake location for `mod`; returns its path. */
export function fakeOlean(projectDir: string, mod: string, content = `olean of ${mod}`): string {
  const file = path.join(projectDir, ".lake", "build", "lib", "lean", ...mod.split(".")) + ".olean";
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

export const EXPORT_META =
  '{"meta":{"exporter":{"name":"lean4export","version":"3.1.0"},"format":{"version":"3.1.0"},"lean":{"githash":"470d5ce","version":"4.35.0-rc3"}}}';

export interface FakeExportOptions {
  /** Axioms in the closure (default: propext). */
  axioms?: string[];
  /** Export a different theorem instead of `decl` (the target is then missing). */
  omitTarget?: boolean;
}

/**
 * A tiny well-formed export (format 3.1.0) whose name table spells `decl` component by component:
 * the axioms, then `theorem decl : Prop`. Its content depends on `decl`, so hashes differ per decl.
 */
export function fakeExport(decl: string, opts: FakeExportOptions = {}): string {
  const lines = [EXPORT_META];
  const ids = new Map<string, number>();
  let next = 0;
  const nameId = (name: string): number => {
    let pre = 0;
    let key = "";
    for (const c of parseNameComponents(name)) {
      key += `\u0000${String(c)}`;
      let id = ids.get(key);
      if (id === undefined) {
        id = ++next;
        ids.set(key, id);
        lines.push(
          typeof c === "number"
            ? `{"in":${id},"num":{"i":${c},"pre":${pre}}}`
            : `{"in":${id},"str":{"pre":${pre},"str":${JSON.stringify(c)}}}`,
        );
      }
      pre = id;
    }
    return pre;
  };
  const axiomIds = (opts.axioms ?? ["propext"]).map(nameId);
  const target = nameId(opts.omitTarget ? `${decl}_other` : decl);
  lines.push('{"ie":0,"sort":0}');
  for (const a of axiomIds) lines.push(`{"axiom":{"isUnsafe":false,"levelParams":[],"name":${a},"type":0}}`);
  lines.push(`{"thm":{"all":[${target}],"levelParams":[],"name":${target},"type":0,"value":0}}`);
  return lines.join("\n") + "\n";
}

/** Standard replies for each checker's success, per docs/CHECKERS.md. */
export const ACCEPT: Record<CheckerName, FakeReply> = {
  leanchecker: { exitCode: 0, stdout: "Lean default kernel accepts the solution\n" },
  // Module replay is silent on success (verified).
  "leanchecker-module": { exitCode: 0 },
  "leanchecker-paranoid": { exitCode: 0, stdout: "Lean default kernel accepts the solution\n" },
  lean4lean: { exitCode: 0, stdout: "checked 38 declarations\n" },
  nanoda: { exitCode: 0 },
  "con-leche": { exitCode: 0, stdout: "con-leche: accepted 38 declarations (--verified)\n" },
  "con-ron": { exitCode: 0, stdout: "con-ron: accepted 38 declarations (--verified)\n" },
};

export function checkerOf(cmd: string): CheckerName | null {
  const base = path.basename(cmd).replace(/\.exe$/i, "");
  return ALL_CHECKERS.find((c) => CHECKER_SPECS[c].binary === base) ?? null;
}

/** Handler: leanexport prints `fakeExport(decl)`; checkers reply from `replies` (default accept). */
export function pipelineHandler(
  toolchain: Toolchain,
  replies: Partial<Record<CheckerName, FakeReply>> = {},
): FakeHandler {
  return ({ cmd, args }) => {
    if (cmd === toolchain.lake && args[0] === "env" && args[1] === "leanchecker") {
      return replies["leanchecker-module"] ?? ACCEPT["leanchecker-module"];
    }
    if (cmd === toolchain.lake && args[1] === "leanexport") {
      const decl = args[args.length - 1] ?? "";
      return { exitCode: 0, stdout: fakeExport(decl) };
    }
    const c = checkerOf(cmd);
    if (c) return replies[c] ?? ACCEPT[c];
    return { exitCode: 127, stderr: `unexpected command ${cmd} ${args.join(" ")}` };
  };
}
